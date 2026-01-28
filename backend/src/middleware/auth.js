// backend/src/middleware/auth.js
// JWT auth middleware used by protected routes (Admin/Manager gates)

const { verify } = require('../auth/jwt');

function authRequired(req, res, next) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;

  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    req.user = verify(token, process.env.JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// normalize role to comparable string
function normRole(r) {
  return String(r || '').trim().toLowerCase();
}

/**
 * requireRole('Admin','Manager')
 * requireRole(['Admin','Manager'])
 * requireRole('Manager', { adminAlso: true })  // ✅ Admin can access Manager routes
 */
function requireRole(...args) {
  // Optional options object as last argument
  let opts = {};
  if (args.length && typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1])) {
    opts = args.pop() || {};
  }

  // Flatten roles
  const rawRoles = args.flat().filter(Boolean);
  const allow = new Set(rawRoles.map(normRole));

  const adminAlso = !!opts.adminAlso; // if true, Admin role always passes
  const adminRole = normRole(opts.adminRole || 'Admin');

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing auth' });

    const userRole = normRole(req.user.role);

    // ✅ Admin override option
    if (adminAlso && userRole === adminRole) return next();

    if (!allow.has(userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        role: req.user.role,
        allowed: Array.from(allow),
      });
    }

    return next();
  };
}

module.exports = { authRequired, requireRole };
