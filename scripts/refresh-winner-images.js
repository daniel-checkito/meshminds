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
const CONCURRENCY = 2;          // gentler on Etsy/eBay than 4
const REQUEST_GAP_MS = 600;      // small jitter so we don't burst

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
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

async function fetchHtml(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!r.ok) return { html: null, status: r.status };
    return { html: await r.text(), status: r.status };
  } catch (e) {
    return { html: null, status: 'err:' + (e.code || e.name || 'unknown') };
  } finally { clearTimeout(t); }
}

let dumpedDebug = false;
async function pickImageFor(winner) {
  if (!winner.url) return { img: null, reason: 'no-url' };
  const { html, status } = await fetchHtml(winner.url);
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
