/**
 * ─── SERVICES CONTROLLER ─────────────────────────────────────────────────────
 * GET /api/services       — list all active services
 * GET /api/services/:id   — get a single service
 */

const supabase = require('../config/supabase');

const isProd    = process.env.NODE_ENV === 'production';
const log       = (...a) => { if (!isProd) console.error(...a); };
const sendError = (res, s, m) => res.status(s).json({ success: false, error: m });
const sendSuccess = (res, s, d) => res.status(s).json({ success: true, ...d });

// GET /api/services
const listServices = async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // Enrich with computed advance/balance amounts
    const services = (data || []).map((svc) => {
      const base    = parseFloat(svc.base_price_inr);
      const advPct  = svc.advance_percent;
      const advance = Math.round(base * advPct) / 100;
      return {
        ...svc,
        advance_amount: advance,
        balance_amount: Math.round((base - advance) * 100) / 100,
      };
    });

    return sendSuccess(res, 200, { services });
  } catch (err) {
    log('[listServices]', err);
    return sendError(res, 500, 'Failed to fetch services.');
  }
};

// GET /api/services/:id
const getService = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .single();

    if (error || !data) return sendError(res, 404, 'Service not found.');

    const base    = parseFloat(data.base_price_inr);
    const advPct  = data.advance_percent;
    const advance = Math.round(base * advPct) / 100;

    return sendSuccess(res, 200, {
      service: {
        ...data,
        advance_amount: advance,
        balance_amount: Math.round((base - advance) * 100) / 100,
      },
    });
  } catch (err) {
    log('[getService]', err);
    return sendError(res, 500, 'Failed to fetch service.');
  }
};

module.exports = { listServices, getService };
