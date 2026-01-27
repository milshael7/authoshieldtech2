// backend/src/routes/posture.routes.js
// Cybersecurity posture endpoints for rooms.
// Requires auth middleware to attach req.user.

const express = require('express');
const router = express.Router();

// If you don't have this service yet, tell me and I'll generate it clean.
// For now, this file assumes it exists.
const posture = require('../services/posture.service');

// Tiny guard so the route doesn't crash if auth isn't attaching req.user yet
function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ ok: false, error: 'Unauthorized (missing user). Login first.' });
    return false;
  }
  return true;
}

// GET /api/posture/me  -> individual posture snapshot
router.get('/me', async (req, res) => {
  try {
    if (!requireUser(req, res)) return;
    const data = await posture.getMyPosture({ user: req.user });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/company  -> company posture snapshot (Company/Admin/Manager)
router.get('/company', async (req, res) => {
  try {
    if (!requireUser(req, res)) return;

    const role = req.user?.role;
    if (!['Company', 'Admin', 'Manager'].includes(role)) {
      return res.status(403).json({ ok: false, error: 'Forbidden (requires Company/Admin/Manager).' });
    }

    const data = await posture.getCompanyPosture({ user: req.user });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/manager  -> manager/global posture (Manager/Admin)
router.get('/manager', async (req, res) => {
  try {
    if (!requireUser(req, res)) return;

    const role = req.user?.role;
    if (!['Manager', 'Admin'].includes(role)) {
      return res.status(403).json({ ok: false, error: 'Forbidden (requires Manager/Admin).' });
    }

    const data = await posture.getManagerPosture({ user: req.user });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
