import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHealthz, readBootVersion, createEventLoopDelayMonitor } from '../lib/kernel/healthz.js';
import { startServer } from '../server.js';

// Full isolation set (server/test/adapter-health-state.test.js) plus
// GLMPS_UNMERGED_SCAN: 'off' (cross-plan finding F-24): GLMPS_STATE_DIR alone lets
// a startServer() test fall through to the operator's real ~/.claude and
// ~/.glmps state for every dir this does not override.
function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-healthz-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    ...process.env,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
}

let sharedSrv;

before(async () => {
  sharedSrv = await startServer({ port: 0, env: mkEnv(), pollMs: 100000, restartFn: () => {} });
});

after(async () => {
  await sharedSrv?.close();
});

test('up with every field; degraded at three consecutive failures', () => {
  const body = buildHealthz({ version: '0.1.0+abc1234', bootTs: 1000, now: () => 61_000, loops: { wiki: { lastOutcome: 'done', lastRunTs: 51_000, consecutiveFailures: 0 } }, openObligations: 2, lastEventTs: 60_000 });
  assert.deepEqual(body, { status: 'up', version: '0.1.0+abc1234', uptime_s: 60, open_obligations: 2, last_event_ts: 60_000,
    loops: { wiki: { lastOutcome: 'done', ageS: 10, consecutiveFailures: 0 } } });
  const bad = buildHealthz({ version: 'v', bootTs: 0, now: () => 1, loops: { wiki: { lastOutcome: 'failed:x', lastRunTs: 0, consecutiveFailures: 3 } }, openObligations: null, lastEventTs: null });
  assert.equal(bad.status, 'degraded');
  assert.equal(bad.loops.wiki.ageS, 0);
});

// Scan 2026-10-15 F7: the view an unauthenticated remote caller gets.
test('F7: the undetailed view drops failure text, version, ages, obligations and event time', () => {
  const loops = { gepa: { lastOutcome: 'failed:Traceback C:/Users/op/x.py', lastRunTs: 0, consecutiveFailures: 3 }, wiki: { lastOutcome: 'done', lastRunTs: 0, consecutiveFailures: 0 }, idle: { lastOutcome: null, lastRunTs: null, consecutiveFailures: 0 } };
  const b = buildHealthz({ version: '0.1.0+abc1234', bootTs: 0, now: () => 5000, loops, openObligations: 2, lastEventTs: 9, detailed: false });
  assert.deepEqual(b, { status: 'degraded', uptime_s: 5, loops: {
    gepa: { lastOutcome: 'failed', consecutiveFailures: 3 }, wiki: { lastOutcome: 'done', consecutiveFailures: 0 }, idle: { lastOutcome: null, consecutiveFailures: 0 } } });
  assert.ok(!JSON.stringify(b).includes('Users'));
  assert.equal(buildHealthz({ version: 'v', bootTs: 0, now: () => 1, loops }).loops.gepa.lastOutcome.startsWith('failed:Traceback'), true, 'detailed by default');
});

test('kernel start and shell pickup fields show in the detailed view only', () => {
  const kernel = { last_start: { reason: 'deploy', at: '2026-10-24T23:28:00.000Z' }, starts_24h: { deploy: 4 }, shell: { last_poll_s: 2 } };
  const d = buildHealthz({ version: 'v', bootTs: 0, now: () => 1000, loops: {}, kernel });
  assert.deepEqual([d.last_start, d.starts_24h, d.shell], [kernel.last_start, kernel.starts_24h, kernel.shell]);
  const r = buildHealthz({ version: 'v', bootTs: 0, now: () => 1000, loops: {}, kernel, detailed: false });
  assert.deepEqual(r, { status: 'up', uptime_s: 1, loops: {} });
});

test('a loop that never ran has a null age', () => {
  assert.equal(buildHealthz({ version: 'v', bootTs: 0, now: () => 1, loops: { x: { lastOutcome: null, lastRunTs: null, consecutiveFailures: 0 } } }).loops.x.ageS, null);
});

