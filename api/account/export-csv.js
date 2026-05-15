// GET /api/account/export-csv → CSV of the signed-in user's scan history.
// Pro-only: free users get a 402 with an upgrade prompt.

const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Sign in required' });

  // Gate on Pro membership
  let isPro = false;
  try {
    const profiles = await adminQuery({
      table: 'profiles',
      filters: `id=eq.${user.id}`,
      select: 'is_premium,premium_until',
    });
    const p = profiles?.[0];
    isPro = !!(p && p.is_premium && (!p.premium_until || new Date(p.premium_until) > new Date()));
  } catch {}
  if (!isPro) {
    return res.status(402).json({ error: 'Pro membership required', proRequired: true });
  }

  let rows;
  try {
    rows = await adminQuery({
      table: 'scans',
      filters: `user_id=eq.${user.id}&order=created_at.desc`,
      select: 'id,created_at,url,title,score,verdict,profit_est,is_public',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const header = ['scan_id','created_at','url','title','score','verdict','profit_est','is_public'];
  const lines = [header.join(',')];
  for (const r of (rows || [])) {
    lines.push([
      csvEscape(r.id),
      csvEscape(r.created_at),
      csvEscape(r.url),
      csvEscape(r.title),
      csvEscape(r.score),
      csvEscape(r.verdict),
      csvEscape(r.profit_est),
      csvEscape(r.is_public),
    ].join(','));
  }

  const filename = `meshminds-scans-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(lines.join('\n'));
};
