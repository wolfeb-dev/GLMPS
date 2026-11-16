// Tests for the session-worktree sweeper (glmps-71 A4): the pure decision
// core (planSweep) and the injected-exec runner (sweepSessionWorktrees).
// Never touches real git - exec is always a fake in these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  worktreeRemoveSafeRecipe,
  deleteBranchRecipe,
  planSweep,
  sweepSessionWorktrees,
} from '../lib/orchestration/worktree-sweeper.js';


test('worktreeRemoveSafeRecipe omits --force (a dirty tree must survive)', () => {
  const r = worktreeRemoveSafeRecipe({ repo: '/r', dir: '/r/.worktrees/p/session-abc' });
  assert.equal(r.file, 'git');
  assert.deepEqual(r.args, ['-C', '/r', 'worktree', 'remove', '/r/.worktrees/p/session-abc']);
  assert.ok(!r.args.includes('--force'));
});

test('deleteBranchRecipe uses -d (not -D) so an unmerged branch is refused, not blown away', () => {
  const r = deleteBranchRecipe({ repo: '/r', branch: 'session/p/abc' });
  assert.equal(r.file, 'git');
  assert.deepEqual(r.args, ['-C', '/r', 'branch', '-d', 'session/p/abc']);
});


test('planSweep: a live session worktree is kept even with zero unmerged commits', () => {
  const worktrees = [{ dir: '/w/live', branch: 'session/mc/live1', head: 'aaa' }];
  const { remove, keep } = planSweep({
    worktrees, liveSessionIds: ['live1'], cherryByBranch: { 'session/mc/live1': { unmerged: 0, equivalent: 2 } },
  });
  assert.deepEqual(remove, []);
  assert.deepEqual(keep, worktrees);
});

test('planSweep: an ended session with unmerged commits is kept (surfaces via the unmerged-branch guard instead)', () => {
  const worktrees = [{ dir: '/w/unmerged', branch: 'session/mc/dead1', head: 'bbb' }];
  const { remove, keep } = planSweep({
    worktrees, liveSessionIds: [], cherryByBranch: { 'session/mc/dead1': { unmerged: 2, equivalent: 0 } },
  });
  assert.deepEqual(remove, []);
  assert.deepEqual(keep, worktrees);
});

test('planSweep: an ended, fully-merged session worktree is removable', () => {
  const worktrees = [{ dir: '/w/merged', branch: 'session/mc/done1', head: 'ccc' }];
  const { remove, keep } = planSweep({
    worktrees, liveSessionIds: [], cherryByBranch: { 'session/mc/done1': { unmerged: 0, equivalent: 3 } },
  });
  assert.deepEqual(remove, [{ dir: '/w/merged', branch: 'session/mc/done1' }]);
  assert.deepEqual(keep, []);
});

test('planSweep: a detached worktree in the managed dir is kept, it has no branch to judge (merge-queue test and review dirs)', () => {
  const worktrees = [
    { dir: '/wt/merge-queue/glmps-2-0-49', branch: null, head: 'ddd' },
    { dir: '/wt/merge-queue-review/glmps-2-0-49-review-r1', branch: null, head: 'eee' },
  ];
  const { remove, keep } = planSweep({ worktrees, managedDir: '/wt', cherryByBranch: { null: { unmerged: 0, equivalent: 0 } } });
  assert.deepEqual(remove, []);
  assert.deepEqual(keep, worktrees);
});

test('planSweep: non-session branches (main worktree, glmps-runner/* job worktrees) are never touched', () => {
  const worktrees = [
    { dir: '/repo', branch: 'main', head: 'zzz' },
    { dir: '/w/job', branch: 'glmps-runner/mc/job1', head: 'yyy' },
  ];
  const { remove, keep } = planSweep({ worktrees, liveSessionIds: [], cherryByBranch: {} });
  assert.deepEqual(remove, []);
  assert.deepEqual(keep, worktrees);
});

test('planSweep: missing cherry data for a session branch defaults to unmerged=0 (caller is expected to have populated it)', () => {
  const worktrees = [{ dir: '/w/x', branch: 'session/mc/nodata', head: 'w1' }];
  const { remove } = planSweep({ worktrees, liveSessionIds: [] });
  assert.deepEqual(remove, [{ dir: '/w/x', branch: 'session/mc/nodata' }]);
});