test('readBootVersion appends the short HEAD sha, or unknown when git fails', async () => {
  const ok = (file, args, opts, cb) => cb(null, 'abc1234def\n');
  const bad = (file, args, opts, cb) => cb(new Error('not a repo'));
  assert.equal(await readBootVersion({ repoRoot: '/r', pkgVersion: '0.1.0', execFileImpl: ok }), '0.1.0+abc1234');
  assert.equal(await readBootVersion({ repoRoot: '/r', pkgVersion: '0.1.0', execFileImpl: bad }), '0.1.0+unknown');
});

// glmps-2-0-59: the kernel bundled in the installer has no .git, so its commit
// comes from the bundle.json the stage step wrote; git is never asked.
test('readBootVersion takes the commit from bundle.json when the kernel runs from an installer bundle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bundle-ver-'));
  try {
    fs.writeFileSync(path.join(dir, 'bundle.json'), JSON.stringify({ node: 'v26.10.0', commit: '94d4165', builtAt: '2026-10-18T00:00:00.000Z' }));
    let gitCalls = 0;
    const git = (file, args, opts, cb) => { gitCalls++; cb(new Error('no git')); };
    assert.equal(await readBootVersion({ repoRoot: dir, pkgVersion: '0.1.0', execFileImpl: git }), '0.1.0+94d4165');
    assert.equal(gitCalls, 0);
    fs.writeFileSync(path.join(dir, 'bundle.json'), '{not json');
    assert.equal(await readBootVersion({ repoRoot: dir, pkgVersion: '0.1.0', execFileImpl: git }), '0.1.0+unknown');
    assert.equal(gitCalls, 1, 'an unreadable bundle.json falls back to git');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// a git failure at boot used to be swallowed into
// '+unknown' with no trace of why -- the one time an operator actually needs
// to know (a broken checkout, git missing from PATH), nothing said so. This
// is the kernel's one boot-time git call, so "once" falls out of the callback
// firing exactly once; readBootVersion itself never repeats it.
test('readBootVersion logs the git failure reason once at boot; a success logs nothing', async () => {
  const bad = (file, args, opts, cb) => cb(new Error('not a repo'));
  const badLogs = [];
  await readBootVersion({ repoRoot: '/r', pkgVersion: '0.1.0', execFileImpl: bad, log: (m) => badLogs.push(m) });
  assert.equal(badLogs.length, 1, 'the git failure reason is logged exactly once');
  assert.match(badLogs[0], /not a repo/);

  const ok = (file, args, opts, cb) => cb(null, 'abc1234def\n');
  const okLogs = [];
  await readBootVersion({ repoRoot: '/r', pkgVersion: '0.1.0', execFileImpl: ok, log: (m) => okLogs.push(m) });
  assert.deepEqual(okLogs, [], 'a successful git read logs nothing');
});

test('GET /healthz answers 200 from memory with every field; open_obligations is a live count from Task 11 on', async () => {
  const r = await fetch(`http://127.0.0.1:${sharedSrv.port}/healthz`);
  assert.equal(r.status, 200);
  const b = await r.json();
  for (const k of ['status', 'version', 'uptime_s', 'open_obligations', 'last_event_ts', 'loops']) assert.ok(k in b, k);
  assert.match(b.version, /^\d+\.\d+\.\d+\+([0-9a-f]{7}|unknown)$/);
  // the obligations store is open by now, so this is a
  // live obligationStore.countOpen() - at least 1, from the kernel's own
  // 'nightly-run' loop (registered at boot, sla.obligation not opted
  // out), which opens a standing loop.freshness row; the
  // obligation-sweeper loop itself opts out (sla.obligation: false).
  // >=1 rather than an exact 1: a future
  // loop registered at boot without opting out would legitimately raise
  // this count, and that is not a regression this test should fail on.
  assert.ok(b.open_obligations >= 1, `expected at least one standing obligation at boot, got ${b.open_obligations}`);
});

test('GET /healthz reports open_obligations null when the obligations store failed to open', async () => {
  // node:sqlite is guaranteed on this Node floor (D22, >=22.13), so the
  // realistic way the store fails to open is a bad dbFile path: pre-create
  // <stateDir>/kernel.db as a DIRECTORY (ensureStateDirs itself only touches
  // its own subdirectories, never this path, so boot up to this point is
  // unaffected) - DatabaseSync then throws opening a directory as a db file.
  const env = mkEnv();
  const stateDir = env.GLMPS_STATE_DIR;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'kernel.db'));
  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {} });
  try {
    const b = await (await fetch(`http://127.0.0.1:${srv.port}/healthz`)).json();
    assert.equal(b.open_obligations, null);
  } finally { await srv.close(); }
});

