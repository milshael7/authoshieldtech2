// backend/src/services/aiBrain.js
// AutoProtect "Brain" (Persistent + Natural Replies) + WIN/LOSS MINDSET (locked)
//
// ✅ What this adds:
// - A permanent “Mindset Policy” stored inside the brain file (persisted on disk)
// - The AI uses the mindset when explaining trades, decisions, confidence, losses
// - Commands:
//   - "mindset" / "show mindset" -> prints the policy
//   - "mindset status" -> shows version + loaded state
//
// Reality check:
// - This module does NOT browse the web.
// - This does NOT place real trades.
// - It explains + reasons + teaches based on the live dashboard context you send.

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

// ------------------ ✅ LOCKED MINDSET POLICY ------------------

const MINDSET_VERSION = 1;

// This is the AI constitution for trading behavior (no emotion, pure logic).
// This will be persisted inside the brain file and used in replies.
const DEFAULT_MINDSET = {
  version: MINDSET_VERSION,
  title: "AutoShield Win/Loss Mindset",
  // Short “AI-readable” rule set
  rules: [
    "PRIMARY PURPOSE: avoid losing money. Protect capital first.",
    "LOSS = FAILURE. A negative trade outcome is failure. Not acceptable.",
    "WIN = SUCCESS. Positive net outcome AND rules followed.",
    "WAITING IS ACCEPTABLE. Missing trades is acceptable. Losing is not.",
    "CONFIDENCE IS RULE-COMPLETION, NOT BELIEF. High confidence must mean rules were satisfied.",
    "IF A LOSS OCCURS: assume rules were insufficient. Tighten thresholds / add constraints. Do not excuse it.",
    "BEFORE ENTERING: if there is a reasonable path to loss under current conditions, do not trade.",
    "RISK CONTROLS ARE OBLIGATORY: daily loss limits, cooldowns, and sizing caps exist to prevent failure cascades.",
  ],
  // Human readable summary (shown when user asks “mindset”)
  summary:
    "The AI exists to avoid failure. Failure is losing money. Success is returning money with profit while obeying rules. " +
    "Waiting is allowed. Confidence must reflect rule completion. A loss means the system must tighten and improve.",
};

// ------------------ utils ------------------

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
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

function truncate(s, max) {
  const limit = Number(max) || DEFAULT_MAX_REPLY_CHARS;
  const t = String(s || "");
  if (t.length <= limit) return t;
  return t.slice(0, limit - 3) + "...";
}

function normalizeMessage(s) {
  return safeStr(s, 2000).toLowerCase();
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
    version: 3,
    createdAt: nowIso(),
    updatedAt: nowIso(),

    // ✅ persisted mindset (so it survives restarts/deploys if AI_BRAIN_PATH is persistent)
    mindset: DEFAULT_MINDSET,

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

    // ensure mindset always exists + versioned
    if (!brain.mindset || typeof brain.mindset !== "object") {
      brain.mindset = DEFAULT_MINDSET;
    }
    if (Number(brain.mindset.version || 0) < MINDSET_VERSION) {
      brain.mindset = DEFAULT_MINDSET;
    }

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
    mindset: {
      version: brain.mindset?.version || 0,
      title: brain.mindset?.title || "—",
      rulesCount: Array.isArray(brain.mindset?.rules) ? brain.mindset.rules.length : 0,
    },
  };
}

function resetBrain() {
  brain = defaultBrain();
  saveBrainNow();
}

// ------------------ context extraction ------------------

function extractTop(ctx) {
  const c = ctx || {};
  const symbol = safeStr(c.symbol || c?.context?.symbol || "BTCUSD", 40) || "BTCUSD";
  const mode = safeStr(c.mode || c?.context?.mode || "Paper", 40) || "Paper";
  const last = safeNum(c.last ?? c?.context?.last, NaN);
  return { symbol, mode, last };
}

function extractPaper(ctx) {
  const c = ctx || {};
  const paper = c.paper || c?.context?.paper || {};

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
    sizing: paper.sizing || null,
    limits: paper.limits || null,
  };
}

// ------------------ mindset helpers ------------------

