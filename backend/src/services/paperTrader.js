// backend/src/services/paperTrader.js
// Paper trading engine + learning stats + REALISTIC accounting + WIN/LOSS totals + persistence
// FIXED: prevents cross-symbol exits (the "billions/millions jump" bug)
// FIXED: safer persistence path for Render (defaults to /tmp unless you set PAPER_STATE_PATH)

const fs = require('fs');
const path = require('path');

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism knobs
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);      // per side
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);     // basis points
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);         // basis points
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000); // min gap between entries

// safety/limits
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// --- persistence file ---
// Render may block writes in repo directory. Default to /tmp (writable).
// If you mount a Render Disk, set PAPER_STATE_PATH to that disk path (ex: /var/data/paper_state.json).
const STATE_FILE =
  (process.env.PAPER_STATE_PATH && String(process.env.PAPER_STATE_PATH).trim()) ||
  path.join('/tmp', 'paper_state.json');

function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function defaultState() {
  return {
    running: true,
    startBalance: START_BAL,
    balance: START_BAL,
    pnl: 0,

    realized: {
      wins: 0,
      losses: 0,
      grossProfit: 0,
      grossLoss: 0, // negative
      net: 0
    },

    costs: {
      feePaid: 0,
      slippageCost: 0,
      spreadCost: 0
    },

    trades: [],
    position: null, // {symbol, side:'LONG', qty, entry, entryTs, entryNotionalUsd, entryCosts}
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      volatility: 0,
      trendEdge: 0,
      decision: "WAIT",
      lastReason: "boot",
      lastTickTs: null
    },

    limits: {
      tradesToday: 0,
      dayKey: dayKey(Date.now()),
      lastTradeTs: 0,
      halted: false,
      haltReason: null
    },

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
      MAX_DRAWDOWN_PCT,
      STATE_FILE
    },

    buf: { BTCUSDT: [], ETHUSDT: [] }
  };
}

let state = defaultState();

// ---- persistence (debounced) ----
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1200);
}

function saveNow() {
  try {
    ensureDirFor(STATE_FILE);
    const safe = {
      ...state,
      trades: state.trades.slice(-800),
      buf: state.buf
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // never crash server due to persistence
  }
}

function loadNow() {
  try {
    ensureDirFor(STATE_FILE);
    if (!fs.existsSync(STATE_FILE)) return false;

    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    const base = defaultState();
    state = {
      ...base,
      ...parsed,
      realized: { ...base.realized, ...(parsed.realized || {}) },
      costs: { ...base.costs, ...(parsed.costs || {}) },
      learnStats: { ...base.learnStats, ...(parsed.learnStats || {}) },
      limits: { ...base.limits, ...(parsed.limits || {}) },
      config: { ...base.config, ...(parsed.config || {}) },
      buf: { ...base.buf, ...(parsed.buf || {}) }
    };

    const dk = dayKey(Date.now());
    if (state.limits.dayKey !== dk) {
      state.limits.dayKey = dk;
      state.limits.tradesToday = 0;
    }

    state.pnl = (state.realized?.net || 0);
    return true;
  } catch {
    return false;
  }
}

// Load state on boot, but never crash if it fails
loadNow();

// ---- learning buffer ----
function pushBuf(symbol, price) {
  if (!state.buf[symbol]) state.buf[symbol] = [];
  const b = state.buf[symbol];
  b.push(price);
  while (b.length > 60) b.shift();
}

function computeSignals(symbol) {
  const b = state.buf[symbol] || [];
  if (b.length < 10) return { vol: 0, edge: 0, conf: 0, reason: "collecting_more_data" };

  const returns = [];
  for (let i = 1; i < b.length; i++) returns.push((b[i] - b[i - 1]) / b[i - 1]);

  const vol = std(returns);
  const volNorm = clamp(vol / 0.002, 0, 1);

  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1);

  const ticksFactor = clamp(state.learnStats.ticksSeen / WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf =
    clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "warmup";
  if (state.learnStats.ticksSeen >= WARMUP_TICKS && Math.abs(edge) < MIN_EDGE) reason = "trend_unclear";
  else if (state.learnStats.ticksSeen >= WARMUP_TICKS && volNorm > 0.85) reason = "too_noisy";
  else if (state.learnStats.ticksSeen >= WARMUP_TICKS) reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

// ---- cost models ----
function applyEntryCosts(usdNotional) {
  const spreadPct = SPREAD_BP / 10000;
  const slipPct = SLIPPAGE_BP / 10000;
  const fee = usdNotional * FEE_RATE;

  const spreadCost = usdNotional * spreadPct;
  const slippageCost = usdNotional * slipPct;

  state.costs.feePaid += fee;
  state.costs.spreadCost += spreadCost;
  state.costs.slippageCost += slippageCost;

  return fee + spreadCost + slippageCost;
}

function applyExitFee(usdNotional) {
  const fee = usdNotional * FEE_RATE;
  state.costs.feePaid += fee;
  return fee;
}

// ---- risk / limits ----
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }
}

