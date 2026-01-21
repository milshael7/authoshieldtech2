// backend/src/services/paperTrader.js
// Paper trading engine with:
// - Win/Loss accounting + fees realism
// - FIX: prevents cross-symbol exits (the "millions/billions jump" bug)
// - Persistence uses PAPER_STATE_PATH (Render Disk recommended)
// - NEW: Daily loss logic + recovery mode
//   If AI loses 2 trades in a day -> risk% resets to 3% and climbs back up as losses are repaid.

const fs = require("fs");
const path = require("path");

// ---------- ENV DEFAULTS ----------
const START_TRADING_WALLET = Number(process.env.PAPER_START_BALANCE || 100000);
const START_STOREHOUSE_WALLET = Number(process.env.PAPER_STOREHOUSE_START || 0);

const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

// risk % (your plan)
const RECOVERY_BASE_RISK_PCT = Number(process.env.PAPER_RECOVERY_BASE_RISK_PCT || 0.03); // 3%
const BASE_RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.12); // normal base (example 12%)
const MAX_RISK_PCT = Number(process.env.PAPER_MAX_RISK_PCT || 0.50); // 50%

// daily loss rule
const DAILY_LOSS_RESET_COUNT = Number(process.env.PAPER_DAILY_LOSS_RESET_COUNT || 2);

// TP/SL
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

// safety/limits
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY_DEFAULT = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 200); // paper can be higher
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// anti tiny-trades/fee-dominance
const MIN_USD_PER_TRADE = Number(process.env.PAPER_MIN_USD_PER_TRADE || 50);
const MIN_NET_TP_USD = Number(process.env.PAPER_MIN_NET_TP_USD || 1.0);

// wallet flow rules (optional; can keep simple for now)
const TRADING_WALLET_CAP_DEFAULT = Number(process.env.PAPER_TRADING_WALLET_CAP || 200000);
const TOPUP_TRIGGER_DEFAULT = Number(process.env.PAPER_TOPUP_TRIGGER || 500000);
const TOPUP_AMOUNT_DEFAULT = Number(process.env.PAPER_TOPUP_AMOUNT || 5000);

// persistence path
const STATE_FILE =
  (process.env.PAPER_STATE_PATH && String(process.env.PAPER_STATE_PATH).trim()) ||
  path.join("/tmp", "paper_state.json");

// ---------- HELPERS ----------
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
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

// ---------- STATE ----------
function defaultState() {
  return {
    running: true,

    wallets: {
      trading: START_TRADING_WALLET,
      storehouse: START_STOREHOUSE_WALLET
    },

    startBalance: START_TRADING_WALLET,
    pnl: 0,
    realized: { wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, net: 0 },
    costs: { feePaid: 0, slippageCost: 0, spreadCost: 0 },

    trades: [],
    position: null, // {symbol, qty, entry, entryTs, entryNotionalUsd, entryCosts}
    lastPriceBySymbol: {},

    learnStats: {
      ticksSeen: 0,
      confidence: 0,
      volatility: 0,
      trendEdge: 0,
      decision: "WAIT",
      lastReason: "boot",
      lastTickTs: null,
    },

    config: {
      WARMUP_TICKS,
      RECOVERY_BASE_RISK_PCT,
      BASE_RISK_PCT,
      MAX_RISK_PCT,
      MANUAL_RISK_PCT: null, // if set, overrides all auto risk
      DAILY_LOSS_RESET_COUNT,
      TAKE_PROFIT_PCT,
      STOP_LOSS_PCT,
      MIN_EDGE,
      FEE_RATE,
      SLIPPAGE_BP,
      SPREAD_BP,
      COOLDOWN_MS,
      MAX_USD_PER_TRADE,
      MAX_TRADES_PER_DAY: MAX_TRADES_PER_DAY_DEFAULT,
      MAX_DRAWDOWN_PCT,
      MIN_USD_PER_TRADE,
      MIN_NET_TP_USD,
      TRADING_WALLET_CAP: TRADING_WALLET_CAP_DEFAULT,
      TOPUP_TRIGGER: TOPUP_TRIGGER_DEFAULT,
      TOPUP_AMOUNT: TOPUP_AMOUNT_DEFAULT,
      STATE_FILE
    },

    limits: {
      tradesToday: 0,
      dayKey: dayKey(Date.now()),
      lastTradeTs: 0,
      halted: false,
      haltReason: null
    },

    // NEW: daily + recovery accounting
    daily: {
      dayKey: dayKey(Date.now()),
      lossesToday: 0,
      recoveryMode: false,
      recoveryDebtUsd: 0,      // current debt remaining
      recoveryDebtStartUsd: 0, // initial debt when recovery began (for % progress)
    },

    buf: { BTCUSDT: [], ETHUSDT: [] }
  };
}

