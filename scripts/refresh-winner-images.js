#!/usr/bin/env node
/**
 * One-shot: fetch product image for every winner in data/winners.json that
 * has a `url` but no `image`. Writes the URL back as the `image` field.
 *
 *   node scripts/refresh-winner-images.js          # fill missing
 *   node scripts/refresh-winner-images.js --force  # refetch everything
 *   node scripts/refresh-winner-images.js --debug  # dump first miss to /tmp
 *
 * Run locally — Vercel sandboxes don't have outbound HTTPS.
 *
 * Etsy and eBay both use bot detection, so we look for a product image in
 * five places, in order: og:image, twitter:image, link rel=image_src,
 * application/ld+json Product schema, and finally any image URL on the page
 * matching the platform's known CDN host (i.etsystatic.com / i.ebayimg.com).
 * The first hit wins.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'winners.json');
const FORCE = process.argv.includes('--force');
const DEBUG = process.argv.includes('--debug');
const TIMEOUT_MS = 15000;
const CONCURRENCY = 1;            // sequential — Etsy starts 429-ing above this
const REQUEST_GAP_MS = 2500;      // wider gap to stay under per-host rate limits
const RETRY_429_DELAY_MS = 30000; // back off 30s on 429 then retry once

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
/* Both Etsy and eBay block real browser UAs at the CDN edge for anything
   that looks like scraping, but they whitelist social-media bots because
   they WANT links to preview on Facebook/Twitter/Slack/etc. We try the
   social UAs in order; the first one that returns a 200 wins. */
const UA_FALLBACKS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Twitterbot/1.0',
  'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'WhatsApp/2.21.12.21 A',
  UA, // last-resort real Chrome
];
const HEADERS_BASE = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

function abs(base, src) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

function pickMeta(html, prop) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].trim() : '';
}

function pickLink(html, rel) {
  const re1 = new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]*href=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*${rel}[^"']*["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].trim() : '';
}

function pickProductJsonLd(html) {
  // Etsy embeds <script type="application/ld+json"> with @type Product
  // and an image array. Also handles ItemList wrappers.
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const json = JSON.parse(m[1].trim());
      const candidates = Array.isArray(json) ? json : [json];
      for (const c of candidates) {
        const queue = [c];
        while (queue.length) {
          const node = queue.shift();
          if (!node || typeof node !== 'object') continue;
          if (node['@type'] === 'Product' || node['@type'] === 'IndividualProduct') {
            if (node.image) {
              if (Array.isArray(node.image)) return node.image[0];
              if (typeof node.image === 'string') return node.image;
              if (node.image.url) return node.image.url;
            }
          }
          // walk nested @graph / mainEntity / itemListElement
          ['@graph', 'mainEntity', 'itemListElement'].forEach(k => {
            if (node[k]) queue.push.apply(queue, Array.isArray(node[k]) ? node[k] : [node[k]]);
          });
        }
      }
    } catch {}
  }
  return '';
}

function pickPlatformCdn(html, isEtsy, isEbay) {
  // Last-resort: grab the first image whose host matches the platform's CDN.
  // Filters out tiny thumbnails (75x75, 16x16 etc.) by preferring the longest
  // path (Etsy/eBay encode size in the URL — bigger paths usually = bigger images).
  const cdnRe = isEtsy
    ? /https:\/\/i\.etsystatic\.com\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/gi
    : isEbay
      ? /https:\/\/i\.ebayimg\.com\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/gi
      : null;
  if (!cdnRe) return '';
  const matches = html.match(cdnRe) || [];
  if (!matches.length) return '';
  // Etsy: prefer fullxfull or il_794xN over il_75x75. eBay: prefer s-l1600 over s-l64.
  const ranked = matches
    .filter(u => !/_75x75|_h_75x75|s-l64|s-l96/i.test(u))
    .sort((a, b) => b.length - a.length);
  return ranked[0] || matches[0];
}

