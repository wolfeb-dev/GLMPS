// glmps-148: the Stage Board's derived logic had no automated coverage --
// npm test never loaded web/overview/stage-board.js, and stage-board-vitals.test.js
// covers only the half that moved server-side. These are the client-side pure
// helpers, now importable instead of duplicated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateText, fmtElapsed, toneOf, fmtResetIn,
  qaCountOf, trendFieldOf, qaSubLabel, fmtQaCount,
  TREND_FIELD, TREND_WARN_ON_UP, findHourAgoPoint, computeDelta,
} from '../../web/overview/stage-board-calc.js';


test('truncateText leaves short strings alone', () => {
  assert.equal(truncateText('abc', 10), 'abc');
  assert.equal(truncateText('exactly-10', 10), 'exactly-10');
});

test('truncateText ellipsizes and trims the trailing space', () => {
  assert.equal(truncateText('hello world', 8), 'hello w\u2026');
  assert.equal(truncateText('hello world', 7), 'hello\u2026');
});

test('truncateText coerces nullish to an empty string', () => {
  assert.equal(truncateText(null, 5), '');
  assert.equal(truncateText(undefined, 5), '');
});

test('truncateText survives a zero/negative max without throwing', () => {
  assert.equal(truncateText('abc', 0), '\u2026');
});


test('fmtElapsed returns null for unknown, never a fabricated 0s', () => {
  assert.equal(fmtElapsed(null), null);
  assert.equal(fmtElapsed(undefined), null);
});

test('fmtElapsed floors sub-second to 1s rather than 0s', () => {
  assert.equal(fmtElapsed(0), '1s');
  assert.equal(fmtElapsed(400), '1s');
});

test('fmtElapsed picks s/m/h by magnitude', () => {
  assert.equal(fmtElapsed(45_000), '45s');
  assert.equal(fmtElapsed(90_000), '2m');
  assert.equal(fmtElapsed(45 * 60_000), '45m');
  assert.equal(fmtElapsed(2 * 3_600_000), '2h');
});

test('toneOf: fresh < 5min, aging < 15min, else old; unknown reads fresh', () => {
  assert.equal(toneOf(null), 'fresh');
  assert.equal(toneOf(0), 'fresh');
  assert.equal(toneOf(5 * 60_000 - 1), 'fresh');
  assert.equal(toneOf(5 * 60_000), 'aging');
  assert.equal(toneOf(15 * 60_000 - 1), 'aging');
  assert.equal(toneOf(15 * 60_000), 'old');
});


const NOW = 1_000_000_000;

test('fmtResetIn rejects a non-numeric deadline', () => {
  assert.equal(fmtResetIn(null, NOW), null);
  assert.equal(fmtResetIn('soon', NOW), null);
});

test('fmtResetIn reports a passed deadline as now', () => {
  assert.equal(fmtResetIn(NOW, NOW), 'now');
  assert.equal(fmtResetIn(NOW - 1000, NOW), 'now');
});

test('fmtResetIn formats minutes and zero-padded hours', () => {
  assert.equal(fmtResetIn(NOW + 12 * 60_000, NOW), '12m');
  assert.equal(fmtResetIn(NOW + 72 * 60_000, NOW), '1h12m');
  assert.equal(fmtResetIn(NOW + 65 * 60_000, NOW), '1h05m');
});

// The regression this guards is real and measured (glmps-149): qa-trends points
// carry testCount null on runs whose log did not parse, while conclusion is set.

test('qaCountOf distinguishes an unparsed run from a real zero', () => {
  assert.equal(qaCountOf({ testCount: null }), null, 'null must not become 0');
  assert.equal(qaCountOf({ testCount: '' }), null, 'empty must not become 0');
  assert.equal(qaCountOf({ testCount: 0 }), 0, 'a real zero must survive');
});

test('qaCountOf parses numerics and rejects garbage', () => {
  assert.equal(qaCountOf({ testCount: 2936 }), 2936);
  assert.equal(qaCountOf({ testCount: '2936' }), 2936);
  assert.equal(qaCountOf({ testCount: 'many' }), null);
  assert.equal(qaCountOf(null), null);
  assert.equal(qaCountOf({}), null);
});


test('trendFieldOf honours the same null-vs-zero contract as qaCountOf', () => {
  const f = trendFieldOf('active');
  assert.equal(f({ active: null }), null);
  assert.equal(f({ active: '' }), null);
  assert.equal(f({ active: 0 }), 0);
  assert.equal(f({ active: '7' }), 7);
  assert.equal(f({ active: 'x' }), null);
  assert.equal(f(null), null);
});

test('trendFieldOf reads only its own field', () => {
  assert.equal(trendFieldOf('active')({ active: 3, uncommitted: 9 }), 3);
  assert.equal(trendFieldOf('uncommitted')({ active: 3, uncommitted: 9 }), 9);
  assert.equal(trendFieldOf('missing')({ active: 3 }), null);
});


test('qaSubLabel leads with the CI verdict', () => {
  assert.equal(qaSubLabel(true, 'good', {}), 'CI passing');
  assert.equal(qaSubLabel(true, 'bad', {}), 'CI failing');
  assert.equal(qaSubLabel(false, 'good', {}), 'Local runs only');
});

test('qaSubLabel names an unrecognised conclusion instead of guessing', () => {
  assert.equal(qaSubLabel(true, 'meh', { conclusion: 'cancelled' }), 'CI cancelled');
  assert.equal(qaSubLabel(true, 'meh', {}), 'CI unknown');
});

test('qaSubLabel appends failures only when there are some', () => {
  assert.equal(qaSubLabel(true, 'bad', { fail: 3 }), 'CI failing \u00B7 3 failed');
  assert.equal(qaSubLabel(true, 'good', { fail: 0 }), 'CI passing');
  assert.equal(qaSubLabel(true, 'good', { fail: null }), 'CI passing');
});

test('fmtQaCount groups thousands and treats junk as 0', () => {
  assert.equal(fmtQaCount(2936), (2936).toLocaleString());
  assert.equal(fmtQaCount(null), '0');
  assert.equal(fmtQaCount('x'), '0');
});


const HOUR = 60 * 60_000;
const pt = (ago, extra) => ({ ts: 10 * HOUR - ago, ...extra });

test('computeDelta compares the newest point with the one nearest an hour earlier', () => {
  const points = [pt(2 * HOUR, { active: 9 }), pt(HOUR + 60_000, { active: 2 }), pt(30 * 60_000, { active: 4 }), pt(0, { active: 5 })];
  assert.equal(findHourAgoPoint(points).active, 2);
  assert.equal(computeDelta(points, 'active'), 3);
});

test('computeDelta is null, never a fabricated zero, without a baseline or with a null end', () => {
  assert.equal(computeDelta([], 'active'), null);
  assert.equal(computeDelta([pt(0, { active: 5 })], 'active'), null);
  assert.equal(computeDelta([pt(3 * HOUR, { active: 5 }), pt(0, { active: 5 })], 'active'), null, 'no point within tolerance of an hour ago');
  assert.equal(computeDelta([pt(HOUR, { active: null }), pt(0, { active: 5 })], 'active'), null);
});

test('TREND_FIELD maps each tile to its record field; up is worse for five of them', () => {
  assert.equal(TREND_FIELD.gate, 'atGate');
  assert.equal(TREND_FIELD.queue, 'queued');
  assert.deepEqual([...TREND_WARN_ON_UP].sort(), ['alerts', 'budget', 'queue', 'stalled', 'uncommitted']);
});
