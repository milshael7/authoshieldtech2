// backend/src/routes/paper.routes.js
// Paper endpoints: status + config + hard reset
// Safe: reset/config can be locked behind optional admin keys (recommended)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// Optional protection so random users can’t reset/config your paper brain.
// If you set these env vars, requests must include headers:
//  - x-reset-key: <PAPER_RESET_KEY>
//  - x-config-key: <PAPER_CONFIG_KEY>
function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true;
  const sent = String(req.headers['x-reset-key'] || '').trim();
  return sent && sent === key;
}

function configAllowed(req) {
  const key = String(process.env.PAPER_CONFIG_KEY || '').trim();
  if (!key) return true;
  const sent = String(req.headers['x-config-key'] || '').trim();
  return sent && sent === key;
}

// GET /api/paper/status -> snapshot (what your frontend already polls)
router.get('/status', (req, res) => {
  try {
    return res.json(paperTrader.snapshot());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/paper/config -> just the owner config + sizing + forceBaseline flag
router.get('/config', (req, res) => {
  try {
    const snap = paperTrader.snapshot();
    return res.json({
      ok: true,
      owner: snap.owner || null,
      sizing: snap.sizing || null,
      forceBaseline: snap.limits?.forceBaseline || false,
      lossesToday: snap.limits?.lossesToday || 0,
      tradesToday: snap.limits?.tradesToday || 0,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/paper/config -> update baselinePct/maxPct/maxTradesPerDay live
// Body: { baselinePct: 0.03, maxPct: 0.25, maxTradesPerDay: 40 }
router.post('/config', (req, res) => {
  try {
    if (!configAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Config blocked. Missing/invalid x-config-key (set PAPER_CONFIG_KEY on backend).'
      });
    }

    if (typeof paperTrader.setConfig !== 'function') {
      return res.status(500).json({
        ok: false,
        error: 'paperTrader.setConfig() not found. Make sure your paperTrader.js exports setConfig.'
      });
    }

    const patch = {
      baselinePct: req.body?.baselinePct,
      maxPct: req.body?.maxPct,
      maxTradesPerDay: req.body?.maxTradesPerDay
    };

    const owner = paperTrader.setConfig(patch);
    return res.json({
      ok: true,
      message: 'Paper config updated.',
      owner,
      snapshot: paperTrader.snapshot()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/paper/reset -> wipe paper wallet + trades + learning buffers (paper only)
router.post('/reset', (req, res) => {
  try {
    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Reset blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY on backend).'
      });
    }

    paperTrader.hardReset();
    return res.json({
      ok: true,
      message: 'Paper wallet reset complete.',
      stateFile: process.env.PAPER_STATE_PATH || '(default from paperTrader)',
      snapshot: paperTrader.snapshot()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
