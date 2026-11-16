// server/lib/observability/integrity-context.js
//
// Turns raw spine events and lesson-ledger state into the flat rows the
// integrity checks read (see the ctx contract in integrity-checks.js).
// Spine events are envelopes ({ kind, ts, payload }); the checks read
// gateName, ref, openedAt and so on at the top level. Passing the envelopes
// straight through made all three checks silently inert, so the mapping lives
// here, once, and stays pure so a test can feed it real event shapes.
//
// Zero runtime dependencies.
import { SPINE_KINDS } from './spine.js';
import { tsToMs } from './event-log.js';

// orphanScan has no "cleared" event. A still-orphaned artifact is re-emitted
// on every nightly scan, so one that has not been seen for longer than this
// is treated as cleared. Two days spans a missed night without letting a
// fixed orphan keep alerting for a week.
export const ORPHAN_CLEAR_AFTER_MS = 2 * 86400000;

export function gateRunsFromSpine(events) {
  const rows = [];
  for (const e of events ?? []) {
    if (e?.kind !== SPINE_KINDS.RUN_GATE_RESULT) continue;
    const p = e.payload;
    if (!p?.gateName || !p.runId) continue;
    rows.push({ runId: p.runId, gateName: p.gateName, status: p.status });
  }
  return rows;
}

export function orphanedArtifactsFromSpine(events, now) {
  const nowMs = tsToMs(now) ?? Date.now();
  const byKey = new Map();
  for (const e of events ?? []) {
    if (e?.kind !== SPINE_KINDS.ARTIFACT_ORPHANED) continue;
    const p = e.payload;
    const ms = tsToMs(e.ts);
    if (!p?.ref || ms === null) continue;
    const key = `${p.type ?? ''}\u0000${p.ref}\u0000${p.path ?? ''}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { ref: p.ref, type: p.type, path: p.path, first: ms, last: ms });
    } else {
      cur.first = Math.min(cur.first, ms);
      cur.last = Math.max(cur.last, ms);
    }
  }
  return [...byKey.values()].map((a) => ({
    ref: a.ref,
    type: a.type,
    path: a.path,
    openedAt: a.first,
    clearedAt: nowMs - a.last > ORPHAN_CLEAR_AFTER_MS ? a.last : null,
  }));
}

// `promoted` here means "the reflex flag is backed by an approval audit
// trail", not "the ledger says promoted". The reflex flag and the ledger's
// promoted state are folded from the same rows, so comparing them to each
// other can never differ. The independent record is the promotion.approved
// spine event approvePromotion emits alongside the ledger row.
export function lessonsForIntegrity(currentLessons, events, isPromoted) {
  const approved = new Set();
  for (const e of events ?? []) {
    if (e?.kind === SPINE_KINDS.PROMOTION_APPROVED && e.payload?.lessonId) approved.add(e.payload.lessonId);
  }
  return [...currentLessons].map((l) => ({
    lessonId: l.lessonId,
    reflex: !!l.reflex,
    promoted: isPromoted(l.lessonId) && approved.has(l.lessonId),
  }));
}
