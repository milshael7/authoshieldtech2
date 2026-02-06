// backend/src/services/krakenPrivate.js
// Kraken Private REST API helper (signed requests)
// Funds NEVER leave Kraken unless ALL safety locks are enabled

const crypto = require("crypto");

// Node 18+ has fetch, but we guard just in case
const fetchFn = global.fetch || ((...args) =>
  import("node-fetch").then(({ default: f }) => f(...args)));

const BASE_URL = "https://api.kraken.com";

/* ------------------ ENV HELPERS ------------------ */
function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  return String(v).toLowerCase() === "true";
}

function getKeysSafe() {
  const key = (process.env.KRAKEN_API_KEY || "").trim();
  const secret = (process.env.KRAKEN_API_SECRET || "").trim();
  return { key, secret, ok: Boolean(key && secret) };
}

function requireKeys() {
  const { key, secret, ok } = getKeysSafe();
  if (!ok) {
    throw new Error(
      "Missing Kraken keys (KRAKEN_API_KEY / KRAKEN_API_SECRET)"
    );
  }
  return { key, secret };
}

/* ------------------ CRYPTO ------------------ */
function b64ToBuf(b64) {
  return Buffer.from(b64, "base64");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}

function hmacSha512(secretBuf, msgBuf) {
  return crypto.createHmac("sha512", secretBuf).update(msgBuf).digest("base64");
}

/* ------------------ NONCE (CRITICAL FIX) ------------------ */
// Kraken REQUIRES strictly increasing nonces
let lastNonce = Date.now();
function nextNonce() {
  const now = Date.now();
  lastNonce = now > lastNonce ? now : lastNonce + 1;
  return String(lastNonce);
}

/* ------------------ SAFETY LOCKS ------------------ */
function liveConfig() {
  return {
    enabled: envBool("LIVE_TRADING_ENABLED", false),
    dryRun: envBool("LIVE_TRADE_DRY_RUN", true),
    armed: envBool("LIVE_TRADE_ARMED", false),
  };
}

/* ------------------ CORE REQUEST ------------------ */
async function privateRequest(path, bodyObj = {}) {
  const { key, secret } = requireKeys();

  const nonce = nextNonce();
  const form = new URLSearchParams({ nonce, ...bodyObj }).toString();

  // Kraken signature:
  // HMAC-SHA512( base64_decode(secret), path + SHA256(nonce + POSTDATA) )
  const hash = sha256(Buffer.from(nonce + form));
  const msg = Buffer.concat([Buffer.from(path), hash]);
  const sig = hmacSha512(b64ToBuf(secret), msg);

  const res = await fetchFn(BASE_URL + path, {
    method: "POST",
    headers: {
      "API-Key": key,
      "API-Sign": sig,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("Kraken: Invalid JSON response");
  }

  // Kraken may return HTTP 200 with errors
  if (!res.ok || (Array.isArray(json.error) && json.error.length)) {
    const err =
      json?.error?.join(", ") ||
      `HTTP_${res.status} ${res.statusText}`;
    throw new Error(`Kraken error: ${err}`);
  }

  if (!json.result) {
    throw new Error("Kraken error: Empty result");
  }

  return json.result;
}

/* ------------------ READ HELPERS ------------------ */
async function getBalance() {
  return privateRequest("/0/private/Balance");
}

async function getOpenOrders() {
  return privateRequest("/0/private/OpenOrders");
}

async function getTradeBalance() {
  return privateRequest("/0/private/TradeBalance", { asset: "ZUSD" });
}

/* ------------------ PAIR MAP ------------------ */
const PAIR_MAP = {
  BTCUSDT: "XBTUSDT",
  ETHUSDT: "ETHUSDT",
  BTCUSD: "XBTUSD",
  ETHUSD: "ETHUSD",
};

function normalizePair(symbol) {
  const s = String(symbol || "").toUpperCase().replace(/[^A-Z]/g, "");
  return PAIR_MAP[s] || s;
}

/* ------------------ TRADING (SAFE) ------------------ */
async function placeMarketOrder({ symbol, side, usd, lastPrice }) {
  const { enabled, dryRun, armed } = liveConfig();
  const { ok: keysPresent } = getKeysSafe();

  if (!enabled)
    return { ok: false, blocked: true, reason: "LIVE_TRADING_DISABLED" };
  if (!keysPresent)
    return { ok: false, blocked: true, reason: "KRAKEN_KEYS_MISSING" };
  if (!armed)
    return { ok: false, blocked: true, reason: "LIVE_NOT_ARMED" };

  const pair = normalizePair(symbol);
  const dir = String(side).toUpperCase() === "SELL" ? "sell" : "buy";

  const usdNum = Number(usd);
  const px = Number(lastPrice);

  if (!Number.isFinite(usdNum) || usdNum <= 0)
    return { ok: false, blocked: true, reason: "INVALID_USD_SIZE" };
  if (!Number.isFinite(px) || px <= 0)
    return { ok: false, blocked: true, reason: "MISSING_LAST_PRICE" };

  const volume = (usdNum / px).toFixed(8);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      request: { pair, type: dir, ordertype: "market", volume },
      note: "Dry-run enabled. No Kraken order sent.",
    };
  }

  const result = await privateRequest("/0/private/AddOrder", {
    pair,
    type: dir,
    ordertype: "market",
    volume,
  });

  return { ok: true, dryRun: false, result };
}

/* ------------------ EXPORTS ------------------ */
module.exports = {
  privateRequest,
  getKeysSafe,
  liveConfig,
  getBalance,
  getOpenOrders,
  getTradeBalance,
  placeMarketOrder,
};
