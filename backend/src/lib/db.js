// backend/src/lib/db.js
// File-based JSON DB with schema + safe writes (atomic) so "brain" survives deploys.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const TMP_PATH = DB_PATH + '.tmp';

const SCHEMA_VERSION = 2;

function ensureDir(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultDb() {
  return {
    schemaVersion: SCHEMA_VERSION,

    // existing
    users: [],
    companies: [],
    audit: [],
    notifications: [],

    // NEW: persistent "brain" areas
    brain: {
      // reserved for long-term memory (summaries, rules, etc)
      memory: [], // [{ts, type, text, meta}]
      // reserved for system notes/flags
      notes: [],  // [{ts, text}]
    },

    paper: {
      // rolling stats that survive restarts
      summary: {
        startBalance: 0,
        balance: 0,
        pnl: 0,
        wins: 0,
        losses: 0,
        totalGain: 0,
        totalLoss: 0,
        fees: 0,
        slippage: 0,
        spread: 0,
        lastTradeTs: 0
      },
      // last N trades persisted (so you can review after restart)
      trades: [], // [{time, symbol, type, price, qty, profit, note}]
      // optional daily rollups
      daily: []   // [{dayKey, trades, pnl, wins, losses, totalGain, totalLoss}]
    },

    live: {
      events: [], // audit trail for live readiness / dry-run orders
    }
  };
}

// Fix old dbs into new schema (non-breaking)
function migrate(db) {
  if (!db || typeof db !== 'object') return defaultDb();

  if (!db.schemaVersion) db.schemaVersion = 1;

  // Add missing collections safely
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.companies)) db.companies = [];
  if (!Array.isArray(db.audit)) db.audit = [];
  if (!Array.isArray(db.notifications)) db.notifications = [];

  if (!db.brain) db.brain = {};
  if (!Array.isArray(db.brain.memory)) db.brain.memory = [];
  if (!Array.isArray(db.brain.notes)) db.brain.notes = [];

  if (!db.paper) db.paper = {};
  if (!db.paper.summary) {
    db.paper.summary = {
      startBalance: 0,
      balance: 0,
      pnl: 0,
      wins: 0,
      losses: 0,
      totalGain: 0,
      totalLoss: 0,
      fees: 0,
      slippage: 0,
      spread: 0,
      lastTradeTs: 0
    };
  }
  if (!Array.isArray(db.paper.trades)) db.paper.trades = [];
  if (!Array.isArray(db.paper.daily)) db.paper.daily = [];

  if (!db.live) db.live = {};
  if (!Array.isArray(db.live.events)) db.live.events = [];

  db.schemaVersion = SCHEMA_VERSION;
  return db;
}

function ensureDb() {
  ensureDir(DB_PATH);

  if (!fs.existsSync(DB_PATH)) {
    const fresh = defaultDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
    return;
  }

  // If file exists but schema is old/missing pieces, migrate once
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const migrated = migrate(parsed);
    fs.writeFileSync(DB_PATH, JSON.stringify(migrated, null, 2));
  } catch {
    // If corrupted, preserve a backup then rebuild
    try {
      const bad = fs.readFileSync(DB_PATH, 'utf-8');
      fs.writeFileSync(DB_PATH + '.corrupt.' + Date.now(), bad);
    } catch {}
    const fresh = defaultDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return migrate(parsed);
}

// Atomic write so deploy/restart never half-writes db.json
function writeDb(db) {
  ensureDb();
  const safe = migrate(db);
  const json = JSON.stringify(safe, null, 2);
  fs.writeFileSync(TMP_PATH, json);
  fs.renameSync(TMP_PATH, DB_PATH);
}

// Convenience updater (read -> mutate -> write)
function updateDb(mutator) {
  const db = readDb();
  const out = mutator(db) || db;
  writeDb(out);
  return out;
}

module.exports = { DB_PATH, ensureDb, readDb, writeDb, updateDb };
