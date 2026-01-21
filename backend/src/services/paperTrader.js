// backend/src/services/paperTrader.js
// Paper trading engine with 3-wallet model + percent sizing + overflow + storehouse top-up
// Also includes realistic costs, win/loss totals, persistence, and cross-symbol exit fix.

const fs = require("fs");
const path = require("path");

// ---------- ENV DEFAULTS ----------
const START_TRADING_WALLET = Number(process.env.PAPER_START_BALANCE || 100000); // AI wallet starts here
const START_STOREHOUSE_WALLET = Number(process.env.PAPER_STOREHOUSE_START || 100000); // locked reserve
const START_OWNER_WALLET = Number(process.env.PAPER_OWNER_START || 0);

const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

// percent sizing (the “plan” lives here)
const BASE_RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.03);   // 3% default
const MAX_RISK_PCT = Number(process.env.PAPER_MAX_RISK_PCT || 0.5); // 50% max cap

// profit / stop
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism knobs
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026); // per side
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

// safety / limits
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY_DEFAULT = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

// anti-fee tiny trade guardrails
const MIN_USD_PER_TRADE = Number(process.env.PAPER_MIN_USD_PER_TRADE || 50);
const MIN_NET_TP_USD = Number(process.env.PAPER_MIN_NET_TP_USD || 1.0);

// wallet system rules
const TOPUP_AMOUNT = Number(process.env.PAPER_TOPUP_AMOUNT || 1000);             // storehouse -> AI wallet
const TOPUP_TRIGGER = Number(process.env.PAPER_TOPUP_TRIGGER || 100);           // when AI wallet <= this, top up
const TRADING_WALLET_CAP_DEFAULT = Number(process.env.PAPER_TRADING_WALLET_CAP || 150000); // overflow threshold

