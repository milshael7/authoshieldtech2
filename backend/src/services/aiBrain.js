// backend/src/services/aiBrain.js
// AutoProtect "Brain" (Persistent + Natural Replies)
// Goals:
// - Non-robotic explanations using real page context (paper trader stats, position, decision, controls)
// - Works even if frontend sends {message, context} OR {message, context, hints}
// - Handles trading questions + general questions (basic assistant mode)
// - Lightweight “memory” (history + notes) saved to disk via AI_BRAIN_PATH
//
// Reality check:
// - This module does NOT browse the web. It can “learn the page” from context you send + what you say.
// - If you want true web browsing/surfacing, you’d add a backend tool layer later.

const fs = require("fs");
const path = require("path");

const BRAIN_PATH =
  (process.env.AI_BRAIN_PATH && String(process.env.AI_BRAIN_PATH).trim()) ||
  "/tmp/ai_brain.json";

const MAX_HISTORY = Number(process.env.AI_BRAIN_MAX_HISTORY || 120);
const MAX_NOTES = Number(process.env.AI_BRAIN_MAX_NOTES || 80);

// Optional personality knobs
const DEFAULT_TONE = String(process.env.AI_BRAIN_TONE || "natural").trim(); // natural|business|friendly
const DEFAULT_MAX_REPLY_CHARS = Number(process.env.AI_BRAIN_MAX_REPLY_CHARS || 1800);

// If you want “smarter” trading explanations, these help frame answers:
const WARN_EDGE_LOW = Number(process.env.AI_BRAIN_WARN_EDGE_LOW || 0.0005); // 0.05%
const WARN_CONF_LOW = Number(process.env.AI_BRAIN_WARN_CONF_LOW || 0.55);

// ------------------ utils ------------------

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeStr(v, max = 5000) {
  return String(v ?? "").trim().slice(0, max);
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function money(n, digits = 2) {
  const x = safeNum(n, NaN);
  if (!Number.isFinite(x)) return "—";
  return (
    "$" +
    x.toLocaleString(undefined, {
      maximumFractionDigits: digits,
    })
  );
}

function pct01(n, digits = 0) {
  const x = safeNum(n, NaN);
  if (!Number.isFinite(x)) return "—";
  return (x * 100).toFixed(digits) + "%";
}

function humanReason(r) {
  const x = String(r || "").toLowerCase().trim();
  if (!x) return "—";
  if (x.includes("take_profit") || x === "tp_hit") return "Take Profit hit";
  if (x.includes("stop_loss") || x === "sl_hit") return "Stop Loss hit";
  if (x.includes("expiry") || x.includes("expired") || x.includes("time"))
    return "Time expired";
  if (x.includes("warming")) return "Still warming up (collecting data)";
  if (x.includes("edge")) return "Trend edge detected";
  return r;
}

function truncate(s, max = DEFAULT_MAX_REPLY_CHARS) {
  const t = String(s || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 3) + "...";
}

function normalizeMessage(s) {
  return safeStr(s, 2000).toLowerCase();
}

function isQuestionLike(m) {
  return /\?$/.test(m) || /\b(what|why|how|when|where|who|can you|could you|do you)\b/i.test(m);
}

function winRate(w, l) {
  const W = safeNum(w, 0);
  const L = safeNum(l, 0);
  const t = W + L;
  if (!t) return 0;
  return W / t;
}

// ------------------ persistent brain ------------------

function defaultBrain() {
  return {
    version: 2,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    history: [], // [{ts, role:'user'|'ai', text}]
    notes: [], // [{ts, text}]
    lastContext: null,

    config: {
      tone: DEFAULT_TONE,
      maxHistory: MAX_HISTORY,
      maxNotes: MAX_NOTES,
      maxReplyChars: DEFAULT_MAX_REPLY_CHARS,
    },
  };
}

let brain = defaultBrain();
let saveTimer = null;

function loadBrain() {
  try {
    ensureDirFor(BRAIN_PATH);
    if (!fs.existsSync(BRAIN_PATH)) return false;

    const raw = fs.readFileSync(BRAIN_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    const base = defaultBrain();
    brain = {
      ...base,
      ...parsed,
      config: { ...base.config, ...(parsed.config || {}) },
      history: Array.isArray(parsed.history) ? parsed.history : base.history,
      notes: Array.isArray(parsed.notes) ? parsed.notes : base.notes,
    };

    brain.history = brain.history.slice(-MAX_HISTORY);
    brain.notes = brain.notes.slice(-MAX_NOTES);
    return true;
  } catch {
    return false;
  }
}

function saveBrainNow() {
  try {
    ensureDirFor(BRAIN_PATH);
    brain.updatedAt = nowIso();

    const safe = {
      ...brain,
      history: brain.history.slice(-MAX_HISTORY),
      notes: brain.notes.slice(-MAX_NOTES),
    };

    const tmp = BRAIN_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, BRAIN_PATH);
  } catch {}
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBrainNow();
  }, 600);
}

