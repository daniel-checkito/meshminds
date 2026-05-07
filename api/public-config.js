// Returns a tiny JS snippet that sets window.SUPABASE_URL / SUPABASE_ANON_KEY
// from server-side env vars. Both values are PUBLIC (anon key is meant to be
// exposed). Loaded before the Supabase module init in every page that uses auth.

module.exports = (req, res) => {
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

  const safe = (s) => String(s).replace(/[\\'"<>\r\n]/g, '');
  const body = `window.SUPABASE_URL='${safe(url)}';window.SUPABASE_ANON_KEY='${safe(anonKey)}';`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).send(body);
};
