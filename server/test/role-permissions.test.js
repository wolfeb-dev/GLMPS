import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_INTEGRATION_BRANCHES, normalizeRole, roleSettings, writeRoleSettings, checkRoleCommand,
} from '../lib/governance/role-permissions.js';

const resolve = () => ({ branch: 'glmps-runner/card-1', upstream: '' });
const W = { role: 'worker', resolve };
const R = { role: 'reviewer', reviewHead: 'glmps-runner/card-1', resolve };
const blocked = (o, command) => checkRoleCommand({ command, ...o }).block;

test('normalizeRole accepts worker and reviewer only', () => {
  assert.equal(normalizeRole('worker'), 'worker');
  assert.equal(normalizeRole('reviewer'), 'reviewer');
  assert.equal(normalizeRole(''), null);
  assert.equal(normalizeRole(undefined), null);
  assert.equal(normalizeRole('admin'), null);
});

test('worker settings deny gh pr merge and carry the role env', () => {
  const s = roleSettings({ role: 'worker' });
  assert.deepEqual(s.permissions.deny, ['Bash(gh pr merge:*)', 'Bash(gh pr merge *)']);
  assert.equal(s.env.GLMPS_ROLE, 'worker');
  assert.equal('GLMPS_REVIEW_HEAD' in s.env, false);
});

test('reviewer settings carry the head branch and the configured integration branches', () => {
  const s = roleSettings({ role: 'reviewer', reviewHead: 'feat/x', integrationBranches: ['main', 'release'] });
  assert.equal(s.env.GLMPS_ROLE, 'reviewer');
  assert.equal(s.env.GLMPS_REVIEW_HEAD, 'feat/x');
  assert.equal(s.env.GLMPS_INTEGRATION_BRANCHES, 'main,release');
  assert.ok(s.permissions.deny.includes('Bash(gh pr merge:*)'));
});

// glmps-2-0-66: the denial feed found the card only from the runner branch, so
// every denial after an agent moved to a feature-branch worktree was dropped.
test('worker settings carry the card id so hooks find the card from any folder', () => {
  assert.equal(roleSettings({ role: 'worker', cardId: 'glmps-2-0-66' }).env.GLMPS_CARD_ID, 'glmps-2-0-66');
  assert.equal('GLMPS_CARD_ID' in roleSettings({ role: 'worker' }).env, false);
  assert.equal('GLMPS_CARD_ID' in roleSettings({ role: 'reviewer', reviewHead: 'feat/x', cardId: 'glmps-1-review-r1' }).env, false, 'a reviewer job id is not a card');
});

test('an unknown role yields no settings', () => {
  assert.equal(roleSettings({ role: 'nobody' }), null);
});

test('writeRoleSettings writes JSON under the state dir and returns its path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-role-'));
  try {
    const file = writeRoleSettings(dir, { role: 'worker', key: 'card-9' });
    assert.ok(file.startsWith(dir));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.GLMPS_ROLE, 'worker');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('default integration branches', () => {
  assert.deepEqual(DEFAULT_INTEGRATION_BRANCHES, ['main', 'master', 'glmps2/main']);
});

// worker pushes
test('worker: push to an integration branch is refused, naming the merge request path', () => {
  const r = checkRoleCommand({ ...W, command: 'git push origin main' });
  assert.equal(r.block, true);
  assert.match(r.reason, /merge request/i);
});

test('worker: HEAD:main refspec, plus-refspec, refs/heads and glmps2/main are refused', () => {
  assert.equal(blocked(W, 'git push origin HEAD:main'), true);
  assert.equal(blocked(W, 'git push origin +HEAD:main'), true);
  assert.equal(blocked(W, 'git push origin HEAD:refs/heads/glmps2/main'), true);
  assert.equal(blocked(W, 'git push -u origin glmps2/main'), true);
  assert.equal(blocked(W, 'git push --force-with-lease origin feat/x:master'), true);
});

test('worker: the -C form is refused', () => {
  assert.equal(blocked(W, 'git -C D:/repo push origin HEAD:main'), true);
  assert.equal(blocked(W, 'git -C "D:/my repo" push origin main'), true);
});

test('worker: chained commands are each checked', () => {
  assert.equal(blocked(W, 'git add -A && git commit -m x && git push origin HEAD:main'), true);
});

test('worker: its own card branch is allowed', () => {
  assert.equal(blocked(W, 'git push origin glmps-runner/card-1'), false);
  assert.equal(blocked(W, 'git push -u origin HEAD:feat/mine'), false);
  assert.equal(blocked(W, 'git -C D:/repo push origin HEAD'), false);
});

test('worker: bare push follows the upstream, else the current branch', () => {
  const up = (upstream, branch = 'feat/x') => ({ role: 'worker', resolve: () => ({ branch, upstream }) });
  assert.equal(blocked(up('main'), 'git push'), true);
  assert.equal(blocked(up('feat/x'), 'git push'), false);
  assert.equal(blocked(up('', 'main'), 'git push origin'), true);
  assert.equal(blocked(up('', 'feat/x'), 'git push origin'), false);
});

test('worker: --all and --mirror pushes are refused', () => {
  assert.equal(blocked(W, 'git push --all origin'), true);
  assert.equal(blocked(W, 'git push --mirror origin'), true);
});

