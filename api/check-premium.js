/**
 * GET /api/check-premium?uid=TELEGRAM_UID
 * Returns { premium: true/false, expiry: ISO_DATE }
 */
const db = require('../lib/db');
const { setCors, handleOptions } = require('../lib/cors');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  setCors(res);

  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  try {
    const sub = await db.get(`sub:${uid}`);
    if (!sub) return res.json({ premium: false });

    const now = Date.now();
    if (sub.expiry && sub.expiry < now) {
      await db.del(`sub:${uid}`);
      return res.json({ premium: false, expired: true });
    }

    return res.json({
      premium: true,
      expiry: new Date(sub.expiry).toISOString(),
      plan: sub.plan || 'monthly'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
