// server/test/api-memory-lookup.test.js
//
// D23/D24 cutover (glmps-159 task 6): GET /api/memory/lookup now fuses the
// curated tier with Mem0. Real HTTP round trip against startServer(); the
// test env never has an embed model installed, so Mem0 is never configured
// here.
//
// finding 6 - curated is not a fallback
// (D24 keeps it), so a Mem0 failure no longer 503s the whole route; it is
// reported as `mem0Error` alongside a normal 200. Finding 4 - `cwd` scopes
// the Mem0 half to the calling session's own project via the same slug
// convention admission uses, not always this server's own project.
// The fused-ranking / poison-filtering behavior itself is covered by
// memory-plugin.test.js's and memory-plugin-mem0-real.test.js's
// pure-function tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { resetAdapterHealth, reportMiss, adapterHealth } from '../lib/adapters/health.js';

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

let sharedStateDir;
let sharedClaudeDir;
let sharedSrv;

before(async () => {
  sharedStateDir = tmp('mc-lookup-');
  sharedClaudeDir = tmp('mc-lookup-claude-');
  fs.mkdirSync(path.join(sharedClaudeDir, 'projects'), { recursive: true });
  const configFile = path.join(sharedStateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({}));
  const env = { ...process.env, GLMPS_STATE_DIR: sharedStateDir, GLMPS_CLAUDE_DIR: sharedClaudeDir };
  sharedSrv = await startServer({ port: 0, env, configFile });
});

after(async () => {
  await sharedSrv?.close?.();
  if (sharedStateDir) fs.rmSync(sharedStateDir, { recursive: true, force: true });
  if (sharedClaudeDir) fs.rmSync(sharedClaudeDir, { recursive: true, force: true });
});

test('GET /api/memory/lookup responds 200 with mem0Error (not 503) when Mem0 is not configured', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/memory/lookup?q=anything`);
  assert.equal(r.status, 200, 'curated is not a fallback: it never goes away because Mem0 is down');
  const body = await r.json();
  assert.deepEqual(body.hits, []);
  assert.match(body.mem0Error, /configureHost/);
});

// an end-to-end proof (not just alert-sources.js's
// own unit tests) that a mem0-lookup reportMiss call server.js's route makes
// actually surfaces through the real GET /api/alerts as a "Kernel health:
// mem0-lookup" alert - never "Capture drift: mem0-lookup". The exact rendering
// (title, source, never a Capture-drift duplicate) is proven directly against
// a real reportMiss() call below; alert-sources.test.js's own unit tests
// cover the KERNEL_HEALTH_IDS rendering rule itself.
//
// K Task 6 fix round 2, I8 ruling (reopened): an UNCONFIGURED mem0 (this
// harness's only state - no embed model is ever installed here) is no
// longer treated as a lookup failure at all: memory-admission's own
// boot-failure report ("Loop failing: memory-admission") already covers it,
// and reporting it a second time, on every single lookup, would just be
// noise for a condition the operator already sees. This test's own
// end-to-end scenario moved from "every lookup is a miss" to this: the
// unconfigured case raises NO mem0-lookup kernel-health alert, but a
// genuine reportMiss('mem0-lookup', ...) call (the one server.js's route
// makes for an ACTUAL search failure, once mem0 is configured) still
// renders correctly through the real route.
test('an unconfigured Mem0 lookup raises no mem0-lookup Kernel health alert (I8: not a fresh failure)', async () => {
  resetAdapterHealth();
  try {
    const lookup = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/memory/lookup?q=anything`);
    assert.equal(lookup.status, 200);
    const alerts = (await (await fetch(`http://127.0.0.1:${sharedSrv.port}/api/alerts`)).json()).alerts;
    assert.ok(
      !alerts.some((a) => a.title === 'Kernel health: mem0-lookup'),
      `an unconfigured mem0 must not raise its own mem0-lookup alert, got: ${JSON.stringify(alerts.map((a) => a.title))}`,
    );
    // The operator still sees SOMETHING - memory-admission's own boot-failure
    // report - just not a second, redundant mem0-lookup alert for the exact
    // same root cause.
    assert.ok(alerts.some((a) => a.title === 'Loop failing: memory-admission'));
  } finally {
    resetAdapterHealth();
  }
});

test('a genuine mem0-lookup miss (mem0 configured, the search itself fails) renders as Kernel health, never Capture drift', async () => {
  resetAdapterHealth();
  const { reportMiss } = await import('../lib/adapters/health.js');
  const { collectAlerts } = await import('../lib/observability/alert-sources.js');
  const { adapterHealth } = await import('../lib/adapters/health.js');
  reportMiss('mem0-lookup', 'mem0 search down');
  const alerts = collectAlerts({ adapterHealth: adapterHealth() });
  const hit = alerts.find((a) => a.title === 'Kernel health: mem0-lookup');
  assert.ok(hit, `expected a Kernel health: mem0-lookup alert, got: ${JSON.stringify(alerts.map((a) => a.title))}`);
  assert.equal(hit.source, 'kernel-health');
  assert.ok(!alerts.some((a) => a.title.includes('Capture drift: mem0-lookup')));
  resetAdapterHealth();
});

test('GET /api/memory/lookup still requires a query', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/memory/lookup`);
  assert.equal(r.status, 400);
});

// with no `cwd`, the route falls back to this
// server's own project (unchanged prior behavior); with `cwd`, it derives
// the project from THAT path instead. This is exercised end to end (via
// mem0Error's absence of a project-specific message, since Mem0 is
// unconfigured here either way) by confirming the route accepts the param
// and still behaves - the actual cross-project isolation is proven against
// the real adapter in memory-plugin-mem0-real.test.js.
test('GET /api/memory/lookup accepts a cwd param to scope the project', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/memory/lookup?q=anything&cwd=${encodeURIComponent('D:\\some-other-project')}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.mem0Error, /configureHost/, 'still reaches the (unconfigured) Mem0 half, just scoped to the given cwd');
});

// I8/I5: the clear-on-success wirings in server.js
// itself, not just clearMiss() in isolation (already covered at the unit
// level, round 2). A migrate run with nothing to migrate (no distilled
// pool - this test's fresh claudeDir) has zero failures regardless of
// whether Mem0 itself is configured, so it is a real success path this
// test harness can reach without a real embed model.
test('a successful migrate-distilled run clears an earlier mem0-migrate miss', async () => {
  resetAdapterHealth();
  try {
    reportMiss('mem0-migrate', 'an earlier failure, before this boot');
    const r = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/memory/migrate-distilled`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.failed, 0, 'precondition: nothing to migrate, so zero failures');
    assert.equal(adapterHealth()['mem0-migrate'], undefined, 'the successful run must clear the earlier miss');
  } finally {
    resetAdapterHealth();
  }
});

// I8/I5: judge-load's clear-on-success wiring - the
// judge plugin loads successfully in this bare test env (it needs no real
// model config of its own at load time), so a boot genuinely exercises the
// success path.
test('a successful boot (judge plugin loads) clears an earlier judge-load miss', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-lookup-'); const claudeDir = tmp('mc-lookup-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  reportMiss('judge-load', 'an earlier failure, before this boot');
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'config.json') });
  try {
    assert.equal(adapterHealth()['judge-load'], undefined, 'a successful judge plugin load must clear the earlier miss');
  } finally {
    await h.close?.();
    resetAdapterHealth();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