loadBrain();

function addHistory(role, text) {
  const clean = safeStr(text);
  if (!clean) return;
  brain.history.push({ ts: Date.now(), role, text: clean });
  if (brain.history.length > MAX_HISTORY) brain.history = brain.history.slice(-MAX_HISTORY);
  scheduleSave();
}

function addNote(text) {
  const clean = safeStr(text, 1200);
  if (!clean) return;
  brain.notes.push({ ts: Date.now(), text: clean });
  if (brain.notes.length > MAX_NOTES) brain.notes = brain.notes.slice(-MAX_NOTES);
  scheduleSave();
}

function setLastContext(ctx) {
  brain.lastContext = ctx || null;
  scheduleSave();
}

function getSnapshot() {
  return {
    ok: true,
    brainPath: BRAIN_PATH,
    createdAt: brain.createdAt,
    updatedAt: brain.updatedAt,
    historyCount: brain.history.length,
    notesCount: brain.notes.length,
    lastContext: !!brain.lastContext,
    config: brain.config,
  };
}

function resetBrain() {
  brain = defaultBrain();
  saveBrainNow();
}

// ------------------ context extraction ------------------

function extractTop(ctx) {
  const c = ctx || {};
  // sometimes the client nests
  const symbol = safeStr(c.symbol || c?.context?.symbol || "BTCUSD", 40) || "BTCUSD";
  const mode = safeStr(c.mode || c?.context?.mode || "Paper", 40) || "Paper";
  const last = safeNum(c.last ?? c?.context?.last, NaN);

  return { symbol, mode, last };
}

function extractPaper(ctx) {
  const c = ctx || {};
  const paper = c.paper || c?.context?.paper || {};

  // Trading.jsx uses: cashBalance, equity, pnl, unrealizedPnL, realized, costs, learnStats, position, config
  const cashBalance = safeNum(paper.cashBalance ?? paper.balance ?? paper.cash ?? 0, 0);
  const equity = safeNum(paper.equity ?? cashBalance, cashBalance);
  const pnl = safeNum(paper.pnl ?? paper.realized?.net ?? paper.net ?? 0, 0);
  const unreal = safeNum(paper.unrealizedPnL ?? paper.unreal ?? 0, 0);

  const realized = {
    wins: safeNum(paper.realized?.wins ?? paper.wins ?? 0, 0),
    losses: safeNum(paper.realized?.losses ?? paper.losses ?? 0, 0),
    grossProfit: safeNum(paper.realized?.grossProfit ?? paper.grossProfit ?? 0, 0),
    grossLoss: safeNum(paper.realized?.grossLoss ?? paper.grossLoss ?? 0, 0),
    net: safeNum(paper.realized?.net ?? paper.net ?? pnl ?? 0, pnl ?? 0),
  };

  const costs = {
    feePaid: safeNum(paper.costs?.feePaid ?? paper.feePaid ?? 0, 0),
    slippageCost: safeNum(paper.costs?.slippageCost ?? paper.slippageCost ?? 0, 0),
    spreadCost: safeNum(paper.costs?.spreadCost ?? paper.spreadCost ?? 0, 0),
  };

  const learnStats = {
    ticksSeen: safeNum(paper.learnStats?.ticksSeen ?? paper.ticksSeen ?? 0, 0),
    confidence: safeNum(paper.learnStats?.confidence ?? paper.confidence ?? 0, 0),
    trendEdge: safeNum(paper.learnStats?.trendEdge ?? paper.trendEdge ?? 0, 0),
    decision: safeStr(paper.learnStats?.decision ?? paper.decision ?? "WAIT", 40) || "WAIT",
    lastReason: safeStr(paper.learnStats?.lastReason ?? paper.decisionReason ?? "—", 300) || "—",
    lastTickTs: paper.learnStats?.lastTickTs ?? null,
  };

  const position = paper.position || null;
  const trades = Array.isArray(paper.trades) ? paper.trades : [];
  const lastTrade = trades.length ? trades[trades.length - 1] : null;

  // paper trader config can be at paper.config or paper.owner depending on your snapshot
  const cfg = paper.config || paper.owner || null;

  return {
    running: !!paper.running,
    cashBalance,
    equity,
    pnl,
    unrealizedPnL: unreal,
    realized,
    costs,
    learnStats,
    position,
    tradesCount: trades.length,
    lastTrade,
    config: cfg,
    // optional sizing/limits if snapshot includes them
    sizing: paper.sizing || null,
    limits: paper.limits || null,
  };
}

