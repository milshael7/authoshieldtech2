// backend/src/lib/brain.js
// AutoShield AI — Persistent Brain (Memory + Voices + Personality)
// 🔒 NON-RESETTING CORE
//
// Exposes:
// - addMemory({ type, text, meta })
// - listMemory({ limit, type })
// - buildPersonality(voiceId?)
// - listVoices()
// - getVoice(voiceId)
//
// This file is the LONG-TERM BRAIN.
// Voice, memory, and personality live here and survive resets.

const fs = require("fs");
const path = require("path");

/* ================= CONFIG ================= */

const MEMORY_PATH =
  (process.env.AI_MEMORY_PATH && String(process.env.AI_MEMORY_PATH).trim()) ||
  "/tmp/autoshield_brain.json";

const MAX_TOTAL = Number(process.env.AI_MEMORY_MAX_ITEMS || 600);

const MAX_PER_TYPE = {
  site: 50,
  rule: 50,
  preference: 100,
  note: 200,
  trade_event: 300,
};

/* ================= HELPERS ================= */

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v, max = 8000) {
  return String(v ?? "").trim().slice(0, max);
}

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

/* ================= VOICE REGISTRY ================= */
/**
 * These voices NEVER reset.
 * VoiceAI + ai.routes.js can reference them by ID.
 */

const VOICES = {
  alex: {
    id: "alex",
    name: "Alex",
    role: "Primary Operator",
    tone: "calm, confident, direct, present-tense",
    description:
      "Explains what is happening right now. Live trading, live incidents, real-time awareness.",
  },

  jordan: {
    id: "jordan",
    name: "Jordan",
    role: "Analyst / Explainer",
    tone: "clear, patient, educational",
    description:
      "Explains why things happened. Breaks down decisions step by step without assumptions.",
  },

  morgan: {
    id: "morgan",
    name: "Morgan",
    role: "Risk & Compliance",
    tone: "conservative, factual, policy-driven",
    description:
      "Focuses on limits, drawdowns, exposure, and rules. Never emotional.",
  },

  taylor: {
    id: "taylor",
    name: "Taylor",
    role: "Systems & Security",
    tone: "technical, precise, human",
    description:
      "Explains systems, attacks, signals, infrastructure, and platform health.",
  },

  casey: {
    id: "casey",
    name: "Casey",
    role: "Executive Summary",
    tone: "high-level, calm, strategic",
    description:
      "Summarizes activity for leadership. No jargon unless asked.",
  },
};

/* ================= STATE ================= */

let state = {
  version: 3,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  items: [],
};

/* ================= LOAD / SAVE ================= */

function load() {
  try {
    ensureDirFor(MEMORY_PATH);
    if (!fs.existsSync(MEMORY_PATH)) return;

    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf-8"));
    if (raw && Array.isArray(raw.items)) {
      state = {
        version: raw.version || 3,
        createdAt: raw.createdAt || nowIso(),
        updatedAt: raw.updatedAt || nowIso(),
        items: raw.items.slice(-MAX_TOTAL),
      };
    }
  } catch {
    state = {
      version: 3,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: [],
    };
  }
}

function save() {
  try {
    ensureDirFor(MEMORY_PATH);
    state.updatedAt = nowIso();

    if (state.items.length > MAX_TOTAL) {
      state.items = state.items.slice(-MAX_TOTAL);
    }

    const tmp = MEMORY_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, MEMORY_PATH);
  } catch {}
}

load();

/* ================= MEMORY ================= */

function addMemory({ type = "note", text = "", meta = {} } = {}) {
  const t = safeStr(type, 40).toLowerCase();
  const txt = safeStr(text, 8000);
  if (!txt) return null;

  const rec = {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: t,
    text: txt,
    meta: meta && typeof meta === "object" ? meta : {},
    iso: nowIso(),
  };

  state.items.unshift(rec);

  const cap = MAX_PER_TYPE[t] || 100;
  const sameType = state.items.filter((m) => m.type === t);
  if (sameType.length > cap) {
    const removeIds = sameType.slice(cap).map((m) => m.id);
    state.items = state.items.filter((m) => !removeIds.includes(m.id));
  }

  save();
  return rec;
}

function listMemory({ limit = 50, type = null } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const t = type ? safeStr(type, 40).toLowerCase() : null;

  let items = state.items;
  if (t) items = items.filter((x) => x.type === t);

  return items.slice(0, n);
}

/* ================= PERSONALITY ================= */
/**
 * Builds personality per VOICE.
 * This is what ai.routes.js should feed into OpenAI/system prompts.
 */

function buildPersonality(voiceId = "alex") {
  const voice = VOICES[voiceId] || VOICES.alex;

  return {
    identity: voice.name,
    role: voice.role,
    tone: voice.tone,
    description: voice.description,

    rules: listMemory({ type: "rule", limit: 20 }).map((m) => m.text),
    preferences: listMemory({ type: "preference", limit: 20 }).map((m) => m.text),
    platformFacts: listMemory({ type: "site", limit: 20 }).map((m) => m.text),
  };
}

/* ================= VOICE API ================= */

function listVoices() {
  return Object.values(VOICES);
}

function getVoice(id) {
  return VOICES[id] || VOICES.alex;
}

/* ================= EXPORT ================= */

module.exports = {
  // memory
  addMemory,
  listMemory,

  // voice + personality
  buildPersonality,
  listVoices,
  getVoice,
};
