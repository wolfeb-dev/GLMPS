// Strict body validators for the /api/ingest/* routes the hooks write through.
// Each returns an error string, or null when the body is acceptable. The shapes
// are what the hooks' producers emit (capability-feed-core.feedFromTranscript,
// decision-log-hook-core.buildConfigRow, qa-trends-local.buildLocalPoint), with
// bounded sizes so a client token cannot be used to fill the server's disk.

export const INGEST_MAX_BODY_BYTES = 1024 * 1024;
const MAX_GAPS = 50;
const MAX_ROWS = 100;
const MAX_ROW_BYTES = 16 * 1024;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max, { min = 0 } = {}) => typeof v === 'string' && v.length >= min && v.length <= max;

export function validateLearningGaps(b) {
  if (!isObj(b)) return 'body must be an object';
  if (!str(b.project, 1024, { min: 1 })) return 'project must be a non-empty string up to 1024 chars';
  if (!str(b.sessionId, 256)) return 'sessionId must be a string up to 256 chars';
  if (!Array.isArray(b.gaps)) return 'gaps must be an array';
  if (b.gaps.length > MAX_GAPS) return `at most ${MAX_GAPS} gaps`;
  for (const g of b.gaps) {
    if (!isObj(g)) return 'each gap must be an object';
    if (!str(g.code, 100, { min: 1 })) return 'gap.code must be a non-empty string up to 100 chars';
    if (g.severity !== undefined && !str(g.severity, 20)) return 'gap.severity must be a short string';
    if (g.message !== undefined && !str(g.message, 2000)) return 'gap.message must be a string up to 2000 chars';
  }
  return null;
}

export function validateBacklogTicket(b) {
  if (!isObj(b)) return 'body must be an object';
  if (!str(b.project, 256, { min: 1 })) return 'project must be a non-empty string up to 256 chars';
  if (!str(b.title, 500, { min: 1 }) || !b.title.trim()) return 'title must be a non-empty string up to 500 chars';
  if (!str(b.prompt, 64 * 1024)) return 'prompt must be a string up to 64 KiB';
  // The only ticket the hook files is a held deferral. Pinning both keeps a
  // client token from filing a launchable card or from claiming operator trust.
  if (b.source !== 'deferred') return "source must be 'deferred'";
  if (b.state !== 'held') return "state must be 'held'";
  if (!str(b.sessionId, 256)) return 'sessionId must be a string up to 256 chars';
  return null;
}

export function validateDecisionRows(b) {
  if (!isObj(b)) return 'body must be an object';
  if (!Array.isArray(b.rows) || b.rows.length === 0) return 'rows must be a non-empty array';
  if (b.rows.length > MAX_ROWS) return `at most ${MAX_ROWS} rows`;
  for (const r of b.rows) {
    if (!isObj(r)) return 'each row must be an object';
    if (!Number.isFinite(r.ts)) return 'row.ts must be a finite number';
    if (!str(r.source, 32, { min: 1 })) return 'row.source must be a short non-empty string';
    if (JSON.stringify(r).length > MAX_ROW_BYTES) return 'row too large';
  }
  return null;
}

export function validateQaPoint(b) {
  if (!isObj(b) || !isObj(b.point)) return 'point must be an object';
  const p = b.point;
  if (!Number.isFinite(p.ts)) return 'point.ts must be a finite number';
  if (p.runId !== null) return 'point.runId must be null (a local run has no CI run id)';
  if (p.source !== 'local') return "point.source must be 'local'";
  if (p.openIssues !== null) return 'point.openIssues must be null';
  for (const k of ['testCount', 'pass', 'fail']) {
    if (!Number.isInteger(p[k]) || p[k] < 0) return `point.${k} must be a non-negative integer`;
  }
  if (p.sha !== null && !str(p.sha, 64)) return 'point.sha must be a short string or null';
  if (p.conclusion !== 'success' && p.conclusion !== 'failure') return "point.conclusion must be 'success' or 'failure'";
  if (p.scope !== undefined && p.scope !== 'full' && p.scope !== 'affected') return "point.scope must be 'full' or 'affected' when present";
  return null;
}
