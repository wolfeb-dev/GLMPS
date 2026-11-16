import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'deletion-guard.js');

function run(input, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['GLMPS_ROLE', 'GLMPS_DELETION_GUARD']) if (!(k in extraEnv)) delete env[k];
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env, encoding: 'utf8', windowsHide: true });
  return { code: r.status, stderr: r.stderr };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('a worker session is denied rm -rf, with copy or rename to .old named', () => {
  const r = run(bash('rm -rf build'), { GLMPS_ROLE: 'worker' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /BLOCKED/);
  assert.match(r.stderr, /Copy the file instead, or rename it to <name>\.old/);
});

test('a reviewer session is denied Remove-Item through the PowerShell tool', () => {
  const r = run({ tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -Recurse x' } }, { GLMPS_ROLE: 'reviewer' });
  assert.equal(r.code, 2);
});

test('an operator session (no role) is not blocked', () => {
  assert.equal(run(bash('rm -rf build')).code, 0);
});

test('GLMPS_DELETION_GUARD=all guards an operator session; off lifts a worker', () => {
  assert.equal(run(bash('git clean -fdx'), { GLMPS_DELETION_GUARD: 'all' }).code, 2);
  assert.equal(run(bash('git clean -fdx'), { GLMPS_ROLE: 'worker', GLMPS_DELETION_GUARD: 'off' }).code, 0);
});

test('a worker may rename to .old', () => {
  assert.equal(run(bash('mv a.txt a.txt.old'), { GLMPS_ROLE: 'worker' }).code, 0);
  assert.equal(run(bash('git mv a.txt a.txt.old'), { GLMPS_ROLE: 'worker' }).code, 0);
});

test('other tools and malformed stdin pass', () => {
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: 'x' } }, { GLMPS_ROLE: 'worker' }).code, 0);
  const r = spawnSync(process.execPath, [HOOK], { input: '{not json', env: { ...process.env, GLMPS_ROLE: 'worker' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /failed open/);
});
