// backend/src/routes/ai.routes.js
// “Brain chat” endpoint used by Trading.jsx + VoiceAI.jsx
// Fixes the issue where AI keeps repeating the same generic line.
// This is a local rule-based explainer (no external AI calls needed).

const express = require('express');
const router = express.Router();

// If you want to lock this to signed-in users only, uncomment:
// const { authRequired } = require('../middleware/auth');

// Small helpers
function n(x) {
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

function money(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '$0.00';
  const sign = v < 0 ? '-' : '';
  const ax = Math.abs(v);
  return `${sign}$${ax.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function pct(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '0%';
  return `${(v * 100).toFixed(0)}%`;
}

function normalizeText(s) {
  return String(s || '').trim().toLowerCase();
}

function getPaper(ctx) {
  const paper = ctx?.paper || {};
  // Trading.jsx already sends a compact “paper” object sometimes.
  // VoiceAI sends full “paper”.
  const realized = paper.realized || {};
  const costs = paper.costs || {};
  const learnStats = paper.learnStats || paper.learn || {};

  return {
    running: !!paper.running,
    balance: n(paper.balance),
    pnl: n(paper.pnl),
    wins: n(realized.wins ?? paper.wins),
    losses: n(realized.losses ?? paper.losses),
    grossProfit: n(realized.grossProfit ?? paper.grossProfit),
    grossLoss: n(realized.grossLoss ?? paper.grossLoss),
    net: n(realized.net ?? paper.net ?? paper.pnl),
    feePaid: n(costs.feePaid ?? paper.feePaid),
    slippageCost: n(costs.slippageCost ?? paper.slippageCost),
    spreadCost: n(costs.spreadCost ?? paper.spreadCost),
    ticksSeen: n(learnStats.ticksSeen ?? paper.ticksSeen),
    confidence: n(learnStats.confidence ?? paper.confidence),
    decision: String(learnStats.decision ?? paper.decision ?? 'WAIT'),
    reason: String(learnStats.lastReason ?? paper.decisionReason ?? '—'),
  };
}

function buildReply(message, ctx) {
  const text = normalizeText(message);
  const symbol = String(ctx?.symbol || 'BTCUSD');
  const mode = String(ctx?.mode || 'Paper');
  const last = n(ctx?.last);

  const p = getPaper(ctx);

  // Common “dashboard” summary
  const summary = [
    `Mode: ${mode} • Symbol: ${symbol}${last ? ` • Last: $${last.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}`,
    `Paper Balance: ${money(p.balance)} • Net P&L: ${money(p.net)}`,
    `Wins: ${p.wins} • Losses: ${p.losses}`,
    `Confidence: ${pct(p.confidence)} • Decision: ${p.decision} • Reason: ${p.reason}`,
    `Costs: Fees ${money(p.feePaid)} • Slippage ${money(p.slippageCost)} • Spread ${money(p.spreadCost)}`
  ].join('\n');

  // Help / capabilities
  if (!text || text === 'help' || text.includes('what can you do') || text.includes('commands')) {
    return [
      `I can explain what the trading brain is doing in real time.`,
      ``,
      `Try asking:`,
      `• "why did you enter?"`,
      `• "why did you sell?"`,
      `• "how many wins and losses?"`,
      `• "what is net p&l?"`,
      `• "what fees did we pay?"`,
      `• "what is the confidence and reason?"`,
      ``,
      summary
    ].join('\n');
  }

  // Why enter / sell / decision?
  if (text.includes('why') && (text.includes('enter') || text.includes('buy') || text.includes('bought'))) {
    return [
      `Entry logic (BUY) only happens when:`,
      `• Warmup ticks reached (learning finished enough)`,
      `• Confidence is high enough`,
      `• Trend edge passes threshold`,
      `• Cooldown passed, daily limits not hit`,
      ``,
      `Right now: Decision = ${p.decision}, Reason = ${p.reason}, Confidence = ${pct(p.confidence)}.`,
      ``,
      summary
    ].join('\n');
  }

  if (text.includes('why') && (text.includes('sell') || text.includes('exit'))) {
    return [
      `Exit logic (SELL) triggers on Take-Profit or Stop-Loss.`,
      `Your backend logs "take_profit" or "stop_loss" in the trade note.`,
      ``,
      `Right now: Decision = ${p.decision}, Reason = ${p.reason}.`,
      ``,
      summary
    ].join('\n');
  }

  // Wins/losses
  if (text.includes('win') || text.includes('loss') || text.includes('wins') || text.includes('losses')) {
    return [
      `Wins: ${p.wins}`,
      `Losses: ${p.losses}`,
      `Total Gain: ${money(p.grossProfit)}`,
      `Total Loss: ${money(p.grossLoss)}`,
      `Net P&L: ${money(p.net)}`,
      ``,
      summary
    ].join('\n');
  }

  // Profit / pnl / balance
  if (text.includes('p&l') || text.includes('pnl') || text.includes('profit') || text.includes('balance')) {
    return [
      `Paper Balance: ${money(p.balance)}`,
      `Net P&L: ${money(p.net)}`,
      `Wins/Losses: ${p.wins}/${p.losses}`,
      ``,
      summary
    ].join('\n');
  }

  // Fees / costs
  if (text.includes('fee') || text.includes('fees') || text.includes('slippage') || text.includes('spread') || text.includes('cost')) {
    return [
      `Costs so far:`,
      `• Fees Paid: ${money(p.feePaid)}`,
      `• Slippage Cost: ${money(p.slippageCost)}`,
      `• Spread Cost: ${money(p.spreadCost)}`,
      ``,
      `If fees are dominating, increase minimum trade size OR lower fee rate in env vars.`,
      ``,
      summary
    ].join('\n');
  }

  // Confidence / learning / warmup
  if (text.includes('confidence') || text.includes('learning') || text.includes('warmup') || text.includes('ticks')) {
    return [
      `Learning status:`,
      `• Ticks Seen: ${p.ticksSeen}`,
      `• Confidence: ${pct(p.confidence)}`,
      `• Decision: ${p.decision}`,
      `• Reason: ${p.reason}`,
      ``,
      summary
    ].join('\n');
  }

  // Default: answer with a useful overview + prompt follow-up
  return [
    `I got you. Here’s what I see right now:`,
    ``,
    summary,
    ``,
    `Ask me something specific like: "why is confidence low?" or "how much fees did we pay?"`
  ].join('\n');
}

// POST /api/ai/chat
router.post('/chat', /* authRequired, */ (req, res) => {
  try {
    const message = req.body?.message || '';
    const context = req.body?.context || {};

    const reply = buildReply(message, context);
    return res.json({ ok: true, reply });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e || 'AI route error')
    });
  }
});

// Optional quick check
router.get('/status', (req, res) => {
  res.json({ ok: true, name: 'autoprotect-ai', time: new Date().toISOString() });
});

module.exports = router;
