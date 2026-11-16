// server/lib/evaluation/lesson-decay.js
//
// Stale-lesson decay (A0.2). A lesson's `strength` is a time-decay clock,
// not an extraction-quality score (that field is deliberately named
// `strength`, never `confidence`, to avoid resurrecting the closed decision
// to demote confidence as a gate). strengthAt is a pure function of
// (lastReconfirmedAt, now, halfLifeDays); every caller that needs "now"
// takes it as an explicit argument rather than reading the clock itself, so
// a simulated clock can drive the whole decay curve in a test.
//
// Zero runtime dependencies.
import { appendLessonRow, readLessonRows, lessonsCurrent } from './lesson-ledger.js';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';
import { learningIntegrityConfig } from './learning-integrity-config.js';

const DAY_MS = 86400000;

function toMs(v) {
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? 0 : n;
}

// strength = 0.5 ** (elapsed / halfLife), clamped to [0,1]. Elapsed can be
// negative (clock skew, or "now" earlier than lastReconfirmedAt) - clamped
// to 1 rather than allowed to exceed it.
export function strengthAt(lesson, nowMs, halfLifeDays) {
  const halfLifeMs = halfLifeDays * DAY_MS;
  if (!(halfLifeMs > 0)) return 0;
  const last = toMs(lesson.lastReconfirmedAt);
  const now = toMs(nowMs);
  const elapsed = now - last;
  const raw = Math.pow(0.5, elapsed / halfLifeMs);
  return Math.min(1, Math.max(0, raw));
}

function halfLifeForScope(config, scope) {
  return config.halfLifeDays[scope] ?? config.halfLifeDays.repo;
}

// Reconfirm a lesson: resets its decay clock to `ts` (or now). This is the
// only way an active lesson's strength returns to 1 short of re-creating it.
export function reconfirmLesson(stateDir, lessonId, { ts, actor = 'operator', runId = null } = {}) {
  const stamped = typeof ts === 'number' ? new Date(ts).toISOString() : (ts ?? new Date().toISOString());
  const row = { type: 'reconfirmed', lessonId, ts: stamped, runId };
  appendLessonRow(stateDir, row);
  emitSpineEvent(stateDir, {
    kind: SPINE_KINDS.LESSON_RECONFIRMED,
    actor,
    ts: stamped,
    payload: { lessonId, runId },
  });
  return row;
}

// Recompute strength for every currently-active lesson and move any that
// have fallen below the strength floor to 'dormant', emitting one
// lesson.decayed event each. Idempotent: a lesson already moved to dormant
// is excluded from the next sweep (it is no longer 'active'), so a second
// sweep at the same or a later clock decays nothing new for it.
export function runDecaySweep(stateDir, { now = Date.now(), config } = {}) {
  const cfg = config ?? learningIntegrityConfig();
  const nowMs = toMs(now);
  const current = lessonsCurrent(readLessonRows(stateDir, {}));
  const decayed = [];
  let evaluated = 0;
  for (const lesson of current.values()) {
    if (lesson.status !== 'active') continue;
    evaluated += 1;
    const halfLifeDays = halfLifeForScope(cfg, lesson.scope);
    const strength = strengthAt(lesson, nowMs, halfLifeDays);
    if (strength < cfg.strengthFloor) {
      const ts = new Date(nowMs).toISOString();
      appendLessonRow(stateDir, { type: 'decayed', lessonId: lesson.lessonId, ts, strength });
      emitSpineEvent(stateDir, {
        kind: SPINE_KINDS.LESSON_DECAYED,
        actor: 'nightly-runner',
        ts,
        payload: { lessonId: lesson.lessonId, strength, halfLifeDays },
      });
      decayed.push(lesson.lessonId);
    }
  }
  return { decayed, evaluated };
}

// The retrieval filter: active lessons whose live strength (recomputed
// against `now`, not just their stored status) is still at or above the
// floor. Dormant and invalidated lessons are excluded here but stay
// readable through readLessonRows for audit.
export function activeLessons(stateDir, { now = Date.now(), config } = {}) {
  const cfg = config ?? learningIntegrityConfig();
  const nowMs = toMs(now);
  const current = lessonsCurrent(readLessonRows(stateDir, {}));
  const result = [];
  for (const lesson of current.values()) {
    if (lesson.status !== 'active') continue;
    const halfLifeDays = halfLifeForScope(cfg, lesson.scope);
    const strength = strengthAt(lesson, nowMs, halfLifeDays);
    if (strength >= cfg.strengthFloor) {
      result.push({ ...lesson, strength });
    }
  }
  return result;
}
