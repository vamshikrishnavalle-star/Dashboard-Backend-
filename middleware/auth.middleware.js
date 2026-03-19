const jwt = require('jsonwebtoken');

/**
 * Middleware: verifyToken
 * Protects routes by validating the Bearer JWT in Authorization header.
 * Attaches decoded user payload to req.user on success.
 */
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Access denied. No token provided.',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token.',
    });
  }
};

module.exports = { verifyToken };
