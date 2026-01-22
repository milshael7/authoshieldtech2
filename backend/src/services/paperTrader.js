// backend/src/services/paperTrader.js
// Paper trading engine + learning stats + REALISTIC wallet accounting + WIN/LOSS totals + persistence
// - cash is reserved on entry (wallet drops on BUY)
// - equity includes unrealized PnL when a position is open
// - prevents cross-symbol exits (no random huge jumps)
// - persistence safe for Render Disk (/var/data) or /tmp fallback
// - strategy profiles: SCALP (quick) vs LONG (conviction)
// - time-based expiry (shows countdown + can auto-exit on expiry)
// ✅ FIX: fee-aware entry gate (prevents “fees dominate -> endless tiny losses”)
// ✅ FIX: scalps require stronger edge + higher TP than costs
// ✅ FIX: optional loss-streak cooldown (stops revenge-trading)

const fs = require('fs');
const path = require('path');

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism knobs
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

// limits
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MIN_USD_PER_TRADE = Number(process.env.PAPER_MIN_USD_PER_TRADE || 25);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// ✅ fee-aware gating (prevents scalp death by fees)
const MIN_EXPECTED_NET_USD = Number(process.env.PAPER_MIN_EXPECTED_NET_USD || 0.75); // require at least this much *net* potential
const COST_BUFFER_MULT = Number(process.env.PAPER_COST_BUFFER_MULT || 1.25);         // TP must beat costs by this factor

// ✅ loss-streak cooldown (optional)
const LOSS_STREAK_COOLDOWN_MS = Number(process.env.PAPER_LOSS_STREAK_COOLDOWN_MS || 60000); // 60s
const MAX_CONSEC_LOSSES_BEFORE_COOLDOWN = Number(process.env.PAPER_MAX_CONSEC_LOSSES || 2);

// Strategy profiles
// NOTE: if you set PAPER_SCALP_HOLD_MS=5000 (5s), you will almost always lose with these fees.
// The fee-gate below will BLOCK those trades unless they can realistically beat costs.
const SCALP = {
  name: "SCALP",
  TP: Number(process.env.PAPER_SCALP_TP_PCT || 0.0040),          // 0.40% (raised so it can outrun fees)
  SL: Number(process.env.PAPER_SCALP_SL_PCT || 0.0030),          // 0.30%
  HOLD_MS: Number(process.env.PAPER_SCALP_HOLD_MS || 60000),     // 60s default (NOT 5s)
  MIN_CONF: Number(process.env.PAPER_SCALP_MIN_CONF || 0.70),    // stricter than before
  MIN_EDGE_MULT: Number(process.env.PAPER_SCALP_MIN_EDGE_MULT || 2.0) // needs stronger edge
};

const LONG = {
  name: "LONG",
  TP: Number(process.env.PAPER_LONG_TP_PCT || 0.012),            // 1.2%
  SL: Number(process.env.PAPER_LONG_SL_PCT || 0.007),            // 0.7%
  HOLD_MS: Number(process.env.PAPER_LONG_HOLD_MS || 45 * 60 * 1000), // 45m
  MIN_CONF: Number(process.env.PAPER_LONG_MIN_CONF || 0.82),
  MIN_EDGE_MULT: Number(process.env.PAPER_LONG_MIN_EDGE_MULT || 2.5)
};

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
    cashBalance: START_BAL,
    equity: START_BAL,
    pnl: 0,

    realized: {
      wins: 0,
      losses: 0,
      grossProfit: 0,
      grossLoss: 0,
      net: 0,
      consecLosses: 0 // ✅ track loss streak
    },

    costs: {
      feePaid: 0,
      slippageCost: 0,
      spreadCost: 0
    },

    trades: [],

    // only ONE position
    position: null, // {symbol, strategy, qty, entry, entryTs, expiresAt, holdMs, entryNotionalUsd, entryCosts, tpPct, slPct}

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
      haltReason: null,
      cooldownUntil: 0 // ✅ extra cooldown after loss streak
    },

    config: {
      START_BAL,
      WARMUP_TICKS,
      RISK_PCT,
      MIN_EDGE,
      FEE_RATE,
      SLIPPAGE_BP,
      SPREAD_BP,
      COOLDOWN_MS,
      MIN_USD_PER_TRADE,
      MAX_USD_PER_TRADE,
      MAX_TRADES_PER_DAY,
      MAX_DRAWDOWN_PCT,
      MIN_EXPECTED_NET_USD,
      COST_BUFFER_MULT,
      LOSS_STREAK_COOLDOWN_MS,
      MAX_CONSEC_LOSSES_BEFORE_COOLDOWN,
      STATE_FILE,
      SCALP,
      LONG
    },

    buf: { BTCUSDT: [], ETHUSDT: [], SOLUSDT: [] }
  };
}

