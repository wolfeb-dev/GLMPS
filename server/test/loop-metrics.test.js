// server/test/loop-metrics.test.js
// Task 2 (glmps-138): buildLoopMetrics() extends the changes ledger with the
// 4 paired, denominator-visible Loop metrics (acceptance/regression/
// guardHits/lifecycle) over a rolling window. Pure, consumes only the
// already-built SystemChange[] (no I/O).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoopMetrics } from '../lib/evaluation/system-changes.js';

const MS_PER_DAY = 86400000;
const NOW = Date.parse('2026-07-21T00:00:00Z');
const daysAgo = (n) => NOW - n * MS_PER_DAY;

function change(overrides) {
  return {
    id: 'x', type: 'guard', title: 't', evidence: {}, status: 'proposed',
    measuredEffect: null, gatePolicy: 'medium', ts: daysAgo(1),
    ...overrides,
  };
}

test('buildLoopMetrics: empty input -> zeros everywhere, no divide-by-zero', () => {
  const m = buildLoopMetrics([], { now: NOW });
  assert.deepEqual(m, {
    acceptance: { accepted: 0, proposed: 0, rate: 0 },
    regression: { reverted: 0, adopted: 0, rate: 0, band: 'low' },
    guardHits: { count: 0 },
    lifecycle: { adopted: 0, deprecated: 0, retired: 0 },
  });
});

test('buildLoopMetrics: acceptance rate is accepted/proposed with the denominator visible', () => {
  const changes = [
    change({ id: 'a', type: 'skill', status: 'kept' }),
    change({ id: 'b', type: 'skill', status: 'kept' }),
    change({ id: 'c', type: 'skill', status: 'kept' }),
    change({ id: 'd', type: 'skill', status: 'proposed' }),
    change({ id: 'e', type: 'skill', status: 'measuring' }),
    change({ id: 'f', type: 'skill', status: 'reverted' }),
    change({ id: 'g', type: 'skill', status: 'proposed' }),
    change({ id: 'h', type: 'skill', status: 'proposed' }),
    change({ id: 'i', type: 'skill', status: 'proposed' }),
    change({ id: 'j', type: 'skill', status: 'proposed' }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.acceptance, { accepted: 3, proposed: 10, rate: 0.3 });
});

test('buildLoopMetrics: regression band boundaries (0.04 low, 0.10 healthy, 0.25 high)', () => {
  const rowsFor = (reverted, adopted) => {
    const out = [];
    for (let i = 0; i < adopted; i++) out.push(change({ id: `kept-${i}`, type: 'promotion', status: 'kept' }));
    for (let i = 0; i < reverted; i++) out.push(change({ id: `rev-${i}`, type: 'promotion', status: 'reverted' }));
    return out;
  };

  const low = buildLoopMetrics(rowsFor(1, 25), { now: NOW });
  assert.equal(low.regression.rate, 0.04);
  assert.equal(low.regression.band, 'low');

  const healthy = buildLoopMetrics(rowsFor(2, 20), { now: NOW });
  assert.equal(healthy.regression.rate, 0.1);
  assert.equal(healthy.regression.band, 'healthy');

  const high = buildLoopMetrics(rowsFor(5, 20), { now: NOW });
  assert.equal(high.regression.rate, 0.25);
  assert.equal(high.regression.band, 'high');
});

test('buildLoopMetrics: regression band boundary edges are inclusive of healthy (0.05 and 0.20)', () => {
  const rowsFor = (reverted, adopted) => {
    const out = [];
    for (let i = 0; i < adopted; i++) out.push(change({ id: `kept-${i}`, type: 'promotion', status: 'kept' }));
    for (let i = 0; i < reverted; i++) out.push(change({ id: `rev-${i}`, type: 'promotion', status: 'reverted' }));
    return out;
  };
  assert.equal(buildLoopMetrics(rowsFor(1, 20), { now: NOW }).regression.band, 'healthy'); // 0.05
  assert.equal(buildLoopMetrics(rowsFor(1, 5), { now: NOW }).regression.band, 'healthy'); // 0.20
});

test('buildLoopMetrics: zero adopted -> regression rate 0, band low, no divide-by-zero', () => {
  const changes = [change({ id: 'a', type: 'promotion', status: 'reverted' })];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.regression, { reverted: 1, adopted: 0, rate: 0, band: 'low' });
});

