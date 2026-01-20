// backend/src/services/paperTrader.js
// Paper trading engine + learning stats + persistence (db.json)
// Goal:
// 1) No reset on page refresh
// 2) Reload state after server restart
// 3) Prevent insane position sizes (respect MAX_USD_PER_TRADE, MAX_TRADES_PER_DAY, cooldown)
// 4) Make P/L math consistent with fees/slippage/spread

const { readDb, writeDb } = require('../lib/db');

// ---------------- Config ----------------
const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);

const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);     // 0.26%
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);    // 8 bp
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);        // 6 bp

// guards
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// persistence key
const DB_KEY = 'paperTrader';

// ---------------- Helpers ----------------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

// ---------------- State ----------------
let state = {
  running: false,

  // money
  balance: START_BAL,
  pnl: 0,

  // accounting
  feePaid: 0,
  slippageCost: 0,
  spreadCost: 0,

  // activity
  trades: [],
  position: null, // {symbol, side:'LONG', qty, entry, time, entryPxRaw}

  lastPriceBySymbol: {},
  buf: { BTCUSDT: [], ETHUSDT: [] },

  learnStats: {
    ticksSeen: 0,
    confidence: 0,
    volatility: 0,
    trendEdge: 0,
    decision: 'WAIT',
    lastReason: 'not_started',
    lastTickTs: null
  },

  limits: {
    tradesToday: 0,
    dayKey: dayKey(),
    lastTradeTs: 0,
    halted: false,
    haltReason: null
  }
};

// ---------------- Persistence ----------------
let saveTimer = null;
let lastSavedAt = 0;

function loadFromDb() {
  try {
    const db = readDb();
    const saved = db?.[DB_KEY];
    if (!saved) return false;

    // merge safe fields only
    state = {
      ...state,
      ...saved,
      // ensure required nested defaults exist
      buf: saved.buf || state.buf,
      lastPriceBySymbol: saved.lastPriceBySymbol || state.lastPriceBySymbol,
      learnStats: { ...state.learnStats, ...(saved.learnStats || {}) },
      limits: { ...state.limits, ...(saved.limits || {}) },
    };

    // reset daily counter if new day
    const dk = dayKey();
    if (state.limits.dayKey !== dk) {
      state.limits.dayKey = dk;
      state.limits.tradesToday = 0;
    }

    return true;
  } catch {
    return false;
  }
}

function saveToDbNow() {
  try {
    const db = readDb();
    db[DB_KEY] = state;
    writeDb(db);
    lastSavedAt = Date.now();
  } catch {
    // ignore write errors (but keep running)
  }
}

function scheduleSaveSoon() {
  // debounce saves (avoid writing every tick)
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDbNow();
  }, 800);
}

// ---------------- Core ----------------
function resetMoney() {
  state.balance = Number(process.env.PAPER_START_BALANCE || START_BAL);
  state.pnl = 0;
  state.feePaid = 0;
  state.slippageCost = 0;
  state.spreadCost = 0;
  state.trades = [];
  state.position = null;

  state.limits.tradesToday = 0;
  state.limits.dayKey = dayKey();
  state.limits.lastTradeTs = 0;
  state.limits.halted = false;
  state.limits.haltReason = null;

  state.learnStats.ticksSeen = 0;
  state.learnStats.confidence = 0;
  state.learnStats.volatility = 0;
  state.learnStats.trendEdge = 0;
  state.learnStats.decision = 'WAIT';
  state.learnStats.lastReason = 'started';
  state.learnStats.lastTickTs = null;

  scheduleSaveSoon();
}

function start() {
  // if we have saved state, keep it; otherwise start fresh
  const loaded = loadFromDb();
  state.running = true;

  if (!loaded) {
    resetMoney();
  } else {
    // make sure config/day counters are sane
    const dk = dayKey();
    if (state.limits.dayKey !== dk) {
      state.limits.dayKey = dk;
      state.limits.tradesToday = 0;
    }
    scheduleSaveSoon();
  }

  // periodic safety save (every 10s)
  setInterval(() => {
    // don’t spam writes if already saved recently
    if (Date.now() - lastSavedAt > 10000) saveToDbNow();
  }, 10000).unref?.();
}

function pushBuf(symbol, price) {
  if (!state.buf[symbol]) state.buf[symbol] = [];
  const b = state.buf[symbol];
  b.push(price);
  while (b.length > 60) b.shift();
}

function computeSignals(symbol) {
  const b = state.buf[symbol] || [];
  if (b.length < 10) {
    return { vol: 0, edge: 0, conf: 0, reason: 'collecting_more_data' };
  }

  const returns = [];
  for (let i = 1; i < b.length; i++) {
    const r = (b[i] - b[i - 1]) / (b[i - 1] || 1);
    returns.push(r);
  }

  const vol = std(returns);
  const volNorm = clamp(vol / 0.002, 0, 1);

  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1);

  const ticksFactor = clamp(state.learnStats.ticksSeen / WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf =
    clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) *
    clamp(noisePenalty, 0.2, 1);

  let reason = 'waiting_warmup';
  if (state.learnStats.ticksSeen < WARMUP_TICKS) reason = 'warmup';
  else if (Math.abs(edge) < MIN_EDGE) reason = 'trend_unclear';
  else if (volNorm > 0.85) reason = 'too_noisy';
  else reason = 'edge_detected';

  return { vol: volNorm, edge, conf, reason };
}

