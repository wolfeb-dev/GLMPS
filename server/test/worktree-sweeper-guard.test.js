import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepSessionWorktrees } from '../lib/orchestration/worktree-sweeper.js';

const LISTING = [
  'worktree /repo', 'HEAD zzz', 'branch refs/heads/main', '',
  'worktree /w/p/card-1', 'HEAD ccc', 'branch refs/heads/glmps-runner/p/card-1', '',
].join('\n');

function exec(calls) {
  return (file, args) => {
    calls.push(args.join(' '));
    const j = args.join(' ');
    if (j.includes('worktree list')) return LISTING;
    if (j.includes('symbolic-ref')) return 'origin/main\n';
    if (j.includes('cherry') || j.includes('worktree remove') || j.includes('branch -d') || j.includes('worktree prune')) return '';
    throw new Error(`unexpected git call: ${j}`);
  };
}

test('sweep guard: a worktree the guard refuses is kept and never removed', async () => {
  const calls = [];
  const asked = [];
  const { removed, kept } = await sweepSessionWorktrees({
    repo: '/repo', worktreesDir: '/w', exec: exec(calls),
    guard: (item) => { asked.push(item); return { remove: false, reason: 'dirty' }; },
  });
  assert.deepEqual(asked, [{ dir: '/w/p/card-1', branch: 'glmps-runner/p/card-1' }]);
  assert.deepEqual(removed, []);
  assert.equal(kept.some((k) => k.dir === '/w/p/card-1'), true);
  assert.equal(calls.some((c) => c.includes('worktree remove')), false);
});

test('sweep guard: an approving (async) guard lets the removal proceed', async () => {
  const calls = [];
  const { removed } = await sweepSessionWorktrees({
    repo: '/repo', worktreesDir: '/w', exec: exec(calls),
    guard: async () => ({ remove: true, reason: 'clean-merged' }),
  });
  assert.deepEqual(removed, [{ dir: '/w/p/card-1', branch: 'glmps-runner/p/card-1' }]);
});

test('sweep guard: a throwing guard keeps the worktree (no evidence, no removal)', async () => {
  const calls = [];
  const { removed } = await sweepSessionWorktrees({
    repo: '/repo', worktreesDir: '/w', exec: exec(calls),
    guard: () => { throw new Error('boom'); },
  });
  assert.deepEqual(removed, []);
});

test('sweep without a guard behaves as before', async () => {
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', worktreesDir: '/w', exec: exec([]) });
  assert.equal(removed.length, 1);
});
