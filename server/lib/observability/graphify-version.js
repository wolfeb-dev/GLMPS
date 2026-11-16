// Pure decision core for the graphify version tick.
//
// WHY THE AUDIT IS BEHAVIOURAL, NOT A CHANGELOG READ: graphify's upstream
// CHANGELOG.md stops at 0.1.8 while the package ships 0.9.51, so release notes
// cannot gate an upgrade. Two checks that CAN: does the candidate still expose
// every command we call, and does adopting it shrink any graph. The second is
// the check that would have caught the 2026-07-28 collapse (6140 nodes down to
// 55) which every freshness check of the day passed.
//
// No fs, no network, no clock. server.js injects all three.

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => Number(n) || 0);
  const pb = String(b).split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Does the candidate's --help still list every command we call? */
export function auditSurface(helpText, requiredCommands = []) {
  const text = typeof helpText === 'string' ? helpText : '';
  const missing = requiredCommands.filter(c => !new RegExp(`^\\s+${c}(\\s|$)`, 'm').test(text));
  return { ok: missing.length === 0, missing };
}

/** Did adopting the candidate shrink any graph below minRatio of its old size? */
export function auditRebuild(before, after, { minRatio = 0.8 } = {}) {
  const regressions = [];
  for (const [root, b] of Object.entries(before || {})) {
    const a = (after || {})[root];
    if (typeof a !== 'number' || a < b * minRatio) {
      regressions.push({ root, before: b, after: typeof a === 'number' ? a : null });
    }
  }
  return { ok: regressions.length === 0, regressions };
}

/** auditRebuild, but a root whose update could not even be VERIFIED (still
 * busy past a bounded wait, or any other per-root failure) is folded in as
 * a regression too -- an unchanged node count would otherwise clear the
 * ratio check and silently pass a root that was never actually rebuilt
 * with the candidate version at all.
 * `failures`: [{ root, reason }], from a loop that could not update some
 * roots. With no failures this is identical to auditRebuild. */
export function auditRebuildWithFailures(before, after, failures = [], opts) {
  const result = auditRebuild(before, after, opts);
  if (!failures.length) return result;
  const extra = failures.map(({ root, reason }) => ({ root, before: (before || {})[root] ?? null, after: `unverified: ${reason}` }));
  return { ok: false, regressions: [...result.regressions, ...extra] };
}

/** Same single-flight + interval shape as planGraphRebuildTick. */
export function planVersionTick({ enabled, running, lastRunAt, now, minIntervalMs } = {}) {
  if (!enabled || running) return false;
  if (lastRunAt == null) return true;
  return (now - lastRunAt) >= minIntervalMs;
}
