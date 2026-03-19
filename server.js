const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const authRoutes     = require('./routes/auth.routes');
const servicesRoutes = require('./routes/services.routes');
const ordersRoutes   = require('./routes/orders.routes');
const paymentsRoutes = require('./routes/payments.routes');
const uploadsRoutes  = require('./routes/uploads.routes');
const adminRoutes    = require('./routes/admin.routes');

const app = express();

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',').map((o) => o.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`Origin ${origin} not allowed.`));
  },
  credentials: true,
}));

// ─── Razorpay webhook — must receive raw body BEFORE express.json() ───────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

// ─── Body parser ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));

// ─── Simple in-memory rate limiter ────────────────────────────────────────────
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key   = req.ip;
    const now   = Date.now();
    const entry = hits.get(key) || { n: 0, start: now };
    if (now - entry.start > windowMs) { entry.n = 1; entry.start = now; }
    else entry.n++;
    hits.set(key, entry);
    if (entry.n > max)
      return res.status(429).json({ success: false, error: 'Too many requests. Try again later.' });
    next();
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ success: true, service: 'AI Agentic Verse API', status: 'running' })
);

app.use('/api/auth',     rateLimit(10, 60_000),  authRoutes);
app.use('/api/services', rateLimit(60, 60_000),  servicesRoutes);
app.use('/api/orders',   rateLimit(30, 60_000),  ordersRoutes);
app.use('/api/payments', rateLimit(20, 60_000),  paymentsRoutes);
app.use('/api/uploads',  rateLimit(20, 60_000),  uploadsRoutes);
app.use('/api/admin',    rateLimit(60, 60_000),  adminRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ success: false, error: `${req.method} ${req.path} not found.` })
);

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);
  res.status(err.status || 500).json({ success: false, error: 'Internal server error.' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);
app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'production')
    console.log(`✓ API → http://localhost:${PORT}`);
});