test('planSweep: full matrix in one pass (live kept, unmerged kept, merged+ended removed, non-session kept)', () => {
  const worktrees = [
    { dir: '/repo', branch: 'main' },
    { dir: '/w/live', branch: 'session/mc/live1' },
    { dir: '/w/unmerged', branch: 'session/mc/dead1' },
    { dir: '/w/merged', branch: 'session/mc/done1' },
  ];
  const cherryByBranch = {
    'session/mc/live1': { unmerged: 0 },
    'session/mc/dead1': { unmerged: 4 },
    'session/mc/done1': { unmerged: 0 },
  };
  const { remove, keep } = planSweep({ worktrees, liveSessionIds: ['live1'], cherryByBranch });
  assert.deepEqual(remove, [{ dir: '/w/merged', branch: 'session/mc/done1' }]);
  assert.deepEqual(keep.map(w => w.branch), ['main', 'session/mc/live1', 'session/mc/dead1']);
});


function fakeGit({ listing, defaultBranch = 'origin/main', cherryFor = {}, onCall } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    if (onCall) { const r = onCall(args, calls); if (r !== undefined) return r; }
    const joined = args.join(' ');
    if (joined.includes('worktree list')) return listing;
    if (joined.includes('symbolic-ref')) return defaultBranch + '\n';
    if (joined.includes('cherry')) {
      const branch = args[args.length - 1];
      const c = cherryFor[branch] ?? { unmerged: 0, equivalent: 0 };
      return [...Array(c.unmerged).fill('+ x'), ...Array(c.equivalent).fill('- y')].join('\n');
    }
    if (joined.includes('worktree remove')) return '';
    if (joined.includes('branch -d')) return '';
    if (joined.includes('worktree prune')) return '';
    throw new Error(`unexpected git call: ${joined}`);
  };
  return { exec, calls };
}

const LISTING_ONE_REMOVABLE = [
  'worktree /repo',
  'HEAD zzz',
  'branch refs/heads/main',
  '',
  'worktree /w/mc/session-done1',
  'HEAD ccc',
  'branch refs/heads/session/mc/done1',
  '',
].join('\n');

test('sweepSessionWorktrees: happy path removes a merged+ended session worktree and deletes its branch', async () => {
  const { exec, calls } = fakeGit({ listing: LISTING_ONE_REMOVABLE, cherryFor: { 'session/mc/done1': { unmerged: 0, equivalent: 1 } } });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, [{ dir: '/w/mc/session-done1', branch: 'session/mc/done1' }]);
  assert.deepEqual(kept, []);
  assert.ok(calls.some(c => c.join(' ').includes('worktree remove /w/mc/session-done1')));
  assert.ok(calls.some(c => c.join(' ').includes('branch -d session/mc/done1')));
  assert.ok(calls.some(c => c.join(' ').includes('worktree prune')), 'always prunes at the end');
  // never forces the remove
  assert.ok(!calls.some(c => c.includes('--force')));
});

test('sweepSessionWorktrees: a dirty tree (worktree remove fails) is kept, not force-removed', async () => {
  const { exec, calls } = fakeGit({
    listing: LISTING_ONE_REMOVABLE,
    cherryFor: { 'session/mc/done1': { unmerged: 0 } },
    onCall: (args) => { if (args.join(' ').includes('worktree remove')) throw new Error('fatal: contains modified or untracked files'); },
  });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, []);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].branch, 'session/mc/done1');
  // branch delete must never be attempted once the worktree remove failed
  assert.ok(!calls.some(c => c.join(' ').includes('branch -d')));
});

test('sweepSessionWorktrees: a live session is kept without even attempting removal', async () => {
  const listing = [
    'worktree /w/mc/session-live1',
    'HEAD aaa',
    'branch refs/heads/session/mc/live1',
    '',
  ].join('\n');
  const { exec, calls } = fakeGit({ listing, cherryFor: { 'session/mc/live1': { unmerged: 0 } } });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: ['live1'], exec });
  assert.deepEqual(removed, []);
  assert.equal(kept.length, 1);
  assert.ok(!calls.some(c => c.join(' ').includes('worktree remove')));
});

test('sweepSessionWorktrees: an unmerged branch (cherry +) is kept, never swept', async () => {
  const listing = [
    'worktree /w/mc/session-dead1',
    'HEAD bbb',
    'branch refs/heads/session/mc/dead1',
    '',
  ].join('\n');
  const { exec, calls } = fakeGit({ listing, cherryFor: { 'session/mc/dead1': { unmerged: 2 } } });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, []);
  assert.equal(kept.length, 1);
  assert.ok(!calls.some(c => c.join(' ').includes('worktree remove')));
});

