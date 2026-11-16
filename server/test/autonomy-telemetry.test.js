// server/test/autonomy-telemetry.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOUCH_TYPES,
  recordTouch,
  readTouches,
  autonomyMetrics,
  graduationDecision,
  recordGraduation,
  readGraduations,
  currentTiers,
  runGraduationSweep,
} from '../lib/evaluation/autonomy-telemetry.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-autonomy-')); }

const DAY = 86400000;
const T0 = Date.parse('2026-08-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// Build `n` merges of one task class, none of them touched. Refs are namespaced
// by task class because a ref is a GLOBAL join key in production (a PR url or a
// sha), so a fixture that reuses one ref across two classes would be modelling
// something that cannot happen.
function cleanMerges(n, { taskClass = 'docs', from = T0 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ ref: `${taskClass}-pr-${i + 1}`, taskClass, ts: iso(from + i * DAY) }));
}

// recordTouch

test('recordTouch rejects an unknown touch type', () => {
  const dir = tmp();
  assert.throws(() => recordTouch(dir, { type: 'vibes', ref: 'pr-1' }), TypeError);
  assert.equal(readTouches(dir).length, 0);
});

test('recordTouch emits a human.touch spine event carrying the ref and task class', () => {
  const dir = tmp();
  recordTouch(dir, { type: 'manual-edit', ref: 'pr-7', taskClass: 'feature', actor: 'operator', ts: iso(T0) });
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.HUMAN_TOUCH });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.type, 'manual-edit');
  assert.equal(ev[0].payload.ref, 'pr-7');
  assert.equal(ev[0].payload.taskClass, 'feature');
  assert.equal(ev[0].actor, 'operator');
});

test('every declared touch type is accepted', () => {
  const dir = tmp();
  for (const t of TOUCH_TYPES) {
    assert.doesNotThrow(() => recordTouch(dir, { type: t, ref: `r-${t}`, ts: iso(T0) }));
  }
  assert.equal(readTouches(dir).length, TOUCH_TYPES.length);
});

// autonomyMetrics

test('a merge with no touches counts as a zero-edit merge', () => {
  const m = autonomyMetrics([], cleanMerges(4), { windowDays: 30, now: T0 + 10 * DAY });
  assert.equal(m.byTaskClass.docs.zeroEditMergeRate, 1);
  assert.equal(m.byTaskClass.docs.touchesPerMerge, 0);
  assert.equal(m.byTaskClass.docs.consecutiveZeroEdit, 4);
});

test('a review comment or manual edit against a merge breaks its zero-edit status', () => {
  const merges = cleanMerges(4);
  const touches = [{ type: 'review-comment', ref: 'docs-pr-2', taskClass: 'docs', ts: iso(T0 + DAY) }];
  const m = autonomyMetrics(touches, merges, { windowDays: 30, now: T0 + 10 * DAY });
  assert.equal(m.byTaskClass.docs.zeroEditMergeRate, 0.75);
  assert.equal(m.byTaskClass.docs.touchesPerMerge, 0.25);
});

test('consecutiveZeroEdit counts only the trailing streak, not the total', () => {
  // pr-1 clean, pr-2 touched, pr-3 and pr-4 clean -> trailing streak is 2.
  const touches = [{ type: 'manual-edit', ref: 'docs-pr-2', taskClass: 'docs', ts: iso(T0 + DAY) }];
  const m = autonomyMetrics(touches, cleanMerges(4), { windowDays: 30, now: T0 + 10 * DAY });
  assert.equal(m.byTaskClass.docs.consecutiveZeroEdit, 2);
});

test('a manual revert raises the revert rate and is not counted as a zero-edit merge', () => {
  const touches = [{ type: 'manual-revert', ref: 'docs-pr-3', taskClass: 'docs', ts: iso(T0 + 3 * DAY) }];
  const m = autonomyMetrics(touches, cleanMerges(4), { windowDays: 30, now: T0 + 10 * DAY });
  assert.equal(m.byTaskClass.docs.revertRate, 0.25);
  assert.equal(m.byTaskClass.docs.zeroEditMergeRate, 0.75);
});

