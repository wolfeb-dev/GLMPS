// server/test/service-mode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isServiceMode, serviceRestart, SERVICE_RESTART_EXIT_CODE } from '../lib/kernel/service-mode.js';
import { startServer } from '../server.js';

const SERVICE_MODE_MODULE_URL = pathToFileURL(path.join(import.meta.dirname, '..', 'lib', 'kernel', 'service-mode.js')).href;

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) {
    // Best-effort: process exit handlers run synchronously and cannot await,
    // and a leftover temp dir here is just disk, never a state leak (each is
    // under os.tmpdir(), never ~/.claude or ~/.glmps) -- so a
    // failed rmSync (e.g. Windows still holding a file handle open) is
    // logged and skipped rather than throwing out of the exit handler.
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.error(`service-mode.test cleanup: rmSync(${d}) failed: ${e?.message || e}`); }
  }
});

// Full GLMPS_* isolation set (server/test/adapter-health-state.test.js), not
// GLMPS_STATE_DIR alone (cross-plan finding F-24): startServer() falls back to
// the operator's real ~/.claude and ~/.glmps for any dir left
// unset, so a partial env leaks into the real state during boot.
function mkEnv(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-svc-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    ...process.env,
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
    ...extra,
  };
}

test('service mode is GLMPS_SERVICE=1 exactly', () => {
  assert.equal(isServiceMode({ GLMPS_SERVICE: '1' }), true);
  assert.equal(isServiceMode({ GLMPS_SERVICE: 'true' }), false);
  assert.equal(isServiceMode({}), false);
});

test('service mode restart exits and never spawns', async () => {
  const calls = [];
  await serviceRestart({ closeServer: async () => calls.push('close'), exit: (c) => calls.push(['exit', c]) });
  assert.deepEqual(calls, ['close', ['exit', 75]]);
  assert.equal(SERVICE_RESTART_EXIT_CODE, 75);
});

test('a close failure still exits 75 (the service manager restarts us either way)', async () => {
  const calls = [];
  await serviceRestart({ closeServer: async () => { throw new Error('socket busy'); }, exit: (c) => calls.push(c), log: () => {} });
  assert.deepEqual(calls, [75]);
});

// Fix round 1 (Opus review, Important): closeServer() had no deadline, so a
// stuck scut.stop() or an in-flight request left the process half-closed
// forever -- WinSW never restarts a process that never exits. Bounded to
// 1000ms at the test-runner level so this fails fast (not hangs) against the
// pre-fix implementation.
test('closeServer that never settles still exits 75 after the injected timeout', { timeout: 1000 }, async () => {
  const calls = [];
  await serviceRestart({
    closeServer: () => new Promise(() => {}), // never resolves or rejects
    exit: (c) => calls.push(['exit', c]),
    log: (msg) => calls.push(msg),
    timeoutMs: 20,
  });
  assert.deepEqual(calls.filter((c) => Array.isArray(c)), [['exit', 75]]);
  assert.ok(
    calls.some((c) => typeof c === 'string' && /timed out/i.test(c)),
    'logs when the timeout wins the race against closeServer',
  );
});

test('an overrun names the close step it was still in and reports it before exiting', { timeout: 1000 }, async () => {
  const calls = [];
  await serviceRestart({
    closeServer: () => new Promise(() => {}),
    exit: (c) => calls.push(['exit', c]),
    log: (msg) => calls.push(msg),
    stage: () => 'Slack stop',
    onOverrun: (s) => calls.push(['overrun', s]),
    timeoutMs: 20,
  });
  assert.ok(calls.some((c) => typeof c === 'string' && /timed out after 20ms in Slack stop; exiting anyway/.test(c)));
  assert.deepEqual(calls.filter((c) => Array.isArray(c)), [['overrun', 'Slack stop'], ['exit', 75]]);
});

