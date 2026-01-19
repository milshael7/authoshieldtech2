// backend/src/services/krakenFeed.js
const WebSocket = require('ws');

/**
 * Connects to Kraken public WS and streams last prices.
 * Emits ticks: { type:'tick', symbol:'BTCUSDT'|'ETHUSDT', price:Number, ts:Number }
 * No API keys required (public market data).
 */
function startKrakenFeed({ onTick, onStatus }) {
  const URL = 'wss://ws.kraken.com';

  const PAIRS = ['XBT/USD', 'ETH/USD'];
  const MAP = { 'XBT/USD': 'BTCUSDT', 'ETH/USD': 'ETHUSDT' };

  let ws = null;
  let closedByUs = false;

  let reconnectTimer = null;
  let backoffMs = 1500;

  let lastMsgAt = 0;
  let watchdog = null;

  function safeStatus(s) {
    try { onStatus && onStatus(s); } catch {}
  }

  function cleanup() {
    try { if (watchdog) clearInterval(watchdog); } catch {}
    watchdog = null;
    try { if (reconnectTimer) clearTimeout(reconnectTimer); } catch {}
    reconnectTimer = null;
    try { if (ws) ws.removeAllListeners(); } catch {}
    ws = null;
  }

  function scheduleReconnect() {
    if (closedByUs) return;
    safeStatus('reconnecting');
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 1.4, 15000); // cap 15s
    reconnectTimer = setTimeout(connect, wait);
  }

  function connect() {
    cleanup();
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

      // Events are objects (subscribeStatus, heartbeat, systemStatus)
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
        // Kraken heartbeat event sometimes shows up here
        return;
      }

      // Data messages are arrays: [channelId, data, channelName, pair]
      if (!Array.isArray(msg)) return;

      const data = msg[1];
      const pair = msg[3];
      if (!data || !pair) return;

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
      // close handler will schedule reconnect
    });

    // Watchdog: if no messages for 20s, reconnect
    watchdog = setInterval(() => {
      if (closedByUs) return;
      const age = Date.now() - (lastMsgAt || 0);
      if (age > 20000) {
        safeStatus('error');
        try { ws && ws.terminate(); } catch {}
        // close handler -> reconnect
      }
    }, 5000);
  }

  connect();

  return {
    stop() {
      closedByUs = true;
      cleanup();
      try { ws && ws.close(); } catch {}
    }
  };
}

module.exports = { startKrakenFeed };