// glmps-2-0-runtime-86: every sweep re-ran cherry for every kept worktree and
// session branch. With a shared cache it runs once per tip pair.
test('sweepSessionWorktrees: a shared cherry cache skips cherry until a tip moves', async () => {
  const listing = ['worktree /w/mc/session-live1', 'HEAD aaa', 'branch refs/heads/session/mc/live1', ''].join('\n');
  let refs = 'main\t1\tm1\nsession/mc/live1\t1\taaa\nsession/mc/orphan1\t1\too1\n';
  const { exec, calls } = fakeGit({
    listing, cherryFor: { 'session/mc/live1': { unmerged: 1 }, 'session/mc/orphan1': { unmerged: 1 } },
    // origin/main tracks the moving base
    onCall: (args) => (args.includes('for-each-ref') ? refs : args.includes('rev-parse') ? refs.match(/^main\t1\t(\w+)/)[1] : undefined),
  });
  const cherries = () => calls.filter((c) => c.includes('cherry')).map((c) => c.at(-1)).sort();
  const cherryCache = new Map();
  const sweep = () => sweepSessionWorktrees({ repo: '/repo', liveSessionIds: ['live1'], exec, cherryCache });
  await sweep();
  assert.deepEqual(cherries(), ['session/mc/live1', 'session/mc/orphan1']);
  calls.length = 0;
  const { kept } = await sweep();
  assert.equal(kept.length, 1);
  assert.deepEqual(cherries(), [], 'same tips: no cherry launched');
  refs = 'main\t1\tm2\nsession/mc/live1\t1\taaa\nsession/mc/orphan1\t1\too1\n';
  await sweep();
  assert.deepEqual(cherries(), ['session/mc/live1', 'session/mc/orphan1'], 'a moved base reruns both');
});

test('sweepSessionWorktrees: a git failure on cherry-check fails open (treated as unmerged, kept)', async () => {
  const listing = [
    'worktree /w/mc/session-flaky1',
    'HEAD ddd',
    'branch refs/heads/session/mc/flaky1',
    '',
  ].join('\n');
  const { exec } = fakeGit({
    listing,
    onCall: (args) => { if (args.join(' ').includes('cherry')) throw new Error('git cherry failed'); },
  });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, []);
  assert.equal(kept.length, 1);
});

test('sweepSessionWorktrees: worktreesDir scopes which session worktrees are ever considered', async () => {
  const listing = [
    'worktree /elsewhere/session-outside1',
    'HEAD eee',
    'branch refs/heads/session/mc/outside1',
    '',
    'worktree /repo/.worktrees/mc/session-inside1',
    'HEAD fff',
    'branch refs/heads/session/mc/inside1',
    '',
  ].join('\n');
  const { exec, calls } = fakeGit({
    listing,
    cherryFor: { 'session/mc/outside1': { unmerged: 0 }, 'session/mc/inside1': { unmerged: 0 } },
  });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', worktreesDir: '/repo/.worktrees', liveSessionIds: [], exec });
  assert.deepEqual(removed, [{ dir: '/repo/.worktrees/mc/session-inside1', branch: 'session/mc/inside1' }]);
  assert.deepEqual(kept, []); // the outside-scope one is never considered at all, so it is neither kept nor removed
  assert.ok(!calls.some(c => c.join(' ').includes('outside1')), 'out-of-scope branch never touched by any git call');
});

test('sweepSessionWorktrees: falls back to for-each-ref main/master when origin/HEAD is unset', async () => {
  const listing = [
    'worktree /w/mc/session-done2',
    'HEAD ggg',
    'branch refs/heads/session/mc/done2',
    '',
  ].join('\n');
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    const joined = args.join(' ');
    if (joined.includes('worktree list')) return listing;
    if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
    if (joined.includes('for-each-ref')) return 'master\t1750000000\n';
    if (joined.includes('cherry')) {
      assert.ok(joined.includes('cherry master session/mc/done2'), 'resolves default branch to master via fallback');
      return '';
    }
    if (joined.includes('worktree remove') || joined.includes('branch -d') || joined.includes('worktree prune')) return '';
    throw new Error(`unexpected: ${joined}`);
  };
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, [{ dir: '/w/mc/session-done2', branch: 'session/mc/done2' }]);
});

test('sweepSessionWorktrees: prunes even when there is nothing to remove', async () => {
  const listing = ['worktree /repo', 'HEAD zzz', 'branch refs/heads/main', ''].join('\n');
  const { exec, calls } = fakeGit({ listing });
  const { removed, kept } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, []);
  assert.deepEqual(kept, []);
  assert.ok(calls.some(c => c.join(' ').includes('worktree prune')));
});

