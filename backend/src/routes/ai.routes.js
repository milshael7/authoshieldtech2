// backend/src/routes/ai.routes.js
// Smarter AI routes (non-robotic) + “learn from the website” memory endpoints
// ✅ Backward compatible: still returns { ok:true, reply }
// ✅ Adds: speakText (for voice), meta, and a simple memory system via lib/brain
// ✅ Works with or without OpenAI. If OPENAI_API_KEY is set, it will use it.
// ✅ If not set, it falls back to a strong local explainer (still useful).

const express = require("express");
const router = express.Router();

const { addMemory, listMemory } = require("../lib/brain");

// Optional existing service (if you already have it)
let aiBrain = null;
try {
  aiBrain = require("../services/aiBrain");
} catch {
  aiBrain = null;
}

function cleanStr(v, max = 8000) {
  return String(v || "").trim().slice(0, max);
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function hasOwnerAccess(req) {
  // If you don’t set AI_OWNER_KEY, these endpoints are OPEN (not recommended).
  const key = cleanStr(process.env.AI_OWNER_KEY, 200);
  if (!key) return true;
  const sent = cleanStr(req.headers["x-owner-key"], 200);
  return !!sent && sent === key;
}

function summarizeTradingContext(context) {
  const p = context?.paper || {};
  const symbol = cleanStr(context?.symbol, 20) || "—";
  const mode = cleanStr(context?.mode, 20) || "—";
  const last = Number(context?.last);

  const running = !!p.running;
  const equity = Number(p.equity ?? p.cashBalance ?? 0);
  const pnl = Number(p.pnl ?? p.net ?? 0);
  const unreal = Number(p.unrealizedPnL ?? 0);

  const wins = Number(p.wins ?? 0);
  const losses = Number(p.losses ?? 0);

  const decision = cleanStr(p.decision, 40) || "WAIT";
  const decisionReason = cleanStr(p.decisionReason || p.lastReason, 220) || "—";
  const confidence = Number(p.confidence ?? 0);

  const pos = p.position || null;

  return {
    symbol,
    mode,
    last: Number.isFinite(last) ? last : null,
    running,
    equity: Number.isFinite(equity) ? equity : 0,
    pnl: Number.isFinite(pnl) ? pnl : 0,
    unreal: Number.isFinite(unreal) ? unreal : 0,
    wins: Number.isFinite(wins) ? wins : 0,
    losses: Number.isFinite(losses) ? losses : 0,
    decision,
    decisionReason,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    position: pos
      ? {
          symbol: cleanStr(pos.symbol, 20),
          strategy: cleanStr(pos.strategy, 40),
          entry: Number(pos.entry),
          qty: Number(pos.qty),
          ageMs: Number(pos.ageMs),
          remainingMs: pos.remainingMs === null ? null : Number(pos.remainingMs),
        }
      : null,
  };
}

function localReply(message, context) {
  const m = cleanStr(message, 2000);
  const snap = summarizeTradingContext(context);

  const basicHelp =
    "I can explain your trading room in real time (wins/losses, P&L, why it entered, what it’s waiting for). " +
    "You can also ask non-trading questions—just say what you need.";

  // If they ask “what is happening / explain” → focus on dashboard
  const low = m.toLowerCase();

  if (
    low.includes("explain") ||
    low.includes("what’s going on") ||
    low.includes("whats going on") ||
    low.includes("status") ||
    low.includes("summary")
  ) {
    const parts = [];
    parts.push(`Here’s what I’m seeing right now:`);

    parts.push(
      `• Mode: ${snap.mode} • Symbol: ${snap.symbol}` +
        (snap.last != null ? ` • Last: $${snap.last.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "")
    );

    parts.push(
      `• Paper Trader: ${snap.running ? "ON" : "OFF"} • Decision: ${snap.decision} (${Math.round(
        snap.confidence * 100
      )}% confidence)`
    );

    parts.push(`• P&L: $${snap.pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })} (Unrealized: $${snap.unreal.toLocaleString(undefined, { maximumFractionDigits: 2 })})`);
    parts.push(`• Wins/Losses: ${snap.wins}/${snap.losses}`);

    if (snap.position) {
      parts.push(
        `• Open position: ${snap.position.symbol} • ${snap.position.strategy || "—"} • Entry $${Number(
          snap.position.entry
        ).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      );
    } else {
      parts.push(`• Open position: none`);
    }

    parts.push(`Why it’s deciding that: ${snap.decisionReason}`);

    return {
      reply: parts.join("\n"),
      speakText: parts.join(". "),
      meta: { kind: "dashboard_explain", snap },
    };
  }

  // If they ask “why did you buy/sell”
  if (low.includes("why") && (low.includes("buy") || low.includes("sell") || low.includes("enter") || low.includes("trade"))) {
    const lines = [];
    lines.push(`Here’s the reason in plain English:`);
    lines.push(`• Decision: ${snap.decision} (${Math.round(snap.confidence * 100)}% confidence)`);
    lines.push(`• Reason: ${snap.decisionReason}`);
    if (snap.position) {
      lines.push(`• You currently have an open position in ${snap.position.symbol} (${snap.position.strategy || "—"}).`);
    } else {
      lines.push(`• There isn’t an open position right now—so it’s either waiting for a stronger signal or it already exited.`);
    }
    lines.push(`If you tell me “what should it do next?”, I’ll answer based on what the dashboard shows (not guesswork).`);

    return {
      reply: lines.join("\n"),
      speakText: lines.join(". "),
      meta: { kind: "trade_reason", snap },
    };
  }

  // General assistant fallback
  return {
    reply: `${basicHelp}\n\nAsk me like: “Explain my dashboard”, “Why did it enter?”, “How do I reduce losses?”, or ask anything else.`,
    speakText: basicHelp,
    meta: { kind: "general_help" },
  };
}

