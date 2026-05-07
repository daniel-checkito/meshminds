const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method === 'GET') {
    try {
      const ideas = await adminQuery({
        table: 'scans',
        filters: `user_id=eq.${user.id}&order=created_at.desc`,
        select: 'id,url,title,score,verdict,image_url,profit_est,is_public,created_at',
      });
      return res.status(200).json({ ideas: ideas || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { action, id, isPublic } = req.body || {};

    if (action === 'toggle' && id) {
      try {
        // Verify this scan belongs to this user AND check pro-lock status
        const rows = await adminQuery({
          table: 'scans',
          filters: `id=eq.${id}&user_id=eq.${user.id}`,
          select: 'id,pro_locked',
        });
        if (!rows?.length) return res.status(403).json({ error: 'Not found' });

        // Pro-locked scans are guaranteed private - they can never be flipped public,
        // even if the user is no longer Pro. This backstops the marketing promise.
        if (rows[0].pro_locked && Boolean(isPublic)) {
          return res.status(200).json({ ok: false, locked: true, message: 'Scans saved while you were Pro stay private - that was the deal.' });
        }

        await adminQuery({
          method: 'PATCH',
          table: 'scans',
          filters: `id=eq.${id}`,
          body: { is_public: Boolean(isPublic) },
        });
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    if (action === 'delete' && id) {
      try {
        const rows = await adminQuery({
          table: 'scans',
          filters: `id=eq.${id}&user_id=eq.${user.id}`,
          select: 'id',
        });
        if (!rows?.length) return res.status(403).json({ error: 'Not found' });

        await adminQuery({
          method: 'DELETE',
          table: 'scans',
          filters: `id=eq.${id}`,
        });
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
