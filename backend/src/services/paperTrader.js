// backend/src/services/paperTrader.js
// Paper trading engine + visible learning stats (confidence, ticks, decision reason)

const START_BAL = Number(process.env.PAPER_START_BALANCE || 100000);
const WARMUP_TICKS = Number(process.env.PAPER_WARMUP_TICKS || 200); // collect data before first trade
const RISK_PCT = Number(process.env.PAPER_RISK_PCT || 0.01); // 1% of balance per trade
const TAKE_PROFIT_PCT = Number(process.env.PAPER_TP_PCT || 0.004); // 0.4%
const STOP_LOSS_PCT = Number(process.env.PAPER_SL_PCT || 0.003); // 0.3%
const MIN_EDGE = Number(process.env.PAPER_MIN_TREND_EDGE || 0.0007); // trend threshold (0.07%)

let state = {
  running: false,
  balance: START_BAL,
  pnl: 0,
  trades: [],
  position: null, // {symbol, side:'LONG', qty, entry, time}
  lastPriceBySymbol: {},
  learnStats: {
    ticksSeen: 0,
    confidence: 0,         // 0..1
    volatility: 0,         // normalized
    trendEdge: 0,          // relative slope-ish
    decision: "WAIT",      // WAIT | BUY | SELL
    lastReason: "not_started",
    lastTickTs: null
  },
  // rolling price buffer per symbol
  buf: {
    BTCUSDT: [],
    ETHUSDT: []
  }
};

function resetMoney() {
  state.balance = Number(process.env.PAPER_START_BALANCE || START_BAL);
  state.pnl = 0;
  state.trades = [];
  state.position = null;
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

function pushBuf(symbol, price) {
  if (!state.buf[symbol]) state.buf[symbol] = [];
  const b = state.buf[symbol];
  b.push(price);
  while (b.length > 60) b.shift(); // last 60 ticks
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

  const vol = std(returns); // raw volatility
  const volNorm = clamp(vol / 0.002, 0, 1); // normalize (tuned for crypto)

  // simple trend edge: compare last vs early average
  const early = mean(b.slice(0, Math.floor(b.length / 3)));
  const late = mean(b.slice(Math.floor((2 * b.length) / 3)));
  const edge = (late - early) / (early || 1); // relative change

  // confidence: needs enough ticks + some trend + not too noisy
  const ticksFactor = clamp(state.learnStats.ticksSeen / WARMUP_TICKS, 0, 1);
  const trendFactor = clamp(Math.abs(edge) / (MIN_EDGE * 2), 0, 1);
  const noisePenalty = 1 - volNorm * 0.7;

  const conf = clamp(ticksFactor * 0.55 + trendFactor * 0.55, 0, 1) * clamp(noisePenalty, 0.2, 1);

  let reason = "waiting_warmup";
  if (state.learnStats.ticksSeen < WARMUP_TICKS) reason = "learning_warmup";
  else if (Math.abs(edge) < MIN_EDGE) reason = "trend_unclear";
  else if (volNorm > 0.85) reason = "too_noisy";
  else reason = "edge_detected";

  return { vol: volNorm, edge, conf, reason };
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

  // Enter LONG only (safe simple baseline)
  const riskDollars = state.balance * RISK_PCT;
  const qty = Math.max(0.00001, riskDollars / price);

  state.position = { symbol, side: "LONG", qty, entry: price, time: ts };
  state.trades.push({ time: ts, symbol, type: "BUY", price, qty, note: "paper_entry" });

  state.learnStats.decision = "BUY";
  state.learnStats.lastReason = "entered_long";
}

function maybeExit(price, ts) {
  const pos = state.position;
  if (!pos) return;

  const entry = pos.entry;
  const change = (price - entry) / entry;

  const tp = TAKE_PROFIT_PCT;
  const sl = STOP_LOSS_PCT;

  if (change >= tp || change <= -sl) {
    const profit = (price - entry) * pos.qty;
    state.balance += profit;
    state.pnl += profit;

    state.trades.push({
      time: ts,
      symbol: pos.symbol,
      type: "SELL",
      price,
      qty: pos.qty,
      profit,
      note: change >= tp ? "take_profit" : "stop_loss"
    });

    state.position = null;
    state.learnStats.decision = "SELL";
    state.learnStats.lastReason = change >= tp ? "tp_hit" : "sl_hit";
  } else {
    state.learnStats.decision = "WAIT";
  }
}

// ✅ main tick entry
// supports BOTH signatures:
// tick(price)                 (legacy)
// tick(symbol, price, ts)     (new)
function tick(a, b, c) {
  if (!state.running) return;

  let symbol, price, ts;

  if (typeof b === "undefined") {
    // legacy: tick(price)
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

  // update exit first (manage open risk)
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
    lastPrice: state.lastPriceBySymbol.BTCUSDT ?? null,
    lastPriceBySymbol: state.lastPriceBySymbol,
    learnStats: state.learnStats
  };
}

module.exports = { start, tick, snapshot };
