const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};

  // ── Feedback action: update an existing scan with rating + comment ──
  if (body.action === 'feedback') {
    const { scanId, rating, comment } = body;
    if (!scanId) return res.status(400).json({ error: 'scanId required' });
    const r = rating === 1 || rating === -1 || rating === 0 ? rating : null;
    try {
      const updated = await adminQuery({
        method: 'PATCH',
        table: 'scans',
        filters: `id=eq.${scanId}&user_id=eq.${user.id}`,
        body: {
          feedback_rating: r,
          feedback_comment: comment ? String(comment).slice(0, 1000) : null,
          feedback_at: new Date().toISOString(),
        },
      });
      if (!updated || updated.length === 0) return res.status(404).json({ error: 'Scan not found' });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const { url, title, score, verdict, imageUrl, profitEst, isPublic, fullData } = body;
  if (!url && !title) return res.status(400).json({ error: 'url or title required' });

  try {
    // Free users: scans are always public (it's a free tier benefit — others
    // can learn from your scan, you get listed on the community feed). Only
    // Pro users can flip the toggle to private. Read both flags in one query.
    const profiles = await adminQuery({
      table: 'profiles',
      filters: `id=eq.${user.id}`,
      select: 'default_public,is_premium',
    });
    const isPro = profiles?.[0]?.is_premium || false;
    const defaultPublic = profiles?.[0]?.default_public;
    let resolvedPublic;
    if (!isPro) {
      resolvedPublic = true; // free tier: always public
    } else if (isPublic !== undefined) {
      resolvedPublic = Boolean(isPublic);
    } else {
      resolvedPublic = defaultPublic !== false; // pro user without explicit pref → default public
    }

    const row = {
      user_id: user.id,
      url: String(url).slice(0, 500),
      title: title ? String(title).slice(0, 200) : null,
      score: score != null ? Number(score) : null,
      verdict: verdict ? String(verdict).slice(0, 200) : null,
      image_url: imageUrl ? String(imageUrl).slice(0, 500) : null,
      profit_est: profitEst ? String(profitEst).slice(0, 50) : null,
      is_public: resolvedPublic,
      full_data: fullData || null,
    };

    const result = await adminQuery({ method: 'POST', table: 'scans', body: row });
    return res.status(200).json({ ok: true, id: result?.[0]?.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
