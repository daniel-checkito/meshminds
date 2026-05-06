// POST {email} → checks Stripe for active subscription → returns new JWT
// Used by /pro/login for returning members whose token expired

const crypto = require('crypto');

function issueToken(payload) {
  const secret = process.env.PRO_JWT_SECRET;
  if (!secret) throw new Error('PRO_JWT_SECRET not configured');
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });

  // Search Stripe for customers with this email
  const custRes = await fetch(
    `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'&limit=1`,
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );
  const custData = await custRes.json();
  const customer = custData.data?.[0];
  if (!customer) return res.status(403).json({ error: 'No membership found for this email' });

  // Check for active subscription
  const subRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=1`,
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );
  const subData = await subRes.json();
  const sub = subData.data?.[0];
  if (!sub) return res.status(403).json({ error: 'No active subscription found' });

  let token;
  try {
    token = issueToken({
      email,
      customerId: customer.id,
      exp: Date.now() + 35 * 24 * 60 * 60 * 1000,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({ ok: true, token, email });
};
