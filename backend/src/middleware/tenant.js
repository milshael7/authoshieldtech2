// backend/src/middleware/tenant.js
// AuthoDev 6.5 — Company / Tenant Isolation Core
// MSP-grade • AI-aware • Non-resetting context

/**
 * PURPOSE
 * - Resolve company (tenant) for every request
 * - Attach a single, trusted req.tenant object
 * - Used by:
 *   - AI (brain, voice, text panels)
 *   - Cybersecurity rooms
 *   - Trading rooms
 *   - Dashboards & logs
 *
 * Tenant resolution order:
 * 1) Auth token (req.user.companyId)  ✅ primary
 * 2) x-company-id header              (admin / API)
 * 3) subdomain                        (future-ready)
 */

function clean(v, max = 100) {
  return String(v ?? "").trim().slice(0, max);
}

function resolveFromSubdomain(req) {
  const host = clean(req.headers.host);
  if (!host) return null;

  // example: acme.autoshield.com
  const parts = host.split(".");
  if (parts.length < 3) return null;

  return clean(parts[0], 50);
}

function tenantMiddleware(req, res, next) {
  let companyId = null;

  /* ================= RESOLUTION ================= */

  // 1️⃣ Authenticated user (preferred)
  if (req.user?.companyId) {
    companyId = clean(req.user.companyId, 50);
  }

  // 2️⃣ Explicit header (admin tools, internal APIs)
  if (!companyId && req.headers["x-company-id"]) {
    companyId = clean(req.headers["x-company-id"], 50);
  }

  // 3️⃣ Subdomain (future expansion)
  if (!companyId) {
    companyId = resolveFromSubdomain(req);
  }

  if (!companyId) {
    return res.status(400).json({
      ok: false,
      error: "Company context missing",
      hint: "Authenticate or provide x-company-id",
    });
  }

  /* ================= TENANT CONTEXT ================= */

  /**
   * 🔒 SINGLE SOURCE OF TRUTH
   * Everything downstream MUST read from req.tenant
   */
  req.tenant = {
    id: companyId,

    // user context
    userId: req.user?.id || null,
    role: req.user?.role || "user",

    // scope flags (used later by AI + rooms)
    scope: {
      isCompany: true,
      isUser: !!req.user,
    },

    // AI brain partition key (non-resetting memory)
    brainKey: `company:${companyId}`,

    // audit helpers
    resolvedFrom: req.user?.companyId
      ? "auth"
      : req.headers["x-company-id"]
      ? "header"
      : "subdomain",
  };

  next();
}

module.exports = tenantMiddleware;