// persistence path (Render Disk recommended)
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

    // 3-wallet system
    wallets: {
      trading: START_TRADING_WALLET,   // AI wallet
      storehouse: START_STOREHOUSE_WALLET, // locked reserve
      owner: START_OWNER_WALLET        // overflow wallet (owner withdraw later)
    },

    // accounting
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

    // configurable knobs (saved + editable from UI)
    config: {
      WARMUP_TICKS,
      BASE_RISK_PCT,
      MAX_RISK_PCT,
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
      TOPUP_AMOUNT,
      TOPUP_TRIGGER,
      TRADING_WALLET_CAP: TRADING_WALLET_CAP_DEFAULT,
      STATE_FILE
    },

    limits: {
      tradesToday: 0,
      dayKey: dayKey(Date.now()),
      lastTradeTs: 0,
      halted: false,
      haltReason: null
    },

    // streak logic for percent scaling
    streak: {
      winsInRow: 0,
      lossesInRow: 0
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
      streak: { ...base.streak, ...(parsed.streak || {}) },
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

// ---------- WALLET RULES ----------
function sweepOverflow() {
  const cap = Number(state.config.TRADING_WALLET_CAP || 0);
  if (!cap || cap <= 0) return;

  const trading = state.wallets.trading;
  if (trading > cap) {
    const overflow = trading - cap;
    state.wallets.trading -= overflow;
    state.wallets.owner += overflow;

    state.trades.push({
      time: Date.now(),
      symbol: "WALLET",
      type: "SWEEP",
      price: 0,
      qty: 0,
      usd: overflow,
      note: "overflow_to_owner_wallet"
    });
  }
}

function maybeTopUpFromStorehouse() {
  if (state.wallets.trading > state.config.TOPUP_TRIGGER) return;
  if (state.wallets.storehouse <= 0) return;

  const amt = Math.min(state.config.TOPUP_AMOUNT, state.wallets.storehouse);
  if (amt <= 0) return;

  state.wallets.storehouse -= amt;
  state.wallets.trading += amt;

  state.trades.push({
    time: Date.now(),
    symbol: "WALLET",
    type: "TOPUP",
    price: 0,
    qty: 0,
    usd: amt,
    note: "storehouse_to_trading_wallet"
  });
}

// ---------- LIMITS ----------
function checkDaily(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
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
function canTradeProfitablyAtTP() {
  const rt = totalRoundTripCostRate();
  return state.config.TAKE_PROFIT_PCT > rt;
}

// ---------- PERCENT SIZING (your “3%..50% plan”) ----------
function currentRiskPct() {
  // Losses reduce risk; wins can increase it up to MAX
  const base = state.config.BASE_RISK_PCT;
  const max = state.config.MAX_RISK_PCT;

  const lossPenalty = Math.min(0.02 * state.streak.lossesInRow, base * 0.8); // step down after losses
  const winBoost = Math.min(0.01 * state.streak.winsInRow, max - base);      // step up after wins

  return clamp(base - lossPenalty + winBoost, 0.005, max);
}

// ---------- TRADING LOGIC ----------
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

  // ✅ Size by % of AI trading wallet (this is what you asked for)
  const pct = currentRiskPct();
  let usdNotional = state.wallets.trading * pct;

  // apply guards
  usdNotional = Math.max(usdNotional, state.config.MIN_USD_PER_TRADE);
  usdNotional = Math.min(usdNotional, state.config.MAX_USD_PER_TRADE);

  // also enforce min expected net at TP
  const rt = totalRoundTripCostRate();
  const netPerUsdAtTP = state.config.TAKE_PROFIT_PCT - rt;
  const expectedNetAtTP = usdNotional * Math.max(0, netPerUsdAtTP);

  if (expectedNetAtTP < state.config.MIN_NET_TP_USD) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trade_too_small_for_net_tp";
    return;
  }

  // ensure wallet can pay entry costs
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
    note: `paper_entry_${Math.round(pct * 10000) / 100}%`
  });

  state.limits.lastTradeTs = ts;
  state.limits.tradesToday += 1;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;
  if (pos.symbol !== symbol) return; // critical fix

  const entry = pos.entry;
  const change = (price - entry) / entry;

  if (change >= state.config.TAKE_PROFIT_PCT || change <= -state.config.STOP_LOSS_PCT) {
    const exitNotionalUsd = pos.qty * price;
    const gross = (price - entry) * pos.qty;

    const exitFee = applyExitFee(exitNotionalUsd);
    const net = gross - (pos.entryCosts || 0) - exitFee;

    state.wallets.trading += net;

    state.realized.net += net;
    state.pnl = state.realized.net;

    if (net >= 0) {
      state.realized.wins += 1;
      state.realized.grossProfit += net;
      state.streak.winsInRow += 1;
      state.streak.lossesInRow = 0;
    } else {
      state.realized.losses += 1;
      state.realized.grossLoss += net;
      state.streak.lossesInRow += 1;
      state.streak.winsInRow = 0;
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
      note: change >= state.config.TAKE_PROFIT_PCT ? "take_profit" : "stop_loss"
    });

    state.position = null;
    checkDrawdown();

    // apply wallet rules after a trade finishes
    sweepOverflow();
    maybeTopUpFromStorehouse();

    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= state.config.TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
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

// ✅ Config controls from UI (owner/admin)
function updateConfig(patch = {}) {
  state.config = { ...state.config, ...patch };

  // clamp the % values
  state.config.BASE_RISK_PCT = clamp(Number(state.config.BASE_RISK_PCT || 0.03), 0.005, 0.5);
  state.config.MAX_RISK_PCT = clamp(Number(state.config.MAX_RISK_PCT || 0.5), state.config.BASE_RISK_PCT, 0.9);

  // clamp wallet caps
  state.config.TRADING_WALLET_CAP = Math.max(0, Number(state.config.TRADING_WALLET_CAP || TRADING_WALLET_CAP_DEFAULT));

  // clamp trades/day
  state.config.MAX_TRADES_PER_DAY = Math.max(1, Number(state.config.MAX_TRADES_PER_DAY || MAX_TRADES_PER_DAY_DEFAULT));

  scheduleSave();
  return state.config;
}

function snapshot() {
  return {
    running: state.running,

    // wallets
    wallets: state.wallets,

    pnl: state.pnl,
    realized: state.realized,
    costs: state.costs,

    trades: state.trades.slice(-200),
    position: state.position,

    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    config: state.config,

    // derived display
    riskPctNow: currentRiskPct()
  };
}

module.exports = { start, tick, snapshot, hardReset, updateConfig };