test('merges outside the window are excluded', () => {
  const merges = [...cleanMerges(2, { from: T0 }), ...cleanMerges(3, { from: T0 + 100 * DAY })];
  const m = autonomyMetrics([], merges, { windowDays: 7, now: T0 + 103 * DAY });
  assert.equal(m.byTaskClass.docs.merges, 3);
});

test('task classes are reported independently, never blended', () => {
  const merges = [...cleanMerges(2, { taskClass: 'docs' }), ...cleanMerges(2, { taskClass: 'feature' })];
  const touches = [{ type: 'manual-edit', ref: 'feature-pr-1', taskClass: 'feature', ts: iso(T0) }];
  const m = autonomyMetrics(touches, merges, { windowDays: 30, now: T0 + 10 * DAY });
  assert.equal(m.byTaskClass.docs.zeroEditMergeRate, 1);
  assert.ok(m.byTaskClass.feature.zeroEditMergeRate < 1);
});

test('a task class with no merges reports no rates rather than dividing by zero', () => {
  const m = autonomyMetrics([{ type: 'manual-rerun', ref: 'x', taskClass: 'ops', ts: iso(T0) }], [], { windowDays: 30, now: T0 });
  assert.equal(m.byTaskClass.ops.merges, 0);
  assert.equal(m.byTaskClass.ops.zeroEditMergeRate, null);
  assert.equal(m.byTaskClass.ops.revertRate, null);
});

// graduationDecision

test('ten consecutive zero-edit merges graduate a task class one tier', () => {
  const m = autonomyMetrics([], cleanMerges(10), { windowDays: 60, now: T0 + 20 * DAY });
  const d = graduationDecision({ metrics: m.byTaskClass.docs, tier: 0 });
  assert.equal(d.action, 'graduate');
  assert.equal(d.tier, 1);
});

test('nine consecutive zero-edit merges do not graduate', () => {
  const m = autonomyMetrics([], cleanMerges(9), { windowDays: 60, now: T0 + 20 * DAY });
  assert.equal(graduationDecision({ metrics: m.byTaskClass.docs, tier: 0 }).action, 'hold');
});

test('a single revert demotes one tier even when the streak would otherwise graduate', () => {
  const merges = cleanMerges(11);
  const touches = [{ type: 'manual-revert', ref: 'docs-pr-1', taskClass: 'docs', ts: iso(T0) }];
  const m = autonomyMetrics(touches, merges, { windowDays: 60, now: T0 + 20 * DAY });
  const d = graduationDecision({ metrics: m.byTaskClass.docs, tier: 2 });
  assert.equal(d.action, 'demote');
  assert.equal(d.tier, 1);
});

test('a demotion never drops below tier 0', () => {
  const touches = [{ type: 'manual-revert', ref: 'docs-pr-1', taskClass: 'docs', ts: iso(T0) }];
  const m = autonomyMetrics(touches, cleanMerges(2), { windowDays: 60, now: T0 + 20 * DAY });
  const d = graduationDecision({ metrics: m.byTaskClass.docs, tier: 0 });
  assert.equal(d.action, 'hold');
  assert.equal(d.tier, 0);
});

test('graduation is capped at the configured maximum tier', () => {
  const m = autonomyMetrics([], cleanMerges(12), { windowDays: 60, now: T0 + 20 * DAY });
  const d = graduationDecision({ metrics: m.byTaskClass.docs, tier: 1, config: { maxTier: 1 } });
  assert.equal(d.action, 'hold');
  assert.equal(d.tier, 1);
});

test('the graduation threshold is configurable', () => {
  const m = autonomyMetrics([], cleanMerges(3), { windowDays: 60, now: T0 + 20 * DAY });
  assert.equal(graduationDecision({ metrics: m.byTaskClass.docs, tier: 0, config: { graduateAfter: 3 } }).action, 'graduate');
});

// recordGraduation

