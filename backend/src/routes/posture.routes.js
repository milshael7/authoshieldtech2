// backend/src/routes/posture.routes.js
// Cybersecurity "Posture" (MVP) — summary + checks + recent events
// ✅ Manager + Admin can view everything
// ✅ Company + Individual can view only their own scope (safe defaults)

const express = require('express');
const router = express.Router();

const { authRequired, requireRole } = require('../middleware/auth');
const { readDb } = require('../lib/db');
const users = require('../users/user.service');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function nowISO() {
  return new Date().toISOString();
}

// Simple “checks” starter list (you can expand later)
function buildChecks({ user }) {
  // MVP logic: you can later wire these to real signals (failed logins, rate limit hits, etc.)
  return [
    {
      id: 'mfa',
      title: 'MFA Recommended',
      status: 'warn',
      message: 'Enable MFA for better account protection (MVP: informational).',
      at: nowISO(),
    },
    {
      id: 'password',
      title: 'Password Hygiene',
      status: 'ok',
      message: 'Password policy enforced by platform (MVP).',
      at: nowISO(),
    },
    {
      id: 'autoprotect',
      title: 'AutoProtect Status',
      status: user?.autoprotectEnabled ? 'ok' : 'warn',
      message: user?.autoprotectEnabled
        ? 'AutoProtect is enabled for this account.'
        : 'AutoProtect is disabled for this account.',
      at: nowISO(),
    },
  ];
}

function getUserCompanyId(u) {
  return u?.companyId || null;
}

// 🔒 Scope helper: what data can this requester see?
function scopeFor(reqUser) {
  const role = reqUser?.role;
  if (role === users.ROLES.ADMIN || role === users.ROLES.MANAGER) {
    return { type: 'global' };
  }
  if (role === users.ROLES.COMPANY) {
    return { type: 'company', companyId: getUserCompanyId(reqUser) || reqUser?.companyId || reqUser?.id };
  }
  return { type: 'user', userId: reqUser?.id };
}

// GET /api/posture/summary
router.get('/summary', authRequired, (req, res) => {
  try {
    const db = readDb();
    const scope = scopeFor(req.user);

    const audit = db.audit || [];
    const notifications = db.notifications || [];
    const allUsers = db.users || [];
    const allCompanies = db.companies || [];

    // Global summary (Admin/Manager)
    if (scope.type === 'global') {
      return res.json({
        scope,
        totals: {
          users: allUsers.length,
          companies: allCompanies.length,
          auditEvents: audit.length,
          notifications: notifications.length,
        },
        time: nowISO(),
      });
    }

    // Company summary
    if (scope.type === 'company') {
      const companyId = scope.companyId;
      const companyUsers = allUsers.filter(u => String(u.companyId || '') === String(companyId));
      const companyAudit = audit.filter(ev => String(ev.companyId || '') === String(companyId));
      const companyNotes = notifications.filter(n => String(n.companyId || '') === String(companyId));

      return res.json({
        scope,
        totals: {
          users: companyUsers.length,
          auditEvents: companyAudit.length,
          notifications: companyNotes.length,
        },
        time: nowISO(),
      });
    }

    // Individual summary
    const userId = scope.userId;
    const myAudit = audit.filter(ev => String(ev.actorId || '') === String(userId) || String(ev.targetId || '') === String(userId));
    const myNotes = notifications.filter(n => String(n.userId || '') === String(userId));

    return res.json({
      scope,
      totals: {
        auditEvents: myAudit.length,
        notifications: myNotes.length,
      },
      time: nowISO(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/checks
router.get('/checks', authRequired, (req, res) => {
  try {
    return res.json({
      scope: scopeFor(req.user),
      checks: buildChecks({ user: req.user }),
      time: nowISO(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/posture/recent
// Optional: ?limit=50 (max 200)
router.get('/recent', authRequired, (req, res) => {
  try {
    const db = readDb();
    const scope = scopeFor(req.user);
    const limit = clampInt(req.query.limit, 1, 200, 50);

    const audit = (db.audit || []).slice().reverse(); // newest first
    const notifications = (db.notifications || []).slice().reverse();

    // Admin/Manager see everything
    if (scope.type === 'global') {
      return res.json({
        scope,
        audit: audit.slice(0, limit),
        notifications: notifications.slice(0, limit),
        time: nowISO(),
      });
    }

    // Company
    if (scope.type === 'company') {
      const companyId = scope.companyId;
      const a = audit.filter(ev => String(ev.companyId || '') === String(companyId)).slice(0, limit);
      const n = notifications.filter(x => String(x.companyId || '') === String(companyId)).slice(0, limit);
      return res.json({ scope, audit: a, notifications: n, time: nowISO() });
    }

    // User
    const userId = scope.userId;
    const a = audit
      .filter(ev => String(ev.actorId || '') === String(userId) || String(ev.targetId || '') === String(userId))
      .slice(0, limit);

    const n = notifications
      .filter(x => String(x.userId || '') === String(userId))
      .slice(0, limit);

    return res.json({ scope, audit: a, notifications: n, time: nowISO() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
