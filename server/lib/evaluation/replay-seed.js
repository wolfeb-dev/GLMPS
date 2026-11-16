/**
 * Stratified seed-from-history helper for the replay set.
 * @typedef {{ id: string, project: string|null, promptFile: null, baseline: object }} ReplayTask
 */
import { readOutcomes } from './outcome-store.js';
import { addReplayTask, listReplayTasks } from './replay-set.js';

// glmps-82 / Open Question 4 (2026-07-09 substrate-refactor plan): mSPRT/CUPED
// need labeled cohorts before they produce a signal. The plan recommends
// starting at the mSPRT paper's typical minimum, ~10-20 paired samples per
// unit - once champion and challenger are each replayed over this frozen
// set, that's how many paired outcome rows the sequential test gets. 16 sits
// in the middle of that range.
export const DEFAULT_SEED_N = 16;

/**
 * @param {object[]} rows
 * @param {{ perClass?: number, targetTotal?: number }} opts
 * @returns {ReplayTask[]}
 */
export function seedFromOutcomes(rows = [], { perClass = 4, targetTotal } = {}) {
  const byClass = new Map();

  for (const row of rows) {
    if (
      row.committed !== true ||
      !row.verifier ||
      row.verifier.exitOk !== true ||
      row.revertedLater === true
    ) continue;

    const cls = row.taskClass;
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(row);
  }

  // targetTotal overrides perClass by distributing the target evenly across
  // the distinct task classes actually present in the qualifying rows, so a
  // from-scratch seed run lands close to N total instead of N-per-class.
  // May overshoot slightly when many classes are present (ceil rounding) - 
  // acceptable since this only controls how big the frozen set gets, not
  // correctness of any individual sample.
  const cap = targetTotal != null
    ? Math.max(1, Math.ceil(targetTotal / Math.max(1, byClass.size)))
    : perClass;

  const result = [];
  for (const bucket of byClass.values()) {
    for (const row of bucket.slice(0, cap)) {
      result.push({ id: `replay-${row.id}`, project: row.project ?? null, promptFile: null, baseline: row });
    }
  }
  return result;
}

/**
 * Read committed/verified OutcomeRows from disk, stratify-sample them via
 * seedFromOutcomes, and persist any new ones as replay tasks. This is the
 * missing link that actually populates the replay/eval set (glmps-82):
 * seedFromOutcomes existed but had zero callers outside its own test.
 *
 * Idempotent: addReplayTask no-ops on an id that's already seeded, so
 * re-running this only tops up toward `n`, never duplicates.
 *
 * @param {string} stateDir
 * @param {{ n?: number }} [opts] n: target total sample count (default
 *   DEFAULT_SEED_N, the 10-20 range from Open Question 4).
 * @returns {{ added: number, skipped: number, total: number }}
 */
export function seedReplaySet(stateDir, { n = DEFAULT_SEED_N } = {}) {
  const rows = readOutcomes(stateDir);
  const candidates = seedFromOutcomes(rows, { targetTotal: n });

  let added = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const { isNew } = addReplayTask(stateDir, candidate);
    if (isNew) added++; else skipped++;
  }

  return { added, skipped, total: listReplayTasks(stateDir).length };
}