function extractHints(contextMaybe, hintsMaybe) {
  // VoiceAI.jsx sends hints in req.body.hints (best)
  // but some callers might nest hints inside context
  return (
    hintsMaybe ||
    (contextMaybe && contextMaybe.hints) ||
    (contextMaybe && contextMaybe?.context && contextMaybe.context.hints) ||
    null
  );
}

// ------------------ reply building ------------------

function tonePrefix() {
  const t = String(brain.config?.tone || DEFAULT_TONE).toLowerCase();
  if (t === "business") return "";
  if (t === "friendly") return "";
  return "";
}

function scoreboardText(top, p) {
  const wr = winRate(p.realized.wins, p.realized.losses);
  const lastPx = Number.isFinite(top.last) ? money(top.last).replace("$", "") : "—";

  const lines = [
    `Trading snapshot (${top.symbol} • ${top.mode})`,
    `Last price: ${lastPx}`,
    `Cash: ${money(p.cashBalance)} • Equity: ${money(p.equity)} • Unrealized: ${money(p.unrealizedPnL)}`,
    `Net P&L: ${money(p.realized.net)} • Wins: ${p.realized.wins} • Losses: ${p.realized.losses} • Win rate: ${(wr * 100).toFixed(0)}%`,
    `Total gain: ${money(p.realized.grossProfit)} • Total loss: ${money(p.realized.grossLoss)}`,
    `Fees: ${money(p.costs.feePaid)} • Slippage: ${money(p.costs.slippageCost)} • Spread: ${money(p.costs.spreadCost)}`,
  ];

  return lines.join("\n");
}

function decisionText(top, p) {
  const reason = humanReason(p.learnStats.lastReason);
  const edge = p.learnStats.trendEdge;
  const conf = p.learnStats.confidence;

  const warnings = [];
  if (p.learnStats.ticksSeen < 50) warnings.push("Still early — the model is warming up.");
  if (Math.abs(edge) < WARN_EDGE_LOW) warnings.push("Edge looks small right now (choppy market).");
  if (conf < WARN_CONF_LOW) warnings.push("Confidence is low — waiting is usually smarter here.");

  const pos = p.position
    ? [
        `Open position: ${p.position.symbol || top.symbol}`,
        `Entry: ${p.position.entry != null ? String(p.position.entry) : "—"}`,
        `Qty: ${p.position.qty != null ? String(p.position.qty) : "—"}`,
        `Strategy: ${p.position.strategy || "—"}`,
        `Age: ${p.position.ageMs != null ? Math.round(p.position.ageMs / 1000) + "s" : "—"}`,
      ].join(" • ")
    : "Open position: none";

  const lines = [
    `Decision report (${top.symbol} • ${top.mode})`,
    pos,
    `Decision: ${p.learnStats.decision}`,
    `Confidence: ${pct01(conf, 0)} • Trend edge: ${pct01(edge, 2)} • Ticks: ${p.learnStats.ticksSeen}`,
    `Reason: ${reason}`,
  ];

  if (warnings.length) {
    lines.push("");
    lines.push("Quick read:");
    for (const w of warnings) lines.push(`- ${w}`);
  }

  // add config hints (if available)
  if (p.config) {
    const bp = safeNum(p.config.baselinePct, NaN);
    const mp = safeNum(p.config.maxPct, NaN);
    const mt = safeNum(p.config.maxTradesPerDay, NaN);
    const cfgLine = [
      Number.isFinite(bp) ? `baseline ${(bp * 100).toFixed(1)}%` : null,
      Number.isFinite(mp) ? `max ${(mp * 100).toFixed(1)}%` : null,
      Number.isFinite(mt) ? `maxTrades/day ${Math.floor(mt)}` : null,
    ]
      .filter(Boolean)
      .join(" • ");
    if (cfgLine) {
      lines.push("");
      lines.push(`Controls: ${cfgLine}`);
    }
  }

  return lines.join("\n");
}

