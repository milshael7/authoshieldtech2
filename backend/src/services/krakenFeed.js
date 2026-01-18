// src/services/krakenFeed.js
const WebSocket = require('ws');

/**
 * Connects to Kraken public WS and streams last prices.
 * Emits ticks as: { symbol: "BTCUSDT" | "ETHUSDT", price: Number, ts: Number }
 *
 * No API key required (public market data).
 */
function startKrakenFeed({ onTick, onStatus }) {
  const URL = 'wss://ws.kraken.com';
  let ws = null;
  let closedByUs = false;
  let reconnectTimer = null;

  const PAIRS = ['XBT/USD', 'ETH/USD'];
  const MAP = {
    'XBT/USD': 'BTCUSDT',
    'ETH/USD': 'ETHUSDT',
  };

  function logStatus(s) {
    try { onStatus && onStatus(s); } catch {}
  }

  function connect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    logStatus('connecting');

    ws = new WebSocket(URL);

    ws.on('open', () => {
      logStatus('connected');
      ws.send(JSON.stringify({
        event: 'subscribe',
        pair: PAIRS,
        subscription: { name: 'ticker' }
      }));
    });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      // Kraken sends events as objects, data as arrays
      if (msg?.event) return; // subscribeStatus, heartbeat, systemStatus, etc.
      if (!Array.isArray(msg)) return;

      // Format: [channelId, data, channelName, pair]
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
      logStatus('closed');
      if (closedByUs) return;
      reconnectTimer = setTimeout(connect, 1500);
    });

    ws.on('error', () => {
      logStatus('error');
      try { ws.close(); } catch {}
    });
  }

  connect();

  return {
    stop() {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch {}
    }
  };
}

module.exports = { startKrakenFeed };
