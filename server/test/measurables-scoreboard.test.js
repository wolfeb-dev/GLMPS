import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMeasurablesScoreboard } from '../lib/evaluation/measurables-scoreboard.js';

test('empty input -> all-zero scoreboard, northStar null', () => {
  assert.deepEqual(buildMeasurablesScoreboard([]), { tracked: 0, byKind: {}, approved: 0, rejected: 0, pruned: 0, unlabeled: 0, northStar: null });
});

test('buckets by latest label decision; unlabeled means an empty labels array', () => {
  const measurables = [
    { kind: 'guard-retire', labels: [] },
    { kind: 'guard-retire', labels: [{ decision: 'approve' }] },
    { kind: 'skill-retire', labels: [{ decision: 'reject' }] },
    { kind: 'workspace-divergence', labels: [{ decision: 'prune' }] },
  ];
  const s = buildMeasurablesScoreboard(measurables);
  assert.equal(s.tracked, 4);
  assert.deepEqual(s.byKind, { 'guard-retire': 2, 'skill-retire': 1, 'workspace-divergence': 1 });
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.pruned, 1);
  assert.equal(s.unlabeled, 1);
});

test('the LAST label wins when a measurable has been labeled more than once', () => {
  const s = buildMeasurablesScoreboard([{ kind: 'guard-retire', labels: [{ decision: 'approve' }, { decision: 'prune' }] }]);
  assert.equal(s.pruned, 1);
  assert.equal(s.approved, 0);
});

test('malformed rows are skipped, not fatal to the rollup', () => {
  const s = buildMeasurablesScoreboard([null, undefined, { kind: 'x', labels: [] }]);
  assert.equal(s.tracked, 3);
  assert.equal(s.unlabeled, 1); // only the one well-formed row counted into a bucket
});