// glmps-138 I1 fix: guardHits.count is a caller-supplied real shadow-arm
// fire count, NEVER derived by counting guard-type SystemChange rows (that
// counted distinct guard IDEAS present in the window, not fire EVENTS).
test('buildLoopMetrics: guardHits.count is exactly the caller-supplied guardFires value, ignoring guard-type row count entirely', () => {
  const changes = [
    change({ id: 'g1', type: 'guard', status: 'proposed' }),
    change({ id: 'g2', type: 'guard', status: 'measuring' }),
    change({ id: 'g3', type: 'guard', status: 'reverted' }),
    change({ id: 's1', type: 'skill', status: 'kept' }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW, guardFires: 42 });
  assert.deepEqual(m.guardHits, { count: 42 }); // NOT 3 (the guard-type row count)
});

test('buildLoopMetrics: guardHits.count defaults to 0 when no guardFires is supplied (never falls back to row count)', () => {
  const changes = [
    change({ id: 'g1', type: 'guard', status: 'measuring' }),
    change({ id: 'g2', type: 'guard', status: 'measuring' }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.guardHits, { count: 0 });
});

// glmps-138 I2/I3 fix: 'measurable' rows are excluded from acceptance too
// (not just lifecycle) - a measurable is a meta-decision about retiring a
// different capability, not a capability adoption itself.
test('buildLoopMetrics: type:measurable rows are excluded from acceptance.proposed and .accepted', () => {
  const changes = [
    change({ id: 's1', type: 'skill', status: 'kept' }),
    change({ id: 'm1', type: 'measurable', status: 'kept' }),
    change({ id: 'm2', type: 'measurable', status: 'proposed' }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.acceptance, { accepted: 1, proposed: 1, rate: 1 });
});

// glmps-138 I2 fix: a guard whose native status is 'applied' (SystemChange
// status 'measuring') has reached active use and must count as accepted/
// adopted, even though it never reaches literal 'kept' (GUARD_STATUS has no
// path to 'kept' at all).
test('buildLoopMetrics: a guard in status measuring counts as accepted/adopted (not only literal kept)', () => {
  const changes = [
    change({ id: 'g1', type: 'guard', status: 'measuring' }),
    change({ id: 'g2', type: 'guard', status: 'proposed' }), // not yet applied, excluded
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.acceptance, { accepted: 1, proposed: 2, rate: 0.5 });
});

// glmps-138 I2/I3 fix: guard discarded/failed rows (SystemChange status
// 'reverted') are proposal-stage rejections that never reached applied/
// measuring - they must NOT count as regressions (the denominator they'd be
// dividing into structurally can never include a guard either).
//
// glmps-142: skill rows get the identical treatment now (s1 below used to
// count here - that was exactly the bug glmps-142 fixed: skill-adopt-
// store.js's rejectCandidate/resolveTrial can never reach 'rejected' from
// an already-'kept' item either, so a bare skill reverted row is, same as
// guard, structurally always a proposal-stage rejection). A promotion row
// is added instead to keep this test demonstrating a real, still-counted
// regression (promotion is NOT covered by the exclusion - see
// isProposalStageRejection's doc comment in system-changes.js).
test('buildLoopMetrics: guard AND skill reverted rows (proposal-stage rejections) are excluded from regression.reverted; promotion still counts', () => {
  const changes = [
    change({ id: 'g1', type: 'guard', status: 'measuring' }), // adopted
    change({ id: 'g2', type: 'guard', status: 'reverted' }),  // discarded/failed proposal, NOT a regression
    change({ id: 's1', type: 'skill', status: 'reverted' }),  // rejected skill-adopt candidate, NOT a regression (glmps-142)
    change({ id: 'p1', type: 'promotion', status: 'reverted' }), // promotion revert still counts
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.regression, { reverted: 1, adopted: 1, rate: 1, band: 'high' });
});

test('buildLoopMetrics: lifecycle splits isAdopted-non-measurable (adopted), measurable-type (deprecated), non-proposal-stage-reverted-non-measurable (retired)', () => {
  const changes = [
    change({ id: 'a1', type: 'skill', status: 'kept' }),
    change({ id: 'a2', type: 'research-candidate', status: 'kept' }),
    change({ id: 'd1', type: 'measurable', status: 'kept' }),
    change({ id: 'd2', type: 'measurable', status: 'proposed' }),
    change({ id: 'd3', type: 'measurable', status: 'reverted' }), // still type:'measurable' -> counts as deprecated, not retired
    change({ id: 'r1', type: 'guard', status: 'reverted' }),      // proposal-stage rejection -> excluded (glmps-138 I2/I3)
    change({ id: 'r2', type: 'research-candidate', status: 'reverted' }), // proposal-stage rejection -> excluded (glmps-142)
    change({ id: 'r3', type: 'promotion', status: 'reverted' }),  // NOT a proposal-stage exclusion -> counts as retired
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.deepEqual(m.lifecycle, { adopted: 2, deprecated: 3, retired: 1 });
});

// glmps-142: regression.reverted parity across kinds. Before this fix, only
// guard proposal-stage rejections were excluded (`c.type !== 'guard'`) - a
// skill-adopt candidate rejected while still quarantined/pending-approval/
// approved/trialing (never reaching 'kept'), or a research candidate
// retired while still quarantined/proposed/trialing (never reaching
// 'kept'), still counted as a "regression" even though neither was ever
// adopted. Both stores enforce the identical kind of TERMINAL-status guard
// the original guard-only exclusion relied on (skill-adopt-store.js's
// rejectCandidate/resolveTrial and research-scanner-store.js's
// retireCandidate/resolveTrial all throw if the item is already 'kept'), so
// - same as guard - every skill/research-
// candidate 'reverted' row is structurally a proposal-stage rejection, not
// a genuine regression, and isProposalStageRejection() now excludes all
// three kinds the same way (see system-changes.js's doc comment on that
// function for the full per-store verification).
//
// promotion is the one kind where a genuine "was adopted (champion), later
// reverted (dethroned)" IS possible - VERDICT_STATUS is a live recompute
// with no persisted terminal-status guard, unlike the other three kinds'
// real state machines - so it is deliberately NOT covered by the exclusion
// and a promotion 'reverted' row still counts, proving the fix is targeted
// (excludes exactly the three kinds with a real structural guarantee) and
// not an overcorrection that would silently hide every regression.
test('buildLoopMetrics: proposal-stage skill and research-candidate rejections do not count as regressions; a genuinely-reverted promotion still does (glmps-142 parity)', () => {
  const changes = [
    // Proposal-stage rejections, one per kind that has the real TERMINAL-
    // status guard - none of these was ever adopted, none should count.
    change({ id: 'guard-reject', type: 'guard', status: 'reverted' }),
    change({ id: 'skill-reject', type: 'skill', status: 'reverted', action: 'adopt' }),
    change({ id: 'research-reject', type: 'research-candidate', status: 'reverted' }),
    // Adopted capabilities in the same window, so regression has a non-zero
    // denominator to test the numerator against.
    change({ id: 'skill-kept', type: 'skill', status: 'kept' }),
    change({ id: 'research-kept', type: 'research-candidate', status: 'kept' }),
    change({ id: 'promotion-kept', type: 'promotion', status: 'kept' }),
    // The one kind where "genuinely adopted, then reverted" is real and
    // must still be counted - a formerly-champion unit dethroned by a
    // newer one (promotion-view.js has no terminal-status guard at all).
    change({ id: 'promotion-dethroned', type: 'promotion', status: 'reverted' }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  // adopted = 3 (skill-kept, research-kept, promotion-kept); reverted = 1
  // (promotion-dethroned only - the 3 proposal-stage rejections above are
  // excluded, which is the entire point of this test).
  assert.deepEqual(m.regression, { reverted: 1, adopted: 3, rate: 1 / 3, band: 'high' });
});

test('buildLoopMetrics: windowDays default is 30 (rolling from now); older changes are excluded', () => {
  const changes = [
    change({ id: 'in', type: 'skill', status: 'kept', ts: daysAgo(29) }),
    change({ id: 'out', type: 'skill', status: 'kept', ts: daysAgo(31) }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.equal(m.acceptance.proposed, 1);
  assert.equal(m.acceptance.accepted, 1);
});

test('buildLoopMetrics: an explicit windowDays overrides the 30-day default', () => {
  const changes = [
    change({ id: 'in7', type: 'skill', status: 'kept', ts: daysAgo(5) }),
    change({ id: 'out7', type: 'skill', status: 'kept', ts: daysAgo(10) }),
  ];
  const m = buildLoopMetrics(changes, { now: NOW, windowDays: 7 });
  assert.equal(m.acceptance.proposed, 1);
});

test('buildLoopMetrics: a change with ts:null is excluded from every windowed count, never throws', () => {
  const changes = [change({ id: 'no-ts', type: 'skill', status: 'kept', ts: null })];
  const m = buildLoopMetrics(changes, { now: NOW });
  assert.equal(m.acceptance.proposed, 0);
  assert.equal(m.acceptance.accepted, 0);
});

test('buildLoopMetrics: malformed input never throws', () => {
  assert.doesNotThrow(() => buildLoopMetrics(undefined, { now: NOW }));
  assert.doesNotThrow(() => buildLoopMetrics(null, { now: NOW }));
  assert.doesNotThrow(() => buildLoopMetrics([null, {}, { ts: 'not-a-number' }], { now: NOW }));
});