function mindsetHeaderLine() {
  return "Mindset: WIN is success. LOSS is failure. Waiting is allowed. Capital protection first.";
}

function mindsetLongText() {
  const ms = brain.mindset || DEFAULT_MINDSET;
  const lines = [];
  lines.push(`${ms.title} (v${ms.version})`);
  lines.push("");
  lines.push(ms.summary);
  lines.push("");
  lines.push("Rules:");
  for (const r of ms.rules || []) lines.push(`- ${r}`);
  return lines.join("\n");
}

// ------------------ reply building ------------------

function scoreboardText(top, p) {
  const wr = winRate(p.realized.wins, p.realized.losses);
  const lastPx = Number.isFinite(top.last) ? money(top.last).replace("$", "") : "—";

  const lines = [
    mindsetHeaderLine(),
    "",
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
  if (p.learnStats.ticksSeen < 50) warnings.push("Warm-up: still collecting data; WAIT is acceptable.");
  if (Math.abs(edge) < WARN_EDGE_LOW) warnings.push("Edge is small (choppy conditions). Avoid entries.");
  if (conf < WARN_CONF_LOW) warnings.push("Confidence is low (rule completion not strong). WAIT.");

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
    mindsetHeaderLine(),
    "",
    `Decision report (${top.symbol} • ${top.mode})`,
    pos,
    `Decision: ${p.learnStats.decision}`,
    `Confidence (rule-completion): ${pct01(conf, 0)} • Trend edge: ${pct01(edge, 2)} • Ticks: ${p.learnStats.ticksSeen}`,
    `Reason: ${reason}`,
  ];

  if (warnings.length) {
    lines.push("");
    lines.push("Mindset enforcement (avoid failure):");
    for (const w of warnings) lines.push(`- ${w}`);
  }

  // show controls if present
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
  if (!t) return `No trades logged yet for ${top.symbol}. (Mindset: WAIT is acceptable. Loss is not.)`;

  const type = safeStr(t.type || "—", 30);
  const sym = safeStr(t.symbol || top.symbol, 30);
  const strat = safeStr(t.strategy || "—", 60);
  const time = t.time ? new Date(t.time).toLocaleString() : "—";
  const px = t.price != null ? money(t.price).replace("$", "") : "—";
  const usd = t.usd != null ? money(t.usd) : "—";
  const profit = t.profit != null ? money(t.profit) : null;
  const exit = t.exitReason ? humanReason(t.exitReason) : null;

  const verdict =
    profit == null
      ? "Result: —"
      : profit.startsWith("-")
      ? "Result: LOSS (failure). Tighten rules/thresholds."
      : "Result: WIN (success). Validate rules worked.";

  const lines = [
    mindsetHeaderLine(),
    "",
    `Last trade (${sym})`,
    `Time: ${time}`,
    `Type: ${type} • Strategy: ${strat}`,
    `Price: ${px} • Notional: ${usd}`,
    verdict,
  ];

  if (profit != null) lines.push(`Net: ${profit}`);
  if (exit) lines.push(`Exit reason: ${exit}`);
  if (t.note) lines.push(`Note: ${safeStr(t.note, 400)}`);

  return lines.join("\n");
}

function helpText() {
  return [
    "Commands:",
    `- "mindset" (show the win/loss mindset policy)`,
    `- "show scoreboard"`,
    `- "why did it buy/sell?"`,
    `- "what is the current decision?"`,
    `- "explain last trade"`,
    `- "what are my fees?"`,
    `- "add note: ..."`,
  ].join("\n");
}

