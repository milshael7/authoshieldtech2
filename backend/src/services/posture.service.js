// backend/src/services/posture.service.js
// Posture = the "security dashboard snapshot" for Individual / Company / Manager rooms.
// Keep it simple + safe for MVP (no secrets, no raw logs dumped).

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function summarizeFromDbOrFallback({ userId, role }) {
  // ✅ MVP: if you later have DB tables (events, alerts, cases), replace this with real queries.
  // For now we return a stable, believable structure so UI can render consistently.

  const now = Date.now();

  // pretend-ish values so UI has data (replace later)
  const baseUsers = 1;
  const baseCompanies = role === 'Company' ? 1 : 0;

  return {
    ok: true,
    at: now,

    // who is asking
    viewer: { userId, role },

    // overall security posture (top KPIs)
    posture: {
      score: 82,                         // 0-100
      risk: "medium",                    // low | medium | high
      activeAlerts: 1,
      openCases: 1,
      blockedAttempts24h: 2,
      phishingReports30d: 1,
      malwareSignals30d: 0,
      accountTakeoverSignals30d: 0
    },

    // “rooms” data
    manager: {
      users: baseUsers,
      companies: baseCompanies,
      auditEvents: 0,
      notifications: 0
    },

    // optional lists (keep small for now)
    recent: {
      alerts: [
        {
          id: "al_1",
          title: "Suspicious login pattern",
          severity: "warn",
          createdAt: now - 60 * 60 * 1000,
          message: "Multiple login attempts detected from a new device fingerprint."
        }
      ],
      cases: [
        {
          id: "case_1",
          title: "Reported phishing email",
          status: "Open",
          createdAt: now - 2 * 60 * 60 * 1000
        }
      ]
    }
  };
}

function getMyPosture({ user }) {
  return summarizeFromDbOrFallback({ userId: user?.id || user?._id || "unknown", role: user?.role || "Individual" });
}

function getCompanyPosture({ user }) {
  return summarizeFromDbOrFallback({ userId: user?.id || user?._id || "unknown", role: "Company" });
}

function getManagerPosture({ user }) {
  // Manager sees “overview style” numbers too
  const out = summarizeFromDbOrFallback({ userId: user?.id || user?._id || "unknown", role: "Manager" });
  out.manager = {
    users: 12,
    companies: 3,
    auditEvents: 45,
    notifications: 8
  };
  out.posture.score = clamp(out.posture.score + 5, 0, 100);
  out.posture.risk = "medium";
  return out;
}

module.exports = {
  getMyPosture,
  getCompanyPosture,
  getManagerPosture
};