test('planSweep keeps a worktree occupied by a live session cwd, even when merged and id-unknown', () => {
  // Terminal launches bake a RANDOM shortid into the branch; the eventual
  // session id never matches it. Occupancy (cwd inside the worktree) is the
  // protection that covers this case.
  const worktrees = [{ dir: 'C:/wt/proj/session-abc123', branch: 'session/proj/abc123', head: 'x' }];
  const plan = planSweep({
    worktrees,
    liveSessionIds: ['totally-different-id'],
    liveDirs: [String.raw`C:\wt\proj\session-abc123\sub\dir`],
    cherryByBranch: { 'session/proj/abc123': { unmerged: 0, equivalent: 0 } },
  });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.keep.length, 1);
});

test('planSweep still removes when no live dir is inside the worktree', () => {
  const worktrees = [{ dir: '/wt/proj/session-abc123', branch: 'session/proj/abc123', head: 'x' }];
  const plan = planSweep({
    worktrees, liveDirs: ['/somewhere/else'],
    cherryByBranch: { 'session/proj/abc123': { unmerged: 0, equivalent: 0 } },
  });
  assert.equal(plan.remove.length, 1);
});

test('sweepSessionWorktrees deletes a fully-merged orphaned session branch (no worktree)', async () => {
  const calls = [];
  const exec = (file, args) => {
    calls.push(args.join(' '));
    const cmd = args.join(' ');
    if (cmd.includes('worktree list')) return 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n';
    if (cmd.includes('symbolic-ref')) return 'origin/main';
    if (cmd.includes('for-each-ref')) return 'main\t1700000000\nsession/proj/orphan1\t1700000000\nfeat/x\t1700000000';
    if (cmd.includes('cherry')) return ''; // fully merged
    return '';
  };
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', exec });
  assert.deepEqual(removed, [{ dir: null, branch: 'session/proj/orphan1' }]);
  assert.ok(calls.some(c => c.includes('branch -d session/proj/orphan1')));
  assert.ok(!calls.some(c => c.includes('branch -d feat/x')), 'non-session branches never touched');
});

test('sweepSessionWorktrees keeps an unmerged orphaned session branch', async () => {
  const exec = (file, args) => {
    const cmd = args.join(' ');
    if (cmd.includes('worktree list')) return 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n';
    if (cmd.includes('symbolic-ref')) return 'origin/main';
    if (cmd.includes('for-each-ref')) return 'session/proj/orphan2\t1700000000';
    if (cmd.includes('cherry')) return '+ abc123\n';
    if (cmd.includes('branch -d')) throw new Error('should not be called');
    return '';
  };
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', exec });
  assert.deepEqual(removed, []);
});

// The sweeper only ever considered `session/*` branches, so worktrees created by
// the harness's Agent(isolation:'worktree') tool and the orchestrator's own
// .claude/worktrees/lane-* / agent-* dirs accumulated forever. 17 of them were
// reaped by hand on 2026-07-22. Managed-dir containment replaces the branch-name
// rule as the candidate test; every existing safety guard still applies.

const MANAGED = 'D:/repo/.claude/worktrees';

test('planSweep: a merged, unoccupied managed worktree is removable even on a non-session branch', () => {
  const worktrees = [{ dir: `${MANAGED}/agent-abc`, branch: 'feat/qa-trends-local', head: 'h' }];
  const { remove, keep } = planSweep({
    worktrees, managedDir: MANAGED, liveSessionIds: [], liveDirs: [],
    cherryByBranch: { 'feat/qa-trends-local': { unmerged: 0, equivalent: 3 } },
  });
  assert.deepEqual(remove, [{ dir: `${MANAGED}/agent-abc`, branch: 'feat/qa-trends-local' }]);
  assert.equal(keep.length, 0);
});

test('planSweep: a managed worktree with unmerged commits is kept', () => {
  const worktrees = [{ dir: `${MANAGED}/lane-mc-10`, branch: 'feat/wip', head: 'h' }];
  const { remove, keep } = planSweep({
    worktrees, managedDir: MANAGED, cherryByBranch: { 'feat/wip': { unmerged: 2, equivalent: 0 } },
  });
  assert.equal(remove.length, 0);
  assert.equal(keep.length, 1);
});

test('planSweep: a managed worktree occupied by a live session is kept', () => {
  const worktrees = [{ dir: `${MANAGED}/lane-mc-10`, branch: 'feat/done', head: 'h' }];
  const { remove } = planSweep({
    worktrees, managedDir: MANAGED, liveDirs: [`${MANAGED}/lane-mc-10`],
    cherryByBranch: { 'feat/done': { unmerged: 0, equivalent: 1 } },
  });
  assert.equal(remove.length, 0, 'never sweep a worktree a live session is sitting in');
});

