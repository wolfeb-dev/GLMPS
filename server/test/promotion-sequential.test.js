import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePromotionSequential } from '../lib/evaluation/promotion.js';

// Fixtures mirror sequential-test.test.js so the wrapping is checked against the
// same hand-computed cases the underlying msprt/cuped already pass.

test('clearly-better challenger -> decision B, available (n >= minSamples)', () => {
  const championSamples = [0, 0, 0, 0, 0, 0, 0, 0];
  const challengerSamples = [1, 1, 1, 1, 1, 1, 1, 1];
  const r = evaluatePromotionSequential({ championSamples, challengerSamples });
  assert.equal(r.available, true);
  assert.equal(r.decision, 'B');
  assert.equal(r.n, 8);
});

test('indistinguishable arms stay continue (still available)', () => {
  const championSamples = [1, 2, 3, 2, 1, 2, 3, 2];
  const challengerSamples = [1, 2, 3, 2, 1, 2, 3, 2];
  const r = evaluatePromotionSequential({ championSamples, challengerSamples });
  assert.equal(r.available, true);
  assert.equal(r.decision, 'continue');
});

test('below minSamples -> not available, decision continue, does not run msprt on noise', () => {
  const r = evaluatePromotionSequential({
    championSamples: [1, 1, 1],
    challengerSamples: [9, 9, 9],
    minSamples: 5,
  });
  assert.equal(r.available, false);
  assert.equal(r.decision, 'continue');
  assert.match(r.reason, /not enough samples/);
  assert.equal(r.n, 3); // sample count still reported for visibility
});

// Demonstrates the CUPED wrapping actually changes the outcome: a shared
// alternating confound (e.g. a per-task-order effect) swamps the small true
// difference on the raw scale, but a covariate that reproduces the confound
// exactly cancels it, exposing the difference.
//
// Hand-computed: championSamples = covariate + 5, challengerSamples = covariate + 6
// (covariate mean 0). Raw: sigma2=9 (from the +-3 swing), n=10, dbar=1 ->
// llr ~ -0.694 < bound (log(1/0.05)=2.996) -> 'continue'.
// CUPED-adjusted: theta=1 exactly for both sides (perfectly correlated with the
// covariate) collapses each side to a constant (5 and 6) -> near-zero variance,
// dbar=1 -> llr blows past the bound -> 'B'.
test('CUPED covariate flips continue -> B by removing a shared confound', () => {
  const covariate = [3, -3, 3, -3, 3, -3, 3, -3, 3, -3];
  const championSamples = covariate.map(v => v + 5);
  const challengerSamples = covariate.map(v => v + 6);

  const withoutCuped = evaluatePromotionSequential({ championSamples, challengerSamples });
  assert.equal(withoutCuped.available, true);
  assert.equal(withoutCuped.decision, 'continue');

  const withCuped = evaluatePromotionSequential({
    championSamples, challengerSamples,
    championCovariate: covariate, challengerCovariate: covariate,
  });
  assert.equal(withCuped.available, true);
  assert.equal(withCuped.decision, 'B');
});