function haltedIfDrawdown() {
  // drawdown from start balance (simple)
  const dd = (START_BAL - state.balance) / (START_BAL || 1);
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(dd * 100)}%`;
    return true;
  }
  return state.limits.halted;
}

// price impact model (simple)
function applyEntryCosts(price) {
  const slip = (SLIPPAGE_BP / 10000) * price;
  const spread = (SPREAD_BP / 10000) * price;
  // entering LONG pays half spread + slippage
  const px = price + slip + spread / 2;
  return { execPx: px, slipCost: slip, spreadCost: spread / 2 };
}
function applyExitCosts(price) {
  const slip = (SLIPPAGE_BP / 10000) * price;
  const spread = (SPREAD_BP / 10000) * price;
  // exiting LONG sells at worse price
  const px = price - slip - spread / 2;
  return { execPx: px, slipCost: slip, spreadCost: spread / 2 };
}

function canTrade(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) {
    state.limits.halted = true;
    state.limits.haltReason = 'max_trades_per_day';
    return false;
  }
  if (ts - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) return false;
  if (haltedIfDrawdown()) return false;
  return true;
}

function maybeEnter(symbol, price, ts) {
  const { vol, edge, conf, reason } = computeSignals(symbol);

  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  if (state.position) {
    state.learnStats.decision = 'WAIT';
    return;
  }

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    state.learnStats.decision = 'WAIT';
    state.learnStats.lastReason = 'warmup';
    return;
  }

  if (conf < 0.45) {
    state.learnStats.decision = 'WAIT';
    state.learnStats.lastReason = 'confidence_low';
    return;
  }

  if (Math.abs(edge) < MIN_EDGE) {
    state.learnStats.decision = 'WAIT';
    state.learnStats.lastReason = 'trend_below_threshold';
    return;
  }

  if (!canTrade(ts)) {
    state.learnStats.decision = 'WAIT';
    state.learnStats.lastReason = state.limits.haltReason || 'cooldown_or_limits';
    return;
  }

  // ✅ HARD CAP notional per trade
  const riskDollars = state.balance * RISK_PCT;
  const usdToUse = Math.max(5, Math.min(riskDollars, MAX_USD_PER_TRADE));

  const { execPx, slipCost, spreadCost } = applyEntryCosts(price);

  const qty = Math.max(0.0000001, usdToUse / execPx);

  // fee charged on notional
  const fee = usdToUse * FEE_RATE;

  state.feePaid += fee;
  state.slippageCost += slipCost * qty;
  state.spreadCost += spreadCost * qty;

  // fees reduce balance immediately
  state.balance -= fee;

  state.position = {
    symbol,
    side: 'LONG',
    qty,
    entry: execPx,
    entryPxRaw: price,
    time: ts
  };

  state.trades.push({
    time: ts,
    symbol,
    type: 'BUY',
    price: execPx,
    qty,
    usd: usdToUse,
    fee,
    note: 'paper_entry'
  });

  state.limits.tradesToday += 1;
  state.limits.lastTradeTs = ts;

  state.learnStats.decision = 'BUY';
  state.learnStats.lastReason = 'entered_long';

  scheduleSaveSoon();
}

function maybeExit(price, ts) {
  const pos = state.position;
  if (!pos) return;

  const entry = pos.entry;
  const change = (price - entry) / (entry || 1);

  const tp = TAKE_PROFIT_PCT;
  const sl = STOP_LOSS_PCT;

  if (change >= tp || change <= -sl) {
    const { execPx, slipCost, spreadCost } = applyExitCosts(price);

    const gross = (execPx - entry) * pos.qty;

    const notional = execPx * pos.qty;
    const fee = notional * FEE_RATE;

    state.feePaid += fee;
    state.slippageCost += slipCost * pos.qty;
    state.spreadCost += spreadCost * pos.qty;

    const net = gross - fee;

    state.balance += net;
    state.pnl += net;

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: 'SELL',
      price: execPx,
      qty: pos.qty,
      profit: net,
      fee,
      note: change >= tp ? 'take_profit' : 'stop_loss'
    });

    state.position = null;
    state.learnStats.decision = 'SELL';
    state.learnStats.lastReason = change >= tp ? 'tp_hit' : 'sl_hit';

    scheduleSaveSoon();
  } else {
    state.learnStats.decision = 'WAIT';
  }
}

// ✅ main tick entry
function tick(a, b, c) {
  if (!state.running) return;

  let symbol, price, ts;

  if (typeof b === 'undefined') {
    symbol = 'BTCUSDT';
    price = Number(a);
    ts = Date.now();
  } else {
    symbol = String(a || 'BTCUSDT');
    price = Number(b);
    ts = Number(c || Date.now());
  }

  if (!Number.isFinite(price)) return;

  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = ts;

  pushBuf(symbol, price);

  // manage open risk first
  maybeExit(price, ts);

  // then decide entry
  maybeEnter(symbol, price, ts);
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: {
      ...state.learnStats,
      feePaid: state.feePaid,
      slippageCost: state.slippageCost,
      spreadCost: state.spreadCost
    },
    limits: state.limits,
    config: {
      START_BAL,
      WARMUP_TICKS,
      RISK_PCT,
      TAKE_PROFIT_PCT,
      STOP_LOSS_PCT,
      MIN_EDGE,
      FEE_RATE,
      SLIPPAGE_BP,
      SPREAD_BP,
      COOLDOWN_MS,
      MAX_USD_PER_TRADE,
      MAX_TRADES_PER_DAY,
      MAX_DRAWDOWN_PCT
    }
  };
}

module.exports = { start, tick, snapshot, resetMoney };