function lastTradeText(top, p) {
  const t = p.lastTrade;
  if (!t) return `No trades logged yet for ${top.symbol}. It may still be warming up.`;

  const type = safeStr(t.type || "—", 30);
  const sym = safeStr(t.symbol || top.symbol, 30);
  const strat = safeStr(t.strategy || "—", 60);
  const time = t.time ? new Date(t.time).toLocaleString() : "—";
  const px = t.price != null ? money(t.price).replace("$", "") : "—";
  const usd = t.usd != null ? money(t.usd) : "—";
  const profit = t.profit != null ? money(t.profit) : null;
  const exit = t.exitReason ? humanReason(t.exitReason) : null;

  const lines = [
    `Last trade (${sym})`,
    `Time: ${time}`,
    `Type: ${type} • Strategy: ${strat}`,
    `Price: ${px} • Notional: ${usd}`,
  ];

  if (profit != null) lines.push(`Result: ${profit}${profit.startsWith("-") ? " (loss)" : " (gain)"}`);
  if (exit) lines.push(`Exit reason: ${exit}`);
  if (t.note) lines.push(`Note: ${safeStr(t.note, 400)}`);

  return lines.join("\n");
}

function helpText() {
  return [
    "You can ask me stuff like:",
    `- "show scoreboard"`,
    `- "why did it buy/sell?"`,
    `- "what is the current decision?"`,
    `- "explain last trade"`,
    `- "what are my fees?"`,
    `- "what should I change to reduce losses?"`,
    `- "add note: ..."`,

    "",
    "And you can ask general questions too (I’ll answer like a normal assistant).",
  ].join("\n");
}

function improvementTips(p) {
  // Practical, page-specific tips (without promising magic)
  const tips = [];

  // If fees are large relative to net
  const fee = p.costs.feePaid + p.costs.slippageCost + p.costs.spreadCost;
  const net = p.realized.net;
  if (fee > 0 && Math.abs(net) > 0 && fee > Math.abs(net) * 0.6) {
    tips.push(
      "Costs are eating a lot of performance. Consider: fewer trades/day, slightly longer holds, or larger notional trades so fees don’t dominate."
    );
  }

  if (p.learnStats.confidence < WARN_CONF_LOW) {
    tips.push("Confidence is low. Best move is usually: WAIT more and raise the entry threshold (MIN_EDGE / MIN_CONF).");
  }

  if (p.limits?.lossesToday >= 2) {
    tips.push("It hit the daily loss control (force baseline). That’s good — it reduces bleeding after a bad streak.");
  }

  if (p.limits?.halted) {
    tips.push(`Trading halted: ${p.limits.haltReason || "safety stop"}. Reset paper or reduce risk before resuming.`);
  }

  if (!tips.length) {
    tips.push("If you want tighter behavior: add daily loss cutoff + cooldown + an ‘edge threshold’ before entering.");
  }

  return ["Here’s how to reduce one-sided losing:", ...tips.map((t) => `- ${t}`)].join("\n");
}

// Very light “general assistant” fallback (no web, no claims)
function generalAssistantReply(msg) {
  const m = normalizeMessage(msg);

  if (m.includes("who are you") || m.includes("what are you")) {
    return "I’m AutoProtect — the assistant for your dashboard. I can explain your trading stats in real time, and I can also answer general questions.";
  }

  if (m.includes("how do i") || m.includes("what should i do")) {
    return (
      "Tell me what you’re trying to do and what tools you’re using (phone/PC, backend/frontend). " +
      "If it’s about trading, ask from inside the Trading Room so I can use your live context."
    );
  }

  // Default
  return (
    "I can help. If this is about your Trading Room, ask: “show scoreboard” or “why did it enter?” " +
    "If it’s a general question, ask it directly and I’ll answer normally."
  );
}

// ------------------ main answer ------------------

/**
 * answer(message, context, hints)
 * - Backward compatible with your current ai.routes.js which calls answer(msg, context)
 */
