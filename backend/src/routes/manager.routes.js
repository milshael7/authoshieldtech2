// backend/src/routes/manager.routes.js
// Manager Room API (read-only)
// ✅ Admin can see everything Manager sees (same endpoints, same data)
// ✅ Adds safe limits + basic filtering + consistent error handling

const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const { readDb } = require('../lib/db');

const users = require('../users/user.service');
const companies = require('../companies/company.service');
const { listNotifications } = require('../lib/notify');

router.use(authRequired);

// ✅ allow Manager; Admin always allowed too (override)
router.use(requireRole(users.ROLES.MANAGER, { adminAlso: true }));

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function safeStr(v, maxLen = 120) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

// Overview counts for manager room
router.get('/overview', (req, res) => {
  try {
    const db = readDb();
    return res.json({
      users: db.users?.length || 0,
      companies: db.companies?.length || 0,
      auditEvents: db.audit?.length || 0,
      notifications: db.notifications?.length || 0,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Read-only lists
router.get('/users', (req, res) => {
  try {
    return res.json(users.listUsers());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

router.get('/companies', (req, res) => {
  try {
    return res.json(companies.listCompanies());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Notifications (read-only)
// Supports optional ?limit= (default 200, max 1000)
router.get('/notifications', (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 1000, 200);

    const all = listNotifications({}) || [];
    return res.json(all.slice(-limit).reverse());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Audit log (read-only)
// Supports:
//   ?limit=200 (max 1000)
//   ?actorId=...  (filter)
//   ?action=...   (partial match)
router.get('/audit', (req, res) => {
  try {
    const db = readDb();
    const limit = clampInt(req.query.limit, 1, 1000, 200);

    const actorId = safeStr(req.query.actorId);
    const actionQ = safeStr(req.query.action).toLowerCase();

    // ✅ filter first, then limit newest-first
    let items = (db.audit || []).slice().reverse();

    if (actorId) items = items.filter(ev => String(ev.actorId || '') === actorId);
    if (actionQ) items = items.filter(ev => String(ev.action || '').toLowerCase().includes(actionQ));

    return res.json(items.slice(0, limit));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
