const express = require('express');
const router  = express.Router();

const { presignUpload, confirmUpload, getDownloadUrl, deleteFile } = require('../controllers/uploads.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Generate Supabase presigned PUT URL (browser uploads directly to Supabase)
router.post('/presign',  verifyToken, presignUpload);

// Register uploaded file in DB (call after browser PUT completes)
router.post('/confirm',  verifyToken, confirmUpload);

// Get signed download URL for a file
router.get('/files/:id/download', verifyToken, getDownloadUrl);

// Delete file from storage + soft-delete in DB
router.delete('/files/:id', verifyToken, deleteFile);

module.exports = router;
