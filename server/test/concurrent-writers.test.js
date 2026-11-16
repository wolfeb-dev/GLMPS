import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCwd, isIsolatedWorktree, detectConcurrentWriters, otherWritersInSameTree,
  otherWritersInSameRepo,
} from '../lib/orchestration/concurrent-writers.js';

const WT = 'D:/mc/.claude/worktrees';

test('normalizeCwd: backslashes, case, trailing/dup slashes', () => {
  assert.equal(normalizeCwd('D:\\GLMPS\\'), 'd:/glmps');
  assert.equal(normalizeCwd('D:/a//b/'), 'd:/a/b');
  assert.equal(normalizeCwd(null), '');
});

test('isIsolatedWorktree: only paths under worktreesDir are isolated', () => {
  assert.equal(isIsolatedWorktree('D:/mc/.claude/worktrees/agent-1', WT), true);
  assert.equal(isIsolatedWorktree('D:/mc', WT), false);
  assert.equal(isIsolatedWorktree('D:/mc', ''), false);
  // convention heuristic: recognized even with no worktreesDir configured
  assert.equal(isIsolatedWorktree('D:/any/.claude/worktrees/agent-9', ''), true);
});

test('two live sessions sharing one working tree => one collision group', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 's1', cwd: 'D:/glmps', lastTs: 1000 },
      { id: 's2', cwd: 'D:\\glmps', lastTs: 1000 }, // same tree, diff slash style
    ],
    worktreesDir: WT, nowMs: 1000, staleMs: 60000,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 2);
});

test('sessions in different trees, or in isolated worktrees, do not collide', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 'a', cwd: 'D:/repo-a', lastTs: 1000 },
      { id: 'b', cwd: 'D:/repo-b', lastTs: 1000 },
      { id: 'c', cwd: 'D:/mc/.claude/worktrees/agent-1', lastTs: 1000 },
      { id: 'd', cwd: 'D:/mc/.claude/worktrees/agent-2', lastTs: 1000 },
    ],
    worktreesDir: WT, nowMs: 1000, staleMs: 60000,
  });
  assert.deepEqual(groups, []);
});

test('stale sessions are excluded from a group', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 's1', cwd: 'D:/mc', lastTs: 100000 },
      { id: 's2', cwd: 'D:/mc', lastTs: 1000 }, // stale
    ],
    worktreesDir: WT, nowMs: 100000, staleMs: 5000,
  });
  assert.deepEqual(groups, []);
});

test('a session id appearing twice is not counted as two writers', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 'dup', cwd: 'D:/mc', lastTs: 1000 },
      { id: 'dup', cwd: 'D:/mc', lastTs: 1000 },
    ],
    worktreesDir: WT, nowMs: 1000, staleMs: 60000,
  });
  assert.deepEqual(groups, []);
});

test('otherWritersInSameTree: returns other live sessions sharing the tree, excluding self', () => {
  const sessions = [
    { id: 'self', cwd: 'D:/mc', lastTs: 1000 },
    { id: 'other', cwd: 'D:\\mc', lastTs: 1000 },
    { id: 'elsewhere', cwd: 'D:/other', lastTs: 1000 },
  ];
  const others = otherWritersInSameTree({ sessions, cwd: 'D:/mc', selfId: 'self', worktreesDir: WT, nowMs: 1000, staleMs: 60000 });
  assert.equal(others.length, 1);
  assert.equal(others[0].id, 'other');
});

test('otherWritersInSameTree: a session in an isolated worktree warns about nobody', () => {
  const sessions = [{ id: 'a', cwd: 'D:/mc', lastTs: 1000 }, { id: 'b', cwd: 'D:/mc', lastTs: 1000 }];
  const others = otherWritersInSameTree({ sessions, cwd: 'D:/mc/.claude/worktrees/agent-9', selfId: 'me', worktreesDir: WT, nowMs: 1000, staleMs: 60000 });
  assert.deepEqual(others, []);
});

// The 2026-07-22 blind spot: two sessions in different directories of one repo.

const REPOS = {
  'd:/glmps': 'd:/glmps/.git',
  'd:/glmps/.claude/worktrees/vitals': 'd:/glmps/.git',
  'd:/mc-push-lease': 'd:/glmps/.git',
  'd:/other-repo': 'd:/other-repo/.git',
};
const repoKeyOf = (cwd) => REPOS[normalizeCwd(cwd)] ?? null;

test('otherWritersInSameRepo catches a live session in a sibling worktree', () => {
  const sessions = [
    { id: 'me', cwd: 'D:\\glmps', lastTs: 1000 },
    { id: 'wt', cwd: 'D:\\glmps\\.claude\\worktrees\\vitals', lastTs: 1000 },
  ];
  const out = otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', repoKeyOf, nowMs: 1000 });
  assert.deepEqual(out.map(s => s.id), ['wt']);
});

