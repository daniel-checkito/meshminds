// Returns a tiny JS snippet that sets window.SUPABASE_URL / SUPABASE_ANON_KEY
// from server-side env vars. Both values are PUBLIC (anon key is meant to be
// exposed). Loaded before the Supabase module init in every page that uses auth.

module.exports = (req, res) => {
  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';
  const safe = (s) => String(s).replace(/[\\'"<>\r\n]/g, '');
  const body = `window.SUPABASE_URL='${safe(url)}';window.SUPABASE_ANON_KEY='${safe(anonKey)}';`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).send(body);
};
