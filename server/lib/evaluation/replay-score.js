/**
 * replay-score.js (glmps-24)
 *
 * Per-task replay scorecard - the diagnostic Task 4 of
 * docs/superpowers/plans/2026-06-28-critic-loop-phase2-replay-eval.md
 * specified and never wired. Answers a different question than
 * promotion-view.js: that module groups outcomes by `unit` and runs
 * mSPRT/CUPED across a POPULATION (cohort vs cohort). This module compares
 * ONE produced OutcomeRow against ITS OWN frozen replay-task baseline, so a
 * single task can flag "this metric regressed vs its own known-good run"
 * before enough samples accumulate for the population-level test.
 *
 * Reuses promotion.js's compareField as the one comparator so 'better' /
 * 'worse' / 'same' / 'na' mean the same thing everywhere in the evaluation
 * pillar - this module does not re-implement the comparison.
 */
import { compareField } from './promotion.js';

// Dot-paths into an OutcomeRow (see outcome-record.js's TEMPLATE).
const LOWER_IS_BETTER = [
  'turns',
  'tokens.in',
  'tokens.out',
  'wallClockMs.total',
  'toolErrors',
  'editApplyFailures',
  'churn',
  'contextUsageRatio',
];

const HIGHER_IS_BETTER = [
  'firstTry',
  'verifier.exitOk',
  'acceptance.met',
];

/**
 * Resolve a dot-path from an object, returning undefined if any segment is
 * missing (not present, or an intermediate value is null/undefined).
 * @param {object} obj
 * @param {string} path  e.g. 'tokens.in'
 */
function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

// compareField() requires Number.isFinite on both sides (see promotion.js) - 
// booleans (e.g. verifier.exitOk, firstTry, acceptance.met) aren't finite
// numbers, so they must be coerced to 1/0 BEFORE calling compareField, or
// every boolean field would score 'na' instead of 'better'/'worse'.
function coerce(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

/**
 * scoreReplay(baseline, produced) -> { perMetric, regressed, improved }
 *
 * baseline = the frozen known-good OutcomeRow (replay task's `baseline`).
 * produced = the challenger run's OutcomeRow being scored against it.
 *
 * @param {object} baseline
 * @param {object} produced
 * @returns {{ perMetric: Record<string,'better'|'worse'|'same'|'na'>, regressed: string[], improved: string[] }}
 */
export function scoreReplay(baseline, produced) {
  const perMetric = {};

  function score(field, direction) {
    const base = coerce(getPath(baseline, field));
    const prod = coerce(getPath(produced, field));
    // compareField(chalVal, champVal, direction): challenger = produced,
    // champion = baseline.
    perMetric[field] = compareField(prod, base, direction);
  }

  for (const field of LOWER_IS_BETTER) score(field, 'lower');
  for (const field of HIGHER_IS_BETTER) score(field, 'higher');

  const regressed = Object.keys(perMetric).filter((f) => perMetric[f] === 'worse');
  const improved = Object.keys(perMetric).filter((f) => perMetric[f] === 'better');

  return { perMetric, regressed, improved };
}

/**
 * scoreReplayHistory(baseline, rows) -> [{ ts, produced, score }, ...]
 *
 * glmps-26: GET /api/replay/:id/score (above) only ever surfaces
 * the SINGLE most-recent produced row - every earlier run's scorecard was
 * computed and then discarded, so there was no way to see whether a task
 * has been trending better or worse across repeated runs, only its current
 * state. This scores EVERY produced row against the same frozen baseline
 * and returns them oldest-to-newest (a trend, not just a snapshot).
 *
 * Pure - the caller (server.js) supplies both the baseline and the
 * already-filtered rows (same `extra.replayTask === id && unit !==
 * 'replay-baseline'` filter GET /api/replay/:id/score uses), exactly
 * mirroring scoreReplay's contract.
 *
 * @param {object|null} baseline  the frozen replay task baseline
 * @param {Array<object>} rows    produced OutcomeRows for this task
 * @returns {Array<{ ts: number|string|undefined, produced: object, score: object }>}
 */
export function scoreReplayHistory(baseline, rows) {
  if (!baseline || !Array.isArray(rows) || !rows.length) return [];
  return rows
    .slice()
    .sort((a, b) => (Number(a?.ts) || 0) - (Number(b?.ts) || 0))
    .map((r) => ({ ts: r?.ts, produced: r, score: scoreReplay(baseline, r) }));
}
