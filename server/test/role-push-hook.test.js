import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'push-lease-guard.js');
let repo;

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-role-hook-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'glmps-runner/card-1');
});
after(() => { fs.rmSync(repo, { recursive: true, force: true }); });

function run(command, roleEnv) {
  const env = { ...process.env, GLMPS_PORT: '1', GLMPS_PUSH_LEASE_TTL_MS: '1000' };
  for (const k of ['GLMPS_ROLE', 'GLMPS_REVIEW_HEAD', 'GLMPS_INTEGRATION_BRANCHES', 'GLMPS_ALLOW_PUSH_LEASE']) delete env[k];
  Object.assign(env, roleEnv);
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: 's1', hook_event_name: 'PreToolUse' }),
    env, encoding: 'utf8',
  });
  return { code: r.status, stderr: r.stderr };
}

const worker = { GLMPS_ROLE: 'worker' };
const reviewer = { GLMPS_ROLE: 'reviewer', GLMPS_REVIEW_HEAD: 'glmps-runner/card-1' };

test('hook: worker push to main is refused with a merge-request reason', () => {
  const r = run('git push origin main', worker);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /merge request/i);
});

test('hook: worker HEAD:main refspec and the -C form are refused', () => {
  assert.equal(run('git push origin HEAD:main', worker).code, 2);
  assert.equal(run(`git -C "${repo}" push origin HEAD:main`, worker).code, 2);
  assert.equal(run('git push origin +HEAD:glmps2/main', worker).code, 2);
});

test('hook: worker may push its own card branch (and the -C form)', () => {
  assert.equal(run('git push origin glmps-runner/card-1', worker).code, 0);
  assert.equal(run(`git -C "${repo}" push -u origin HEAD`, worker).code, 0);
});

test('hook: worker gh pr merge and gh api merge are refused', () => {
  assert.equal(run('gh pr merge 5 --squash', worker).code, 2);
  assert.equal(run('gh api -X PUT repos/o/r/pulls/5/merge', worker).code, 2);
  assert.equal(run('gh pr view 5', worker).code, 0);
});

test('hook: reviewer may push only the PR head branch', () => {
  assert.equal(run('git push origin glmps-runner/card-1', reviewer).code, 0);
  assert.equal(run('git push origin HEAD:glmps-runner/card-1', reviewer).code, 0);
  assert.equal(run('git push origin HEAD:main', reviewer).code, 2);
  assert.equal(run(`git -C "${repo}" push origin main`, reviewer).code, 2);
  assert.equal(run('git push origin glmps-runner/other', reviewer).code, 2);
});

test('hook: GLMPS_INTEGRATION_BRANCHES adds a refused branch', () => {
  assert.equal(run('git push origin HEAD:trunk', worker).code, 0);
  assert.equal(run('git push origin HEAD:trunk', { ...worker, GLMPS_INTEGRATION_BRANCHES: 'main,trunk' }).code, 2);
});

test('hook: the lease bypass env does not lift a role refusal', () => {
  assert.equal(run('git push origin main', { ...worker, GLMPS_ALLOW_PUSH_LEASE: '1' }).code, 2);
});

test('hook: no role behaves as before (gh pr merge untouched)', () => {
  assert.equal(run('gh pr merge 5', {}).code, 0);
  assert.equal(run('git status', {}).code, 0);
});
