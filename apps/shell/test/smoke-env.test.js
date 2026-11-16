// apps/shell/test/smoke-env.test.js
// the smoke run's environment lacked GLMPS_STATE_DIR, so the shell
// it launched resolved the operator's real ~/.glmps-2 and its launch
// runner read the real launch-token. The env is now built by smoke-env.mjs and
// always points GLMPS_STATE_DIR into the run's own temp dir, overriding anything
// inherited. Never imports run-smoke.mjs itself (that launches Electron).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { smokeEnv } from '../smoke/smoke-env.mjs';

const dir = path.join('C:\\tmp', 'glmps-shell-smoke-x');

test('W3: the smoke env always sets GLMPS_STATE_DIR inside the run\'s own temp dir, even over an inherited value', () => {
  for (const base of [{}, { GLMPS_STATE_DIR: 'C:\\Users\\op\\.glmps-2' }, { HOME: 'x' }]) {
    const env = smokeEnv({ base, dir, stubUrl: 'http://127.0.0.1:5555', result: path.join(dir, 'result.json') });
    assert.equal(typeof env.GLMPS_STATE_DIR, 'string');
    assert.equal(path.relative(dir, env.GLMPS_STATE_DIR).startsWith('..'), false, env.GLMPS_STATE_DIR);
    assert.notEqual(env.GLMPS_STATE_DIR, base.GLMPS_STATE_DIR);
  }
});

test('W3: the smoke env keeps its other isolation settings and never runs Electron as node', () => {
  const env = smokeEnv({ base: { ELECTRON_RUN_AS_NODE: '1' }, dir, stubUrl: 'http://127.0.0.1:5555', result: path.join(dir, 'result.json') });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.GLMPS_KERNEL_URL, 'http://127.0.0.1:5555');
  assert.equal(env.GLMPS_SERVICE_NAME, 'GLMPS_SMOKE_NO_SUCH_SERVICE');
  assert.equal(env.GLMPS_SHELL_USERDATA, path.join(dir, 'userData'));
  assert.equal(env.GLMPS_SHELL_SMOKE, path.join(dir, 'result.json'));
});

test('the smoke env names the stub control port and makes one failed probe a down kernel', () => {
  const env = smokeEnv({ base: {}, dir, stubUrl: 'http://127.0.0.1:5555', stubControlUrl: 'http://127.0.0.1:6666', result: path.join(dir, 'result.json') });
  assert.equal(env.GLMPS_SMOKE_STUB_CONTROL, 'http://127.0.0.1:6666');
  assert.equal(env.GLMPS_SHELL_SUPERVISOR_FAIL_THRESHOLD, '1');
  assert.equal(env.GLMPS_SHELL_SUPERVISOR_NO_ANSWER_MS, '0');
});

test('W3: run-smoke.mjs builds its env through smokeEnv, not an inline object', () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'smoke', 'run-smoke.mjs'), 'utf8');
  assert.match(text, /smokeEnv\(/);
  assert.doesNotMatch(text, /GLMPS_SERVICE_NAME:/, 'no second inline env definition');
});