function checkDrawdown() {
  const peak = state.startBalance;
  const dd = (peak - state.balance) / peak;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(MAX_DRAWDOWN_PCT * 100)}%`;
  }
}

// ---- trading logic ----
function maybeEnter(symbol, price, ts) {
  const { vol, edge, conf, reason } = computeSignals(symbol);

  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  if (state.limits.halted) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = state.limits.haltReason || "halted";
    return;
  }

  if (state.position) { state.learnStats.decision = "WAIT"; return; }
  if (state.learnStats.ticksSeen < WARMUP_TICKS) { state.learnStats.decision = "WAIT"; return; }

  if (Date.now() - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "cooldown";
    return;
  }

  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "max_trades_today";
    return;
  }

  if (conf < 0.55) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "confidence_low";
    return;
  }

  if (Math.abs(edge) < MIN_EDGE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trend_below_threshold";
    return;
  }

  const desiredUsd = Math.min(state.balance * RISK_PCT * 10, MAX_USD_PER_TRADE);
  const usdNotional = Math.max(10, desiredUsd);

  const qty = usdNotional / price;

  const entryCosts = applyEntryCosts(usdNotional);
  state.balance -= entryCosts;

  state.position = {
    symbol,
    side: "LONG",
    qty,
    entry: price,
    entryTs: ts,
    entryNotionalUsd: usdNotional,
    entryCosts
  };

  state.trades.push({
    time: ts,
    symbol,
    type: "BUY",
    price,
    qty,
    usd: usdNotional,
    cost: entryCosts,
    note: "paper_entry"
  });

  state.limits.lastTradeTs = ts;
  state.limits.tradesToday += 1;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;

  // ✅ CRITICAL FIX: only exit the position when the tick is the same symbol
  if (pos.symbol !== symbol) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  if (change >= TAKE_PROFIT_PCT || change <= -STOP_LOSS_PCT) {
    const exitNotionalUsd = pos.qty * price;
    const gross = (price - entry) * pos.qty;

    const exitFee = applyExitFee(exitNotionalUsd);
    const net = gross - (pos.entryCosts || 0) - exitFee;

    state.balance += net;
    state.realized.net += net;
    state.pnl = state.realized.net;

    if (net >= 0) {
      state.realized.wins += 1;
      state.realized.grossProfit += net;
    } else {
      state.realized.losses += 1;
      state.realized.grossLoss += net; // negative
    }

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price,
      qty: pos.qty,
      usd: exitNotionalUsd,
      profit: net,
      gross,
      fees: exitFee,
      note: change >= TAKE_PROFIT_PCT ? "take_profit" : "stop_loss"
    });

    state.position = null;
    checkDrawdown();

    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
  } else {
    state.learnStats.decision = "WAIT";
  }
}

// supports tick(price) or tick(symbol, price, ts)
function tick(a, b, c) {
  if (!state.running) return;

  let symbol, price, ts;
  if (typeof b === "undefined") {
    symbol = "BTCUSDT";
    price = Number(a);
    ts = Date.now();
  } else {
    symbol = String(a || "BTCUSDT");
    price = Number(b);
    ts = Number(c || Date.now());
  }

  if (!Number.isFinite(price)) return;

  checkDaily(ts);

  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = ts;

  pushBuf(symbol, price);

  // ✅ exit before enter (and symbol-aware)
  maybeExit(symbol, price, ts);
  maybeEnter(symbol, price, ts);

  if (state.trades.length > 4000) state.trades = state.trades.slice(-1500);
  scheduleSave();
}

function start() {
  state.running = true;
  state.learnStats.lastReason = "started";
  scheduleSave();
}

function hardReset() {
  state = defaultState();
  saveNow();
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    realized: state.realized,
    costs: state.costs,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    config: state.config
  };
}

module.exports = { start, tick, snapshot, hardReset };
