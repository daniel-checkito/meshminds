module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, consent, timestamp } = req.body || {};

  // Log to Google Apps Script (fire-and-forget)
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (scriptUrl && email) {
    fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, consent, timestamp, source: 'idea-page' }),
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
};
