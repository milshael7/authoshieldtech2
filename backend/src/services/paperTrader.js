// backend/src/services/paperTrader.js
// Paper trading engine + tiered % growth + storehouse overflow + 50% top-up + persistence ("brain")
// FIXES:
//  - prevents cross-symbol exits (only exit if tick symbol matches position symbol)
//  - persistence path safe for Render disk via PAPER_STATE_PATH
//  - minimum trade size so fees don’t dominate
//  - tier logic: 100k -> 200k -> 300k -> 400k -> 500k (step=100k, cap=500k)

const fs = require('fs');
const path = require('path');

// ---- Core tier rules ----
const TIER_STEP_USD = Number(process.env.PAPER_TIER_STEP_USD || 100000);     // 100k
const MAX_TRADING_WALLET = Number(process.env.PAPER_MAX_WALLET_USD || 500000); // 500k
const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);        // 100k start
const TOPUP_TRIGGER_PCT = Number(process.env.PAPER_TOPUP_TRIGGER_PCT || 0.5); // 50% drop triggers top-up to tier base

// Storehouse starts at 0 by default (you can set if you want extra buffer in paper)
const STOREHOUSE_START = Number(process.env.PAPER_STOREHOUSE_START || 0);

// ---- Learning / signals ----
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// ---- Risk growth inside tier ----
const BASE_RISK_PCT = Number(process.env.PAPER_BASE_RISK_PCT || 0.03);  // 3%
const MAX_RISK_PCT = Number(process.env.PAPER_MAX_RISK_PCT || 0.50);    // 50%

// ---- Exit rules ----
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);

// ---- Realism knobs ----
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);      // per side
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);     // basis points
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);         // basis points
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000); // min gap between entries

// ---- Safety/limits ----
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 240); // paper can trade a lot
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.60);   // for paper safety only

// ---- Fee dominance fix ----
const MIN_TRADE_USD = Number(process.env.PAPER_MIN_TRADE_USD || 25); // enforce min order so fees don’t eat it
const MAX_TRADE_USD = Number(process.env.PAPER_MAX_TRADE_USD || 5000); // hard cap per trade
const RISK_SCALE = Number(process.env.PAPER_RISK_SCALE || 1.0); // owner knob (1.0 normal)

// ---- Persistence ("brain") ----
const STATE_FILE =
  (process.env.PAPER_STATE_PATH && String(process.env.PAPER_STATE_PATH).trim()) ||
  path.join('/tmp', 'paper_state.json');

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
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ---- Tier helpers ----
function getTierBase(balanceUsd) {
  // Tier base is in steps of 100k, min 100k, max 500k
  const b = Number(balanceUsd) || START_BAL;
  const capped = clamp(b, START_BAL, MAX_TRADING_WALLET);
  const steps = Math.floor((capped - 1) / TIER_STEP_USD);
  const base = START_BAL + steps * TIER_STEP_USD;
  return clamp(base, START_BAL, MAX_TRADING_WALLET);
}

function getTierCeil(tierBase) {
  return clamp(tierBase + TIER_STEP_USD, START_BAL, MAX_TRADING_WALLET);
}

function pctWithinTier(balanceUsd, tierBase) {
  const ceil = getTierCeil(tierBase);
  if (ceil === tierBase) return 1;
  return clamp((balanceUsd - tierBase) / (ceil - tierBase), 0, 1);
}

function currentRiskPct(balanceUsd, tierBase, riskPctFloor) {
  // riskPctFloor is usually 3%, but can reset after loss streak
  const prog = pctWithinTier(balanceUsd, tierBase);
  const maxPct = clamp(MAX_RISK_PCT, riskPctFloor, 0.99);
  const now = riskPctFloor + prog * (maxPct - riskPctFloor);
  return clamp(now, riskPctFloor, maxPct);
}

