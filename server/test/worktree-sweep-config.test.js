// server/test/worktree-sweep-config.test.js
//
// the 2.0 shadow instance observes
// production and other repos read-only, so its boot-time and inventory-tick
// worktree sweep (server/lib/orchestration/worktree-sweeper.js) must never
// run `git worktree prune` / `git branch -d` against them. cfg.worktreeSweep
// is the explicit, deep-merged config switch that gates it (defaulting true
// for production); GLMPS_UNMERGED_SCAN=off is the separate, pre-existing
// environment gate the shadow launcher also sets.
//
// Most tests here inject `sweepSessionWorktreesFn` as a fake recorder, so
// even when the gate is (deliberately) open in a test, no real git command
// ever runs against this checkout's own repo (server.js's gitRepoRoots()
// always includes REPO_ROOT, which is this worktree). A few tests below
// deliberately run the REAL (non-injected) sweeper instead, to prove the
// test-process backstop itself (test-write-guard.js's
// testRealGitWriteRefused) refuses before any real git command is reached -
// for those, the backstop IS the safety net, not a fake.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';
import { waitFor } from './helpers/wait-for.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// the sweep's test-write guard is now per root, so a
// real root (REPO_ROOT, this checkout) is filtered out before it ever reaches
// even an injected sweeper. The tests below that need the sweeper REACHED
// inject one temp-dir root instead; the recorder sweepers never run git.
const SWEEP_TMP_ROOT = tmp('mc-wsc-root-');
process.on('exit', () => { try { fs.rmSync(SWEEP_TMP_ROOT, { recursive: true, force: true }); } catch (e) { console.error(`[worktree-sweep-config] temp root cleanup failed: ${e?.message ?? e}`); } });
const sweepableTmpRoots = () => [{ project: 'tmp-root', path: SWEEP_TMP_ROOT }];

function isolatedEnv(extra = {}) {
  return {
    ...process.env,
    GLMPS_CLAUDE_DIR: tmp('mc-wsc-claude-'),
    GLMPS_ANTIGRAVITY_DIR: tmp('mc-wsc-ag-'),
    GLMPS_GEMINI_TMP_DIR: tmp('mc-wsc-gemini-'),
    GLMPS_VSCODE_STORAGE_DIR: tmp('mc-wsc-vscode-'),
    GLMPS_AGY_CLI_DIR: tmp('mc-wsc-agy-'),
    GLMPS_CODEX_DIR: tmp('mc-wsc-codex-'),
    GLMPS_COPILOT_CLI_DIR: tmp('mc-wsc-copilot-'),
    GLMPS_HERMES_DIR: tmp('mc-wsc-hermes-'),
    GLMPS_OPENCODE_DIR: tmp('mc-wsc-opencode-'),
    GLMPS_MODEL_RUNNER: 'off',
    ...extra,
  };
}

let defaultSweepStateDir;
let defaultSweepSrv;
let currentSweeper = null;

let realGuardStateDir;
let realGuardSrv;

before(async () => {
  defaultSweepStateDir = tmp('mc-wsc-shared-on-');
  const defaultEnv = isolatedEnv({ GLMPS_STATE_DIR: defaultSweepStateDir });
  delete defaultEnv.GLMPS_UNMERGED_SCAN;
  defaultSweepSrv = await startServer({
    port: 0, env: defaultEnv,
    gitRepoRootsFn: sweepableTmpRoots,
    sweepSessionWorktreesFn: async (arg) => (currentSweeper ? currentSweeper(arg) : { removed: [], kept: [] }),
  });
  let settled = false;
  currentSweeper = async () => { settled = true; return { removed: [], kept: [] }; };
  await waitFor(async () => { await defaultSweepSrv.sweepWorktreesTick(); return settled; }, { message: 'the shared server to finish a sweep' });
  currentSweeper = null;

  resetAdapterHealth();
  realGuardStateDir = tmp('mc-wsc-shared-nospawn-');
  const realGuardEnv = isolatedEnv({ GLMPS_STATE_DIR: realGuardStateDir });
  delete realGuardEnv.GLMPS_UNMERGED_SCAN;
  realGuardSrv = await startServer({ port: 0, env: realGuardEnv });
});

