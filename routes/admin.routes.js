const express = require('express');
const router  = express.Router();
const {
  listAllOrders, updateOrderStatus, uploadDeliverable, assignOrder, getOrderAdmin,
} = require('../controllers/admin.controller');
const { verifyToken }  = require('../middleware/auth.middleware');
const { verifyAdmin }  = require('../middleware/admin.middleware');

// All admin routes require both token and admin role
const guard = [verifyToken, verifyAdmin];

router.get('/orders',              ...guard, listAllOrders);
router.get('/orders/:id',          ...guard, getOrderAdmin);
router.patch('/orders/:id/status', ...guard, updateOrderStatus);
router.post('/orders/:id/deliverable', ...guard, uploadDeliverable);
router.patch('/orders/:id/assign', ...guard, assignOrder);

module.exports = router;
