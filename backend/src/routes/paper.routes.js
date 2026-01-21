// backend/src/routes/paper.routes.js
// Paper routes: status + reset
// NOTE: auth is optional here (won't crash if you haven't wired middleware yet)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// Optional auth (won't break if file doesn't exist yet)
let authRequired = null;
let requireRole = null;
try {
  // If you have this file, it will lock reset to Admin/Manager
  const auth = require('../middleware/auth');
  authRequired = auth.authRequired;
  requireRole = auth.requireRole;
} catch {
  // No auth middleware found — routes still work (status + reset)
}

// GET /api/paper/status  (same data as before, now grouped under /api/paper)
router.get('/status', (req, res) => {
  res.json(paperTrader.snapshot());
});

// POST /api/paper/reset
// If auth middleware exists => Admin/Manager only
// If not => still works (paper only; no real funds)
router.post(
  '/reset',
  ...(authRequired && requireRole ? [authRequired, requireRole('Admin', 'Manager')] : []),
  (req, res) => {
    try {
      paperTrader.hardReset();
      res.json({ ok: true, message: 'Paper trader reset complete.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  }
);

module.exports = router;
