// server/test/graph-refresh.test.js
// Unit tests for the pure scheduled-graph-rebuild decision logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGraphRebuildTick, selectRebuildRoots } from '../lib/observability/graph-refresh.js';

const HOUR = 60 * 60 * 1000;
const DUE = { enabled: true, running: false, lastRunAt: null, now: 1_000_000, minIntervalMs: 24 * HOUR };


test('not due when the schedule is disabled', () => {
  assert.equal(planGraphRebuildTick({ ...DUE, enabled: false }), false);
});

test('not due while a previous rebuild is still running (single-flight)', () => {
  assert.equal(planGraphRebuildTick({ ...DUE, running: true }), false);
});

test('due on the first tick when it has never run', () => {
  assert.equal(planGraphRebuildTick(DUE), true);
});

test('not due inside the throttle window', () => {
  const now = 100 * HOUR;
  assert.equal(planGraphRebuildTick({ ...DUE, now, lastRunAt: now - 23 * HOUR }), false);
});

test('due once the throttle window has elapsed', () => {
  const now = 100 * HOUR;
  assert.equal(planGraphRebuildTick({ ...DUE, now, lastRunAt: now - 24 * HOUR }), true);
});

test('not due when now or minIntervalMs is not a number', () => {
  assert.equal(planGraphRebuildTick({ ...DUE, now: undefined }), false);
  assert.equal(planGraphRebuildTick({ ...DUE, minIntervalMs: null }), false);
});

test('not due on empty input rather than throwing', () => {
  assert.equal(planGraphRebuildTick(), false);
  assert.equal(planGraphRebuildTick({}), false);
});

// The load-bearing difference from a gate on commit drift (`manifest.builtAtCommit
// !== headCommit`, the shape the wiki loop's own checker uses). A collapsed
// graph is rebuilt by the post-commit hook on EVERY commit, so its
// built_at_commit tracks HEAD exactly while the graph itself covers a handful
// of files. Gating this tick on commit drift would mean the 2026-07-28 stub
// (55 nodes of a 771-file repo, built at HEAD) never healed. The interval is
// the whole guard: it must fire blind.
test('due on interval alone, ignoring commit state (the collapsed-stub case)', () => {
  const now = 100 * HOUR;
  const due = planGraphRebuildTick({
    ...DUE, now, lastRunAt: now - 25 * HOUR,
    // deliberately passed and deliberately ignored
    builtAtCommit: 'abc1234', headCommit: 'abc1234',
  });
  assert.equal(due, true);
});


const hasGraphDir = (root) => ['/d/has-graph', '/d/broken-graph'].includes(root);

test('keeps roots that have a graphify-out directory', () => {
  assert.deepEqual(selectRebuildRoots(['/d/has-graph'], { hasGraphDir }), ['/d/has-graph']);
});

test('drops roots that never used graphify', () => {
  assert.deepEqual(selectRebuildRoots(['/d/no-graph'], { hasGraphDir }), []);
});

// The regression that motivated this feature. On 2026-07-28 graphify-out/ still
// held GRAPH_REPORT.md and graph.html but graph.json was gone, so graphPathFor()
// returned null. Selecting by graph.json presence would skip exactly the repo
// that needs repair, so selection keys off the DIRECTORY.
test('keeps a root whose graphify-out exists but graph.json is missing', () => {
  assert.deepEqual(selectRebuildRoots(['/d/broken-graph'], { hasGraphDir }), ['/d/broken-graph']);
});

test('filters a mixed list, preserving order', () => {
  const roots = ['/d/no-graph', '/d/has-graph', '/d/other', '/d/broken-graph'];
  assert.deepEqual(selectRebuildRoots(roots, { hasGraphDir }), ['/d/has-graph', '/d/broken-graph']);
});

test('returns empty for a non-array or missing predicate rather than throwing', () => {
  assert.deepEqual(selectRebuildRoots(null, { hasGraphDir }), []);
  assert.deepEqual(selectRebuildRoots(['/d/has-graph'], {}), []);
  assert.deepEqual(selectRebuildRoots(['/d/has-graph']), []);
});

test('skips falsy entries in the root list', () => {
  assert.deepEqual(selectRebuildRoots(['', null, '/d/has-graph'], { hasGraphDir }), ['/d/has-graph']);
});
