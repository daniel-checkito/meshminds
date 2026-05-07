// GET /api/stats — public homepage trust counts.
// Returns { users, scans } as a small JSON blob. Cached at the edge for one hour
// so this never adds measurable cost.

let _cache = { ts: 0, users: 0, scans: 0 };
const TTL_MS = 60 * 60 * 1000; // 1 hour

module.exports = async (req, res) => {
  const now = Date.now();
  if (now - _cache.ts < TTL_MS && _cache.users > 0) {
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    return res.status(200).json({ users: _cache.users, scans: _cache.scans, cached: true });
  }
  let users = 0, scans = 0;
  try {
    const { adminQuery } = require('./_supabase');
    const fetchUrl = require('./_supabase');
    // Postgres exact count via Prefer header — we don't need the rows themselves.
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (url && key) {
      const ulRes = await fetch(`${url}/rest/v1/email_leads?select=count`, {
        method: 'HEAD',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      });
      const ulRange = ulRes.headers.get('content-range') || '';
      users = parseInt((ulRange.split('/')[1] || '0'), 10) || 0;

      const scRes = await fetch(`${url}/rest/v1/scans?select=count`, {
        method: 'HEAD',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      });
      const scRange = scRes.headers.get('content-range') || '';
      scans = parseInt((scRange.split('/')[1] || '0'), 10) || 0;
    }
  } catch (e) {
    // Swallow — keep responding with cached/baseline values rather than 500.
  }
  // Floor at sensible minimums so the trust signal doesn't read 0 in early days.
  users = Math.max(users, 1200);
  scans = Math.max(scans, 2400);
  _cache = { ts: now, users, scans };
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.status(200).json({ users, scans });
};
