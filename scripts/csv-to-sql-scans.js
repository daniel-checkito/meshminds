#!/usr/bin/env node
/* csv-to-sql-scans.js
 *
 * Convert a legacy scans CSV (Google Sheets export) into PostgreSQL
 * INSERT statements you can paste straight into the Supabase SQL Editor.
 *
 * Usage:
 *   node scripts/csv-to-sql-scans.js path/to/legacy-scans.csv > legacy-scans.sql
 *
 * Then open legacy-scans.sql in your editor, copy everything, and paste
 * into Supabase Studio → SQL Editor → Run.
 *
 * What it does:
 *   - timestamp     → created_at
 *   - input_url     → url (NULL if it's an unfilled n8n placeholder)
 *   - title         → title
 *   - score         → score (0-100 integer)
 *   - verdict       → verdict
 *   - net_profit    → profit_est ("~€34/mo")
 *   - all 47 columns packed into full_data JSONB so nothing is lost
 *   - user_id NULL, ip_hash NULL, is_public/pro_locked FALSE
 *   - Splits into batches of 50 rows so each INSERT statement is a
 *     reasonable size for the SQL Editor.
 */

const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2];
if (!csvPath || !fs.existsSync(csvPath)) {
  console.error('Usage: node scripts/csv-to-sql-scans.js path/to/legacy-scans.csv > legacy-scans.sql');
  process.exit(1);
}

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

const csvText = fs.readFileSync(csvPath, 'utf8');
const matrix = parseCsv(csvText);
const headers = matrix[0].map(h => h.trim());
const dataRows = matrix.slice(1).filter(r => r.length > 1 && r.some(c => c && c.trim()));

const isPlaceholder = s => !s || /^\s*\{\s*\$\(/.test(s) || s.trim() === '';
const toNum = s => { if (!s) return null; const n = Number(String(s).replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const toIntScore = s => { const n = toNum(s); if (n == null) return null; return Math.max(0, Math.min(100, Math.round(n))); };
const toIso = s => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); };
const sqlStr = s => s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const sqlNum = n => n == null ? 'NULL' : String(n);
const sqlJsonb = obj => obj == null ? 'NULL' : "'" + JSON.stringify(obj).replace(/'/g, "''") + "'::jsonb";

const valueRows = dataRows.map((cols) => {
  const obj = {};
  headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
  for (const k of Object.keys(obj)) if (k !== 'timestamp' && isPlaceholder(obj[k])) obj[k] = '';
  const created_at = toIso(obj.timestamp) || new Date().toISOString();
  const score = toIntScore(obj.score);
  const verdict = obj.verdict ? obj.verdict.slice(0, 200) : null;
  const title = obj.title ? obj.title.slice(0, 200) : null;
  const url = isPlaceholder(obj.input_url) ? null : obj.input_url.slice(0, 500);
  const netProfitNum = toNum(obj.net_profit);
  const profit_est = netProfitNum ? `~€${Math.round(netProfitNum)}/mo` : null;
  const full_data = { source: 'google-sheets-import', original: obj };
  return `(NULL, ${sqlStr(url)}, ${sqlStr(title)}, ${sqlNum(score)}, ${sqlStr(verdict)}, NULL, ${sqlStr(profit_est)}, FALSE, FALSE, ${sqlJsonb(full_data)}, NULL, '${created_at}')`;
});

const BATCH = 50;
const colList = '(user_id, url, title, score, verdict, image_url, profit_est, is_public, pro_locked, full_data, ip_hash, created_at)';
const out = [];
out.push(`-- Legacy scans import: ${dataRows.length} rows, ${Math.ceil(dataRows.length / BATCH)} batches of up to ${BATCH}.`);
out.push(`-- Source: Google Sheets export. All original columns preserved in full_data->'original'.`);
out.push(``);
for (let i = 0; i < valueRows.length; i += BATCH) {
  const slice = valueRows.slice(i, i + BATCH);
  out.push(`-- batch ${i / BATCH + 1} (rows ${i + 1}–${i + slice.length})`);
  out.push(`INSERT INTO scans ${colList} VALUES`);
  out.push(slice.join(',\n') + ';');
  out.push(``);
}
process.stdout.write(out.join('\n'));
console.error(`✓ Generated SQL for ${dataRows.length} rows in ${Math.ceil(dataRows.length / BATCH)} batches.`);
