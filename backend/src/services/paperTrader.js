// backend/src/services/paperTrader.js
// Paper trading engine
// - REAL position sizing (3% baseline → scales up to max %)
// - Uses REAL capital (not pennies)
// - Full trade history (BUY + SELL)
// - Loss control: after 2 losses/day → reset to baseline
// - Owner-configurable sizing + trades/day
// - Daily rollover reset (tradesToday/lossesToday/forceBaseline)
// - Snapshot includes sizing info

const fs = require('fs');
const path = require('path');

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const BASELINE_PCT = Number(process.env.PAPER_BASELINE_PCT || 0.03);
const MAX_PCT = Number(process.env.PAPER_OWNER_MAX_PCT || 0.50);
const MAX_TRADES_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);

const TIER_SIZE = Number(process.env.PAPER_TIER_SIZE || 100000);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

const STATE_FILE = process.env.PAPER_STATE_PATH || path.join('/tmp', 'paper_state.json');

const SCALP = {
  name: 'SCALP',
  TP: 0.0025,
  SL: 0.0020,
  HOLD_MS: Number(process.env.PAPER_SCALP_HOLD_MS || 5000),
  MIN_CONF: 0.62,
};

const LONG = {
  name: 'LONG',
  TP: 0.010,
  SL: 0.006,
  HOLD_MS: Number(process.env.PAPER_LONG_HOLD_MS || 45 * 60 * 1000),
  MIN_CONF: 0.80,
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

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
      dayKey: dayKey(Date.now()),
      tradesToday: 0,
      lossesToday: 0,
      forceBaseline: false,
      lastTradeTs: 0,
      halted: false,
      haltReason: null,
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

/* ========== persistence ========== */
function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
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

/* ========== daily rollover ========== */
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lossesToday = 0;
    state.limits.forceBaseline = false;
  }
}