test('worker: a configured extra integration branch is refused', () => {
  assert.equal(blocked({ ...W, integrationBranches: ['trunk'] }, 'git push origin HEAD:trunk'), true);
  assert.equal(blocked({ ...W, integrationBranches: ['trunk'] }, 'git push origin HEAD:main'), false);
});

test('worker: text that merely mentions a push is not a push', () => {
  assert.equal(blocked(W, 'echo "git push origin main"'), false);
  assert.equal(blocked(W, 'git log --oneline main'), false);
  assert.equal(blocked(W, 'git fetch origin main'), false);
});

// reviewer pushes
test('reviewer: may push the PR head branch only', () => {
  assert.equal(blocked(R, 'git push origin glmps-runner/card-1'), false);
  assert.equal(blocked(R, 'git push origin HEAD:glmps-runner/card-1'), false);
  assert.equal(blocked(R, 'git -C D:/repo push origin +HEAD:glmps-runner/card-1'), false);
  assert.equal(blocked(R, 'git push origin HEAD:main'), true);
  assert.equal(blocked(R, 'git -C D:/repo push origin main'), true);
  assert.equal(blocked(R, 'git push origin glmps-runner/other'), true);
});

test('reviewer: bare push is judged by the resolved branch', () => {
  assert.equal(blocked(R, 'git push'), false);
  assert.equal(blocked({ ...R, resolve: () => ({ branch: 'main', upstream: '' }) }, 'git push'), true);
});

test('reviewer with no head branch cannot push anywhere', () => {
  assert.equal(blocked({ ...R, reviewHead: '' }, 'git push origin glmps-runner/card-1'), true);
});

// merges
test('both roles: gh pr merge is refused', () => {
  assert.equal(blocked(W, 'gh pr merge 12 --squash'), true);
  assert.equal(blocked(R, 'gh -R o/r pr merge 12'), true);
  assert.equal(blocked(W, 'gh pr view 12'), false);
});

test('worker: gh api merge calls on pulls are refused', () => {
  assert.equal(blocked(W, 'gh api -X PUT repos/o/r/pulls/12/merge'), true);
  assert.equal(blocked(W, 'gh api --method PUT "/repos/o/r/pulls/12/merge" -f merge_method=squash'), true);
  assert.equal(blocked(W, 'gh api graphql -f query="mutation { mergePullRequest(input:{}) { clientMutationId } }"'), true);
  assert.equal(blocked(W, 'gh api repos/o/r/pulls/12'), false);
  assert.equal(blocked(W, 'gh api repos/o/r/pulls/12/comments'), false);
});

// no role
test('no role: nothing is refused', () => {
  const none = { role: '', resolve };
  assert.equal(blocked(none, 'git push origin main'), false);
  assert.equal(blocked(none, 'gh pr merge 1'), false);
  assert.equal(blocked({ role: undefined, resolve }, 'git push origin HEAD:main'), false);
});

test('a resolver that throws fails open', () => {
  const boom = { role: 'worker', resolve: () => { throw new Error('x'); } };
  assert.equal(blocked(boom, 'git push'), false);
});

// a wrapped or chained push/merge was invisible to the guard.
test('worker: a push wrapped in a shell, env or subshell is still refused', () => {
  const push = 'git push origin main';
  const cases = [
    `bash -c "${push}"`,
    `sh -c '${push}'`,
    `bash -lc "${push}"`,
    `cmd /c ${push}`,
    `cmd /c "${push}"`,
    `powershell -Command "${push}"`,
    `pwsh -NoProfile -Command "${push}"`,
    `FOO=1 ${push}`,
    `FOO=1 BAR="a b" ${push}`,
    `(${push})`,
    `( ${push} )`,
    `env ${push}`,
    `env -i FOO=1 ${push}`,
    `command ${push}`,
    `exec ${push}`,
    `echo hi; ${push}`,
    `echo hi && ${push}`,
    `false || ${push}`,
    `echo hi | ${push}`,
    `echo hi\n${push}`,
    `bash -c "echo hi && ${push}"`,
    `bash -c "bash -c 'git push origin main'"`,
    '/usr/bin/git push origin main',
    'git.exe push origin main',
  ];
  for (const c of cases) assert.equal(blocked(W, c), true, c);
});

test('worker: a merge wrapped or chained is still refused', () => {
  const cases = [
    'command gh pr merge 12',
    'env gh pr merge 12',
    'bash -c "gh pr merge 12 --squash"',
    'GH_TOKEN=x gh pr merge 12',
    '(gh pr merge 12)',
    'true && gh pr merge 12',
    'cmd /c gh pr merge 12',
    'bash -c "gh api -X PUT repos/o/r/pulls/12/merge"',
  ];
  for (const c of cases) assert.equal(blocked(W, c), true, c);
});

test('worker: wrapped commands that are not integration pushes stay allowed', () => {
  const cases = [
    'bash -c "git push origin glmps-runner/card-1"',
    'FOO=1 git push origin glmps-runner/card-1',
    '(git push origin glmps-runner/card-1)',
    'env git push origin glmps-runner/card-1',
    'bash -c "echo git push origin main"',
    'bash -c "git log main && git status"',
    'cmd /c echo done',
    'command gh pr view 12',
    'echo "a && git push origin main"',
  ];
  for (const c of cases) assert.equal(blocked(W, c), false, c);
});
