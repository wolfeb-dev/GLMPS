// server/lib/evaluation/guard-retire.js
//
// Pure: propose retirement CANDIDATES for guards that Phase 2's shadow-arm
// measurement shows never fire. Never deletes anything itself - this is a
// read-only "here's what to look at" surface; a human (or a future explicit
// action) decides whether to actually remove a guard line from governance.
//
// How a "guard" and a shadow-arm observation are correlated
//
// shadow-arm.js's recordShadow(stateDir, { taskClass, wouldFire, fired })
// buckets observations by a free-form `taskClass` string key - it has no
// opinion on what that key means. shadowRates() aggregates those buckets
// into { byClass: { <key>: { n, fireRate, counterfactualRate } } }.
//
// The `guards` list this module reads is ALSO keyed by a free-form string:
// the gap code (e.g. 'sleep-poll', 'reread-loop'). Guard proposer cutover
// : this used to be learning-templates.js's static TEMPLATES map;
// server.js now builds the same { code -> { rule } } shape from applied
// learning-store items instead (appliedGuardCatalog()), since guards are
// proposed dynamically (GEPA) rather than compiled in. Either way, a gap
// code is exactly the natural per-guard counterfactual bucket: each gap code
// corresponds to exactly one guard rule, and gap-detect's "would this
// guard's condition have applied here" check is naturally recorded per gap
// code. So this module treats `shadowRates().byClass[<gap code>]` as that
// guard's observed fire-rate bucket - no new correlation key needs
// inventing, it's already latent in how the two are keyed.
//
// A guard with no bucket at all (shadowRates has never seen its gap code)
// is NOT a candidate: zero observations can't support "never fires" - that
// would be silence mistaken for evidence. Only a guard with >= minObservations
// recorded AND a counterfactualRate of exactly 0 (would-fire never true) is
// surfaced.

const DEFAULT_MIN_OBSERVATIONS = 20;

/**
 * @param {Array<{ code: string, rule: string }>} guards
 * @param {{ byClass?: Record<string, { n:number, fireRate:number, counterfactualRate:number }> }} rates
 *   the shape returned by shadow-arm.js's shadowRates()
 * @param {{ minObservations?: number }} [opts]
 * @returns {Array<{ code: string, rule: string, reason: string, n: number }>}
 */
export function retireCandidates(guards, rates, { minObservations = DEFAULT_MIN_OBSERVATIONS } = {}) {
  const byClass = (rates && rates.byClass) || {};
  const list = Array.isArray(guards) ? guards : [];
  const out = [];

  for (const guard of list) {
    if (!guard || typeof guard.code !== 'string') continue;
    const bucket = byClass[guard.code];
    if (!bucket) continue; // never observed - no evidence either way, fail-open
    if (typeof bucket.n !== 'number' || bucket.n < minObservations) continue;
    if (bucket.counterfactualRate !== 0) continue; // it would have fired at least once

    out.push({
      code: guard.code,
      rule: guard.rule,
      reason: `never fired across ${bucket.n} observed sessions`,
      n: bucket.n,
    });
  }

  return out;
}

/**
 * Convenience wrapper: build the `guards` list directly from any
 * { code -> { rule, ... } } Map (server.js's appliedGuardCatalog(), a test
 * fixture, or - historically - learning-templates.js's now-deleted static
 * TEMPLATES map) so callers don't have to reshape it themselves.
 *
 * @param {Map<string, { rule: string }>} templates
 * @param {object} rates
 * @param {{ minObservations?: number }} [opts]
 */
export function retireCandidatesFromTemplates(templates, rates, opts) {
  const guards = [];
  for (const [code, entry] of templates instanceof Map ? templates : []) {
    if (entry && typeof entry.rule === 'string') guards.push({ code, rule: entry.rule });
  }
  return retireCandidates(guards, rates, opts);
}

export { DEFAULT_MIN_OBSERVATIONS };

