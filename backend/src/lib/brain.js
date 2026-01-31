// backend/src/lib/brain.js
// Simple persistent memory store for AI routes
// - addMemory({type, text, meta})
// - listMemory({limit, type})
// Persisted to disk via AI_MEMORY_PATH (or /tmp/ai_memory.json)

const fs = require("fs");
const path = require("path");

const MEMORY_PATH =
  (process.env.AI_MEMORY_PATH && String(process.env.AI_MEMORY_PATH).trim()) ||
  "/tmp/ai_memory.json";

const MAX_ITEMS = Number(process.env.AI_MEMORY_MAX_ITEMS || 400);

function ensureDirFor(filePath) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function safeStr(v, max = 8000) {
  return String(v ?? "").trim().slice(0, max);
}

function nowIso() {
  return new Date().toISOString();
}

let state = { version: 1, createdAt: nowIso(), updatedAt: nowIso(), items: [] };

function load() {
  try {
    ensureDirFor(MEMORY_PATH);
    if (!fs.existsSync(MEMORY_PATH)) return;
    const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    if (parsed && Array.isArray(parsed.items)) {
      state = {
        version: parsed.version || 1,
        createdAt: parsed.createdAt || nowIso(),
        updatedAt: parsed.updatedAt || nowIso(),
        items: parsed.items.slice(-MAX_ITEMS),
      };
    }
  } catch {
    // never crash server due to memory persistence
  }
}

function save() {
  try {
    ensureDirFor(MEMORY_PATH);
    state.updatedAt = nowIso();

    // keep bounded
    if (state.items.length > MAX_ITEMS) {
      state.items = state.items.slice(-MAX_ITEMS);
    }

    const tmp = MEMORY_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, MEMORY_PATH);
  } catch {}
}

load();

function addMemory({ type = "site", text = "", meta = {} } = {}) {
  const rec = {
    id: String(Date.now()) + "_" + Math.random().toString(16).slice(2),
    ts: Date.now(),
    iso: nowIso(),
    type: safeStr(type, 40) || "site",
    text: safeStr(text, 8000),
    meta: meta && typeof meta === "object" ? meta : {},
  };

  if (!rec.text) return null;

  state.items.push(rec);
  save();
  return rec;
}

function listMemory({ limit = 50, type = null } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const t = type ? safeStr(type, 40).toLowerCase() : null;

  let items = state.items.slice();
  if (t) items = items.filter((x) => String(x.type || "").toLowerCase() === t);

  // newest first
  items = items.slice().reverse();
  return items.slice(0, n);
}

module.exports = { addMemory, listMemory };
