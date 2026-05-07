// Email lead capture: idea-page email gates and the save-results form.
// Primary store is Supabase (email_leads). If GOOGLE_SCRIPT_URL is still set,
// we also forward fire-and-forget so legacy sheets stay populated during the
// transition.

const { adminQuery, hashIp } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, url, score, verdict, consent, timestamp, source } = req.body || {};
  if (!email || !/.+@.+\..+/.test(String(email))) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const clientIp = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const ipHash = hashIp(clientIp);

  try {
    await adminQuery({
      method: 'POST',
      table: 'email_leads',
      body: {
        email: String(email).slice(0, 320),
        url: url ? String(url).slice(0, 500) : null,
        score: score != null && score !== '' ? Number(score) : null,
        verdict: verdict ? String(verdict).slice(0, 200) : null,
        consent: typeof consent === 'boolean' ? consent : (consent === 'true' || consent === 1),
        source: source ? String(source).slice(0, 80) : 'save-results',
        ip_hash: ipHash,
        created_at: timestamp || new Date().toISOString(),
      },
    });
  } catch (e) {
    // Log but don't fail the user — they expect a quick success
    console.error('email_leads insert failed:', e.message);
  }

  // Legacy: keep posting to Google Sheets if the env var is still set.
  // Safe to remove once you've verified Supabase is receiving everything.
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
