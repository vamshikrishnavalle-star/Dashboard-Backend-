/**
 * ─── UPLOADS CONTROLLER ──────────────────────────────────────────────────────
 * POST   /api/uploads/presign          — generate Supabase presigned PUT URL
 * POST   /api/uploads/confirm          — register uploaded file in DB
 * GET    /api/orders/:id/files         — list files for an order
 * GET    /api/uploads/files/:id/download — signed download URL
 * DELETE /api/uploads/files/:id        — delete from storage + soft-delete in DB
 */

const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const {
  createPresignedUploadUrl,
  getSignedDownloadUrl,
  deleteStorageFile,
  validateUpload,
} = require('../utils/storage');

const isProd      = process.env.NODE_ENV === 'production';
const log         = (...a) => { if (!isProd) console.error(...a); };
const sendError   = (res, s, m) => res.status(s).json({ success: false, error: m });
const sendSuccess = (res, s, d) => res.status(s).json({ success: true, ...d });

// ─── POST /api/uploads/presign ────────────────────────────────────────────────
const presignUpload = async (req, res) => {
  const { order_id, file_name, content_type, file_size_bytes, category } = req.body;

  if (!order_id || !file_name || !content_type || !category)
    return sendError(res, 400, 'order_id, file_name, content_type, and category are required.');

  try {
    // 1. Verify order belongs to this user
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, status')
      .eq('id', order_id)
      .eq('client_id', req.user.id)
      .single();

    if (orderErr || !order) return sendError(res, 404, 'Order not found.');
    if (['completed', 'cancelled'].includes(order.status))
      return sendError(res, 400, 'Cannot upload files to a completed or cancelled order.');

    // 2. Validate MIME type and size
    try {
      validateUpload({ contentType: content_type, fileSizeBytes: file_size_bytes, category });
    } catch (e) {
      return sendError(res, e.status || 400, e.message);
    }

    // 3. Generate presigned upload URL (browser uploads directly to Supabase)
    const { signedUrl, storagePath } = await createPresignedUploadUrl({
      orderId:  order_id,
      fileName: file_name,
      category,
    });

    return sendSuccess(res, 200, {
      upload: { presigned_url: signedUrl, storage_path: storagePath },
    });
  } catch (err) {
    log('[presignUpload]', err);
    return sendError(res, 500, 'Failed to generate upload URL.');
  }
};

// ─── POST /api/uploads/confirm ────────────────────────────────────────────────
const confirmUpload = async (req, res) => {
  const { order_id, storage_path, file_name, content_type, file_size_bytes, category } = req.body;

  if (!order_id || !storage_path || !file_name || !content_type || !category)
    return sendError(res, 400, 'Missing required fields.');

  try {
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id')
      .eq('id', order_id)
      .eq('client_id', req.user.id)
      .single();

    if (orderErr || !order) return sendError(res, 404, 'Order not found.');

    const { data: file, error: insertErr } = await supabase
      .from('order_files')
      .insert([{
        id:              uuidv4(),
        order_id,
        uploaded_by:     req.user.id,
        category,
        file_name,
        s3_key:          storage_path,  // Supabase storage path
        s3_bucket:       'supabase',
        content_type,
        file_size_bytes: file_size_bytes || null,
        is_deleted:      false,
      }])
      .select()
      .single();

    if (insertErr) throw insertErr;

    return sendSuccess(res, 201, { file });
  } catch (err) {
    log('[confirmUpload]', err);
    return sendError(res, 500, 'Failed to register file.');
  }
};

// ─── GET /api/orders/:id/files ────────────────────────────────────────────────
const listOrderFiles = async (req, res) => {
  try {
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id')
      .eq('id', req.params.id)
      .eq('client_id', req.user.id)
      .single();

    if (orderErr || !order) return sendError(res, 404, 'Order not found.');

    const { data, error } = await supabase
      .from('order_files')
      .select('id, category, file_name, content_type, file_size_bytes, created_at')
      .eq('order_id', req.params.id)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return sendSuccess(res, 200, { files: data || [] });
  } catch (err) {
    log('[listOrderFiles]', err);
    return sendError(res, 500, 'Failed to fetch files.');
  }
};

// ─── GET /api/uploads/files/:id/download ─────────────────────────────────────
const getDownloadUrl = async (req, res) => {
  try {
    const { data: file, error } = await supabase
      .from('order_files')
      .select('id, s3_key, file_name, orders!inner(client_id)')
      .eq('id', req.params.id)
      .eq('is_deleted', false)
      .single();

    if (error || !file) return sendError(res, 404, 'File not found.');

    const clientId = file.orders?.client_id;
    if (clientId !== req.user.id) {
      const { data: profile } = await supabase
        .from('users').select('role').eq('id', req.user.id).single();
      if (profile?.role !== 'admin')
        return sendError(res, 403, 'Access denied.');
    }

    const signedUrl = await getSignedDownloadUrl(file.s3_key);
    return sendSuccess(res, 200, { download_url: signedUrl, file_name: file.file_name });
  } catch (err) {
    log('[getDownloadUrl]', err);
    return sendError(res, 500, 'Failed to generate download URL.');
  }
};

// ─── DELETE /api/uploads/files/:id ───────────────────────────────────────────
const deleteFile = async (req, res) => {
  try {
    const { data: file, error } = await supabase
      .from('order_files')
      .select('id, s3_key, uploaded_by, orders!inner(client_id, status)')
      .eq('id', req.params.id)
      .eq('is_deleted', false)
      .single();

    if (error || !file) return sendError(res, 404, 'File not found.');
    if (file.uploaded_by !== req.user.id) return sendError(res, 403, 'Access denied.');
    if (['completed', 'cancelled'].includes(file.orders?.status))
      return sendError(res, 400, 'Cannot delete files from a completed or cancelled order.');

    await deleteStorageFile(file.s3_key);

    await supabase
      .from('order_files')
      .update({ is_deleted: true })
      .eq('id', req.params.id);

    return sendSuccess(res, 200, { message: 'File deleted.' });
  } catch (err) {
    log('[deleteFile]', err);
    return sendError(res, 500, 'Failed to delete file.');
  }
};

module.exports = { presignUpload, confirmUpload, listOrderFiles, getDownloadUrl, deleteFile };
