// server/test/api-wiki-loop.test.js
// the loop runs in the kernel (service mode or explicit config), never in
// a plain test or dev server, and every test injects runBuild so no real model runs.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import { listRoutes, matchRoute, registerRoute } from '../lib/observability/route-registry.js';
import { writeFixtureBuild } from './fixtures/wiki-build-fixture.js';

const HEAD = '7'.repeat(40);
function mkEnv(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-awl-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const env = { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
    GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'oc'), GLMPS_UNMERGED_SCAN: 'off', ...extra };
  return { tmp, env };
}
function config(tmp, obj) { const f = path.join(tmp, 'config.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; }
const fakes = () => {
  const calls = { builds: 0 };
  return { calls, overrides: {
    readHead: async () => HEAD,
    readGraph: async () => ({ exists: true, commit: HEAD, fingerprint: 'g1:fixture' }),
    refreshGraph: async () => {},
    runBuild: async (o) => { calls.builds += 1; return writeFixtureBuild(o.buildDir, { headSha: o.headSha }); },
  } };
};
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); }
}

const snapshotRoutes = () => listRoutes().map(({ method, pattern }) => matchRoute(method, pattern).route);
const restoreRoutes = (routes) => { for (const r of routes) registerRoute(r); };

let serviceSrv;
let serviceRoutes;
let enabledSrv;
let enabledCalls;
let enabledRoutes;

before(async () => {
  const { env: serviceEnv } = mkEnv({ GLMPS_SERVICE: '1' });
  serviceSrv = await startServer({
    port: 0, pollMs: 1000, env: serviceEnv,
    // readHead/readGraph/refreshGraph injected so the maker reaches runBuild
    // deterministically; runBuild is deliberately left at its real default.
    wikiLoopOverrides: {
      readHead: async () => HEAD,
      readGraph: async () => ({ exists: true, commit: HEAD, fingerprint: 'g1:fixture' }),
      refreshGraph: async () => {},
    },
  });
  serviceRoutes = snapshotRoutes();

  const { tmp: enabledTmp, env: enabledEnv } = mkEnv();
  const { calls, overrides } = fakes();
  enabledCalls = calls;
  enabledSrv = await startServer({
    port: 0, pollMs: 1000, env: enabledEnv,
    configFile: config(enabledTmp, { wikiLoop: { enabled: true, keepBuilds: 5 } }),
    wikiLoopOverrides: overrides,
  });
  enabledRoutes = snapshotRoutes();
});

after(async () => {
  await enabledSrv?.close();
  await serviceSrv?.close();
});

test('a plain server (not service mode, no config) does not register the loop: rebuild of its own repo is 409', async () => {
  const { env } = mkEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const loops = await (await fetch(`http://127.0.0.1:${srv.port}/api/loops`)).json();
    assert.equal(loops.wiki, undefined);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /wiki loop is not running in this server/);
    assert.equal((await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json()).loop, null);
  } finally { await srv.close(); }
});

test('service mode registers the loop with the contract trigger (config default enabled: null)', async () => {
  restoreRoutes(serviceRoutes);
  const rec = await (await fetch(`http://127.0.0.1:${serviceSrv.port}/api/loops/wiki`)).json();
  assert.equal(rec.name, 'wiki');
  assert.deepEqual(rec.trigger, { everyMs: 21600000 });
});

test('config-enabled: POST /api/wiki/rebuild is 202, the loop publishes, and /api/wiki and /wiki/* show the build', async () => {
  restoreRoutes(enabledRoutes);
  const res = await fetch(`http://127.0.0.1:${enabledSrv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { queued: true, loop: 'wiki' });
  const wiki = await waitFor(async () => {
    const b = await (await fetch(`http://127.0.0.1:${enabledSrv.port}/api/wiki`)).json();
    return b.loop?.lastOutcome === 'done' ? b : null;
  });
  assert.equal(wiki.base, '/wiki');
  assert.equal(wiki.manifest.builtAtCommit, HEAD);
  assert.equal(wiki.loop.consecutiveFailures, 0);
  assert.ok(enabledCalls.builds >= 1);
  assert.equal((await fetch(`http://127.0.0.1:${enabledSrv.port}/wiki/server.html`)).status, 200);
});

