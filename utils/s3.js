/**
 * ─── AWS S3 UTILITY ──────────────────────────────────────────────────────────
 * Generates presigned PUT and GET URLs so files go directly to S3,
 * never through the Express server. This keeps upload sizes unbounded.
 */

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET;

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
  deliverable:   1024 * 1024 * 1024,  // 1 GB
  revision:      1024 * 1024 * 1024,  // 1 GB
};

/**
 * Generate a presigned PUT URL — client uses this to upload directly to S3.
 * Returns { presignedUrl, s3Key, bucket, expiresIn }
 */
async function presignPut({ orderId, fileName, contentType, category }) {
  const s3Key = `orders/${orderId}/${category}/${uuidv4()}-${sanitize(fileName)}`;

  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         s3Key,
    ContentType: contentType,
  });

  const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 min

  return { presignedUrl, s3Key, bucket: BUCKET, expiresIn: 900 };
}

/**
 * Generate a presigned GET URL — client uses this to download a file.
 * Returns a signed URL string valid for 1 hour.
 */
async function presignGet(s3Key) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: s3Key });
  return getSignedUrl(s3, command, { expiresIn: 3600 }); // 1 hour
}

/**
 * Validate content type and file size before issuing a presigned URL.
 * Throws a 400 error with a descriptive message on failure.
 */
function validateUpload({ contentType, fileSizeBytes, category }) {
  const allowed = ALLOWED_TYPES[category];
  if (!allowed) throw Object.assign(new Error(`Unknown file category: ${category}`), { status: 400 });

  if (!allowed.includes(contentType)) {
    throw Object.assign(
      new Error(`File type "${contentType}" is not allowed for ${category}. Allowed: ${allowed.join(', ')}`),
      { status: 400 }
    );
  }

  const maxBytes = MAX_BYTES[category];
  if (fileSizeBytes && fileSizeBytes > maxBytes) {
    const maxMB = (maxBytes / 1024 / 1024).toFixed(0);
    throw Object.assign(
      new Error(`File too large. Maximum allowed for ${category} is ${maxMB} MB.`),
      { status: 400 }
    );
  }
}

/** Strip unsafe characters from file names */
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

module.exports = { presignPut, presignGet, validateUpload, ALLOWED_TYPES, MAX_BYTES };
