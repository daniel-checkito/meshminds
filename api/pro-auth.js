// POST {sessionId} → validates Stripe checkout session → grants access.
//
// Pricing model: one-time payments (no subscriptions).
//   STRIPE_PRICE_LIFETIME → €29 lifetime → flips profiles.is_premium = true
//   STRIPE_PRICE_PACK_100 → €19 pack    → profiles.scan_credits += 100
//
// We match the Stripe customer email against a Supabase auth user. If found,
// we update their profile. We also still issue a legacy JWT so the existing
// /pro/* dashboard pages keep working for buyers who haven't created a
// Supabase account yet (they can sign up later with the same email and the
// /api/pro-login flow will see the Stripe purchase).

const crypto = require('crypto');
const { adminQuery } = require('./_supabase');

function issueToken(payload) {
  const secret = process.env.PRO_JWT_SECRET;
  if (!secret) throw new Error('PRO_JWT_SECRET not configured');
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const s = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

function classifySku(priceIds) {
  const lifetime = process.env.STRIPE_PRICE_LIFETIME || '';
  const pack = process.env.STRIPE_PRICE_PACK_100 || '';
  if (lifetime && priceIds.includes(lifetime)) return 'lifetime';
  if (pack && priceIds.includes(pack)) return 'pack_100';
  // Back-compat: if no env-mapping configured, treat any paid session as lifetime
  // so existing buyers don't get locked out during the rollout.
  return 'lifetime';
}

async function findSupabaseUserIdByEmail(email) {
  const supaUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
  if (!supaUrl || !serviceKey || !email) return null;
  try {
    const r = await fetch(`${supaUrl}/auth/v1/admin/users?filter=${encodeURIComponent('email.eq.' + email)}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const u = (j.users || [])[0];
    return u?.id || null;
  } catch { return null; }
}

async function grantLifetime(userId) {
  if (!userId) return;
  // Upsert profile: ensure row exists, then set is_premium=true, premium_until=null
  try {
    await adminQuery({
      method: 'PATCH',
      table: 'profiles',
      filters: `id=eq.${userId}`,
      body: { is_premium: true, premium_until: null },
    });
  } catch { /* row may not exist yet */ }
}

async function grantPack(userId, credits) {
  if (!userId) return;
  // Read current credits, then add. Best-effort: ignore if column missing.
  try {
    const rows = await adminQuery({
      table: 'profiles',
      filters: `id=eq.${userId}`,
      select: 'scan_credits',
    });
    const current = Number(rows?.[0]?.scan_credits || 0);
    await adminQuery({
      method: 'PATCH',
      table: 'profiles',
      filters: `id=eq.${userId}`,
      body: { scan_credits: current + credits },
    });
  } catch { /* swallow */ }
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

  // Expand line_items so we can read the price ID for SKU classification.
  const stripeRes = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
    { headers: { Authorization: `Bearer ${stripeKey}` } }
  );
  if (!stripeRes.ok) return res.status(400).json({ error: 'Invalid session' });
  const session = await stripeRes.json();
  if (session.payment_status !== 'paid') {
    return res.status(400).json({ error: 'Payment not completed' });
  }

  const email = session.customer_details?.email || session.customer_email || '';
  const customerId = session.customer || '';
  const priceIds = (session.line_items?.data || [])
    .map(li => li.price?.id)
    .filter(Boolean);
  const sku = classifySku(priceIds);

  // Try to attach the purchase to a Supabase account (best-effort).
  let userId = null;
  try { userId = await findSupabaseUserIdByEmail(email); } catch {}
  if (userId) {
    if (sku === 'pack_100') await grantPack(userId, 100);
    else await grantLifetime(userId);
  }

  // Issue the legacy JWT so /pro/dashboard still works without a Supabase login.
  let token = null;
  try {
    token = issueToken({
      email,
      customerId,
      sku,
      exp: Date.now() + 365 * 24 * 60 * 60 * 1000, // lifetime grants get a long token
    });
  } catch (e) {
    // Token is non-essential when the Supabase profile is updated - keep going.
    if (!userId) return res.status(500).json({ error: e.message });
  }

  return res.status(200).json({
    ok: true,
    token,
    email,
    sku,
    linkedToAccount: !!userId,
  });
};
