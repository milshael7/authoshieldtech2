// backend/src/routes/paper.routes.js
const express = require('express');
const router = express.Router();
const paperTrader = require('../services/paperTrader');

function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true;
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
    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Reset blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY).'
      });
    }
    paperTrader.hardReset();
    return res.json({ ok: true, message: 'Paper wallet reset complete.', snapshot: paperTrader.snapshot() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ NEW: owner config live update
// POST /api/paper/config   body: { baselinePct, maxPct, maxTradesPerDay }
router.post('/config', (req, res) => {
  try {
    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error: 'Config blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY).'
      });
    }

    const patch = req.body || {};
    const owner = paperTrader.setConfig({
      baselinePct: patch.baselinePct,
      maxPct: patch.maxPct,
      maxTradesPerDay: patch.maxTradesPerDay
    });

    return res.json({ ok: true, owner, snapshot: paperTrader.snapshot() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
