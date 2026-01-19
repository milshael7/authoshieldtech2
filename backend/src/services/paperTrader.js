// backend/src/services/paperTrader.js
// Paper trading engine + visible learning stats (confidence, ticks, decision reason)
// Now supports MANY symbols dynamically.

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 250);

const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01);
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004);
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003);
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007);

const FEE_RATE = Number(process.env.PAPER_FEE_RATE || 0.0026);     // realism
const SLIPPAGE_BP = Number(process.env.PAPER_SLIPPAGE_BP || 8);
const SPREAD_BP = Number(process.env.PAPER_SPREAD_BP || 6);
const COOLDOWN_MS = Number(process.env.PAPER_COOLDOWN_MS || 12000);

const MAX_USD_PER_TRADE = Number(process.env.PAPER_MAX_USD_PER_TRADE || 300);
const MAX_TRADES_PER_DAY = Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40);
const MAX_DRAWDOWN_PCT = Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25);

let state = {
  running: false,
  startBalance: START_BAL,
  balance: START_BAL,
  pnl: 0,
  trades: [],
  position: null, // {symbol, side:'LONG', qty, entry, time}
  lastPriceBySymbol: {},
  buf: {},

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
    dayKey: dayKey(),
    lastTradeTs: 0,
    halted: false,
    haltReason: null,
  }
};

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function resetDayIfNeeded(ts) {
  const k = dayKey(ts);
  if (state.limits.dayKey !== k) {
    state.limits.dayKey = k;
    state.limits.tradesToday = 0;
    state.limits.lastTradeTs = 0;
    state.limits.halted = false;
    state.limits.haltReason = null;
  }
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
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
    const r = (b[i] - b[i - 1]) / (b[i - 1] || 1);
    returns.push(r);
  }

  const vol = std(returns);
  const volNorm = clamp(vol / 0.002, 0, 1);

  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late  = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1);

  const ticksFactor = clamp(state.learnStats.ticksSeen / WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf = clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "learning_warmup";
  if (state.learnStats.ticksSeen >= WARMUP_TICKS && Math.abs(edge) < MIN_EDGE) reason = "trend_unclear";
  else if (state.learnStats.ticksSeen >= WARMUP_TICKS && volNorm > 0.85) reason = "too_noisy";
  else if (state.learnStats.ticksSeen >= WARMUP_TICKS) reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
}

function applyCosts(usdNotional) {
  const fee = usdNotional * FEE_RATE;
  const slip = usdNotional * (SLIPPAGE_BP / 10000);
  const sprd = usdNotional * (SPREAD_BP / 10000);

  state.learnStats.feePaid += fee;
  state.learnStats.slippageCost += slip;
  state.learnStats.spreadCost += sprd;

  return fee + slip + sprd;
}

function canTrade(ts) {
  resetDayIfNeeded(ts);

  if (state.limits.halted) return { ok:false, reason: state.limits.haltReason || "halted" };
  if (state.limits.tradesToday >= MAX_TRADES_PER_DAY) return { ok:false, reason:"max_trades_per_day" };
  if (ts - (state.limits.lastTradeTs || 0) < COOLDOWN_MS) return { ok:false, reason:"cooldown" };

  const dd = (state.startBalance - state.balance) / (state.startBalance || 1);
  if (dd >= MAX_DRAWDOWN_PCT) {
    state.limits.halted = true;
    state.limits.haltReason = "max_drawdown_halt";
    return { ok:false, reason:"max_drawdown_halt" };
  }

  return { ok:true, reason:"ok" };
}

function maybeEnter(symbol, price, ts) {
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

  const lim = canTrade(ts);
  if (!lim.ok) {
    state.learnStats.decision = "WAIT";
    state.learnStats.lastReason = lim.reason;
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

  // ✅ Notional is capped (realism)
  const usdNotional = Math.min(MAX_USD_PER_TRADE, state.balance * RISK_PCT);
  const qty = Math.max(0.000001, usdNotional / price);

  // apply entry costs
  const costs = applyCosts(usdNotional);
  state.balance -= costs;
  state.pnl -= costs;

  state.position = { symbol, side: "LONG", qty, entry: price, time: ts };
  state.trades.push({ time: ts, symbol, type: "BUY", price, qty, note: "paper_entry", costs });

  state.limits.tradesToday += 1;
  state.limits.lastTradeTs = ts;

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(symbol, price, ts) {
  const pos = state.position;
  if (!pos) return;
  if (pos.symbol !== symbol) return;

  const entry = pos.entry;
  const change = (price - entry) / (entry || 1);

  if (change >= TAKE_PROFIT_PCT || change <= -STOP_LOSS_PCT) {
    const gross = (price - entry) * pos.qty;

    const usdNotional = Math.min(MAX_USD_PER_TRADE, pos.qty * price);
    const costs = applyCosts(usdNotional);

    const net = gross - costs;

    state.balance += net;
    state.pnl += net;

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price,
      qty: pos.qty,
      profit: net,
      note: change >= TAKE_PROFIT_PCT ? "take_profit" : "stop_loss",
      costs
    });

    state.position = null;
    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= TAKE_PROFIT_PCT ? "tp_hit" : "sl_hit";
  } else {
    state.learnStats.decision = "WAIT";
  }
}

function start() {
  state.running = true;
  state.startBalance = Number(process.env.PAPER_START_BALANCE || START_BAL);
  state.balance = state.startBalance;
  state.pnl = 0;
  state.trades = [];
  state.position = null;
  state.lastPriceBySymbol = {};
  state.buf = {};

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
    dayKey: dayKey(),
    lastTradeTs: 0,
    halted: false,
    haltReason: null,
  };
}

// tick(symbol, price, ts)
function tick(symbol, price, ts = Date.now()) {
  if (!state.running) return;

  const sym = String(symbol || "BTCUSDT");
  const p = Number(price);
  const t = Number(ts || Date.now());
  if (!Number.isFinite(p)) return;

  resetDayIfNeeded(t);

  state.lastPriceBySymbol[sym] = p;
  state.learnStats.ticksSeen += 1;
  state.learnStats.lastTickTs = t;

  pushBuf(sym, p);

  // manage exit first then entry
  maybeExit(sym, p, t);
  maybeEnter(sym, p, t);
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
      START_BAL: state.startBalance,
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
    }
  };
}

module.exports = { start, tick, snapshot };
