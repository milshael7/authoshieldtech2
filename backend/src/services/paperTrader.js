// backend/src/services/paperTrader.js
// Step C1: learning stats exposed (proof-of-life)
// Compatible with:
// - tick(price)
// - tick(symbol, price, ts)
// - onTick(symbol, price, ts)

let state = {
  running: false,
  balance: Number(process.env.PAPER_START_BALANCE || 100000),
  pnl: 0,
  equity: Number(process.env.PAPER_START_BALANCE || 100000),
  trades: [],
  position: null,
  lastPrice: null,
  lastSymbol: "BTCUSDT",

  // learning knobs
  learn: {
    minTrendEdge: 0.0006,
    maxVol: 0.012,
    minVol: 0.0012,
    stopLossPct: 0.004,
    takeProfitPct: 0.006,
    cooldownSec: 20,
    riskPctPerTrade: 0.10,
    maxTradesPerHour: Number(process.env.PAPER_MAX_TRADES_PER_HOUR || 6),
  },

  // ✅ NEW: visible learning stats (this is what you asked for)
  learnStats: {
    startedAt: 0,
    ticksSeen: 0,
    warmupNeeded: 40,
    warmupLeft: 40,
    lastDecision: "idle",
    lastReason: "not_started",
    lastEdge: 0,
    lastVol: 0,
    confidence: 0,         // 0..100
    volatilityState: "idle" // flat_noise / normal / too_volatile
  },

  notes: [],
  _lastActionAt: 0,
  _tradeCountWindow: [],
};

const hist = {}; // symbol -> { prices: [], rets: [] }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v);
}
function sma(values, n) {
  if (values.length < n) return null;
  return mean(values.slice(values.length - n));
}

function note(text) {
  state.notes = (state.notes || []).slice(-40);
  state.notes.push({ time: Date.now(), text: String(text).slice(0, 240) });
}

function start() {
  state.running = true;
  state.balance = Number(process.env.PAPER_START_BALANCE || state.balance || 100000);
  state.equity = state.balance;
  state.pnl = 0;

  state._lastActionAt = 0;
  state._tradeCountWindow = [];

  state.learnStats.startedAt = Date.now();
  state.learnStats.ticksSeen = 0;
  state.learnStats.lastDecision = "learning";
  state.learnStats.lastReason = "started";
  state.learnStats.confidence = 0;

  note("Paper trader started (learning + stats).");
}

function stop() {
  state.running = false;
  state.learnStats.lastDecision = "stopped";
  state.learnStats.lastReason = "manual_stop";
  note("Paper trader stopped.");
}

function updateEquity(symbol, price) {
  let eq = state.balance;
  if (state.position && state.position.symbol === symbol) {
    const pos = state.position;
    const unreal = (price - pos.entryPrice) * pos.qty;
    eq += unreal;
  }
  state.equity = Number(eq.toFixed(2));
  const startBal = Number(process.env.PAPER_START_BALANCE || 100000);
  state.pnl = Number((state.equity - startBal).toFixed(2));
}

function canTradeNow(now) {
  const cooldown = state.learn.cooldownSec * 1000;
  if (now - (state._lastActionAt || 0) < cooldown) return false;

  const hourAgo = now - 60 * 60 * 1000;
  state._tradeCountWindow = (state._tradeCountWindow || []).filter(ts => ts >= hourAgo);
  if (state._tradeCountWindow.length >= state.learn.maxTradesPerHour) return false;

  return true;
}

function markTrade(now) {
  state._tradeCountWindow = (state._tradeCountWindow || []).slice(-200);
  state._tradeCountWindow.push(now);
}

function openLong(symbol, price, now, reason) {
  const riskPct = clamp(state.learn.riskPctPerTrade, 0.01, 0.5);
  const spend = state.balance * riskPct;
  const qty = spend / price;

  state.position = {
    symbol,
    entryPrice: price,
    qty,
    openedAt: now,
    reason,
    stopPrice: price * (1 - state.learn.stopLossPct),
    takePrice: price * (1 + state.learn.takeProfitPct),
  };

  state._lastActionAt = now;
  state.learnStats.lastDecision = "OPEN_LONG";
  state.learnStats.lastReason = reason;
  note(`OPEN LONG ${symbol} @ ${price.toFixed(2)} reason=${reason}`);
}

function closePosition(symbol, price, now, exitReason) {
  const pos = state.position;
  if (!pos || pos.symbol !== symbol) return;

  const profit = (price - pos.entryPrice) * pos.qty;
  state.balance = Number((state.balance + profit).toFixed(2));
  state.position = null;
  state._lastActionAt = now;

  const trade = {
    time: now,
    symbol,
    side: "LONG",
    entry: Number(pos.entryPrice.toFixed(2)),
    exit: Number(price.toFixed(2)),
    qty: Number(pos.qty.toFixed(8)),
    profit: Number(profit.toFixed(2)),
    durationSec: Math.max(1, Math.round((now - pos.openedAt) / 1000)),
    reason: pos.reason,
    exitReason,
  };

  state.trades = (state.trades || []).slice(-200);
  state.trades.push(trade);

  markTrade(now);

  state.learnStats.lastDecision = "CLOSE";
  state.learnStats.lastReason = exitReason;

  note(`CLOSE ${symbol} @ ${price.toFixed(2)} profit=${profit.toFixed(2)} exit=${exitReason}`);
}

