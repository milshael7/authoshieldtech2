// backend/src/routes/posture.routes.js
const express = require('express');
const router = express.Router();

/**
 * ✅ IMPORTANT:
 * This route expects your auth system to already attach the logged-in user to req.user.
 * If your project uses a different pattern (ex: req.userId, req.auth, etc),
 * tell me what you see inside backend/src/routes/me.routes.js and I’ll match it exactly.
 */

// GET /api/posture/me
router.get('/me', async (req, res) => {
  try {
    // If your auth middleware sets req.user, keep this.
    // If not, you’ll get 401 until we wire it to your auth guard.
    const me = req.user || null;
    if (!me) {
      return res.status(401).json({ ok: false, error: 'Not signed in' });
    }

    // ✅ MVP posture model (we’ll make it “real” once we start collecting signals)
    // This gives you the “official-looking” panel for every room.
    const risk = me.autoprotectEnabled ? 'low' : 'medium';
    const score = me.autoprotectEnabled ? 86 : 62;

    return res.json({
      ok: true,
      me: {
        id: me.id,
        role: me.role,
        autoprotectEnabled: !!me.autoprotectEnabled,
      },
      posture: {
        score,
        risk,
        factors: [
          { key: 'autoprotect', label: 'AutoProtect', value: me.autoprotectEnabled ? 'enabled' : 'disabled' },
          { key: 'mfa', label: 'MFA', value: 'next' },
          { key: 'device', label: 'Device health', value: 'next' },
        ],
      },
      recent: {
        alerts: [
          // leave empty for now; later we’ll fill with real detections + audit trail
        ],
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

module.exports = router;