// S2/S3 surfacing: modelErrors and degraded reach
// last-verify.json and the loop's log, but an operator's actual dashboard
// view is GET /api/wiki's loop field -- which only ever returned
// {lastOutcome, lastReason, lastRunTs, lastOkTs, consecutiveFailures,
// nextRunTs, retentionWarning}, with no path from either array to there.
test('GET /api/wiki loop view surfaces modelErrors and degraded from the last run', async () => {
  const { tmp, env } = mkEnv();
  const overrides = {
    readHead: async () => HEAD,
    readGraph: async () => ({ exists: true, commit: HEAD, fingerprint: 'g1:fixture' }),
    refreshGraph: async () => {},
    runBuild: async (o) => ({
      ...(await writeFixtureBuild(o.buildDir, { headSha: o.headSha })),
      modelErrors: [{ slug: 'server', error: 'rate limited (429)' }],
      degraded: [{ site: 'listFiles', detail: o.root, code: null, error: 'not a git repository', expected: true }],
    }),
  };
  const srv = await startServer({ port: 0, pollMs: 1000, env, configFile: config(tmp, { wikiLoop: { enabled: true } }), wikiLoopOverrides: overrides });
  try {
    await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const wiki = await waitFor(async () => {
      const b = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
      return b.loop?.lastOutcome === 'done' ? b : null;
    });
    assert.deepEqual(wiki.loop.modelErrors, [{ slug: 'server', error: 'rate limited (429)' }]);
    assert.equal(wiki.loop.degraded.length, 1);
    assert.equal(wiki.loop.degraded[0].site, 'listFiles');
  } finally { await srv.close(); }
});

// close() used to only stop() the registry
// (future scheduled runs); an in-flight wiki build (and its claude -p
// grandchild) outlived shutdown, and a late onVerified could hit the
// obligations store closed three lines later. close() must abort the
// in-flight run via the registry's new abort(), not just leave it running.
// Bounded: without the fix, `started` below never
// settles at all (the fake build only resolves on an abort it never gets),
// which hung this one test for over two minutes rather than failing it --
// a regression here must fail fast, not stall the whole suite.
test('close() aborts an in-flight wiki build rather than leaving it running (R-M1)', { timeout: 5000 }, async () => {
  const { tmp, env } = mkEnv();
  let sawAbort = false;
  const overrides = {
    readHead: async () => HEAD,
    readGraph: async () => ({ exists: true, commit: HEAD, fingerprint: 'g1:fixture' }),
    refreshGraph: async () => {},
    // Never resolves on its own: simulates a real build still running
    // (spawnWikiBuild's own promise never settles until the child does).
    runBuild: (o) => new Promise((resolve, reject) => {
      o.signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted'));
      }, { once: true });
    }),
  };
  const srv = await startServer({ port: 0, pollMs: 1000, env, configFile: config(tmp, { wikiLoop: { enabled: true } }), wikiLoopOverrides: overrides });
  const started = srv.loopRegistry.runNow('wiki', {});
  await waitFor(async () => srv.loopRegistry.isRunning('wiki') || null);
  await srv.close();
  assert.equal(sawAbort, true, 'close() must abort the in-flight build, not just stop future runs');
  const r = await started; // the aborted run settles (never an unhandled rejection)
  // an abort() called AFTER stop() (exactly what close()
  // does) must never record as a real failure -- see loop-registry-core.
  // test.js for the full rationale (a false "loop failing" streak alert
  // across ordinary restarts during a build).
  assert.deepEqual(r, { outcome: 'nothing-to-do', reason: 'aborted at shutdown' });
});

