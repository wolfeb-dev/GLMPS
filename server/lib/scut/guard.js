// server/lib/scut/guard.js
// Inbound identity gate for SCUT: an @mention must be on the allowlist
// before it is allowed to become a launch prompt or a steer note.
//
// This module deliberately does NOT poison-scan the mention text, and it
// must not gain one back. GLMPS already scans every ticket SCUT files, at
// intake: classifyTrust('scut') resolves to external trust, scanTicket flags
// the content, and a flagged ticket is quarantined with a poison alert and a
// real release path, POST /api/backlog/:id/approve (see
// server/lib/governance/poison-scan.js). A scan HERE would run strictly EARLIER, before
// any ticket exists, so a flagged mention would produce no ticket, no alert
// and no approve route - just a bare rejection with nothing an operator
// could act on. Blocking sooner is worse than the gate it would pre-empt,
// not better.
//
// If you are about to add a scan back to this file: don't. Let the mention
// become a ticket and let the existing quarantine/approve flow (which
// already exists and already works) handle the content risk.
export function makeGuard({ isAllowed } = {}) {
  const allow = typeof isAllowed === 'function' ? isAllowed : () => false; // fail-closed
  return {
    check(ctx) {
      if (!allow(ctx?.user)) return { allowed: false, reason: 'not-authorized' };
      return { allowed: true };
    },
  };
}
