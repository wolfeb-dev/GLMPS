// Routes under test: server/lib/routes/plugins-routes.js
// server/test/gepa-route.test.js
//
// Guard proposer cutover, now the guard-proposals
// loop (K Task 6, server/lib/loops/plugin-loops.js). The loop is exercised
// directly through h.loopRegistry.emit('gepa.requested', {}) for the
// deterministic "no pending gaps" case, and through real HTTP for the
// 202/409 single-flight contract - the underlying work is a real
// child_process spawn (measurable OS latency, not a same-tick microtask), so
// a live HTTP race here is not expected to be flaky.
//
// plugins/gepa/propose_guards.py now EXISTS in this
// worktree, and the real CLI reaches the real model route,
// which reaches real `claude -p` - never allowed in a test. Every test here
// sets GLMPS_GEPA_SCRIPT to a throwaway path (nonexistent, or a tiny fake
// script that does nothing but write a canned failure) so the real CLI is
// never invoked. gepa-plugin.test.js covers the happy-path ingest with an
// injected spawnImpl at the unit level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { waitFor } from './helpers/wait-for.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Full GLMPS_* isolation (matching gap-shadow-integration.test.js's baseEnv):
// every adapter dir this server scans for gaps/alerts must be a throwaway
// temp dir, or a real session on the operator's machine (this dev box has
// live Claude/Gemini/etc. history) leaks into these tests as a phantom gap
// or alert - exactly the "never read the operator's real state" rule.
//
// GLMPS_ASSETS_DIR is now in the DEFAULT set
// too, not just the one test that explicitly needs a broken CLAUDE.global.md
// - readGuards() (the gepa adapter server.js builds for the guard-proposals
// loop) reads P.assetsDir/CLAUDE.global.md unconditionally, before runGepa
// even checks whether there are any failures to reflect on, so every test
// here that reaches it previously read the REAL default assets dir
// (D:/glmps-assets, a sibling of this checkout) rather than a
// throwaway one.
function isolatedEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CLAUDE_DIR: tmp('mc-gepa-claude-'),
    GLMPS_ANTIGRAVITY_DIR: tmp('mc-gepa-ag-'),
    GLMPS_GEMINI_TMP_DIR: tmp('mc-gepa-gemini-'),
    GLMPS_VSCODE_STORAGE_DIR: tmp('mc-gepa-vscode-'),
    GLMPS_AGY_CLI_DIR: tmp('mc-gepa-agy-'),
    GLMPS_CODEX_DIR: tmp('mc-gepa-codex-'),
    GLMPS_COPILOT_CLI_DIR: tmp('mc-gepa-copilot-'),
    GLMPS_HERMES_DIR: tmp('mc-gepa-hermes-'),
    GLMPS_OPENCODE_DIR: tmp('mc-gepa-opencode-'),
    GLMPS_ASSETS_DIR: tmp('mc-gepa-assets-'),
    ...extra,
  };
}

function seedPendingGap(stateDir) {
  let state = learningStore.emptyState();
  state = learningStore.upsertGapInto(state, { code: 'ui-without-frontend-design', severity: 'warn', message: 'm' }, { project: 'p', sessionId: 's1' }).state;
  learningStore.save(stateDir, state);
}

// A tiny real Python process (never gepa, never claude): writes a
// recognizable line to stderr and exits non-zero without ever writing
// --out, simulating a crash. Gives the test full control over what the
// eventual loop-failure alert text should contain.
function writeFakeCrashScript() {
  const dir = tmp('mc-gepa-fake-');
  const scriptPath = path.join(dir, 'fake_propose_guards.py');
  fs.writeFileSync(scriptPath, [
    'import sys',
    'sys.stderr.write("FAKE-GEPA-CRASH-MARKER: simulated failure for test\\n")',
    'sys.exit(1)',
    '',
  ].join('\n'));
  return scriptPath;
}

const isGepaAlert = (a) => a.source === 'loop' && a.title === 'Loop failing: guard-proposals';

async function waitForGepaAlert(base) {
  let alerts;
  for (let i = 0; i < 50; i++) {
    alerts = await (await fetch(`${base}/api/alerts`)).json();
    if (alerts.alerts.some(isGepaAlert)) return alerts;
    await new Promise((res) => setTimeout(res, 100));
  }
  return alerts;
}

