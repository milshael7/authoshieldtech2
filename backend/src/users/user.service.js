// backend/src/users/user.service.js
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { readDb, writeDb } = require('../lib/db');
const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

const ROLES = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  COMPANY: 'Company',
  INDIVIDUAL: 'Individual',
};

const SUBSCRIPTION = {
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'PastDue',
  LOCKED: 'Locked',
};

function ensureArrays(db) {
  if (!db.users) db.users = [];
  if (!Array.isArray(db.users)) db.users = [];
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sanitize(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

// ✅ single source of truth: autoprotechEnabled is what db currently stores
function getAutoprotect(u) {
  return !!(u?.autoprotectEnabled || u?.autoprotechEnabled);
}
function setAutoprotect(u, enabled) {
  // keep backward-compat fields in sync
  u.autoprotectEnabled = !!enabled;
  u.autoprotechEnabled = !!enabled;
  u.autoprotechEnabled = !!enabled; // supports existing typo
  u.autoprotechEnabled = !!enabled; // safe no-op if not used
  u.autoprotechEnabled = !!enabled;
  u.autoprotechEnabled = !!enabled;
  // IMPORTANT: the actual one used elsewhere in your codebase:
  u.autoprotechEnabled = !!enabled;
}

function requireValidRole(role) {
  const r = String(role || '').trim();
  const ok = Object.values(ROLES).includes(r);
  if (!ok) throw new Error(`Invalid role: ${r}`);
  return r;
}

function ensureAdminFromEnv() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;

  const db = readDb();
  ensureArrays(db);

  const emailKey = normEmail(ADMIN_EMAIL);
  const exists = db.users.find(
    (u) => normEmail(u.email) === emailKey && u.role === ROLES.ADMIN
  );
  if (exists) return;

  const admin = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: String(ADMIN_EMAIL).trim(),
    passwordHash: bcrypt.hashSync(String(ADMIN_PASSWORD), 10),
    role: ROLES.ADMIN,
    companyId: null,
    createdAt: new Date().toISOString(),
    subscriptionStatus: SUBSCRIPTION.ACTIVE,
    mustResetPassword: false,
    profile: { displayName: 'Admin' },
  };

  // Admins always start with AutoProtect on
  setAutoprotect(admin, true);

  db.users.push(admin);
  writeDb(db);

  audit({
    actorId: admin.id,
    action: 'ADMIN_BOOTSTRAP',
    targetType: 'User',
    targetId: admin.id,
  });
}

function createUser({ email, password, role, profile = {}, companyId = null }) {
  const db = readDb();
  ensureArrays(db);

  const cleanEmail = String(email || '').trim();
  if (!cleanEmail) throw new Error('Email required');

  const r = requireValidRole(role);

  if (db.users.find((u) => normEmail(u.email) === normEmail(cleanEmail))) {
    throw new Error('Email already exists');
  }

  if (!password || String(password).length < 4) {
    throw new Error('Password too short');
  }

  const isIndividual = r === ROLES.INDIVIDUAL;

  const u = {
    id: nanoid(),
    platformId: `AS-${nanoid(10).toUpperCase()}`,
    email: cleanEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: r,
    companyId: companyId || null,
    createdAt: new Date().toISOString(),
    subscriptionStatus: isIndividual ? SUBSCRIPTION.TRIAL : SUBSCRIPTION.ACTIVE,
    trialEndsAt: isIndividual
      ? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      : null,
    mustResetPassword: false,
    profile: profile && typeof profile === 'object' ? profile : {},
  };

  // Managers/Admins start with AutoProtect on; others off by default
  setAutoprotect(u, r === ROLES.ADMIN || r === ROLES.MANAGER);

  db.users.push(u);
  writeDb(db);

  audit({ actorId: u.id, action: 'USER_CREATED', targetType: 'User', targetId: u.id });

  createNotification({
    userId: u.id,
    severity: 'info',
    title: 'Welcome',
    message: 'Welcome to AutoShield Tech. Check notifications and start your first project.',
  });

  return sanitize(u);
}

function findByEmail(email) {
  const db = readDb();
  ensureArrays(db);
  return db.users.find((u) => normEmail(u.email) === normEmail(email)) || null;
}

function listUsers() {
  const db = readDb();
  ensureArrays(db);
  return db.users.map(sanitize);
}

function updateUser(id, patch, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error('User not found');

  const p = patch && typeof patch === 'object' ? { ...patch } : {};

  // keep autoprotect fields synced if present
  if (typeof p.autoprotectEnabled !== 'undefined') {
    setAutoprotect(u, !!p.autoprotectEnabled);
    delete p.autoprotectEnabled;
    delete p.autoprotechEnabled;
  }
  if (typeof p.autoprotechEnabled !== 'undefined') {
    setAutoprotect(u, !!p.autoprotechEnabled);
    delete p.autoprotechEnabled;
  }

  // role changes should be validated (if you ever allow it)
  if (typeof p.role !== 'undefined') {
    p.role = requireValidRole(p.role);
  }

  Object.assign(u, p);
  writeDb(db);

  audit({
    actorId,
    action: 'USER_UPDATED',
    targetType: 'User',
    targetId: id,
    metadata: patch,
  });

  return sanitize(u);
}

function rotatePlatformIdAndForceReset(id, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error('User not found');

  u.platformId = `AS-${nanoid(10).toUpperCase()}`;
  u.mustResetPassword = true;
  writeDb(db);

  audit({ actorId, action: 'USER_ROTATE_ID', targetType: 'User', targetId: id });

  createNotification({
    userId: id,
    severity: 'warn', // ✅ matches your CSS dot.warn
    title: 'Security reset required',
    message: 'Your platform ID was rotated. Please reset your password before continuing.',
  });

  return sanitize(u);
}

function setPassword(id, newPassword, actorId) {
  const db = readDb();
  ensureArrays(db);

  const u = db.users.find((x) => x.id === id);
  if (!u) throw new Error('User not found');

  if (!newPassword || String(newPassword).length < 4) {
    throw new Error('Password too short');
  }

  u.passwordHash = bcrypt.hashSync(String(newPassword), 10);
  u.mustResetPassword = false;
  writeDb(db);

  audit({ actorId, action: 'USER_PASSWORD_SET', targetType: 'User', targetId: id });

  return sanitize(u);
}

// Helper (useful later)
function verifyPassword(user, password) {
  if (!user) return false;
  return bcrypt.compareSync(String(password || ''), String(user.passwordHash || ''));
}

module.exports = {
  ROLES,
  SUBSCRIPTION,
  ensureAdminFromEnv,
  createUser,
  findByEmail,
  listUsers,
  updateUser,
  rotatePlatformIdAndForceReset,
  setPassword,
  verifyPassword,
  getAutoprotect,
};