async function openaiReply(message, context, memoryItems) {
  const apiKey = cleanStr(process.env.OPENAI_API_KEY, 200);
  if (!apiKey) return null;

  const model = cleanStr(process.env.OPENAI_CHAT_MODEL, 60) || "gpt-4o-mini";
  const m = cleanStr(message, 2000);

  const snap = summarizeTradingContext(context);

  const memoryText = (memoryItems || [])
    .slice(0, 20)
    .map((x) => `- [${x.type}] ${x.text}`)
    .join("\n");

  const system = `
You are AutoProtect, an assistant inside a trading + cybersecurity dashboard.
Tone: natural, confident, conversational. Not robotic.
Rules:
- If user asks about trading room, explain using the provided context snapshot only.
- If user asks general questions unrelated to the dashboard, answer normally.
- Keep answers clear and actionable. Use short paragraphs or bullets.
- If data is missing, say what’s missing instead of hallucinating.
- Provide a "speakText" that sounds good spoken aloud (no emoji, no code blocks).
`;

  const user = `
User message: ${m}

Dashboard snapshot (truth):
${JSON.stringify(snap, null, 2)}

Saved memory (facts/preferences):
${memoryText || "(none)"}

Now respond with JSON ONLY:
{
  "reply": "text to show on screen (can include bullets)",
  "speakText": "slightly smoother spoken version"
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
      temperature: 0.4,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: user.trim() },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(errTxt || `OpenAI HTTP ${r.status}`);
  }

  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content || "";
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }

  const reply = cleanStr(parsed?.reply || "", 12000);
  const speakText = cleanStr(parsed?.speakText || reply, 12000);

  if (!reply) return null;

  return { reply, speakText, meta: { kind: "openai", model } };
}

// POST /api/ai/chat
router.post("/chat", async (req, res) => {
  try {
    const message = cleanStr(req.body?.message, 8000);
    const context = req.body?.context || {};

    if (!message) return res.status(400).json({ ok: false, error: "Missing message" });

    // Pull recent memory to make responses less robotic over time
    const memoryItems = listMemory({ limit: 25 });

    // 1) If you have a custom aiBrain service, let it run first (supports sync or async)
    if (aiBrain && typeof aiBrain.answer === "function") {
      const out = await Promise.resolve(aiBrain.answer(message, context));
      if (typeof out === "string" && out.trim()) {
        return res.json({ ok: true, reply: out.trim(), speakText: out.trim(), meta: { kind: "aiBrain" } });
      }
      if (out && typeof out === "object" && out.reply) {
        return res.json({
          ok: true,
          reply: String(out.reply),
          speakText: String(out.speakText || out.reply),
          meta: out.meta || { kind: "aiBrain" },
        });
      }
      // fall through if aiBrain returns nothing
    }

    // 2) Try OpenAI (if configured)
    let out = null;
    try {
      out = await openaiReply(message, context, memoryItems);
    } catch (e) {
      // If OpenAI fails, we fall back to local reply (don’t break the app)
      out = null;
    }

    // 3) Local smart explainer fallback
    if (!out) out = localReply(message, context);

    // Light “learning” — store useful signals (bounded, safe)
    // (We avoid storing secrets; just store short helpful preferences or site facts.)
    const low = message.toLowerCase();
    if (low.includes("remember") || low.includes("from now on") || low.includes("i prefer")) {
      addMemory({ type: "preference", text: message.slice(0, 800) });
    }

    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ GET /api/ai/memory?limit=50&type=preference
router.get("/memory", (req, res) => {
  try {
    if (!hasOwnerAccess(req)) {
      return res.status(403).json({ ok: false, error: "Forbidden (x-owner-key required)" });
    }
    const limit = clampInt(req.query.limit, 1, 500, 50);
    const type = cleanStr(req.query.type, 40) || null;
    const items = listMemory({ limit, type });
    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ POST /api/ai/learn  (frontend can send “site facts” so AI learns the web app)
// Body: { type: 'site'|'rule'|'preference'|'note', text, meta? }
router.post("/learn", (req, res) => {
  try {
    if (!hasOwnerAccess(req)) {
      return res.status(403).json({ ok: false, error: "Forbidden (x-owner-key required)" });
    }

    const type = cleanStr(req.body?.type, 40) || "site";
    const text = cleanStr(req.body?.text, 8000);
    const meta = req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {};

    if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

    const rec = addMemory({ type, text, meta });
    return res.json({ ok: true, saved: rec });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// GET /api/ai/brain/status  (safe diagnostics)
router.get("/brain/status", (req, res) => {
  try {
    const hasOpenAI = !!cleanStr(process.env.OPENAI_API_KEY, 10);
    return res.json({
      ok: true,
      openai: hasOpenAI ? "configured" : "missing",
      model: cleanStr(process.env.OPENAI_CHAT_MODEL, 60) || null,
      memoryCount: listMemory({ limit: 500 }).length,
      aiBrainPresent: !!aiBrain,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
