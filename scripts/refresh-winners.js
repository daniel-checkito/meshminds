#!/usr/bin/env node
/* refresh-winners.js
 *
 * Surface candidate new winners from high-scoring scans, so data/winners.json
 * keeps growing with real validated products over time.
 *
 * What it does:
 *   - Pulls scans with score ≥ 80 from the last N days (default 60)
 *   - Groups by matched category
 *   - For each category, lists top scans NOT already in winners.json
 *     (matched by title similarity)
 *   - Prints a markdown report you can use to add new entries by hand
 *
 * Does NOT auto-write - winner entries need editorial review (price/revenue
 * estimates, IP-risk classification, why-it-sells narrative). You decide.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/refresh-winners.js
 *   --window=60   look-back window in days (default 60)
 *   --min-score=80   minimum score (default 80)
 *   --max-per-cat=5  candidates printed per category (default 5)
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  return m ? [m[1], m[2] || true] : [a, true];
}));
const WINDOW = Number(args.window || 60);
const MIN_SCORE = Number(args['min-score'] || 80);
const MAX_PER = Number(args['max-per-cat'] || 5);

const winners = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'winners.json'), 'utf8'));
const knownTitles = new Set(winners.winners.map(w => w.name.toLowerCase()));

function similar(a, b) {
  // crude title similarity - share at least 3 significant tokens (>3 chars)
  const tokens = s => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3));
  const A = tokens(a), B = tokens(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared >= 3;
}

async function rest(q) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

(async () => {
  const since = new Date(Date.now() - WINDOW * 86400000).toISOString();
  console.log(`\n=== Winner candidates from scans (score ≥ ${MIN_SCORE}, last ${WINDOW} days) ===\n`);

  // Need scan data joined with the matched category from market_observations
  const obs = await rest(`market_observations?created_at=gte.${since}&category_id=not.is.null&select=scan_id,category_id,product_title,etsy_avg_price`);
  const scanIds = [...new Set(obs.map(o => o.scan_id).filter(Boolean))];
  if (!scanIds.length) { console.log('No observations in window.'); return; }

  // Pull the actual scans for score and full_data
  const scans = [];
  for (let i = 0; i < scanIds.length; i += 50) {
    const slice = scanIds.slice(i, i + 50).map(id => `"${id}"`).join(',');
    const batch = await rest(`scans?id=in.(${slice})&score=gte.${MIN_SCORE}&select=id,score,title,verdict,profit_est,full_data`);
    scans.push(...batch);
  }
  if (!scans.length) { console.log(`No scans ≥ ${MIN_SCORE} in window.`); return; }
  const scanById = new Map(scans.map(s => [s.id, s]));

  // Group by category
  const byCat = new Map();
  for (const o of obs) {
    const s = scanById.get(o.scan_id);
    if (!s) continue;
    if (!byCat.has(o.category_id)) byCat.set(o.category_id, []);
    byCat.get(o.category_id).push({ obs: o, scan: s });
  }

  for (const [catId, items] of byCat.entries()) {
    items.sort((a, b) => b.scan.score - a.scan.score);
    const candidates = [];
    for (const it of items) {
      const title = it.obs.product_title || it.scan.title;
      if (!title) continue;
      if (knownTitles.has(title.toLowerCase())) continue;
      // skip if title is similar to an existing winner
      const dupe = winners.winners.find(w => similar(w.name, title));
      if (dupe) continue;
      if (candidates.length >= MAX_PER) break;
      // dedupe within category by similar title
      if (candidates.find(c => similar(c.title, title))) continue;
      candidates.push({ title, score: it.scan.score, verdict: it.scan.verdict, price: it.obs.etsy_avg_price, profit: it.scan.profit_est });
    }
    if (!candidates.length) continue;
    console.log(`### ${catId}`);
    for (const c of candidates) {
      console.log(`  - ${c.title}`);
      console.log(`    score: ${c.score} · verdict: ${c.verdict || 'n/a'} · est avg price: ${c.price ? '€' + c.price : 'n/a'} · ${c.profit || 'n/a'}`);
    }
    console.log('');
  }

  console.log('Add the ones you like to data/winners.json - fill in price_eur, monthly_revenue_eur, why_it_sells, differentiator, ip_risk fields manually for each.');
})().catch(e => { console.error(e); process.exit(1); });
