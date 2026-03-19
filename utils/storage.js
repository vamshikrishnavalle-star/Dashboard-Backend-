/**
 * ─── SUPABASE STORAGE UTILITY ────────────────────────────────────────────────
 * Uses Supabase presigned upload URLs so files go DIRECTLY from the browser
 * to Supabase Storage — the Express server is never in the upload path.
 *
 * Flow:
 *   1. POST /api/uploads/presign  → backend generates signed upload URL
 *   2. Browser PUTs file directly to Supabase (fast, single hop)
 *   3. POST /api/uploads/confirm  → backend records file in DB
 */

const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');

const BUCKET = 'order-files';

// ─── Allowed MIME types per upload category ───────────────────────────────────
const ALLOWED_TYPES = {
  voice_sample:  ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/webm'],
  video_sample:  ['video/mp4', 'video/quicktime', 'video/webm', 'video/avi'],
  raw_asset:     ['image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'video/mp4', 'video/quicktime'],
  brief:         ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'],
  deliverable:   ['video/mp4', 'image/jpeg', 'image/png', 'image/webp', 'application/zip'],
  revision:      ['video/mp4', 'image/jpeg', 'image/png', 'image/webp', 'application/zip'],
};

// ─── Max file sizes ───────────────────────────────────────────────────────────
const MAX_BYTES = {
  voice_sample:  50  * 1024 * 1024,   // 50 MB
  video_sample:  500 * 1024 * 1024,   // 500 MB
  raw_asset:     500 * 1024 * 1024,   // 500 MB
  brief:         10  * 1024 * 1024,   // 10 MB
  deliverable:   500 * 1024 * 1024,   // 500 MB
  revision:      500 * 1024 * 1024,   // 500 MB
};

/**
 * Generate a presigned upload URL — browser uses this to PUT directly to Supabase.
 * Returns { signedUrl, storagePath, token }
 */
async function createPresignedUploadUrl({ orderId, fileName, category }) {
  const storagePath = `orders/${orderId}/${category}/${uuidv4()}-${sanitize(fileName)}`;

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error) throw error;

  return { signedUrl: data.signedUrl, storagePath, token: data.token };
}

/**
 * Generate a signed download URL valid for 1 hour.
 */
async function getSignedDownloadUrl(storagePath) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, 3600);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * Delete a file from Supabase Storage.
 */
async function deleteStorageFile(storagePath) {
  await supabase.storage.from(BUCKET).remove([storagePath]);
}

/**
 * Validate content type and file size before issuing a presigned URL.
 * Throws a 400 error with a descriptive message on failure.
 */
function validateUpload({ contentType, fileSizeBytes, category }) {
  const allowed = ALLOWED_TYPES[category];
  if (!allowed)
    throw Object.assign(new Error(`Unknown file category: ${category}`), { status: 400 });

  if (!allowed.includes(contentType))
    throw Object.assign(
      new Error(`File type "${contentType}" is not allowed for ${category}. Allowed: ${allowed.join(', ')}`),
      { status: 400 },
    );

  const maxBytes = MAX_BYTES[category];
  if (fileSizeBytes && fileSizeBytes > maxBytes) {
    const maxMB = (maxBytes / 1024 / 1024).toFixed(0);
    throw Object.assign(
      new Error(`File too large. Maximum allowed for ${category} is ${maxMB} MB.`),
      { status: 400 },
    );
  }
}

/** Strip unsafe characters from file names */
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

module.exports = {
  createPresignedUploadUrl,
  getSignedDownloadUrl,
  deleteStorageFile,
  validateUpload,
  ALLOWED_TYPES,
  MAX_BYTES,
};