async function fetchHtml(url, allowBackoff) {
  /* Try each UA in the fallback list until one returns 200. We stop early
     on success so most URLs only need a single request. If we hit a 429
     (rate limit), pause for RETRY_429_DELAY_MS and retry the whole UA loop
     once — Etsy/eBay throttle per-host so a single long pause clears it. */
  let lastStatus = null;
  let saw429 = false;
  for (const ua of UA_FALLBACKS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        headers: { ...HEADERS_BASE, 'User-Agent': ua },
        redirect: 'follow',
        signal: ac.signal,
      });
      lastStatus = r.status;
      if (r.ok) return { html: await r.text(), status: r.status, ua };
      if (r.status === 429) saw429 = true;
    } catch (e) {
      lastStatus = 'err:' + (e.code || e.name || 'unknown');
    } finally { clearTimeout(t); }
  }
  if (saw429 && allowBackoff) {
    process.stdout.write('(429, backing off ' + (RETRY_429_DELAY_MS / 1000) + 's) ');
    await sleep(RETRY_429_DELAY_MS);
    return fetchHtml(url, false);
  }
  return { html: null, status: lastStatus, ua: null };
}

let dumpedDebug = false;
async function pickImageFor(winner) {
  if (!winner.url) return { img: null, reason: 'no-url' };
  const { html, status } = await fetchHtml(winner.url, true);
  if (!html) return { img: null, reason: 'fetch:' + status };
  const isEtsy = /etsy\.com/.test(winner.url);
  const isEbay = /ebay\./.test(winner.url);
  const img =
    pickMeta(html, 'og:image:secure_url') ||
    pickMeta(html, 'og:image') ||
    pickMeta(html, 'twitter:image:src') ||
    pickMeta(html, 'twitter:image') ||
    pickLink(html, 'image_src') ||
    pickProductJsonLd(html) ||
    pickPlatformCdn(html, isEtsy, isEbay);
  if (img) return { img: abs(winner.url, img), reason: 'ok' };
  if (DEBUG && !dumpedDebug) {
    fs.writeFileSync('/tmp/winner-miss.html', html);
    dumpedDebug = true;
    console.log('\n[debug] First miss HTML written to /tmp/winner-miss.html (' + html.length + ' bytes)');
  }
  return { img: null, reason: 'no-image-tag' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processQueue(items, worker) {
  let i = 0;
  const slots = new Array(CONCURRENCY).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
      await sleep(REQUEST_GAP_MS);
    }
  });
  await Promise.all(slots);
}

async function main() {
  const json = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const todo = json.winners
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.url && (FORCE || !w.image));
  /* Interleave by host so we don't hit the same domain (Etsy/eBay) 50 times
     in a row — that's what triggered the 429 cascade in the previous run. */
  const byHost = {};
  todo.forEach(item => {
    const h = (() => { try { return new URL(item.w.url).host; } catch { return 'x'; } })();
    (byHost[h] = byHost[h] || []).push(item);
  });
  const interleaved = [];
  let added = true;
  while (added) {
    added = false;
    for (const h of Object.keys(byHost)) {
      if (byHost[h].length) { interleaved.push(byHost[h].shift()); added = true; }
    }
  }
  todo.length = 0; todo.push.apply(todo, interleaved);
  console.log(`Found ${todo.length} winner(s) needing images${FORCE ? ' (--force)' : ''}.\n`);
  let updated = 0, failed = 0;
  const reasons = {};
  await processQueue(todo, async ({ w, i }) => {
    process.stdout.write(`[${(i + 1).toString().padStart(3)}/${json.winners.length}] ${w.name.slice(0, 48).padEnd(48)} … `);
    const { img, reason } = await pickImageFor(w);
    if (img) {
      w.image = img;
      updated++;
      console.log('OK');
    } else {
      failed++;
      reasons[reason] = (reasons[reason] || 0) + 1;
      console.log('miss (' + reason + ')');
    }
  });
  fs.writeFileSync(FILE, JSON.stringify(json, null, 2));
  console.log(`\nDone. ${updated} updated, ${failed} failed.`);
  if (failed) {
    console.log('Failure reasons:');
    Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]).forEach(r => {
      console.log('  ' + r + ': ' + reasons[r]);
    });
    console.log('\nTip: re-run with --debug to dump the first miss to /tmp/winner-miss.html so we can see exactly what came back.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