/* ========== drawdown safety ========== */
function checkDrawdown() {
  const peak = state.startBalance;
  const dd = (peak - state.equity) / peak;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(MAX_DRAWDOWN_PCT * 100)}%`;
  }
}

/* ========== signals ========== */
function pushBuf(sym, price) {
  const b = state.buf[sym] || [];
  b.push(price);
  while (b.length > 60) b.shift();
  state.buf[sym] = b;
}

function computeSignals(sym) {
  const b = state.buf[sym] || [];
  if (b.length < 15) return { conf: 0, edge: 0, reason: 'warming_up' };

  const early = b.slice(0, 20).reduce((a, x) => a + x, 0) / 20;
  const late = b.slice(-20).reduce((a, x) => a + x, 0) / 20;
  const edge = (late - early) / (early || 1);

  const conf = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  return { conf, edge, reason: 'edge_detected' };
}

/* ========== sizing ========== */
function tierBase() {
  return Math.max(TIER_SIZE, Math.floor((state.equity || 0) / TIER_SIZE) * TIER_SIZE);
}

function sizePct() {
  const baseline = clamp(Number(state.owner.baselinePct || BASELINE_PCT), 0.001, 0.50);
  const maxPct = clamp(Number(state.owner.maxPct || MAX_PCT), baseline, 0.50);
  if (state.limits.forceBaseline) return baseline;

  // Smooth grow within tier: baseline → maxPct as equity approaches tier top
  const base = tierBase();
  const top = base + TIER_SIZE;
  const p = clamp(((state.equity || 0) - base) / (top - base), 0, 1);

  return clamp(baseline + p * (maxPct - baseline), baseline, maxPct);
}

function tradeSizeUsd() {
  let usd = tierBase() * sizePct();
  usd = Math.min(usd, Math.max(0, (state.cashBalance || 0) - 1));
  return Math.max(25, usd);
}

/* ========== costs ========== */
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

/* ========== trading ========== */
function maybeEnter(sym, price, ts) {
  if (state.limits.halted) return;
  if (state.position) return;
  if (state.learnStats.ticksSeen < WARMUP_TICKS) return;

  if (Date.now() - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) return;
  if (state.limits.tradesToday >= Number(state.owner.maxTradesPerDay || MAX_TRADES_DAY)) return;

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
  state.cashBalance -= (usd + cost);

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
    cost,
    holdMs: strat.HOLD_MS,
    note: `Entered ${strat.name} • size ${(sizePct() * 100).toFixed(1)}% of tier ${tierBase()}`,
  });

  state.limits.tradesToday++;
  state.limits.lastTradeTs = ts;
}

function maybeExit(sym, price, ts) {
  const p = state.position;
  if (!p || p.symbol !== sym) return;

  const change = (price - p.entry) / p.entry;
  const hitTP = change >= p.tp;
  const hitSL = change <= -p.sl;
  const expired = ts >= p.expiresAt;

  if (!hitTP && !hitSL && !expired) {
    // mark equity with unrealized
    state.equity = state.cashBalance + (price - p.entry) * p.qty;
    return;
  }

  const gross = (price - p.entry) * p.qty;
  const fee = exitFee(p.qty * price);
  const net = gross - p.cost - fee;

  state.cashBalance += (p.usd + net);
  state.equity = state.cashBalance;

  state.realized.net += net;
  state.pnl = state.realized.net;

  const heldMs = Math.max(0, ts - (p.entryTs || ts));

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
    strategy: p.strategy,
    price,
    usd: p.qty * price,
    profit: net,
    holdMs: heldMs,
    exitReason: hitTP ? 'take_profit' : hitSL ? 'stop_loss' : 'expiry',
  });

  state.position = null;
  checkDrawdown();
}

/* ========== public API ========== */
function tick(sym, price, ts = Date.now()) {
  if (!state.running) return;

  checkDaily(ts);

  state.learnStats.ticksSeen++;
  state.learnStats.lastTickTs = ts;
  state.lastPriceBySymbol[sym] = price;

  pushBuf(sym, price);

  maybeExit(sym, price, ts);
  maybeEnter(sym, price, ts);

  if (state.trades.length > 6000) state.trades = state.trades.slice(-2000);

  save();
}

function snapshot() {
  const pos = state.position;
  const lastPx = pos ? state.lastPriceBySymbol[pos.symbol] : null;
  const unreal = (pos && Number.isFinite(lastPx)) ? (Number(lastPx) - pos.entry) * pos.qty : 0;

  const now = Date.now();
  const ageMs = pos ? Math.max(0, now - (pos.entryTs || now)) : null;
  const remainingMs = pos ? Math.max(0, (pos.expiresAt || now) - now) : null;

  return {
    ...state,
    unrealizedPnL: unreal,
    position: pos ? { ...pos, ageMs, remainingMs, holdMs: (pos.expiresAt - pos.entryTs) } : null,
    sizing: {
      tierBase: tierBase(),
      sizePct: sizePct(),
      sizeUsd: tradeSizeUsd(),
    },
  };
}

function start() { state.running = true; }
function hardReset() { state = defaultState(); save(); }

function setConfig(patch = {}) {
  const o = state.owner || {};
  if (patch.baselinePct != null) o.baselinePct = Number(patch.baselinePct);
  if (patch.maxPct != null) o.maxPct = Number(patch.maxPct);
  if (patch.maxTradesPerDay != null) o.maxTradesPerDay = Number(patch.maxTradesPerDay);

  o.baselinePct = clamp(Number(o.baselinePct || BASELINE_PCT), 0.001, 0.50);
  o.maxPct = clamp(Number(o.maxPct || MAX_PCT), o.baselinePct, 0.50);
  o.maxTradesPerDay = clamp(Number(o.maxTradesPerDay || MAX_TRADES_DAY), 1, 500);

  state.owner = o;
  save();
  return state.owner;
}

module.exports = { start, tick, snapshot, hardReset, setConfig };
