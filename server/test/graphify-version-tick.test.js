// server/test/graphify-version-tick.test.js
// graphifyVersionTick has no injection
// seam of its own -- calling srv.graphifyVersionTick() from a test would
// run a real uv/uvx/PyPI/graphify sequence (including a real `uv tool
// upgrade graphifyy` and `graphify install`). graphifyVersionOverrides
// covers the three real-process/network points the tick depends on
// (runCmd, the PyPI version lookup, the installed-version check); every
// default REFUSES under isTestProcess({ env }) when no override is given,
// mirroring spawnGraphifyUpdate's own guard (M2) exactly. Every test here
// injects the seam -- none ever reaches a real external process or network
// call, on purpose, even during a red check.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { listGraphifyProcesses } from '../lib/observability/graphify-toolchain.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot(), 'mc-gvt-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vs'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'),
           GLMPS_CODEX_DIR: path.join(tmp, 'cx'), GLMPS_HERMES_DIR: path.join(tmp, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'oc'), GLMPS_UNMERGED_SCAN: 'off', ...extra },
  };
}

// A graph-collectable env for the tests below: a real graphify-out/ under a
// fresh temp dir, discoverable via a fake active session's cwd (same
// convention as api-graph.test.js's R-M6 fixture) -- never the real repo.
function mkGraphRoot({ roots = 1 } = {}) {
  const base = fs.mkdtempSync(path.join(tmpRoot(), 'mc-gvt-root-')); tmpDirs.push(base);
  const claudeDir = path.join(base, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'proj');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'ag', 'brain'), { recursive: true });
  const sessions = [];
  const projectRoots = [];
  for (let i = 0; i < roots; i++) {
    const projectRoot = path.join(base, i === 0 ? 'project' : `project${i}`);
    projectRoots.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'a' }], links: [] }));
    const transcript = path.join(projDir, `sess${i + 1}.jsonl`);
    fs.writeFileSync(transcript, '');
    sessions.push({ sessionId: `sess${i + 1}`, ppid: process.pid, cwd: projectRoot, transcriptPath: transcript, ts: Date.now() });
  }
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify(sessions));
  // The version tick acts only on in-scope roots (card glmps-2-0-93): each
  // root is a real repo, opted in as a machine root.
  for (const r of projectRoots) execFileSync('git', ['init', '-q', r], { windowsHide: true });
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ graph: { machine: { enabled: true, include: projectRoots } } }));
  return {
    projectRoot: projectRoots[0],
    projectRoots,
    configFile,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(base, 'gt'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vs'), GLMPS_AGY_CLI_DIR: path.join(base, 'agy'),
           GLMPS_CODEX_DIR: path.join(base, 'cx'), GLMPS_HERMES_DIR: path.join(base, 'hm'), GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'),
           GLMPS_OPENCODE_DIR: path.join(base, 'oc'), GLMPS_UNMERGED_SCAN: 'off' },
  };
}

// Default config.graphifyUpdate.requiredCommands: a surface-audit-passing
// --help text for a happy-path uvx call.
const REQUIRED_COMMANDS = ['query', 'explain', 'path', 'update', 'watch', 'affected', 'install'];
const PASSING_HELP = REQUIRED_COMMANDS.map((c) => `  ${c} "<x>"`).join('\n');

async function waitTick() { await new Promise((r) => setImmediate(r)); }

// The installed-version check as a sequence: the first call sees the
// version before the upgrade, every later call (the post-upgrade re-read,
// fix round 5 item 1) sees the last one, i.e. an upgrade that landed.
// The upgrade is `uv tool install --upgrade graphifyy==<candidate>`; a
// rollback is a plain `uv tool install graphifyy==<prior>`.
const isUpgrade = (bin, args) => bin === 'uv' && args[0] === 'tool' && args[1] === 'install' && args[2] === '--upgrade';
const isRollback = (bin, args) => bin === 'uv' && args[0] === 'tool' && args[1] === 'install' && args[2] !== '--upgrade';

function installedVersions(...seq) {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)];
}

const healthFileOf = (env) => path.join(env.GLMPS_STATE_DIR, 'state', 'graph-sync-health.json');
const markerFileOf = (env) => path.join(env.GLMPS_STATE_DIR, 'state', 'graphify-pending-rollback.json');
const rejectedFileOf = (env) => path.join(env.GLMPS_STATE_DIR, 'state', 'graphify-rejected.json');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// graphify's own no-op line (graphify-outcome.js RE_NOOP): a clean exit-0
// update that leaves graph.json as it was, so the rebuild audit passes.
const NOOP_STDOUT = 'No code-graph topology changes detected';
const isDangerous = (bin, args) => (bin === 'uv' && args[0] === 'tool' && (args[1] === 'upgrade' || args[1] === 'install')) || (bin === 'graphify' && args[0] === 'install');

function setSkillStamps(home, stamps) {
  const dirs = { claude: path.join(home, '.claude', 'skills', 'graphify'), agents: path.join(home, '.agents', 'skills', 'graphify') };
  for (const d of Object.values(dirs)) fs.rmSync(d, { recursive: true, force: true });
  for (const [platform, version] of Object.entries(stamps)) {
    fs.mkdirSync(dirs[platform], { recursive: true });
    fs.writeFileSync(path.join(dirs[platform], 'SKILL.md'), '# graphify');
    fs.writeFileSync(path.join(dirs[platform], '.graphify_version'), `${version}\n`);
  }
  return home;
}

function mkSkillHome(stamps) {
  const home = fs.mkdtempSync(path.join(tmpRoot(), 'mc-gvt-home-')); tmpDirs.push(home);
  return setSkillStamps(home, stamps);
}
const skillInstalls = (calls) => calls.filter(([b, a]) => b === 'graphify' && a === 'install').map(c => c.slice(1).join(' '));

function makeTickRepeatable(srv) {
  for (const method of ['graphifyVersionTick', 'graphRebuildTick']) {
    const raw = srv[method];
    srv[method] = (...args) => {
      const realNow = Date.now;
      Date.now = () => Infinity;
      try { return raw(...args); }
      finally { Date.now = realNow; }
    };
  }
}

