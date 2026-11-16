// server/lib/evaluation/lesson-ledger.js
//
// Append-only ledger of lesson lifecycle rows, plus lessonsCurrent, the pure
// fold that rebuilds the current-state projection from it. Mirrors
// outcome-store.js's append/read/atomic-rewrite idiom: NDJSON on disk under
// <stateDir>/lessons/ledger.ndjson, tolerant of a missing file and of
// malformed lines.
//
// createLesson is the ONLY row-appending export here that writes a
// 'created' row; later tasks (decay, invalidation, promotion) append
// 'reconfirmed' / 'decayed' / 'invalidated' / 'promoted' / 'revoked' rows
// through their own modules, all folded by the same lessonsCurrent here so
// there is exactly one projection shape for the whole lesson lifecycle.
//
// Zero runtime dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { assertProvenance, normalizeProvenance } from './lesson-provenance.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';

export function lessonLedgerFile(stateDir) {
  return path.join(stateDir, 'lessons', 'ledger.ndjson');
}

export function appendLessonRow(stateDir, row) {
  const dir = path.join(stateDir, 'lessons');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(lessonLedgerFile(stateDir), JSON.stringify(row) + '\n');
  return row;
}

export function readLessonRows(stateDir, { lessonId } = {}) {
  const file = lessonLedgerFile(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return rows.filter((r) => lessonId === undefined || r.lessonId === lessonId);
}

// Pure fold over the append-only rows into one current-state row per
// lessonId. Always rebuildable from the log; never itself the source of
// truth. Row types not yet produced by any writer (decayed/invalidated/
// promoted/revoked) are handled here up front so later tasks only need to
// append rows, never touch this fold.
export function lessonsCurrent(rows) {
  const map = new Map();
  // Promotion state is an approval attached to a lessonId, NOT to a lesson
  // row (ADR-0001 s5). An operator may pre-approve a guard the loop has
  // proposed but not yet landed, so a promoted/revoked row can legally
  // precede its created row; holding it here and applying it when the
  // created row arrives is what makes the automatic apply path reachable at
  // all. Before this, a lesson could not be created without a promotion
  // (writeLesson asserts the gate before createLesson) and could not be
  // promoted without being created (this fold dropped the row) - a deadlock.
  //
  // A lessonId that only ever appears in a promoted/revoked row still yields
  // NO projection entry: a dangling approval must not conjure a lesson.
  const pendingReflex = new Map();
  for (const row of rows) {
    if (!row || !row.lessonId) continue;
    switch (row.type) {
      case 'created': {
        const prev = map.get(row.lessonId);
        map.set(row.lessonId, {
          lessonId: row.lessonId,
          kind: row.kind,
          title: row.title,
          scope: row.provenance?.scope ?? null,
          provenance: row.provenance,
          status: 'active',
          strength: 1,
          lastReconfirmedAt: row.createdAt,
          // A repeat created row must never silently un-promote a live guard,
          // and an approval recorded before this row must survive it.
          reflex: prev ? prev.reflex : (pendingReflex.get(row.lessonId) ?? false),
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        break;
      }
      case 'reconfirmed': {
        const cur = map.get(row.lessonId);
        if (!cur) break;
        cur.status = 'active';
        cur.strength = 1;
        cur.lastReconfirmedAt = row.ts;
        cur.updatedAt = row.ts;
        break;
      }
      case 'decayed': {
        const cur = map.get(row.lessonId);
        if (!cur) break;
        cur.status = 'dormant';
        cur.strength = typeof row.strength === 'number' ? row.strength : cur.strength;
        cur.updatedAt = row.ts;
        break;
      }
      case 'invalidated': {
        const cur = map.get(row.lessonId);
        if (!cur) break;
        cur.status = 'invalidated';
        cur.strength = 0;
        cur.updatedAt = row.ts;
        break;
      }
      case 'shareable': {
        // Optional (card glmps-2-0-183): which lessons a customer install may receive, and the generic text for it.
        const cur = map.get(row.lessonId);
        if (!cur) break;
        cur.shareable = row.shareable === true;
        cur.shareText = typeof row.shareText === 'string' ? row.shareText : null;
        break;
      }
      case 'promoted': {
        const cur = map.get(row.lessonId);
        if (!cur) { pendingReflex.set(row.lessonId, true); break; }
        cur.reflex = true;
        cur.updatedAt = row.ts;
        break;
      }
      case 'revoked': {
        const cur = map.get(row.lessonId);
        if (!cur) { pendingReflex.set(row.lessonId, false); break; }
        cur.reflex = false;
        cur.updatedAt = row.ts;
        break;
      }
      default:
        break;
    }
  }
  return map;
}

/**
 * reflexApproved(rows, lessonId) -> boolean
 *
 * Is this lessonId currently approved for the reflex layer? Folded from the
 * promoted/revoked rows ALONE (last one wins), so it is also true for an
 * approval recorded BEFORE the lesson's first landing - which is the whole
 * point of ADR-0001 s5: a promotion is an approval attached to a lesson id,
 * not to a lesson row. For a lesson that already exists this is the same
 * answer as lessonsCurrent's `reflex` flag; this is the one that also works
 * before it exists, and it is what reflex-gate.js's isPromoted reads.
 *
 * A dangling approval yields no lesson (lessonsCurrent still returns nothing
 * for it), so nothing becomes retrievable or reflex on the strength of this
 * alone - it only unblocks the write that would create the lesson.
 */
export function reflexApproved(rows, lessonId) {
  let approved = false;
  for (const row of rows) {
    if (!row || row.lessonId !== lessonId) continue;
    if (row.type === 'promoted') approved = true;
    else if (row.type === 'revoked') approved = false;
  }
  return approved;
}

// Create a lesson's origin row. Asserts provenance BEFORE appending, so a
// rejected write leaves the ledger byte-identical - never a partial or
// invalid row lands on disk.
export function createLesson(stateDir, {
  lessonId,
  kind,
  title,
  provenance,
  actor = 'operator',
  now,
} = {}) {
  const p = normalizeProvenance(provenance);
  assertProvenance(p);
  const ts = typeof now === 'number' ? new Date(now).toISOString() : (now ?? new Date().toISOString());
  const row = {
    type: 'created',
    lessonId,
    kind,
    title,
    provenance: p,
    createdAt: ts,
  };
  appendLessonRow(stateDir, row);
  emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.LESSON_CREATED,
    actor,
    ts,
    payload: { lessonId, kind, title, scope: p.scope },
  });
  return row;
}

/** Append a shareable row: the operator's choice to put this lesson's generic text in the customer seed. */
export function setLessonShareable(stateDir, { lessonId, shareable, shareText = null, now } = {}) {
  if (typeof shareable !== 'boolean') throw new Error('lesson-ledger: shareable must be a boolean');
  const ts = typeof now === 'number' ? new Date(now).toISOString() : (now ?? new Date().toISOString());
  return appendLessonRow(stateDir, { type: 'shareable', lessonId, shareable, shareText, ts });
}
