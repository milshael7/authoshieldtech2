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

const paperTrader = require('./services/paperTrader');
const { startKrakenFeed } = require('./services/krakenFeed');

ensureDb();
if(!process.env.JWT_SECRET){
  console.error("Missing required env var: JWT_SECRET");
  process.exit(1);
}
users.ensureAdminFromEnv();

const app = express();

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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATELIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (req, res) =>
  res.json({ ok: true, name: 'autoshield-tech-backend', time: new Date().toISOString() })
);

// routes
app.use('/api/auth', authLimiter, require('./routes/auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/manager', require('./routes/manager.routes'));
app.use('/api/company', require('./routes/company.routes'));
app.use('/api/me', require('./routes/me.routes'));
app.use('/api/trading', require('./routes/trading.routes'));
app.use('/api/ai', require('./routes/ai.routes'));

app.use('/api/live', require('./routes/live.routes'));

// ✅ NEW: paper routes (status/config/reset)
app.use('/api/paper', require('./routes/paper.routes'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/market' });

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

// start paper engine
paperTrader.start();

// start feed
startKrakenFeed({
  onStatus: (s) => console.log('[kraken]', s),
  onTick: (tick) => {
    last[tick.symbol] = tick.price;
    paperTrader.tick(tick.symbol, tick.price, tick.ts);
    broadcast(tick);
  }
});

const port = process.env.PORT || 5000;
server.listen(port, () => console.log('AutoShield Tech backend on', port));
