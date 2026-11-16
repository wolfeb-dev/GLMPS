// server/lib/evaluation/measurables-store.js
// Durable, keyed store for C1's "fitness function" - guard/skill retire
// candidates, the Build-A workspace-divergence signal, and human label
// decisions, persisted so they survive past a single request/tick (unlike
// the ephemeral alert feed built on signal-producer.js). Same atomic
// tmp+rename pattern as outcome-store.js/runner-store.js: one JSON file
// holding a dict keyed by measurable id. NOT the memory plane (locked
// decision 2, docs/superpowers/specs/2026-07-11-c1-c2-b-aligned-design.md sec 1).
//
// Measurable = {
//   id: string,                 // stable dedup key, e.g. "guard-retire:<code>"
//   kind: 'guard-retire'|'skill-retire'|'agent-retire'|'routing-compliance'|'workspace-divergence',
//   title: string, detail: string,
//   evidence: { sessionId: string|null, ref: string|null },
//   metric: object|null,        // kind-specific payload, never invented
//   labels: Array<{ decision:'approve'|'reject'|'prune', by:string|null, note:string|null, ts:number }>,
//   createdTs: number, updatedTs: number,
// }
import fs from 'node:fs';
import path from 'node:path';

export const VALID_DECISIONS = new Set(['approve', 'reject', 'prune']);

const dir = (stateDir) => path.join(stateDir, 'measurables');
const file = (stateDir) => path.join(dir(stateDir), 'measurables.json');

function readAll(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(stateDir), 'utf-8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

function writeAll(stateDir, map) {
  const f = file(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, f);
}

/**
 * Insert-or-merge a measurable by id. Preserves `labels`/`createdTs` across
 * repeated upserts (e.g. a retire candidate recomputed on every request);
 * only the caller-supplied fields (title/detail/metric/evidence) refresh.
 */
export function upsertMeasurable(stateDir, partial) {
  if (!partial || typeof partial.id !== 'string' || !partial.id) {
    throw new Error('upsertMeasurable requires a string id');
  }
  const map = readAll(stateDir);
  const ts = typeof partial.ts === 'number' ? partial.ts : 0;
  const existing = map[partial.id];
  const merged = {
    id: partial.id,
    kind: partial.kind ?? existing?.kind ?? null,
    title: partial.title ?? existing?.title ?? '',
    detail: partial.detail ?? existing?.detail ?? '',
    evidence: partial.evidence ?? existing?.evidence ?? { sessionId: null, ref: null },
    // metric deliberately uses !==undefined (not ??): an explicit `metric:
    // null` in partial CLEARS a previously-stored metric (a caller saying "no
    // metric anymore"), whereas omitting the key entirely preserves the
    // existing one. The other fields above use ?? because there is no
    // caller today that needs to explicitly null out a title/detail/evidence
    // - if one arises, it needs the same !==undefined treatment.
    metric: partial.metric !== undefined ? partial.metric : (existing?.metric ?? null),
    labels: existing?.labels ?? [],
    createdTs: existing?.createdTs ?? ts,
    updatedTs: ts,
  };
  map[partial.id] = merged;
  writeAll(stateDir, map);
  return merged;
}

export function getMeasurable(stateDir, id) {
  return readAll(stateDir)[id] ?? null;
}

export function listMeasurables(stateDir, { kind } = {}) {
  const all = Object.values(readAll(stateDir));
  const filtered = kind ? all.filter(m => m.kind === kind) : all;
  return filtered.sort((a, b) => (b.updatedTs ?? 0) - (a.updatedTs ?? 0));
}

/**
 * Append a human label decision. Returns the updated measurable, or null if
 * `id` is unknown (the route layer turns that into a 404).
 *
 * Existence is checked BEFORE decision validity (glmps-102) - an unknown id
 * always 404s, even with a bogus decision string, rather than 400ing first
 * and never telling the caller the id didn't exist either. A KNOWN id with
 * an invalid decision still throws (the route layer's 400 path).
 */
export function addLabel(stateDir, id, label) {
  const map = readAll(stateDir);
  const existing = map[id];
  if (!existing) return null;
  if (!VALID_DECISIONS.has(label?.decision)) {
    throw new Error(`invalid decision: ${label?.decision}`);
  }
  const entry = { decision: label.decision, by: label.by ?? null, note: label.note ?? null, ts: label.ts ?? 0 };
  existing.labels = [...(existing.labels ?? []), entry];
  existing.updatedTs = entry.ts;
  map[id] = existing;
  writeAll(stateDir, map);
  return existing;
}