// ---- Costs ----
function applyEntryCosts(state, usdNotional) {
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

function applyExitFee(state, usdNotional) {
  const fee = usdNotional * FEE_RATE;
  state.costs.feePaid += fee;
  return fee;
}

// ---- Default state ----
function defaultState() {
  const tierBase = getTierBase(START_BAL);
  return {
    running: true,

    // Trading wallet (capped at 500k). Anything above goes to storehouse.
    balance: START_BAL,
    startBalance: START_BAL,
    storehouse: STOREHOUSE_START,

    // Tier and risk tracking
    tierBase,
    tierCeil: getTierCeil(tierBase),
    riskPctFloor: BASE_RISK_PCT, // resets back to 3% on loss-streak events
    riskPctNow: BASE_RISK_PCT,

    // Stats
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

    // Trades/position
    trades: [],
    position: null, // {symbol, side:'LONG', qty, entry, entryTs, entryNotionalUsd, entryCosts}
    lastPriceBySymbol: {},

    // Learning stats
    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      volatility: 0,
      trendEdge: 0,
      decision: "WAIT",
      lastReason: "boot",
      lastTickTs: null,
      riskPctNow: BASE_RISK_PCT
    },

    // Limits
    limits: {
      tradesToday: 0,
      dayKey: dayKey(Date.now()),
      lastTradeTs: 0,
      halted: false,
      haltReason: null,
      lossStreak: 0,        // IMPORTANT: if reaches 3, risk floor snaps back to 3%
      lossStreakTrigger: 3,
    },

    // Buffers per symbol
    buf: { BTCUSDT: [], ETHUSDT: [] },

    // Config (for UI/debug)
    config: {
      START_BAL,
      TIER_STEP_USD,
      MAX_TRADING_WALLET,
      TOPUP_TRIGGER_PCT,
      STOREHOUSE_START,
      WARMUP_TICKS,
      MIN_EDGE,
      BASE_RISK_PCT,
      MAX_RISK_PCT,
      TAKE_PROFIT_PCT,
      STOP_LOSS_PCT,
      FEE_RATE,
      SLIPPAGE_BP,
      SPREAD_BP,
      COOLDOWN_MS,
      MIN_TRADE_USD,
      MAX_TRADE_USD,
      MAX_TRADES_PER_DAY,
      MAX_DRAWDOWN_PCT,
      RISK_SCALE,
      STATE_FILE
    }
  };
}

let state = defaultState();

// ---- Persistence (debounced) ----
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
      trades: state.trades.slice(-1500)
    };
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // never crash backend due to persistence
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

    // daily reset
    const dk = dayKey(Date.now());
    if (state.limits.dayKey !== dk) {
      state.limits.dayKey = dk;
      state.limits.tradesToday = 0;
      state.limits.lossStreak = 0;
    }

    // keep pnl consistent
    state.pnl = (state.realized?.net || 0);

    // re-derive tier base/ceil safely
    const tb = getTierBase(state.balance);
    state.tierBase = tb;
    state.tierCeil = getTierCeil(tb);

    return true;
  } catch {
    return false;
  }
}
loadNow();

// ---- Learning buffer ----
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

// ---- Limits ----
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lossStreak = 0;
  }
}

