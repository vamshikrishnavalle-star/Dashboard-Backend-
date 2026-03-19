/**
 * ─── ADMIN CONTROLLER ────────────────────────────────────────────────────────
 * GET   /api/admin/orders           — list all orders with filters
 * PATCH /api/admin/orders/:id/status — update order status
 * POST  /api/admin/orders/:id/deliverable — upload final deliverable file
 * PATCH /api/admin/orders/:id/assign    — assign order to team member
 */

const supabase = require('../config/supabase');
const { assertTransition, STATUS_LABELS } = require('../utils/orderStatus');
const { presignPut, validateUpload } = require('../utils/s3');
const { v4: uuidv4 } = require('uuid');

const isProd    = process.env.NODE_ENV === 'production';
const log       = (...a) => { if (!isProd) console.error(...a); };
const sendError = (res, s, m) => res.status(s).json({ success: false, error: m });
const sendSuccess = (res, s, d) => res.status(s).json({ success: true, ...d });

// ─── GET /api/admin/orders ───────────────────────────────────────────────────
const listAllOrders = async (req, res) => {
  try {
    const { status, service_type, page = '1', limit = '20' } = req.query;
    const pageNum  = Math.max(parseInt(page) || 1, 1);
    const limitNum = Math.min(parseInt(limit) || 20, 100);
    const from     = (pageNum - 1) * limitNum;
    const to       = from + limitNum - 1;

    let query = supabase
      .from('orders')
      .select(`
        id, order_number, service_type, status, final_price_inr,
        advance_amount, balance_amount, currency, brief,
        expected_delivery_at, delivered_at, created_at, admin_notes,
        services ( display_name ),
        users!orders_client_id_fkey ( full_name, email, organization_name, whatsapp_number )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (status)       query = query.eq('status', status);
    if (service_type) query = query.eq('service_type', service_type);

    const { data, error, count } = await query;
    if (error) throw error;

    const orders = (data || []).map((o) => ({
      ...o,
      service_name:  o.services?.display_name,
      client:        o.users,
      services:      undefined,
      users:         undefined,
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
    log('[listAllOrders]', err);
    return sendError(res, 500, 'Failed to fetch orders.');
  }
};

// ─── PATCH /api/admin/orders/:id/status ──────────────────────────────────────
const updateOrderStatus = async (req, res) => {
  const { status, note } = req.body;
  if (!status) return sendError(res, 400, 'status is required.');

  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, order_number, status, client_id')
      .eq('id', req.params.id)
      .single();

    if (error || !order) return sendError(res, 404, 'Order not found.');

    try {
      assertTransition(order.status, status);
    } catch (e) {
      return sendError(res, e.status || 400, e.message);
    }

    const updateData = { status };
    if (status === 'completed') updateData.delivered_at = new Date().toISOString();
    if (note) updateData.admin_notes = note;

    await supabase.from('orders').update(updateData).eq('id', order.id);
    await supabase.from('order_status_history').insert([{
      order_id:    order.id,
      from_status: order.status,
      to_status:   status,
      changed_by:  req.user.id,
      note:        note || `Status updated to ${STATUS_LABELS[status]}.`,
    }]);

    // Notify client
    await supabase.from('notifications').insert([{
      user_id:  order.client_id,
      order_id: order.id,
      title:    `Order Update — ${order.order_number}`,
      body:     note || `Your order status has been updated to: ${STATUS_LABELS[status]}.`,
    }]);

    return sendSuccess(res, 200, { order: { id: order.id, status } });
  } catch (err) {
    log('[updateOrderStatus]', err);
    return sendError(res, 500, 'Failed to update order status.');
  }
};

// ─── POST /api/admin/orders/:id/deliverable ──────────────────────────────────
const uploadDeliverable = async (req, res) => {
  const { file_name, content_type, file_size_bytes } = req.body;

  if (!file_name || !content_type) return sendError(res, 400, 'file_name and content_type are required.');

  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, status, client_id, order_number')
      .eq('id', req.params.id)
      .single();

    if (error || !order) return sendError(res, 404, 'Order not found.');
    if (!['confirmed', 'in_progress', 'revision_requested'].includes(order.status))
      return sendError(res, 400, `Cannot upload deliverable for order in status: ${STATUS_LABELS[order.status]}`);

    try {
      validateUpload({ contentType: content_type, fileSizeBytes: file_size_bytes, category: 'deliverable' });
    } catch (e) {
      return sendError(res, e.status || 400, e.message);
    }

    const { presignedUrl, s3Key } = await presignPut({
      orderId:     order.id,
      fileName:    file_name,
      contentType: content_type,
      category:    'deliverable',
    });

    // Pre-register the file (client will confirm after actual upload)
    const { data: file } = await supabase
      .from('order_files')
      .insert([{
        id:              uuidv4(),
        order_id:        order.id,
        uploaded_by:     req.user.id,
        category:        'deliverable',
        file_name,
        s3_key:          s3Key,
        s3_bucket:       process.env.AWS_S3_BUCKET,
        content_type,
        file_size_bytes: file_size_bytes || null,
      }])
      .select()
      .single();

    // Move order to "review" for client approval
    const currentStatus = order.status;
    if (['confirmed', 'in_progress', 'revision_requested'].includes(currentStatus)) {
      const newStatus = 'review';
      try { assertTransition(currentStatus, newStatus); } catch { /* already in review */ }
      await supabase.from('orders').update({ status: newStatus }).eq('id', order.id);
      await supabase.from('order_status_history').insert([{
        order_id: order.id, from_status: currentStatus, to_status: newStatus,
        changed_by: req.user.id, note: 'Deliverable uploaded — awaiting client review.',
      }]);
      await supabase.from('notifications').insert([{
        user_id:  order.client_id,
        order_id: order.id,
        title:    `Deliverable Ready — ${order.order_number}`,
        body:     'Your project is ready for review. Please check and approve.',
      }]);
    }

    return sendSuccess(res, 201, {
      upload:   { presigned_url: presignedUrl, s3_key: s3Key },
      file:     file,
      message:  'Upload URL generated. Upload the file and it will be available for client download.',
    });
  } catch (err) {
    log('[uploadDeliverable]', err);
    return sendError(res, 500, 'Failed to generate deliverable upload URL.');
  }
};

// ─── PATCH /api/admin/orders/:id/assign ──────────────────────────────────────
const assignOrder = async (req, res) => {
  const { assigned_to } = req.body;
  try {
    const { data: order, error } = await supabase
      .from('orders').select('id').eq('id', req.params.id).single();
    if (error || !order) return sendError(res, 404, 'Order not found.');

    await supabase.from('orders').update({ assigned_to: assigned_to || null }).eq('id', order.id);
    return sendSuccess(res, 200, { message: 'Order assigned.' });
  } catch (err) {
    log('[assignOrder]', err);
    return sendError(res, 500, 'Failed to assign order.');
  }
};

// ─── GET /api/admin/orders/:id ───────────────────────────────────────────────
const getOrderAdmin = async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        *,
        services ( display_name, description ),
        users!orders_client_id_fkey ( full_name, email, organization_name, whatsapp_number )
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !order) return sendError(res, 404, 'Order not found.');

    const [paymentsRes, filesRes, historyRes] = await Promise.all([
      supabase.from('payments').select('*').eq('order_id', order.id).order('created_at'),
      supabase.from('order_files').select('*').eq('order_id', order.id).eq('is_deleted', false),
      supabase.from('order_status_history').select('*').eq('order_id', order.id).order('created_at'),
    ]);

    return sendSuccess(res, 200, {
      order: {
        ...order,
        client:         order.users,
        service_name:   order.services?.display_name,
        users:          undefined,
        payments:       paymentsRes.data || [],
        files:          filesRes.data    || [],
        status_history: historyRes.data  || [],
      },
    });
  } catch (err) {
    log('[getOrderAdmin]', err);
    return sendError(res, 500, 'Failed to fetch order.');
  }
};

module.exports = { listAllOrders, updateOrderStatus, uploadDeliverable, assignOrder, getOrderAdmin };
