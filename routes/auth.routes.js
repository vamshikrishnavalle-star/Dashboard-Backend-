const express = require('express');
const { body } = require('express-validator');

const router = express.Router();
const { signup, login, getMe, logout } = require('../controllers/auth.controller');
const { verifyToken } = require('../middleware/auth.middleware');

// ─── Validation Rules ─────────────────────────────────────────────────────────

const signupValidation = [
  body('full_name').trim().notEmpty().withMessage('Full name is required.'),
  body('whatsapp_number')
    .trim()
    .notEmpty().withMessage('WhatsApp number is required.')
    .matches(/^\+?[0-9]{7,15}$/).withMessage('Enter a valid WhatsApp number (e.g. +1234567890).'),
  body('organization_name').trim().notEmpty().withMessage('Organization name is required.'),
  body('email').isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter.')
    .matches(/[0-9]/).withMessage('Password must contain at least one number.'),
];

const loginValidation = [
  body('email').isEmail().withMessage('Enter a valid email address.').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required.'),
];

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/auth/signup  — Create new account
router.post('/signup', signupValidation, signup);

// POST /api/auth/login   — Authenticate and receive token
router.post('/login', loginValidation, login);

// POST /api/auth/logout  — Invalidate session (protected)
router.post('/logout', verifyToken, logout);

// GET  /api/auth/me      — Get current user profile (protected)
router.get('/me', verifyToken, getMe);

module.exports = router;
