import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByUnit, promotionView } from '../lib/evaluation/promotion-view.js';

const rows = [
  // champion unit 'v1' - 3 rows, decent
  { unit: 'v1', taskClass: 'feature', turns: 5, firstTry: true,  verifier: { exitOk: true },  contextUsageRatio: 0.5 },
  { unit: 'v1', taskClass: 'feature', turns: 5, firstTry: false, verifier: { exitOk: true },  contextUsageRatio: 0.5 },
  { unit: 'v1', taskClass: 'bug',     turns: 6, firstTry: true,  verifier: { exitOk: false }, contextUsageRatio: 0.4 },
  // challenger unit 'v2' - 2 rows, strictly better
  { unit: 'v2', taskClass: 'feature', turns: 3, firstTry: true,  verifier: { exitOk: true },  contextUsageRatio: 0.3 },
  { unit: 'v2', taskClass: 'bug',     turns: 3, firstTry: true,  verifier: { exitOk: true },  contextUsageRatio: 0.3 },
];

test('aggregateByUnit computes per-unit metrics', () => {
  const a = aggregateByUnit(rows);
  assert.equal(a.v1.n, 3);
  assert.equal(a.v2.n, 2);
  assert.equal(a.v1.medianTurns.value, 5);
  assert.equal(a.v2.medianTurns.value, 3);
  assert.equal(a.v2.verifierPassRate.value, 1);
});

test('aggregateByUnit: metrics are evidence-tagged', () => {
  const rows2 = [
    { unit: 'a', turns: 3, verifier: { exitOk: true }, firstTry: true, contextUsageRatio: 0.5 },
    { unit: 'a', turns: 5, verifier: { exitOk: false }, firstTry: false, contextUsageRatio: 0.7 },
  ];
  const byUnit = aggregateByUnit(rows2);
  assert.equal(byUnit.a.medianTurns.value, 4);
  assert.equal(byUnit.a.medianTurns.evidence, 'measured');
});

test('promotionView: challenger dominates -> promote (champion = most outcomes)', () => {
  const v = promotionView(rows);
  assert.equal(v.available, true);
  assert.equal(v.champion.unit, 'v1'); // n=3
  assert.equal(v.challenger.unit, 'v2');
  assert.equal(v.verdict, 'promote');
  assert.equal(v.perMetric.medianTurns, 'better');
});

test('promotionView: explicit champion/challenger swap -> reject (regression)', () => {
  const v = promotionView(rows, { champion: 'v2', challenger: 'v1' });
  assert.equal(v.champion.unit, 'v2');
  assert.equal(v.challenger.unit, 'v1');
  assert.equal(v.verdict, 'reject'); // v1 worse on turns
});

test('promotionView: fewer than two units -> not available', () => {
  const v = promotionView([{ unit: 'only', turns: 3 }]);
  assert.equal(v.available, false);
  assert.match(v.reason, /two units/);
});


test('promotionView: sequential.available is false with too few per-unit rows (units n=3/n=2)', () => {
  const v = promotionView(rows); // v1 has 3 rows, v2 has 2 - both below the default minSamples
  assert.equal(v.available, true); // top-level: enough UNITS to compare
  assert.ok(v.sequential, 'sequential field present');
  assert.equal(v.sequential.available, false); // but not enough SAMPLES for the sequential test
  assert.match(v.sequential.reason, /not enough samples/);
});

test('promotionView: sequential.available is true and decides B when challenger has clearly fewer turns', () => {
  // verifier/firstTry are populated (not left undefined) so medianTurns isn't
  // the only measured metric here: at n=6 per unit (below evidence.js's
  // MIN_CONSTANT_N=10) they land 'measured' regardless of their own variance,
  // clearing Task 5's two-measured-metrics gate without changing the turns
  // story this test is actually about.
  const manyRows = [
    ...Array.from({ length: 6 }, () => ({ unit: 'v1', turns: 10, verifier: { exitOk: true }, firstTry: true })),
    ...Array.from({ length: 6 }, () => ({ unit: 'v2', turns: 2, verifier: { exitOk: true }, firstTry: true })),
  ];
  const v = promotionView(manyRows, { champion: 'v1', challenger: 'v2' });
  assert.equal(v.available, true);
  assert.equal(v.sequential.available, true);
  // turns is lower-is-better and the challenger's turns are far lower -> the
  // sign-flip makes 'B' read as "challenger better", matching the Pareto verdict.
  assert.equal(v.sequential.decision, 'B');
  assert.equal(v.verdict, 'promote');
});


test('promotionView: fewer than two measured metrics on either side -> insufficient-evidence, no recommendation', () => {
  // All four metrics have zero variance within each unit (medianContextUsage
  // included: it is constant per unit, just a different constant between
  // 'a' and 'b', which is irrelevant to tagValue - it only looks at
  // variance WITHIN a unit's own samples). n=11 for 'a' meets evidence.js's
  // MIN_CONSTANT_N=10, so medianTurns/firstTryRate/medianContextUsage land
  // 'constant' there (0 measured metrics). n=8 for 'b' falls under that
  // threshold, so the same three metrics land 'measured' instead (3
  // measured metrics). verifierPassRate is 'absent' on both sides (every
  // row's exitOk is null, so 0 valid samples). The gate trips because it
  // requires >= 2 measured metrics on EACH side and the champion has zero,
  // even though the challenger clears it on its own.
  const constRows = (unit, n) => new Array(n).fill(0).map(() => ({ unit, turns: 0, verifier: { exitOk: null }, firstTry: true, contextUsageRatio: unit === 'a' ? 0.16 : 0.09 }));
  const rows = [...constRows('a', 11), ...constRows('b', 8)];
  const v = promotionView(rows, { champion: 'a', challenger: 'b' });
  assert.equal(v.available, true);
  assert.equal(v.verdict, 'insufficient-evidence');
  assert.equal(v.n.champion, 11);
  assert.equal(v.n.challenger, 8);
  assert.ok(v.perMetric); // per-metric evidence tags present for inspection
});

test('promotionView: two or more measured metrics -> a real verdict, unchanged from before', () => {
  const rows = [
    { unit: 'a', turns: 3, verifier: { exitOk: true }, firstTry: true, contextUsageRatio: 0.5 },
    { unit: 'a', turns: 4, verifier: { exitOk: true }, firstTry: false, contextUsageRatio: 0.4 },
    { unit: 'b', turns: 8, verifier: { exitOk: false }, firstTry: false, contextUsageRatio: 0.6 },
    { unit: 'b', turns: 9, verifier: { exitOk: false }, firstTry: true, contextUsageRatio: 0.7 },
  ];
  const v = promotionView(rows, { champion: 'a', challenger: 'b' });
  assert.notEqual(v.verdict, 'insufficient-evidence');
});
