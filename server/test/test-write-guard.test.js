// server/test/test-write-guard.test.js
// Pure predicate tests (Task 11 fix round 3, Important I2: "test the
// predicate as a pure function for each signal"). Every signal is injected
// here - never the real process.env/argv/os.tmpdir() - so this file never
// depends on, or mutates, this actual process's own test-ness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { testRealGitWriteRefused, isTestProcess } from '../lib/orchestration/test-write-guard.js';

const REAL_REPO = 'D:/some/real/repo';
const TMP_DIR = 'D:/tmp';
const TMP_REPO = 'D:/tmp/mc-fixture-repo';
const noSignals = { processEnv: {}, argv: ['node', 'server.js'], env: {}, tmpDir: TMP_DIR };

test('no signal at all (production): never refuses', () => {
  assert.equal(testRealGitWriteRefused(REAL_REPO, noSignals), false);
});

// Phase C final review, M8: this is the same four-signal check
// testRealGitWriteRefused uses internally, exported standalone so another
// module (the migration script) can detect a test process without
// duplicating the signal list.
test('M8: isTestProcess is the same four-signal check, exported standalone', () => {
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'server.js'] }), false);
  assert.equal(isTestProcess({ env: {}, processEnv: { NODE_TEST_CONTEXT: 'child-v8' }, argv: ['node', 'x.mjs'] }), true);
  assert.equal(isTestProcess({ env: { NODE_TEST_CONTEXT: '1' }, processEnv: {}, argv: ['node', 'x.mjs'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: { GLMPS_TEST: '1' }, argv: ['node', 'x.mjs'] }), true);
  assert.equal(isTestProcess({ env: { GLMPS_TEST: '1' }, processEnv: {}, argv: ['node', 'x.mjs'] }), true);
  assert.equal(isTestProcess({ env: {}, processEnv: {}, argv: ['node', 'x.test.js'] }), true);
});