function classifyVol(vol) {
  if (vol < state.learn.minVol) return "flat_noise";
  if (vol > state.learn.maxVol) return "too_volatile";
  return "normal";
}

function computeConfidence(edgeAbs, volState, warmupLeft) {
  // confidence rises as warmup completes + edge strengthens, but drops in bad volatility states
  const warmupFactor = clamp(1 - warmupLeft / state.learnStats.warmupNeeded, 0, 1);
  const edgeFactor = clamp(edgeAbs / (state.learn.minTrendEdge * 2), 0, 1);
  let base = (warmupFactor * 0.6 + edgeFactor * 0.4) * 100;

  if (volState === "flat_noise") base *= 0.55;
  if (volState === "too_volatile") base *= 0.35;

  return Math.round(clamp(base, 0, 100));
}

function decide(symbol, price, now) {
  const h = hist[symbol];
  if (!h || h.prices.length < state.learnStats.warmupNeeded) {
    const left = Math.max(0, state.learnStats.warmupNeeded - (h ? h.prices.length : 0));
    state.learnStats.warmupLeft = left;
    state.learnStats.lastDecision = "HOLD";
    state.learnStats.lastReason = "warming_up";
    state.learnStats.confidence = computeConfidence(0, "idle", left);
    return { action: "HOLD", reason: "warming_up" };
  }

  const maShort = sma(h.prices, 10);
  const maLong = sma(h.prices, 30);
  if (!maShort || !maLong) {
    state.learnStats.lastDecision = "HOLD";
    state.learnStats.lastReason = "warming_up";
    return { action: "HOLD", reason: "warming_up" };
  }

  const edge = (maShort - maLong) / maLong;     // signed
  const edgeAbs = Math.abs(edge);
  const vol = stdev(h.rets.slice(-25));

  const volState = classifyVol(vol);

  // update visible stats
  state.learnStats.lastEdge = Number(edge.toFixed(6));
  state.learnStats.lastVol = Number(vol.toFixed(6));
  state.learnStats.volatilityState = volState;
  state.learnStats.warmupLeft = 0;
  state.learnStats.confidence = computeConfidence(edgeAbs, volState, 0);

  // avoid dumb zones
  if (volState === "flat_noise") return { action: "HOLD", reason: "flat_noise" };
  if (volState === "too_volatile") return { action: "HOLD", reason: "too_volatile" };

  // manage position
  if (state.position && state.position.symbol === symbol) {
    const pos = state.position;
    if (price <= pos.stopPrice) return { action: "CLOSE", reason: "stop_loss" };
    if (price >= pos.takePrice) return { action: "CLOSE", reason: "take_profit" };
    if (edge < -state.learn.minTrendEdge * 0.6) return { action: "CLOSE", reason: "trend_flip" };
    return { action: "HOLD", reason: "manage_position" };
  }

  // entries
  if (!canTradeNow(now)) return { action: "HOLD", reason: "cooldown_or_limit" };

  if (edge > state.learn.minTrendEdge) return { action: "OPEN_LONG", reason: "trend_confirmed" };

  return { action: "HOLD", reason: "no_signal" };
}

// Main tick supports both signatures
function onTick(a, b, c) {
  const now = Number(c || Date.now());

  let symbol, price;
  if (typeof a === "string") {
    symbol = a;
    price = Number(b);
  } else {
    symbol = state.lastSymbol || "BTCUSDT";
    price = Number(a);
  }

  if (!Number.isFinite(price)) return;

  state.lastSymbol = symbol;
  state.lastPrice = price;

  if (!hist[symbol]) hist[symbol] = { prices: [], rets: [] };
  const h = hist[symbol];
  const prev = h.prices.length ? h.prices[h.prices.length - 1] : null;

  h.prices.push(price);
  if (prev) h.rets.push((price - prev) / prev);

  h.prices = h.prices.slice(-240);
  h.rets = h.rets.slice(-240);

  state.learnStats.ticksSeen += 1;

  updateEquity(symbol, price);

  if (!state.running) return;

  const d = decide(symbol, price, now);

  // expose decision even if it’s HOLD
  state.learnStats.lastDecision = d.action;
  state.learnStats.lastReason = d.reason;

  if (d.action === "OPEN_LONG") openLong(symbol, price, now, d.reason);
  if (d.action === "CLOSE") closePosition(symbol, price, now, d.reason);
}

function tick(priceOrSymbol, maybePrice, maybeTs) {
  return onTick(priceOrSymbol, maybePrice, maybeTs);
}

function snapshot() {
  return {
    running: state.running,
    balance: state.balance,
    equity: state.equity,
    pnl: state.pnl,
    trades: (state.trades || []).slice(-25),
    position: state.position,
    lastPrice: state.lastPrice,
    symbol: state.lastSymbol,

    learn: state.learn,
    learnStats: state.learnStats,
    notes: (state.notes || []).slice(-10),
  };
}

module.exports = { start, stop, tick, onTick, snapshot };
