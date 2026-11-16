// End-to-end drive of graphify's auto-upgrade (card glmps-2-0-runtime-144).
// The upgrade failed four different ways in four days (glmps#242,
// #301, #305, #307); each fix faked one seam on its own. Here one stateful fake
// machine stands behind every seam at once: uv's tool receipt with its exact-
// pin behaviour, the installed version, a launcher list that shows every
// running update, and a graph.json that whichever version is installed
// rewrites (refusing a collapse, as graphify's own guard does). Two server
// instances share one state dir, so a restart is a real restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { DEP_MANIFEST } from '../lib/chassis/deps.js';
import { collectAlerts } from '../lib/observability/alert-sources.js';
import { compareVersions } from '../lib/observability/graphify-version.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const REQUIRED_COMMANDS = ['query', 'explain', 'path', 'update', 'watch', 'affected', 'install'];
const PASSING_HELP = REQUIRED_COMMANDS.map((c) => `  ${c} "<x>"`).join('\n');
const norm = (p) => path.resolve(p).toLowerCase();
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

function mkWorkspace() {
  const base = fs.mkdtempSync(path.join(tmpRoot(), 'mc-gue-')); tmpDirs.push(base);
  const claudeDir = path.join(base, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'proj');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'ag', 'brain'), { recursive: true });
  const roots = [path.join(base, 'kernel'), path.join(base, 'planning')];
  const sessions = roots.map((root, i) => {
    fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: Array.from({ length: 50 }, (_, n) => ({ id: `n${n}` })), links: [] }));
    execFileSync('git', ['init', '-q', root], { windowsHide: true });
    const transcript = path.join(projDir, `s${i}.jsonl`);
    fs.writeFileSync(transcript, '');
    return { sessionId: `s${i}`, ppid: process.pid, cwd: root, transcriptPath: transcript, ts: Date.now() };
  });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify(sessions));
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ graph: { machine: { enabled: true, include: roots } } }));
  const env = {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(base, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vs'), GLMPS_AGY_CLI_DIR: path.join(base, 'agy'),
    GLMPS_CODEX_DIR: path.join(base, 'cx'), GLMPS_HERMES_DIR: path.join(base, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'),
    GLMPS_OPENCODE_DIR: path.join(base, 'oc'), GLMPS_UNMERGED_SCAN: 'off',
  };
  return { env, configFile, roots };
}

// uv as observed on uv 0.11.19: `uv tool install graphifyy==X` installs X and
// pins it in the receipt; `uv tool upgrade graphifyy` honours that pin (exit 0,
// nothing moves); `uv tool install graphifyy@latest` installs the latest and
// drops the pin. uv cannot replace the tool exe while a launcher runs it
// (Windows os error 32).
function fakeMachine({ installed, latest, nodesFor }) {
  const m = { installed, pin: installed, latest, running: new Map(), holds: new Map(), uv: [], updates: [], onUpgrade: null };
  m.runCmd = async (bin, args) => {
    if (bin === 'uvx') return ok(PASSING_HELP);
    if (bin !== 'uv') return ok();
    m.uv.push(args.join(' '));
    if (m.running.size) return { code: 2, stdout: '', stderr: 'error: failed to remove graphify.exe: The process cannot access the file because it is being used by another process. (os error 32)' };
    const [tool, verb, ...rest] = args;
    if (tool !== 'tool') return { code: 2, stdout: '', stderr: 'unknown' };
    const spec = rest.filter((a) => !a.startsWith('--')).pop() ?? '';
    if (verb === 'upgrade') {
      if (!m.pin) m.installed = m.latest;
      return ok();
    }
    if (verb === 'install') {
      const exact = spec.match(/^graphifyy==(.+)$/);
      if (exact) { m.installed = exact[1]; m.pin = exact[1]; }
      else if (spec === 'graphifyy@latest') { m.installed = m.latest; m.pin = null; }
      else if (spec === 'graphifyy' && !m.installed) m.installed = m.latest;
      if (rest.includes('--upgrade') && exact) m.onUpgrade?.();
      return ok();
    }
    return { code: 2, stdout: '', stderr: `unknown verb ${verb}` };
  };
  m.version = async () => m.installed;
  m.latestVersion = async () => m.latest;
  m.list = async () => [...m.running.values()].map((pid) => ({ image: 'graphify.exe', pid }));
  let pid = 1000;
  m.spawn = async (root) => {
    const key = norm(root);
    m.running.set(key, pid++);
    m.updates.push({ root: key, version: m.installed });
    try {
      const hold = m.holds.get(key);
      if (hold) { const r = await hold; if (r) return r; }
      const gp = path.join(root, 'graphify-out', 'graph.json');
      if (!fs.existsSync(gp)) return ok('No code-graph topology changes detected');
      const existing = JSON.parse(fs.readFileSync(gp, 'utf8')).nodes.length;
      const n = nodesFor(m.installed, existing);
      if (n < existing * 0.5) return { code: 1, stdout: `Refusing to overwrite existing graph: new graph has ${n} nodes but existing graph.json has ${existing}`, stderr: '' };
      // An unchanged graph is a no-op, in the wording each version prints
      // (0.9.102 changed it, and the live audit read that as a failure).
      if (n === existing) {
        return ok(compareVersions(m.installed, '0.9.102') >= 0
          ? '[graphify watch] Incremental: none of the 59 scanned files differ from the last build.\n[graphify watch] No tracked code files in change set - skipping rebuild.\n'
          : '[graphify watch] No code-graph topology changes detected; outputs left untouched.\n');
      }
      fs.writeFileSync(gp, JSON.stringify({ nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}` })), links: [] }));
      return ok(`Rebuilt: ${n} nodes`);
    } finally { m.running.delete(key); }
  };
  return m;
}

function hold(m, root) {
  let release;
  m.holds.set(norm(root), new Promise((r) => { release = (v) => { m.holds.delete(norm(root)); r(v); }; }));
  return (v) => release(v);
}

const statePath = (env, f) => path.join(env.GLMPS_STATE_DIR, 'state', f);
const health = (env) => JSON.parse(fs.readFileSync(statePath(env, 'graph-sync-health.json'), 'utf8'));
const marker = (env) => statePath(env, 'graphify-pending-rollback.json');
const graphifyAlerts = (env) => collectAlerts({ graphSyncHealth: health(env) })
  .filter((a) => a.source === 'graph-sync' && /graphify@/.test(JSON.stringify(a)));

function boot(ws, m, extra = {}) {
  return startServer({
    port: 0, pollMs: 100000, env: ws.env, configFile: ws.configFile,
    spawnGraphifyUpdate: (root) => m.spawn(root),
    graphifyVersionOverrides: {
      runCmd: m.runCmd, graphifyVersion: m.version, latestGraphifyVersion: m.latestVersion,
      listGraphifyProcesses: m.list,
      processWaitOpts: { maxWaitMs: 50, pollMs: 1, sleep: () => new Promise((r) => setImmediate(r)) },
      ...extra,
    },
  });
}

test('graphify upgrade end to end: busy root, audit pass, regression rollback, restart mid-audit, superseded alerts clear', async () => {
  const ws = mkWorkspace();
  const [kernel] = ws.roots;
  // 0.9.101 writes a quarter of the graph (graphify itself refuses it);
  // every other version rebuilds the same 50 nodes.
  const m = fakeMachine({ installed: '0.9.99', latest: '0.9.100', nodesFor: (v, existing) => (v === '0.9.101' ? Math.floor(existing / 4) : existing) });

  // 1. Busy root: the post-deploy rebuild holds the kernel root for minutes
  //    (#305), its launcher already gone from the process list. The tick
  //    waits it out on a fake clock, then upgrades, audits and adopts.
  let clock = 0;
  const releaseRebuild = hold(m, kernel);
  const srv1 = await boot(ws, m, {
    waitOpts: { now: () => clock, pollMs: 1000, sleep: async (ms) => { clock += ms * 30; if (clock >= 180_000) releaseRebuild(); await new Promise((r) => setImmediate(r)); } },
  });
  const rebuild = srv1.graphifyUpdate(kernel, {});
  m.running.delete(norm(kernel));
  try {
    await srv1.graphifyVersionTick();
    releaseRebuild();
    await rebuild;
    assert.equal(m.installed, '0.9.100');
    assert.equal(health(ws.env)['graphify@0.9.100'].outcome, 'updated', JSON.stringify(health(ws.env)['graphify@0.9.100']));
    assert.equal(fs.existsSync(marker(ws.env)), false);
  } finally { releaseRebuild?.(); await srv1.close(); }

  // 2. Regression: 0.9.101's rebuild is refused, so it is rolled back to the
  //    version the audit last passed, by exact pin.
  m.latest = '0.9.101';
  const srv2 = await boot(ws, m);
  try {
    await srv2.graphifyVersionTick();
    assert.equal(m.installed, '0.9.100');
    assert.equal(m.uv.at(-1), 'tool install graphifyy==0.9.100');
    assert.equal(health(ws.env)['graphify@0.9.101'].outcome, 'failed');
    assert.match(health(ws.env)['graphify@0.9.101'].reason, /rolled back to 0\.9\.100/);
    assert.equal(fs.existsSync(marker(ws.env)), false);
  } finally { await srv2.close(); }

  // 3. Restart mid-audit (#307): 0.9.102 lands under the rollback's pin (#301),
  //    the service stops while the kernel root rebuilds and the update is
  //    killed. The next boot resumes the audit and adopts, with no rollback.
  m.latest = '0.9.102';
  const releaseKilled = hold(m, kernel);
  let srvA; let closing;
  srvA = await boot(ws, m);
  const spawnA = m.spawn;
  m.spawn = async (root) => {
    if (norm(root) === norm(kernel) && !closing) { closing = srvA.close(); queueMicrotask(() => releaseKilled({ code: null, stdout: '', stderr: 'killed: service stopping' })); }
    return spawnA(root);
  };
  await srvA.graphifyVersionTick();
  await closing;
  m.spawn = spawnA;
  assert.equal(m.installed, '0.9.102', 'the shutdown must not roll the candidate back unchecked');
  assert.ok(fs.existsSync(marker(ws.env)), 'the interrupted audit leaves its marker for the next boot');

  const uvBefore = m.uv.length;
  const srvB = await boot(ws, m);
  try {
    await srvB.graphifyVersionTick();
    assert.equal(m.installed, '0.9.102');
    assert.deepEqual(m.uv.slice(uvBefore), [], 'the resumed audit needs no install and no rollback');
    assert.equal(health(ws.env)['graphify@0.9.102'].outcome, 'updated');
    assert.match(health(ws.env)['graphify@0.9.102'].reason, /audit resumed after a restart/);
    assert.equal(fs.existsSync(marker(ws.env)), false);
    // Cleared by the adoption itself, not a day later by the next tick.
    assert.deepEqual(graphifyAlerts(ws.env).map((a) => a.title), []);
  } finally { await srvB.close(); }

  // 4. A later boot finds nothing to do and keeps the adopted version, and no
  //    failure recorded for a superseded version is still an alert.
  const srvC = await boot(ws, m);
  try {
    const uvC = m.uv.length;
    await srvC.graphifyVersionTick();
    assert.equal(m.installed, '0.9.102');
    assert.equal(m.uv.length, uvC);
    assert.deepEqual(graphifyAlerts(ws.env).map((a) => a.title), [], JSON.stringify(health(ws.env), null, 1));
    assert.match(health(ws.env)['graphify@0.9.101'].reason, /superseded by 0\.9\.102/);
  } finally { await srvC.close(); }
});

// 11-03 4:27-4:50 PM PT, live: the boot rebuild of the kernel root ran ~23
// minutes. Its launcher left the process list at the 600 s spawn timeout while
// the rebuild kept the root held, so "no graphify running" passed, 0.9.102 was
// installed, and the audit gave up on the busy root and rolled it back.
test('a boot rebuild that outlives its launcher is waited out before the upgrade, not rolled back', async () => {
  const ws = mkWorkspace();
  const [kernel] = ws.roots;
  const m = fakeMachine({ installed: '0.9.99', latest: '0.9.102', nodesFor: (v, existing) => existing });
  let clock = 0;
  const release = hold(m, kernel);
  const srv = await boot(ws, m, {
    waitOpts: { now: () => clock, sleep: async (ms) => { clock += ms; if (clock >= 23 * 60_000) release(); await new Promise((r) => setImmediate(r)); } },
  });
  const bootRebuild = srv.graphifyUpdate(kernel, {});
  m.running.delete(norm(kernel)); // launcher killed at its timeout; the rebuild runs on
  try {
    await srv.graphifyVersionTick();
    release();
    await bootRebuild;
    assert.ok(!m.uv.includes('tool install graphifyy==0.9.99'), `no rollback expected: ${JSON.stringify(m.uv)} ${JSON.stringify(health(ws.env)['graphify@0.9.102'])}`);
    assert.equal(m.installed, '0.9.102');
    assert.equal(health(ws.env)['graphify@0.9.102'].outcome, 'updated');
    assert.ok(m.updates.some((u) => u.root === norm(kernel) && u.version === '0.9.102'), 'the audit rebuilt the kernel root under the candidate');
  } finally { release(); await srv.close(); }
});

test('while the audit holds its roots, another caller for them is refused as busy', async () => {
  const ws = mkWorkspace();
  const [kernel] = ws.roots;
  const m = fakeMachine({ installed: '0.9.99', latest: '0.9.102', nodesFor: (v, existing) => existing });
  let srv;
  let refused = null;
  m.onUpgrade = () => { srv.graphifyUpdate(kernel, {}).then(() => { refused = false; }, (e) => { refused = e.code; }); };
  srv = await boot(ws, m);
  try {
    await srv.graphifyVersionTick();
    assert.equal(refused, 'graphify-busy');
    assert.equal(health(ws.env)['graphify@0.9.102'].outcome, 'updated');
    assert.equal((await srv.graphifyUpdate(kernel, {})).code, 0, 'the reservation is released when the tick ends');
  } finally { await srv.close(); }
});

test('a failure for the version still being offered stays an alert; only older ones are superseded', async () => {
  const ws = mkWorkspace();
  const m = fakeMachine({ installed: '0.9.99', latest: '0.9.100', nodesFor: (v, existing) => existing });
  m.running.set('launcher', 1); // a launcher that never exits: the upgrade cannot land
  const srv = await boot(ws, m);
  try {
    await srv.graphifyVersionTick();
    m.running.clear();
    // The 0.9.100 upgrade exits 0 but does not move (an outside pin), twice.
    const real = m.runCmd;
    m.runCmd = async (bin, args) => (bin === 'uv' && args.includes('--upgrade') ? ok() : real(bin, args));
    const srv2 = await boot(ws, m);
    try { await srv2.graphifyVersionTick(); } finally { await srv2.close(); }
    assert.equal(health(ws.env)['graphify@0.9.100'].outcome, 'failed');
    assert.equal(graphifyAlerts(ws.env).length, 1, 'the live failure for the offered version still alerts');
    m.runCmd = real;
    m.latest = '0.9.101';
    const srv3 = await boot(ws, m);
    try { await srv3.graphifyVersionTick(); } finally { await srv3.close(); }
    assert.equal(m.installed, '0.9.101');
    assert.equal(health(ws.env)['graphify@0.9.100'].outcome, 'noop');
    assert.match(health(ws.env)['graphify@0.9.100'].reason, /superseded by 0\.9\.101/);
    assert.equal(graphifyAlerts(ws.env).length, 0);
  } finally { await srv.close(); }
});

test('an abandoned pending rollback stays an alert on the tick that records it, though a newer version exists', async () => {
  const ws = mkWorkspace();
  const m = fakeMachine({ installed: '0.9.103', latest: '0.9.103', nodesFor: (v, existing) => existing });
  fs.mkdirSync(path.dirname(marker(ws.env)), { recursive: true });
  fs.writeFileSync(marker(ws.env), JSON.stringify({ prior: '0.9.100', candidate: '0.9.101', ts: 1 }));
  const srv = await boot(ws, m);
  try {
    await srv.graphifyVersionTick();
    assert.equal(health(ws.env)['graphify@0.9.101'].outcome, 'failed');
    assert.match(health(ws.env)['graphify@0.9.101'].reason, /abandoned/);
  } finally { await srv.close(); }
});

test('a deferred upgrade does not overwrite a standing failure for the same version', async () => {
  const ws = mkWorkspace();
  const m = fakeMachine({ installed: '0.9.100', latest: '0.9.101', nodesFor: (v, existing) => (v === '0.9.101' ? 1 : existing) });
  const srv = await boot(ws, m);
  try { await srv.graphifyVersionTick(); } finally { await srv.close(); }
  assert.equal(health(ws.env)['graphify@0.9.101'].outcome, 'failed');
  m.running.set('launcher', 1);
  const srv2 = await boot(ws, m);
  try { await srv2.graphifyVersionTick(); } finally { await srv2.close(); }
  assert.equal(health(ws.env)['graphify@0.9.101'].outcome, 'failed', 'the regression alert must survive a deferral');
  assert.equal(m.installed, '0.9.100');
});

test('the setup wizard update command moves graphify past an exact pin a rollback left', async () => {
  const m = fakeMachine({ installed: '0.9.99', latest: '0.9.102', nodesFor: (v, e) => e });
  const graphify = DEP_MANIFEST.find((d) => d.name === 'graphify');
  const [bin, ...args] = graphify.update;
  const res = await m.runCmd(bin, args);
  assert.equal(res.code, 0);
  assert.equal(m.installed, '0.9.102', `\`${graphify.update.join(' ')}\` left graphify on ${m.installed}`);
});

// The setup wizard updates graphify with `uv tool install graphifyy@latest`,
// which also reinstalls a version the audit already rolled back. With installed
// equal to latest and no marker, the tick returned early and kept it unchecked.
test('a version the audit rejected, reinstalled by the setup wizard, is rolled back and re-audited', async () => {
  const ws = mkWorkspace();
  const m = fakeMachine({ installed: '0.9.100', latest: '0.9.101', nodesFor: (v, existing) => (v === '0.9.101' ? Math.floor(existing / 4) : existing) });
  const srv1 = await boot(ws, m);
  try {
    await srv1.graphifyVersionTick();
    assert.equal(m.installed, '0.9.100');
    assert.match(health(ws.env)['graphify@0.9.101'].reason, /rolled back to 0\.9\.100/);
  } finally { await srv1.close(); }

  const wizard = DEP_MANIFEST.find((d) => d.name === 'graphify').update;
  await m.runCmd(wizard[0], wizard.slice(1));
  assert.equal(m.installed, '0.9.101');

  const srv2 = await boot(ws, m);
  try {
    await srv2.graphifyVersionTick();
    assert.equal(m.installed, '0.9.100', 'a rejected version must not stay installed unchecked');
    assert.equal(m.uv.at(-1), 'tool install graphifyy==0.9.100');
    assert.equal(health(ws.env)['graphify@0.9.101'].outcome, 'failed');
    assert.match(health(ws.env)['graphify@0.9.101'].reason, /reinstalled outside the version tick/);
  } finally { await srv2.close(); }

  // The next tick audits it from scratch, like any offered version.
  const srv3 = await boot(ws, m);
  try {
    const updates = m.updates.length;
    await srv3.graphifyVersionTick();
    assert.ok(m.updates.slice(updates).some((u) => u.version === '0.9.101'), 'the candidate is rebuilt in a fresh audit');
    assert.equal(m.installed, '0.9.100');
    assert.match(health(ws.env)['graphify@0.9.101'].reason, /rebuild audit failed, rolled back to 0\.9\.100/);
  } finally { await srv3.close(); }
});
