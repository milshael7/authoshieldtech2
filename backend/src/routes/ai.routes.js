// backend/src/routes/ai.routes.js
// AutoShield AI Routes — Voice + Memory + Personality
// FULL DROP-IN FILE (Step 9)
// - Uses lib/brain personality + memory
// - Non-robotic responses
// - Real-time trading explanations
// - Backward compatible: { ok, reply, speakText }

const express = require("express");
const router = express.Router();

const {
  addMemory,
  listMemory,
  buildPersonality,
} = require("../lib/brain");

/* ================= HELPERS ================= */

function cleanStr(v, max = 8000) {
  return String(v ?? "").trim().slice(0, max);
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function hasOwnerAccess(req) {
  const key = cleanStr(process.env.AI_OWNER_KEY, 200);
  if (!key) return true;
  const sent = cleanStr(req.headers["x-owner-key"], 200);
  return !!sent && sent === key;
}

/* ================= CONTEXT NORMALIZATION ================= */

function summarizeTradingContext(context) {
  const p = context?.paper || {};

  return {
    platform: context?.platform || "AutoShield",
    room: context?.room || "TradingRoom",

    mode: cleanStr(context?.trading_mode || context?.mode, 20) || "—",
    tradeStyle: cleanStr(context?.trade_style, 20) || "—",

    risk: context?.risk || {},

    stats: context?.stats || {},

    paper: {
      running: !!p.running,
      equity: Number(p.equity ?? p.cashBalance ?? 0),
      pnl: Number(p.realized?.net ?? p.pnl ?? 0),
      unrealized: Number(p.unrealizedPnL ?? 0),
      wins: Number(p.realized?.wins ?? 0),
      losses: Number(p.realized?.losses ?? 0),
      decision: cleanStr(p.learnStats?.decision || p.decision, 40) || "WAIT",
      confidence: Number(p.learnStats?.confidence ?? p.confidence ?? 0),
      reason: cleanStr(p.learnStats?.lastReason || p.decisionReason, 300) || "—",
      position: p.position || null,
    },
  };
}

/* ================= LOCAL INTELLIGENCE (NO OPENAI) ================= */

function localReply(message, context) {
  const snap = summarizeTradingContext(context);
  const low = message.toLowerCase();

  // Status / Explain
  if (
    low.includes("explain") ||
    low.includes("status") ||
    low.includes("what") ||
    low.includes("summary")
  ) {
    const lines = [
      `Here’s what’s happening right now.`,
      `Mode: ${snap.mode} • Style: ${snap.tradeStyle}`,
      `P&L: $${snap.paper.pnl.toFixed(2)} (Unrealized $${snap.paper.unrealized.toFixed(2)})`,
      `Wins / Losses: ${snap.paper.wins} / ${snap.paper.losses}`,
      `Current decision: ${snap.paper.decision} (${Math.round(
        snap.paper.confidence * 100
      )}% confidence)`,
      `Reason: ${snap.paper.reason}`,
    ];

    if (snap.paper.position) {
      lines.push(
        `Open position: ${snap.paper.position.symbol} @ ${snap.paper.position.entry}`
      );
    } else {
      lines.push(`No open position right now.`);
    }

    return {
      reply: lines.join("\n"),
      speakText: lines.join(". "),
      meta: { kind: "local_dashboard" },
    };
  }

  // Why trade?
  if (low.includes("why")) {
    return {
      reply: `Here’s why.\nDecision: ${snap.paper.decision}\nConfidence: ${Math.round(
        snap.paper.confidence * 100
      )}%\nReason: ${snap.paper.reason}`,
      speakText: `Here’s why. ${snap.paper.reason}`,
      meta: { kind: "local_reason" },
    };
  }

  return {
    reply:
      "You can ask me what’s happening, why a trade happened, or what I’m waiting for.",
    speakText:
      "You can ask me what’s happening, why a trade happened, or what I’m waiting for.",
    meta: { kind: "local_help" },
  };
}

/* ================= OPENAI (OPTIONAL) ================= */

async function openaiReply(message, context) {
  const apiKey = cleanStr(process.env.OPENAI_API_KEY, 200);
  if (!apiKey) return null;

  const model =
    cleanStr(process.env.OPENAI_CHAT_MODEL, 60) || "gpt-4o-mini";

  const snap = summarizeTradingContext(context);
  const personality = buildPersonality();
  const memory = listMemory({ limit: 30 });

  const system = `
You are ${personality.identity}, the AI voice of a live trading platform.

Tone:
${personality.tone}

Rules:
- Speak naturally, like a human operator.
- Explain trades ONLY using the provided snapshot.
- Never hallucinate missing data.
- Keep responses clear, confident, and calm.
- Provide a spoken version (speakText) that sounds natural aloud.

Known platform facts:
${personality.platformFacts.join("\n")}

Preferences:
${personality.preferences.join("\n")}

Hard rules:
${personality.rules.join("\n")}
`;

  const user = `
User said:
${message}

Live snapshot:
${JSON.stringify(snap, null, 2)}

Recent memory:
${memory.map((m) => `- (${m.type}) ${m.text}`).join("\n")}

Respond ONLY with JSON:
{
  "reply": "...",
  "speakText": "..."
}
`;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);

  const data = await r.json();
  const raw = data?.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);

  return {
    reply: cleanStr(parsed.reply, 12000),
    speakText: cleanStr(parsed.speakText || parsed.reply, 12000),
    meta: { kind: "openai", model },
  };
}

/* ================= ROUTES ================= */

// POST /api/ai/chat
router.post("/chat", async (req, res) => {
  try {
    const message = cleanStr(req.body?.message, 8000);
    const context = req.body?.context || {};

    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    let out = null;

    // Try OpenAI first (if configured)
    try {
      out = await openaiReply(message, context);
    } catch {
      out = null;
    }

    // Fallback to local intelligence
    if (!out) out = localReply(message, context);

    // Light learning
    const low = message.toLowerCase();
    if (
      low.includes("remember") ||
      low.includes("from now on") ||
      low.includes("i prefer")
    ) {
      addMemory({ type: "preference", text: message.slice(0, 800) });
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "AI error" });
  }
});

/* ================= MEMORY ADMIN ================= */

// GET /api/ai/memory
router.get("/memory", (req, res) => {
  if (!hasOwnerAccess(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  const limit = clampInt(req.query.limit, 1, 500, 50);
  const type = cleanStr(req.query.type, 40) || null;

  return res.json({
    ok: true,
    items: listMemory({ limit, type }),
  });
});

// POST /api/ai/learn
router.post("/learn", (req, res) => {
  if (!hasOwnerAccess(req)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }

  const rec = addMemory({
    type: req.body?.type || "site",
    text: req.body?.text,
    meta: req.body?.meta,
  });

  if (!rec) {
    return res.status(400).json({ ok: false, error: "Invalid memory" });
  }

  return res.json({ ok: true, saved: rec });
});

// GET /api/ai/brain/status
router.get("/brain/status", (req, res) => {
  return res.json({
    ok: true,
    openai: !!process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_CHAT_MODEL || null,
    memoryCount: listMemory({ limit: 500 }).length,
    time: new Date().toISOString(),
  });
});

module.exports = router;