let sharedRoot;
let sharedSrv;
const sharedState = {
  spawnGraphifyUpdate: null,
  graphifyVersion: null,
  latestGraphifyVersion: null,
  runCmd: null,
  listGraphifyProcesses: null,
  integrationRunCmd: null,
  waitOpts: {},
  processWaitOpts: {},
};

let skillRoot;
let skillSrv;
let sharedSkillHome;
const skillState = {
  spawnGraphifyUpdate: null,
  graphifyVersion: null,
  latestGraphifyVersion: null,
  runCmd: null,
  listGraphifyProcesses: null,
  waitOpts: {},
  processWaitOpts: {},
};

function bindOverrides(state, { spawnGraphifyUpdate, graphifyVersionOverrides = {} } = {}) {
  state.spawnGraphifyUpdate = spawnGraphifyUpdate ?? (async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }));
  state.graphifyVersion = graphifyVersionOverrides.graphifyVersion ?? (async () => '0.9.0');
  state.latestGraphifyVersion = graphifyVersionOverrides.latestGraphifyVersion ?? (async () => '0.9.0');
  state.runCmd = graphifyVersionOverrides.runCmd ?? (async () => ({ code: 0, stdout: '', stderr: '' }));
  state.listGraphifyProcesses = graphifyVersionOverrides.listGraphifyProcesses ?? null;
  state.integrationRunCmd = graphifyVersionOverrides.integrationRunCmd ?? null;
  for (const k of Object.keys(state.waitOpts)) delete state.waitOpts[k];
  if (graphifyVersionOverrides.waitOpts) Object.assign(state.waitOpts, graphifyVersionOverrides.waitOpts);
  for (const k of Object.keys(state.processWaitOpts)) delete state.processWaitOpts[k];
  if (graphifyVersionOverrides.processWaitOpts) Object.assign(state.processWaitOpts, graphifyVersionOverrides.processWaitOpts);
}

function cleanRootDisk(root) {
  fs.rmSync(markerFileOf(root.env), { recursive: true, force: true });
  fs.rmSync(healthFileOf(root.env), { recursive: true, force: true });
  fs.rmSync(rejectedFileOf(root.env), { recursive: true, force: true });
  fs.writeFileSync(path.join(root.projectRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'a' }], links: [] }));
  for (const rel of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.claude', '.github']) {
    fs.rmSync(path.join(root.projectRoot, rel), { recursive: true, force: true });
  }
}

