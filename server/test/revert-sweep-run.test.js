// server/test/revert-sweep-run.test.js
//
// The orchestration A0.3 shipped without a caller for. Every dependency is
// injected, so nothing here spawns git or touches a real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRevertSweep } from '../lib/evaluation/revert-sweep-run.js';

const NOW = Date.parse('2026-08-21T22:00:00.000Z');

function harness(over = {}) {
  const calls = { scan: [], sweep: [], orphan: [], written: [] };
  return {
    calls,
    deps: {
      now: NOW,
      readMark: () => null,
      writeMark: (sd, key, head) => { calls.written.push([key, head]); },
      scan: ({ repo, since }) => { calls.scan.push([repo, since]); return { refs: ['abc123'], head: 'head1' }; },
      sweep: (sd, args) => { calls.sweep.push(args); return { invalidated: ['L1'] }; },
      orphan: (sd, args) => { calls.orphan.push(args); return { orphaned: [] }; },
      worktreesFor: () => [],
      ...over,
    },
  };
}

test('scans each repo from its own watermark and advances it', async () => {
  const h = harness({ readMark: (sd, key) => (key === 'C:/a' ? 'oldhead' : null) });
  const out = await runRevertSweep('/state', { repos: ['C:/a', 'C:/b'], ...h.deps });
  assert.deepEqual(h.calls.scan, [['C:/a', 'oldhead'], ['C:/b', null]]);
  assert.deepEqual(h.calls.written, [['C:/a', 'head1'], ['C:/b', 'head1']]);
  assert.equal(out.repos.length, 2);
  assert.deepEqual(out.repos[0].invalidated, ['L1']);
});

test('sweeps with reason revert, and orphan-scans the same refs', async () => {
  const h = harness();
  await runRevertSweep('/state', { repos: ['C:/a'], ...h.deps });
  assert.equal(h.calls.sweep[0].reason, 'revert');
  assert.deepEqual(h.calls.sweep[0].refs, ['abc123']);
  assert.deepEqual(h.calls.orphan[0].refs, ['abc123']);
});

test('a repo with no reverts still advances its watermark, so the range is not rescanned forever', async () => {
  const h = harness({ scan: () => ({ refs: [], head: 'head2' }) });
  await runRevertSweep('/state', { repos: ['C:/a'], ...h.deps });
  assert.deepEqual(h.calls.written, [['C:/a', 'head2']]);
  assert.equal(h.calls.sweep.length, 0, 'no refs means no sweep call at all');
});

test('a scan error is recorded and does NOT advance the watermark or stop the other repos', async () => {
  // A scan that could not read the repo is not evidence of "no reverts".
  // Leaving the watermark alone is what makes the next night retry the range.
  const h = harness({
    scan: ({ repo }) => (repo === 'C:/a'
      ? { refs: [], head: null, error: 'not a git repo' }
      : { refs: [], head: 'head3' }),
  });
  const out = await runRevertSweep('/state', { repos: ['C:/a', 'C:/b'], ...h.deps });
  assert.equal(out.repos[0].error, 'not a git repo');
  assert.deepEqual(h.calls.written, [['C:/b', 'head3']], 'only the healthy repo advances');
});

test('a throwing dependency fails open: the tick must not die on one bad repo', async () => {
  const h = harness({ scan: () => { throw new Error('boom'); } });
  const out = await runRevertSweep('/state', { repos: ['C:/a'], ...h.deps });
  assert.match(out.repos[0].error, /boom/);
  assert.deepEqual(h.calls.written, []);
});

test('no repos configured is a clean no-op, not a crash', async () => {
  const h = harness();
  assert.deepEqual((await runRevertSweep('/state', { repos: [], ...h.deps })).repos, []);
  assert.deepEqual((await runRevertSweep('/state', { ...h.deps })).repos, []);
  assert.deepEqual((await runRevertSweep('/state', { repos: ['', '   ', null], ...h.deps })).repos, []);
});
