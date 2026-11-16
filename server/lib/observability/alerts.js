// server/lib/observability/alerts.js
// Pure alert/flag model for the dashboard alert center. Aggregates flags from any GLMPS
// source (capture-coverage gaps, poison-quarantine, memory-scan drift, done-gate fails, and - 
// later - the storm-research security detectors: prompt injection, sensitive-data egress).
// Design-agnostic: the topbar bell + badge + feed + critical banner all render off this.
// See docs/superpowers/specs/2026-07-01-capture-parity-harness-design.md (Phase 2).

export const SEVERITY = { INFO: 'info', WARN: 'warn', CRITICAL: 'critical' };
const RANK = { critical: 3, warn: 2, info: 1 };
const VALID = new Set(Object.values(SEVERITY));

// Stable dedup id from the flag's identity when the source didn't supply one.
function deriveId({ source, title, target }) {
  const t = target ? JSON.stringify(target) : '';
  return `${source || '?'}::${title || ''}::${t}`;
}

/** Normalize a raw flag into the canonical alert shape with safe defaults. */
export function normalizeAlert(raw = {}) {
  const severity = VALID.has(raw.severity) ? raw.severity : SEVERITY.INFO;
  const source = raw.source ?? 'unknown';
  const title = raw.title ?? '';
  const target = raw.target ?? null;
  return {
    id: raw.id ?? deriveId({ source, title, target }),
    source,
    severity,
    title,
    detail: raw.detail ?? '',
    target,
    ts: raw.ts ?? 0,
    acknowledged: raw.acknowledged === true,
  };
}

/** Highest severity first, then most recent first. Does not mutate the input. */
export function rankAlerts(alerts) {
  return [...alerts].sort((a, b) => (RANK[b.severity] - RANK[a.severity]) || (b.ts - a.ts));
}

/** Collapse duplicates by id, keeping the most recent (highest ts). */
export function dedupAlerts(alerts) {
  const byId = new Map();
  for (const a of alerts) {
    const prev = byId.get(a.id);
    if (!prev || (a.ts ?? 0) >= (prev.ts ?? 0)) byId.set(a.id, a);
  }
  return [...byId.values()];
}

/** Badge/summary counts for the topbar alert center. */
export function summarizeAlerts(alerts) {
  const s = { total: alerts.length, critical: 0, warn: 0, info: 0, unacknowledged: 0, topSeverity: null };
  let topRank = 0;
  for (const a of alerts) {
    s[a.severity] = (s[a.severity] ?? 0) + 1;
    if (!a.acknowledged) s.unacknowledged++;
    if (RANK[a.severity] > topRank) { topRank = RANK[a.severity]; s.topSeverity = a.severity; }
  }
  return s;
}
