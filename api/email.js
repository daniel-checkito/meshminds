// Vercel serverless function — replaces n8n email capture webhook.
// Logs to Google Sheets via the Sheets API if GOOGLE_SHEETS_ID and
// GOOGLE_SERVICE_ACCOUNT_KEY are set; otherwise silently succeeds.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, consent, timestamp } = req.body || {};

  // Fire-and-forget Google Sheets append (optional — works without it)
  const sheetId = process.env.GOOGLE_SHEETS_ID;
  const serviceKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (sheetId && serviceKey && email) {
    appendToSheet(sheetId, serviceKey, {
      timestamp: timestamp || new Date().toISOString(),
      email: email || '',
      consent: consent ? 'true' : 'false',
    }).catch(e => console.error('Sheet append failed:', e.message));
  }

  return res.status(200).json({ ok: true });
};

async function appendToSheet(sheetId, serviceKeyJson, row) {
  const key = JSON.parse(serviceKeyJson);
  const token = await getGoogleAccessToken(key);
  const range = encodeURIComponent('Emails!A:C');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ values: [[row.timestamp, row.email, row.consent]] }),
  });
}

async function getGoogleAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const claim = btoa(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const { createSign } = await import('node:crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  const sig = sign.sign(key.private_key, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${header}.${claim}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  return data.access_token;
}
