// backend/src/lib/notify.js
const { readDb, writeDb } = require('./db');
const { nanoid } = require('nanoid');

function ensureArray(db) {
  if (!db.notifications) db.notifications = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];
}

function normalizeSeverity(sev) {
  const s = String(sev || 'info').toLowerCase().trim();
  // keep it simple + consistent across UI
  if (s === 'warning') return 'warn';
  if (s === 'critical') return 'danger';
  if (s === 'error') return 'danger';
  if (s === 'success') return 'ok';
  if (['info', 'warn', 'danger', 'ok'].includes(s)) return s;
  return 'info';
}

// Always store both timestamps so all UI versions work
function withTimes(obj, iso) {
  return {
    ...obj,
    at: iso,
    createdAt: iso, // ✅ frontend sometimes uses this
  };
}

function createNotification({ userId = null, companyId = null, severity = 'info', title, message }) {
  const db = readDb();
  ensureArray(db);

  const iso = new Date().toISOString();

  const cleanTitle = String(title || '').trim();
  const cleanMsg = String(message || '').trim();

  const n = withTimes(
    {
      id: nanoid(),
      userId: userId ? String(userId) : null,
      companyId: companyId ? String(companyId) : null,
      severity: normalizeSeverity(severity),
      title: cleanTitle || 'Notification',
      message: cleanMsg || '',
      read: false,
    },
    iso
  );

  db.notifications.push(n);
  writeDb(db);
  return n;
}

function listNotifications({ userId, companyId } = {}) {
  const db = readDb();
  ensureArray(db);

  return db.notifications
    .map((n) => {
      // ✅ migrate older notifications silently
      const iso = n.createdAt || n.at || new Date().toISOString();
      const fixed = withTimes(
        {
          ...n,
          severity: normalizeSeverity(n.severity),
        },
        iso
      );
      return fixed;
    })
    .filter((n) => {
      if (userId && String(n.userId || '') !== String(userId)) return false;
      if (companyId && String(n.companyId || '') !== String(companyId)) return false;
      return true;
    })
    .sort((a, b) => ((a.createdAt || a.at) < (b.createdAt || b.at) ? 1 : -1));
}

/**
 * markRead(id, userId?, companyId?)
 * - Backward compatible: markRead(id) still works.
 * - If userId/companyId provided, it will ONLY mark if it matches scope.
 */
function markRead(id, userId = null, companyId = null) {
  const db = readDb();
  ensureArray(db);

  const n = db.notifications.find((x) => String(x.id) === String(id));
  if (!n) return null;

  // If scope is provided, enforce it
  if (userId && String(n.userId || '') !== String(userId)) return null;
  if (companyId && String(n.companyId || '') !== String(companyId)) return null;

  n.read = true;

  // ✅ ensure both timestamps exist (older records)
  if (!n.createdAt && n.at) n.createdAt = n.at;
  if (!n.at && n.createdAt) n.at = n.createdAt;

  // ✅ normalize severity just in case
  n.severity = normalizeSeverity(n.severity);

  writeDb(db);
  return n;
}

function markReadAll({ userId = null, companyId = null } = {}) {
  const db = readDb();
  ensureArray(db);

  let changed = 0;
  for (const n of db.notifications) {
    if (userId && String(n.userId || '') !== String(userId)) continue;
    if (companyId && String(n.companyId || '') !== String(companyId)) continue;

    if (!n.read) {
      n.read = true;
      changed++;
    }

    // keep timestamps consistent
    if (!n.createdAt && n.at) n.createdAt = n.at;
    if (!n.at && n.createdAt) n.at = n.createdAt;

    // normalize severity
    n.severity = normalizeSeverity(n.severity);
  }

  if (changed) writeDb(db);
  return { ok: true, changed };
}

module.exports = { createNotification, listNotifications, markRead, markReadAll };