async function useSharedServer(opts = {}) {
  cleanRootDisk(sharedRoot);
  bindOverrides(sharedState, {
    graphifyVersionOverrides: {
      graphifyVersion: async () => '999.0.0',
      latestGraphifyVersion: async () => '999.0.0',
      runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  });
  await sharedSrv.graphifyVersionTick();
  fs.rmSync(healthFileOf(sharedRoot.env), { recursive: true, force: true });
  bindOverrides(sharedState, opts);
  return { srv: sharedSrv, env: sharedRoot.env, projectRoot: sharedRoot.projectRoot, configFile: sharedRoot.configFile };
}

async function useSkillServer({ stamps, ...opts } = {}) {
  cleanRootDisk(skillRoot);
  setSkillStamps(sharedSkillHome, { claude: '999.0.0', agents: '999.0.0' });
  bindOverrides(skillState, {
    graphifyVersionOverrides: {
      graphifyVersion: async () => '999.0.0',
      latestGraphifyVersion: async () => '999.0.0',
      runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  });
  await skillSrv.graphifyVersionTick();
  fs.rmSync(healthFileOf(skillRoot.env), { recursive: true, force: true });
  setSkillStamps(sharedSkillHome, stamps);
  bindOverrides(skillState, opts);
  return { srv: skillSrv, env: skillRoot.env, projectRoot: skillRoot.projectRoot, configFile: skillRoot.configFile, skillHome: sharedSkillHome };
}

before(async () => {
  sharedRoot = mkGraphRoot();
  bindOverrides(sharedState);
  sharedSrv = await startServer({
    port: 0, pollMs: 100000, env: sharedRoot.env, configFile: sharedRoot.configFile,
    spawnGraphifyUpdate: (...a) => sharedState.spawnGraphifyUpdate(...a),
    graphifyVersionOverrides: {
      graphifyVersion: (...a) => sharedState.graphifyVersion(...a),
      latestGraphifyVersion: (...a) => sharedState.latestGraphifyVersion(...a),
      runCmd: (...a) => sharedState.runCmd(...a),
      listGraphifyProcesses: (...a) => (sharedState.listGraphifyProcesses
        ? sharedState.listGraphifyProcesses(...a)
        : listGraphifyProcesses({ runCmd: (...ra) => sharedState.runCmd(...ra) })),
      integrationRunCmd: (...a) => (sharedState.integrationRunCmd
        ? sharedState.integrationRunCmd(...a)
        : Promise.resolve({ code: 0, stdout: '', stderr: '' })),
      waitOpts: sharedState.waitOpts,
      processWaitOpts: sharedState.processWaitOpts,
    },
  });
  makeTickRepeatable(sharedSrv);

  skillRoot = mkGraphRoot();
  sharedSkillHome = mkSkillHome({ claude: '999.0.0', agents: '999.0.0' });
  bindOverrides(skillState);
  skillSrv = await startServer({
    port: 0, pollMs: 100000, env: skillRoot.env, configFile: skillRoot.configFile,
    spawnGraphifyUpdate: (...a) => skillState.spawnGraphifyUpdate(...a),
    graphifyVersionOverrides: {
      skillHome: sharedSkillHome,
      graphifyVersion: (...a) => skillState.graphifyVersion(...a),
      latestGraphifyVersion: (...a) => skillState.latestGraphifyVersion(...a),
      runCmd: (...a) => skillState.runCmd(...a),
      listGraphifyProcesses: (...a) => (skillState.listGraphifyProcesses
        ? skillState.listGraphifyProcesses(...a)
        : listGraphifyProcesses({ runCmd: (...ra) => skillState.runCmd(...ra) })),
      waitOpts: skillState.waitOpts,
      processWaitOpts: skillState.processWaitOpts,
    },
  });
  makeTickRepeatable(skillSrv);
});

after(async () => {
  await skillSrv?.close();
  await sharedSrv?.close();
});

// waitForGraphifyUpdate's RESOLVED result
// was discarded -- only a THROWN error reached updateFailures. graphify's
// own collapse-refusal exits 1 and RESOLVES (graphify-outcome.js), so a
// refused update used to present as a clean pass with an unchanged
// graph.json, clearing auditRebuild's own ratio check and keeping the
// regressing version installed with no rollback.
test('a refused (not thrown) update result still forces the rollback decision, not a silent pass (N1)', async () => {
  const rollbackCalls = [];
  const { srv } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({
      code: 1,
      stdout: 'Refusing to overwrite existing graph: new graph has 5 nodes but existing graph.json has 50',
      stderr: '',
    }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (isRollback(bin, args)) rollbackCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  assert.equal(rollbackCalls.length, 1, `a refused update must still trigger the rollback, not a silent pass; calls: ${JSON.stringify(rollbackCalls)}`);
  assert.deepEqual(rollbackCalls[0], ['tool', 'install', 'graphifyy==0.9.0']);
});

// the rollback's own runCmd result was
// unchecked -- health said "rolled back to X" even when uv itself failed
// (plausible on Windows while another graphify process holds the tool
// exe), silently keeping the regressing version installed while claiming
// it had been fixed.
test('a failed rollback is recorded distinctly, never reported as a successful rollback (N3)', async () => {
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 1, stdout: 'Refusing to overwrite existing graph', stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (isRollback(bin, args)) return { code: 1, stdout: '', stderr: 'uv: tool exe locked by another process' };
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  const healthFile = path.join(env.GLMPS_STATE_DIR, 'state', 'graph-sync-health.json');
  const health = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  const entry = health['graphify@0.9.1'];
  assert.ok(entry, `expected a graphify@0.9.1 health entry, got: ${JSON.stringify(health)}`);
  assert.doesNotMatch(entry.reason, /^rebuild audit failed, rolled back to 0\.9\.0:/, 'must never claim a successful rollback when uv itself failed');
  assert.match(entry.reason, /rollback.*failed/i);
  assert.match(entry.reason, /tool exe locked/);
});

// close() landing mid-tick could still let
// an upgrade or a rollback install start AFTER shutdown had already begun,
// keeping the process alive past close() and mutating the operator's
// installed graphify version during exit.
test('a shutdown mid-tick skips the upgrade/install/rollback steps entirely (N4)', async () => {
  const { env, configFile } = mkGraphRoot();
  const dangerousCalls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = await startServer({
    port: 0, pollMs: 100000, env, configFile,
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => { await gate; return '0.9.1'; }, // pauses the tick right before compareVersions
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if ((bin === 'uv' && args[0] === 'tool' && (args[1] === 'upgrade' || args[1] === 'install')) || (bin === 'graphify' && args[0] === 'install')) {
          dangerousCalls.push([bin, ...args]);
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  const tick = srv.graphifyVersionTick();
  await waitTick();
  const closing = srv.close(); // closingPromise is truthy synchronously, before this even resolves
  release();
  await tick;
  await closing;
  assert.deepEqual(dangerousCalls, [], `no upgrade/install/rollback command must run once shutdown had begun, got: ${JSON.stringify(dangerousCalls)}`);
});

// N4 remainder + F1(2): close() landing AFTER the upgrade, during the
// rebuild, must skip the rollback install AND say so in graph sync health
// (persisted, so it reaches the alert center), not only in a console line.
test('a shutdown after the upgrade skips the rollback and records the skip in health (N4 remainder, F1(2))', async () => {
  const { env, configFile } = mkGraphRoot();
  const rollbackCalls = [];
  let srv; let closing;
  srv = await startServer({
    port: 0, pollMs: 100000, env, configFile,
    spawnGraphifyUpdate: async () => {
      closing = srv.close(); // shutdown begins mid-rebuild, after the upgrade already ran
      return { code: 1, stdout: 'Refusing to overwrite existing graph: new graph has 5 nodes but existing graph.json has 50', stderr: '' };
    },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (isRollback(bin, args)) rollbackCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  await closing;
  assert.deepEqual(rollbackCalls, [], 'no rollback install may start once shutdown has begun');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.ok(entry, 'expected a persisted graphify@0.9.1 health entry');
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.reason, /^rebuild audit failed; rollback SKIPPED \(server closing\): /);
});

// the per-root rebuild loop must stop spawning graphify updates once
// close() has begun.
test('a shutdown during the per-root rebuild loop stops spawning further updates (F1(3))', async () => {
  const { env, configFile } = mkGraphRoot({ roots: 2 });
  const spawned = [];
  let srv; let closing;
  srv = await startServer({
    port: 0, pollMs: 100000, env, configFile,
    spawnGraphifyUpdate: async (root) => {
      spawned.push(root);
      if (!closing) closing = srv.close();
      return { code: 0, stdout: NOOP_STDOUT, stderr: '' };
    },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin) => (bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    },
  });
  await srv.graphifyVersionTick();
  await closing;
  assert.equal(spawned.length, 1, `no graphify update may be spawned after close(); spawned: ${JSON.stringify(spawned)}`);
});

// 2026-11-03: 0.9.101 landed, then the audit gave up after the 60 s default
// on the kernel root, held by a post-deploy rebuild that runs for minutes,
// and rolled back (the third time in a row). The audit waits as long as one
// update may run. A fake clock stands in for the 2 minutes.
test('the rebuild audit waits out a root held busy for minutes, then adopts the candidate', async () => {
  const rollbackCalls = [];
  let release;
  const held = new Promise((r) => { release = r; });
  let clock = 0;
  const { srv, env, projectRoot } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => {
      if (path.resolve(root).toLowerCase() === path.resolve(projectRoot).toLowerCase()) await held;
      return { code: 0, stdout: NOOP_STDOUT, stderr: '' };
    },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (isRollback(bin, args)) rollbackCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      waitOpts: {
        now: () => clock,
        sleep: async (ms) => { clock += ms * 100; if (clock >= 120_000) release(); await new Promise((r) => setImmediate(r)); },
      },
    },
  });
  const holder = srv.graphifyUpdate(projectRoot, {});
  try {
    await srv.graphifyVersionTick();
    assert.deepEqual(rollbackCalls, [], 'a root busy for 2 minutes must be waited out, not rolled back');
    assert.equal(readJson(healthFileOf(env))['graphify@0.9.1'].outcome, 'updated');
  } finally { release(); await holder; }
});

// F2 / N2 remainder: a root held busy past a short maxWaitMs (injected via
// graphifyVersionOverrides.waitOpts) is never a silent pass. Since card
// glmps-2-0-runtime-144 the tick waits for its roots BEFORE the upgrade, so a
// root still busy defers the upgrade with nothing installed, rather than
// installing, failing the audit and rolling back.
test('a root held busy past a short maxWaitMs defers the upgrade: no install, no marker, no rollback (F2, I1 tick-level)', async () => {
  const uvCalls = [];
  let release;
  const held = new Promise((r) => { release = r; });
  const { srv, env, projectRoot } = await useSharedServer({
    // Only the holder's own call blocks; every other root (collectGraphRoots
    // always includes this repo's root too) returns at once.
    spawnGraphifyUpdate: async (root) => {
      if (path.resolve(root).toLowerCase() === path.resolve(projectRoot).toLowerCase()) await held;
      return { code: 0, stdout: '', stderr: '' };
    },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (bin === 'uv') uvCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      waitOpts: { maxWaitMs: 30, pollMs: 1, sleep: () => new Promise((r) => setImmediate(r)) },
    },
  });
  const holder = srv.graphifyUpdate(projectRoot, {}); // another caller holds the root
  try {
    const t0 = Date.now();
    await srv.graphifyVersionTick();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 10000, `the injected maxWaitMs (30ms) must bound the busy wait, not the 60s default; tick took ${elapsed}ms`);
    assert.deepEqual(uvCalls, [], 'nothing is installed while a root is still busy');
    assert.equal(fs.existsSync(markerFileOf(env)), false);
    const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
    assert.equal(entry.outcome, 'noop');
    assert.match(entry.reason, /deferred to the next tick: graph update still running on /);
  } finally { release(); await holder; }
});

// the pending-rollback marker is on disk BEFORE the rebuild audit can
// be interrupted, and a passing audit clears it.
test('the pending-rollback marker is written before the rebuild and cleared by a passing audit (F1(1))', async () => {
  let markerDuringRebuild = null;
  const rollbackCalls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => {
      try { markerDuringRebuild = readJson(markerFileOf(env)); } catch { markerDuringRebuild = 'missing'; }
      return { code: 0, stdout: NOOP_STDOUT, stderr: '' };
    },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (isRollback(bin, args)) rollbackCalls.push(args);
        return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  assert.equal(markerDuringRebuild?.prior, '0.9.0', `marker must name the prior version during the rebuild, got: ${JSON.stringify(markerDuringRebuild)}`);
  assert.equal(markerDuringRebuild?.candidate, '0.9.1');
  assert.deepEqual(rollbackCalls, [], 'the audit must pass here, so the marker is cleared by the pass, not by a rollback');
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'a passing audit must clear the marker');
});