test('planSweep: a worktree OUTSIDE the managed dir is never swept on branch name alone', () => {
  const worktrees = [
    { dir: 'D:/repo', branch: 'main', head: 'h' },
    { dir: 'D:/some-hand-made-tree', branch: 'feat/merged', head: 'h' },
  ];
  const { remove, keep } = planSweep({
    worktrees, managedDir: MANAGED,
    cherryByBranch: { main: { unmerged: 0, equivalent: 0 }, 'feat/merged': { unmerged: 0, equivalent: 9 } },
  });
  assert.equal(remove.length, 0, 'containment is the guard: a hand-made tree is not ours to reap');
  assert.equal(keep.length, 2);
});

test('planSweep: without a managedDir, behaviour is unchanged (session/* only)', () => {
  const worktrees = [{ dir: 'D:/anywhere/agent-abc', branch: 'feat/merged', head: 'h' }];
  const { remove, keep } = planSweep({ worktrees, cherryByBranch: { 'feat/merged': { unmerged: 0, equivalent: 1 } } });
  assert.equal(remove.length, 0);
  assert.equal(keep.length, 1);
});

test('planSweep: session/* still sweeps by branch even outside the managed dir', () => {
  const worktrees = [{ dir: 'D:/elsewhere/s1', branch: 'session/proj/s1', head: 'h' }];
  const { remove } = planSweep({
    worktrees, managedDir: MANAGED, liveSessionIds: [],
    cherryByBranch: { 'session/proj/s1': { unmerged: 0, equivalent: 1 } },
  });
  assert.equal(remove.length, 1);
});

test('planSweep: a live session id still protects its session/* worktree under a managed dir', () => {
  const worktrees = [{ dir: `${MANAGED}/s9`, branch: 'session/proj/s9', head: 'h' }];
  const { remove } = planSweep({
    worktrees, managedDir: MANAGED, liveSessionIds: ['s9'],
    cherryByBranch: { 'session/proj/s9': { unmerged: 0, equivalent: 1 } },
  });
  assert.equal(remove.length, 0);
});

const LISTING_MANAGED = [
  'worktree /repo', 'HEAD zzz', 'branch refs/heads/main', '',
  'worktree /repo/.claude/worktrees/agent-abc', 'HEAD ccc', 'branch refs/heads/feat/qa-trends-local', '',
  'worktree /elsewhere/hand-made', 'HEAD ddd', 'branch refs/heads/feat/mine', '',
].join('\n');

test('sweepSessionWorktrees: reaps a managed agent-* worktree on an ordinary feature branch (glmps-117)', async () => {
  const { exec, calls } = fakeGit({
    listing: LISTING_MANAGED,
    cherryFor: { 'feat/qa-trends-local': { unmerged: 0, equivalent: 4 }, 'feat/mine': { unmerged: 0, equivalent: 1 } },
  });
  const { removed, kept } = await sweepSessionWorktrees({
    repo: '/repo', worktreesDir: '/repo/.claude/worktrees', liveSessionIds: [], exec,
  });
  assert.deepEqual(removed.map(r => r.dir), ['/repo/.claude/worktrees/agent-abc']);
  assert.deepEqual(kept, [], 'the main worktree and the hand-made tree are not even candidates');
  assert.ok(calls.some(c => c.join(' ').includes('worktree remove /repo/.claude/worktrees/agent-abc')));
  assert.ok(!calls.some(c => c.includes('--force')), 'still never forces');
  assert.ok(!calls.some(c => c.join(' ').includes('/elsewhere/hand-made')), 'never touches a tree outside the managed dir');
});

test('sweepSessionWorktrees: with no worktreesDir, a non-session managed tree is left alone', async () => {
  const { exec, calls } = fakeGit({
    listing: LISTING_MANAGED,
    cherryFor: { 'feat/qa-trends-local': { unmerged: 0, equivalent: 4 } },
  });
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.deepEqual(removed, []);
  assert.ok(!calls.some(c => c.join(' ').includes('worktree remove')));
});

test('sweepSessionWorktrees: deletes an orphaned merged worktree-agent-* branch (glmps-117)', async () => {
  const refs = ['worktree-agent-abc\t1700000000', 'feat/keep-me\t1700000000', 'main\t1700000000'].join('\n');
  const { exec, calls } = fakeGit({
    listing: ['worktree /repo', 'HEAD zzz', 'branch refs/heads/main', ''].join('\n'),
    cherryFor: { 'worktree-agent-abc': { unmerged: 0, equivalent: 2 }, 'feat/keep-me': { unmerged: 0, equivalent: 2 } },
    onCall: (args) => (args.join(' ').includes('for-each-ref') ? refs : undefined),
  });
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', worktreesDir: '/repo/.claude/worktrees', exec });
  assert.deepEqual(removed.map(r => r.branch), ['worktree-agent-abc']);
  assert.ok(!calls.some(c => c.join(' ').includes('branch -d feat/keep-me')),
    'an ordinary merged feature branch is NOT auto-deleted; only tooling-generated names are');
});