test('a partial wikiLoop config keeps the other defaults', async () => {
  restoreRoutes(enabledRoutes);
  const rec = await (await fetch(`http://127.0.0.1:${enabledSrv.port}/api/loops/wiki`)).json();
  assert.deepEqual(rec.trigger, { everyMs: 21600000 });
});

// cfg.wikiLoop.model ?? getModelConfig(cfg).models[cfg.wikiLoop.modelTier]
// used to resolve to undefined on a mistyped modelTier, silently omitting
// --model so wiki-build-cli.mjs fell back to its own hard-coded 'haiku' --
// no error, no log, just a quietly different model than configured. A
// known tier ('fast'/'strong', or a custom key under plugins.model.models)
// must still resolve by name; an unknown one must fall back to 'fast'
// VISIBLY (a logged warning), never to undefined.
test('a mistyped wikiLoop.modelTier logs a visible warning and falls back to the fast tier model, never undefined', async () => {
  const { tmp, env } = mkEnv();
  const seenModels = [];
  const { overrides } = fakes();
  // console.error must be captured BEFORE startServer(): the modelTier
  // warning fires synchronously during the wiki loop's registration, inside
  // startServer() itself, not later on the first run.
  const realError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); realError(...args); };
  const srv = await startServer({
    port: 0, pollMs: 1000, env,
    configFile: config(tmp, { wikiLoop: { enabled: true, modelTier: 'turbo-deluxe' } }),
    wikiLoopOverrides: { ...overrides, runBuild: async (o) => { seenModels.push(o.model); return overrides.runBuild(o); } },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 202);
    await waitFor(async () => {
      const b = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
      return b.loop?.lastOutcome === 'done' ? b : null;
    });
    assert.deepEqual(seenModels, ['haiku'], 'an unknown modelTier resolves to the fast tier model (haiku), not undefined');
    assert.ok(logs.some((m) => /unknown.*modelTier.*turbo-deluxe/i.test(m)), `expected a visible warning naming the bad tier, got: ${JSON.stringify(logs)}`);
  } finally { console.error = realError; await srv.close(); }
});

test('a recognised custom modelTier (plugins.model.models) still resolves by name, no warning', async () => {
  const { tmp, env } = mkEnv();
  const seenModels = [];
  const { overrides } = fakes();
  const realError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); realError(...args); };
  const srv = await startServer({
    port: 0, pollMs: 1000, env,
    configFile: config(tmp, { wikiLoop: { enabled: true, modelTier: 'cheap' }, plugins: { model: { models: { cheap: 'opus-mini' } } } }),
    wikiLoopOverrides: { ...overrides, runBuild: async (o) => { seenModels.push(o.model); return overrides.runBuild(o); } },
  });
  try {
    await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await waitFor(async () => {
      const b = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
      return b.loop?.lastOutcome === 'done' ? b : null;
    });
    assert.deepEqual(seenModels, ['opus-mini']);
    assert.ok(!logs.some((m) => /unknown.*modelTier/i.test(m)));
  } finally { console.error = realError; await srv.close(); }
});

