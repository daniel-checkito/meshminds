#!/usr/bin/env node
/* refresh-market-data.js
 *
 * Periodic promotion tool: aggregates observations from Supabase
 * market_observations table and proposes updates to data/market-data.json.
 *
 * It does NOT write the file automatically. It prints:
 *   1. A diff of proposed updates per category (median observed vs. baseline)
 *   2. Categories with low usage (candidates for removal)
 *   3. Top uncategorized scans (candidates for new categories)
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/refresh-market-data.js
 *
 * Optional flags:
 *   --apply       write the proposed updates back to data/market-data.json
 *   --window=90   look-back window in days (default 90)
 *   --min=10      minimum observations required to propose an update (default 10)
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
const WINDOW_DAYS = Number(args.window || 90);
const MIN_OBS = Number(args.min || 10);
const APPLY = !!args.apply;

const dataPath = path.join(__dirname, '..', 'data', 'market-data.json');
const baseline = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const baselineMap = Object.fromEntries(baseline.categories.map(c => [c.id, c]));

async function rest(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

function median(arr) {
  const c = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!c.length) return null;
  const m = Math.floor(c.length / 2);
  return c.length % 2 ? c[m] : (c[m - 1] + c[m]) / 2;
}

(async () => {
  console.log(`\n=== Market data refresh - last ${WINDOW_DAYS} days ===\n`);

  // Pull all observations in window (paginate by 1000)
  const allObs = [];
  for (let offset = 0; ; offset += 1000) {
    const batch = await rest(
      `market_observations?created_at=gte.${since}&select=category_id,category_name,etsy_listings,etsy_avg_price,search_volume,match_confidence,product_title&order=created_at.desc&offset=${offset}&limit=1000`
    );
    allObs.push(...batch);
    if (batch.length < 1000) break;
  }
  console.log(`Pulled ${allObs.length} observations.\n`);

  // Group by category_id
  const byCat = new Map();
  for (const o of allObs) {
    const k = o.category_id || '__uncat__';
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(o);
  }

  // 1. Proposed updates for known categories
  console.log('## Proposed updates\n');
  let updates = 0;
  const updatedCats = baseline.categories.map(cat => {
    const obs = byCat.get(cat.id) || [];
    const usable = obs.filter(o => o.match_confidence >= 0.5);
    if (usable.length < MIN_OBS) return cat;
    const newPrice = median(usable.map(o => parseFloat(o.etsy_avg_price)));
    const newSearch = median(usable.map(o => o.search_volume));
    const newListings = median(usable.map(o => o.etsy_listings));
    const before = `€${cat.etsy_avg_price} · ${cat.search_volume_monthly} searches`;
    const after = `€${newPrice ? Math.round(newPrice) : cat.etsy_avg_price} · ${newSearch ? Math.round(newSearch) : cat.search_volume_monthly} searches`;
    const priceDelta = newPrice ? Math.abs(newPrice - cat.etsy_avg_price) / cat.etsy_avg_price : 0;
    const searchDelta = newSearch ? Math.abs(newSearch - cat.search_volume_monthly) / cat.search_volume_monthly : 0;
    if (priceDelta < 0.1 && searchDelta < 0.15) return cat; // skip noise
    console.log(`  ${cat.name.padEnd(36)}  n=${usable.length.toString().padStart(3)}  ${before}  →  ${after}`);
    updates++;
    return {
      ...cat,
      etsy_avg_price: newPrice ? Math.round(newPrice) : cat.etsy_avg_price,
      search_volume_monthly: newSearch ? Math.round(newSearch) : cat.search_volume_monthly,
    };
  });
  if (!updates) console.log('  (no significant changes)\n'); else console.log('');

  // 2. Low-usage categories
  console.log('## Low-usage categories (candidates for removal)\n');
  let lowUse = 0;
  for (const cat of baseline.categories) {
    const n = (byCat.get(cat.id) || []).length;
    if (n < 5) {
      console.log(`  ${cat.name.padEnd(36)}  observations=${n}  ${n === 0 ? '(unused)' : '(rare)'}`);
      lowUse++;
    }
  }
  if (!lowUse) console.log('  (none)\n'); else console.log('');

  // 3. Uncategorized scans - top product titles by frequency
  console.log('## Uncategorized scans (candidates for new categories)\n');
  const uncat = byCat.get('__uncat__') || [];
  if (uncat.length) {
    const titles = uncat
      .map(o => (o.product_title || '').toLowerCase().split(/\s+/).filter(w => w.length > 3))
      .flat();
    const counts = new Map();
    for (const w of titles) counts.set(w, (counts.get(w) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log(`  ${uncat.length} uncategorized scans. Top recurring keywords:`);
    for (const [w, n] of top) console.log(`    ${w.padEnd(20)}  ${n}`);
    console.log('  Recent uncategorized titles:');
    for (const o of uncat.slice(0, 15)) console.log(`    - ${o.product_title || '(no title)'}`);
  } else {
    console.log('  (none)');
  }
  console.log('');

  // 4. Apply
  if (APPLY && updates > 0) {
    const next = { ...baseline, version: new Date().toISOString().slice(0, 10), categories: updatedCats };
    fs.writeFileSync(dataPath, JSON.stringify(next, null, 2) + '\n');
    console.log(`✓ Wrote ${updates} updated categories to ${dataPath}`);
    console.log('  Review the diff with: git diff data/market-data.json');
  } else if (updates > 0) {
    console.log(`(Re-run with --apply to write ${updates} updates to data/market-data.json)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