// Staleness-based retire candidates (glmps-138 Task 4)
//
// The counterfactual rule above ("never fired across >= minObservations
// sessions") is honest but too strict for an active repo: a guard that fires
// occasionally never qualifies, no matter how long it has actually gone
// quiet, so retirement proposals rarely populate in practice. This adds a
// second, complementary rule: a guard that WAS used but has gone quiet for a
// while. staleDays flags it (informational); retireDays is the threshold
// that actually yields a propose-retire candidate. Both are propose-only,
// same as retireCandidates() above - nothing here ever mutates a store.
//
// staleness() is shared with skill-retire.js's staleArchiveCandidates() (its
// own "used before, gone quiet" rule) rather than duplicated - same
// import-a-shared-constant precedent skill-adopt-store.js already uses for
// DEFAULT_MIN_OBSERVATIONS above.
export const DEFAULT_STALE_DAYS = 30;
export const DEFAULT_RETIRE_DAYS = 90;
const MS_PER_DAY = 86400000;

/**
 * @param {number} lastUsedTs   epoch ms of the last known use/fire; anything
 *   else (missing, NaN, a string) means "no evidence" and is fail-open.
 * @param {number} now          epoch ms
 * @param {{ staleDays?: number, retireDays?: number }} [opts]
 * @returns {{ stale: boolean, proposeRetire: boolean, lastUsedDays: number|null }}
 */
export function staleness(lastUsedTs, now, { staleDays = DEFAULT_STALE_DAYS, retireDays = DEFAULT_RETIRE_DAYS } = {}) {
  if (typeof lastUsedTs !== 'number' || !Number.isFinite(lastUsedTs)) {
    return { stale: false, proposeRetire: false, lastUsedDays: null };
  }
  const lastUsedDays = (now - lastUsedTs) / MS_PER_DAY;
  return {
    stale: lastUsedDays >= staleDays,
    proposeRetire: lastUsedDays >= retireDays,
    lastUsedDays,
  };
}

/**
 * @param {Array<{ code: string, rule: string }>} guards
 * @param {Record<string, number>} lastUsedByCode   guard code -> epoch ms of
 *   last known use (caller-supplied; this module has no opinion on where
 *   that comes from - server.js derives it from learning-store.js item
 *   updatedTs for status:'applied' items).
 * @param {{ now?: number, staleDays?: number, retireDays?: number }} [opts]
 * @returns {Array<{ code: string, rule: string, reason: 'stale', lastUsedDays: number }>}
 *   Only guards that reach `retireDays` are included - a guard merely past
 *   `staleDays` is flagged via staleness() directly but does not appear in
 *   this array (propose-retire only happens at the stronger threshold).
 */
export function staleGuardCandidates(guards, lastUsedByCode, { now = Date.now(), staleDays = DEFAULT_STALE_DAYS, retireDays = DEFAULT_RETIRE_DAYS } = {}) {
  const map = (lastUsedByCode && typeof lastUsedByCode === 'object') ? lastUsedByCode : {};
  const list = Array.isArray(guards) ? guards : [];
  const out = [];

  for (const guard of list) {
    if (!guard || typeof guard.code !== 'string') continue;
    const { proposeRetire, lastUsedDays } = staleness(map[guard.code], now, { staleDays, retireDays });
    if (!proposeRetire) continue;
    out.push({ code: guard.code, rule: guard.rule, reason: 'stale', lastUsedDays });
  }

  return out;
}

/**
 * Convenience wrapper mirroring retireCandidatesFromTemplates() above: build
 * the `guards` list directly from any { code -> { rule } } Map.
 */
export function staleGuardCandidatesFromTemplates(templates, lastUsedByCode, opts) {
  const guards = [];
  for (const [code, entry] of templates instanceof Map ? templates : []) {
    if (entry && typeof entry.rule === 'string') guards.push({ code, rule: entry.rule });
  }
  return staleGuardCandidates(guards, lastUsedByCode, opts);
}
