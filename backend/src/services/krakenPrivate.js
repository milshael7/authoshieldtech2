// backend/src/services/krakenPrivate.js
// Kraken Private REST API helper (signed requests)
// NOTE: Funds stay on Kraken. This verifies keys + reads balances + (optionally) places orders
// Safety locks: LIVE_TRADING_ENABLED + LIVE_TRADE_DRY_RUN + LIVE_TRADE_ARMED

const crypto = require('crypto');

const BASE_URL = 'https://api.kraken.com';

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  return String(v).toLowerCase() === 'true';
}

function getKeysSafe() {
  const key = (process.env.KRAKEN_API_KEY || '').trim();
  const secret = (process.env.KRAKEN_API_SECRET || '').trim();
  return { key, secret, ok: !!(key && secret) };
}

function requireKeys() {
  const { key, secret, ok } = getKeysSafe();
  if (!ok) throw new Error('Missing Kraken keys (KRAKEN_API_KEY / KRAKEN_API_SECRET)');
  return { key, secret };
}

function b64ToBuf(b64) {
  return Buffer.from(b64, 'base64');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function hmacSha512(secretBuf, msgBuf) {
  return crypto.createHmac('sha512', secretBuf).update(msgBuf).digest('base64');
}

function liveConfig() {
  // 3-lock safety system
  const enabled = envBool('LIVE_TRADING_ENABLED', false);
  const dryRun = envBool('LIVE_TRADE_DRY_RUN', true);
  const armed = envBool('LIVE_TRADE_ARMED', false);
  return { enabled, dryRun, armed };
}

async function privateRequest(path, bodyObj = {}) {
  const { key, secret } = requireKeys();

  const nonce = Date.now().toString();
  const form = new URLSearchParams({ nonce, ...bodyObj }).toString();

  // Kraken signature: HMAC-SHA512( base64_decode(secret), uri_path + SHA256(nonce + POSTDATA) )
  const hash = sha256(Buffer.from(nonce + form));
  const msg = Buffer.concat([Buffer.from(path), hash]);
  const sig = hmacSha512(b64ToBuf(secret), msg);

  const url = BASE_URL + path;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'API-Key': key,
      'API-Sign': sig,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const json = await res.json().catch(() => ({}));

  // Kraken returns 200 even with errors sometimes; check both
  const errList = json?.error;
  if (!res.ok) {
    const err = errList || [`HTTP_${res.status}`];
    throw new Error(`Kraken error: ${Array.isArray(err) ? err.join(',') : String(err)}`);
  }
  if (Array.isArray(errList) && errList.length) {
    throw new Error(`Kraken error: ${errList.join(',')}`);
  }

  return json.result;
}

// ---------- Read helpers ----------
async function getBalance() {
  // returns { ZUSD:"12.34", XXBT:"0.001", ... }
  return privateRequest('/0/private/Balance', {});
}

async function getOpenOrders() {
  return privateRequest('/0/private/OpenOrders', {});
}

async function getTradeBalance() {
  // useful to show "equity" in one place (still on Kraken)
  return privateRequest('/0/private/TradeBalance', { asset: 'ZUSD' });
}

// ---------- Trading helper (Stage C) ----------
// IMPORTANT: Kraken pair naming can vary; these are common.
// You can extend this map later for more symbols.
const PAIR_MAP = {
  BTCUSDT: 'XBTUSDT',
  ETHUSDT: 'ETHUSDT',
  BTCUSD: 'XBTUSD',
  ETHUSD: 'ETHUSD',
};

// Place a MARKET order in quote currency sizing (USD/USDT).
// For market orders on Kraken, you typically provide volume in BASE units.
// To keep it simple + safe, we do a small "usd -> volume estimate" using last price from caller.
async function placeMarketOrder({ symbol, side, usd, lastPrice }) {
  const { enabled, dryRun, armed } = liveConfig();
  const { ok: keysPresent } = getKeysSafe();

  if (!enabled) {
    return { ok: false, blocked: true, reason: 'LIVE_TRADING_DISABLED' };
  }
  if (!keysPresent) {
    return { ok: false, blocked: true, reason: 'KRAKEN_KEYS_MISSING' };
  }
  if (!armed) {
    return { ok: false, blocked: true, reason: 'LIVE_NOT_ARMED' };
  }

  const s = String(symbol || '').trim();
  const pair = PAIR_MAP[s] || s;

  const dir = String(side || '').toUpperCase() === 'SELL' ? 'sell' : 'buy';

  const usdNum = Number(usd);
  if (!Number.isFinite(usdNum) || usdNum <= 0) {
    return { ok: false, blocked: true, reason: 'INVALID_USD_SIZE' };
  }

  const px = Number(lastPrice);
  if (!Number.isFinite(px) || px <= 0) {
    return { ok: false, blocked: true, reason: 'MISSING_LAST_PRICE' };
  }

  // Estimate base volume
  // Example: $50 BTC at $95k => 0.000526 BTC
  const vol = usdNum / px;

  // Kraken volume precision varies; keep a safe precision
  const volumeStr = vol.toFixed(8);

  // Dry-run: never touches Kraken
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      request: { pair, type: dir, ordertype: 'market', volume: volumeStr },
      note: 'Dry-run is ON. No order was sent to Kraken.',
    };
  }

  // Live call
  const result = await privateRequest('/0/private/AddOrder', {
    pair,
    type: dir,
    ordertype: 'market',
    volume: volumeStr,
  });

  return { ok: true, dryRun: false, result };
}

module.exports = {
  privateRequest,
  getKeysSafe,
  liveConfig,
  getBalance,
  getOpenOrders,
  getTradeBalance,
  placeMarketOrder,
};
