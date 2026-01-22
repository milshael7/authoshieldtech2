// backend/src/services/paperTrader.js
// Paper trading engine
// - REAL position sizing (3% baseline → scales up to max %)
// - Uses REAL capital (not pennies)
// - Full trade history (BUY + SELL)
// - Loss control: after 2 losses/day → reset to baseline
// - Owner-configurable sizing + trades/day
// - Safe persistence

const fs = require('fs');
const path = require('path');

/* =========================
   CONFIG / DEFAULTS
========================= */

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const BASELINE_PCT = Number(process.env.PAPER_BASELINE_PCT || 0.03); // 3%
const MAX_PCT = Number(process.env.PAPER_OWNER_MAX_PCT || 0.50);     // 50%
const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);

const TIER_SIZE = Number(process.env.PAPER_TIER_SIZE || 100000);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const STATE_FILE =
  process.env.PAPER_STATE_PATH ||
  path.join('/tmp', 'paper_state.json');

/* =========================
   STRATEGIES
========================= */

const SCALP = {
  name: 'SCALP',
  TP: 0.0025,
  SL: 0.0020,
  HOLD_MS: 5000,
  MIN_CONF: 0.62,
};

const LONG = {
  name: 'LONG',
  TP: 0.010,
  SL: 0.006,
  HOLD_MS: 45 * 60 * 1000,
  MIN_CONF: 0.80,
};

/* =========================
   UTIL
========================= */

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/* =========================
   STATE
========================= */

function defaultState() {
  return {
    running: true,

    startBalance: START_BAL,
    cashBalance: START_BAL,
    equity: START_BAL,
    pnl: 0,

    realized: {
      wins: 0,
      losses: 0,
      grossProfit: 0,
      grossLoss: 0,
      net: 0,
    },

    costs: {
      feePaid: 0,
      slippageCost: 0,
      spreadCost: 0,
    },

    trades: [],
    position: null,
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      trendEdge: 0,
      decision: 'WAIT',
      lastReason: 'boot',
      lastTickTs: null,
    },

    limits: {
      tradesToday: 0,
      lossesToday: 0,
      forceBaseline: false,
      lastTradeTs: 0,
      halted: false,
      haltReason: null,
      dayKey: dayKey(Date.now()),
    },

    owner: {
      baselinePct: BASELINE_PCT,
      maxPct: MAX_PCT,
      maxTradesPerDay: MAX_TRADES_DAY,
    },

    buf: { BTCUSDT: [], ETHUSDT: [] },
  };
}

let state = defaultState();

/* =========================
   PERSISTENCE
========================= */

function save() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE));
      state = { ...defaultState(), ...raw };
    }
  } catch {}
}

load();

/* =========================
   SIGNALS
========================= */

function pushBuf(sym, price) {
  const b = state.buf[sym] || [];
  b.push(price);
  while (b.length > 60) b.shift();
  state.buf[sym] = b;
}

function computeSignals(sym) {
  const b = state.buf[sym] || [];
  if (b.length < 15) return { conf: 0, edge: 0, reason: 'warming_up' };

  const early = b.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  const late = b.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const edge = (late - early) / early;

  const conf = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  return { conf, edge, reason: 'edge_detected' };
}

/* =========================
   SIZING
========================= */

function tierBase() {
  return Math.max(TIER_SIZE, Math.floor(state.equity / TIER_SIZE) * TIER_SIZE);
}

function sizePct() {
  if (state.limits.forceBaseline) return state.owner.baselinePct;
  return clamp(state.owner.maxPct, state.owner.baselinePct, state.owner.maxPct);
}

function tradeSizeUsd() {
  let usd = tierBase() * sizePct();
  usd = Math.min(usd, state.cashBalance - 1);
  return Math.max(25, usd);
}

/* =========================
   COSTS
========================= */

function entryCost(usd) {
  const fee = usd * FEE_RATE;
  const slip = usd * (SLIPPAGE_BP / 10000);
  const spread = usd * (SPREAD_BP / 10000);
  state.costs.feePaid += fee;
  state.costs.slippageCost += slip;
  state.costs.spreadCost += spread;
  return fee + slip + spread;
}

function exitFee(usd) {
  const fee = usd * FEE_RATE;
  state.costs.feePaid += fee;
  return fee;
}

/* =========================
   TRADING LOGIC
========================= */

function maybeEnter(sym, price, ts) {
  if (state.position) return;
  if (state.learnStats.ticksSeen < WARMUP_TICKS) return;
  if (state.limits.tradesToday >= state.owner.maxTradesPerDay) return;

  const { conf, edge, reason } = computeSignals(sym);
  state.learnStats.confidence = conf;
  state.learnStats.trendEdge = edge;
  state.learnStats.lastReason = reason;

  const strat =
    conf >= LONG.MIN_CONF ? LONG :
    conf >= SCALP.MIN_CONF ? SCALP :
    null;

  if (!strat) return;

  const usd = tradeSizeUsd();
  const cost = entryCost(usd);
  if (state.cashBalance < usd + cost) return;

  const qty = usd / price;
  state.cashBalance -= usd + cost;

  state.position = {
    symbol: sym,
    entry: price,
    qty,
    usd,
    strategy: strat.name,
    tp: strat.TP,
    sl: strat.SL,
    entryTs: ts,
    expiresAt: ts + strat.HOLD_MS,
    cost,
  };

  state.trades.push({
    time: ts,
    type: 'BUY',
    symbol: sym,
    strategy: strat.name,
    price,
    usd,
    note: `Entered ${strat.name} with ${(sizePct() * 100).toFixed(1)}%`,
  });

  state.limits.tradesToday++;
}

function maybeExit(sym, price, ts) {
  const p = state.position;
  if (!p || p.symbol !== sym) return;

  const change = (price - p.entry) / p.entry;
  const hitTP = change >= p.tp;
  const hitSL = change <= -p.sl;
  const expired = ts >= p.expiresAt;

  if (!hitTP && !hitSL && !expired) return;

  const gross = (price - p.entry) * p.qty;
  const fee = exitFee(p.qty * price);
  const net = gross - p.cost - fee;

  state.cashBalance += p.usd + net;
  state.equity = state.cashBalance;
  state.realized.net += net;

  if (net >= 0) {
    state.realized.wins++;
    state.realized.grossProfit += net;
    state.limits.forceBaseline = false;
  } else {
    state.realized.losses++;
    state.realized.grossLoss += net;
    state.limits.lossesToday++;
    if (state.limits.lossesToday >= 2) state.limits.forceBaseline = true;
  }

  state.trades.push({
    time: ts,
    type: 'SELL',
    symbol: sym,
    price,
    profit: net,
    exitReason: hitTP ? 'take_profit' : hitSL ? 'stop_loss' : 'expiry',
  });

  state.position = null;
}

/* =========================
   TICK
========================= */

function tick(sym, price, ts = Date.now()) {
  state.learnStats.ticksSeen++;
  state.learnStats.lastTickTs = ts;
  state.lastPriceBySymbol[sym] = price;

  pushBuf(sym, price);
  maybeExit(sym, price, ts);
  maybeEnter(sym, price, ts);

  save();
}

/* =========================
   API
========================= */

function snapshot() {
  return { ...state };
}

function start() {
  state.running = true;
}

function hardReset() {
  state = defaultState();
  save();
}

function setConfig(patch) {
  state.owner = { ...state.owner, ...patch };
  save();
  return state.owner;
}

module.exports = { start, tick, snapshot, hardReset, setConfig };
