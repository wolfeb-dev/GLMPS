// Per-root graph shape and verified-accuracy record (glmps-2.0 upgrade plan
// items 7 and 7b step 3).
//
// WHY A SHAPE CHECK: in July 2026 a graph collapsed to a 55-node stub for 54
// commits while every health check passed, because built_at_commit tracked
// HEAD the whole time. A commit stamp answers "which commit", never "does
// this output have that commit's scale". Recording node and edge counts and
// comparing against a baseline answers the second question.
//
// The baseline only moves on a healthy observation. If a collapsed shape
// became the new baseline, the alert would clear on the next sample and the
// stub would become normal, which is the 54-commit failure all over again.
//
// WHY verifiedAtCommit: graphify does not advance built_at_commit when a full
// re-extraction finds no topology change, so a repo whose commits touch only
// docs or config reads stale forever while being accurate. We record the
// verified commit in our own store rather than rewrite graph.json, which is a
// third-party tool's output with its own concurrent writers.
//
// Pure folds plus a load/persist pair; no clock, no process.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MIN_RATIO = 0.5;

// Callers name the same root with either separator (collectGraphRoots gives
// forward slashes, path.resolve gives backslashes); one key per root.
function keyOf(root) {
  return String(root).replace(/\\/g, '/');
}

/** Read nodes, edges and built_at_commit from a parsed graph.json. */
export function graphShape(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    nodes: Array.isArray(raw.nodes) ? raw.nodes.length : 0,
    edges: Array.isArray(raw.links) ? raw.links.length : (Array.isArray(raw.edges) ? raw.edges.length : 0),
    builtAtCommit: typeof raw.built_at_commit === 'string' && raw.built_at_commit ? raw.built_at_commit : null,
  };
}

/** Returns a NEW store with the shape folded in for `root`. */
export function observeGraphShape(store, root, shape, { now = 0, minRatio = DEFAULT_MIN_RATIO } = {}) {
  if (!shape || typeof shape.nodes !== 'number') return store || {};
  const prev = (store && store[keyOf(root)]) || {};
  const cur = { nodes: shape.nodes, edges: shape.edges ?? 0, builtAtCommit: shape.builtAtCommit ?? null, ts: now };
  const base = prev.baseline && typeof prev.baseline.nodes === 'number' ? prev.baseline : null;
  const collapsed = !!(base && base.nodes > 0 && cur.nodes < base.nodes * minRatio);
  return {
    ...(store || {}),
    [keyOf(root)]: {
      ...prev,
      last: cur,
      baseline: collapsed ? base : cur,
      collapsed,
      dropRatio: base && base.nodes > 0 ? 1 - cur.nodes / base.nodes : 0,
    },
  };
}

/**
 * Stamp `commit` as verified accurate for `root`: a full re-extraction ran,
 * found no topology change, and HEAD did not move during the run. Refused
 * while the root is collapsed, so a verified stamp can never vouch for a stub.
 */
export function stampVerifiedNoop(store, root, { commit, now = 0 } = {}) {
  const prev = (store && store[keyOf(root)]) || {};
  if (!commit || prev.collapsed) return store || {};
  return { ...(store || {}), [keyOf(root)]: { ...prev, verifiedAtCommit: commit, verifiedTs: now } };
}

/** Has a shape ever been observed for `root`? */
export function hasIntegrityRecord(store, root) {
  const v = store && store[keyOf(root)];
  return !!(v && v.last);
}

export function verifiedCommitFor(store, root) {
  const v = store && store[keyOf(root)];
  return v && typeof v.verifiedAtCommit === 'string' ? v.verifiedAtCommit : null;
}

/** Read projection for the alert center; copies so callers cannot mutate the store. */
export function graphIntegrity(store) {
  const out = {};
  for (const [root, v] of Object.entries(store && typeof store === 'object' ? store : {})) {
    if (v && typeof v === 'object') out[root] = { ...v };
  }
  return out;
}

export function loadGraphIntegrity(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

export function persistGraphIntegrity(file, store) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store ?? {}, null, 2));
  } catch { /* fail open: integrity telemetry must never break a tick */ }
}
