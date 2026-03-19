/**
 * ─── ADMIN MIDDLEWARE ─────────────────────────────────────────────────────────
 * Must be used AFTER verifyToken.
 * Checks that the authenticated user has the 'admin' role.
 */

const supabase = require('../config/supabase');

const verifyAdmin = async (req, res, next) => {
  try {
    const { data: profile, error } = await supabase
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .single();

    if (error || !profile) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    if (profile.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required.' });
    }

    next();
  } catch {
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
};

module.exports = { verifyAdmin };
