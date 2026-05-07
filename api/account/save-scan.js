const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { url, title, score, verdict, imageUrl, profitEst, isPublic, fullData } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    // Get user's default_public setting
    const profiles = await adminQuery({
      table: 'profiles',
      filters: `id=eq.${user.id}`,
      select: 'default_public',
    });
    const defaultPublic = profiles?.[0]?.default_public || false;

    const row = {
      user_id: user.id,
      url: String(url).slice(0, 500),
      title: title ? String(title).slice(0, 200) : null,
      score: score != null ? Number(score) : null,
      verdict: verdict ? String(verdict).slice(0, 200) : null,
      image_url: imageUrl ? String(imageUrl).slice(0, 500) : null,
      profit_est: profitEst ? String(profitEst).slice(0, 50) : null,
      is_public: isPublic !== undefined ? Boolean(isPublic) : defaultPublic,
      full_data: fullData || null,
    };

    const result = await adminQuery({ method: 'POST', table: 'scans', body: row });
    return res.status(200).json({ ok: true, id: result?.[0]?.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
