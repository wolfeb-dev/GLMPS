// apps/shell/test/endpoints.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KERNEL_URL, resolveKernelUrl, resolveLogsDir, resolveStateDir, resolveWorktreesDir, resolveServiceName, shouldRunLaunches } from '../src/lib/endpoints.js';

test('the default kernel URL is the live kernel on loopback 8123', () => {
  const k = resolveKernelUrl({ env: {}, settings: {} });
  assert.equal(k.url, 'http://127.0.0.1:8123/');
  assert.equal(k.origin, 'http://127.0.0.1:8123');
  assert.equal(k.isLoopback, true);
  assert.equal(k.source, 'default');
  assert.equal(DEFAULT_KERNEL_URL, 'http://127.0.0.1:8123');
});

test('GLMPS_KERNEL_URL wins over settings; a remote host is not loopback', () => {
  const k = resolveKernelUrl({ env: { GLMPS_KERNEL_URL: 'http://mini.lan:8124' }, settings: { kernelUrl: 'http://127.0.0.1:9000' } });
  assert.equal(k.source, 'env');
  assert.equal(k.isLoopback, false);
  assert.equal(resolveKernelUrl({ env: {}, settings: { kernelUrl: 'http://localhost:9000' } }).isLoopback, true);
});

test('a non-http kernel URL is refused with a warning and the default is used', () => {
  const k = resolveKernelUrl({ env: { GLMPS_KERNEL_URL: 'file:///C:/evil.html' }, settings: {} });
  assert.equal(k.origin, 'http://127.0.0.1:8123');
  assert.match(k.warning, /ignored invalid kernel URL from env/);
  assert.match(resolveKernelUrl({ env: { GLMPS_KERNEL_URL: 'not a url' }, settings: {} }).warning, /ignored/);
});

const ABSENT = () => false;
const GLMPS2_PRESENT = (p) => p === path.join('C:/u', '.glmps2');

test('logs folder follows GLMPS_STATE_DIR, then settings.stateDir, then the live state folder', () => {
  assert.equal(resolveLogsDir({ env: { GLMPS_STATE_DIR: 'D:/s' }, settings: {}, homedir: 'C:/u' }), path.join('D:/s', 'logs'));
  assert.equal(resolveLogsDir({ env: {}, settings: { stateDir: 'E:/t' }, homedir: 'C:/u' }), path.join('E:/t', 'logs'));
  assert.equal(resolveLogsDir({ env: {}, settings: {}, homedir: 'C:/u', exists: ABSENT }), path.join('C:/u', '.glmps', 'logs'));
  assert.equal(resolveLogsDir({ env: {}, settings: {}, homedir: 'C:/u', exists: GLMPS2_PRESENT }), path.join('C:/u', '.glmps2', 'logs'));
});

test('card glmps-2-0-144: empty settings never point at the pre-cutover shadow folder or port 8124', () => {
  for (const exists of [ABSENT, GLMPS2_PRESENT]) {
    assert.doesNotMatch(resolveStateDir({ env: {}, settings: {}, homedir: 'C:/u', exists }), /glmps-2/);
  }
  assert.doesNotMatch(resolveKernelUrl({ env: {}, settings: {} }).url, /8124/);
  assert.equal(resolveStateDir({ env: {}, settings: {}, homedir: 'C:/u', exists: () => { throw new Error('EACCES'); } }), path.join('C:/u', '.glmps'), 'a failed check reads as absent');
});

// the same formula, without the trailing 'logs' segment -
// the directory the launch runner's own runner-origin path check resolves
// a queued prompt path against.
test('resolveStateDir follows the same precedence as resolveLogsDir, minus the logs segment', () => {
  assert.equal(resolveStateDir({ env: { GLMPS_STATE_DIR: 'D:/s' }, settings: {}, homedir: 'C:/u' }), 'D:/s');
  assert.equal(resolveStateDir({ env: {}, settings: { stateDir: 'E:/t' }, homedir: 'C:/u' }), 'E:/t');
  assert.equal(resolveStateDir({ env: {}, settings: {}, homedir: 'C:/u', exists: GLMPS2_PRESENT }), path.join('C:/u', '.glmps2'));
});

