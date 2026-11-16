// GLMPS 2.0 identity (separated build): the default service name is the
// literal GLMPS2, independent of process.env (fix round 1: no
// environment-derived default here; a caller that needs the env-aware,
// packaging-aware name calls endpoints.js resolveServiceName itself and
// passes it in as `name`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretScStart, startService, SERVICE_NAME } from '../src/lib/service-control.js';

test('interpretScStart maps the sc.exe outcomes the shell acts on', () => {
  assert.deepEqual(interpretScStart({ code: 0, stdout: 'SERVICE_NAME: GLMPS2\r\n        STATE              : 2  START_PENDING' }), { ok: true, code: 0, reason: 'start-requested' });
  assert.deepEqual(interpretScStart({ code: 1056, stdout: '[SC] StartService FAILED 1056:\r\n\r\nAn instance of the service is already running.' }), { ok: true, code: 1056, reason: 'already-running' });
  assert.deepEqual(interpretScStart({ code: 1060, stdout: '[SC] StartService: OpenService FAILED 1060:' }), { ok: false, code: 1060, reason: 'not-installed' });
  assert.deepEqual(interpretScStart({ code: 5, stdout: '[SC] StartService: OpenService FAILED 5:' }), { ok: false, code: 5, reason: 'access-denied' });
  assert.deepEqual(interpretScStart({ code: 1058, stdout: '' }), { ok: false, code: 1058, reason: 'disabled' });
  assert.deepEqual(interpretScStart({ code: 1053, stdout: '' }), { ok: false, code: 1053, reason: 'sc-error-1053' });
});

test('the FAILED code in the text wins over a truncated exit code (Git Bash shows 1060 as 36)', () => {
  assert.equal(interpretScStart({ code: 36, stdout: '[SC] StartService: OpenService FAILED 1060:' }).reason, 'not-installed');
});

test('startService runs exactly: sc.exe start <name>, hidden, with a 15 s timeout', async () => {
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, 'SERVICE_NAME: GLMPS2', ''); };
  const r = await startService({ name: SERVICE_NAME, execFileImpl });
  assert.deepEqual(calls, [{ file: 'sc.exe', args: ['start', 'GLMPS2'], opts: { windowsHide: true, timeout: 15000 } }]);
  assert.equal(r.reason, 'start-requested');
});

test('a failing sc.exe maps through its exit code and text; missing and timed-out sc.exe are named', async () => {
  const fail = (err, stdout) => (file, args, opts, cb) => cb(err, stdout, '');
  assert.equal((await startService({ execFileImpl: fail(Object.assign(new Error('Command failed'), { code: 1060 }), '[SC] StartService: OpenService FAILED 1060:') })).reason, 'not-installed');
  assert.equal((await startService({ execFileImpl: fail(Object.assign(new Error('spawn sc.exe ENOENT'), { code: 'ENOENT' }), '') })).reason, 'sc-missing');
  assert.equal((await startService({ execFileImpl: fail(Object.assign(new Error('killed'), { killed: true, code: null }), '') })).reason, 'sc-timeout');
});

test('the real sc.exe reports a missing service as not-installed (1060)', { skip: process.platform !== 'win32' ? 'Windows only' : false }, async () => {
  const r = await startService({ name: `GLMPS_TEST_NO_SUCH_SERVICE_${process.pid}` });
  assert.deepEqual(r, { ok: false, code: 1060, reason: 'not-installed' });
});

test('SERVICE_NAME defaults to the literal GLMPS2, with no environment-derived default', () => {
  assert.equal(SERVICE_NAME, 'GLMPS2');
});

test('SERVICE_NAME does not read GLMPS_SERVICE_NAME (that is endpoints.js resolveServiceName\'s job, at the caller)', async () => {
  const before = process.env.GLMPS_SERVICE_NAME;
  process.env.GLMPS_SERVICE_NAME = 'SOME_OTHER_NAME';
  try {
    // Re-import under a cache-busting query string: even a fresh module
    // evaluation must not pick up the env var, because this module no
    // longer derives its default from it at all.
    const mod = await import(`../src/lib/service-control.js?probe=${Date.now()}`);
    assert.equal(mod.SERVICE_NAME, 'GLMPS2');
  } finally {
    if (before === undefined) delete process.env.GLMPS_SERVICE_NAME; else process.env.GLMPS_SERVICE_NAME = before;
  }
});

test('interpretScStart: a signal-killed process (null code, no FAILED text) is a named failure, not start-requested', () => {
  const r = interpretScStart({ code: null, stdout: '' });
  assert.equal(r.ok, false);
  assert.notEqual(r.reason, 'start-requested');
  assert.doesNotMatch(r.reason, /NaN/);
});

test('interpretScStart: an undefined code with no FAILED text is a named failure, not start-requested', () => {
  const r = interpretScStart({ stdout: '' });
  assert.equal(r.ok, false);
  assert.notEqual(r.reason, 'start-requested');
  assert.doesNotMatch(r.reason, /NaN/);
});

test('interpretScStart: a non-numeric error code is a named failure, never the literal NaN', () => {
  const r = interpretScStart({ code: 'ERR_SOMETHING', stdout: '' });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /NaN/);
  assert.notEqual(r.reason, 'start-requested');
});
