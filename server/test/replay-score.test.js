import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreReplay, scoreReplayHistory } from '../lib/evaluation/replay-score.js';

test('more turns regresses; better verifier and firstTry improve', () => {
  const base = { turns: 3, verifier: { exitOk: false }, firstTry: false, tokens: {}, wallClockMs: {}, acceptance: {} };
  const prod = { turns: 5, verifier: { exitOk: true }, firstTry: true, tokens: {}, wallClockMs: {}, acceptance: {} };
  const s = scoreReplay(base, prod);
  assert.equal(s.perMetric.turns, 'worse');
  assert.equal(s.perMetric['verifier.exitOk'], 'better');
  assert.equal(s.perMetric.firstTry, 'better');
  assert.deepEqual(s.regressed, ['turns']);
  assert.ok(s.improved.includes('verifier.exitOk'));
  assert.ok(s.improved.includes('firstTry'));
});

test('fewer turns (lower-is-better) improves', () => {
  const base = { turns: 5 };
  const prod = { turns: 3 };
  assert.equal(scoreReplay(base, prod).perMetric.turns, 'better');
});

test('same value on both sides -> same', () => {
  const base = { turns: 3, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  const prod = { turns: 3, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  assert.equal(scoreReplay(base, prod).perMetric.turns, 'same');
});

test('missing/null field -> na', () => {
  const base = { turns: null, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  const prod = { turns: 4, verifier: {}, tokens: {}, wallClockMs: {}, acceptance: {} };
  assert.equal(scoreReplay(base, prod).perMetric.turns, 'na');
});

test('field absent entirely (no key at all) -> na, not a throw', () => {
  const base = {};
  const prod = {};
  const s = scoreReplay(base, prod);
  assert.equal(s.perMetric.turns, 'na');
  assert.equal(s.perMetric['tokens.in'], 'na');
  assert.equal(s.regressed.length, 0);
  assert.equal(s.improved.length, 0);
});

test('dot-path resolution: tokens.in and wallClockMs.total', () => {
  const base = { tokens: { in: 1000 }, wallClockMs: { total: 5000 } };
  const prod = { tokens: { in: 1200 }, wallClockMs: { total: 4000 } };
  const s = scoreReplay(base, prod);
  // lower-is-better: produced higher tokens.in -> worse
  assert.equal(s.perMetric['tokens.in'], 'worse');
  // lower-is-better: produced lower wallClockMs.total -> better
  assert.equal(s.perMetric['wallClockMs.total'], 'better');
});

test('boolean coercion: verifier.exitOk true vs false is better, not na', () => {
  const base = { verifier: { exitOk: false } };
  const prod = { verifier: { exitOk: true } };
  const s = scoreReplay(base, prod).perMetric['verifier.exitOk'];
  assert.equal(s, 'better');
});

test('boolean coercion: both false -> same, not na', () => {
  const base = { verifier: { exitOk: false } };
  const prod = { verifier: { exitOk: false } };
  assert.equal(scoreReplay(base, prod).perMetric['verifier.exitOk'], 'same');
});

test('boolean coercion: acceptance.met regressing true -> false is worse', () => {
  const base = { acceptance: { met: true } };
  const prod = { acceptance: { met: false } };
  assert.equal(scoreReplay(base, prod).perMetric['acceptance.met'], 'worse');
});

test('regressed and improved arrays only contain their respective directions', () => {
  const base = { turns: 3, tokens: { in: 100, out: 50 }, verifier: { exitOk: true }, firstTry: true };
  const prod = { turns: 6, tokens: { in: 100, out: 40 }, verifier: { exitOk: true }, firstTry: false };
  const s = scoreReplay(base, prod);
  assert.deepEqual(s.regressed.sort(), ['firstTry', 'turns'].sort());
  assert.deepEqual(s.improved.sort(), ['tokens.out'].sort());
  assert.equal(s.perMetric.turns, 'worse');
  assert.equal(s.perMetric['tokens.out'], 'better');
  assert.equal(s.perMetric['tokens.in'], 'same');
  assert.equal(s.perMetric.firstTry, 'worse');
  assert.equal(s.perMetric['verifier.exitOk'], 'same');
});


test('scoreReplayHistory scores every row against the baseline, sorted oldest-to-newest', () => {
  const base = { turns: 5 };
  const rows = [
    { ts: 3000, turns: 3 }, // better, out of order on input
    { ts: 1000, turns: 8 }, // worse
    { ts: 2000, turns: 5 }, // same
  ];
  const history = scoreReplayHistory(base, rows);
  assert.deepEqual(history.map(h => h.ts), [1000, 2000, 3000]);
  assert.equal(history[0].score.perMetric.turns, 'worse');
  assert.equal(history[1].score.perMetric.turns, 'same');
  assert.equal(history[2].score.perMetric.turns, 'better');
  assert.equal(history[0].produced.ts, 1000); // the original row, not just the score
});

test('scoreReplayHistory never mutates the input rows array', () => {
  const base = { turns: 5 };
  const rows = [{ ts: 2000, turns: 3 }, { ts: 1000, turns: 4 }];
  const before = rows.map(r => r.ts);
  scoreReplayHistory(base, rows);
  assert.deepEqual(rows.map(r => r.ts), before);
});

test('scoreReplayHistory with no baseline returns an empty array (never scores against nothing)', () => {
  assert.deepEqual(scoreReplayHistory(null, [{ ts: 1, turns: 3 }]), []);
});

test('scoreReplayHistory with no rows returns an empty array', () => {
  assert.deepEqual(scoreReplayHistory({ turns: 5 }, []), []);
});