function improvementTips(p) {
  // Practical, mindset-aligned tips:
  const tips = [];

  const fee = p.costs.feePaid + p.costs.slippageCost + p.costs.spreadCost;
  const net = p.realized.net;

  if (fee > 0 && Math.abs(net) > 0 && fee > Math.abs(net) * 0.6) {
    tips.push(
      "Costs are eating performance. Mindset says: avoid failure → reduce trade frequency or raise entry quality."
    );
  }

  if (p.learnStats.confidence < WARN_CONF_LOW) {
    tips.push(
      "Confidence is low (rule completion weak). Mindset says: WAIT. Raise entry thresholds (MIN_EDGE / MIN_CONF)."
    );
  }

  if (p.limits?.halted) {
    tips.push(`Trading is halted by safety stop: ${p.limits.haltReason || "unknown"}. Keep it halted until rules are tightened.`);
  }

  if (!tips.length) {
    tips.push("To reduce failure: tighten entry filters, add cooldown after loss, enforce daily loss cutoff, and cap sizing.");
  }

  return ["Mindset-aligned improvements (avoid loss):", ...tips.map((t) => `- ${t}`)].join("\n");
}

// Very light “general assistant” fallback (no web, no fake claims)
function generalAssistantReply(msg) {
  return (
    "I can explain your trading dashboard using the live context you send (wins/losses, P&L, decisions, risk). " +
    "Ask: “mindset”, “show scoreboard”, or “why did it enter?”"
  );
}

// ------------------ main answer ------------------

/**
 * answer(message, context, hints)
 * Backward compatible with ai.routes.js calling answer(msg, context)
 */
function answer(message, context /*, hints */) {
  const msg = safeStr(message, 4000);
  const m = normalizeMessage(msg);

  const top = extractTop(context || {});
  const paper = extractPaper(context || {});

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
  });

  // --------- mindset commands ----------
  if (m === "mindset" || m.includes("show mindset")) {
    const reply = truncate(mindsetLongText(), brain.config?.maxReplyChars);
    addHistory("ai", reply);
    return reply;
  }

  if (m.includes("mindset status")) {
    const ms = brain.mindset || DEFAULT_MINDSET;
    const reply = `Mindset status\n- title: ${ms.title}\n- version: ${ms.version}\n- rules: ${(ms.rules || []).length}\n- brain file: ${BRAIN_PATH}`;
    addHistory("ai", reply);
    return reply;
  }

  // --------- other command-like intents ----------
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
    const snap = getSnapshot();
    const reply =
      `Brain status\n` +
      `- Brain file: ${snap.brainPath}\n` +
      `- Updated: ${snap.updatedAt}\n` +
      `- History: ${snap.historyCount}\n` +
      `- Notes: ${snap.notesCount}\n` +
      `- Mindset: ${snap.mindset.title} (v${snap.mindset.version})`;
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
    if (m.includes("last trade") || m.includes("explain last trade")) {
      const reply = truncate(lastTradeText(top, paper), brain.config?.maxReplyChars);
      addHistory("ai", reply);
      return reply;
    }

    if (
      m.includes("scoreboard") ||
      m.includes("wins") ||
      m.includes("loss") ||
      m.includes("p&l") ||
      m.includes("pnl")
    ) {
      const reply = truncate(scoreboardText(top, paper), brain.config?.maxReplyChars);
      addHistory("ai", reply);
      return reply;
    }

    if (m.includes("fees") || m.includes("slippage") || m.includes("spread") || m.includes("cost")) {
      const reply = truncate(
        [
          mindsetHeaderLine(),
          "",
          "Costs breakdown",
          `Fees paid: ${money(paper.costs.feePaid)}`,
          `Slippage cost: ${money(paper.costs.slippageCost)}`,
          `Spread cost: ${money(paper.costs.spreadCost)}`,
          "",
          improvementTips(paper),
        ].join("\n"),
        brain.config?.maxReplyChars
      );
      addHistory("ai", reply);
      return reply;
    }

    if (m.includes("reduce losses") || m.includes("stop losing") || m.includes("risk")) {
      const reply = truncate(improvementTips(paper), brain.config?.maxReplyChars);
      addHistory("ai", reply);
      return reply;
    }

    // default “decision / why”
    const reply = truncate(decisionText(top, paper), brain.config?.maxReplyChars);
    addHistory("ai", reply);
    return reply;
  }

  // --------- general fallback ----------
  const reply = truncate(generalAssistantReply(msg), brain.config?.maxReplyChars);
  addHistory("ai", reply);
  return reply;
}

module.exports = {
  answer,
  addNote,
  getSnapshot,
  resetBrain,
};
