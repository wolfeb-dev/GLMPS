// server/test/launch-native-test-guard.test.js
// the review's own red-phase incident (five real terminal
// windows opened by a test before the service-mode branch existed) must be
// impossible to repeat. launchNative's real-spawn branch now refuses on its
// own, in ANY test process, whenever no spawn seam was injected - dry-run
// and service-mode are each only ONE guard; this is the backstop under both.
// spawnEditorApp carries the identical backstop now
// (resume location:'workspace', open-in-editor) - tested below the
// launchNative test, same safety discipline.
//
// SAFETY NOTE (read before touching this file): an earlier version of this
// test tried to prove the guard by mocking node:child_process's own `spawn`
// with node:test's t.mock.method as a belt-and-suspenders net. That net does
// NOT work for this codebase's import style - server.js does
// `import { spawn } from 'node:child_process'` (a named import), and
// mocking a DEFAULT import of the same built-in does not touch that
// binding; a NAMESPACE import cannot even be mocked at all ("Cannot
// redefine property: spawn"). Verified safely with a harmless, invisible
// `node --version` probe outside this suite before writing this comment -
// neither mock intercepted the real call. So: this test asserts the
// guard's effect (the HTTP response and the adapterHealth miss it records)
// rather than relying on any child_process mock. Do not add one back
// without re-verifying it actually intercepts a NAMED import in this repo's
// ESM style; a mock that looks safe but silently fails is how the five
// windows happened the first time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';
import { readEvents } from '../lib/observability/event-log.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = '3f2a9b1c-1111-4222-8333-444455556666';

test('launchNative refuses a real spawn in a test process when no spawn seam was injected (no dry-run, no service mode)', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-launchguard-state-');
  const claudeDir = claudeTmp();
  const cwd = tmp('mc-launchguard-cwd-');
  // Deliberately neither GLMPS_RUNNER_DRYRUN nor GLMPS_SERVICE, and no
  // editorSpawnFn passed to startServer: the real-spawn branch itself is
  // what isTestProcess() must refuse, with no other guard in front of it.
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  delete env.GLMPS_RUNNER_DRYRUN;
  delete env.GLMPS_SERVICE;
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()] }));
  const h = await startServer({ port: 0, env, configFile });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession },
      body: JSON.stringify({ sessionId: SID, cwd, location: 'editor' }),
    });
    assert.equal(r.status, 500, 'no pid and no launchId: a named, visible refusal, not a silent 200');
    const body = await r.json();
    assert.equal(body.error, 'terminal did not start');
    const miss = adapterHealth()['spawn:resume'];
    assert.ok(miss, 'the refusal is reported under the route\'s own spawn: miss key');
    assert.match(miss.lastReason ?? '', /test process, no injected spawn seam/);
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1, 'a durable launch.failed event, not only the health-panel miss');
    assert.equal(events[0].lane, 'resume');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// spawnEditorApp's own copy of the same backstop. The
// implementation was written and reviewed BEFORE this test (same safety
// discipline as the launchNative test above): the guard returns before
// guardedSpawn is ever built, so by construction no real spawn is
// reachable here even with no editorSpawnFn injected at all.
test('spawnEditorApp refuses a real spawn in a test process when no spawn seam was injected (no service mode)', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-editorguard-state-');
  const claudeDir = claudeTmp();
  const cwd = tmp('mc-editorguard-cwd-');
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ antigravityCommand: 'fake-antigravity', launchRoots: [os.tmpdir()] }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  delete env.GLMPS_SERVICE;
  const h = await startServer({ port: 0, env, configFile });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession },
      body: JSON.stringify({ sessionId: SID, cwd, location: 'workspace' }),
    });
    assert.equal(r.status, 500, 'a named, visible refusal, not a silent opened:true');
    const body = await r.json();
    assert.match(body.error, /test process, no injected spawn seam/);
    const miss = adapterHealth()['spawn:resume-workspace'];
    assert.ok(miss, 'the refusal is reported under the route\'s own spawn: miss key');
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].lane, 'resume-workspace');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
