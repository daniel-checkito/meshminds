// Shared Supabase REST helpers - no npm packages, pure fetch

const crypto = require('crypto');
const env = process.env;

// SHA-256 hash an IP (so we never store raw IPs)
function hashIp(ip) {
  if (!ip) return 'anon';
  const salt = env.IP_HASH_SALT || 'meshminds-default-salt';
  return crypto.createHash('sha256').update(salt + ':' + ip).digest('hex').slice(0, 32);
}

// Daily usage check. Returns { allowed: bool, used: int, limit: int }.
// userId = Supabase user.id when logged in, null otherwise.
// isPro = true if the user is on a pro plan (no limit).
async function checkDailyLimit({ userId, ipHash, isPro }) {
  if (isPro) return { allowed: true, used: 0, limit: -1 };
  // Free tier: 2 scans/day (anon and logged-in). Pro is unlimited.
  const limit = userId ? 2 : 1;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const filterKey = userId ? `user_id=eq.${userId}` : `ip_hash=eq.${ipHash}`;
  try {
    const rows = await adminQuery({
      table: 'usage_log',
      filters: `${filterKey}&kind=eq.scan&created_at=gte.${since}&select=id`,
    });
    const used = Array.isArray(rows) ? rows.length : 0;
    return { allowed: used < limit, used, limit };
  } catch (e) {
    // If the table doesn't exist or DB is unreachable, fail open
    return { allowed: true, used: 0, limit };
  }
}

// Log a scan attempt for rate-limiting purposes.
async function logUsage({ userId, ipHash, kind = 'scan' }) {
  try {
    await adminQuery({
      method: 'POST',
      table: 'usage_log',
      body: { user_id: userId || null, ip_hash: ipHash || null, kind },
    });
  } catch { /* swallow - logging should never break the request */ }
}

function supabaseUrl() {
  const u = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || '';
  if (!u) throw new Error('SUPABASE_URL not set');
  return u.replace(/\/$/, '');
}

function serviceKey() {
  // Vercel integration uses SUPABASE_SERVICE_ROLE_KEY; accept both names
  const k = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  return k;
}

function anonKey() {
  const k = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.PUBLIC_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '';
  if (!k) throw new Error('SUPABASE_ANON_KEY not set');
  return k;
}

// Verify a Supabase access token and return the user object, or null
async function getUser(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${supabaseUrl()}/auth/v1/user`, {
      headers: {
        'apikey': anonKey(),
        'Authorization': `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Run a REST query against a table using the service role (bypasses RLS)
async function adminQuery({ method = 'GET', table, filters = '', body, select = '*' }) {
  const sk = serviceKey();
  const url = `${supabaseUrl()}/rest/v1/${table}${filters ? '?' + filters : ''}`;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': sk,
    'Authorization': `Bearer ${sk}`,
    'Prefer': 'return=representation',
  };
  if (select && method === 'GET') {
    headers['Accept'] = 'application/json';
  }
  const res = await fetch(url + (method === 'GET' && select ? (filters ? '&' : '?') + 'select=' + select : ''), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Extract Bearer token from Authorization header or cookie named 'sb_token'
function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  const cookies = req.headers['cookie'] || '';
  const match = cookies.match(/sb_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Standard CORS headers for all API routes
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

module.exports = { getUser, adminQuery, extractToken, cors, hashIp, checkDailyLimit, logUsage };