// a retention error (an old build directory that
// fails to delete) is non-fatal to the run (checker already verified the new
// build; the run still records 'done'), so it must not vanish into a log file
// nobody watches -- it has to reach the same place an operator already looks,
// GET /api/wiki's loop view, for BOTH a manually-queued run and a run the
// registry's own timer fires with nobody watching stdout.
test('a retention error surfaces on GET /api/wiki loop view (not console only), and a later clean run clears it', async () => {
  const { tmp, env } = mkEnv();
  const { overrides } = fakes();
  const rmError = new Error('EBUSY: resource busy or locked');
  let rmFails = true; // flips false below, so a later run's prune actually succeeds
  const srv = await startServer({
    port: 0, pollMs: 1000, env,
    configFile: config(tmp, { wikiLoop: { enabled: true, keepBuilds: 1 } }),
    wikiLoopOverrides: { ...overrides, rm: (p, o) => { if (rmFails) throw rmError; return fs.rmSync(p, o); } },
  });
  try {
    // First build: publishes clean (nothing yet to prune).
    await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await waitFor(async () => {
      const b = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
      return b.loop?.lastOutcome === 'done' ? b : null;
    });
    assert.equal((await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json()).loop.retentionWarning, null);
    // Second build (forced, same HEAD): keepBuilds:1 means the first build is
    // now due for removal, and the injected rm always fails to remove it.
    let before = (await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json()).loop.lastRunTs;
    await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) });
    let wiki = await waitFor(async () => {
      const b = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
      return b.loop?.lastRunTs > before ? b : null;
    });
    assert.equal(wiki.loop.lastOutcome, 'done'); // the retention failure never fails the run
    assert.ok(wiki.loop.retentionWarning, 'expected a retentionWarning after a failed prune');
    assert.match(wiki.loop.retentionWarning.message, /old build\(s\) not removed/);
    assert.ok(Number.isFinite(wiki.loop.retentionWarning.ts));
    // Third build (forced): the underlying problem is resolved (rm now
    // succeeds), so the stale build removes cleanly and the warning must
    // clear, not just stay pinned at the earlier failure forever.
    rmFails = false;
    before = wiki.loop.lastRunTs;
    await fetch(`http://127.0.0.1:${srv.port}/api/wiki/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }) });
    wiki = await waitFor(async () => {
      const b = await (await fetch(`http://127.0.0.1:${srv.port}/api/wiki`)).json();
      return b.loop?.lastRunTs > before ? b : null;
    });
    assert.equal(wiki.loop.lastOutcome, 'done');
    assert.equal(wiki.loop.retentionWarning, null, 'expected the retentionWarning to clear after a clean prune');
  } finally { await srv.close(); }
});

// service-mode.test.js booted a real
// GLMPS_SERVICE=1 server with NO wikiLoopOverrides at all, so the loop
// registered with the REAL default runBuild (spawnWikiBuild against the
// real CLI, the real model backend) -- defense in depth, belt-and-suspenders
// on top of every test always injecting an override: the default runBuild
// itself must refuse to spawn a real build while isTestProcess() is true,
// with a named reason, rather than relying solely on every caller
// remembering to override it.
test('the default runBuild refuses under isTestProcess(), even with service mode and no override (defense in depth)', async () => {
  restoreRoutes(serviceRoutes);
  const r = await serviceSrv.loopRegistry.runNow('wiki', {});
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /isTestProcess/i, `expected a named refusal reason, got: ${r.reason}`);
});

test('D-W6: nothing living in the repo references the retired wiki path', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let out = '';
  try {
    // 'web/wiki/' (trailing slash), not the bare 'web/wiki' this pattern used
    // before the D-surface merge: D-surface (D3) keeps a permanent, unrelated
    // web/wiki-assets/ directory (vendored mermaid for the /wiki/ pages),
    // which the un-slashed pattern also matched as a false positive.
    out = execFileSync('git', ['-C', repo, 'grep', '-n', '-e', 'wiki-nightly', '-e', 'wikiRefresh', '-e', 'web/wiki/',
      '-e', 'install-wiki-hook', '-e', 'GLMPS_WIKI_DIR', '-e', 'wiki-refresh', '--',
      '.', ':!docs/superpowers', ':!docs/backlog-triage-2026-07-16.md', ':!docs/graphify-collapse-incident-2026-07-30.md',
      // The 2.0 planning corpus (merged under docs/, card glmps-2-0-142) is a
      // dated record that describes the retired path as history.
      ':!docs/research', ':!docs/rendered', ':!docs/overnight-readiness-2026-10-20.md',
      ':!docs/specs/2026-10-25-graphify-in-glmps2.md', ':!docs/specs/2026-10-28-wiki-graph-freshness.md',
      ':!server/test/api-wiki-loop.test.js'], { encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e; // git grep exits 1 when nothing matches, which is the pass
  }
  assert.equal(out, '', `retired references remain:\n${out}`);
});
