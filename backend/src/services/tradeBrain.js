// backend/src/services/tradeBrain.js
// ONE decision brain for BOTH paper + live trading.
// Brain decides. Executors execute. No exceptions.

const aiBrain = require("./aiBrain");

/* ---------------- SAFETY CONSTANTS ---------------- */
const MIN_CONF = Number(process.env.TRADE_MIN_CONF || 0.62);
const MIN_EDGE = Number(process.env.TRADE_MIN_EDGE || 0.0007); // 0.07%
const MAX_TRADES_PER_DAY = Number(process.env.TRADE_MAX_TRADES_PER_DAY || 12);

const ALLOWED_ACTIONS = new Set(["WAIT", "BUY", "SELL", "CLOSE"]);

/* ---------------- MINDSET (IMMUTABLE) ---------------- */
const MINDSET = Object.freeze({
  winIsSuccess: true,
  loseIsFailure: true,
  ruleFirst: true,
  message:
    "Winning is success. Losing is failure. The mission is to avoid losing. " +
    "Rules come before entries. If rules are not met, WAIT. " +
    "Losses are failure signals: learn, tighten filters, and do not repeat.",
});

/* ---------------- HELPERS ---------------- */
function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ---------------- CORE DECISION ---------------- */
function makeDecision(context = {}) {
  const symbol = String(context.symbol || "BTCUSDT");
  const last = safeNum(context.last, NaN);

  const paper = context.paper || {};
  const learn = paper.learnStats || {};
  const limits = paper.limits || {};
  const config = paper.config || {};

  /* -------- AI INPUT (OPTIONAL, NEVER TRUSTED BLINDLY) -------- */
  let aiView = {};
  try {
    if (typeof aiBrain.decide === "function") {
      aiView = aiBrain.decide({ symbol, last, paper }) || {};
    }
  } catch {
    aiView = {};
  }

  const proposedAction = String(
    aiView.action ?? learn.decision ?? "WAIT"
  ).toUpperCase();

  const baseAction = ALLOWED_ACTIONS.has(proposedAction)
    ? proposedAction
    : "WAIT";

  const confidence = safeNum(
    aiView.confidence ?? learn.confidence,
    0
  );

  const edge = safeNum(
    aiView.edge ?? learn.trendEdge,
    0
  );

  const tradesToday = safeNum(limits.tradesToday, 0);
  const lossesToday = safeNum(limits.lossesToday, 0);

  let action = baseAction;
  let blockedReason = "";

  /* ---------------- HARD SAFETY GATES ---------------- */
  if (!Number.isFinite(last)) {
    action = "WAIT";
    blockedReason = "Missing last price.";
  } else if (limits.halted) {
    action = "WAIT";
    blockedReason = `Halted: ${limits.haltReason || "safety stop"}`;
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

  /* ---------------- RISK MODEL ---------------- */
  const baselinePct = clamp(
    safeNum(config.baselinePct, 0.01),
    0.001,
    0.02
  );

  const maxPct = clamp(
    safeNum(config.maxPct, 0.03),
    baselinePct,
    0.05
  );

  const riskPct =
    lossesToday >= 2
      ? baselinePct
      : clamp(baselinePct * 2, baselinePct, maxPct);

  const slPct = clamp(
    safeNum(config.slPct, 0.005),
    0.002,
    0.02
  );

  const tpPct = clamp(
    safeNum(config.tpPct, 0.01),
    slPct,
    0.05
  );

  /* ---------------- FINAL PLAN ---------------- */
  return {
    symbol,
    action,
    confidence: action === "WAIT" ? 0 : confidence,
    edge: action === "WAIT" ? 0 : edge,
    riskPct,
    slPct,
    tpPct,
    mindset: MINDSET,
    blockedReason,
    ts: Date.now(),
  };
}

/* ---------------- EXPLAIN ---------------- */
function explain(message, context) {
  try {
    if (typeof aiBrain.answer === "function") {
      return aiBrain.answer(message, context);
    }
  } catch {}
  return "AI explanation unavailable.";
}

module.exports = {
  makeDecision,
  explain,
};
