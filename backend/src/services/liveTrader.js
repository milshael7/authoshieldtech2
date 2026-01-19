// backend/src/services/liveTrader.js
// Live trading engine (SAFE: disabled by default)
// Stage C1: scaffolding only — no real orders yet.

const START_BAL = Number(process.env.LIVE_START_BALANCE || 0);

// Hard gate (must be explicitly enabled in env to do anything)
function isEnabled() {
  const v = String(process.env.LIVE_TRADING_ENABLED || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes";
}

let state = {
  running: false,
  enabled: false,
  mode: "live-disabled",
  lastPriceBySymbol: {},
  // live will NOT track paper-like balance/pnl; exchange is source of truth later
  stats: {
    ticksSeen: 0,
    lastTickTs: null,
    lastReason: "not_started",
  },
  // placeholder for later
  orders: [],
  lastError: null,
};

function start() {
  state.running = true;
  state.enabled = isEnabled();
  state.mode = state.enabled ? "live-armed" : "live-disabled";
  state.stats.lastReason = state.enabled ? "armed_waiting_for_stage_c2" : "disabled_by_env";
  state.lastError = null;
}

function refreshEnabledFlag() {
  state.enabled = isEnabled();
  state.mode = state.enabled ? "live-armed" : "live-disabled";
  if (!state.enabled) state.stats.lastReason = "disabled_by_env";
}

function tick(symbol, price, ts) {
  if (!state.running) return;

  const sym = String(symbol || "BTCUSDT");
  const p = Number(price);
  const t = Number(ts || Date.now());
  if (!Number.isFinite(p)) return;

  state.lastPriceBySymbol[sym] = p;
  state.stats.ticksSeen += 1;
  state.stats.lastTickTs = t;

  // Stage C1: do NOT place real orders.
  // We only confirm the engine is receiving ticks and respecting the enable gate.
  if (!state.enabled) {
    state.stats.lastReason = "disabled_by_env";
    return;
  }

  // Still no orders in C1 — we just show "armed"
  state.stats.lastReason = "armed_waiting_for_exchange_adapter";
}

function snapshot() {
  refreshEnabledFlag();
  return {
    ok: true,
    running: state.running,
    enabled: state.enabled,
    mode: state.mode,
    lastPriceBySymbol: state.lastPriceBySymbol,
    stats: state.stats,
    orders: state.orders.slice(-50),
    lastError: state.lastError,
    config: {
      LIVE_TRADING_ENABLED: state.enabled,
      LIVE_START_BALANCE: START_BAL,
      NOTE: "Stage C1 only. No exchange adapter yet; no real orders will be placed.",
    },
  };
}

module.exports = { start, tick, snapshot };
