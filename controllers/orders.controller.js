/**
 * ─── ORDERS CONTROLLER ───────────────────────────────────────────────────────
 * POST   /api/orders           — create a new order (draft)
 * GET    /api/orders           — list current user's orders
 * GET    /api/orders/:id       — get order detail (incl. payments, files, history)
 * DELETE /api/orders/:id       — cancel a draft order
 */

const { validationResult } = require('express-validator');
const supabase = require('../config/supabase');
const { computeOrderPricing, calculateDynamicPrice } = require('../utils/pricing');
const { assertTransition } = require('../utils/orderStatus');

const isProd    = process.env.NODE_ENV === 'production';
const log       = (...a) => { if (!isProd) console.error(...a); };
const sendError = (res, s, m) => res.status(s).json({ success: false, error: m });
const sendSuccess = (res, s, d) => res.status(s).json({ success: true, ...d });

// ─── Helper: generate order number ────────────────────────────────────────────
async function generateOrderNumber() {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true });
  const seq = String((count || 0) + 1).padStart(6, '0');
  return `ORD-${year}-${seq}`;
}

// ─── Helper: delivery date (business days from now) ───────────────────────────
function deliveryDate(durationDays = 5) {
  const d = new Date();
  d.setDate(d.getDate() + durationDays);
  return d.toISOString();
}

// ─── POST /api/orders ─────────────────────────────────────────────────────────
const createOrder = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return sendError(res, 400, errors.array()[0].msg);

  const { service_id, brief = {}, client_notes, discount_inr = 0 } = req.body;

  try {
    // 1. Fetch service
    const { data: service, error: svcErr } = await supabase
      .from('services')
      .select('*')
      .eq('id', service_id)
      .eq('is_active', true)
      .single();

    if (svcErr || !service) return sendError(res, 404, 'Service not found.');

    // 2. Calculate dynamic price from brief inputs
    let dynamicBasePrice;
    try {
      dynamicBasePrice = calculateDynamicPrice(service.service_type, brief);
    } catch {
      dynamicBasePrice = parseFloat(service.base_price_inr);
    }

    // 3. Build a service snapshot with the dynamic price
    const serviceSnapshot = { ...service, base_price_inr: dynamicBasePrice };
    const pricing = computeOrderPricing(serviceSnapshot, discount_inr);

    // 4. Generate order number
    const orderNumber = await generateOrderNumber();

    // 5. Calculate expected delivery
    const durationDays = service.metadata?.duration_days || 5;
    const expectedDeliveryAt = deliveryDate(durationDays);

    // 6. Insert order
    const { data: order, error: insertErr } = await supabase
      .from('orders')
      .insert([{
        order_number:        orderNumber,
        client_id:           req.user.id,
        service_id:          service.id,
        service_type:        service.service_type,
        ...pricing,
        currency:            'INR',
        status:              'draft',
        brief,
        client_notes:        client_notes || null,
        expected_delivery_at: expectedDeliveryAt,
      }])
      .select()
      .single();

    if (insertErr) throw insertErr;

    // 7. Insert first status history entry
    await supabase.from('order_status_history').insert([{
      order_id:   order.id,
      to_status:  'draft',
      changed_by: req.user.id,
      note:       'Order created.',
    }]);

    return sendSuccess(res, 201, {
      order: {
        ...order,
        service_name: service.display_name,
      },
    });
  } catch (err) {
    log('[createOrder]', err);
    return sendError(res, 500, 'Failed to create order.');
  }
};

// ─── GET /api/orders ──────────────────────────────────────────────────────────
const listOrders = async (req, res) => {
  try {
    const { status, page = '1', limit = '10' } = req.query;
    const pageNum  = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(parseInt(limit) || 10, 50);
    const from     = (pageNum - 1) * limitNum;
    const to       = from + limitNum - 1;

    let query = supabase
      .from('orders')
      .select(`
        id, order_number, service_type, status, final_price_inr,
        advance_amount, balance_amount, currency,
        expected_delivery_at, delivered_at, created_at, updated_at,
        services ( display_name )
      `, { count: 'exact' })
      .eq('client_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (status) query = query.eq('status', status);

    const { data, error, count } = await query;
    if (error) throw error;

    const orders = (data || []).map((o) => ({
      ...o,
      service_name: o.services?.display_name,
      services:     undefined,
    }));

    return sendSuccess(res, 200, {
      orders,
      pagination: {
        total:       count || 0,
        page:        pageNum,
        limit:       limitNum,
        total_pages: Math.ceil((count || 0) / limitNum),
      },
    });
  } catch (err) {
    log('[listOrders]', err);
    return sendError(res, 500, 'Failed to fetch orders.');
  }
};

// ─── GET /api/orders/:id ──────────────────────────────────────────────────────
const getOrder = async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        *,
        services ( display_name, description, metadata )
      `)
      .eq('id', req.params.id)
      .eq('client_id', req.user.id)
      .single();

    if (error || !order) return sendError(res, 404, 'Order not found.');

    // Fetch related data in parallel
    const [paymentsRes, filesRes, historyRes] = await Promise.all([
      supabase
        .from('payments')
        .select('id, payment_type, status, amount_paise, currency, paid_at, created_at')
        .eq('order_id', order.id)
        .order('created_at', { ascending: true }),

      supabase
        .from('order_files')
        .select('id, category, file_name, content_type, file_size_bytes, created_at')
        .eq('order_id', order.id)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false }),

      supabase
        .from('order_status_history')
        .select('id, from_status, to_status, note, created_at')
        .eq('order_id', order.id)
        .order('created_at', { ascending: true }),
    ]);

    return sendSuccess(res, 200, {
      order: {
        ...order,
        service_name: order.services?.display_name,
        service:      order.services,
        services:     undefined,
        payments:     paymentsRes.data || [],
        files:        filesRes.data    || [],
        status_history: historyRes.data || [],
      },
    });
  } catch (err) {
    log('[getOrder]', err);
    return sendError(res, 500, 'Failed to fetch order.');
  }
};

// ─── DELETE /api/orders/:id (cancel) ─────────────────────────────────────────
const cancelOrder = async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, status, client_id')
      .eq('id', req.params.id)
      .eq('client_id', req.user.id)
      .single();

    if (error || !order) return sendError(res, 404, 'Order not found.');

    try {
      assertTransition(order.status, 'cancelled');
    } catch (e) {
      return sendError(res, e.status || 400, e.message);
    }

    const { error: updateErr } = await supabase
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', order.id);

    if (updateErr) throw updateErr;

    await supabase.from('order_status_history').insert([{
      order_id:   order.id,
      from_status: order.status,
      to_status:  'cancelled',
      changed_by: req.user.id,
      note:       req.body.reason || 'Cancelled by client.',
    }]);

    return sendSuccess(res, 200, { message: 'Order cancelled.' });
  } catch (err) {
    log('[cancelOrder]', err);
    return sendError(res, 500, 'Failed to cancel order.');
  }
};

module.exports = { createOrder, listOrders, getOrder, cancelOrder };
