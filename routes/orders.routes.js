const express = require('express');
const { body } = require('express-validator');
const router  = express.Router();
const { createOrder, listOrders, getOrder, cancelOrder } = require('../controllers/orders.controller');
const { listOrderPayments } = require('../controllers/payments.controller');
const { listOrderFiles } = require('../controllers/uploads.controller');
const { initiatePayment } = require('../controllers/payments.controller');
const { downloadInvoice } = require('../controllers/invoice.controller');
const { verifyToken } = require('../middleware/auth.middleware');

const createOrderValidation = [
  body('service_id').notEmpty().withMessage('service_id is required.').isUUID().withMessage('Invalid service_id.'),
  body('brief').optional().isObject().withMessage('brief must be an object.'),
  body('discount_inr').optional().isNumeric().withMessage('discount_inr must be a number.'),
];

// Order CRUD
router.get('/',    verifyToken, listOrders);
router.post('/',   verifyToken, createOrderValidation, createOrder);
router.get('/:id', verifyToken, getOrder);
router.delete('/:id', verifyToken, cancelOrder);

// Nested resources
router.get('/:orderId/payments',      verifyToken, listOrderPayments);
router.post('/:orderId/payments',     verifyToken, initiatePayment);
router.get('/:id/files',              verifyToken, listOrderFiles);
router.get('/:orderId/invoice',       verifyToken, downloadInvoice);

module.exports = router;
