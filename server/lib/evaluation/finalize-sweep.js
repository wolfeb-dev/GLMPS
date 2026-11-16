// server/lib/evaluation/finalize-sweep.js
//
// GLMPS 2.0 shadow-instance plan, Task 1. Production's Stop hook only pings
// its own instance's POST /api/outcomes/finalize, so a second, isolated
// server (the 2.0 shadow on port 8124) never gets a finalize ping for any of
// its own sessions - it would otherwise never produce outcome rows or judge
// verdicts at all. This is the pure eligibility rule a periodic sweep
// (server.js) uses instead: on each tick, every known session is checked
// against pickSessionsToFinalize, and each one it returns is finalized and
// has a judge job queued, exactly like the Stop-hook route does for its own
// instance.
//
// Kept pure (no fs/timers/queues here) so the rule itself - not the wiring
// around it - is what the tests pin down. server.js supplies the real
// session snapshot and the hasOutcomeRow/hasJudgeJob lookups.

/**
 * @param {{
 *   sessions: Array<{ sessionId: string, lastActivityTs: number, eventCount: number }>,
 *   now: number,
 *   idleMs: number,
 *   maxAgeMs?: number,
 *   hasOutcomeRow: (sessionId: string) => boolean,
 *   hasJudgeJob: (sessionId: string) => boolean,
 * }} opts
 * @returns {string[]} sessionIds due for finalize, in input order
 */
export function pickSessionsToFinalize({ sessions, now, idleMs, maxAgeMs, hasOutcomeRow, hasJudgeJob }) {
  const out = [];
  for (const s of sessions) {
    const age = now - s.lastActivityTs;
    if (age < idleMs) continue; // still active
    // a fresh shadow state dir must not
    // finalize and queue judge model calls for every historical session
    // already sitting in the index - only ones that went idle within the
    // lookback window are ever eligible. Undefined maxAgeMs (no cap
    // supplied) never excludes anything, matching every caller before this
    // fix landed.
    if (maxAgeMs !== undefined && age > maxAgeMs) continue; // too old to be a live sweep target
    if (!(s.eventCount > 0)) continue; // nothing to finalize
    if (hasOutcomeRow(s.sessionId)) continue; // already finalized
    if (hasJudgeJob(s.sessionId)) continue; // already queued
    out.push(s.sessionId);
  }
  return out;
}

/**
 * Runs one finalize-sweep pass: picks due sessions via pickSessionsToFinalize,
 * then finalizes each one in isolation - a throwing session must never skip
 * or starve any other due session in the same tick, matching runRetryTick's
 * per-job isolation (server/lib/plugins/memory-plugin.js).
 *
 * @param {{
 *   sessions: Array<{ sessionId: string, lastActivityTs: number, eventCount: number }>,
 *   now: number,
 *   idleMs: number,
 *   maxAgeMs?: number,
 *   hasOutcomeRow: (sessionId: string) => boolean,
 *   hasJudgeJob: (sessionId: string) => boolean,
 *   finalizeAndQueueJudge: (sessionId: string, opts: { notBefore: number }) => any,
 *   onError: (sessionId: string, error: unknown) => void,
 * }} opts
 * @returns {string[]} the sessionIds pickSessionsToFinalize selected (whether or not each one succeeded)
 */
export function runFinalizeSweep({ sessions, now, idleMs, maxAgeMs, hasOutcomeRow, hasJudgeJob, finalizeAndQueueJudge, onError }) {
  const due = pickSessionsToFinalize({ sessions, now, idleMs, maxAgeMs, hasOutcomeRow, hasJudgeJob });
  for (const sid of due) {
    const s = sessions.find((x) => x.sessionId === sid);
    try {
      finalizeAndQueueJudge(sid, { notBefore: s.lastActivityTs + idleMs });
    } catch (e) {
      onError(sid, e);
    }
  }
  return due;
}