test('resolveWorktreesDir: GLMPS_WORKTREES_DIR, then settings.worktreesDir, then <stateDir>/runner/worktrees', () => {
  assert.equal(resolveWorktreesDir({ env: { GLMPS_WORKTREES_DIR: 'D:/w', GLMPS_STATE_DIR: 'D:/s' }, settings: { worktreesDir: 'E:/x' }, homedir: 'C:/u' }), 'D:/w');
  assert.equal(resolveWorktreesDir({ env: {}, settings: { worktreesDir: 'E:/x' }, homedir: 'C:/u' }), 'E:/x');
  assert.equal(resolveWorktreesDir({ env: { GLMPS_STATE_DIR: 'D:/s' }, settings: {}, homedir: 'C:/u' }), path.join('D:/s', 'runner', 'worktrees'));
  assert.equal(resolveWorktreesDir({ env: {}, settings: {}, homedir: 'C:/u', exists: GLMPS2_PRESENT }), path.join('C:/u', '.glmps2', 'runner', 'worktrees'));
});

test('the service name override is honoured only in an unpackaged (dev or smoke) run', () => {
  assert.equal(resolveServiceName({ env: { GLMPS_SERVICE_NAME: 'X' }, isPackaged: false }), 'X');
  assert.equal(resolveServiceName({ env: { GLMPS_SERVICE_NAME: 'X' }, isPackaged: true }), 'GLMPS2');
  assert.equal(resolveServiceName({ env: {}, isPackaged: false }), 'GLMPS2');
});

// the launch runner executes whatever the kernel hands
// it in the operator's own session. The session-0 problem (what this whole
// feature exists for) is local-only; a non-loopback kernelUrl means this
// shell is pointed at SOME OTHER machine's kernel, and a LAN host or a
// MITM between here and there could serve a launch that then runs on THIS
// machine, in this operator's session, regardless of the kernel's own
// up/degraded/down state.
test('shouldRunLaunches: only when the kernel is loopback', () => {
  assert.equal(shouldRunLaunches({ isLoopback: true }), true);
  assert.equal(shouldRunLaunches({ isLoopback: false }), false);
});

// Task 15, L4 (security review): a kernel URL carrying a username or password
// was accepted, shown in plain text (title, offline page, notifications),
// loaded into the dashboard pane and broke fetch (which refuses credentialed
// URLs). It is now invalid: the default is used, with a warning that does
// not repeat the secret.
test('L4: a kernel URL with a username or password is refused, the default is used, and the warning hides the credential', () => {
  for (const raw of ['http://user:hunter2@127.0.0.1:8124', 'http://user@127.0.0.1:8124', 'http://:hunter2@127.0.0.1:8124']) {
    for (const [env, settings] of [[{ GLMPS_KERNEL_URL: raw }, {}], [{}, { kernelUrl: raw }]]) {
      const k = resolveKernelUrl({ env, settings });
      assert.equal(k.url, new URL(DEFAULT_KERNEL_URL).href, raw);
      assert.equal(k.source, 'default');
      assert.match(k.warning, /credentials/);
      assert.doesNotMatch(k.warning, /hunter2/);
    }
  }
});

test('card glmps-2-0-144: on a real disk the default follows the cutover rename', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-home-'));
  try {
    fs.mkdirSync(path.join(home, '.glmps'));
    assert.equal(resolveStateDir({ env: {}, settings: {}, homedir: home }), path.join(home, '.glmps'));
    fs.renameSync(path.join(home, '.glmps'), path.join(home, '.glmps2'));
    fs.symlinkSync(path.join(home, '.glmps2'), path.join(home, '.glmps'), 'junction');
    assert.equal(resolveStateDir({ env: {}, settings: {}, homedir: home }), path.join(home, '.glmps2'));
    assert.equal(resolveLogsDir({ env: {}, settings: {}, homedir: home }), path.join(home, '.glmps2', 'logs'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
