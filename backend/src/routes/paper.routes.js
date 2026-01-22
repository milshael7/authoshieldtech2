// backend/src/routes/paper.routes.js
// Paper endpoints: status + reset + config
// - GET  /api/paper/status
// - POST /api/paper/reset
// - GET  /api/paper/config
// - POST /api/paper/config   (sets baselinePct, maxPct, maxTradesPerDay)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// OPTIONAL protection for reset/config
// Set env PAPER_RESET_KEY to something long.
// Then call POST endpoints with header: x-reset-key: <your key>
function writeAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true; // if not set, endpoints are open (not recommended)
  const sent = String(req.headers['x-reset-key'] || '').trim();
  return sent && sent === key;
}

// GET /api/paper/status
router.get('/status', (req, res) => {
  try {
    return res.json(paperTrader.snapshot());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/paper/reset
router.post('/reset', (req, res) => {
  try {
    if (!writeAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY on backend).'
      });
    }

    paperTrader.hardReset();
    return res.json({
      ok: true,
      message: 'Paper wallet reset complete.',
      snapshot: paperTrader.snapshot()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/paper/config  (read current owner controls)
router.get('/config', (req, res) => {
  try {
    const snap = paperTrader.snapshot();
    return res.json({
      ok: true,
      owner: snap.owner || null,
      sizing: snap.sizing || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/paper/config  (set owner controls live)
router.post('/config', (req, res) => {
  try {
    if (!writeAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY on backend).'
      });
    }

    if (typeof paperTrader.setConfig !== 'function') {
      return res.status(500).json({
        ok: false,
        error: 'paperTrader.setConfig() not found. Make sure your paperTrader.js exports setConfig.'
      });
    }

    const { baselinePct, maxPct, maxTradesPerDay } = req.body || {};
    const owner = paperTrader.setConfig({ baselinePct, maxPct, maxTradesPerDay });

    return res.json({
      ok: true,
      owner,
      snapshot: paperTrader.snapshot()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
