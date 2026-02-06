// backend/src/routes/trading.routes.js
const express = require("express");
const router = express.Router();

const { authRequired } = require("../middleware/auth");
const paperTrader = require("../services/paperTrader");
const liveTrader = require("../services/liveTrader");

/**
 * TRADING ROUTES
 *
 * Design rules:
 * - Routes are THIN
 * - NO mock market logic
 * - NO duplicated live state
 * - Decisions happen in tradeBrain
 * - Execution handled by paperTrader / liveTrader
 * - Live trading is SAFE by default
 */

// ---------- ROLE HELPERS ----------
function isAdmin(req) {
  return String(req?.user?.role || "").toLowerCase() === "admin";
}

function isManagerOrAdmin(req) {
  const r = String(req?.user?.role || "").toLowerCase();
  return r === "admin" || r === "manager";
}

// ---------- PUBLIC (NO AUTH) ----------

/**
 * GET /api/trading/symbols
 * Frontend helper only
 */
router.get("/symbols", (req, res) => {
  res.json({
    ok: true,
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
  });
});

// ---------- PROTECTED ----------
router.use(authRequired);

// ---------- PAPER TRADING ----------

/**
 * GET /api/trading/paper/snapshot
 * Admin + Manager
 */
router.get("/paper/snapshot", (req, res) => {
  if (!isManagerOrAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  return res.json({
    ok: true,
    snapshot: paperTrader.snapshot(),
  });
});

/**
 * POST /api/trading/paper/config
 * Admin only
 */
router.post("/paper/config", (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  const updated = paperTrader.setConfig(req.body || {});
  return res.json({ ok: true, config: updated });
});

/**
 * POST /api/trading/paper/reset
 * Admin only
 */
router.post("/paper/reset", (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  paperTrader.hardReset();
  return res.json({ ok: true });
});

// ---------- LIVE TRADING (SAFE) ----------

/**
 * GET /api/trading/live/snapshot
 * Admin + Manager
 */
router.get("/live/snapshot", (req, res) => {
  if (!isManagerOrAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  return res.json(liveTrader.snapshot());
});

/**
 * POST /api/trading/live/signal
 * Admin only
 *
 * Signals are:
 * - validated
 * - logged
 * - NEVER executed unless env + execution adapter allow it
 */
router.post("/live/signal", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  try {
    const result = await liveTrader.pushSignal(req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "Live signal error",
    });
  }
});

module.exports = router;
