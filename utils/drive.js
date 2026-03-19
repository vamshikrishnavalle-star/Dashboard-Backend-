/**
 * ─── GOOGLE DRIVE UTILITY ────────────────────────────────────────────────────
 * Uploads files from the Express server to Google Drive using a Service Account.
 * Files are organised: root-folder / orderId / category / uuid-filename
 */

const { google } = require('googleapis');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');

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
  voice_sample:  50  * 1024 * 1024,
  video_sample:  500 * 1024 * 1024,
  raw_asset:     500 * 1024 * 1024,
  brief:         10  * 1024 * 1024,
  deliverable:   1024 * 1024 * 1024,
  revision:      1024 * 1024 * 1024,
};

/** Build an authenticated Drive v3 client using the Service Account key file */
function getDrive() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes:  ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

/**
 * Find or create a subfolder inside parentId.
 * Returns the folder ID.
 */
async function getOrCreateFolder(drive, parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const { data } = await drive.files.list({ q, fields: 'files(id)', spaces: 'drive' });
  if (data.files.length > 0) return data.files[0].id;

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents:  [parentId],
    },
    fields: 'id',
  });
  return folder.data.id;
}

/**
 * Upload a file (from disk path) to Drive.
 * Folder structure: GOOGLE_DRIVE_FOLDER_ID / orderId / category / uuid-filename
 * Returns { driveFileId }
 */
async function uploadFile({ orderId, fileName, contentType, category, filePath }) {
  const drive  = getDrive();
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const orderFolderId    = await getOrCreateFolder(drive, rootId, String(orderId));
  const categoryFolderId = await getOrCreateFolder(drive, orderFolderId, category);

  const uniqueName = `${uuidv4()}-${sanitize(fileName)}`;

  const { data } = await drive.files.create({
    requestBody: { name: uniqueName, parents: [categoryFolderId] },
    media:       { mimeType: contentType, body: fs.createReadStream(filePath) },
    fields:      'id',
  });

  return { driveFileId: data.id };
}

/**
 * Stream a Drive file directly to an Express response.
 * Sets Content-Type, Content-Disposition, and Content-Length headers.
 */
async function streamFile(driveFileId, res) {
  const drive = getDrive();

  const { data: meta } = await drive.files.get({
    fileId: driveFileId,
    fields: 'name,mimeType,size',
  });

  res.setHeader('Content-Type',        meta.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${meta.name}"`);
  if (meta.size) res.setHeader('Content-Length', meta.size);

  const { data: stream } = await drive.files.get(
    { fileId: driveFileId, alt: 'media' },
    { responseType: 'stream' },
  );

  stream.pipe(res);
}

/**
 * Validate content type and file size.
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

module.exports = { uploadFile, streamFile, validateUpload, ALLOWED_TYPES, MAX_BYTES };
