// Shared Supabase REST helpers - no npm packages, pure fetch

function supabaseUrl() {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error('SUPABASE_URL not set');
  return u.replace(/\/$/, '');
}

function serviceKey() {
  const k = process.env.SUPABASE_SERVICE_KEY;
  if (!k) throw new Error('SUPABASE_SERVICE_KEY not set');
  return k;
}

function anonKey() {
  const k = process.env.SUPABASE_ANON_KEY;
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

module.exports = { getUser, adminQuery, extractToken, cors };
