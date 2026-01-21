// backend/src/routes/paper.routes.js
// Paper endpoints: status + hard reset
// Safe: reset is locked behind an optional admin key (recommended)

const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// OPTIONAL: simple protection so random users can’t reset your paper brain.
// Set env PAPER_RESET_KEY to something long. Then call:
// POST /api/paper/reset  with header:  x-reset-key: <your key>
function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || '').trim();
  if (!key) return true; // if you don't set it, reset is open (not recommended)
  const sent = String(req.headers['x-reset-key'] || '').trim();
  return sent && sent === key;
}

// GET /api/paper/status  -> same as the old /api/paper/status you already call
router.get('/status', (req, res) => {
  try {
    return res.json(paperTrader.snapshot());
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