function checkDrawdown() {
  const peak = Math.max(state.startBalance, state.tierBase); // simple guard
  const dd = (peak - state.balance) / peak;
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(MAX_DRAWDOWN_PCT * 100)}%`;
  }
}

// ---- Storehouse + tier updates ----
function enforceWalletCapAndOverflow() {
  if (state.balance > MAX_TRADING_WALLET) {
    const overflow = state.balance - MAX_TRADING_WALLET;
    state.balance = MAX_TRADING_WALLET;
    state.storehouse += overflow;

    state.trades.push({
      time: Date.now(),
      symbol: "SYSTEM",
      type: "STOREHOUSE_CREDIT",
      price: 0,
      qty: 0,
      usd: overflow,
      note: "overflow_to_storehouse"
    });
  }
}

function updateTierAndRisk() {
  const tb = getTierBase(state.balance);
  const tc = getTierCeil(tb);

  // If tier changed (up or down), risk floor resets to 3% (your rule)
  const tierChanged = tb !== state.tierBase;
  state.tierBase = tb;
  state.tierCeil = tc;

  if (tierChanged) {
    state.riskPctFloor = BASE_RISK_PCT;
    state.limits.lossStreak = 0;
  }

  // Compute current risk % inside tier
  state.riskPctNow = currentRiskPct(state.balance, state.tierBase, state.riskPctFloor);
  state.learnStats.riskPctNow = state.riskPctNow;
}

function maybeTopUpFromStorehouse(ts) {
  // Trigger when trading wallet falls to 50% of current tier base (ex: 100k tier -> trigger under 50k)
  const triggerLevel = state.tierBase * TOPUP_TRIGGER_PCT;

  if (state.balance >= triggerLevel) return;

  const needed = state.tierBase - state.balance;
  if (needed <= 0) return;

  const available = state.storehouse;

  const transfer = Math.max(0, Math.min(needed, available));
  if (transfer > 0) {
    state.storehouse -= transfer;
    state.balance += transfer;

    state.trades.push({
      time: ts,
      symbol: "SYSTEM",
      type: "STOREHOUSE_TOPUP",
      price: 0,
      qty: 0,
      usd: transfer,
      note: `topup_to_tier_base_${state.tierBase}`
    });
  } else {
    // Storehouse empty: record it (so you SEE why topup didn’t happen)
    state.trades.push({
      time: ts,
      symbol: "SYSTEM",
      type: "STOREHOUSE_TOPUP_FAILED",
      price: 0,
      qty: 0,
      usd: needed,
      note: "storehouse_empty"
    });
  }
}

// ---- Trading logic ----
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

  // ---- Position sizing: tiered risk % ----
  updateTierAndRisk();

  // Notional target = balance * riskPctNow, scaled and clamped
  let usdNotional = state.balance * state.riskPctNow * RISK_SCALE;

  // Fee dominance protection: enforce MIN_TRADE_USD
  usdNotional = clamp(usdNotional, MIN_TRADE_USD, MAX_TRADE_USD);

  // Also never exceed available cash too much (keep buffer)
  usdNotional = Math.min(usdNotional, Math.max(MIN_TRADE_USD, state.balance * 0.25));

  const qty = usdNotional / price;

  const entryCosts = applyEntryCosts(state, usdNotional);
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
  state.learnStats.lastReason = `entered_long_risk_${Math.round(state.riskPctNow * 100)}%`;
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;

  // ✅ FIX: never exit a BTC position using an ETH tick (or vice versa)
  if (pos.symbol !== symbol) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  if (change >= TAKE_PROFIT_PCT || change <= -STOP_LOSS_PCT) {
    const exitNotionalUsd = pos.qty * price;
    const gross = (price - entry) * pos.qty;

    const exitFee = applyExitFee(state, exitNotionalUsd);
    const net = gross - (pos.entryCosts || 0) - exitFee;

    // Apply net change to trading wallet
    state.balance += net;
    state.realized.net += net;
    state.pnl = state.realized.net;

    // Win/loss tracking + loss streak
    if (net >= 0) {
      state.realized.wins += 1;
      state.realized.grossProfit += net;
      state.limits.lossStreak = 0;
    } else {
      state.realized.losses += 1;
      state.realized.grossLoss += net; // negative
      state.limits.lossStreak = (state.limits.lossStreak || 0) + 1;

      // If 3 losses, snap risk floor back to 3% (your rule)
      if (state.limits.lossStreak >= (state.limits.lossStreakTrigger || 3)) {
        state.riskPctFloor = BASE_RISK_PCT;
        state.learnStats.lastReason = "loss_streak_3_reset_to_3%";
      }
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

    // Wallet cap + overflow to storehouse
    enforceWalletCapAndOverflow();

    // Update tier/risk after wallet changes
    updateTierAndRisk();

    // If wallet dropped too hard, top-up from storehouse to tier base (if available)
    maybeTopUpFromStorehouse(ts);

    // Re-evaluate tier after topup
    updateTierAndRisk();

    checkDrawdown();

    state.learnStats.decision = "SELL";
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

  // Exit before enter
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
  // keep tier/risk fresh in UI
  updateTierAndRisk();

  return {
    running: state.running,

    // wallets
    balance: state.balance,
    storehouse: state.storehouse,

    // tier + risk
    tierBase: state.tierBase,
    tierCeil: state.tierCeil,
    riskPctFloor: state.riskPctFloor,
    riskPctNow: state.riskPctNow,

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
