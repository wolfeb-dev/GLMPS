import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reopenBranch } from '../lib/scut/reopen.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const item = (rs) => ({ runSession: { sessionId: SID, launcher: 'native-terminal', worktree: { dir: 'W/p/p-1', branch: 'b', repo: 'R' }, ...rs } });

test('a worktree removed after its outcome was recorded is recreated: resume, not a fresh session', () => {
  const outcome = { branch: 'b', head: 'abc', dir: 'W/p/p-1' };
  assert.equal(reopenBranch({ item: item({ outcome, purgedTs: 5 }), worktreeExists: false }).branch, 'b');
  assert.equal(reopenBranch({ item: item({ outcome }), worktreeExists: false }).branch, 'b');
});

test('a purged worktree with no outcome record still starts a fresh session', () => {
  assert.equal(reopenBranch({ item: item({ purgedTs: 5 }), worktreeExists: false }).branch, 'c');
  assert.equal(reopenBranch({ item: item({}), worktreeExists: false }).branch, 'c');
});

test('an existing worktree still resumes in place', () => {
  assert.equal(reopenBranch({ item: item({ purgedTs: 5, outcome: { branch: 'b', head: 'abc' } }), worktreeExists: true }).branch, 'c', 'purged flag still wins over a stale directory');
  assert.equal(reopenBranch({ item: item({}), worktreeExists: true }).branch, 'b');
});
