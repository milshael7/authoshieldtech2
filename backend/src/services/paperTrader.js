// backend/src/services/paperTrader.js
// Paper Trading Engine + AI Narration Hooks (FIXED STEP 10)
// SAFE • Deterministic • Human-explainable • Drop-in Replacement

const fs = require("fs");
const path = require("path");
const { makeDecision } = require("./tradeBrain");
const { addMemory } = require("../lib/brain");

/* ================= CONFIG ================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const STATE_FILE =
  process.env.PAPER_STATE_PATH || path.join("/tmp", "paper_state.json");

/* ================= HELPERS ================= */

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function narrate(text, meta = {}) {
  if (!text) return;
  addMemory({
    type: "trade_event",
    text: String(text).slice(0, 800),
    meta,
  });
}

/* ================= STATE ================= */

function defaultState() {
  return {
    running: true,

    cashBalance: START_BAL,
    equity: START_BAL,
    peakEquity: START_BAL,

    realized: { wins: 0, losses: 0, net: 0 },
    costs: { fees: 0, slippage: 0, spread: 0 },

    position: null,
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      decision: "WAIT",
      lastReason: "boot",
    },

    limits: {
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      halted: false,
      haltReason: null,
      lastTradeTs: 0,
    },
  };
}

let state = defaultState();

/* ================= PERSISTENCE ================= */

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE));
      state = { ...defaultState(), ...raw };
    }
  } catch {
    state = defaultState();
  }
}

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

load();

/* ================= CORE ================= */

function resetDayIfNeeded(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
}

function updateEquity(price) {
  if (state.position) {
    state.equity =
      state.cashBalance +
      (price - state.position.entry) * state.position.qty;
  } else {
    state.equity = state.cashBalance;
  }
  state.peakEquity = Math.max(state.peakEquity, state.equity);
}

function checkDrawdown() {
  if (state.limits.halted) return;

  const dd = (state.peakEquity - state.equity) / state.peakEquity;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = "max_drawdown";

    narrate(
      `Trading halted. Drawdown exceeded ${(MAX_DRAWDOWN_PCT * 100).toFixed(
        0
      )}% from peak equity.`,
      { reason: "drawdown", equity: state.equity }
    );
  }
}

function canTrade(ts) {
  if (state.limits.halted) return false;
  if (state.limits.tradesToday >= MAX_TRADES_DAY) return false;
  if (ts - state.limits.lastTradeTs < COOLDOWN_MS) return false;
  return true;
}

/* ================= EXECUTION ================= */

function openPosition(symbol, price, riskPct) {
  const usd = clamp(state.cashBalance * riskPct, 25, state.cashBalance - 10);
  if (usd <= 0) return;

  const spread = price * (SPREAD_BP / 10000);
  const slippage = price * (SLIPPAGE_BP / 10000);
  const fill = price + spread + slippage;

  const qty = usd / fill;
  const fee = usd * FEE_RATE;

  state.cashBalance -= usd + fee;
  state.costs.fees += fee;
  state.costs.spread += spread * qty;
  state.costs.slippage += slippage * qty;

  state.position = { symbol, entry: fill, qty, ts: Date.now() };
  state.limits.tradesToday++;
  state.limits.lastTradeTs = Date.now();

  narrate(
    `Entered ${symbol} at ${fill.toFixed(
      2
    )}. Risked ${(riskPct * 100).toFixed(1)}% of balance.`,
    { symbol, action: "BUY", entry: fill }
  );
}

function closePosition(price, reason) {
  const pos = state.position;
  if (!pos) return;

  const gross = (price - pos.entry) * pos.qty;
  const fee = Math.abs(gross) * FEE_RATE;
  const pnl = gross - fee;

  state.cashBalance += pos.qty * price - fee;
  state.costs.fees += fee;
  state.realized.net += pnl;

  if (pnl > 0) state.realized.wins++;
  else state.realized.losses++;

  narrate(
    `Closed ${pos.symbol} at ${price.toFixed(
      2
    )}. ${pnl >= 0 ? "Profit" : "Loss"}: ${pnl.toFixed(2)}.`,
    { symbol: pos.symbol, action: "CLOSE", pnl, reason }
  );

  state.position = null;
}

/* ================= TICK ================= */

function tick(symbol, price, ts = Date.now()) {
  if (!state.running) return;

  resetDayIfNeeded(ts);
  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen++;

  updateEquity(price);
  checkDrawdown();

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    save();
    return;
  }

  const plan = makeDecision({
    symbol,
    last: price,
    paper: state,
  });

  state.learnStats.decision = plan.action;
  state.learnStats.confidence = plan.confidence;
  state.learnStats.lastReason = plan.blockedReason || plan.action;

  if (!canTrade(ts)) {
    save();
    return;
  }

  if (plan.action === "BUY" && !state.position) {
    openPosition(symbol, price, plan.riskPct);
  }

  if (
    (plan.action === "SELL" || plan.action === "CLOSE") &&
    state.position &&
    state.position.symbol === symbol
  ) {
    closePosition(price, plan.action);
  }

  save();
}

/* ================= API ================= */

function snapshot() {
  return {
    ...state,
    unrealizedPnL: state.position
      ? (state.lastPriceBySymbol[state.position.symbol] -
          state.position.entry) *
        state.position.qty
      : 0,
  };
}

function start() {
  state.running = true;
}

function hardReset() {
  state = defaultState();
  save();
}

module.exports = {
  tick,
  snapshot,
  start,
  hardReset,
};
