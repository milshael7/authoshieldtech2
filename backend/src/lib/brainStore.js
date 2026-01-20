// backend/src/lib/brainStore.js
// Persistent memory for paper trading + future AI brain memory.
// This is the "brain folder" that survives deploys.

const { updateDb, readDb } = require('./db');

const MAX_PAPER_TRADES_STORED = Number(process.env.PAPER_TRADES_STORE_LIMIT || 1500);
const MAX_BRAIN_MEMORY_STORED = Number(process.env.BRAIN_MEMORY_STORE_LIMIT || 800);

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function recordPaperTrade(trade) {
  updateDb((db) => {
    if (!db.paper) db.paper = { summary: {}, trades: [], daily: [] };
    if (!Array.isArray(db.paper.trades)) db.paper.trades = [];

    db.paper.trades.push(trade);

    // cap storage
    if (db.paper.trades.length > MAX_PAPER_TRADES_STORED) {
      db.paper.trades = db.paper.trades.slice(-MAX_PAPER_TRADES_STORED);
    }

    // update daily rollup
    const dk = dayKey(trade.time);
    if (!Array.isArray(db.paper.daily)) db.paper.daily = [];
    let row = db.paper.daily.find((r) => r.dayKey === dk);
    if (!row) {
      row = { dayKey: dk, trades: 0, pnl: 0, wins: 0, losses: 0, totalGain: 0, totalLoss: 0 };
      db.paper.daily.push(row);
    }

    row.trades += 1;
    if (typeof trade.profit === 'number') {
      row.pnl += trade.profit;
      if (trade.profit >= 0) { row.wins += 1; row.totalGain += trade.profit; }
      else { row.losses += 1; row.totalLoss += Math.abs(trade.profit); }
    }

    // keep last 120 days
    if (db.paper.daily.length > 140) {
      db.paper.daily = db.paper.daily.slice(-140);
    }

    return db;
  });
}

function setPaperSummary(summary) {
  updateDb((db) => {
    if (!db.paper) db.paper = {};
    db.paper.summary = { ...(db.paper.summary || {}), ...(summary || {}) };
    return db;
  });
}

function getPaperSummary() {
  const db = readDb();
  return db.paper?.summary || {};
}

function getPaperTrades(limit = 200) {
  const db = readDb();
  const t = db.paper?.trades || [];
  return t.slice(-Math.max(1, Number(limit) || 200));
}

function addBrainMemory({ type = 'note', text = '', meta = null }) {
  const clean = String(text || '').trim();
  if (!clean) return;

  updateDb((db) => {
    if (!db.brain) db.brain = { memory: [], notes: [] };
    if (!Array.isArray(db.brain.memory)) db.brain.memory = [];

    db.brain.memory.push({ ts: Date.now(), type, text: clean, meta: meta || null });

    if (db.brain.memory.length > MAX_BRAIN_MEMORY_STORED) {
      db.brain.memory = db.brain.memory.slice(-MAX_BRAIN_MEMORY_STORED);
    }
    return db;
  });
}

function getBrainMemory(limit = 50) {
  const db = readDb();
  const mem = db.brain?.memory || [];
  return mem.slice(-Math.max(1, Number(limit) || 50));
}

function recordLiveEvent(evt) {
  updateDb((db) => {
    if (!db.live) db.live = { events: [] };
    if (!Array.isArray(db.live.events)) db.live.events = [];
    db.live.events.push({ ts: Date.now(), ...evt });

    // cap
    if (db.live.events.length > 1200) db.live.events = db.live.events.slice(-1200);
    return db;
  });
}

module.exports = {
  recordPaperTrade,
  setPaperSummary,
  getPaperSummary,
  getPaperTrades,
  addBrainMemory,
  getBrainMemory,
  recordLiveEvent,
};
