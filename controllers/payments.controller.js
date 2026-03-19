/**
 * ─── PAYMENTS CONTROLLER ─────────────────────────────────────────────────────
 * POST /api/orders/:orderId/payments   — initiate a Razorpay payment
 * POST /api/payments/verify            — verify Razorpay HMAC signature
 * POST /api/payments/webhook/razorpay  — Razorpay webhook (raw body)
 * GET  /api/orders/:orderId/payments   — list payments for an order
 */

const crypto   = require('crypto');
const Razorpay = require('razorpay');
const supabase = require('../config/supabase');
const { getPaymentAmount, toPaise } = require('../utils/pricing');
const { assertTransition, resolveStatusAfterPayment, STATUS_LABELS } = require('../utils/orderStatus');

const isProd    = process.env.NODE_ENV === 'production';
const log       = (...a) => { if (!isProd) console.error(...a); };
const sendError = (res, s, m) => res.status(s).json({ success: false, error: m });
const sendSuccess = (res, s, d) => res.status(s).json({ success: true, ...d });

// Lazy-init Razorpay so missing env keys don't crash on startup
let _rzp = null;
function getRzp() {
  if (!_rzp) {
    _rzp = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _rzp;
}

// ─── POST /api/orders/:orderId/payments ──────────────────────────────────────
const initiatePayment = async (req, res) => {
  const { payment_type, gateway = 'razorpay' } = req.body;
  const { orderId } = req.params;

  if (!['advance', 'balance', 'full'].includes(payment_type))
    return sendError(res, 400, 'payment_type must be advance, balance, or full.');

  if (gateway !== 'razorpay')
    return sendError(res, 400, 'Only razorpay is supported at this time.');

  try {
    // 1. Fetch order (must belong to current user)
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('client_id', req.user.id)
      .single();

    if (orderErr || !order) return sendError(res, 404, 'Order not found.');

    if (['completed', 'cancelled'].includes(order.status))
      return sendError(res, 400, `Cannot pay for a ${STATUS_LABELS[order.status]} order.`);

    // 2. Calculate amount due
    let amountInr;
    try {
      amountInr = await getPaymentAmount(order, payment_type, supabase);
    } catch (e) {
      return sendError(res, e.status || 400, e.message);
    }

    const amountPaise = toPaise(amountInr);

    // 3. Create Razorpay order
    const rzp = getRzp();
    const rzpOrder = await rzp.orders.create({
      amount:   amountPaise,
      currency: 'INR',
      receipt:  `ord_${orderId.slice(0, 8)}_${Date.now()}`,
      notes: {
        internal_order_id: orderId,
        payment_type,
        client_id: req.user.id,
      },
    });

    // 4. Insert pending payment record
    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .insert([{
        order_id:         orderId,
        client_id:        req.user.id,
        payment_type,
        gateway:          'razorpay',
        status:           'pending',
        amount_paise:     amountPaise,
        currency:         'INR',
        gateway_order_id: rzpOrder.id,
      }])
      .select()
      .single();

    if (payErr) throw payErr;

    // 5. Move order to pending_payment if still draft
    if (order.status === 'draft') {
      await supabase
        .from('orders')
        .update({ status: 'pending_payment' })
        .eq('id', orderId);

      await supabase.from('order_status_history').insert([{
        order_id:    orderId,
        from_status: 'draft',
        to_status:   'pending_payment',
        changed_by:  req.user.id,
        note:        'Payment initiated.',
      }]);
    }

    return sendSuccess(res, 201, {
      payment: {
        id:               payment.id,
        gateway_order_id: rzpOrder.id,
        amount_paise:     amountPaise,
        amount_inr:       amountInr,
        currency:         'INR',
        key_id:           process.env.RAZORPAY_KEY_ID,
      },
    });
  } catch (err) {
    log('[initiatePayment]', err);
    return sendError(res, 500, 'Failed to initiate payment.');
  }
};

// ─── POST /api/payments/verify ────────────────────────────────────────────────
const verifyPayment = async (req, res) => {
  const { payment_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!payment_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return sendError(res, 400, 'Missing required verification fields.');

  try {
    // 1. HMAC-SHA256 verification
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature)
      return sendError(res, 400, 'Payment verification failed. Invalid signature.');

    // 2. Fetch internal payment record
    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .select('*, orders(*)')
      .eq('id', payment_id)
      .eq('client_id', req.user.id)
      .single();

    if (payErr || !payment) return sendError(res, 404, 'Payment record not found.');
    if (payment.status === 'captured') return sendSuccess(res, 200, {
      payment: { status: 'captured' },
      order: { id: payment.order_id, status: payment.orders.status },
    });

    // 3. Mark payment as captured
    const { error: updatePayErr } = await supabase
      .from('payments')
      .update({
        status:             'captured',
        gateway_payment_id: razorpay_payment_id,
        gateway_signature:  razorpay_signature,
        paid_at:            new Date().toISOString(),
      })
      .eq('id', payment_id);

    if (updatePayErr) throw updatePayErr;

    // 4. Sum all captured payments for this order
    const { data: allCaptures } = await supabase
      .from('payments')
      .select('amount_paise')
      .eq('order_id', payment.order_id)
      .eq('status', 'captured');

    const totalCapturedPaise = (allCaptures || []).reduce(
      (sum, p) => sum + (p.amount_paise || 0), 0
    ) + payment.amount_paise; // add the one we just captured

    // 5. Determine new order status
    const order       = payment.orders;
    const newStatus   = resolveStatusAfterPayment(order, payment.payment_type, totalCapturedPaise);

    try {
      assertTransition(order.status, newStatus);
    } catch {
      // Already at this status or beyond — no-op
    }

    await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', payment.order_id);

    await supabase.from('order_status_history').insert([{
      order_id:    payment.order_id,
      from_status: order.status,
      to_status:   newStatus,
      changed_by:  req.user.id,
      note:        `Payment of ₹${(payment.amount_paise / 100).toFixed(2)} captured.`,
    }]);

    // 6. Notify client
    await supabase.from('notifications').insert([{
      user_id:  req.user.id,
      order_id: payment.order_id,
      title:    'Payment Successful',
      body:     `₹${(payment.amount_paise / 100).toFixed(2)} received for order ${order.order_number}. Status: ${STATUS_LABELS[newStatus]}.`,
    }]);

    return sendSuccess(res, 200, {
      payment: { status: 'captured', paid_at: new Date().toISOString() },
      order:   { id: payment.order_id, status: newStatus },
    });
  } catch (err) {
    log('[verifyPayment]', err);
    return sendError(res, 500, 'Failed to verify payment.');
  }
};

// ─── POST /api/payments/webhook/razorpay ─────────────────────────────────────
// Uses raw body (registered before express.json() in server.js)
const razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature     = req.headers['x-razorpay-signature'];

    if (webhookSecret && signature) {
      const expected = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.body) // raw buffer
        .digest('hex');
      if (expected !== signature) return res.status(400).json({ success: false });
    }

    const event   = JSON.parse(req.body.toString());
    const payload = event?.payload?.payment?.entity;
    if (!payload || event.event !== 'payment.captured') {
      return res.json({ success: true }); // ack non-relevant events
    }

    const rzpPaymentId = payload.id;
    const rzpOrderId   = payload.order_id;

    // Idempotent: if already captured, skip
    const { data: existing } = await supabase
      .from('payments')
      .select('id, status')
      .eq('gateway_order_id', rzpOrderId)
      .single();

    if (!existing || existing.status === 'captured') return res.json({ success: true });

    await supabase
      .from('payments')
      .update({
        status:             'captured',
        gateway_payment_id: rzpPaymentId,
        gateway_response:   payload,
        paid_at:            new Date().toISOString(),
      })
      .eq('id', existing.id);

    return res.json({ success: true });
  } catch (err) {
    log('[razorpayWebhook]', err);
    return res.status(500).json({ success: false });
  }
};

// ─── GET /api/orders/:orderId/payments ───────────────────────────────────────
const listOrderPayments = async (req, res) => {
  try {
    // Verify order belongs to user first
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id')
      .eq('id', req.params.orderId)
      .eq('client_id', req.user.id)
      .single();

    if (orderErr || !order) return sendError(res, 404, 'Order not found.');

    const { data, error } = await supabase
      .from('payments')
      .select('id, payment_type, gateway, status, amount_paise, currency, paid_at, created_at')
      .eq('order_id', req.params.orderId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    return sendSuccess(res, 200, { payments: data || [] });
  } catch (err) {
    log('[listOrderPayments]', err);
    return sendError(res, 500, 'Failed to fetch payments.');
  }
};

module.exports = { initiatePayment, verifyPayment, razorpayWebhook, listOrderPayments };
