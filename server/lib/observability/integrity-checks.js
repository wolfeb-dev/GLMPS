// server/lib/observability/integrity-checks.js
//
// The three integrity checks, as data: CHECKS is a declarative array of
// { name, severity, run(ctx) -> finding[] }. reconciliation.js owns the
// registry mechanics (config defaulting, enable/disable filtering, spine
// emission); this module owns the checks' firing logic and their default
// config, so the two can be read and changed independently.
//
// Every check is a pure function of ctx - no I/O, no Date.now(). The ctx
// contract (every field optional; a check with nothing to look at produces
// no findings, i.e. fails open):
//
//   now                epoch ms / ISO string / Date - "now" for every check
//   config             a resolved reconciliationConfig() object
//   gateRuns[]         one row per (nightly run, gate): { runId, gateName,
//                      status }; skipped_gates walks the trailing streak per
//                      gateName, ordered by runId
//   orphanedArtifacts[] normalized artifact.orphaned findings:
//                      { ref, type, path, openedAt, clearedAt }. clearedAt
//                      null/absent means still open. This is a normalized
//                      shape rather than raw artifact.orphaned events because
//                      "without a completed cleanup task" needs a resolution
//                      signal this module deliberately does not couple to
//                      (the orphanScan/backlog ticket machinery); the caller
//                      supplies clearedAt from whatever tracks that.
//   lessons[]          { lessonId, reflex, promoted } - CALLER-SUPPLIED.
//                      ungated_reflex reads reflex/promotion state from here
//                      rather than importing reflex-gate.js.
//
// Zero runtime dependencies.

const DAY_MS = 86400000;

export const DEFAULT_CHECK_CONFIG = Object.freeze({
  skipped_gates: Object.freeze({ enabled: true, threshold: 3 }),
  orphaned_artifact: Object.freeze({ enabled: true, threshold: 7 }),
  ungated_reflex: Object.freeze({ enabled: true }),
});

function toMs(v, fallback = null) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(v);
  return Number.isNaN(n) ? fallback : n;
}

function checkCfg(ctx, name) {
  return ctx.config?.checks?.[name] ?? DEFAULT_CHECK_CONFIG[name] ?? {};
}

//
// The same gate skipped >= 3 (config threshold) consecutive nightly runs ->
// warn. "Consecutive" is the trailing streak of status:'skipped' rows for
// that gateName, ordered by runId (nightly-<YYYYMMDD> sorts lexicographically
// in run order).
function skippedGates(ctx) {
  const rows = ctx.gateRuns ?? [];
  const cfg = checkCfg(ctx, 'skipped_gates');
  const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 3;

  const byGate = new Map();
  for (const r of rows) {
    if (!r || !r.gateName) continue;
    const list = byGate.get(r.gateName) ?? [];
    list.push(r);
    byGate.set(r.gateName, list);
  }

  const findings = [];
  for (const [gateName, list] of byGate) {
    const sorted = [...list].sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
    let streak = 0;
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].status === 'skipped') streak += 1;
      else break;
    }
    if (streak >= threshold) {
      findings.push({ severity: 'warn', details: { gateName, streak } });
    }
  }
  return findings;
}

//
// An artifact.orphaned finding open (no clearedAt) for more than the
// threshold (default 7) days -> warn.
function orphanedArtifact(ctx) {
  const now = toMs(ctx.now, Date.now());
  const artifacts = ctx.orphanedArtifacts ?? [];
  const cfg = checkCfg(ctx, 'orphaned_artifact');
  const thresholdMs = (Number.isFinite(cfg.threshold) ? cfg.threshold : 7) * DAY_MS;

  const findings = [];
  for (const a of artifacts) {
    if (!a || a.clearedAt) continue;
    const openedAt = toMs(a.openedAt);
    if (openedAt === null) continue;
    if (now - openedAt > thresholdMs) {
      findings.push({
        severity: 'warn',
        details: { ref: a.ref, type: a.type, path: a.path, ageDays: Math.round((now - openedAt) / DAY_MS) },
      });
    }
  }
  return findings;
}

//
// Any reflex-layer lesson lacking an approved promotion -> critical.
// Reads from ctx.lessons (CALLER-SUPPLIED), never from reflex-gate.js - see
// the file header.
function ungatedReflex(ctx) {
  const lessons = ctx.lessons ?? [];
  const findings = [];
  for (const l of lessons) {
    if (!l || !l.reflex) continue;
    if (l.promoted === true) continue;
    findings.push({ severity: 'critical', details: { lessonId: l.lessonId } });
  }
  return findings;
}

export const CHECKS = Object.freeze([
  { name: 'skipped_gates', severity: 'warn', run: skippedGates },
  { name: 'orphaned_artifact', severity: 'warn', run: orphanedArtifact },
  { name: 'ungated_reflex', severity: 'critical', run: ungatedReflex },
]);
