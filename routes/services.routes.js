const express = require('express');
const router  = express.Router();
const { listServices, getService } = require('../controllers/services.controller');
const { verifyToken } = require('../middleware/auth.middleware');

router.get('/',    verifyToken, listServices);
router.get('/:id', verifyToken, getService);

module.exports = router;
