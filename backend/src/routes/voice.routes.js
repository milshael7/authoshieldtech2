// backend/src/routes/voice.routes.js
// Optional server-side TTS bridge (for “real voice” vs device robot voices)
//
// If you configure a provider (example: OpenAI), the frontend can fetch an audio file.
// If not configured, this returns a clear 501 message so nothing breaks silently.

const express = require('express');
const router = express.Router();

function cleanStr(v, max = 6000) {
  return String(v || '').trim().slice(0, max);
}

// GET /api/voice/status
router.get('/status', (req, res) => {
  return res.json({
    ok: true,
    configured: !!process.env.OPENAI_API_KEY,
    provider: process.env.VOICE_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : null),
    model: process.env.OPENAI_TTS_MODEL || null,
    time: new Date().toISOString()
  });
});

// POST /api/voice/tts
// Body: { text, voice?, format? }
// Returns: audio bytes (mp3 by default)
router.post('/tts', async (req, res) => {
  try {
    const provider = (process.env.VOICE_PROVIDER || '').trim().toLowerCase() || 'openai';
    const text = cleanStr(req.body?.text, 8000);
    const voice = cleanStr(req.body?.voice, 50) || (process.env.OPENAI_TTS_VOICE || 'alloy');
    const format = cleanStr(req.body?.format, 20) || 'mp3';

    if (!text) return res.status(400).json({ ok: false, error: 'Missing text' });

    // If no provider configured, fail clearly (frontend can fall back to SpeechSynthesis)
    if (provider !== 'openai') {
      return res.status(501).json({
        ok: false,
        error: 'Voice provider not configured',
        detail: 'Set VOICE_PROVIDER=openai (or implement another provider).'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(501).json({
        ok: false,
        error: 'OPENAI_API_KEY missing',
        detail: 'Set OPENAI_API_KEY on backend to enable server-side voice.'
      });
    }

    // NOTE:
    // - Model name is configurable via env so you’re not locked into a specific one.
    // - This route uses Node's built-in fetch (Node 18+).
    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';

    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        format,
        input: text,
      })
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      return res.status(502).json({
        ok: false,
        error: 'TTS provider error',
        detail: errTxt || `HTTP ${r.status}`
      });
    }

    const buf = Buffer.from(await r.arrayBuffer());

    const mime =
      format === 'wav' ? 'audio/wav' :
      format === 'aac' ? 'audio/aac' :
      format === 'opus' ? 'audio/ogg' :
      'audio/mpeg';

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