test('otherWritersInSameRepo catches a worktree checked out OUTSIDE the repo dir', () => {
  const sessions = [{ id: 'ext', cwd: 'D:\\mc-push-lease', lastTs: 1000 }];
  const out = otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', repoKeyOf, nowMs: 1000 });
  assert.deepEqual(out.map(s => s.id), ['ext']);
});

test('otherWritersInSameRepo ignores a different repo', () => {
  const sessions = [{ id: 'far', cwd: 'D:\other-repo', lastTs: 1000 }];
  assert.deepEqual(otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', repoKeyOf, nowMs: 1000 }), []);
});

test('otherWritersInSameRepo excludes the same tree (otherWritersInSameTree owns it)', () => {
  const sessions = [{ id: 'twin', cwd: 'D:\\glmps', lastTs: 1000 }];
  assert.deepEqual(otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', repoKeyOf, nowMs: 1000 }), []);
});

test('otherWritersInSameRepo drops stale sessions', () => {
  // lastTs must be truthy: a missing timestamp deliberately counts as live,
  // since absence of a heartbeat does not prove staleness.
  const sessions = [{ id: 'wt', cwd: 'D:\\glmps\\.claude\\worktrees\\vitals', lastTs: 1 }];
  const out = otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', repoKeyOf, nowMs: 60 * 60 * 1000 });
  assert.deepEqual(out, []);
});

test('otherWritersInSameRepo returns nothing without a usable repo resolver', () => {
  const sessions = [{ id: 'wt', cwd: 'D:\\glmps\\.claude\\worktrees\\vitals', lastTs: 1000 }];
  assert.deepEqual(otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', nowMs: 1000 }), []);
  assert.deepEqual(otherWritersInSameRepo({ sessions, cwd: 'D:\\unknown', selfId: 'me', repoKeyOf, nowMs: 1000 }), []);
});

// The session index accumulates entries that can never be updated again:
// eventCount 0 and a transcript that retention has since deleted, so lastTs
// stays 0 forever. isLive's fail-open ("no heartbeat does not prove staleness")
// counted every one of them as live, so 92 husks manufactured six permanent
// "N sessions sharing one working tree" alerts, growing monotonically. The
// husk/brand-new distinction is eventCount: a session that has recorded
// activity but no heartbeat still gets the benefit of the doubt.

const husk = (id, cwd) => ({ id, cwd, lastTs: 0, eventCount: 0 });

test('dead husks sharing a cwd do not form a collision group', () => {
  const groups = detectConcurrentWriters({
    sessions: [husk('h1', 'D:\\data-research'), husk('h2', 'D:\\data-research'), husk('h3', 'D:\\data-research')],
    worktreesDir: WT, nowMs: Date.now(),
  });
  assert.deepEqual(groups, []);
});

test('a husk does not pad a group around one real session', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 'real', cwd: 'D:\\glmps', lastTs: 100000, eventCount: 500 },
      husk('h1', 'D:\\glmps'),
      husk('h2', 'D:\\glmps'),
    ],
    worktreesDir: WT, nowMs: 100000, staleMs: 60000,
  });
  assert.deepEqual(groups, []);
});

test('a brand-new session (no events yet, but a fresh heartbeat) still counts as live', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 'new', cwd: 'D:\\mc', lastTs: 100000, eventCount: 0 },
      { id: 'other', cwd: 'D:\\mc', lastTs: 100000, eventCount: 12 },
    ],
    worktreesDir: WT, nowMs: 100000, staleMs: 60000,
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sessions.map(s => s.id).sort(), ['new', 'other']);
});

test('a session with activity but no heartbeat keeps the documented fail-open', () => {
  const groups = detectConcurrentWriters({
    sessions: [
      { id: 'a', cwd: 'D:\\mc', eventCount: 30 }, // no lastTs at all
      { id: 'b', cwd: 'D:\\mc', eventCount: 40 },
    ],
    worktreesDir: WT, nowMs: Date.now(), staleMs: 60000,
  });
  assert.equal(groups.length, 1, 'absence of a heartbeat must not prove staleness when events exist');
});

test('otherWritersInSameTree ignores husks', () => {
  const sessions = [
    { id: 'self', cwd: 'D:\\mc', lastTs: 100000, eventCount: 5 },
    husk('h1', 'D:\\mc'),
  ];
  const others = otherWritersInSameTree({ sessions, cwd: 'D:\\mc', selfId: 'self', worktreesDir: WT, nowMs: 100000, staleMs: 60000 });
  assert.deepEqual(others, []);
});

test('otherWritersInSameRepo ignores husks', () => {
  const sessions = [{ ...husk('h1', 'D:\\mc-push-lease') }];
  const out = otherWritersInSameRepo({ sessions, cwd: 'D:\\glmps', selfId: 'me', repoKeyOf, nowMs: Date.now() });
  assert.deepEqual(out, []);
});

test('husks are excluded even with no clock supplied', () => {
  const groups = detectConcurrentWriters({
    sessions: [husk('h1', 'D:\\mc'), husk('h2', 'D:\\mc')],
    worktreesDir: WT, // nowMs omitted
  });
  assert.deepEqual(groups, []);
});
