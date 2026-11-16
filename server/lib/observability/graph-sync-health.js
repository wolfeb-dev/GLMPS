// Last-known sync outcome per graph root. Mirrors adapters/health.js: a small
// keyed record the dashboard can render, persisted so a restart does not erase
// the evidence that a repair loop has been failing.
//
// `consecutive` is the field that matters for alerting: one refusal is noise,
// the same refusal every night for a month is the finding.
import fs from 'node:fs';
import path from 'node:path';

/** Pure fold. Returns a NEW store; never mutates the input. */
export function recordSyncOutcome(store, root, result, { now } = {}) {
  const prev = (store && store[root]) || null;
  const same = prev && prev.outcome === result.outcome;
  return {
    ...(store || {}),
    [root]: {
      outcome: result.outcome,
      nodes: result.nodes ?? null,
      existingNodes: result.existingNodes ?? null,
      reason: result.reason ?? '',
      ts: now ?? 0,
      consecutive: same ? (prev.consecutive || 0) + 1 : 1,
    },
  };
}

/** Read projection. Kept separate so callers never mutate the store by accident. */
export function graphSyncHealth(store) {
  const out = {};
  for (const [root, v] of Object.entries(store && typeof store === 'object' ? store : {})) {
    if (v && typeof v === 'object') out[root] = { ...v };
  }
  return out;
}

export function loadSyncHealth(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

export function persistSyncHealth(file, store) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(store ?? {}, null, 2));
  } catch { /* fail open: health telemetry must never break the tick */ }
}