let state = defaultState();

// ---------- PERSISTENCE ----------
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
    const safe = { ...state, trades: state.trades.slice(-800), buf: state.buf };
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {}
}
function loadNow() {
  try {
    ensureDirFor(STATE_FILE);
    if (!fs.existsSync(STATE_FILE)) return false;

    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    const base = defaultState();
    state = {
      ...base,
      ...parsed,
      wallets: { ...base.wallets, ...(parsed.wallets || {}) },
      realized: { ...base.realized, ...(parsed.realized || {}) },
      costs: { ...base.costs, ...(parsed.costs || {}) },
      learnStats: { ...base.learnStats, ...(parsed.learnStats || {}) },
      limits: { ...base.limits, ...(parsed.limits || {}) },
      config: { ...base.config, ...(parsed.config || {}) },
      daily: { ...base.daily, ...(parsed.daily || {}) },
      buf: { ...base.buf, ...(parsed.buf || {}) }
    };

    // ensure daily matches today
    const dk = dayKey(Date.now());
    if (state.limits.dayKey !== dk) {
      state.limits.dayKey = dk;
      state.limits.tradesToday = 0;
    }
    if (state.daily.dayKey !== dk) {
      state.daily.dayKey = dk;
      state.daily.lossesToday = 0;
      state.daily.recoveryMode = false;
      state.daily.recoveryDebtUsd = 0;
      state.daily.recoveryDebtStartUsd = 0;
    }

    state.pnl = (state.realized?.net || 0);
    return true;
  } catch {
    return false;
  }
}
loadNow();

