require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { WebSocketServer } = require('ws');

const { ensureDb } = require('./lib/db');
const users = require('./users/user.service');

// ✅ Kraken live feed
const { startKrakenFeed } = require('./services/krakenFeed');

// ✅ Paper trader
const paperTrader = require('./services/paperTrader');

function requireEnv(name){
  if(!process.env[name]){
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

ensureDb();
requireEnv('JWT_SECRET');
users.ensureAdminFromEnv();

const app = express();

// --- CORS allowlist (set CORS_ORIGINS="https://a.com,https://b.com") ---
const allowlist = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowlist.length === 0) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  credentials: true
}));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// --- Rate limit auth endpoints ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATELIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (req, res) =>
  res.json({ ok: true, name: 'autoshield-tech-backend', time: new Date().toISOString() })
);

app.use('/api/auth', authLimiter, require('./routes/auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/manager', require('./routes/manager.routes'));
app.use('/api/company', require('./routes/company.routes'));
app.use('/api/me', require('./routes/me.routes'));
app.use('/api/trading', require('./routes/trading.routes'));
app.use('/api/ai', require('./routes/ai.routes'));

// ✅ Paper status endpoint (frontend reads this)
app.get('/api/paper/status', (req, res) => {
  res.json(paperTrader.snapshot());
});

// --- WebSocket server: frontend connects here ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/market' });

// Keep last known prices
let last = { BTCUSDT: 65000, ETHUSDT: 3500 };

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(payload); } catch {}
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', symbols: Object.keys(last), last, ts: Date.now() }));
});

// ✅ Start paper trader
paperTrader.start();

// ✅ Start Kraken feed and broadcast ticks + feed paper trader
startKrakenFeed({
  onStatus: (s) => console.log('[kraken]', s),
  onTick: (tick) => {
    // tick: {type:'tick', symbol:'BTCUSDT', price, ts}
    last[tick.symbol] = tick.price;

    // send to frontend
    broadcast(tick);

    // ✅ feed into paper trader learning + decisions
    paperTrader.tick(tick.symbol, tick.price, tick.ts);
  }
});

const port = process.env.PORT || 5000;
server.listen(port, () => console.log('AutoShield Tech backend on', port));
