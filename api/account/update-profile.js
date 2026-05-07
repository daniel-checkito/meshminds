const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { displayName, avatarUrl, defaultPublic } = req.body || {};

  const patch = {};
  if (displayName !== undefined) patch.display_name = String(displayName).slice(0, 60);
  if (avatarUrl !== undefined) patch.avatar_url = String(avatarUrl).slice(0, 500);
  if (defaultPublic !== undefined) patch.default_public = Boolean(defaultPublic);

  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    await adminQuery({
      method: 'PATCH',
      table: 'profiles',
      filters: `id=eq.${user.id}`,
      body: patch,
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