// ---------- SIGNALS ----------
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

  const ticksFactor = clamp(state.learnStats.ticksSeen / state.config.WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (state.config.MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf =
    clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "warmup";
  if (state.learnStats.ticksSeen >= state.config.WARMUP_TICKS && Math.abs(edge) < state.config.MIN_EDGE) reason = "trend_unclear";
  else if (state.learnStats.ticksSeen >= state.config.WARMUP_TICKS && volNorm > 0.85) reason = "too_noisy";
  else if (state.learnStats.ticksSeen >= state.config.WARMUP_TICKS) reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

// ---------- COST MODEL ----------
function entryCostRate() {
  const spreadPct = state.config.SPREAD_BP / 10000;
  const slipPct = state.config.SLIPPAGE_BP / 10000;
  return state.config.FEE_RATE + spreadPct + slipPct;
}
function totalRoundTripCostRate() {
  const spreadPct = state.config.SPREAD_BP / 10000;
  const slipPct = state.config.SLIPPAGE_BP / 10000;
  return (2 * state.config.FEE_RATE) + spreadPct + slipPct;
}
function applyEntryCosts(usdNotional) {
  const spreadPct = state.config.SPREAD_BP / 10000;
  const slipPct = state.config.SLIPPAGE_BP / 10000;
  const fee = usdNotional * state.config.FEE_RATE;

  const spreadCost = usdNotional * spreadPct;
  const slippageCost = usdNotional * slipPct;

  state.costs.feePaid += fee;
  state.costs.spreadCost += spreadCost;
  state.costs.slippageCost += slippageCost;

  return fee + spreadCost + slippageCost;
}
function applyExitFee(usdNotional) {
  const fee = usdNotional * state.config.FEE_RATE;
  state.costs.feePaid += fee;
  return fee;
}

// ---------- DAILY CHECK ----------
function checkDaily(ts) {
  const dk = dayKey(ts);

  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
  }

  if (state.daily.dayKey !== dk) {
    state.daily.dayKey = dk;
    state.daily.lossesToday = 0;
    state.daily.recoveryMode = false;
    state.daily.recoveryDebtUsd = 0;
    state.daily.recoveryDebtStartUsd = 0;
  }
}

function checkDrawdown() {
  const peak = state.startBalance;
  const dd = (peak - state.wallets.trading) / peak;
  if (dd >= state.config.MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(state.config.MAX_DRAWDOWN_PCT * 100)}%`;
  }
}

// ---------- RISK % LOGIC (MANUAL OVERRIDE + DAILY RECOVERY MODE) ----------
function currentRiskPct() {
  // Owner override wins over everything
  const manual = state.config.MANUAL_RISK_PCT;
  if (manual !== null && manual !== undefined && Number.isFinite(Number(manual))) {
    return clamp(Number(manual), 0.005, state.config.MAX_RISK_PCT);
  }

  // Recovery mode: start at 3% and climb to max as debt is repaid
  if (state.daily.recoveryMode) {
    const base = clamp(state.config.RECOVERY_BASE_RISK_PCT, 0.005, state.config.MAX_RISK_PCT);
    const max = state.config.MAX_RISK_PCT;

    const startDebt = Math.max(1e-9, Number(state.daily.recoveryDebtStartUsd || 0));
    const debtNow = Math.max(0, Number(state.daily.recoveryDebtUsd || 0));

    // progress = 0 when debt unchanged, 1 when fully repaid
    const progress = clamp((startDebt - debtNow) / startDebt, 0, 1);

    return clamp(base + progress * (max - base), base, max);
  }

  // Normal mode: use your base->max logic (simple)
  return clamp(state.config.BASE_RISK_PCT, 0.005, state.config.MAX_RISK_PCT);
}

// ---------- TRADE PROFITABILITY CHECK ----------
function canTradeProfitablyAtTP() {
  const rt = totalRoundTripCostRate();
  return state.config.TAKE_PROFIT_PCT > rt;
}

// ---------- TRADING ----------
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
  if (state.learnStats.ticksSeen < state.config.WARMUP_TICKS) { state.learnStats.decision = "WAIT"; return; }

  if (Date.now() - (state.limits.lastTradeTs || 0) < state.config.COOLDOWN_MS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "cooldown";
    return;
  }

  if (state.limits.tradesToday >= state.config.MAX_TRADES_PER_DAY) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "max_trades_today";
    return;
  }

  if (!canTradeProfitablyAtTP()) {
    state.limits.halted = true;
    state.limits.haltReason = "tp_too_small_for_fees";
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "tp_too_small_for_fees";
    return;
  }

  if (conf < 0.55) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "confidence_low";
    return;
  }

  if (Math.abs(edge) < state.config.MIN_EDGE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trend_below_threshold";
    return;
  }

  // size by % of trading wallet
  const pct = currentRiskPct();
  let usdNotional = state.wallets.trading * pct;

  // enforce min/max sizing
  usdNotional = Math.max(usdNotional, state.config.MIN_USD_PER_TRADE);
  usdNotional = Math.min(usdNotional, state.config.MAX_USD_PER_TRADE);

  // expected net at TP must be meaningful
  const rt = totalRoundTripCostRate();
  const netPerUsdAtTP = state.config.TAKE_PROFIT_PCT - rt;
  const expectedNetAtTP = usdNotional * Math.max(0, netPerUsdAtTP);
  if (expectedNetAtTP < state.config.MIN_NET_TP_USD) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trade_too_small_for_net_tp";
    return;
  }

  // must afford entry costs
  const worstEntryCosts = usdNotional * entryCostRate();
  if (state.wallets.trading <= worstEntryCosts + 1) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "wallet_too_low_for_fees";
    return;
  }

  const qty = usdNotional / price;

  const entryCosts = applyEntryCosts(usdNotional);
  state.wallets.trading -= entryCosts;

  state.position = {
    symbol,
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
    note: state.daily.recoveryMode ? "entry_recovery_mode" : "entry_normal_mode"
  });

  state.limits.lastTradeTs = ts;
  state.limits.tradesToday += 1;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function onClosedTrade(net) {
  // net < 0 => loss
  if (net < 0) {
    state.daily.lossesToday += 1;

    // if we hit the daily loss reset count, enter recovery mode
    if (state.daily.lossesToday >= state.config.DAILY_LOSS_RESET_COUNT) {
      // add this loss into debt pool (debt is positive)
      const addDebt = Math.abs(net);

      // if first time entering recovery today, set start debt snapshot
      if (!state.daily.recoveryMode) {
        state.daily.recoveryMode = true;
        state.daily.recoveryDebtUsd = addDebt;
        state.daily.recoveryDebtStartUsd = addDebt;
      } else {
        // already in recovery, just increase debt (and start debt too so progress remains consistent)
        state.daily.recoveryDebtUsd += addDebt;
        state.daily.recoveryDebtStartUsd += addDebt;
      }
    } else {
      // not yet in recovery, do nothing special
    }
  } else if (net > 0) {
    // win: if in recovery, pay down debt
    if (state.daily.recoveryMode) {
      state.daily.recoveryDebtUsd -= net;

      if (state.daily.recoveryDebtUsd <= 0) {
        // debt fully repaid -> exit recovery mode (but lossesToday stays counted for the day)
        state.daily.recoveryMode = false;
        state.daily.recoveryDebtUsd = 0;
        state.daily.recoveryDebtStartUsd = 0;
      }
    }
  }
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;

  // critical: prevent cross-symbol exits
  if (pos.symbol !== symbol) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  if (change >= state.config.TAKE_PROFIT_PCT || change <= -state.config.STOP_LOSS_PCT) {
    const exitNotionalUsd = pos.qty * price;
    const gross = (price - entry) * pos.qty;

    const exitFee = applyExitFee(exitNotionalUsd);
    const net = gross - (pos.entryCosts || 0) - exitFee;

    // apply P&L to trading wallet
    state.wallets.trading += net;

    // record totals
    state.realized.net += net;
    state.pnl = state.realized.net;

    if (net >= 0) {
      state.realized.wins += 1;
      state.realized.grossProfit += net;
    } else {
      state.realized.losses += 1;
      state.realized.grossLoss += net;
    }

    // NEW: daily recovery logic
    onClosedTrade(net);

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
      note: change >= state.config.TAKE_PROFIT_PCT ? "take_profit" : "stop_loss"
    });

    state.position = null;

    checkDrawdown();

    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= state.config.TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
  } else {
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

// config update (optional)
function updateConfig(patch = {}) {
  state.config = { ...state.config, ...patch };

  state.config.RECOVERY_BASE_RISK_PCT = clamp(Number(state.config.RECOVERY_BASE_RISK_PCT || 0.03), 0.005, 0.95);
  state.config.BASE_RISK_PCT = clamp(Number(state.config.BASE_RISK_PCT || 0.12), 0.005, 0.95);
  state.config.MAX_RISK_PCT = clamp(Number(state.config.MAX_RISK_PCT || 0.5), state.config.BASE_RISK_PCT, 0.95);

  if (state.config.MANUAL_RISK_PCT === "" || state.config.MANUAL_RISK_PCT === undefined) {
    state.config.MANUAL_RISK_PCT = null;
  }
  if (state.config.MANUAL_RISK_PCT !== null) {
    const v = Number(state.config.MANUAL_RISK_PCT);
    state.config.MANUAL_RISK_PCT = Number.isFinite(v) ? clamp(v, 0.005, state.config.MAX_RISK_PCT) : null;
  }

  state.config.DAILY_LOSS_RESET_COUNT = Math.max(1, Number(state.config.DAILY_LOSS_RESET_COUNT || 2));
  state.config.MAX_TRADES_PER_DAY = Math.max(1, Number(state.config.MAX_TRADES_PER_DAY || MAX_TRADES_PER_DAY_DEFAULT));

  scheduleSave();
  return state.config;
}

function snapshot() {
  return {
    running: state.running,
    wallets: state.wallets,
    pnl: state.pnl,
    realized: state.realized,
    costs: state.costs,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    daily: state.daily,
    config: state.config,
    riskPctNow: currentRiskPct()
  };
}

module.exports = { start, tick, snapshot, hardReset, updateConfig };
