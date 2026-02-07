// backend/src/routes/paper.routes.js
// Paper endpoints: status + reset + config (SAFE + ENGINE-ALIGNED)
// ✔ FULL DROP-IN REPLACEMENT
// ✔ Matches current paperTrader implementation (Step 10)
// ✔ No phantom methods, no crashes
// ✔ Frontend-safe response shapes

const express = require("express");
const router = express.Router();

const paperTrader = require("../services/paperTrader");

/* ================= KEY GATES ================= */
// If a key is NOT set, the action is OPEN (not recommended).

function resetAllowed(req) {
  const key = String(process.env.PAPER_RESET_KEY || "").trim();
  if (!key) return true;
  const sent = String(req.headers["x-reset-key"] || "").trim();
  return !!sent && sent === key;
}

/* ================= ROUTES ================= */

// GET /api/paper/status
router.get("/status", (req, res) => {
  try {
    return res.json({
      ok: true,
      snapshot: paperTrader.snapshot(),
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// POST /api/paper/reset
router.post("/reset", (req, res) => {
  try {
    if (!resetAllowed(req)) {
      return res.status(403).json({
        ok: false,
        error:
          "Reset blocked. Missing/invalid x-reset-key (set PAPER_RESET_KEY).",
      });
    }

    paperTrader.hardReset();

    return res.json({
      ok: true,
      message: "Paper trader reset complete.",
      snapshot: paperTrader.snapshot(),
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

/* ================= CONFIG (READ-ONLY) ================= */
/*
  IMPORTANT:
  The current paperTrader engine (Step 10) does NOT support
  runtime config mutation. All values are ENV-driven.

  This endpoint exists so the frontend can READ limits
  without breaking, not to modify them.
*/

// GET /api/paper/config
router.get("/config", (req, res) => {
  try {
    const snap = paperTrader.snapshot();

    const config = {
      startBalance: Number(process.env.PAPER_START_BALANCE || 100000),
      warmupTicks: Number(process.env.PAPER_WARMUP_TICKS || 250),

      feeRate: Number(process.env.PAPER_FEE_RATE || 0.0026),
      slippageBp: Number(process.env.PAPER_SLIPPAGE_BP || 8),
      spreadBp: Number(process.env.PAPER_SPREAD_BP || 6),

      cooldownMs: Number(process.env.PAPER_COOLDOWN_MS || 12000),
      maxTradesPerDay: Number(process.env.PAPER_MAX_TRADES_PER_DAY || 40),
      maxDrawdownPct: Number(process.env.PAPER_MAX_DRAWDOWN_PCT || 0.25),
    };

    return res.json({
      ok: true,
      config,          // ✅ frontend-friendly
      owner: config,   // ✅ backward compatible
      limits: snap.limits || {},
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// POST /api/paper/config
// ❌ Disabled intentionally (engine does not support it yet)
router.post("/config", (req, res) => {
  return res.status(409).json({
    ok: false,
    error:
      "Runtime config updates are not supported. Set PAPER_* env variables and restart the server.",
  });
});

module.exports = router;
