// Handles both email-only captures (source=idea-page) and full save-results
// from the offer card. Replaces the old separate /api/email endpoint.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, url, score, verdict, consent, timestamp, source } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (scriptUrl) {
    fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        url: url || '',
        score: score || '',
        verdict: verdict || '',
        consent: consent ?? '',
        source: source || 'save-results',
        timestamp: timestamp || new Date().toISOString(),
      }),
    }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
};
