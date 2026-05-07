#!/usr/bin/env node
/* import-emails.js
 *
 * One-time backfill of legacy email captures (e.g. Google Sheets export)
 * into the Supabase email_leads table.
 *
 * Behaviour:
 *   - Parses CSV (header: timestamp,email,consent)
 *   - Dedupes by email (case-insensitive); keeps the LATEST row per email,
 *     so the most recent consent state wins
 *   - Validates each surviving row with api/_email-validator
 *   - Prints a report: total → unique → valid → fakes (with reasons)
 *   - With --apply, inserts valid rows into email_leads (source='legacy-import')
 *     using the original timestamp as created_at
 *
 * Usage:
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/import-emails.js path/to/emails.csv          # dry run
 *   node scripts/import-emails.js path/to/emails.csv --apply  # actually insert
 *
 * Re-running creates duplicates (no unique index on email_leads.email).
 * Truncate or filter before re-running.
 */

const fs = require('fs');
const path = require('path');
const { isLikelyFakeEmail } = require('../api/_email-validator');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const args = process.argv.slice(2);
const CSV_PATH = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');

if (!CSV_PATH || !fs.existsSync(CSV_PATH)) {
  console.error('Usage: node scripts/import-emails.js path/to/file.csv [--apply]');
  process.exit(1);
}
if (APPLY && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars (required for --apply).');
  process.exit(1);
}

// ── CSV parser (RFC 4180-ish) ──────────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let i = 0; let inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const text = fs.readFileSync(CSV_PATH, 'utf8');
const matrix = parseCsv(text).filter(r => r.length && r.some(c => c.trim()));
const headers = matrix.shift().map(h => h.trim().toLowerCase());
const idxTs = headers.indexOf('timestamp');
const idxEmail = headers.indexOf('email');
const idxConsent = headers.indexOf('consent');
if (idxEmail < 0) { console.error('CSV must have an "email" column.'); process.exit(1); }

const rows = matrix.map(c => ({
  ts: idxTs >= 0 ? c[idxTs].trim() : new Date().toISOString(),
  email: c[idxEmail].trim(),
  consent: idxConsent >= 0 ? /^(true|1|yes)$/i.test(c[idxConsent].trim()) : null,
}));

console.log(`Parsed ${rows.length} CSV rows.`);

// Dedupe by lowercased email; latest timestamp wins
const byEmail = new Map();
for (const r of rows) {
  const key = r.email.toLowerCase();
  const cur = byEmail.get(key);
  if (!cur || new Date(r.ts) > new Date(cur.ts)) byEmail.set(key, r);
}
const uniques = [...byEmail.values()];
console.log(`Deduped to ${uniques.length} unique emails.\n`);

// Validate
const valid = [];
const fakes = [];
for (const r of uniques) {
  const v = isLikelyFakeEmail(r.email);
  if (v.fake) fakes.push({ ...r, ...v });
  else valid.push(r);
}

console.log(`✓ Valid: ${valid.length}`);
console.log(`✗ Fakes: ${fakes.length}\n`);

if (fakes.length) {
  console.log('Filtered as fake:');
  const byReason = {};
  for (const f of fakes) (byReason[f.reason] ||= []).push(f);
  for (const [reason, list] of Object.entries(byReason)) {
    console.log(`  [${reason}] (${list.length}):`);
    for (const f of list) console.log(`    ${f.email}${f.didYouMean ? ` → ${f.didYouMean}?` : ''}`);
  }
  console.log('');
}

if (!APPLY) {
  console.log('Dry run only. Re-run with --apply to insert into Supabase.');
  process.exit(0);
}

// ── Insert ────────────────────────────────────────────────────────────────
async function postBatch(batch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/email_leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(batch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}

(async () => {
  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH).map(r => ({
      email: r.email,
      consent: r.consent,
      source: 'legacy-import',
      created_at: r.ts || new Date().toISOString(),
      url: null, score: null, verdict: null, ip_hash: null,
    }));
    try {
      await postBatch(slice);
      inserted += slice.length;
      console.log(`✓ inserted ${inserted}/${valid.length}`);
    } catch (e) {
      console.error(`✗ batch failed: ${e.message}\n  retrying row-by-row…`);
      for (const r of slice) {
        try { await postBatch([r]); inserted++; }
        catch (e2) { console.error(`  ✗ ${r.email}: ${e2.message}`); }
      }
    }
  }
  console.log(`\nDone. ${inserted}/${valid.length} rows inserted.`);
})().catch(e => { console.error(e); process.exit(1); });
