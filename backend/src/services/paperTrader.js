// backend/src/services/paperTrader.js
// Paper trading engine + visible learning stats + realism (fees/slippage/spread) + safety limits

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

// risk + trade logic
const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

// realism costs
const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);      // 0.26% typical taker-ish
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);     // basis points
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);         // basis points

// safety + limits
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000); // 12s between entries
const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25); // 25%

let state = {
  running: false,
  balance: START_BAL,
  pnl: 0,
  trades: [],
  position: null, // {symbol, side:'LONG', qty, entry, time, feePaid, entrySlip, entrySpread}
  lastPriceBySymbol: {},
  learnStats: {
    ticksSeen: 0,
    confidence: 0,       // 0..1
    volatility: 0,       // 0..1
    trendEdge: 0,        // +/- edge
    decision: "WAIT",    // WAIT | BUY | SELL
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
  },
  buf: {
    BTCUSDT: [],
    ETHUSDT: []
  }
};

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
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
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}

function resetMoney() {
  state.balance = Number(process.env.PAPER_START_BALANCE || START_BAL);
  state.pnl = 0;
  state.trades = [];
  state.position = null;

  state.learnStats.feePaid = 0;
  state.learnStats.slippageCost = 0;
  state.learnStats.spreadCost = 0;

  state.limits.tradesToday = 0;
  state.limits.lastTradeTs = 0;
  state.limits.halted = false;
  state.limits.haltReason = null;
}

function start() {
  state.running = true;
  resetMoney();

  state.learnStats.ticksSeen = 0;
  state.learnStats.confidence = 0;
  state.learnStats.volatility = 0;
  state.learnStats.trendEdge = 0;
  state.learnStats.decision = "WAIT";
  state.learnStats.lastReason = "started";
  state.learnStats.lastTickTs = null;

  state.limits.dayKey = dayKey(Date.now());
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

  const conf = clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "waiting_warmup";
  if (state.learnStats.ticksSeen < WARMUP_TICKS) reason = "warmup";
  else if (Math.abs(edge) < MIN_EDGE) reason = "trend_unclear";
  else if (volNorm > 0.85) reason = "too_noisy";
  else reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

function applyExecutionCosts({ price, side }) {
  // Convert bp to pct
  const spreadPct = SPREAD_BP / 10000;
  const slipPct = SLIPPAGE_BP / 10000;

  // Buy gets worse price; Sell gets worse price too
  const spreadAdj = price * spreadPct;
  const slipAdj = price * slipPct;

  let exec = price;
  if (side === "BUY") exec = price + spreadAdj + slipAdj;
  if (side === "SELL") exec = price - spreadAdj - slipAdj;

  return {
    execPrice: exec,
    spreadCost: spreadAdj,
    slippageCost: slipAdj
  };
}

function checkDailyReset(ts) {
  const k = dayKey(ts);
  if (state.limits.dayKey !== k) {
    state.limits.dayKey = k;
    state.limits.tradesToday = 0;
    state.limits.lastTradeTs = 0;
    state.limits.halted = false;
    state.limits.haltReason = null;
  }
}

function checkDrawdown() {
  const dd = (START_BAL - state.balance) / (START_BAL || 1);
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = `max_drawdown_${Math.round(MAX_DRAWDOWN_PCT * 100)}pct`;
  }
}

function canTrade(ts) {
  checkDailyReset(ts);

  if (state.limits.halted) return { ok: false, reason: state.limits.haltReason || "halted" };
  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) return { ok: false, reason: "max_trades_per_day" };

  const since = ts - (state.limits.lastTradeTs || 0);
  if (since < COOLDOWN_MS) return { ok: false, reason: "cooldown" };

  checkDrawdown();
  if (state.limits.halted) return { ok: false, reason: state.limits.haltReason || "halted" };

  return { ok: true, reason: "ok" };
}

function maybeEnter(symbol, midPrice, ts) {
  const { vol, edge, conf, reason } = computeSignals(symbol);

  state.learnStats.volatility = vol;
  state.learnStats.trendEdge = edge;
  state.learnStats.confidence = conf;
  state.learnStats.lastReason = reason;

  if (state.position) {
    state.learnStats.decision = "WAIT";
    return;
  }

  if (state.learnStats.ticksSeen < WARMUP_TICKS) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = "warmup";
    return;
  }

  const okTrade = canTrade(ts);
  if (!okTrade.ok) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = okTrade.reason;
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

  // simple baseline: long only
  const riskDollars = Math.min(state.balance * RISK_PCT, MAX_USD_PER_TRADE);
  const qty = Math.max(0.00001, riskDollars / midPrice);

  // execution costs on BUY (worse fill)
  const ex = applyExecutionCosts({ price: midPrice, side: "BUY" });
  const fee = ex.execPrice * qty * FEE_RATE;

  state.learnStats.feePaid += fee;
  state.learnStats.spreadCost += ex.spreadCost * qty;
  state.learnStats.slippageCost += ex.slippageCost * qty;

  state.position = {
    symbol,
    side: "LONG",
    qty,
    entry: ex.execPrice,
    time: ts,
    feePaid: fee,
    entrySpread: ex.spreadCost,
    entrySlip: ex.slippageCost
  };

  state.trades.push({
    time: ts,
    symbol,
    type: "BUY",
    price: ex.execPrice,
    qty,
    fee,
    note: "paper_entry"
  });

  state.limits.tradesToday += 1;
  state.limits.lastTradeTs = ts;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(midPrice, ts) {
  const pos = state.position;
  if (!pos) return;

  const entry = pos.entry;
  const change = (midPrice - entry) / (entry || 1);

  const tp = TAKE_PROFIT_PCT;
  const sl = STOP_LOSS_PCT;

  if (change >= tp || change <= -sl) {
    // execution costs on SELL (worse fill)
    const ex = applyExecutionCosts({ price: midPrice, side: "SELL" });
    const fee = ex.execPrice * pos.qty * FEE_RATE;

    state.learnStats.feePaid += fee;
    state.learnStats.spreadCost += ex.spreadCost * pos.qty;
    state.learnStats.slippageCost += ex.slippageCost * pos.qty;

    const gross = (ex.execPrice - entry) * pos.qty;
    const net = gross - fee - (pos.feePaid || 0);

    state.balance += net;
    state.pnl += net;

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price: ex.execPrice,
      qty: pos.qty,
      profit: net,
      fee,
      note: change >= tp ? "take_profit" : "stop_loss"
    });

    state.position = null;
    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= tp ? "tp_hit" : "sl_hit";

    checkDrawdown();
  } else {
    state.learnStats.decision = "WAIT";
  }
}

// tick() supports both:
// tick(price)            legacy
// tick(symbol, price, ts)
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

  state.lastPriceBySymbol[symbol] = price;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = ts;

  pushBuf(symbol, price);

  // manage open position first
  maybeExit(price, ts);

  // then consider entry
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
    learnStats: state.learnStats,
    limits: state.limits,
    config: state.config,
  };
}

module.exports = { start, tick, snapshot };
