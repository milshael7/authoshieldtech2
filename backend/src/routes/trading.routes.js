// backend/src/routes/trading.routes.js
const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const paperTrader = require("../services/paperTrader");
const tradeBrain = require("../services/tradeBrain");
const liveTrader = require("../services/liveTrader");

// --------------------------------------------------
// GET /api/trading/status
// Unified status for UI (paper + live)
// --------------------------------------------------
router.get("/status", authRequired, (req, res) => {
  try {
    const paper = paperTrader.snapshot();
    const live = liveTrader.snapshot();

    return res.json({
      ok: true,
      paper,
      live,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// --------------------------------------------------
// POST /api/trading/decide
// Brain-only decision (NO execution)
// Used by UI, paper trader, or diagnostics
// --------------------------------------------------
router.post("/decide", authRequired, (req, res) => {
  try {
    const { symbol } = req.body || {};
    const last = paperTrader.getLastPrice(symbol);

    const context = {
      symbol,
      last,
      paper: paperTrader.context(symbol),
    };

    const plan = tradeBrain.makeDecision(context);

    return res.json({
      ok: true,
      plan,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// --------------------------------------------------
// POST /api/trading/explain
// Natural-language explanation (AI reasoning)
// --------------------------------------------------
router.post("/explain", authRequired, async (req, res) => {
  try {
    const { message, context } = req.body || {};

    const explanation = await tradeBrain.explain(
      message || "Explain last trading decision.",
      context || {}
    );

    return res.json({
      ok: true,
      explanation,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// --------------------------------------------------
// POST /api/trading/signal
// Push a signal to LIVE trader (SAFE)
// NOTE: This does NOT execute trades unless env allows
// --------------------------------------------------
router.post("/signal", authRequired, async (req, res) => {
  try {
    const signal = req.body || {};

    const result = await liveTrader.pushSignal(signal);

    return res.json({
      ok: true,
      result,
    });
  } catch (e) {
    return res.status(400).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

module.exports = router;
