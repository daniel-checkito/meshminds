// POST {token} → verifies JWT → returns {ok, member}
// Called on every Pro page load to gate access

const crypto = require('crypto');

function verifyToken(token) {
  const secret = process.env.PRO_JWT_SECRET;
  if (!secret) return null;
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  if (s !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false, error: 'Invalid or expired token' });

  return res.status(200).json({ ok: true, member: { email: payload.email } });
};
