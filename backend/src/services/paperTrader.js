// backend/src/services/paperTrader.js
// Paper trading engine with hard limits to prevent "million dollar jumps"

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);

// learning / entry logic
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);

// realism + safety limits
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);     // 0.26%
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);    // 8 bps
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);        // 6 bps
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

let state = {
  running: false,
  balance: START_BAL,
  startBalance: START_BAL,
  pnl: 0,
  trades: [],
  position: null, // {symbol, qty, entry, time, usdNotional}
  lastPriceBySymbol: {},
  learnStats: {
    ticksSeen: 0,
    confidence: 0,
    volatility: 0,
    trendEdge: 0,
    decision: "WAIT",
    lastReason: "not_started",
    lastTickTs: null,
    feePaid: 0,
    slippageCost: 0,
    spreadCost: 0,
  },
  limits: {
    tradesToday: 0,
    dayKey: null,
    lastTradeTs: 0,
    halted: false,
    haltReason: null,
  },
  buf: { BTCUSDT: [], ETHUSDT: [] },
};

function dayKey(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
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
    return { vol: 0, edge: 0, conf: 0, reason: "collecting_more_data" };
  }

  const returns = [];
  for (let i = 1; i < b.length; i++) {
    const r = (b[i] - b[i - 1]) / b[i - 1];
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

  const conf = clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "warmup";
  if (state.learnStats.ticksSeen < WARMUP_TICKS) reason = "warmup";
  else if (Math.abs(edge) < MIN_EDGE) reason = "trend_unclear";
  else if (volNorm > 0.85) reason = "too_noisy";
  else reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

// price helpers for realism
function applySpreadAndSlippage(price, side) {
  // spread: buy a bit higher, sell a bit lower
  const spreadFrac = (SPREAD_BP / 10000);
  const slipFrac = (SLIPPAGE_BP / 10000);

  if (side === "BUY") {
    const px = price * (1 + spreadFrac / 2) * (1 + slipFrac);
    const cost = (px - price);
    return { px, spreadCost: price * (spreadFrac / 2), slippageCost: price * slipFrac };
  } else {
    const px = price * (1 - spreadFrac / 2) * (1 - slipFrac);
    const cost = (price - px);
    return { px, spreadCost: price * (spreadFrac / 2), slippageCost: price * slipFrac };
  }
}

function maybeResetDailyLimits(ts) {
  const dk = dayKey(ts);
  if (state.limits.dayKey !== dk) {
    state.limits.dayKey = dk;
    state.limits.tradesToday = 0;
    state.limits.lastTradeTs = 0;
  }
}

function checkDrawdown() {
  const dd = (state.startBalance - state.balance) / (state.startBalance || 1);
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(dd * 100)}%`;
  }
}

function canTrade(ts) {
  if (state.limits.halted) return false;
  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) return false;
  if (ts - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) return false;
  return true;
}

function start() {
  state.running = true;
  state.balance = START_BAL;
  state.startBalance = START_BAL;
  state.pnl = 0;
  state.trades = [];
  state.position = null;
  state.lastPriceBySymbol = {};
  state.learnStats = {
    ticksSeen: 0,
    confidence: 0,
    volatility: 0,
    trendEdge: 0,
    decision: "WAIT",
    lastReason: "started",
    lastTickTs: null,
    feePaid: 0,
    slippageCost: 0,
    spreadCost: 0,
  };
  state.limits = {
    tradesToday: 0,
    dayKey: null,
    lastTradeTs: 0,
    halted: false,
    haltReason: null,
  };
  state.buf = { BTCUSDT: [], ETHUSDT: [] };
}

function enterLong(symbol, price, ts) {
  // HARD CAP: never exceed MAX_USD_PER_TRADE, and never exceed available balance
  const usd = Math.min(MAX_USD_PER_TRADE, Math.max(0, state.balance));
  if (usd <= 0) return;

  const { px, spreadCost, slippageCost } = applySpreadAndSlippage(price, "BUY");

  const qty = usd / px; // qty derived from capped USD
  const fee = usd * FEE_RATE;

  // deduct fee immediately (realistic)
  state.balance = state.balance - fee;

  state.learnStats.feePaid += fee;
  state.learnStats.spreadCost += spreadCost * qty;
  state.learnStats.slippageCost += slippageCost * qty;

  state.position = { symbol, qty, entry: px, time: ts, usdNotional: usd };
  state.trades.push({ time: ts, symbol, type: "BUY", price: px, qty, fee, note: "paper_entry" });

  state.limits.tradesToday += 1;
  state.limits.lastTradeTs = ts;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function exitLong(price, ts, note) {
  const pos = state.position;
  if (!pos) return;

  const { px, spreadCost, slippageCost } = applySpreadAndSlippage(price, "SELL");

  const gross = (px - pos.entry) * pos.qty;
  const fee = (pos.usdNotional) * FEE_RATE; // fee on notional (simple)
  const profit = gross - fee;

  state.balance += profit;
  state.pnl += profit;

  state.learnStats.feePaid += fee;
  state.learnStats.spreadCost += spreadCost * pos.qty;
  state.learnStats.slippageCost += slippageCost * pos.qty;

  state.trades.push({
    time: ts,
    symbol: pos.symbol,
    type: "SELL",
    price: px,
    qty: pos.qty,
    profit,
    fee,
    note,
  });

  state.position = null;

  state.learnStats.decision = "SELL";
  state.learnStats.lastReason = note;

  checkDrawdown();
}

function tick(symbol, price, ts = Date.now()) {
  if (!state.running) return;

  symbol = String(symbol || "BTCUSDT");
  const p = Number(price);
  const t = Number(ts || Date.now());
  if (!Number.isFinite(p)) return;

  state.lastPriceBySymbol[symbol] = p;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = t;

  maybeResetDailyLimits(t);
  pushBuf(symbol, p);

  const { vol, edge, conf, reason } = computeSignals(symbol);
  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  // manage exit first
  if (state.position && state.position.symbol === symbol) {
    const entry = state.position.entry;
    const change = (p - entry) / (entry || 1);
    if (change >= TAKE_PROFIT_PCT) exitLong(p, t, "tp_hit");
    else if (change <= -STOP_LOSS_PCT) exitLong(p, t, "sl_hit");
    else state.learnStats.decision = "WAIT";
    return;
  }

  // decide entry
  if (!canTrade(t)) {
    state.learnStats.decision = "WAIT";
    if (state.limits.halted) state.learnStats.lastReason = state.limits.haltReason || "halted";
    else if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) state.learnStats.lastReason = "max_trades_day";
    else state.learnStats.lastReason = "cooldown";
    return;
  }

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "warmup";
    return;
  }

  if (conf < 0.45) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "confidence_low";
    return;
  }

  if (Math.abs(edge) < MIN_EDGE) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "trend_below_threshold";
    return;
  }

  // baseline: LONG only
  enterLong(symbol, p, t);
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    pnl: state.pnl,
    trades: state.trades.slice(-200),
    position: state.position,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats,
    limits: state.limits,
    config: {
      START_BAL,
      WARMUP_TICKS,
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
    },
  };
}

module.exports = { start, tick, snapshot };
