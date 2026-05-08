const { getUser, adminQuery, extractToken, cors } = require('../_supabase');

// Founder-only calibration bypass: a long random secret in the env unlocks
// admin mode (list ALL scans, calibrate any of them) without requiring a
// Supabase login. Set CALIBRATE_SECRET in Vercel to enable. Calibrations made
// in admin mode are stored under this synthetic user id so they're isolated
// from real user calibrations and survive `unique (scan_id, user_id)`.
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Pull secret from query (GET) or body (POST). Constant-time-ish compare.
  const providedSecret = (req.query && req.query.secret) || (req.body && req.body.secret) || null;
  const expectedSecret = process.env.CALIBRATE_SECRET || '';
  const isAdmin = !!(expectedSecret && providedSecret && providedSecret === expectedSecret);

  let user = null;
  if (isAdmin) {
    user = { id: ADMIN_USER_ID, email: 'calibrate@admin' };
  } else {
    const token = extractToken(req);
    user = await getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    // Special mode: ?export=calibrations dumps the user's calibration log as a
    // download-friendly JSON the founder can paste straight into a Claude chat
    // for prompt-tuning. Includes related scan summary so reasons have context.
    if (req.query && req.query.export === 'calibrations') {
      try {
        const calibrations = await adminQuery({
          table: 'calibrations',
          filters: `user_id=eq.${user.id}&order=created_at.desc`,
          select: 'scan_id,ai_score,ai_verdict,product_title,product_url,category,suggested_score,reason,created_at',
        });
        return res.status(200).json({
          exportedAt: new Date().toISOString(),
          count: (calibrations || []).length,
          calibrations: calibrations || [],
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    try {
      // Admin (secret link) sees the most recent 50 scans across all users.
      // Regular signed-in users see only their own.
      const limit = isAdmin ? 50 : 200;
      const filters = isAdmin
        ? `order=created_at.desc&limit=${limit}`
        : `user_id=eq.${user.id}&order=created_at.desc`;
      const ideas = await adminQuery({
        table: 'scans',
        filters,
        select: 'id,url,title,score,verdict,image_url,profit_est,is_public,full_data,created_at',
      });
      // Pull the user's calibrations and attach to matching ideas so the UI
      // can pre-fill the calibration form.
      let calMap = {};
      try {
        const cals = await adminQuery({
          table: 'calibrations',
          filters: `user_id=eq.${user.id}`,
          select: 'scan_id,suggested_score,reason',
        });
        (cals || []).forEach(c => { calMap[c.scan_id] = { suggestedScore: c.suggested_score, reason: c.reason }; });
      } catch (_) {}
      const enriched = (ideas || []).map(i => ({ ...i, calibration: calMap[i.id] || null }));
      return res.status(200).json({ ideas: enriched });
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

        // Free users can't make scans private — public sharing is a free-tier
        // benefit (and feeds the community catalogue). Pro is what unlocks
        // the toggle. Check premium status before honouring a private flip.
        if (Boolean(isPublic) === false) {
          const profiles = await adminQuery({
            table: 'profiles',
            filters: `id=eq.${user.id}`,
            select: 'is_premium',
          });
          if (!profiles?.[0]?.is_premium) {
            return res.status(403).json({ ok: false, proRequired: true, message: 'Pro members can hide scans. Upgrade to make this private.' });
          }
        }

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

    if (action === 'calibrate' && id) {
      const { suggestedScore, reason } = req.body || {};
      const sScore = suggestedScore == null || suggestedScore === '' ? null : Number(suggestedScore);
      if (sScore !== null && (Number.isNaN(sScore) || sScore < 0 || sScore > 100)) {
        return res.status(400).json({ error: 'suggestedScore must be 0-100' });
      }
      try {
        // Admin (secret link) can calibrate any scan; regular users only theirs.
        const scanFilter = isAdmin
          ? `id=eq.${id}`
          : `id=eq.${id}&user_id=eq.${user.id}`;
        const rows = await adminQuery({
          table: 'scans',
          filters: scanFilter,
          select: 'id,score,verdict,title,url,full_data',
        });
        if (!rows?.length) return res.status(403).json({ error: 'Not found' });
        const scan = rows[0];
        // Try to recover the category from full_data (analyze.js sometimes
        // stashes payload.category in the full_data blob).
        let category = null;
        try {
          if (scan.full_data && typeof scan.full_data === 'object') {
            category = scan.full_data.category || scan.full_data?.product?.category || null;
          }
        } catch (_) {}

        // If no suggestedScore + no reason → treat as a delete (reset).
        if (sScore === null && !reason) {
          await adminQuery({
            method: 'DELETE',
            table: 'calibrations',
            filters: `scan_id=eq.${id}&user_id=eq.${user.id}`,
          });
          return res.status(200).json({ ok: true, cleared: true });
        }

        // Upsert: delete-then-insert (Supabase REST upsert needs a header
        // we don't have abstracted, and the unique constraint enforces
        // one-per-(scan_id,user_id) anyway).
        await adminQuery({
          method: 'DELETE',
          table: 'calibrations',
          filters: `scan_id=eq.${id}&user_id=eq.${user.id}`,
        });
        await adminQuery({
          method: 'POST',
          table: 'calibrations',
          body: {
            scan_id: id,
            user_id: user.id,
            ai_score: scan.score != null ? Number(scan.score) : null,
            ai_verdict: scan.verdict || null,
            product_title: scan.title || null,
            product_url: scan.url || null,
            category,
            suggested_score: sScore,
            reason: reason ? String(reason).slice(0, 500) : null,
          },
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
