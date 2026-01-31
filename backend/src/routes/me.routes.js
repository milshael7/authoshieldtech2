// backend/src/routes/me.routes.js
// Me endpoints (Individual user room):
// - notifications (scoped to the logged-in user)
// - mark notification read (scoped safety)
// - create project/case (AutoProtect)

const express = require('express');
const router = express.Router();

const { authRequired } = require('../middleware/auth');
const { listNotifications, markRead } = require('../lib/notify');
const { createProject } = require('../autoprotect/autoprotect.service');

router.use(authRequired);

// GET /api/me/notifications
router.get('/notifications', (req, res) => {
  try {
    return res.json(listNotifications({ userId: req.user.id }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/me/notifications/:id/read
router.post('/notifications/:id/read', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing notification id' });

    // ✅ Uses new notify.js signature (scope-safe)
    const n = markRead(id, req.user.id);
    if (!n) return res.status(404).json({ error: 'Not found' });

    return res.json(n);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// POST /api/me/projects
router.post('/projects', (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();

    const issue = body.issue || {};
    const issueType = String(issue.type || '').trim();
    const details = typeof issue.details === 'string' ? issue.details : '';

    if (!title) return res.status(400).json({ error: 'Missing title' });
    if (!issueType) return res.status(400).json({ error: 'Missing issue.type' });

    const companyId =
      body.companyId != null
        ? (String(body.companyId || '').trim() || null)
        : (req.user.companyId || null);

    const p = createProject({
      actorId: req.user.id,
      companyId,
      title,
      issue: { type: issueType, details }
    });

    return res.status(201).json(p);
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