test('sweepSessionWorktrees: an unmerged tooling branch survives the orphan pass', async () => {
  const refs = ['worktree-agent-xyz\t1700000000'].join('\n');
  const { exec, calls } = fakeGit({
    listing: ['worktree /repo', 'HEAD zzz', 'branch refs/heads/main', ''].join('\n'),
    cherryFor: { 'worktree-agent-xyz': { unmerged: 3, equivalent: 0 } },
    onCall: (args) => (args.join(' ').includes('for-each-ref') ? refs : undefined),
  });
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', worktreesDir: '/repo/.claude/worktrees', exec });
  assert.deepEqual(removed, []);
  assert.ok(!calls.some(c => c.join(' ').includes('branch -d worktree-agent-xyz')));
});

// A runner job worktree lives under the SAME managed dir as everything above,
// so glmps-117's containment rule makes it a sweep candidate. Its branch is
// glmps-runner/<project>/<jobId>, which encodes no session id, so the
// liveSessionIds guard cannot reach it and `occupied` (a live session's cwd
// inside the worktree) was the only thing left. That check is racy by
// construction: between `git worktree add` and the launched agent appearing in
// sessionSummaries() with a cwd there is a window in which a fresh runner
// worktree is merged (unmerged === 0), unoccupied, and therefore removable.
// That window is what fired on 2026-07-29 during glmps-33.
//
// The fix mirrors what session/* already gets: the runner LEDGER is the
// identity, so a job still in it is never swept, occupancy or not.

const RUNNER_MANAGED = 'C:/state/runner/worktrees';
const RUNNER_DIR = `${RUNNER_MANAGED}/glmps/glmps-33`;
const RUNNER_BRANCH = 'glmps-runner/glmps/glmps-33';

test('planSweep: a runner worktree whose job is still in the ledger is kept, even unoccupied and merged', () => {
  // Reproduces the launch-window race directly: no liveDirs (the agent has not
  // been indexed yet), no liveSessionIds, a fresh branch with nothing on it.
  // Before glmps-162 all three guards passed and the checkout was removed out
  // from under a live agent.
  const worktrees = [{ dir: RUNNER_DIR, branch: RUNNER_BRANCH, head: 'h' }];
  const { remove, keep } = planSweep({
    worktrees,
    managedDir: RUNNER_MANAGED,
    liveSessionIds: [],
    liveDirs: [],
    liveJobIds: ['glmps-33'],
    cherryByBranch: { [RUNNER_BRANCH]: { unmerged: 0, equivalent: 0 } },
  });
  assert.deepEqual(remove, [], 'a job in the runner ledger owns its checkout');
  assert.deepEqual(keep.map(w => w.branch), [RUNNER_BRANCH]);
});

test('planSweep: a runner worktree whose job has left the ledger is still reclaimable', () => {
  // The protection must be a lease, not a permanent exemption, or runner
  // worktrees accumulate forever (the glmps-117 defect in a new costume).
  const worktrees = [{ dir: RUNNER_DIR, branch: RUNNER_BRANCH, head: 'h' }];
  const { remove } = planSweep({
    worktrees,
    managedDir: RUNNER_MANAGED,
    liveJobIds: ['some-other-job'],
    cherryByBranch: { [RUNNER_BRANCH]: { unmerged: 0, equivalent: 2 } },
  });
  assert.deepEqual(remove, [{ dir: RUNNER_DIR, branch: RUNNER_BRANCH }]);
});

test('planSweep: a departed runner job with unmerged commits is kept regardless', () => {
  const worktrees = [{ dir: RUNNER_DIR, branch: RUNNER_BRANCH, head: 'h' }];
  const { remove } = planSweep({
    worktrees, managedDir: RUNNER_MANAGED, liveJobIds: [],
    cherryByBranch: { [RUNNER_BRANCH]: { unmerged: 3, equivalent: 0 } },
  });
  assert.equal(remove.length, 0, 'unmerged work outranks reclaim, same as every other branch');
});

test('planSweep: a job id that merely appears inside another branch name does not protect it', () => {
  // Guards against a substring match: job "mc-3" must not shield "mc-33".
  const worktrees = [{ dir: `${RUNNER_MANAGED}/mc/mc-33`, branch: 'glmps-runner/mc/mc-33', head: 'h' }];
  const { remove } = planSweep({
    worktrees, managedDir: RUNNER_MANAGED, liveJobIds: ['mc-3'],
    cherryByBranch: { 'glmps-runner/mc/mc-33': { unmerged: 0, equivalent: 1 } },
  });
  assert.equal(remove.length, 1, 'protection is an exact job-id match on the branch tail');
});

