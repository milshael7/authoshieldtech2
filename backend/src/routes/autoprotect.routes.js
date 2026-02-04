// backend/src/routes/autoprotect.routes.js
// AutoProtect Routes — FINAL LOCKED VERSION
//
// RULES ENFORCED:
// ✅ AutoProtect = INDIVIDUAL USERS ONLY
// ❌ Companies CANNOT enable AutoProtect
// ❌ Managers/Admins CANNOT modify AutoProtect (mirror view only)
// ✅ No room leakage
// ✅ Admin sees GLOBAL status (read-only)
// ✅ Creates guided security projects (no silent actions)
//
// THIS FILE IS COMPLETE. DO NOT PATCH LATER.

const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/auth');
const users = require('../users/user.service');
const { readDb, writeDb } = require('../lib/db');
const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');
const { createProject } = require('../services/autoprotect.project');

// -------------------- helpers --------------------

function nowISO() {
  return new Date().toISOString();
}

function roleOf(u) {
  return String(u?.role || '');
}

function isAdmin(u) {
  return roleOf(u) === users.ROLES.ADMIN;
}
function isManager(u) {
  return roleOf(u) === users.ROLES.MANAGER;
}
function isCompany(u) {
  return roleOf(u) === users.ROLES.COMPANY;
}
function isIndividual(u) {
  return roleOf(u) === users.ROLES.INDIVIDUAL;
}

// 🚨 HARD RULE: ONLY INDIVIDUAL USERS
function assertIndividualOnly(user) {
  if (!isIndividual(user)) {
    return {
      allowed: false,
      reason: 'AutoProtect is available to Individual users only.',
    };
  }
  return { allowed: true };
}

// -------------------- middleware --------------------
router.use(authRequired);

// -------------------- ROUTES --------------------

/**
 * GET /api/autoprotect/status
 * - Individual: sees own status
 * - Admin/Manager: GLOBAL MIRROR (read-only)
 */
router.get('/status', (req, res) => {
  const db = readDb();
  const user = req.user;

  // ADMIN / MANAGER = GLOBAL READ-ONLY
  if (isAdmin(user) || isManager(user)) {
    const individuals = (db.users || []).filter(u => u.role === users.ROLES.INDIVIDUAL);

    return res.json({
      scope: 'global',
      totals: {
        individuals: individuals.length,
        enabled: individuals.filter(u => u.autoprotectEnabled).length,
        disabled: individuals.filter(u => !u.autoprotectEnabled).length,
      },
      time: nowISO(),
      readOnly: true,
    });
  }

  // COMPANY = NOT ALLOWED
  if (isCompany(user)) {
    return res.status(403).json({
      ok: false,
      error: 'Companies cannot use AutoProtect.',
    });
  }

  // INDIVIDUAL
  return res.json({
    scope: 'user',
    enabled: !!user.autoprotectEnabled,
    message: user.autoprotectEnabled
      ? 'AutoProtect is active.'
      : 'AutoProtect is disabled.',
    time: nowISO(),
  });
});

/**
 * POST /api/autoprotect/enable
 * Individual ONLY
 */
router.post('/enable', (req, res) => {
  const user = req.user;

  const gate = assertIndividualOnly(user);
  if (!gate.allowed) {
    return res.status(403).json({ ok: false, error: gate.reason });
  }

  const db = readDb();
  const u = db.users.find(x => x.id === user.id);
  if (!u) return res.status(404).json({ ok: false, error: 'User not found.' });

  u.autoprotectEnabled = true;
  writeDb(db);

  audit({
    actorId: user.id,
    action: 'AUTOPROTECT_ENABLED',
    targetType: 'User',
    targetId: user.id,
  });

  createNotification({
    userId: user.id,
    severity: 'info',
    title: 'AutoProtect Enabled',
    message: 'AutoProtect is now actively monitoring your account.',
  });

  return res.json({
    ok: true,
    enabled: true,
    time: nowISO(),
  });
});

/**
 * POST /api/autoprotect/disable
 * Individual ONLY
 */
router.post('/disable', (req, res) => {
  const user = req.user;

  const gate = assertIndividualOnly(user);
  if (!gate.allowed) {
    return res.status(403).json({ ok: false, error: gate.reason });
  }

  const db = readDb();
  const u = db.users.find(x => x.id === user.id);
  if (!u) return res.status(404).json({ ok: false, error: 'User not found.' });

  u.autoprotectEnabled = false;
  writeDb(db);

  audit({
    actorId: user.id,
    action: 'AUTOPROTECT_DISABLED',
    targetType: 'User',
    targetId: user.id,
  });

  return res.json({
    ok: true,
    enabled: false,
    time: nowISO(),
  });
});

/**
 * POST /api/autoprotect/project
 * Creates a guided security project (NO silent fixes)
 * Individual ONLY
 */
router.post('/project', (req, res) => {
  const user = req.user;

  const gate = assertIndividualOnly(user);
  if (!gate.allowed) {
    return res.status(403).json({ ok: false, error: gate.reason });
  }

  if (!user.autoprotectEnabled) {
    return res.status(400).json({
      ok: false,
      error: 'Enable AutoProtect before creating projects.',
    });
  }

  const { title, issue } = req.body || {};
  if (!title || !issue) {
    return res.status(400).json({ ok: false, error: 'Missing title or issue.' });
  }

  const project = createProject({
    actorId: user.id,
    title,
    issue,
  });

  return res.status(201).json({
    ok: true,
    project,
    time: nowISO(),
  });
});

module.exports = router;
