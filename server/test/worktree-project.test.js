import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worktreeParent, worktreeInfo } from '../lib/orchestration/worktree-project.js';

const WT = 'D:/state/runner/worktrees';

test('worktreeParent: resolves a session worktree cwd (forward slashes)', () => {
  const r = worktreeParent(`${WT}/glmps/session-abc123`, { worktreesDir: WT });
  assert.deepEqual(r, { project: 'glmps', kind: 'session', id: 'abc123' });
});

test('worktreeParent: resolves a session worktree cwd (Windows backslashes)', () => {
  const r = worktreeParent('D:\\state\\runner\\worktrees\\glmps\\session-abc123',
    { worktreesDir: 'D:\\state\\runner\\worktrees' });
  assert.deepEqual(r, { project: 'glmps', kind: 'session', id: 'abc123' });
});

test('worktreeParent: mixed slash styles between cwd and worktreesDir', () => {
  const r = worktreeParent('D:\\state\\runner\\worktrees\\proj\\session-xyz', { worktreesDir: `${WT}` });
  assert.deepEqual(r, { project: 'proj', kind: 'session', id: 'xyz' });
});

test('worktreeParent: resolves a runner/job worktree cwd (not session-prefixed)', () => {
  const r = worktreeParent(`${WT}/glmps/71-job1`, { worktreesDir: WT });
  assert.deepEqual(r, { project: 'glmps', kind: 'runner', id: '71-job1' });
});

test('worktreeParent: session id with extra hyphens keeps them', () => {
  const r = worktreeParent(`${WT}/proj/session-abc-123-def`, { worktreesDir: WT });
  assert.deepEqual(r, { project: 'proj', kind: 'session', id: 'abc-123-def' });
});

test('worktreeParent: nested subdirectory inside a session worktree still resolves', () => {
  const r = worktreeParent(`${WT}/glmps/session-abc123/server/lib`, { worktreesDir: WT });
  assert.deepEqual(r, { project: 'glmps', kind: 'session', id: 'abc123' });
});

test('worktreeParent: cwd not under worktreesDir -> null', () => {
  assert.equal(worktreeParent('D:/glmps', { worktreesDir: WT }), null);
});

test('worktreeParent: a sibling dir with the base dir as a string prefix does not false-match', () => {
  // D:/state/runner/worktreesOTHER/... must NOT match base D:/state/runner/worktrees
  assert.equal(worktreeParent(`${WT}OTHER/proj/session-x`, { worktreesDir: WT }), null);
});

test('worktreeParent: cwd exactly equals worktreesDir -> null (no project segment)', () => {
  assert.equal(worktreeParent(WT, { worktreesDir: WT }), null);
  assert.equal(worktreeParent(`${WT}/`, { worktreesDir: WT }), null);
});

test('worktreeParent: cwd equals <worktreesDir>/<project> only -> null (no session/job segment)', () => {
  assert.equal(worktreeParent(`${WT}/glmps`, { worktreesDir: WT }), null);
});

test('worktreeParent: trailing slash variants on worktreesDir are tolerated', () => {
  const r = worktreeParent(`${WT}/proj/session-x`, { worktreesDir: `${WT}/` });
  assert.deepEqual(r, { project: 'proj', kind: 'session', id: 'x' });
});

test('worktreeParent: case-insensitive base-dir match, preserves segment casing', () => {
  const r = worktreeParent('d:/State/Runner/Worktrees/Proj/session-XYZ', { worktreesDir: WT });
  assert.deepEqual(r, { project: 'Proj', kind: 'session', id: 'XYZ' });
});

test('worktreeParent: missing/empty worktreesDir -> null', () => {
  assert.equal(worktreeParent(`${WT}/proj/session-x`, {}), null);
  assert.equal(worktreeParent(`${WT}/proj/session-x`, { worktreesDir: '' }), null);
  assert.equal(worktreeParent(`${WT}/proj/session-x`), null);
});

test('worktreeParent: missing/empty cwd -> null', () => {
  assert.equal(worktreeParent(null, { worktreesDir: WT }), null);
  assert.equal(worktreeParent(undefined, { worktreesDir: WT }), null);
  assert.equal(worktreeParent('', { worktreesDir: WT }), null);
});

// worktreeInfo

test('worktreeInfo: reconstructs a session branch matching sessionWorktreePlan\'s convention', () => {
  const r = worktreeInfo(`${WT}/glmps/session-abc123`, { worktreesDir: WT });
  assert.deepEqual(r, { branch: 'session/glmps/abc123', parent: 'glmps', kind: 'session', id: 'abc123' });
});

test('worktreeInfo: reconstructs a runner-job branch matching worktreePlan\'s convention', () => {
  const r = worktreeInfo(`${WT}/glmps/71-job1`, { worktreesDir: WT });
  assert.deepEqual(r, { branch: 'glmps-runner/glmps/71-job1', parent: 'glmps', kind: 'runner', id: '71-job1' });
});

test('worktreeInfo: non-worktree cwd -> null', () => {
  assert.equal(worktreeInfo('D:/glmps', { worktreesDir: WT }), null);
});