test('sweepSessionWorktrees: threads liveJobIds through, so a live runner job survives a real sweep', async () => {
  const listing = [
    'worktree /repo', 'HEAD zzz', 'branch refs/heads/main', '',
    `worktree ${RUNNER_DIR}`, 'HEAD ccc', `branch refs/heads/${RUNNER_BRANCH}`, '',
  ].join('\n');
  const { exec, calls } = fakeGit({ listing, cherryFor: { [RUNNER_BRANCH]: { unmerged: 0, equivalent: 0 } } });
  const { removed, kept } = await sweepSessionWorktrees({
    repo: '/repo', worktreesDir: RUNNER_MANAGED, liveSessionIds: [], liveDirs: [],
    liveJobIds: ['glmps-33'], exec,
  });
  assert.deepEqual(removed, []);
  assert.deepEqual(kept.map(w => w.branch), [RUNNER_BRANCH]);
  assert.ok(!calls.some(c => c.join(' ').includes(`worktree remove ${RUNNER_DIR}`)),
    'the removal must never be attempted at all, not merely fail');
});

test('sweepSessionWorktrees: retries an orphaned merged glmps-runner/* branch (defect 3)', async () => {
  // A branch delete that failed once (the 2026-07-29 case: `worktree remove`
  // errored on Windows, so `branch -d` never ran) was never retried, because
  // sweepableOrphanBranch did not recognise glmps-runner/*. The debris branch
  // outlived its worktree forever.
  const refs = [`${RUNNER_BRANCH}\t1700000000`, 'main\t1700000000'].join('\n');
  const { exec, calls } = fakeGit({
    listing: ['worktree /repo', 'HEAD zzz', 'branch refs/heads/main', ''].join('\n'),
    cherryFor: { [RUNNER_BRANCH]: { unmerged: 0, equivalent: 1 } },
    onCall: (args) => (args.join(' ').includes('for-each-ref') ? refs : undefined),
  });
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', worktreesDir: RUNNER_MANAGED, liveJobIds: [], exec });
  assert.deepEqual(removed.map(r => r.branch), [RUNNER_BRANCH]);
  assert.ok(calls.some(c => c.join(' ').includes(`branch -d ${RUNNER_BRANCH}`)));
});

test('sweepSessionWorktrees: the orphan pass never deletes a live job\'s branch', async () => {
  // The worktree can legitimately be absent from `git worktree list` while the
  // job is live (that is exactly what a partially-failed remove leaves behind),
  // so the orphan pass needs the same ledger check as planSweep or it becomes a
  // second, unguarded route to the same damage.
  const refs = [`${RUNNER_BRANCH}\t1700000000`].join('\n');
  const { exec, calls } = fakeGit({
    listing: ['worktree /repo', 'HEAD zzz', 'branch refs/heads/main', ''].join('\n'),
    cherryFor: { [RUNNER_BRANCH]: { unmerged: 0, equivalent: 1 } },
    onCall: (args) => (args.join(' ').includes('for-each-ref') ? refs : undefined),
  });
  const { removed } = await sweepSessionWorktrees({
    repo: '/repo', worktreesDir: RUNNER_MANAGED, liveJobIds: ['glmps-33'], exec,
  });
  assert.deepEqual(removed, []);
  assert.ok(!calls.some(c => c.join(' ').includes(`branch -d ${RUNNER_BRANCH}`)));
});

// The ticket asks by name for "log every sweeper removal with the reason".
// The sweeper keeps its I/O injected, so the report goes out through a
// callback rather than an import; the caller (server.js) is what makes it
// durable. Optional and swallowed on purpose: a throwing callback must never
// break the sweep of everything else.

test('sweepSessionWorktrees reports each removal through onRemove', async () => {
  const { exec } = fakeGit({ listing: LISTING_ONE_REMOVABLE, cherryFor: { 'session/mc/done1': { unmerged: 0, equivalent: 1 } } });
  const seen = [];
  await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec, onRemove: (r) => seen.push(r) });
  assert.deepEqual(seen.map(r => r.kind), ['worktree']);
  assert.equal(seen[0].branch, 'session/mc/done1');
});

test('sweepSessionWorktrees reports an orphan branch reap with kind orphan-branch', async () => {
  // Reuses the orphaned-merged-session-branch fixture (no worktree, fully
  // merged) from the test above the glmps-117 section.
  const exec = (file, args) => {
    const cmd = args.join(' ');
    if (cmd.includes('worktree list')) return 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n';
    if (cmd.includes('symbolic-ref')) return 'origin/main';
    if (cmd.includes('for-each-ref')) return 'main\t1700000000\nsession/proj/orphan1\t1700000000\nfeat/x\t1700000000';
    if (cmd.includes('cherry')) return ''; // fully merged
    return '';
  };
  const seen = [];
  await sweepSessionWorktrees({ repo: '/repo', exec, onRemove: (r) => seen.push(r) });
  assert.deepEqual(seen.map(r => r.kind), ['orphan-branch']);
});

