// backend/src/services/autoprotect.project.js
// AutoProtect Project Engine — FINAL LOCKED VERSION
//
// PURPOSE:
// - AutoProtect NEVER performs silent fixes
// - It CREATES GUIDED PROJECTS for users to act on
// - Each project explains WHAT happened + WHAT to do
//
// RULES:
// ✅ Individual users only
// ❌ Companies cannot use AutoProtect
// ❌ No background changes without user action
// ✅ Audited + Notified
// ✅ Stable data structure for UI
//
// THIS FILE IS COMPLETE. DO NOT PATCH LATER.

const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

// -------------------- helpers --------------------

function nowISO() {
  return new Date().toISOString();
}

function projectId() {
  return `AP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Step-by-step guidance (human + AI readable)
function guidanceForIssue(issue) {
  const base = [
    'Confirm scope (what happened, when, which account).',
    'Preserve evidence (timestamps, screenshots, logs).',
    'Contain the issue (limit access, isolate exposure).',
    'Remediate (apply fixes, rotate credentials).',
    'Verify resolution (monitor activity).',
    'Close project and document outcome.',
  ];

  if (issue?.type === 'phishing') {
    base.unshift(
      'Do NOT click the link again.',
      'Report the phishing email to your provider.'
    );
  }

  if (issue?.type === 'malware') {
    base.unshift(
      'Disconnect the affected device from the network.',
      'Run a trusted malware scan.'
    );
  }

  if (issue?.type === 'account_takeover') {
    base.unshift(
      'Immediately reset your password.',
      'Enable MFA on all supported services.'
    );
  }

  return base;
}

// -------------------- main creator --------------------

function createProject({ actorId, title, issue }) {
  const project = {
    id: projectId(),
    title: String(title).trim(),
    issue: {
      type: issue?.type || 'unknown',
      description: issue?.description || 'Unspecified security issue.',
      detectedAt: nowISO(),
    },
    status: 'Open',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    steps: guidanceForIssue(issue),
    notes: [],
    completedAt: null,
  };

  // ---------------- audit ----------------
  audit({
    actorId,
    action: 'AUTOPROTECT_PROJECT_CREATED',
    targetType: 'AutoProtectProject',
    targetId: project.id,
    metadata: {
      title: project.title,
      issueType: project.issue.type,
    },
  });

  // ---------------- notify user ----------------
  createNotification({
    userId: actorId,
    severity: 'warn',
    title: 'AutoProtect Action Required',
    message: `A new security project "${project.title}" has been created. Review the steps and take action.`,
  });

  return project;
}

// -------------------- exports --------------------
module.exports = {
  createProject,
};