// buildHealthz's own unit test above pins the 3-failure
// threshold in isolation; this pins the same boundary end to end, through the
// live route and the real loop registry, so a wiring mismatch between the two
// (e.g. the route passing the wrong field) would show up here even if the
// unit test still passed.
test('GET /healthz stays "up" through 2 consecutive loop failures; the 3rd degrades it', async () => {
  sharedSrv.loopRegistry.registerLoop({
    name: 'flaky', trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false },
  });
  const getStatus = async () => (await (await fetch(`http://127.0.0.1:${sharedSrv.port}/healthz`)).json()).status;
  try {
    sharedSrv.loopRegistry.report('flaky', { outcome: 'failed', reason: 'x' });
    sharedSrv.loopRegistry.report('flaky', { outcome: 'failed', reason: 'x' });
    assert.equal(await getStatus(), 'up', 'two consecutive failures do not degrade the kernel');
    sharedSrv.loopRegistry.report('flaky', { outcome: 'failed', reason: 'x' });
    assert.equal(await getStatus(), 'degraded', 'the third consecutive failure degrades it');
  } finally {
    sharedSrv.loopRegistry.report('flaky', { outcome: 'done' });
  }
});

// glmps-2-0-runtime-10 (triage glmps-189): the event-loop stall that slowed
// the git remote feed was only inferred from probe latency; /healthz now
// reports it directly.
test('event-loop delay: detailed view carries p50/p99/max, the undetailed view does not', () => {
  const d = { p50: 1.2, p99: 40.5, max: 700, window_s: 12 };
  const body = buildHealthz({ version: 'v', bootTs: 0, now: () => 1000, eventLoopDelay: d });
  assert.deepEqual(body.event_loop_delay_ms, d);
  assert.equal('event_loop_delay_ms' in buildHealthz({ version: 'v', bootTs: 0, now: () => 1000, eventLoopDelay: d, detailed: false }), false);
});

test('createEventLoopDelayMonitor reports ms from the histogram and resets after its window', () => {
  let t = 0; let resets = 0;
  const h = { enable() {}, disable() {}, reset() { resets++; }, percentile: (p) => (p === 50 ? 2e6 : 9e7), max: 1.5e9, count: 10 };
  const m = createEventLoopDelayMonitor({ windowMs: 60_000, now: () => t, histogram: h });
  t = 30_000;
  assert.deepEqual(m.read(), { p50: 2, p99: 90, max: 1500, window_s: 30 });
  assert.equal(resets, 0, 'no reset inside the window');
  t = 61_000; m.read();
  assert.equal(resets, 1, 'the first read after the window starts a fresh one');
  t = 70_000;
  assert.equal(m.read().window_s, 9);
  m.stop();
});

test('GET /healthz reports live event-loop delay fields', async () => {
  const b = await (await fetch(`http://127.0.0.1:${sharedSrv.port}/healthz`)).json();
  for (const k of ['p50', 'p99', 'max', 'window_s']) assert.equal(typeof b.event_loop_delay_ms?.[k], 'number', k);
  assert.ok(b.event_loop_delay_ms.max >= b.event_loop_delay_ms.p50);
});