// across a simulated restart. Server A is shut down mid-rebuild with
// a failing audit (rollback skipped); server B boots with the candidate
// installed (installed === latest, which used to return early forever) and
// must roll back from the marker, then clear it.
test('a pending rollback left by a shutdown is carried out by the next server after a restart (F1(1))', async () => {
  const { env: envA, configFile: configFileA } = mkGraphRoot();
  let srvA; let closingA;
  srvA = await startServer({
    port: 0, pollMs: 100000, env: envA, configFile: configFileA,
    spawnGraphifyUpdate: async () => { closingA = srvA.close(); return { code: 1, stdout: 'Refusing to overwrite existing graph', stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin) => (bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    },
  });
  await srvA.graphifyVersionTick();
  await closingA;
  assert.ok(fs.existsSync(markerFileOf(envA)), 'the skipped rollback must leave a pending-rollback marker behind');

  const callsB = [];
  const { srv: srvB, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => { throw new Error('no rebuild expected on the recovery tick'); },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1', // the unaudited candidate is what is installed now
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => { if (bin !== 'tasklist') callsB.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.copyFileSync(markerFileOf(envA), markerFileOf(env));
  await srvB.graphifyVersionTick();
  assert.deepEqual(callsB, [['uv', 'tool', 'install', 'graphifyy==0.9.0']], `expected exactly the rollback, got: ${JSON.stringify(callsB)}`);
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'a verified rollback must clear the marker');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.reason, /rolled back to 0\.9\.0/);
});

// 2026-11-03: a restart at 3:15 PM PT cut 0.9.102's audit short, and the next
// boot rolled back a candidate nobody had found fault with. The marker now
// carries the audit's roots and pre-upgrade counts, so a boot resumes it.
test('the upgrade marker records the audit roots and pre-upgrade node counts', async () => {
  let marker = null;
  const { srv, env, projectRoot } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (isUpgrade(bin, args)) marker = readJson(markerFileOf(env));
        return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  assert.ok(marker, 'the marker is on disk when the upgrade runs');
  const key = marker.roots.find((r) => path.resolve(r).toLowerCase() === path.resolve(projectRoot).toLowerCase());
  assert.ok(key, JSON.stringify(marker));
  assert.equal(marker.before[key], 1);
});

const resumeMarker = (env, projectRoot, count) => {
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.0', candidate: '0.9.1', ts: 1, roots: [projectRoot], before: { [projectRoot]: count } }));
};

test('a boot that finds an interrupted audit on the candidate resumes it and adopts, without a rollback', async () => {
  const uvCalls = [];
  const spawned = [];
  const { srv, env, projectRoot } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => { spawned.push(root); return { code: 0, stdout: NOOP_STDOUT, stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => { if (bin === 'uv') uvCalls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  resumeMarker(env, projectRoot, 1);
  await srv.graphifyVersionTick();
  assert.deepEqual(uvCalls, [], 'no rollback and no reinstall');
  assert.equal(spawned.length, 1, 'the audit rebuilds the recorded root');
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'an audit that passes clears the marker');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'updated');
  assert.match(entry.reason, /adopted 0\.9\.1 \(was 0\.9\.0\); audit resumed after a restart/);
});

test('a resumed audit that finds a regression rolls back to the prior version', async () => {
  const rollbackCalls = [];
  const { srv, env, projectRoot } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => { if (isRollback(bin, args)) rollbackCalls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  resumeMarker(env, projectRoot, 100);
  await srv.graphifyVersionTick();
  assert.deepEqual(rollbackCalls, [['tool', 'install', 'graphifyy==0.9.0']]);
  assert.match(readJson(healthFileOf(env))['graphify@0.9.1'].reason, /rebuild audit failed, rolled back to 0\.9\.0: .*100->1/);
});

// Card glmps-2-0-runtime-146 finding 7: an audit that reached a verdict and
// then failed to roll back leaves a rollback-only marker, so the next tick
// retries the rollback without paying another rebuild of every root.
test('a resumed audit that fails and cannot roll back is retried as a rollback, not a second audit', async () => {
  const spawned = [];
  const rollbacks = [];
  let rollbackCode = 1;
  const { srv, env, projectRoot } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => { spawned.push(root); return { code: 0, stdout: NOOP_STDOUT, stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (isRollback(bin, args)) { rollbacks.push(args); return { code: rollbackCode, stdout: '', stderr: 'uv: tool exe locked' }; }
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  resumeMarker(env, projectRoot, 100);
  await srv.graphifyVersionTick();
  assert.equal(spawned.length, 1, 'the first tick audits');
  assert.equal(rollbacks.length, 1);
  const kept = readJson(markerFileOf(env));
  assert.equal(kept.roots, undefined, `the kept marker no longer asks for an audit: ${JSON.stringify(kept)}`);
  assert.equal(kept.prior, '0.9.0');

  rollbackCode = 0;
  await srv.graphifyVersionTick();
  assert.equal(spawned.length, 1, 'the retry does not rebuild the roots again');
  assert.equal(rollbacks.length, 2, 'the retry goes straight to the rollback');
  assert.equal(fs.existsSync(markerFileOf(env)), false);
});

// a recovery rollback that itself fails keeps the marker, so the
// next tick retries, and the failure is named in health.
test('a failed recovery rollback keeps the marker and is recorded (F1(1))', async () => {
  const { srv, env } = await useSharedServer({
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => (isRollback(bin, args) ? { code: 1, stdout: '', stderr: 'uv: tool exe locked' } : { code: 0, stdout: '', stderr: '' }),
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.0', candidate: '0.9.1', ts: 1 }));
  await srv.graphifyVersionTick();
  assert.ok(fs.existsSync(markerFileOf(env)), 'a failed rollback must keep the marker for the next tick');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.match(entry.reason, /rollback to 0\.9\.0 failed/);
  assert.match(entry.reason, /tool exe locked/);
});

// a marker whose prior version is what is installed (the upgrade
// never took, or a rollback already landed) is stale: cleared, no rollback,
// and the normal audit flow proceeds.
test('a stale marker (installed === prior) is cleared without a rollback (F1(1))', async () => {
  const dangerous = [];
  const { srv, env } = await useSharedServer({
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.0',
      latestGraphifyVersion: async () => '0.9.0', // nothing newer: normal flow returns early
      runCmd: async (bin, args) => { if (isDangerous(bin, args)) dangerous.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.0', candidate: '0.9.1', ts: 1 }));
  await srv.graphifyVersionTick();
  assert.deepEqual(dangerous, []);
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'a stale marker must be cleared');
});

// A passing audit records the adopted version as healthy, so a 'failed'
// entry left for the same candidate by an earlier interrupted or rolled-back
// attempt does not stay a standing alert after it is genuinely adopted.
test('a passing audit records the adopted candidate as updated in health', async () => {
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin) => (bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    },
  });
  fs.mkdirSync(path.dirname(healthFileOf(env)), { recursive: true });
  fs.writeFileSync(healthFileOf(env), JSON.stringify({ 'graphify@0.9.1': { outcome: 'failed', reason: 'earlier interrupted attempt', ts: 1, consecutive: 1 } }));
  await srv.graphifyVersionTick();
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'updated', JSON.stringify(entry));
});

// Item 1: `uv tool upgrade` exiting non-zero (Windows: a running graphify
// locks the tool exe) used to go unchecked; the rebuild then ran on the OLD
// version, the audit passed, and health recorded 'updated: adopted <latest>',
// overwriting a real 'failed' alert for that version.
test('an upgrade that did not land is recorded as failed, with no rebuild and no "updated" (round 5 item 1)', async () => {
  const spawned = [];
  const calls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => { spawned.push(root); return { code: 0, stdout: NOOP_STDOUT, stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.0', // the upgrade never landed
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        calls.push([bin, ...args]);
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (isUpgrade(bin, args)) return { code: 1, stdout: '', stderr: 'error: failed to remove graphify.exe: Access is denied' };
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  fs.mkdirSync(path.dirname(healthFileOf(env)), { recursive: true });
  fs.writeFileSync(healthFileOf(env), JSON.stringify({ 'graphify@0.9.1': { outcome: 'failed', reason: 'a real earlier failure', ts: 1, consecutive: 1 } }));
  await srv.graphifyVersionTick();
  assert.deepEqual(spawned, [], 'no rebuild may run on a version that was never installed');
  assert.ok(!calls.some(([b, a]) => b === 'graphify' && a === 'install'), `graphify install must not run after a failed upgrade: ${JSON.stringify(calls)}`);
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'failed', JSON.stringify(entry));
  assert.match(entry.reason, /^upgrade to 0\.9\.1 did not land: exit 1 /);
  assert.match(entry.reason, /Access is denied/);
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'still on the prior version: the marker must be cleared');
});

// Item 1, second half: exit 0 is not enough -- the re-read installed
// version must equal the candidate.
test('an upgrade that exits 0 but leaves another version installed is recorded as failed (round 5 item 1)', async () => {
  const spawned = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => { spawned.push(root); return { code: 0, stdout: NOOP_STDOUT, stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.0',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin) => (bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }),
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(spawned, []);
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.match(entry.reason, /^upgrade to 0\.9\.1 did not land: exit 0, installed is 0\.9\.0/);
});

// Item 2: a marker that exists but cannot be read (anything but ENOENT) is
// not "no marker": it is logged, recorded in health, and the tick stops
// rather than silently taking the installed === latest early return.
test('an unreadable pending-rollback marker is recorded in health and halts the tick (round 5 item 2)', async () => {
  const dangerous = [];
  let latestAsked = false;
  const logs = [];
  const { srv, env } = await useSharedServer({
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => { latestAsked = true; return '0.9.1'; },
      runCmd: async (bin, args) => { if (isDangerous(bin, args)) dangerous.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(markerFileOf(env), { recursive: true }); // a directory: readFileSync throws EISDIR, not ENOENT
  const realError = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  try {
    await srv.graphifyVersionTick();
    assert.deepEqual(dangerous, []);
    assert.equal(latestAsked, false, 'the tick must stop at the unreadable marker, not continue to the early return');
    const entry = readJson(healthFileOf(env))['graphify@pending-rollback'];
    assert.ok(entry, 'expected a graphify@pending-rollback health entry');
    assert.equal(entry.outcome, 'failed');
    assert.match(entry.reason, /unreadable/);
    assert.match(entry.reason, /EISDIR/);
    assert.ok(logs.some((m) => /pending-rollback marker.*unreadable/.test(m)), `expected a log line, got: ${JSON.stringify(logs)}`);
  } finally { console.error = realError; }
});

// Item 3: roll back only when the installed version IS the unverified
// candidate. Anything else (e.g. the operator installed a newer one) is
// not ours to undo: the marker is cleared and what was found is recorded.
test('a marker whose candidate is no longer installed is cleared, not rolled back (round 5 item 3)', async () => {
  const dangerous = [];
  const { srv, env } = await useSharedServer({
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.5', // installed by someone else
      latestGraphifyVersion: async () => '0.9.5',
      runCmd: async (bin, args) => { if (isDangerous(bin, args)) dangerous.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.0', candidate: '0.9.1', ts: 1 }));
  await srv.graphifyVersionTick();
  assert.deepEqual(dangerous, [], 'a version that is neither prior nor candidate must not be rolled back');
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'the marker must be cleared');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.ok(entry, 'expected what was found to be recorded under graphify@0.9.1');
  assert.match(entry.reason, /installed is 0\.9\.5/);
});

// `uv tool upgrade` is unpinned, so if PyPI publishes a newer release
// mid-tick the upgrade exits 0 with a THIRD version installed, one the
// surface audit never saw. Roll it back at once (the next tick then audits
// the true latest normally) instead of leaving it for a marker that the
// next tick would abandon.
test('an upgrade that installs a version newer than the audited candidate is rolled back at once (R1)', async () => {
  const spawned = [];
  const calls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => { spawned.push(root); return { code: 0, stdout: NOOP_STDOUT, stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.2'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }; },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(spawned, [], 'no rebuild on an unaudited version');
  assert.deepEqual(calls.filter(([b]) => b !== 'uvx' && b !== 'tasklist'), [['uv', 'tool', 'install', '--upgrade', 'graphifyy==0.9.1'], ['uv', 'tool', 'install', 'graphifyy==0.9.0']],
    `expected the upgrade then exactly the rollback, got: ${JSON.stringify(calls)}`);
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'a verified rollback clears the marker');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.reason, /installed is 0\.9\.2/);
  assert.match(entry.reason, /rolled back to 0\.9\.0/);
});

// R1, shutdown check first: the same case with close() landing during the
// upgrade must not start the rollback; the skip is recorded and the marker
// stays for the next boot.
test('the R1 rollback is skipped and recorded when the server is closing (R1)', async () => {
  const { env, configFile } = mkGraphRoot();
  const rollbackCalls = [];
  let srv; let closing;
  srv = await startServer({
    port: 0, pollMs: 100000, env, configFile,
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.2'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (bin === 'uvx') return { code: 0, stdout: PASSING_HELP, stderr: '' };
        if (isUpgrade(bin, args)) closing = srv.close();
        if (isRollback(bin, args)) rollbackCalls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  await closing;
  assert.deepEqual(rollbackCalls, []);
  assert.ok(fs.existsSync(markerFileOf(env)), 'the marker must stay for the next boot');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.match(entry.reason, /rollback SKIPPED \(server closing\)/);
  assert.match(entry.reason, /installed is 0\.9\.2/);
});

// exit 0 but the installed version cannot be re-read: recorded as not
// landed, nothing rolled back or rebuilt, and the marker KEPT so the next
// tick decides from it.
test('an upgrade whose resulting version cannot be read keeps the marker (R3)', async () => {
  const spawned = [];
  const rollbackCalls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async (root) => { spawned.push(root); return { code: 0, stdout: NOOP_STDOUT, stderr: '' }; },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', null),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => {
        if (isRollback(bin, args)) rollbackCalls.push(args);
        return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(spawned, []);
  assert.deepEqual(rollbackCalls, []);
  assert.ok(fs.existsSync(markerFileOf(env)), 'an unknown resulting version must keep the marker');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.reason, /^upgrade to 0\.9\.1 did not land: exit 0, installed is unknown/);
});

// the 'graphify@pending-rollback' failed entry used to
// stand forever. Once the marker reads cleanly again (here: absent), the
// key gets a non-alerting outcome. 'noop' (graph-sync-health / alert-
// sources: only refused/failed raise, a no-op is a legitimate outcome): the
// recovery changed nothing, it only stopped being broken.
test('a failed graphify@pending-rollback entry is cleared once the marker reads cleanly (R2)', async () => {
  const { env, configFile } = mkGraphRoot();
  fs.mkdirSync(path.dirname(healthFileOf(env)), { recursive: true });
  fs.writeFileSync(healthFileOf(env), JSON.stringify({ 'graphify@pending-rollback': { outcome: 'failed', reason: 'pending-rollback marker unreadable (EISDIR: x)', ts: 1, consecutive: 3 } }));
  const srv = await startServer({
    port: 0, pollMs: 100000, env, configFile,
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  });
  try {
    await srv.graphifyVersionTick();
    const entry = readJson(healthFileOf(env))['graphify@pending-rollback'];
    assert.equal(entry.outcome, 'noop', JSON.stringify(entry));
    assert.match(entry.reason, /readable/);
  } finally { await srv.close(); }
});

// R2, the other half: with no failed entry there is nothing to clear, so
// the key is never created on a healthy tick.
test('a healthy tick never creates a graphify@pending-rollback entry (R2)', async () => {
  const { srv, env } = await useSharedServer({
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    },
  });
  await srv.graphifyVersionTick();
  let health = {};
  try { health = readJson(healthFileOf(env)); } catch { /* never written: fine */ }
  assert.equal(health['graphify@pending-rollback'], undefined);
});

test('the default graphifyVersionOverrides refuse under isTestProcess(), with no override given (N2)', async () => {
  const { env } = mkEnv();
  const logs = [];
  const realError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  const srv = await startServer({ port: 0, pollMs: 100000, env }); // no graphifyVersionOverrides at all
  try {
    await srv.graphifyVersionTick();
    assert.ok(
      logs.some((m) => /graphify version tick failed.*refused.*isTestProcess/.test(m)),
      `expected a named refusal to reach the tick's own log, got: ${JSON.stringify(logs)}`,
    );
  } finally { console.error = realError; await srv.close(); }
});

// The 2026-10-23 failure: `uv tool upgrade` ran while a graphify launcher
// held graphify.exe (os error 32). The upgrade now waits for no graphify
// process, and a wait that runs out defers without touching anything.
const BUSY = [{ image: 'graphify-mcp.exe', pid: 4242 }];

test('an upgrade is deferred, with no marker and no uv call, while graphify is still running', async () => {
  const calls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => { throw new Error('no rebuild expected on a deferred upgrade'); },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.0',
      latestGraphifyVersion: async () => '0.9.1',
      listGraphifyProcesses: async () => BUSY,
      processWaitOpts: { maxWaitMs: 0 },
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }; },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(calls.filter(([b]) => b === 'uv'), [], `no uv call while graphify runs, got: ${JSON.stringify(calls)}`);
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'a deferred upgrade writes no marker');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'noop');
  assert.match(entry.reason, /deferred.*graphify-mcp\.exe pid 4242/);
});

// 2026-10-31..11-03: after a rollback pinned graphifyy==0.9.99 in the uv
// receipt, `uv tool upgrade graphifyy` exited 0 without moving, 23 ticks in
// a row. The upgrade must name the audited candidate itself.
test('the upgrade installs the audited candidate by exact pin, not an unpinned uv tool upgrade', async () => {
  const uvCalls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.99', '0.9.101'),
      latestGraphifyVersion: async () => '0.9.101',
      runCmd: async (bin, args) => { if (bin === 'uv') uvCalls.push(args); return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }; },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(uvCalls, [['tool', 'install', '--upgrade', 'graphifyy==0.9.101']]);
  assert.equal(readJson(healthFileOf(env))['graphify@0.9.101'].outcome, 'updated');
});

test('an upgrade waits for graphify to exit, then runs', async () => {
  const order = [];
  let polls = 0;
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      listGraphifyProcesses: async () => { polls += 1; order.push('list'); return polls < 3 ? BUSY : []; },
      processWaitOpts: { maxWaitMs: 60_000, pollMs: 1, sleep: async () => {} },
      runCmd: async (bin, args) => { if (bin === 'uv') order.push(args.slice(0, 2).join(' ')); return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }; },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(order, ['list', 'list', 'list', 'tool install']);
  assert.equal(readJson(healthFileOf(env))['graphify@0.9.1'].outcome, 'updated');
});

test('a pending rollback is deferred while graphify is running and the marker is kept', async () => {
  const calls = [];
  const { srv, env } = await useSharedServer({
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.1',
      latestGraphifyVersion: async () => '0.9.1',
      listGraphifyProcesses: async () => BUSY,
      processWaitOpts: { maxWaitMs: 0 },
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.0', candidate: '0.9.1', ts: 1 }));
  await srv.graphifyVersionTick();
  assert.deepEqual(calls.filter(([b]) => b === 'uv'), [], 'no rollback install while graphify runs');
  assert.ok(fs.existsSync(markerFileOf(env)), 'the marker stays so the next tick retries');
  const entry = readJson(healthFileOf(env))['graphify@0.9.1'];
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.reason, /deferred, graphify still running: graphify-mcp\.exe pid 4242/);
});

// The marker left on 2026-10-23: prior 0.9.90, candidate 0.9.95, and 0.9.95
// installed. 0.9.95 is the pinned known-good version, so the marker is stale.
test('a pending rollback whose candidate is the pinned known-good version is cleared, not rolled back', async () => {
  const calls = [];
  const { srv, env } = await useSharedServer({
    spawnGraphifyUpdate: async () => { throw new Error('no rebuild expected'); },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.95',
      latestGraphifyVersion: async () => '0.9.95',
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.90', candidate: '0.9.95', ts: 1792787290473 }));
  fs.writeFileSync(healthFileOf(env), JSON.stringify({ 'graphify@0.9.95': { outcome: 'failed', reason: 'upgrade to 0.9.95 did not land: exit 1 ... (os error 32)', ts: 1, consecutive: 1 } }));
  await srv.graphifyVersionTick();
  assert.deepEqual(calls.filter(([b]) => b === 'uv'), [], `no rollback of the pinned version, got: ${JSON.stringify(calls)}`);
  assert.equal(fs.existsSync(markerFileOf(env)), false, 'the stale marker is cleared');
  const entry = readJson(healthFileOf(env))['graphify@0.9.95'];
  assert.equal(entry.outcome, 'updated');
  assert.match(entry.reason, /known-good version pinned in config; pending rollback to 0\.9\.90 cleared/);
});

// Graphify plan task 9: the app keeps the claude and agents skill copies in
// step with the installed package on every tick, after an upgrade, a
// rollback or a hand install. skillHome names a temp home; without it (the
// tests above) nothing is refreshed.
test('a landed upgrade refreshes both skill copies with install --platform claude and agents', async () => {
  const calls = [];
  const { srv, env } = await useSkillServer({
    stamps: { claude: '0.9.0', agents: '0.9.0' },
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.0', '0.9.1'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return bin === 'uvx' ? { code: 0, stdout: PASSING_HELP, stderr: '' } : { code: 0, stdout: '', stderr: '' }; },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(skillInstalls(calls), ['install --platform claude', 'install --platform agents']);
  const health = readJson(healthFileOf(env));
  assert.equal(health['graphify-skill@claude'].outcome, 'updated');
  assert.match(health['graphify-skill@agents'].reason, /was 0\.9\.0/);
});

test('a tick with no upgrade still refreshes a stale copy (the 0.9.51 agents skill) and leaves a current one', async () => {
  const calls = [];
  const { srv } = await useSkillServer({
    stamps: { claude: '0.9.95', agents: '0.9.51' },
    spawnGraphifyUpdate: async () => { throw new Error('no rebuild expected'); },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.95',
      latestGraphifyVersion: async () => '0.9.95',
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  await srv.graphifyVersionTick();
  assert.deepEqual(skillInstalls(calls), ['install --platform agents']);
});

test('a failed skill install is recorded as failed in health', async () => {
  const { srv, env } = await useSkillServer({
    stamps: { claude: '0.9.95', agents: '0.9.51' },
    graphifyVersionOverrides: {
      graphifyVersion: async () => '0.9.95',
      latestGraphifyVersion: async () => '0.9.95',
      runCmd: async (bin, args) => (args[0] === 'install' ? { code: 1, stdout: '', stderr: 'PermissionError' } : { code: 0, stdout: '', stderr: '' }),
    },
  });
  await srv.graphifyVersionTick();
  const entry = readJson(healthFileOf(env))['graphify-skill@agents'];
  assert.equal(entry.outcome, 'failed');
  assert.match(entry.reason, /PermissionError/);
});

test('after a rollback the skill copies follow the package down to the prior version', async () => {
  const calls = [];
  const { srv, env } = await useSkillServer({
    stamps: { claude: '0.9.1', agents: '0.9.1' },
    spawnGraphifyUpdate: async () => { throw new Error('no rebuild expected'); },
    graphifyVersionOverrides: {
      graphifyVersion: installedVersions('0.9.1', '0.9.0'),
      latestGraphifyVersion: async () => '0.9.1',
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    },
  });
  fs.mkdirSync(path.dirname(markerFileOf(env)), { recursive: true });
  fs.writeFileSync(markerFileOf(env), JSON.stringify({ prior: '0.9.0', candidate: '0.9.1', ts: 1 }));
  await srv.graphifyVersionTick();
  assert.ok(calls.some(c => c.join(' ') === 'uv tool install graphifyy==0.9.0'), JSON.stringify(calls));
  assert.deepEqual(skillInstalls(calls), ['install --platform claude', 'install --platform agents']);
});

// Machine repos get integrations only when opted in; the rebuild tick
// installs what an opted-in repo is missing, then refreshes the skills
// (gemini install overwrites ~/.agents/skills).
test('the rebuild tick installs missing integrations in opted-in machine repos only, then refreshes skills', async () => {
  const { env, configFile, projectRoots } = mkGraphRoot({ roots: 2 });
  const [optedIn, notOptedIn] = projectRoots;
  fs.writeFileSync(configFile, JSON.stringify({ graph: { machine: { enabled: true, include: [optedIn] } } }));
  const skillHome = mkSkillHome({ claude: '0.9.95', agents: '0.9.95' });
  const integ = [];
  const calls = [];
  const srv = await startServer({
    port: 0, pollMs: 100000, env, configFile,
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: {
      skillHome,
      graphifyVersion: async () => '0.9.95',
      latestGraphifyVersion: async () => '0.9.95',
      runCmd: async (bin, args) => { calls.push([bin, ...args]); return { code: 0, stdout: '', stderr: '' }; },
      integrationRunCmd: async (bin, args, opts) => {
        integ.push({ cmd: [bin, ...args].join(' '), cwd: opts?.cwd });
        // gemini's install rewrites the shared agents copy with its own stamp
        if (args[0] === 'gemini') fs.writeFileSync(path.join(skillHome, '.agents', 'skills', 'graphify', '.graphify_version'), '0.9.51\n');
        return { code: 0, stdout: '', stderr: '' };
      },
    },
  });
  try {
    await srv.graphRebuildTick();
    const norm = (p) => path.resolve(String(p)).toLowerCase();
    assert.deepEqual(integ.map(i => i.cmd), ['graphify claude install', 'graphify aider install', 'graphify gemini install', 'graphify vscode install']);
    assert.ok(integ.every(i => norm(i.cwd) === norm(optedIn)), `only the opted-in root is written: ${JSON.stringify(integ)} vs ${notOptedIn}`);
    assert.deepEqual(skillInstalls(calls), ['install --platform agents']);
    const entry = Object.entries(readJson(healthFileOf(env))).find(([k]) => k.startsWith('graphify-integrations@'));
    assert.equal(entry[1].outcome, 'updated');
    assert.match(entry[1].reason, /installed claude, agents-md, gemini, copilot/);
  } finally { await srv.close(); }
});

test('the rebuild tick writes nothing into a repo whose integrations are all present', async () => {
  const integ = [];
  const { srv, projectRoot } = await useSharedServer({
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: NOOP_STDOUT, stderr: '' }),
    graphifyVersionOverrides: { integrationRunCmd: async (...a) => { integ.push(a); return { code: 0, stdout: '', stderr: '' }; } },
  });
  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '## graphify\n');
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.claude', 'settings.json'), '{"c":"[ -f graphify-out/graph.json ]"}');
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '## graphify\n');
  fs.writeFileSync(path.join(projectRoot, 'GEMINI.md'), '## graphify\n');
  fs.mkdirSync(path.join(projectRoot, '.github'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, '.github', 'copilot-instructions.md'), '## graphify\n');
  await srv.graphRebuildTick();
  assert.deepEqual(integ, []);
});
