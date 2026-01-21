// backend/src/middleware/auth.js
// JWT auth middleware used by protected routes (Admin/Manager gates)

const { verify } = require('../auth/jwt');

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    req.user = verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing auth' });

    // role in token must match one of the allowed roles
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
}

module.exports = { authRequired, requireRole };
