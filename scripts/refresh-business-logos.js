#!/usr/bin/env node
/**
 * One-shot: fetch og:image (or favicon as fallback) for every business in
 * data/businesses.json and write it back as the `logo` field. Run it locally
 * once after editing businesses.json. Re-running is safe — it only fetches
 * entries that don't already have a `logo` (use --force to refresh all).
 *
 *   node scripts/refresh-business-logos.js          # fill missing
 *   node scripts/refresh-business-logos.js --force  # refetch everything
 *
 * No deps. Uses Node 18+ global fetch.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'businesses.json');
const FORCE = process.argv.includes('--force');
const TIMEOUT_MS = 10000;
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

function pickLink(html, rels) {
  for (const rel of rels) {
    const re1 = new RegExp(`<link[^>]+rel=["'][^"']*${rel}[^"']*["'][^>]*href=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*${rel}[^"']*["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m) return m[1].trim();
  }
  return '';
}

async function fetchHtml(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ac.signal,
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function pickLogoFor(business) {
  if (!business.url) return null;
  const html = await fetchHtml(business.url);
  if (!html) return null;
  // og:image first (usually a hero/product shot — the best preview)
  let img =
    pickMeta(html, 'og:image') ||
    pickMeta(html, 'twitter:image') ||
    pickLink(html, ['apple-touch-icon', 'icon', 'shortcut icon']);
  if (!img) return null;
  return abs(business.url, img);
}

async function main() {
  const json = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let updated = 0, skipped = 0, failed = 0;
  for (let i = 0; i < json.businesses.length; i++) {
    const b = json.businesses[i];
    if (!FORCE && b.logo) { skipped++; continue; }
    process.stdout.write(`[${i + 1}/${json.businesses.length}] ${b.name} … `);
    const logo = await pickLogoFor(b);
    if (logo) {
      b.logo = logo;
      updated++;
      console.log('OK');
    } else {
      failed++;
      console.log('miss (will fall back to favicon at render time)');
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(json, null, 2));
  console.log(`\nDone. ${updated} updated, ${skipped} skipped, ${failed} failed (will use favicon fallback).`);
}

main().catch(e => { console.error(e); process.exit(1); });