test('the guard-proposals loop with no pending gap items is a clean no-op, not a loop failure', async () => {
  const stateDir = tmp('mc-gepa-route-');
  const env = isolatedEnv(stateDir, { GLMPS_GEPA_SCRIPT: path.join(tmp('mc-gepa-none-'), 'does-not-exist.py') });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const [r] = await h.loopRegistry.emit('gepa.requested', {});
    assert.equal(r.outcome, 'nothing-to-do', 'an empty pending-gap queue is a no-op, never a failure');
    const alerts = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
    assert.ok(!alerts.alerts.some(isGepaAlert), 'an empty queue never raises a loop failure, and never even spawns');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the guard-proposals loop against a nonexistent script fails closed with the interpreter\'s own error', async () => {
  const stateDir = tmp('mc-gepa-route-');
  seedPendingGap(stateDir);
  const env = isolatedEnv(stateDir, { GLMPS_GEPA_SCRIPT: path.join(tmp('mc-gepa-none-'), 'does-not-exist.py') });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const [r] = await h.loopRegistry.emit('gepa.requested', {});
    assert.equal(r.outcome, 'failed');
    assert.match(r.reason, /does-not-exist\.py/i, 'the interpreter\'s own "can\'t open file" message reaches the loop\'s own failure reason');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('POST /api/plugins/gepa/run: 202 started, then 409 while in flight; the CLI\'s stderr reaches the loop-failure alert', async () => {
  const stateDir = tmp('mc-gepa-route-');
  const env = isolatedEnv(stateDir, { GLMPS_GEPA_SCRIPT: writeFakeCrashScript() });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  try {
    // Seed a pending gap so buildGepaInput has a failure to reflect on -
    // otherwise the loop short-circuits on 'no-failures' before ever
    // spawning, and there would be nothing in flight to race against.
    seedPendingGap(stateDir);

    const [first, second] = await Promise.all([
      fetch(`${base}/api/plugins/gepa/run`, { method: 'POST' }),
      fetch(`${base}/api/plugins/gepa/run`, { method: 'POST' }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [202, 409], 'exactly one of the two concurrent calls is accepted');
    const busy = first.status === 409 ? first : second;
    assert.deepEqual(await busy.json(), { error: 'already running' });

    // Wait for the in-flight run to actually finish (the fake script exits
    // almost immediately) before asserting on its aftermath.
    const alerts = await waitForGepaAlert(base);
    const alert = alerts.alerts.find(isGepaAlert);
    assert.ok(alert, 'the fake CLI\'s crash is a loop failure, surfaced as an alert');
    assert.match(alert.detail, /FAKE-GEPA-CRASH-MARKER/, 'the CLI\'s stderr tail reaches the alert text');

    // The queue is untouched by a failed run: still one pending gap, no gepa
    // proposal, and it can be run again now that it is no longer in flight.
    const learning = await (await fetch(`${base}/api/learning`)).json();
    assert.equal(learning.items.length, 1);
    assert.equal(learning.items[0].source, 'gap');
    const again = await fetch(`${base}/api/plugins/gepa/run`, { method: 'POST' });
    assert.equal(again.status, 202);
    // The second run spawns a real Python child that holds stateDir open; on
    // Windows tearing down under it fails rmSync with EPERM (card glmps-2-0-233).
    await waitFor(() => !h.loopRegistry.isRunning('guard-proposals'), { message: 'the second guard-proposals run to finish' });
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('readGuards fails the run (never silently proposes from an empty seed) when CLAUDE.global.md cannot be read for a reason other than "missing"', async () => {
  const stateDir = tmp('mc-gepa-route-');
  seedPendingGap(stateDir);
  const assetsDir = tmp('mc-gepa-assets-');
  // A directory named CLAUDE.global.md: fs.readFileSync throws EISDIR, not
  // ENOENT - the one case that must fail the run rather than fall back to ''.
  fs.mkdirSync(path.join(assetsDir, 'CLAUDE.global.md'));
  const env = isolatedEnv(stateDir, { GLMPS_ASSETS_DIR: assetsDir, GLMPS_GEPA_SCRIPT: writeFakeCrashScript() });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const [r] = await h.loopRegistry.emit('gepa.requested', {});
    assert.equal(r.outcome, 'failed');
    assert.match(r.reason, /EISDIR|directory/i);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(assetsDir, { recursive: true, force: true });
  }
});