test('signal (a): process.env.NODE_TEST_CONTEXT (node --test\'s own child-process marker)', () => {
  const r = testRealGitWriteRefused(REAL_REPO, { ...noSignals, processEnv: { NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(r, true);
});

test('signal (b): the INJECTED env\'s NODE_TEST_CONTEXT - covers a caller that builds env as a bare literal, never spreading process.env', () => {
  const r = testRealGitWriteRefused(REAL_REPO, { ...noSignals, env: { NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(r, true);
});

test('signal (c): process.env.GLMPS_TEST === "1" (test.env, loaded by every npm test run via --env-file)', () => {
  const r = testRealGitWriteRefused(REAL_REPO, { ...noSignals, processEnv: { GLMPS_TEST: '1' } });
  assert.equal(r, true);
});

test('signal (d): the INJECTED env\'s GLMPS_TEST === "1" - same bare-literal-env case as signal (b)', () => {
  const r = testRealGitWriteRefused(REAL_REPO, { ...noSignals, env: { GLMPS_TEST: '1' } });
  assert.equal(r, true);
});

test('signal (e): argv[1] matching /\\.test\\.m?js$/ - a direct `node x.test.js` run, or --test-isolation=none, where NODE_TEST_CONTEXT and test.env may both be absent', () => {
  const r = testRealGitWriteRefused(REAL_REPO, { ...noSignals, argv: ['node', 'server/test/api-purge-worktree.test.js'] });
  assert.equal(r, true);
  const r2 = testRealGitWriteRefused(REAL_REPO, { ...noSignals, argv: ['node', 'server/test/api-purge-worktree.test.mjs'] });
  assert.equal(r2, true);
  const r3 = testRealGitWriteRefused(REAL_REPO, { ...noSignals, argv: ['node', 'server/server.js'] });
  assert.equal(r3, false);
});

test('a repo already under os.tmpdir() is never refused, whichever signal is present - real test fixtures must keep working', () => {
  const r = testRealGitWriteRefused(TMP_REPO, { ...noSignals, processEnv: { NODE_TEST_CONTEXT: 'child-v8' } });
  assert.equal(r, false);
});

test('GLMPS_TEST_ALLOW_REAL_SWEEP=1 opts out of the refusal, from either process.env or the injected env', () => {
  const base = { ...noSignals, processEnv: { NODE_TEST_CONTEXT: 'child-v8' } };
  assert.equal(testRealGitWriteRefused(REAL_REPO, { ...base, processEnv: { ...base.processEnv, GLMPS_TEST_ALLOW_REAL_SWEEP: '1' } }), false);
  assert.equal(testRealGitWriteRefused(REAL_REPO, { ...base, env: { GLMPS_TEST_ALLOW_REAL_SWEEP: '1' } }), false);
});

test('containment is case- and separator-insensitive (win32 drive-letter case), matching isUnderDir', () => {
  const r = testRealGitWriteRefused('d:/TMP/mc-fixture-repo', { ...noSignals, processEnv: { NODE_TEST_CONTEXT: 'child-v8' }, tmpDir: 'D:\\tmp' });
  assert.equal(r, false);
});

test('multiple signals at once still refuse exactly like one', () => {
  const r = testRealGitWriteRefused(REAL_REPO, {
    processEnv: { NODE_TEST_CONTEXT: 'child-v8', GLMPS_TEST: '1' },
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    argv: ['node', 'x.test.js'],
    tmpDir: TMP_DIR,
  });
  assert.equal(r, true);
});

// realOrSelf used to fall back to the raw path for
// EVERY realpath failure. Only ENOENT (the path does not exist yet) falls back
// silently now; any other failure (EPERM, ELOOP) is reported with a named
// reason, and an unresolvable path is treated as NOT under tmpdir, so the
// predicate refuses - the safe direction. realpath is injected, so no real
// filesystem call happens here.
function failingRealpath(failOn, code) {
  return (p) => {
    if (p === failOn) { const e = new Error(`${code}: simulated`); e.code = code; throw e; }
    const e = new Error('ENOENT: simulated'); e.code = 'ENOENT'; throw e;
  };
}
const inTest = { ...noSignals, processEnv: { NODE_TEST_CONTEXT: 'child-v8' } };

test('M1: an EPERM resolving the repo refuses (unresolvable is not under tmpdir) and is reported by name', () => {
  const reasons = [];
  const r = testRealGitWriteRefused(TMP_REPO, {
    ...inTest, realpath: failingRealpath(TMP_REPO, 'EPERM'), onResolveError: (reason) => reasons.push(reason),
  });
  assert.equal(r, true, 'a temp-looking repo that cannot be resolved is still refused');
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /realpath-failed/);
  assert.match(reasons[0], /EPERM/);
});

test('M1: an ELOOP resolving the temp dir refuses and is reported by name', () => {
  const reasons = [];
  const r = testRealGitWriteRefused(TMP_REPO, {
    ...inTest, realpath: failingRealpath(TMP_DIR, 'ELOOP'), onResolveError: (reason) => reasons.push(reason),
  });
  assert.equal(r, true);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /ELOOP/);
});

test('M1: ENOENT still falls back to the raw path silently (a fixture path not created yet)', () => {
  const reasons = [];
  const r = testRealGitWriteRefused(TMP_REPO, {
    ...inTest, realpath: failingRealpath(null, 'ENOENT'), onResolveError: (reason) => reasons.push(reason),
  });
  assert.equal(r, false, 'the raw temp path is still recognised as under tmpdir');
  assert.deepEqual(reasons, [], 'ENOENT is the expected case and is not reported');
});

// Trunk-merge CI (Windows runner): TEMP is an 8.3 short name that the native
// realpath expands to the long form. A fixture path that does not exist yet
// must resolve through its nearest existing ancestor, or its short-form raw
// path no longer sits under the long-form temp dir and a real fixture is
// refused.
test('ENOENT resolves through the nearest existing ancestor, so a not-yet-created fixture under a short-name tmpdir is not refused', () => {
  const SHORT = path.join(path.sep, 'Users', 'RUNNER~1', 'Temp');
  const LONG = path.join(path.sep, 'Users', 'runneradmin', 'Temp');
  const realpath = (p) => {
    if (p === SHORT) return LONG;
    if (p === path.join(SHORT, 'mc-x')) return path.join(LONG, 'mc-x');
    const e = new Error('ENOENT: simulated'); e.code = 'ENOENT'; throw e;
  };
  const reasons = [];
  const r = testRealGitWriteRefused(path.join(SHORT, 'mc-x', 'repo'), {
    ...inTest, tmpDir: SHORT, realpath, onResolveError: (reason) => reasons.push(reason),
  });
  assert.equal(r, false);
  assert.deepEqual(reasons, []);
});