function answer(message, context, hints) {
  const msg = safeStr(message, 4000);
  const m = normalizeMessage(msg);

  const top = extractTop(context || {});
  const paper = extractPaper(context || {});
  const h = extractHints(context || {}, hints);

  // memory update
  addHistory("user", msg);
  setLastContext({
    ts: Date.now(),
    symbol: top.symbol,
    mode: top.mode,
    last: top.last,
    paper: {
      running: paper.running,
      cashBalance: paper.cashBalance,
      equity: paper.equity,
      net: paper.realized.net,
      wins: paper.realized.wins,
      losses: paper.realized.losses,
      decision: paper.learnStats.decision,
      reason: paper.learnStats.lastReason,
      confidence: paper.learnStats.confidence,
      ticksSeen: paper.learnStats.ticksSeen,
    },
    hintsPresent: !!h,
  });

  // --------- command-like intents ----------
  if (m === "help" || m.includes("what can you do") || m.includes("commands")) {
    const reply = helpText();
    addHistory("ai", reply);
    return reply;
  }

  if (m.startsWith("add note:") || m.startsWith("note:")) {
    const text = msg.split(":").slice(1).join(":").trim();
    addNote(text);
    const reply = `Saved note. (${brain.notes.length}/${MAX_NOTES})`;
    addHistory("ai", reply);
    return reply;
  }

  if (m.includes("brain status") || (m.includes("brain") && m.includes("status"))) {
    const reply =
      `Brain status\n` +
      `- Brain file: ${BRAIN_PATH}\n` +
      `- Updated: ${brain.updatedAt}\n` +
      `- History: ${brain.history.length} messages\n` +
      `- Notes: ${brain.notes.length}\n\n` +
      `To persist across deploys, set AI_BRAIN_PATH to your Render Disk mount path (example: /var/data/ai_brain.json).`;
    addHistory("ai", reply);
    return reply;
  }

  // --------- trading intents ----------
  const tradingIntent =
    m.includes("scoreboard") ||
    m.includes("p&l") ||
    m.includes("pnl") ||
    m.includes("wins") ||
    m.includes("loss") ||
    m.includes("fees") ||
    m.includes("slippage") ||
    m.includes("spread") ||
    m.includes("cost") ||
    m.includes("decision") ||
    m.includes("reason") ||
    m.includes("why did") ||
    m.includes("enter") ||
    m.includes("buy") ||
    m.includes("sell") ||
    m.includes("position") ||
    m.includes("trade") ||
    m.includes("history");

  if (tradingIntent) {
    // more specific routing
    if (m.includes("last trade") || m.includes("explain last trade")) {
      const reply = truncate(lastTradeText(top, paper), brain.config?.maxReplyChars || DEFAULT_MAX_REPLY_CHARS);
      addHistory("ai", reply);
      return reply;
    }

    if (m.includes("scoreboard") || m.includes("wins") || m.includes("loss") || m.includes("p&l") || m.includes("pnl")) {
      const reply = truncate(scoreboardText(top, paper), brain.config?.maxReplyChars || DEFAULT_MAX_REPLY_CHARS);
      addHistory("ai", reply);
      return reply;
    }

    if (m.includes("fees") || m.includes("slippage") || m.includes("spread") || m.includes("cost")) {
      const reply = truncate(
        [
          "Costs breakdown",
          `Fees paid: ${money(paper.costs.feePaid)}`,
          `Slippage cost: ${money(paper.costs.slippageCost)}`,
          `Spread cost: ${money(paper.costs.spreadCost)}`,
          "",
          improvementTips(paper),
        ].join("\n"),
        brain.config?.maxReplyChars || DEFAULT_MAX_REPLY_CHARS
      );
      addHistory("ai", reply);
      return reply;
    }

    if (m.includes("reduce losses") || m.includes("stop losing") || m.includes("one-sided") || m.includes("risk")) {
      const reply = truncate(improvementTips(paper), brain.config?.maxReplyChars || DEFAULT_MAX_REPLY_CHARS);
      addHistory("ai", reply);
      return reply;
    }

    // default “decision / why”
    const reply = truncate(decisionText(top, paper), brain.config?.maxReplyChars || DEFAULT_MAX_REPLY_CHARS);
    addHistory("ai", reply);
    return reply;
  }

  // --------- “general questions” (outside trading) ----------
  // We still keep it grounded and not robotic.
  const reply = truncate(
    tonePrefix() + generalAssistantReply(msg),
    brain.config?.maxReplyChars || DEFAULT_MAX_REPLY_CHARS
  );
  addHistory("ai", reply);
  return reply;
}

module.exports = {
  answer,
  addNote,
  getSnapshot,
  resetBrain,
};