test('a graduation is written as a decision event, not silently applied', () => {
  const dir = tmp();
  recordGraduation(dir, { taskClass: 'docs', action: 'graduate', from: 0, to: 1, reason: '10 consecutive zero-edit merges', ts: iso(T0) });
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.DECISION_RECORDED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.kind, 'autonomy_graduation');
  assert.equal(ev[0].payload.taskClass, 'docs');
  assert.equal(ev[0].payload.to, 1);
  assert.equal(readGraduations(dir).length, 1);
});

test('a hold is not recorded as a graduation event', () => {
  const dir = tmp();
  assert.throws(() => recordGraduation(dir, { taskClass: 'docs', action: 'hold', from: 0, to: 0 }));
  assert.equal(readGraduations(dir).length, 0);
});

// graduationDecision/recordGraduation/readGraduations were reached only from
// this test file: no route, no timer, nothing in production ever called them,
// so no task class could ever actually graduate. Tier state is DERIVED from
// the spine rather than stored, so the event log stays the single source of
// truth and no new store is introduced to drift out of sync with it.

test('currentTiers reads the latest graduation per class from the spine, defaulting to none', () => {
  const dir = tmp();
  assert.deepEqual(currentTiers(dir), {});
  recordGraduation(dir, { taskClass: 'docs', action: 'graduate', from: 0, to: 1, ts: iso(T0) });
  recordGraduation(dir, { taskClass: 'docs', action: 'graduate', from: 1, to: 2, ts: iso(T0 + DAY) });
  recordGraduation(dir, { taskClass: 'ui', action: 'graduate', from: 0, to: 1, ts: iso(T0 + 2 * DAY) });
  assert.deepEqual(currentTiers(dir), { docs: 2, ui: 1 });
});

test('the sweep records graduations but never a hold', () => {
  const dir = tmp();
  const metrics = { byTaskClass: {
    docs: { consecutiveZeroEdit: 10, reverts: 0 },
    ui: { consecutiveZeroEdit: 3, reverts: 0 },
  } };
  const acted = runGraduationSweep(dir, { metrics, now: iso(T0) });
  assert.deepEqual(acted.map(a => [a.taskClass, a.action]), [['docs', 'graduate']]);
  assert.equal(readGraduations(dir).length, 1, 'ui held, so nothing was written for it');
  assert.deepEqual(currentTiers(dir), { docs: 1 });
});

test('a revert demotes a class that had graduated', () => {
  const dir = tmp();
  recordGraduation(dir, { taskClass: 'docs', action: 'graduate', from: 0, to: 1, ts: iso(T0) });
  const acted = runGraduationSweep(dir, {
    metrics: { byTaskClass: { docs: { consecutiveZeroEdit: 0, reverts: 1 } } },
    now: iso(T0 + DAY),
  });
  assert.deepEqual(acted.map(a => [a.taskClass, a.action, a.to]), [['docs', 'demote', 0]]);
  assert.deepEqual(currentTiers(dir), { docs: 0 });
});

test('the sweep is idempotent within a night: a class already at its earned tier holds', () => {
  const dir = tmp();
  const metrics = { byTaskClass: { docs: { consecutiveZeroEdit: 10, reverts: 0 } } };
  runGraduationSweep(dir, { metrics, now: iso(T0) });
  const second = runGraduationSweep(dir, { metrics, now: iso(T0 + DAY) });
  assert.deepEqual(second.map(a => [a.taskClass, a.action]), [['docs', 'graduate']],
    'tier 1 -> 2 is a real second step, not a duplicate');
  const third = runGraduationSweep(dir, { metrics, now: iso(T0 + 2 * DAY) });
  assert.deepEqual(third, [], 'at maxTier it holds, and a hold writes nothing');
});

test('an empty metrics object is a clean no-op', () => {
  const dir = tmp();
  assert.deepEqual(runGraduationSweep(dir, { metrics: { byTaskClass: {} }, now: iso(T0) }), []);
  assert.deepEqual(runGraduationSweep(dir, { now: iso(T0) }), []);
});
