#!/usr/bin/env node
/**
 * One-shot: fetch og:image (or twitter:image / first product image) for
 * every winner in data/winners.json that has a `url` but no `image`.
 * Writes the image URL back as the `image` field on the entry. Run
 * locally — Vercel sandboxes don't have outbound HTTPS.
 *
 *   node scripts/refresh-winner-images.js          # fill missing
 *   node scripts/refresh-winner-images.js --force  # refetch everything
 *
 * No deps. Uses Node 18+ global fetch.
 *
 * eBay & Etsy both expose og:image on listing pages, so the same code
 * works for both. The fetch impersonates a real browser User-Agent
 * because Etsy returns a stripped page to bots otherwise.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'winners.json');
const FORCE = process.argv.includes('--force');
const TIMEOUT_MS = 12000;
const CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function abs(base, src) {
  try { return new URL(src, base).toString(); } catch { return null; }
}

function pickMeta(html, prop) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].trim() : '';
}

function pickFirstImg(html, base) {
  // Fallback: pick the first <img src=...> that looks like a product photo
  // (filters out base64 placeholders, sprites, tracking pixels).
  const re = /<img[^>]+src=["']([^"']+\.(?:jpe?g|png|webp|gif)(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (/sprite|pixel|tracking|placeholder|1x1|spacer/i.test(u)) continue;
    if (/data:image/i.test(u)) continue;
    return abs(base, u);
  }
  return null;
}

async function fetchHtml(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

async function pickImageFor(winner) {
  if (!winner.url) return null;
  const html = await fetchHtml(winner.url);
  if (!html) return null;
  const img =
    pickMeta(html, 'og:image:secure_url') ||
    pickMeta(html, 'og:image') ||
    pickMeta(html, 'twitter:image:src') ||
    pickMeta(html, 'twitter:image') ||
    pickFirstImg(html, winner.url);
  return img ? abs(winner.url, img) : null;
}

// Tiny concurrency limiter
async function processQueue(items, worker) {
  let i = 0;
  const slots = new Array(CONCURRENCY).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
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
  await processQueue(todo, async ({ w, i }) => {
    process.stdout.write(`[${i + 1}/${json.winners.length}] ${w.name.slice(0, 48).padEnd(48)} … `);
    const img = await pickImageFor(w);
    if (img) {
      w.image = img;
      updated++;
      console.log('OK');
    } else {
      failed++;
      console.log('miss');
    }
  });
  fs.writeFileSync(FILE, JSON.stringify(json, null, 2));
  console.log(`\nDone. ${updated} updated, ${failed} failed (will fall back to category placeholder).`);
}

main().catch(e => { console.error(e); process.exit(1); });
