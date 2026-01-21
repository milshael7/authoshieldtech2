// backend/src/routes/ai.routes.js
// Uses the persistent AI Brain module for replies (no more repetitive dummy replies)

const express = require("express");
const router = express.Router();

const aiBrain = require("../services/aiBrain");

// Optional: if you want auth for AI, uncomment these lines
// const { authRequired } = require("../middleware/auth");

// POST /api/ai/chat
router.post("/chat", /* authRequired, */ (req, res) => {
  try {
    const { message, context } = req.body || {};
    const clean = String(message || "").trim();

    if (!clean) {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    const reply = aiBrain.answer(clean, context || {});
    return res.json({ ok: true, reply });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/ai/brain/status  (safe diagnostics)
router.get("/brain/status", /* authRequired, */ (req, res) => {
  try {
    return res.json(aiBrain.getSnapshot());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/ai/brain/reset  (ONLY if you want a reset button later)
// Keep disabled by default. If you enable it, add authRequired.
// router.post("/brain/reset", authRequired, (req, res) => {
//   aiBrain.resetBrain();
//   res.json({ ok: true, message: "Brain reset." });
// });

module.exports = router;
