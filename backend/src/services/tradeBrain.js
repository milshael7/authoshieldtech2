// backend/src/services/tradeBrain.js
// ONE brain contract used for BOTH paper + live.
// Brain decides. Executors execute.

const aiBrain = require("./aiBrain"); // your existing brain

// Hard safety defaults (can be overridden by env)
const MIN_CONF = Number(process.env.TRADE_MIN_CONF || 0.62);
const MIN_EDGE = Number(process.env.TRADE_MIN_EDGE || 0.0007); // 0.07%
const MAX_TRADES_PER_DAY = Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);

// Mindset rules (owner preference) — stored once and reused
const MINDSET = {
  winIsSuccess: true,
  loseIsFailure: true,
  ruleFirst: true,
  message:
    "Winning is success. Losing is failure. The mission is to avoid losing. " +
    "Follow the rules before entering. If rules are not met, WAIT. " +
    "If you lose, treat it as a failure signal: learn, tighten filters, and do not repeat.",
};

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * makeDecision({symbol, mode, last, paper})
 * Returns a strict object that executors can use.
 */
function makeDecision(context) {
  const symbol = String(context?.symbol || "BTCUSDT");
  const last = safeNum(context?.last, NaN);

  const paper = context?.paper || {};
  const learn = paper.learnStats || {};
  const limits = paper.limits || {};
  const config = paper.config || {};

  // Pull the brain’s current “decision language”
  // (We use your aiBrain explanation engine to stay consistent with the UI.)
  const decision = String(learn.decision || "WAIT").toUpperCase();
  const confidence = safeNum(learn.confidence, 0);
  const edge = safeNum(learn.trendEdge, 0);
  const tradesToday = safeNum(limits.tradesToday, 0);
  const lossesToday = safeNum(limits.lossesToday, 0);

  // -------- HARD SAFETY GATES (same for paper + live) --------
  let action = decision;
  let blockedReason = "";

  if (!Number.isFinite(last)) {
    action = "WAIT";
    blockedReason = "Missing last price.";
  } else if (tradesToday >= MAX_TRADES_PER_DAY) {
    action = "WAIT";
    blockedReason = `Daily trade limit reached (${tradesToday}/${MAX_TRADES_PER_DAY}).`;
  } else if (confidence < MIN_CONF) {
    action = "WAIT";
    blockedReason = `Confidence too low (${confidence.toFixed(2)} < ${MIN_CONF}).`;
  } else if (Math.abs(edge) < MIN_EDGE) {
    action = "WAIT";
    blockedReason = `Edge too small (${edge.toFixed(6)} < ${MIN_EDGE}).`;
  }

  // If your paper trader already halts, respect it in BOTH modes
  if (limits.halted) {
    action = "WAIT";
    blockedReason = `Halted by safety stop: ${limits.haltReason || "unknown"}`;
  }

  // -------- Position sizing contract --------
  // Keep it simple now: use config.baselinePct/maxPct if present, else fixed tiny size.
  const baselinePct = safeNum(config.baselinePct, 0.01);
  const maxPct = safeNum(config.maxPct, 0.03);

  // If losing streak today, force baseline
  const riskPct = lossesToday >= 2 ? baselinePct : Math.min(maxPct, baselinePct * 2);

  // SL/TP placeholder: you’ll wire your real logic later
  const slPct = safeNum(config.slPct, 0.005); // 0.5%
  const tpPct = safeNum(config.tpPct, 0.010); // 1.0%

  const plan = {
    symbol,
    action, // WAIT | BUY | SELL | CLOSE
    confidence,
    edge,
    riskPct,
    slPct,
    tpPct,
    mindset: MINDSET, // stored here so UI + logs can display it
    blockedReason,
    ts: Date.now(),
  };

  return plan;
}

/**
 * explain(message, context)
 * Uses your aiBrain to produce the human-readable explanation for the UI.
 */
function explain(message, context) {
  return aiBrain.answer(message, context);
}

module.exports = { makeDecision, explain };