// CI regression (Linux, node 22): an injected fake exit() in the test above
// hides a real bug, because it never actually ends the process, so the
// process-exit race this guards against never gets a chance to run. The
// fallback timer that decides the close-timeout race used to be unref'd, on
// the theory that it should "never be the reason the process stays alive".
// But exit(SERVICE_RESTART_EXIT_CODE) can only run after that race settles -
// an unref'd timer is invisible to Node's "is the event loop empty" check,
// so once closeServer() has torn down every other handle and nothing else is
// keeping the loop alive, Node is free to end the process on its own (exit
// code 0, the implicit default) the instant the loop looks empty, before the
// fallback timer ever fires. A real child process with no other open handles
// is the only way to observe this: proves the fallback timer actually wins
// the race and the process truly exits 75, not just that a mock function got
// called with 75.
test('serviceRestart in a real process with no other open handles exits 75, not 0, when closeServer never settles', () => {
  const script = `
    import('${SERVICE_MODE_MODULE_URL}').then(({ serviceRestart }) => {
      serviceRestart({
        closeServer: () => new Promise(() => {}), // never resolves or rejects
        exit: process.exit,
        log: () => {},
        timeoutMs: 50,
      });
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.equal(result.status, SERVICE_RESTART_EXIT_CODE,
    `expected the real process to exit ${SERVICE_RESTART_EXIT_CODE}, got status=${result.status} signal=${result.signal} stderr=${result.stderr?.toString()}`);
});

// this boots a real GLMPS_SERVICE=1 server with
// no wikiLoop config, so (before this fix) the wiki loop registered with
// its REAL default runBuild -- a genuine child build against this repo,
// capable of a real model call, with nothing here ever intending to
// exercise the wiki loop at all. wikiLoopOverrides.runBuild is belt-and-
// suspenders alongside the server-side isTestProcess() refusal: this test
// is about /api/restart, not the wiki loop, and must never let one run.
const NO_WIKI_BUILD = { wikiLoopOverrides: { runBuild: async () => { throw new Error('test: the wiki loop must never actually build here'); } } };

test('POST /api/restart reports its mode', async () => {
  let called = 0;
  const srv = await startServer({ port: 0, env: mkEnv({ GLMPS_SERVICE: '1' }), pollMs: 100000, restartFn: () => { called++; }, ...NO_WIKI_BUILD });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/restart`, { method: 'POST', headers: { 'x-glmps-local-session': srv.localSession } });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { restarting: true, mode: 'service' });
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(called, 1, 'the injected restartFn still wins in tests');
  } finally { await srv.close(); }
});

// Fix round 1 (Opus review, minor): the prior test only proves the response
// shape, because an injected restartFn bypasses defaultRestart (and so
// serviceRestart) entirely. This one leaves restartFn unset -- the real
// defaultRestart runs -- and injects the spawn/exit primitives it uses, so
// the actual "service mode never spawns, always exits 75" behavior is
// provable without ever exiting this test process or leaving a detached
// child around.
test('the real defaultRestart, under service mode, exits 75 and never spawns', async () => {
  const spawnCalls = [];
  const exitCalls = [];
  const srv = await startServer({
    port: 0, env: mkEnv({ GLMPS_SERVICE: '1' }), pollMs: 100000,
    restartSpawnFn: (...args) => { spawnCalls.push(args); return { unref() {} }; },
    restartExitFn: (code) => { exitCalls.push(code); },
    ...NO_WIKI_BUILD,
  });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/restart`, { method: 'POST', headers: { 'x-glmps-local-session': srv.localSession } });
    assert.equal(r.status, 202);
    await new Promise((res) => setTimeout(res, 400));
    assert.deepEqual(exitCalls, [75]);
    assert.deepEqual(spawnCalls, []);
  } finally { await srv.close(); } // idempotent: safe even though defaultRestart already closed
});

test('a supervised (GLMPS_SUPERVISED=1) desktop kernel restarts by exiting 75 and never spawns an unsupervised copy', async () => {
  const spawnCalls = [];
  const exitCalls = [];
  const srv = await startServer({
    port: 0, env: mkEnv({ GLMPS_SUPERVISED: '1' }), pollMs: 100000,
    restartSpawnFn: (...args) => { spawnCalls.push(args); return { unref() {} }; },
    restartExitFn: (code) => { exitCalls.push(code); },
    ...NO_WIKI_BUILD,
  });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/restart`, { method: 'POST', headers: { 'x-glmps-local-session': srv.localSession } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { restarting: true, mode: 'supervised' });
    await new Promise((res) => setTimeout(res, 400));
    assert.deepEqual(exitCalls, [75]);
    assert.deepEqual(spawnCalls, []);
  } finally { await srv.close(); }
});

test('server.js scrubs GLMPS_SUPERVISED from process.env at import so spawned children do not inherit it', () => {
  const serverUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'server.js')).href;
  const script = `import('${serverUrl}').then(() => { console.log('SUP=' + String(process.env.GLMPS_SUPERVISED)); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: mkEnv({ GLMPS_SUPERVISED: '1' }), timeout: 30000, encoding: 'utf8',
  });
  assert.match(r.stdout, /SUP=undefined/, `status=${r.status} stderr=${r.stderr}`);
});
