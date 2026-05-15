// Returns a tiny JS snippet that sets window.SUPABASE_URL / SUPABASE_ANON_KEY
// (both public-by-design) plus window.MM_USERS / window.MM_SCANS for the
// landing-page trust signal. Loaded before the Supabase module init in every
// page that uses auth. Cached for 5 min so this is cheap even at scale.

let _statsCache = { ts: 0, users: 0, scans: 0 };
const STATS_TTL_MS = 5 * 60 * 1000; // 5 min

async function fetchCounts(supaUrl, serviceKey) {
  if (!supaUrl || !serviceKey) return { users: 0, scans: 0 };
  async function countTable(table) {
    try {
      const r = await fetch(`${supaUrl}/rest/v1/${table}?select=count`, {
        method: 'HEAD',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      });
      const range = r.headers.get('content-range') || '';
      return parseInt((range.split('/')[1] || '0'), 10) || 0;
    } catch { return 0; }
  }
  const [users, scans] = await Promise.all([countTable('email_leads'), countTable('scans')]);
  return { users, scans };
}

module.exports = async (req, res) => {
  const env = process.env;
  const url =
    env.SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    env.PUBLIC_SUPABASE_URL ||
    env.VITE_SUPABASE_URL ||
    '';
  const anonKey =
    env.SUPABASE_ANON_KEY ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    env.PUBLIC_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_ANON_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    '';

  // Debug mode: ?debug=1 returns names of env vars matching SUPA/POSTGRES so we
  // can find which prefix Vercel's integration used. No values exposed.
  if (req.query?.debug === '1' || req.url.includes('debug=1')) {
    const names = Object.keys(env)
      .filter(k => /SUPA|POSTGRES|DATABASE_URL/i.test(k))
      .sort();
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ found: names, urlResolved: !!url, keyResolved: !!anonKey });
    return;
  }

  // JSON mode: ?json=1 returns the same data as JSON for direct fetch from
  // client code that doesn't want to evaluate JS. Used by no current caller
  // but keeps the door open.
  const wantsJson = req.query?.json === '1' || req.url.includes('json=1');

  // Counts: best-effort, cached 5 min, never blocks the response on failure.
  let users = _statsCache.users, scans = _statsCache.scans;
  if (Date.now() - _statsCache.ts > STATS_TTL_MS) {
    try {
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '';
      const counts = await fetchCounts(url, serviceKey);
      if (counts.users || counts.scans) {
        _statsCache = { ts: Date.now(), users: counts.users, scans: counts.scans };
        users = counts.users;
        scans = counts.scans;
      }
    } catch { /* keep cached values */ }
  }
  // Floor at sensible minimums so the trust signal doesn't read 0 in early
  // days. Real numbers grow into the gap as signups land.
  users = Math.max(users, 300);
  scans = Math.max(scans, 600);

  if (wantsJson) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.status(200).json({
      supabaseUrl: url ? '<set>' : '',
      supabaseKey: anonKey ? '<set>' : '',
      users,
      scans,
    });
    return;
  }

  const safe = (s) => String(s).replace(/[\\'"<>\r\n]/g, '');
  const lifetimeUrl = env.STRIPE_LIFETIME_URL || '';
  const packUrl = env.STRIPE_PACK_URL || '';
  const body =
    `window.SUPABASE_URL='${safe(url)}';` +
    `window.SUPABASE_ANON_KEY='${safe(anonKey)}';` +
    `window.MM_USERS=${Number(users) || 0};` +
    `window.MM_SCANS=${Number(scans) || 0};` +
    `window.MM_STRIPE_LIFETIME_URL='${safe(lifetimeUrl)}';` +
    `window.MM_STRIPE_PACK_URL='${safe(packUrl)}';` +
    `(function(){var f=function(){document.querySelectorAll('[data-stripe]').forEach(function(a){var k=a.getAttribute('data-stripe');var u=k==='pack'?window.MM_STRIPE_PACK_URL:window.MM_STRIPE_LIFETIME_URL;if(u)a.setAttribute('href',u);});};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',f);}else{f();}})();`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(body);
};
