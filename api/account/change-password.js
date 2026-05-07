const { getUser, extractToken, cors } = require('../_supabase');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = extractToken(req);
  const user = await getUser(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const sk = process.env.SUPABASE_SERVICE_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

  try {
    const res2 = await fetch(`${supabaseUrl}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'apikey': sk,
        'Authorization': `Bearer ${sk}`,
      },
      body: JSON.stringify({ password: newPassword }),
    });
    if (!res2.ok) {
      const err = await res2.text();
      return res.status(400).json({ error: err });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
