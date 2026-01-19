// backend/src/routes/live.routes.js
const express = require('express');
const router = express.Router();

const { getBalance, getOpenOrders, liveConfig } = require('../services/krakenPrivate');

// Health / readiness: confirms keys exist + can hit Kraken private endpoint
router.get('/status', async (req, res) => {
  const cfg = liveConfig();

  try {
    // If keys are wrong, this will throw
    await getBalance();

    return res.json({
      ok: true,
      exchange: 'kraken',
      keys: 'ok',
      liveTradingEnabled: cfg.enabled,
      dryRun: cfg.dryRun,
      note: cfg.enabled
        ? (cfg.dryRun ? 'READY (ARMED but DRY-RUN: no real orders)' : 'WARNING: REAL ORDERS ENABLED')
        : 'READY (LOCKED: cannot place orders)'
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      exchange: 'kraken',
      keys: 'error',
      error: e?.message || String(e)
    });
  }
});

// Read balances (safe)
router.get('/balances', async (req, res) => {
  try {
    const bal = await getBalance();
    res.json({ ok: true, balances: bal });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Read open orders (safe)
router.get('/open-orders', async (req, res) => {
  try {
    const oo = await getOpenOrders();
    res.json({ ok: true, openOrders: oo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Place order endpoint (LOCKED by default + DRY-RUN default)
// Right now: returns what it WOULD do.
// Later, we’ll wire real Kraken AddOrder when you decide.
router.post('/order', async (req, res) => {
  const cfg = liveConfig();
  const { symbol, side, usd } = req.body || {};

  if (!cfg.enabled) {
    return res.status(403).json({ ok: false, error: 'LIVE_TRADING_ENABLED is false (locked).' });
  }

  if (cfg.dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      wouldPlace: { symbol, side, usd },
      note: 'Dry-run only. No real order was placed.'
    });
  }

  // If you ever flip dryRun to false, we still hard-stop here until we implement AddOrder safely.
  return res.status(501).json({
    ok: false,
    error: 'Real order placement not implemented yet. Keep LIVE_TRADE_DRY_RUN=true.'
  });
});

module.exports = router;
