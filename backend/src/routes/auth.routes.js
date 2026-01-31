// backend/src/routes/auth.routes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { sign } = require('../auth/jwt');
const users = require('../users/user.service');
const { audit } = require('../lib/audit');

function cleanEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function cleanStr(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

router.post('/login', (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = cleanStr(req.body?.password, 500);

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const u = users.findByEmail(email);
    if (!u) return res.status(401).json({ error: 'Invalid credentials' });

    // passwordHash is stored on raw user record (not sanitized)
    if (!u.passwordHash || !bcrypt.compareSync(password, u.passwordHash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (u.subscriptionStatus === users.SUBSCRIPTION.LOCKED) {
      return res.status(403).json({ error: 'Account locked' });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'Server misconfigured (JWT_SECRET missing)' });
    }

    const token = sign(
      { id: u.id, role: u.role, companyId: u.companyId || null },
      process.env.JWT_SECRET,
      '7d'
    );

    audit({ actorId: u.id, action: 'LOGIN', targetType: 'Session', targetId: u.id });

    res.json({
      token,
      user: {
        id: u.id,
        role: u.role,
        email: u.email,
        companyId: u.companyId || null,
        mustResetPassword: !!u.mustResetPassword,
        subscriptionStatus: u.subscriptionStatus,

        // ✅ frontend-friendly name + supports your DB schema typo
        autoprotectEnabled: !!(u.autoprotectEnabled || u.autoprotechEnabled),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

router.post('/reset-password', (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const newPassword = cleanStr(req.body?.newPassword, 500);

    if (!email || !newPassword) {
      return res.status(400).json({ error: 'Email and newPassword required' });
    }

    // basic minimum (you can raise later)
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const u = users.findByEmail(email);
    if (!u) return res.status(404).json({ error: 'User not found' });

    if (!u.mustResetPassword) {
      return res.status(400).json({ error: 'Reset not required' });
    }

    // actorId = user themselves here (MVP)
    users.setPassword(u.id, newPassword, u.id);

    audit({ actorId: u.id, action: 'PASSWORD_RESET', targetType: 'User', targetId: u.id });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

module.exports = router;
