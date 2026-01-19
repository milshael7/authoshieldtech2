// backend/src/services/krakenFeed.js
const WebSocket = require('ws');

/**
 * Connects to Kraken public WS and streams last prices.
 * Emits ticks: { type:'tick', symbol:'BTCUSDT'|..., price:Number, ts:Number }
 * No API keys required (public market data).
 */
function startKrakenFeed({ onTick, onStatus }) {
  const URL = 'wss://ws.kraken.com';

  // ✅ 10 well-known / “expensive” / top coins (USD pairs on Kraken)
  // Note: Symbol names are INTERNAL to your app. Prices are USD from Kraken ticker.
  const PAIRS = [
    'XBT/USD', // BTC
    'ETH/USD', // ETH
    'SOL/USD', // SOL
    'XRP/USD', // XRP
    'ADA/USD', // ADA
    'DOT/USD', // DOT
    'LINK/USD', // LINK
    'LTC/USD', // LTC
    'BCH/USD', // BCH
    'XLM/USD', // XLM
  ];

  const MAP = {
    'XBT/USD': 'BTCUSDT',
    'ETH/USD': 'ETHUSDT',
    'SOL/USD': 'SOLUSDT',
    'XRP/USD': 'XRPUSDT',
    'ADA/USD': 'ADAUSDT',
    'DOT/USD': 'DOTUSDT',
    'LINK/USD': 'LINKUSDT',
    'LTC/USD': 'LTCUSDT',
    'BCH/USD': 'BCHUSDT',
    'XLM/USD': 'XLMUSDT',
  };

  let ws = null;
  let closedByUs = false;

  let reconnectTimer = null;
  let backoffMs = 1500;

  let lastMsgAt = 0;
  let watchdog = null;

  function safeStatus(s) {
    try { onStatus && onStatus(s); } catch {}
  }

  function clearTimers() {
    try { if (watchdog) clearInterval(watchdog); } catch {}
    watchdog = null;

    try { if (reconnectTimer) clearTimeout(reconnectTimer); } catch {}
    reconnectTimer = null;
  }

  function cleanupSocket() {
    try { if (ws) ws.removeAllListeners(); } catch {}
    ws = null;
  }

  function scheduleReconnect() {
    if (closedByUs) return;

    safeStatus('reconnecting');
    const wait = backoffMs;
    backoffMs = Math.min(Math.floor(backoffMs * 1.4), 15000); // cap 15s

    clearTimers();
    reconnectTimer = setTimeout(connect, wait);
  }

  function connect() {
    clearTimers();
    cleanupSocket();

    safeStatus('connecting');
    ws = new WebSocket(URL);

    ws.on('open', () => {
      safeStatus('connected');
      backoffMs = 1500; // reset after success
      lastMsgAt = Date.now();

      // Subscribe to ticker
      try {
        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: PAIRS,
          subscription: { name: 'ticker' }
        }));
      } catch {}
    });

    ws.on('message', (buf) => {
      lastMsgAt = Date.now();

      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      // Events are objects: subscribeStatus, heartbeat, systemStatus
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) return;

      // Data messages are arrays: [channelId, data, channelName, pair]
      if (!Array.isArray(msg)) return;

      const data = msg[1];
      const pair = msg[3];
      if (!data || !pair) return;

      // Ticker "c" is last trade closed: ["price", "lot volume"]
      const lastStr = data?.c?.[0];
      const price = Number(lastStr);
      if (!Number.isFinite(price)) return;

      const symbol = MAP[pair] || pair;
      const tick = { type: 'tick', symbol, price, ts: Date.now() };

      try { onTick && onTick(tick); } catch {}
    });

    ws.on('close', () => {
      safeStatus('closed');
      if (closedByUs) return;
      scheduleReconnect();
    });

    ws.on('error', () => {
      safeStatus('error');
      try { ws && ws.close(); } catch {}
      // close handler schedules reconnect
    });

    // Watchdog: if no messages for 20s, force reconnect
    watchdog = setInterval(() => {
      if (closedByUs) return;
      const age = Date.now() - (lastMsgAt || 0);
      if (age > 20000) {
        safeStatus('error');
        try { ws && ws.terminate(); } catch {}
      }
    }, 5000);
  }

  connect();

  return {
    stop() {
      closedByUs = true;

      // ✅ FIX: close socket BEFORE cleanup (your old stop() cleaned ws first)
      try { ws && ws.close(); } catch {}

      clearTimers();
      cleanupSocket();
    }
  };
}

module.exports = { startKrakenFeed };
