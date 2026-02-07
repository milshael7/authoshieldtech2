// backend/src/routes/ai.routes.js
// AutoShield AI — Personality Locked + Voice-First Responses
// Step 2: Brand voice, mindset, cadence control

const express = require("express");
const router = express.Router();

const { addMemory, listMemory } = require("../lib/brain");
const paperTrader = require("../services/paperTrader");

/* ================= BRAND PERSONA ================= */

/**
 * This is the HEART of AutoShield.
 * Change this = change how the AI thinks & speaks.
 */
const AUTOSHIELD_PERSONA = `
You are AutoShield.

Identity:
- You are a calm, confident trading operator.
- You speak like a professional human trader, not an assistant.
- You explain what you see. You do NOT hype. You do NOT guess.
- You never talk like a robot.

Behavior rules:
- If data is missing, say it’s missing.
- If nothing is happening, say you’re waiting and why.
- When explaining trades, always answer:
  1. What happened
  2. Why it happened
  3. Risk involved
  4. What you are watching next

Voice rules:
- Short sentences.
- Natural pauses.
- No emojis.
- No code blocks.
- Speak like you’re on a trading desk.

Authority:
- You are allowed to say “I don’t like this setup.”
- You are allowed to say “I’m waiting.”
- You are allowed to say “Risk is elevated.”

You are NOT customer support.
You are NOT motivational.
You are NOT chatty.

You are AutoShield.
`;

/* ================= HELPERS ================= */

function cleanStr(v, max = 8000) {
  return String(v || "").trim().slice(0, max);
}

/* ================= CONTEXT ================= */

function buildSnapshot(clientContext) {
  let paper = null;
  try {
    paper = paperTrader.snapshot();
  } catch {}

  return {
    platform: "AutoShield",
    room: "TradingRoom",
    ...clientContext,
    paper,
    serverTime: new Date().toISOString(),
  };
}

/* ================= LOCAL VOICE-FIRST REPLY ================= */

function localReply(message, context) {
  const m = cleanStr(message, 2000).toLowerCase();
  const p = context.paper || {};

  const decision = p.decision || "WAIT";
  const confidence = Math.round((p.confidence || 0) * 100);
  const reason = p.lastReason || "No clear edge yet.";

  if (
    m.includes("status") ||
    m.includes("explain") ||
    m.includes("what's going on")
  ) {
    const reply = `
Here’s where we are.

Decision: ${decision}.
Confidence: ${confidence} percent.

Equity: ${p.equity?.toFixed?.(2) || "—"}.
Unrealized P&L: ${p.unrealizedPnL?.toFixed?.(2) || "—"}.

${p.position ? `Position open in ${p.position.symbol}.` : "No position open."}

Reason: ${reason}.
`;

    return {
      reply: reply.trim(),
      speakText: reply.replace(/\n+/g, ". ").trim(),
    };
  }

  if (m.includes("why") && (m.includes("buy") || m.includes("sell"))) {
    const reply = `
That trade was taken for one reason.

${reason}

Confidence was ${confidence} percent.
Risk was controlled.
`;

    return {
      reply: reply.trim(),
      speakText: reply.replace(/\n+/g, ". ").trim(),
    };
  }

  return {
    reply:
      "I’m live. Ask me what I’m seeing, why I’m waiting, or what risk looks like.",
    speakText:
      "I’m live. Ask me what I’m seeing, why I’m waiting, or what risk looks like.",
  };
}

/* ================= OPENAI (OPTIONAL, PERSONA LOCKED) ================= */

async function openaiReply(message, context, memoryItems) {
  if (!process.env.OPENAI_API_KEY) return null;

  const payload = {
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    temperature: 0.35,
    messages: [
      { role: "system", content: AUTOSHIELD_PERSONA },
      {
        role: "user",
        content: `
User said:
${message}

Live trading snapshot (truth only):
${JSON.stringify(context.paper, null, 2)}

Respond in JSON:
{
  "reply": "screen text",
  "speakText": "spoken version, slightly smoother"
}
`,
      },
    ],
    response_format: { type: "json_object" },
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return null;

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/* ================= ROUTE ================= */

router.post("/chat", async (req, res) => {
  try {
    const message = cleanStr(req.body?.message, 8000);
    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    const context = buildSnapshot(req.body?.context || {});
    const memoryItems = listMemory({ limit: 20 });

    let out = null;

    try {
      out = await openaiReply(message, context, memoryItems);
    } catch {}

    if (!out) out = localReply(message, context);

    if (message.toLowerCase().includes("remember")) {
      addMemory({ type: "preference", text: message.slice(0, 800) });
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
