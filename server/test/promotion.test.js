import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paretoDominates, evaluatePromotion } from '../lib/evaluation/promotion.js';

const dirs = { turns: 'lower', verifierPassRate: 'higher', firstTryRate: 'higher' };

test('challenger dominates -> promote', () => {
  const champ = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chal  = { turns: 4, verifierPassRate: 0.7, firstTryRate: 0.6 };
  assert.equal(paretoDominates(chal, champ, dirs), true);
  const e = evaluatePromotion({ champion: champ, challenger: chal, directions: dirs });
  assert.equal(e.verdict, 'promote');
});

test('any regression -> reject', () => {
  const champ = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chal  = { turns: 4, verifierPassRate: 0.6, firstTryRate: 0.6 }; // verifier worse
  assert.equal(paretoDominates(chal, champ, dirs), false);
  const e = evaluatePromotion({ champion: champ, challenger: chal, directions: dirs });
  assert.equal(e.verdict, 'reject');
  assert.ok(e.perMetric.verifierPassRate === 'worse');
});

test('no movement -> hold', () => {
  const champ = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chal  = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  assert.equal(evaluatePromotion({ champion: champ, challenger: chal, directions: dirs }).verdict, 'hold');
});

test('null fields are na and ignored', () => {
  const champ = { turns: 5, verifierPassRate: null };
  const chal  = { turns: 4, verifierPassRate: 0.7 };
  const e = evaluatePromotion({ champion: champ, challenger: chal, directions: { turns:'lower', verifierPassRate:'higher' } });
  assert.equal(e.perMetric.verifierPassRate, 'na');
  assert.equal(e.verdict, 'promote');
});

// glmps loop-measurement-honesty Task 4: promotion-view.js's aggregateByUnit
// now returns evidence-tagged envelopes ({value, evidence, n}) instead of
// bare numbers. evaluatePromotion must unwrap `.value` transparently so the
// Pareto comparison is unaffected either way.
test('evaluatePromotion produces the same verdict for tagged-metric input as for bare numbers', () => {
  const champBare = { turns: 5, verifierPassRate: 0.7, firstTryRate: 0.5 };
  const chalBare  = { turns: 4, verifierPassRate: 0.7, firstTryRate: 0.6 };
  const bare = evaluatePromotion({ champion: champBare, challenger: chalBare, directions: dirs });

  const tag = (value, n = 5) => ({ value, evidence: 'measured', n });
  const champTagged = { turns: tag(5), verifierPassRate: tag(0.7), firstTryRate: tag(0.5) };
  const chalTagged  = { turns: tag(4), verifierPassRate: tag(0.7), firstTryRate: tag(0.6) };
  const tagged = evaluatePromotion({ champion: champTagged, challenger: chalTagged, directions: dirs });

  assert.deepEqual(tagged, bare);
  assert.equal(tagged.verdict, 'promote');
});
