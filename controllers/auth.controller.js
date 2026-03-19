const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const supabase = require('../config/supabase');

const isProd = process.env.NODE_ENV === 'production';
const log    = (...a) => { if (!isProd) console.error(...a); };

const signToken   = (p) => jwt.sign(p, process.env.JWT_SECRET, { expiresIn: '7d' });
const sendError   = (res, s, m) => res.status(s).json({ success: false, error: m });
const sendSuccess = (res, s, d) => res.status(s).json({ success: true, ...d });

// POST /api/auth/signup
const signup = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendError(res, 400, errors.array()[0].msg);

  const { full_name, whatsapp_number, organization_name, email, password } = req.body;

  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
    });

    if (authError) {
      const dup = authError.message.toLowerCase().includes('already');
      return sendError(res, dup ? 409 : 400,
        dup ? 'An account with this email already exists.' : 'Unable to create account.');
    }

    const { error: dbError } = await supabase.from('users').insert([{
      id: authData.user.id, full_name, whatsapp_number, organization_name, email,
    }]);

    if (dbError) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      return sendError(res, 500, 'Failed to save user profile. Please try again.');
    }

    const token = signToken({ id: authData.user.id, email, full_name, organization_name });
    return sendSuccess(res, 201, {
      token,
      user: { id: authData.user.id, full_name, email, organization_name, whatsapp_number },
    });
  } catch (err) {
    log('[signup]', err);
    return sendError(res, 500, 'Internal server error.');
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendError(res, 400, errors.array()[0].msg);

  const { email, password } = req.body;

  try {
    const { data: session, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) return sendError(res, 401, 'Invalid email or password.');

    const { data: profile, error: profileError } = await supabase
      .from('users').select('id,full_name,email,organization_name,whatsapp_number')
      .eq('id', session.user.id).single();

    if (profileError || !profile) return sendError(res, 404, 'User profile not found.');

    const token = signToken({
      id: profile.id, email: profile.email,
      full_name: profile.full_name, organization_name: profile.organization_name,
    });

    return sendSuccess(res, 200, { token, user: profile });
  } catch (err) {
    log('[login]', err);
    return sendError(res, 500, 'Internal server error.');
  }
};

// GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const { data: profile, error } = await supabase
      .from('users').select('id,full_name,email,organization_name,whatsapp_number,created_at')
      .eq('id', req.user.id).single();

    if (error || !profile) return sendError(res, 404, 'User not found.');
    return sendSuccess(res, 200, { user: profile });
  } catch (err) {
    log('[getMe]', err);
    return sendError(res, 500, 'Internal server error.');
  }
};

// POST /api/auth/logout
const logout = (_req, res) => sendSuccess(res, 200, { message: 'Logged out successfully.' });

module.exports = { signup, login, getMe, logout };
