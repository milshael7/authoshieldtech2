// backend/src/routes/paper.routes.js
const express = require('express');
const router = express.Router();

const paperTrader = require('../services/paperTrader');

// GET status
router.get('/status', (req, res) => {
  try {
    res.json(paperTrader.snapshot());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST reset
router.post('/reset', (req, res) => {
  paperTrader.hardReset();
  res.json({ ok: true });
});

// POST owner config
router.post('/config', (req, res) => {
  const cfg = paperTrader.setConfig(req.body || {});
  res.json({ ok: true, owner: cfg });
});

module.exports = router;
