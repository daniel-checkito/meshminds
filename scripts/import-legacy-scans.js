#!/usr/bin/env node
/* Import legacy scan rows from a CSV (e.g. exported from Google Sheets)
 * into the Supabase scans table.
 *
 * Usage:
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   node scripts/import-legacy-scans.js path/to/legacy-scans.csv
 *
 * What it does:
 *   - parses the CSV (RFC 4180-ish: quoted fields with embedded commas/newlines/quotes)
 *   - maps timestamp -> created_at, input_url -> url, score -> score,
 *     verdict -> verdict, title -> title, net_profit -> profit_est ("~€34/mo")
 *   - packs every other column into full_data JSONB
 *   - sets user_id NULL, is_public FALSE, pro_locked FALSE
 *   - skips rows where input_url is the raw n8n placeholder
 *   - inserts in batches of 100
 *
 * Safe to re-run: each row gets a fresh UUID. To avoid duplicates,
 * truncate the legacy rows first or run only once.
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const CSV_PATH = process.argv[2];

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}
if (!CSV_PATH || !fs.existsSync(CSV_PATH)) {
  console.error('Usage: node scripts/import-legacy-scans.js path/to/file.csv');
  process.exit(1);
}

// ── CSV parser (RFC 4180-ish) ──────────────────────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(CSV_PATH, 'utf8');
const matrix = parseCsv(raw);
if (!matrix.length) { console.error('Empty CSV.'); process.exit(1); }

const headers = matrix[0].map(h => h.trim());
const dataRows = matrix.slice(1).filter(r => r.length > 1 && r.some(c => c && c.trim()));

console.log(`Parsed ${dataRows.length} data rows. Columns: ${headers.length}`);

// ── Build Supabase row objects ─────────────────────────────────────────────
function isPlaceholder(s) {
  if (!s) return true;
  return /^\s*\{\s*\$\(/.test(s) || s.trim() === '';
}
function toNum(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function toIntScore(s) {
  const n = toNum(s);
  if (n == null) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function toIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const rows = dataRows.map((cols) => {
  const obj = {};
  headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
  // Strip placeholders from every field - they were unfilled n8n templates
  for (const k of Object.keys(obj)) if (isPlaceholder(obj[k]) && k !== 'timestamp') obj[k] = '';
  const created_at = toIso(obj.timestamp) || new Date().toISOString();
  const score = toIntScore(obj.score);
  const verdict = obj.verdict ? obj.verdict.slice(0, 200) : null;
  const title = obj.title ? obj.title.slice(0, 200) : null;
  const url = isPlaceholder(obj.input_url) ? null : obj.input_url.slice(0, 500);
  const netProfitNum = toNum(obj.net_profit);
  const profit_est = netProfitNum ? `~€${Math.round(netProfitNum)}/mo` : null;
  // Pack all original columns into full_data so nothing is lost
  const full_data = { source: 'google-sheets-import', original: { ...obj } };
  return {
    user_id: null,
    url,
    title,
    score,
    verdict,
    image_url: null,
    profit_est,
    is_public: false,
    pro_locked: false,
    full_data,
    ip_hash: null,
    created_at,
  };
});

// ── Push to Supabase in batches ────────────────────────────────────────────
async function postBatch(batch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scans`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(batch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

(async () => {
  const BATCH = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    try {
      await postBatch(slice);
      inserted += slice.length;
      console.log(`✓ inserted ${inserted}/${rows.length}`);
    } catch (e) {
      console.error(`✗ batch ${i / BATCH + 1} failed:`, e.message);
      console.error('  retrying row-by-row to isolate the bad row…');
      for (const row of slice) {
        try { await postBatch([row]); inserted++; }
        catch (e2) { console.error(`  ✗ row ${row.created_at} ${row.title || row.url || ''}: ${e2.message}`); }
      }
    }
  }
  console.log(`\nDone. ${inserted}/${rows.length} rows inserted.`);
})();