test('sweepSessionWorktrees survives a throwing onRemove', async () => {
  const { exec } = fakeGit({ listing: LISTING_ONE_REMOVABLE, cherryFor: { 'session/mc/done1': { unmerged: 0, equivalent: 1 } } });
  const { removed } = await sweepSessionWorktrees({
    repo: '/repo', liveSessionIds: [], exec, onRemove: () => { throw new Error('boom'); },
  });
  assert.equal(removed.length, 1);
});

// A local main nobody pulls is stale, so a branch cut from a fresh origin/main
// read as unmerged and its worktree was kept forever (2026-10-24).
test('sweepSessionWorktrees compares against origin/main, so a stale local main does not keep a merged worktree', async () => {
  const bases = [];
  const { exec } = fakeGit({
    listing: LISTING_ONE_REMOVABLE,
    onCall: (args) => {
      const i = args.indexOf('cherry');
      if (i < 0) return undefined;
      bases.push(args[i + 1]);
      return args[i + 1] === 'origin/main' ? '' : Array(17).fill('+ x').join('\n');
    },
  });
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', liveSessionIds: [], exec });
  assert.ok(bases.length && bases.every((b) => b === 'origin/main'), `cherry base was ${bases.join(', ')}`);
  assert.equal(removed.length, 1);
});

test('sweepSessionWorktrees keys the cherry cache on the origin/main tip, not local main', async () => {
  let originTip = 'o1';
  let cherryRuns = 0;
  const { exec } = fakeGit({
    listing: LISTING_ONE_REMOVABLE,
    onCall: (args) => {
      const joined = args.join(' ');
      if (joined.includes('rev-parse')) return originTip + '\n';
      if (joined.includes('for-each-ref')) return 'main\t1700000000\tlocalmain\nsession/mc/done1\t1700000000\tccc\n';
      if (args.includes('cherry')) { cherryRuns++; return '+ x'; }
      return undefined;
    },
  });
  const cherryCache = new Map();
  // unmerged commit keeps the worktree, so both sweeps reach the cherry check
  await sweepSessionWorktrees({ repo: '/repo', exec, cherryCache });
  await sweepSessionWorktrees({ repo: '/repo', exec, cherryCache });
  assert.equal(cherryRuns, 1);
  originTip = 'o2';
  await sweepSessionWorktrees({ repo: '/repo', exec, cherryCache });
  assert.equal(cherryRuns, 2);
});

test('sweepSessionWorktrees compares against the local name when origin/HEAD does not resolve', async () => {
  const bases = [];
  const { exec } = fakeGit({
    listing: LISTING_ONE_REMOVABLE,
    onCall: (args) => {
      if (args.join(' ').includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (args.join(' ').includes('for-each-ref')) return 'main\t1700000000\nsession/mc/done1\t1700000000\n';
      const i = args.indexOf('cherry');
      if (i < 0) return undefined;
      bases.push(args[i + 1]);
      return '';
    },
  });
  await sweepSessionWorktrees({ repo: '/repo', exec });
  assert.ok(bases.length && bases.every((b) => b === 'main'));
});

// Self-worked cards use hand-named card/<id> branches that no worktree tooling
// generates, so they were never swept (2026-11-13 audit: 28 merged locals).
test('orphan pass deletes a merged card/* branch, keeps an unmerged one and one checked out in a worktree', async () => {
  const listing = [
    'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /elsewhere/z', 'HEAD zzz', 'branch refs/heads/card/z', '',
  ].join('\n');
  const { exec, calls } = fakeGit({
    listing,
    cherryFor: { 'card/y': { unmerged: 2, equivalent: 0 } },
    onCall: (args) => (args.includes('for-each-ref')
      ? 'main\t1700000000\tm1\ncard/x\t1700000000\tx1\ncard/y\t1700000000\ty1\ncard/z\t1700000000\tzzz\n'
      : undefined),
  });
  const { removed } = await sweepSessionWorktrees({ repo: '/repo', exec });
  assert.deepEqual(removed, [{ dir: null, branch: 'card/x' }]);
  const deletes = calls.filter((c) => c.includes('branch') && c.includes('-d')).map((c) => c.at(-1));
  assert.deepEqual(deletes, ['card/x'], 'only the merged orphan is passed to branch -d');
});
