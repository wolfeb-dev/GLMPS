/**
 * Pareto-dominance check and champion/challenger promotion evaluator.
 */
import { msprt, cuped } from './sequential-test.js';

// A metric field may be a bare number (this file's own tests, or any other
// direct caller) or an evidence-tagged envelope from evidence.js's tagValue()
// ({ value, evidence, n, reason? } - promotion-view.js's aggregateByUnit,
// the real production caller as of the evidence-envelope task). Unwrap
// transparently so both shapes compare identically; existing bare-number
// callers are not broken by the new envelope shape.
function metricValue(v) {
  return (v != null && typeof v === 'object' && 'value' in v) ? v.value : v;
}

/**
 * Compare challenger vs champion for a single field.
 * Returns 'better' | 'worse' | 'same' | 'na'.
 */
export function compareField(chalVal, champVal, direction) {
  if (!Number.isFinite(chalVal) || !Number.isFinite(champVal)) return 'na';
  if (direction === 'lower') {
    if (chalVal < champVal) return 'better';
    if (chalVal > champVal) return 'worse';
    return 'same';
  }
  // 'higher'
  if (chalVal > champVal) return 'better';
  if (chalVal < champVal) return 'worse';
  return 'same';
}

/**
 * paretoDominates(challenger, champion, directions) -> boolean
 *
 * Returns true iff challenger is NOT worse on any compared field AND strictly
 * better on at least one. Fields where either side is null/missing/non-finite
 * are ignored.
 *
 * @param {Record<string,number|null|undefined>} challenger
 * @param {Record<string,number|null|undefined>} champion
 * @param {Record<string,'lower'|'higher'>} directions
 */
export function paretoDominates(challenger, champion, directions) {
  let anyBetter = false;
  for (const [field, dir] of Object.entries(directions)) {
    const result = compareField(
      challenger[field] ?? null,
      champion[field] ?? null,
      dir
    );
    if (result === 'worse') return false;
    if (result === 'better') anyBetter = true;
  }
  return anyBetter;
}

/**
 * evaluatePromotion({ champion, challenger, directions })
 * -> { verdict: 'promote'|'hold'|'reject', rationale: string, perMetric: Record<string,'better'|'worse'|'same'|'na'> }
 *
 * - Any 'worse' field -> 'reject' (regression blocks promotion).
 * - At least one 'better' (no 'worse') -> 'promote'.
 * - Otherwise -> 'hold'.
 */
export function evaluatePromotion({ champion, challenger, directions }) {
  const perMetric = {};
  const worse = [];
  const better = [];

  for (const [field, dir] of Object.entries(directions)) {
    const result = compareField(
      metricValue(challenger[field]) ?? null,
      metricValue(champion[field]) ?? null,
      dir
    );
    perMetric[field] = result;
    if (result === 'worse') worse.push(field);
    if (result === 'better') better.push(field);
  }

  if (worse.length > 0) {
    return {
      verdict: 'reject',
      rationale: `regression on: ${worse.join(', ')}`,
      perMetric,
    };
  }
  if (better.length > 0) {
    return {
      verdict: 'promote',
      rationale: `improvement on: ${better.join(', ')}`,
      perMetric,
    };
  }
  return {
    verdict: 'hold',
    rationale: 'no measurable improvement',
    perMetric,
  };
}

/**
 * evaluatePromotionSequential({ championSamples, challengerSamples, championCovariate,
 *   challengerCovariate, alpha, minSamples }) -> { decision, llr, n, available, reason? }
 *
 * ADDITIVE companion to evaluatePromotion/paretoDominates above - does not change
 * their behavior. Where those two run over AGGREGATE per-unit medians and stay the
 * guardrail-regression veto, this wraps the mSPRT sequential test (+ optional CUPED
 * variance reduction) from sequential-test.js over the RAW PER-OUTCOME-ROW metric
 * samples, so a small-sample "can we call it yet" decision doesn't have to wait for
 * a full replay-set aggregate.
 *
 * - Below `minSamples` (default 5) per side: `available:false`, `decision:'continue'`
 * - distinct from a real 'continue' verdict reached WITH enough samples.
 * - When `championCovariate`/`challengerCovariate` arrays are supplied (same length
 *   as their samples array), CUPED-adjusts that side before the test runs.
 * - `decision:'B'` means the challenger samples are higher than the champion's on
 *   whatever scale was passed in; callers with a lower-is-better metric must sign-flip
 *   both sample arrays before calling (see promotion-view.js) so 'B' consistently
 *   reads as "challenger better".
 */
export function evaluatePromotionSequential({
  championSamples = [],
  challengerSamples = [],
  championCovariate = null,
  challengerCovariate = null,
  alpha = 0.05,
  minSamples = 5,
} = {}) {
  const n = Math.min(championSamples.length, challengerSamples.length);
  if (n < minSamples) {
    return { decision: 'continue', llr: 0, n, available: false, reason: 'not enough samples for the sequential test' };
  }

  let a = championSamples;
  let b = challengerSamples;
  if (Array.isArray(championCovariate) && championCovariate.length === championSamples.length)
    a = cuped(championSamples, championCovariate);
  if (Array.isArray(challengerCovariate) && challengerCovariate.length === challengerSamples.length)
    b = cuped(challengerSamples, challengerCovariate);

  const result = msprt(a, b, { alpha });
  return { ...result, available: true };
}