after(async () => {
  await realGuardSrv?.close?.();
  await defaultSweepSrv?.close?.();
  if (realGuardStateDir) fs.rmSync(realGuardStateDir, { recursive: true, force: true });
  if (defaultSweepStateDir) fs.rmSync(defaultSweepStateDir, { recursive: true, force: true });
});

test('worktree sweep never runs when cfg.worktreeSweep.enabled is false, even though nothing else disables it', async () => {
  const stateDir = tmp('mc-wsc-off-');
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ worktreeSweep: { enabled: false } }));
  let called = false;
  // Deliberately NOT setting GLMPS_UNMERGED_SCAN=off: this test proves the
  // config gate alone stops the sweep, independent of the environment gate.
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir });
  delete env.GLMPS_UNMERGED_SCAN;
  const h = await startServer({
    port: 0, env, configFile,
    gitRepoRootsFn: sweepableTmpRoots,
    sweepSessionWorktreesFn: async () => { called = true; return { removed: [], kept: [] }; },
  });
  try {
    await h.sweepWorktreesTick();
    assert.equal(called, false, 'sweepSessionWorktrees must never be called while cfg.worktreeSweep.enabled is false');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('worktree sweep defaults to enabled (production posture): with no config override and the env gate open, the injected sweeper runs', async () => {
  let called = false;
  currentSweeper = async () => { called = true; return { removed: [], kept: [] }; };
  try {
    await defaultSweepSrv.sweepWorktreesTick();
    assert.equal(called, true, 'expected the default-enabled sweep to reach the injected sweeper');
  } finally {
    currentSweeper = null;
  }
});

test('worktree sweep still honors the pre-existing GLMPS_UNMERGED_SCAN=off environment gate when cfg.worktreeSweep.enabled is true', async () => {
  const stateDir = tmp('mc-wsc-envgate-');
  let called = false;
  const h = await startServer({
    port: 0, env: isolatedEnv({ GLMPS_STATE_DIR: stateDir, GLMPS_UNMERGED_SCAN: 'off' }),
    // enabled defaults true; GLMPS_UNMERGED_SCAN=off must still block it.
    gitRepoRootsFn: sweepableTmpRoots,
    sweepSessionWorktreesFn: async () => { called = true; return { removed: [], kept: [] }; },
  });
  try {
    await h.sweepWorktreesTick();
    assert.equal(called, false, 'GLMPS_UNMERGED_SCAN=off must still gate the sweep even with the config flag left at its default');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// Minor (fold), Task 11 fix round 1: sweepWorktrees' liveJobIds is the union
// of the live ledger AND retainedWorktreeJobs() - an idle or hidden ticket's
// worktree must be just as protected from the SWEEP as it already is from
// reconcileNow's own departed-loop reclaim (runner-worktree.test.js's
// integration test covers that side).
test('worktree sweep folds retained (idle) job ids into liveJobIds, even with an empty runner ledger', async () => {
  let seenLiveJobIds = null;
  currentSweeper = async ({ liveJobIds }) => { seenLiveJobIds = liveJobIds; return { removed: [], kept: [] }; };
  try {
    const { item } = backlogStore.addItemTo(defaultSweepStateDir, { project: 'p', title: 'idle retained' });
    backlogStore.updateItemIn(defaultSweepStateDir, item.id, { state: 'idle' });
    backlogStore.setRunSessionIn(defaultSweepStateDir, item.id, { worktree: { dir: 'W', branch: 'b', repo: 'R' } });

    // startServer() fires an un-awaited boot-time sweep (server.js's own
    // `sweepWorktrees().catch(() => {})`), which can still be in flight here
    // - its sweepWorktreesInFlight guard then makes a same-tick tick() call a
    // silent no-op rather than actually waiting for it, so a single call
    // cannot tell "blocked" apart from "ran with stale data". Poll instead
    // (bounded, not a fixed sleep): eventually one attempt lands with the
    // flag clear, and by then this test's own card already exists, so its id
    // is in THAT attempt's liveJobIds.
    const deadline = Date.now() + 5000;
    let found = false;
    while (Date.now() < deadline && !found) {
      seenLiveJobIds = null;
      await defaultSweepSrv.sweepWorktreesTick();
      found = Array.isArray(seenLiveJobIds) && seenLiveJobIds.includes(item.id);
      if (!found) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(found, `expected liveJobIds to include ${item.id} within the poll window; last seen: ${JSON.stringify(seenLiveJobIds)}`);
  } finally {
    currentSweeper = null;
  }
});

// Task 11 fix round 2/3 SAFETY RULING: 68 server-booting test files never
// set GLMPS_UNMERGED_SCAN=off, so without a backstop independent of any single
// file remembering that gate, every one of them fires the REAL sweeper
// against this machine's real repos on every boot and every inventory
// tick. Confirmed directly (server.js's own gitRepoRoots(), driven through
// this file's injected-fn seam with GLMPS_UNMERGED_SCAN unset): with no
// backstop, this scans REPO_ROOT and every other real project directory
// this workstation's session history and settings know about - not a
// hypothetical. The sweep cannot remove real worktree DIRECTORIES (filtered
// by the temp worktreesDir), but it still runs `git worktree prune` and
// `git branch -d` on merged tooling/runner branches in those real repos - a
// genuine write to state outside the test's own temp dirs.
//
// Round 2's version read only the INJECTED env.NODE_TEST_CONTEXT, which
// left ~17 test files that build env as a bare literal (never spreading
// process.env) still running the real sweep, and a direct `node
// x.test.js` run bypassed it too (no NODE_TEST_CONTEXT at all - that is
// node --test's own child-process marker). Round 3's
// testRealGitWriteRefused (server/lib/orchestration/test-write-guard.js,
// its own pure-function tests) checks four independent test-process
// signals, so both gaps are closed - see its own test file for the
// signal-by-signal RED/GREEN coverage.
//
// Deliberately NOT verified by mocking child_process.execFile from this
// file: server.js imports it as a NAMED import
// (`import { execFile } from 'node:child_process'`), and a mock installed
// via a DIFFERENT file's import of the same builtin does not reach that
// binding (confirmed empirically - unlike fs, which server.js and
// editor-spawn-routes.test.js both import as the DEFAULT export, a mutable
// shared object). The only way to safely prove "no git subprocess call
// happens" without risking one is to make the refusal itself the very
// first line of sweepWorktrees, verified here by its own reported miss -
// nothing runs before a `return` statement, and the ordering is the whole
// safety property (see server.js's own comment on the check).
//
// resetAdapterHealth() before each of these - the registry is
// a process-wide singleton (never reset between tests in one file, as
// carry-in (c)'s own fix round 1 report already found the hard way), so
// without this, an earlier test's own refusal could make a LATER test pass
// even if ITS OWN boot never refused anything.
test('the real (non-injected) worktree sweeper refuses to run at all under node --test, reporting a named reason', async () => {
  // No sweepSessionWorktreesFn override on realGuardSrv: exercises the REAL
  // default - safe ONLY because the backstop refuses before ever reaching it.
  await realGuardSrv.sweepWorktreesTick();
  assert.ok(adapterHealth()['sweep-worktrees-test-guard']?.misses >= 1, 'the refusal is reported with a named reason');
});

// The reviewer's own residual risk: the backstop must not be fooled by
// GLMPS_WORKTREES_DIR merely LOOKING like a real, non-temp path - it refuses
// on the test-process signals alone, independent of what worktreesDir
// claims to be.
test('the test-context backstop refuses the real sweeper even when GLMPS_WORKTREES_DIR looks like a real, non-temp path', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-wsc-nospawn2-');
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir, GLMPS_WORKTREES_DIR: 'C:\\Users\\op\\definitely-not-a-temp-dir\\worktrees' });
  delete env.GLMPS_UNMERGED_SCAN;
  const h = await startServer({ port: 0, env });
  try {
    await h.sweepWorktreesTick();
    assert.ok(adapterHealth()['sweep-worktrees-test-guard']?.misses >= 1, 'a non-temp-looking GLMPS_WORKTREES_DIR must not bypass the backstop');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// round 2's backstop read ONLY the injected env's
// NODE_TEST_CONTEXT. About 17 real server-booting test files (api-graph,
// api-alerts-ack, api-coverage-alerts, api-wiki, codex-parity,
// copilot-otel-tail, gap-suppression-server-sites, memory-endpoint,
// research-signal-persistence, server.integration, watch-loop-resilience,
// workspace-dirty-check, workspace-poll-tick, vitals-trends-store, and the
// mkEnv callers) build their env as a bare literal
// ({GLMPS_STATE_DIR: ..., ...}) rather than spreading process.env, so the
// ambient NODE_TEST_CONTEXT node --test itself sets never reached
// server.js's own `env` at all - round 2's check saw nothing and let the
// real sweep run. testRealGitWriteRefused checks the REAL process.env
// independently of whatever `env` the caller injects (that is exactly
// what closes this gap), so this reproduces that pattern directly.
test('C1: a bare env literal (the ~17-file pattern, never spreading process.env) still refuses the real sweeper', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-wsc-bareenv-');
  const claudeDir = tmp('mc-wsc-bareenv-claude-');
  // Deliberately NOT `{ ...process.env, ... }` - this is the exact shape
  // of the ~17 files named above.
  const env = { GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_MODEL_RUNNER: 'off' };
  const h = await startServer({ port: 0, env });
  try {
    await h.sweepWorktreesTick();
    assert.ok(adapterHealth()['sweep-worktrees-test-guard']?.misses >= 1, 'a bare-literal env must still be refused via the real process.env/argv signals');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

// the same predicate also guards
// createWorktree (the runner-launch path) and removeWorktree
// (reconcileNow's automatic reclaim) - round 2's backstop lived inside
// sweepWorktrees alone. Both are exercised here via createWorktreeForTest/
// removeWorktreeForTest (exposed on the handle for exactly this), against a
// target path that is never created anywhere on disk - safe regardless of
// whether the guard holds, since even a hypothetical failure would only
// make git fail against something that does not exist, never touch a real
// repo.
test('createWorktree refuses a real (non-existent, non-temp) target while running as a test process, reporting a named reason', async () => {
  resetAdapterHealth();
  const fakeRepo = path.join(os.homedir(), `mc-test-fake-repo-${Date.now()}`);
  assert.equal(fs.existsSync(fakeRepo), false, 'precondition: the target never exists on disk');
  const result = await realGuardSrv.createWorktreeForTest({ repo: fakeRepo, project: 'p', jobId: 'fake-job' });
  assert.equal(result, null, 'refused - the same null the caller already treats as "fall back to the shared repo cwd"');
  assert.ok(adapterHealth()['create-worktree-test-guard']?.misses >= 1, 'the refusal is reported with a named reason');
  assert.equal(fs.existsSync(fakeRepo), false, 'nothing was ever created at the target');
});

// the guard used to check REPO_ROOT alone and then
// let the sweep write to EVERY root gitRepoRoots() returned. If the checkout
// itself sits under os.tmpdir() (agent scratchpads do on this machine), that
// single check passed and the whole sweep ran against real repos. The check
// is now per root: each refused root is skipped, the refusal is reported once
// per instance, and only a root list that cannot be computed refuses the
// whole sweep. Both roots here are injected and the sweeper is a recorder, so
// no git runs anywhere; the non-temp root is never created on disk.
test('I1: the sweep guard is applied per root - only the temp-dir root reaches the sweeper', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-wsc-perroot-');
  const tmpRoot = tmp('mc-wsc-perroot-repo-');
  const realRoot = path.join(os.homedir(), `mc-test-not-a-repo-${Date.now()}`);
  assert.equal(fs.existsSync(realRoot), false, 'precondition: the non-temp root never exists on disk');
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir });
  delete env.GLMPS_UNMERGED_SCAN;
  const seen = [];
  const h = await startServer({
    port: 0, env,
    gitRepoRootsFn: () => [{ project: 'tmp-repo', path: tmpRoot }, { project: 'real-repo', path: realRoot }],
    sweepSessionWorktreesFn: async ({ repo }) => { seen.push(repo); return { removed: [], kept: [] }; },
  });
  try {
    // Same in-flight race as the retained-ids test above: poll until one
    // tick actually runs (a tick that lands while the boot sweep is in
    // flight is a silent no-op).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.length) {
      await h.sweepWorktreesTick();
      if (!seen.length) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(seen.length >= 1, 'the temp-dir root reached the sweeper');
    assert.deepEqual([...new Set(seen)], [tmpRoot], 'only the temp-dir root is ever passed to the sweeper');
    await h.sweepWorktreesTick();
    assert.equal(adapterHealth()['sweep-worktrees-test-guard']?.misses, 1, 'the per-root refusal is reported exactly once per instance');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('I1: a root list that cannot be computed refuses the whole sweep with a named reason', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-wsc-noroots-');
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir });
  delete env.GLMPS_UNMERGED_SCAN;
  let called = false;
  const h = await startServer({
    port: 0, env,
    gitRepoRootsFn: () => { throw new Error('boom: roots unavailable'); },
    sweepSessionWorktreesFn: async () => { called = true; return { removed: [], kept: [] }; },
  });
  try {
    await h.sweepWorktreesTick();
    assert.equal(called, false, 'no root may reach the sweeper when the list itself failed');
    assert.ok(adapterHealth()['sweep-worktrees-roots']?.misses >= 1, 'the failure is reported with a named reason');
    assert.match(adapterHealth()['sweep-worktrees-roots'].lastReason, /boom: roots unavailable/);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// when createWorktree refuses under the guard, the
// launch used to fall back to cwd = the real repo, so a test process could
// still launch an agent INTO a real checkout. It must refuse the launch with a
// named reason instead. The repo here is this checkout (REPO_ROOT, which
// repoForProject always resolves by basename); GLMPS_RUNNER_DRYRUN means the
// launch never spawns anything, and createWorktree's own guard (the
// createWorktree test above) keeps git away from REPO_ROOT.
test('M4: a launch whose worktree is refused by the test-write guard is refused, never run in the real repo', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-wsc-launch-');
  const worktreesDir = tmp('mc-wsc-launch-wts-');
  const env = isolatedEnv({ GLMPS_STATE_DIR: stateDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off', GLMPS_WORKTREES_DIR: worktreesDir });
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (p, o) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    return { status: r.status, body: await r.json() };
  };
  try {
    await post('/api/runner/config', { enabled: false, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'm4 guard', prompt: 'x', project: path.basename(REPO_ROOT) });
    const res = await post(`/api/runner/run/${encodeURIComponent(card.id)}`, {});
    assert.equal(h.lastDryRunLaunch(), null, 'nothing was launched at all, least of all into the real repo');
    assert.equal(res.status, 409, `refused with a named reason, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body.reason, /test process/);
    assert.ok(adapterHealth()['launch-job-test-guard']?.misses >= 1, 'the refusal is reported with a named reason');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(worktreesDir, { recursive: true, force: true });
  }
});

test('removeWorktree refuses a real (non-existent, non-temp) target while running as a test process, reporting a named reason', async () => {
  resetAdapterHealth();
  const fakeRepo = path.join(os.homedir(), `mc-test-fake-repo-${Date.now()}`);
  const fakeDir = path.join(fakeRepo, 'worktree');
  const ok = await realGuardSrv.removeWorktreeForTest({ repo: fakeRepo, dir: fakeDir });
  assert.equal(ok, false, 'refused - the same false the caller already treats as "reclaim failed"');
  assert.ok(adapterHealth()['remove-worktree-test-guard']?.misses >= 1, 'the refusal is reported with a named reason');
});
