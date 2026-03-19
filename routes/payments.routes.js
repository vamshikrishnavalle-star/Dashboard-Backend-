const express = require('express');
const router  = express.Router();
const { verifyPayment, razorpayWebhook } = require('../controllers/payments.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// Verify payment after Razorpay checkout
router.post('/verify', verifyToken, verifyPayment);

// Razorpay webhook — raw body, no auth (signature-verified internally)
router.post('/webhook/razorpay', razorpayWebhook);

module.exports = router;
