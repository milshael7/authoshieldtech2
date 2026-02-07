// backend/src/routes/ai.routes.js
// STEP 7 — AI explains trades in real time (event-driven, human voice)

const express = require("express");
const router = express.Router();

const { addMemory, listMemory } = require("../lib/brain");
const { traderEvents } = require("../services/paperTrader");

/* ================= INTERNAL MEMORY ================= */

let lastTradeEvent = null;

/* ================= LISTEN TO TRADER ================= */

traderEvents.on("ENTRY", (e) => {
  lastTradeEvent = {
    type: "ENTRY",
    time: new Date().toISOString(),
    ...e,
  };
});

traderEvents.on("EXIT", (e) => {
  lastTradeEvent = {
    type: "EXIT",
    time: new Date().toISOString(),
    ...e,
  };
});

traderEvents.on("HALT", (e) => {
  lastTradeEvent = {
    type: "HALT",
    time: new Date().toISOString(),
    ...e,
  };
});

/* ================= HELPERS ================= */

function cleanStr(v, max = 8000) {
  return String(v || "").trim().slice(0, max);
}

/* ================= CORE EXPLAINER ================= */

function explainLastTrade() {
  if (!lastTradeEvent) {
    return {
      reply: "No trades have happened yet. I’m currently observing the market.",
      speakText: "No trades have happened yet. I’m watching and waiting.",
    };
  }

  if (lastTradeEvent.type === "ENTRY") {
    return {
      reply:
        `I entered ${lastTradeEvent.symbol}.\n` +
        `• Entry price: $${lastTradeEvent.price.toFixed(2)}\n` +
        `• Confidence: ${Math.round(lastTradeEvent.confidence * 100)}%\n` +
        `• Reason: ${lastTradeEvent.reason}`,
      speakText:
        `I entered ${lastTradeEvent.symbol} because ${lastTradeEvent.reason}. ` +
        `Confidence was ${Math.round(lastTradeEvent.confidence * 100)} percent.`,
    };
  }

  if (lastTradeEvent.type === "EXIT") {
    return {
      reply:
        `I closed ${lastTradeEvent.symbol}.\n` +
        `• P&L: $${lastTradeEvent.pnl.toFixed(2)}\n` +
        `• Reason: ${lastTradeEvent.reason}`,
      speakText:
        `I closed the position with a result of ${lastTradeEvent.pnl.toFixed(
          2
        )} dollars. The reason was ${lastTradeEvent.reason}.`,
    };
  }

  if (lastTradeEvent.type === "HALT") {
    return {
      reply:
        `Trading was halted.\n` +
        `• Reason: ${lastTradeEvent.reason}\n` +
        `• Equity: $${lastTradeEvent.equity.toFixed(2)}`,
      speakText:
        `I halted trading due to ${lastTradeEvent.reason}.`,
    };
  }

  return {
    reply: "I’m not sure what just happened.",
    speakText: "I’m not sure what just happened.",
  };
}

/* ================= ROUTES ================= */

// POST /api/ai/chat
router.post("/chat", async (req, res) => {
  try {
    const message = cleanStr(req.body?.message, 8000).toLowerCase();

    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    // 👂 Natural language detection
    if (
      message.includes("why") ||
      message.includes("explain") ||
      message.includes("what happened") ||
      message.includes("last trade") ||
      message.includes("what did you do")
    ) {
      const out = explainLastTrade();
      return res.json({ ok: true, ...out });
    }

    // Fallback (general assistant)
    return res.json({
      ok: true,
      reply:
        "I’m monitoring the market in real time. You can ask me why I entered, exited, or what I’m waiting for.",
      speakText:
        "I’m monitoring the market in real time. Ask me about my last trade or decision.",
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "AI error",
    });
  }
});

/* ================= EXPORT ================= */

module.exports = router;
