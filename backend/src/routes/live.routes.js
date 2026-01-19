// backend/src/routes/live.routes.js
const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/auth');
const { getBalance, getOpenOrders, liveConfig } = require('../services/krakenPrivate');

// ------------------------------------------------------------
// Stage C: Live trading control plane (SAFE by default)
// - status is PUBLIC (so UI can show readiness)
// - any state-changing endpoint requires authRequired
// - orders are blocked unless: enabled && armed
// - dryRun defaults true (no real orders)
// ------------------------------------------------------------

// In-memory runtime toggles (survive until redeploy).
// For permanent behavior, set env vars in Render.
const runtime = {
  enabled: null, // null => use env
  dryRun: null,  // null => use env
  armed: false,  // extra safety gate
};

function boolish(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').toLowerCase().trim();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function effectiveConfig() {
  const env = liveConfig(); // { enabled, dryRun } from env
  const enabled = runtime.enabled === null ? !!env.enabled : !!runtime.enabled;
  const dryRun = runtime.dryRun === null ? !!env.dryRun : !!runtime.dryRun;

  // Optional env support if you want it:
  // LIVE_TRADING_ARMED=true (still can be overridden by runtime arm/disarm)
  const envArmed = boolish(process.env.LIVE_TRADING_ARMED, false);
  const armed = !!runtime.armed || envArmed;

  return { enabled, dryRun, armed };
}

// PUBLIC: readiness + control state (safe summary)
router.get('/status', async (req, res) => {
  const cfg = effectiveConfig();

  // We test keys by calling a private endpoint. If keys are missing/wrong, it will throw.
  try {
    await getBalance();
    return res.json({
      ok: true,
      exchange: 'kraken',
      keysPresent: true,
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      armed: cfg.armed,
      note: cfg.enabled
        ? (cfg.armed
            ? (cfg.dryRun ? 'READY (ARMED + DRY-RUN: no real orders)' : 'DANGER: ARMED + REAL ORDERS')
            : 'ENABLED but NOT ARMED (orders blocked)')
        : 'LOCKED (LIVE_TRADING disabled)',
    });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      exchange: 'kraken',
      keysPresent: false,
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      armed: cfg.armed,
      note: 'Keys missing/invalid or Kraken private API not reachable.',
      error: e?.message || String(e),
    });
  }
});

// PROTECTED: balances (safe but private)
router.get('/balances', authRequired, async (req, res) => {
  try {
    const bal = await getBalance();
    res.json({ ok: true, balances: bal });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// PROTECTED: open orders (private)
router.get('/open-orders', authRequired, async (req, res) => {
  try {
    const oo = await getOpenOrders();
    res.json({ ok: true, openOrders: oo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// PROTECTED: toggle enabled/disabled
router.post('/mode', authRequired, async (req, res) => {
  const enabled = boolish(req.body?.enabled, null);
  if (enabled === null) {
    return res.status(400).json({ ok: false, error: 'Body must include { enabled: true|false }' });
  }
  runtime.enabled = enabled;
  const cfg = effectiveConfig();
  return res.json({ ok: true, message: `Live enabled=${cfg.enabled}`, enabled: cfg.enabled, dryRun: cfg.dryRun, armed: cfg.armed });
});

// PROTECTED: toggle dry-run
router.post('/dryrun', authRequired, async (req, res) => {
  const dryRun = boolish(req.body?.dryRun, null);
  if (dryRun === null) {
    return res.status(400).json({ ok: false, error: 'Body must include { dryRun: true|false }' });
  }
  runtime.dryRun = dryRun;
  const cfg = effectiveConfig();
  return res.json({ ok: true, message: `Dry-run=${cfg.dryRun}`, enabled: cfg.enabled, dryRun: cfg.dryRun, armed: cfg.armed });
});

// PROTECTED: arm/disarm (extra safety gate)
router.post('/arm', authRequired, async (req, res) => {
  const armed = boolish(req.body?.armed, null);
  if (armed === null) {
    return res.status(400).json({ ok: false, error: 'Body must include { armed: true|false }' });
  }
  runtime.armed = armed;
  const cfg = effectiveConfig();
  return res.json({ ok: true, message: `Armed=${cfg.armed}`, enabled: cfg.enabled, dryRun: cfg.dryRun, armed: cfg.armed });
});

// PROTECTED: place order endpoint (SAFE)
// - requires enabled && armed
// - dryRun returns "wouldPlace" (no real order)
// - real order placement still NOT implemented (hard stop)
router.post('/order', authRequired, async (req, res) => {
  const cfg = effectiveConfig();
  const { symbol, side, usd } = req.body || {};

  if (!cfg.enabled) {
    return res.status(403).json({ ok: false, error: 'Live trading is disabled. Enable it first.' });
  }

  if (!cfg.armed) {
    return res.status(403).json({ ok: false, error: 'Live trading is NOT ARMED. Arm it first (extra safety).' });
  }

  const usdNum = Number(usd);
  if (!symbol || !side || !Number.isFinite(usdNum) || usdNum <= 0) {
    return res.status(400).json({ ok: false, error: 'Missing/invalid body. Expect { symbol, side, usd }' });
  }

  // Optional safety cap using the same env style you already use elsewhere
  const maxUsd = Number(process.env.LIVE_MAX_USD_PER_TRADE || process.env.PAPER_MAX_USD_PER_TRADE || 300);
  if (usdNum > maxUsd) {
    return res.status(400).json({ ok: false, error: `usd exceeds limit. Max is ${maxUsd}` });
  }

  if (cfg.dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      wouldPlace: { symbol, side, usd: usdNum },
      note: 'Dry-run only. No real order was placed.'
    });
  }

  // Hard stop until we wire Kraken AddOrder safely (with pair mapping + volume rules)
  return res.status(501).json({
    ok: false,
    error: 'Real order placement not implemented yet. Keep LIVE_TRADE_DRY_RUN=true for now.'
  });
});

module.exports = router;
