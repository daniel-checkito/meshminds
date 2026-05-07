const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const profiles = await adminQuery({
      table: 'profiles',
      filters: `id=eq.${user.id}`,
      select: 'display_name,avatar_url,default_public,is_premium,premium_until,free_scans_used',
    });
    const profile = profiles?.[0] || {};

    const scansCountResult = await adminQuery({
      table: 'scans',
      filters: `user_id=eq.${user.id}&select=count`,
    });
    const scansCount = Array.isArray(scansCountResult) ? scansCountResult.length : 0;

    return res.status(200).json({
      id: user.id,
      email: user.email,
      displayName: profile.display_name || '',
      avatarUrl: profile.avatar_url || '',
      defaultPublic: profile.default_public || false,
      isPro: profile.is_premium || false,
      premiumUntil: profile.premium_until || null,
      freeScansUsed: profile.free_scans_used || 0,
      scansCount,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
