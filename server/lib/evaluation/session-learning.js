/**
 * session-learning.js - what one session taught the system, for its detail
 * page's Learning band (session-detail spec section 8 item 3).
 *
 * Joins the learning store's items and the lesson ledger's lessons to a
 * session by id, and folds the per-session fitness scoreboard into one
 * summary line. Zero deps, Node 18+ ESM.
 */

import fs from 'node:fs';
import { lessonLedgerFile, readLessonRows, lessonsCurrent } from './lesson-ledger.js';
import { lessonIdForLearningItem } from './guard-lesson.js';

// A gap row keys on code|project, so a recurring gap keeps the session that
// first filed it in `sessionId` and the latest one in `lastSessionId`; either
// names this session. A GEPA proposal has no session of its own and joins
// through the gap items it was derived from.
export function sessionLearning(sid, { items = [], lessons = [], fitness = null } = {}) {
  const own = items.filter((i) => i && (i.sessionId === sid || i.lastSessionId === sid));
  const ownIds = new Set(own.map((i) => i.id));
  const derived = items.filter((i) => i && !ownIds.has(i.id)
    && Array.isArray(i.derivedFrom) && i.derivedFrom.some((d) => ownIds.has(d)));
  const joined = [...own, ...derived].map((i) => ({
    id: i.id, source: i.source ?? null, code: i.code ?? null, title: i.title ?? '',
    status: i.status ?? null, severity: i.severity ?? null, count: i.count ?? 1,
    firstSession: i.sessionId === sid, rule: i.proposedGuard?.rule ?? null,
    derivedFrom: Array.isArray(i.derivedFrom) ? i.derivedFrom : [],
    applyCommit: i.applyCommit ?? null, createdTs: i.createdTs ?? null, updatedTs: i.updatedTs ?? null,
  }));

  const lessonIds = new Set(joined.map((i) => lessonIdForLearningItem(i.id)));
  const sessionRef = `session:${sid}`;
  const ownLessons = lessons
    .filter((l) => lessonIds.has(l.lessonId) || (l.provenance?.sourceEventIds ?? []).includes(sessionRef))
    .map((l) => ({
      lessonId: l.lessonId, kind: l.kind ?? null, title: l.title ?? '', status: l.status,
      reflex: !!l.reflex, strength: l.strength, scope: l.scope ?? null,
      createdAt: l.createdAt ?? null, updatedAt: l.updatedAt ?? null,
    }));

  const gapsByStatus = {};
  for (const i of joined) if (i.source === 'gap') gapsByStatus[i.status] = (gapsByStatus[i.status] ?? 0) + 1;
  const guards = joined.filter((i) => i.rule);
  return {
    items: joined,
    lessons: ownLessons,
    summary: {
      gaps: joined.filter((i) => i.source === 'gap').length,
      gapsByStatus,
      guardsProposed: guards.filter((i) => i.status !== 'applied' && i.status !== 'discarded').length,
      guardsLanded: guards.filter((i) => i.status === 'applied').length,
      lessons: ownLessons.length,
      measurables: fitness?.tracked ?? 0,
    },
  };
}

// The ledger is append-only and grows with every lesson row, so it is
// refolded only when its mtime or size moves.
export function createSessionLearningLookup(stateDir, { read = readLessonRows, stat = fs.statSync } = {}) {
  const file = lessonLedgerFile(stateDir);
  let key = null;
  let lessons = [];
  return (sid, { items, fitness } = {}) => {
    if (!sid) return null;
    let k;
    try { const s = stat(file); k = `${s.mtimeMs}:${s.size}`; } catch { k = 'missing'; }
    if (k !== key) { lessons = [...lessonsCurrent(read(stateDir)).values()]; key = k; }
    return sessionLearning(sid, { items, lessons, fitness });
  };
}
