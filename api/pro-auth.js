// POST {sessionId} → validates Stripe checkout session → returns signed JWT
// Called once by /pro/success after Stripe redirects

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

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(500).json({ error: 'Stripe not configured' });

  const stripeRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );

  if (!stripeRes.ok) return res.status(400).json({ error: 'Invalid session' });
  const session = await stripeRes.json();

  if (session.payment_status !== 'paid') {
    return res.status(400).json({ error: 'Payment not completed' });
  }

  const email = session.customer_details?.email || session.customer_email || '';
  const customerId = session.customer || '';

  let token;
  try {
    token = issueToken({
      email,
      customerId,
      exp: Date.now() + 35 * 24 * 60 * 60 * 1000, // 35 days
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({ ok: true, token, email });
};