let state = defaultState();

// ---- persistence ----
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 900);
}

function saveNow() {
  try {
    ensureDirFor(STATE_FILE);
    const safe = {
      ...state,
      trades: state.trades.slice(-1200),
      buf: state.buf
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
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

    if (!Number.isFinite(Number(state.cashBalance))) state.cashBalance = state.balance ?? base.cashBalance;
    if (!Number.isFinite(Number(state.equity))) state.equity = state.cashBalance;
    if (!Number.isFinite(Number(state.startBalance))) state.startBalance = base.startBalance;

    // backwards compat for consecLosses/cooldown
    if (!Number.isFinite(Number(state.realized.consecLosses))) state.realized.consecLosses = 0;
    if (!Number.isFinite(Number(state.limits.cooldownUntil))) state.limits.cooldownUntil = 0;

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

// ✅ estimate “round trip” cost BEFORE entering (so we can block bad trades)
function estimateRoundTripCosts(usdNotional) {
  // entry side: fee + spread + slippage
  const spreadPct = SPREAD_BP / 10000;
  const slipPct = SLIPPAGE_BP / 10000;

  const entryFee = usdNotional * FEE_RATE;
  const entrySpread = usdNotional * spreadPct;
  const entrySlip = usdNotional * slipPct;

  // exit side: fee (we already model fee on exit; spread/slip is “effectively” in your fills too,
  // but we’ll be conservative and count only fee on exit so we don't over-block.
  const exitFee = usdNotional * FEE_RATE;

  const entryCosts = entryFee + entrySpread + entrySlip;
  const total = entryCosts + exitFee;

  return { entryCosts, exitFee, total };
}

// ---- limits ----
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.realized.consecLosses = 0;
    state.limits.cooldownUntil = 0;
  }
}

function checkDrawdown() {
  const peak = state.startBalance;
  const dd = (peak - state.equity) / peak;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(MAX_DRAWDOWN_PCT * 100)}%`;
  }
}

function computeUnrealized(symbol, price) {
  const pos = state.position;
  if (!pos) return 0;
  if (pos.symbol !== symbol) return 0;
  return (price - pos.entry) * pos.qty;
}

function updateEquity(symbol, price) {
  const unreal = computeUnrealized(symbol, price);
  state.equity = state.cashBalance + unreal;
}

// ---- strategy selection ----
function pickStrategy({ conf, edge, volNorm }) {
  const strongTrendLong = Math.abs(edge) >= (MIN_EDGE * LONG.MIN_EDGE_MULT);
  const strongTrendScalp = Math.abs(edge) >= (MIN_EDGE * SCALP.MIN_EDGE_MULT);
  const notCrazyNoisy = volNorm <= 0.85;

  if (conf >= LONG.MIN_CONF && strongTrendLong && notCrazyNoisy) return LONG;
  if (conf >= SCALP.MIN_CONF && strongTrendScalp && notCrazyNoisy) return SCALP;
  return null;
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

  if (state.position) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "holding_position";
    return;
  }

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "warming_up";
    return;
  }

  const now = Date.now();
  if (state.limits.cooldownUntil && now < state.limits.cooldownUntil) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "loss_streak_cooldown";
    return;
  }

  if (now - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "cooldown";
    return;
  }

  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "max_trades_today";
    return;
  }

  if (Math.abs(edge) < MIN_EDGE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trend_below_threshold";
    return;
  }

  const strat = pickStrategy({ conf, edge, volNorm: vol });
  if (!strat) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "confidence_low";
    return;
  }

  // Notional sizing
  const desiredUsd = Math.min(state.cashBalance * RISK_PCT * 10, MAX_USD_PER_TRADE);
  let usdNotional = Math.max(MIN_USD_PER_TRADE, desiredUsd);

  usdNotional = Math.min(usdNotional, Math.max(0, state.cashBalance - 1));
  if (usdNotional < MIN_USD_PER_TRADE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "cash_too_low_for_min_trade";
    return;
  }

  // ✅ fee-aware gate: block trades whose TP can't beat costs
  // Expected gross profit at TP ~= usdNotional * TP%
  const est = estimateRoundTripCosts(usdNotional);
  const tpUsdGross = usdNotional * (strat.TP || 0);
  const tpUsdNetApprox = tpUsdGross - est.total;

  if (tpUsdGross < (est.total * COST_BUFFER_MULT) || tpUsdNetApprox < MIN_EXPECTED_NET_USD) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = `tp_vs_costs_blocked_${strat.name.toLowerCase()}`;
    return;
  }

  const qty = usdNotional / price;

  const entryCosts = applyEntryCosts(usdNotional);
  const totalReserve = usdNotional + entryCosts;

  if (state.cashBalance < totalReserve) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "insufficient_cash_for_entry";
    return;
  }

  state.cashBalance -= totalReserve;

  const holdMs = strat.HOLD_MS;
  const expiresAt = ts + holdMs;

  state.position = {
    symbol,
    strategy: strat.name,
    tpPct: strat.TP,
    slPct: strat.SL,
    holdMs,
    expiresAt,

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
    strategy: strat.name,
    price,
    qty,
    usd: usdNotional,
    cost: entryCosts,
    expiresAt,
    holdMs,
    note: "paper_entry"
  });

  state.limits.lastTradeTs = ts;
  state.limits.tradesToday += 1;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = `entered_${strat.name.toLowerCase()}`;

  updateEquity(symbol, price);
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;
  if (pos.symbol !== symbol) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  const tpHit = change >= (pos.tpPct ?? SCALP.TP);
  const slHit = change <= -(pos.slPct ?? SCALP.SL);
  const timeUp = Number.isFinite(pos.expiresAt) && ts >= pos.expiresAt;

  if (tpHit || slHit || timeUp) {
    const exitNotionalUsd = pos.qty * price;
    const gross = (price - entry) * pos.qty;

    const exitFee = applyExitFee(exitNotionalUsd);
    const net = gross - (pos.entryCosts || 0) - exitFee;

    // release principal + pnl into cash
    state.cashBalance += pos.entryNotionalUsd;
    state.cashBalance += net;

    state.realized.net += net;
    state.pnl = state.realized.net;

    if (net >= 0) {
      state.realized.wins += 1;
      state.realized.grossProfit += net;
      state.realized.consecLosses = 0;
    } else {
      state.realized.losses += 1;
      state.realized.grossLoss += net;
      state.realized.consecLosses = (state.realized.consecLosses || 0) + 1;

      // ✅ cooldown after a loss streak
      if (state.realized.consecLosses >= MAX_CONSEC_LOSSES_BEFORE_COOLDOWN) {
        state.limits.cooldownUntil = Date.now() + LOSS_STREAK_COOLDOWN_MS;
      }
    }

    const holdMs = Math.max(0, ts - (pos.entryTs || ts));

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      strategy: pos.strategy || "—",
      price,
      qty: pos.qty,
      usd: exitNotionalUsd,
      profit: net,
      gross,
      fees: exitFee,
      holdMs,
      exitReason: tpHit ? "take_profit" : (slHit ? "stop_loss" : "expiry"),
      note: tpHit ? "take_profit" : (slHit ? "stop_loss" : "expiry")
    });

    state.position = null;
    state.equity = state.cashBalance;

    checkDrawdown();

    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = tpHit ? "tp_hit" : (slHit ? "sl_hit" : "time_expired");
  } else {
    updateEquity(symbol, price);
    state.learnStats.decision = "WAIT";
  }
}

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

  // exit before enter
  maybeExit(symbol, price, ts);
  maybeEnter(symbol, price, ts);

  if (state.trades.length > 6000) state.trades = state.trades.slice(-2000);

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
  const sym = state.position?.symbol;
  const lastPx = sym ? state.lastPriceBySymbol[sym] : null;
  const unreal = (sym && lastPx && state.position) ? computeUnrealized(sym, Number(lastPx)) : 0;

  const pos = state.position;
  const now = Date.now();
  const ageMs = pos ? Math.max(0, now - (pos.entryTs || now)) : 0;
  const remainingMs = pos && Number.isFinite(pos.expiresAt) ? Math.max(0, pos.expiresAt - now) : null;

  return {
    running: state.running,

    cashBalance: state.cashBalance,
    equity: state.equity,
    pnl: state.pnl,

    realized: state.realized,
    costs: state.costs,

    trades: state.trades.slice(-240),

    position: pos ? {
      ...pos,
      ageMs,
      remainingMs
    } : null,

    unrealizedPnL: unreal,

    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    config: state.config
  };
}

module.exports = { start, tick, snapshot, hardReset };
