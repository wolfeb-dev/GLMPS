// server/test/api-graph.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { sessionScope } from '../lib/zones.js';
import { waitFor } from './helpers/wait-for.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-graph-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'D--test');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  const transcript = path.join(projDir, 'sess1.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: process.pid, cwd: 'D:\\test', transcriptPath: transcript, ts: Date.now() }]));
  return {
    transcript,
    projectDir: tmp,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
           GLMPS_STATE_DIR: path.join(tmp, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
           GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
           GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
           GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode') },
  };
}

function mkProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-graph-proj-'));
  tmpDirs.push(dir);
  return dir;
}

// /api/graph only answers for a project in the graph-root allowlist.
function registerAllowlistedRoot(claudeDir, root) {
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [root.replace(/\\/g, '/')] },
  }));
}

let sharedEnv;
let sharedSrv;
let rebuildCtx;
let rebuildSrv;
let currentSpawn = async () => ({ code: 0, stdout: 'No code-graph topology changes detected', stderr: '' });

before(async () => {
  ({ env: sharedEnv } = mkEnv());
  sharedSrv = await startServer({ port: 0, pollMs: 100000, env: sharedEnv });

  rebuildCtx = mkGraphCollectableEnv();
  rebuildSrv = await startServer({
    port: 0, pollMs: 100000, env: rebuildCtx.env, configFile: rebuildCtx.configFile,
    spawnGraphifyUpdate: (...a) => currentSpawn(...a),
  });
});

after(async () => {
  await rebuildSrv?.close();
  await sharedSrv?.close();
});

test('GET /api/graph returns { project, graph: null, zoneConfig } for a project with no graph file', async () => {
  const projectDir = mkProjectDir();
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  // projectDir has no graphify-out/graph.json, so graph must be null
  const res = await fetch(`${base}/api/graph?project=${encodeURIComponent(projectDir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('project' in body, 'response has project field');
  assert.ok('graph' in body, 'response has graph field');
  assert.ok('zoneConfig' in body, 'response has zoneConfig field');
  assert.equal(body.project, projectDir);
  assert.equal(body.graph, null, 'graph is null when no graph file exists');
  assert.ok('graphRoot' in body, 'response has graphRoot field');
  assert.equal(body.graphRoot, null, 'graphRoot is null when no graph file exists');
  assert.ok(Array.isArray(body.zoneConfig.prefixes), 'zoneConfig has prefixes array');
});

test('GET /api/graph includes graphRoot = parent of the loaded graphify-out dir', async () => {
  const projectDir = mkProjectDir();
  const goDir = path.join(projectDir, 'graphify-out');
  fs.mkdirSync(goDir, { recursive: true });
  fs.writeFileSync(path.join(goDir, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'a', label: 'a.js', source_file: 'a.js', community: 0 }],
    links: [],
  }));
  registerAllowlistedRoot(sharedEnv.GLMPS_CLAUDE_DIR, projectDir);
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  const res = await fetch(`${base}/api/graph?project=${encodeURIComponent(projectDir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('graphRoot' in body, 'response has graphRoot field');
  assert.equal(body.graphRoot, projectDir.replace(/\\/g, '/'),
    'graphRoot is the parent of graphify-out, forward-slashed');
  assert.ok(body.graph, 'graph loaded');
});

test('POST /api/graph/rebuild rejects a root outside the graph allowlist', async () => {
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  const res = await fetch(`${base}/api/graph/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: 'x && calc.exe' }),
  });
  assert.equal(res.status, 400, 'attacker-controlled root must be rejected before any spawn');
  const body = await res.json();
  assert.match(body.error, /allowlist/i);
});

// graphRebuildTick, the wiki loop maker's
// refreshGraph and POST /api/graph/rebuild all run `graphify update <root>`
// with no mutual exclusion -- two writers racing on the same root's
// graph.json is the 2026-07-28 collapse-incident class. spawnGraphifyUpdate
// is injected so this proves the REAL mutual-exclusion wiring (both call
// sites share one graphifySingleFlight instance) with no real graphify
// binary and no touching of this repo's own graph.json.
async function waitForSpawn(spawnCalls, ms = 5000) {
  const end = Date.now() + ms;
  while (spawnCalls.length === 0) {
    if (Date.now() > end) throw new Error('timed out waiting for the first spawn');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// this test used to target REPO_ROOT (this
// checkout's own glmps dir), relying on collectGraphRoots()
// always including it AND selectRebuildRoots()'s hasGraphDir() filter
// finding a graphify-out/ directory there -- but graphify-out/ is
// untracked and gitignored, so on a fresh checkout (CI, a git-archive
// copy) it does not exist, selectRebuildRoots() yields no roots at all,
// graphRebuildTick() never spawns anything, and waitForSpawn() times out.
// Builds its OWN isolated, graph-collectable root instead (a real
// graphify-out/ under a fresh temp dir, made discoverable via a fake
// active session's cwd, same convention mkEnv() above already uses) --
// never the real repo root.
function mkGraphCollectableEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-graph-rm6-')); tmpDirs.push(base);
  const claudeDir = path.join(base, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'proj');
  const projectRoot = path.join(base, 'project'); // the graph-collectable root -- separate from claudeDir
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }));
  const transcript = path.join(projDir, 'sess1.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: process.pid, cwd: projectRoot, transcriptPath: transcript, ts: Date.now() }]));
  // The rebuild tick acts only on in-scope roots (card glmps-2-0-93).
  execFileSync('git', ['init', '-q', projectRoot], { windowsHide: true });
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ graph: { machine: { enabled: true, include: [projectRoot] } } }));
  return {
    projectRoot,
    configFile,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(base, 'agy-cli'), GLMPS_CODEX_DIR: path.join(base, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'), GLMPS_HERMES_DIR: path.join(base, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(base, 'opencode') },
  };
}

test('graphRebuildTick and POST /api/graph/rebuild never run graphify update on the SAME root at once (R-M6)', { timeout: 15000 }, async () => {
  const spawnCalls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  currentSpawn = async (root) => {
    spawnCalls.push(root);
    await gate;
    return { code: 0, stdout: 'No code-graph topology changes detected', stderr: '' };
  };
  const first = rebuildSrv.graphRebuildTick(); // not awaited: must still be in flight when the POST below arrives
  await waitForSpawn(spawnCalls);
  assert.equal(spawnCalls.length, 1);
  // Target whichever root graphRebuildTick is CURRENTLY in flight on,
  // never a hardcoded one: this dev checkout's own REPO_ROOT may (or may
  // not) also carry a graphify-out/ dir, so collectGraphRoots() can
  // legitimately select it AHEAD of the synthetic project root above,
  // depending on the host. Colliding on whatever root actually started
  // first is what proves the single-flight guard, on any host or a
  // completely fresh checkout alike.
  const busyRoot = spawnCalls[0];
  const res = await fetch(`http://127.0.0.1:${rebuildSrv.port}/api/graph/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: busyRoot }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body.graphs));
  assert.equal(spawnCalls.length, 1, 'the POST request never actually spawned a second writer for the same root: it was refused, not queued as a second run');
  // a busy-skipped root used to vanish
  // silently into a 200 with no sign anything was skipped. The root value
  // here is the same one graphs[].root already exposes in this same
  // response, so this is not a new leak.
  assert.equal(body.skipped?.length, 1, `expected one skipped entry, got: ${JSON.stringify(body.skipped)}`);
  assert.equal(body.skipped[0].reason, 'graphify-busy');
  assert.equal(path.resolve(body.skipped[0].root).toLowerCase(), path.resolve(busyRoot).toLowerCase());
  release();
  await first;
});

// Batched review finding 5 (card glmps-2-0-runtime-148): a rebuild may run for
// 45 minutes, so the request answers at its reply budget and the rebuild keeps
// going in the background, listed as running until it ends.
test('AC-3: POST /api/graph/rebuild answers 202 at its reply budget while the rebuild keeps running', { timeout: 15000 }, async () => {
  const { env, configFile, projectRoot } = mkGraphCollectableEnv();
  const spawnCalls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const srv = await startServer({
    port: 0, pollMs: 100000, env, configFile, graphRebuildReplyMs: 200,
    spawnGraphifyUpdate: async (root) => {
      spawnCalls.push(root);
      await gate;
      return { code: 0, stdout: 'No code-graph topology changes detected', stderr: '' };
    },
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/graph/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: projectRoot }) });
    const body = await res.json();
    assert.equal(res.status, 202, JSON.stringify(body));
    assert.ok(Date.now() - t0 < 5000, 'answered at the budget, not when the rebuild ended');
    assert.ok(Array.isArray(body.graphs));
    assert.ok(body.running.some((r) => same(r, projectRoot)), `listed as running: ${JSON.stringify(body.running)}`);
    const during = await (await fetch(`${base}/api/graph/status`)).json();
    assert.ok(during.running.some((r) => same(r, projectRoot)), 'status lists it as running');
    const again = await fetch(`${base}/api/graph/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: projectRoot }) });
    assert.equal((await again.json()).skipped?.[0]?.reason, 'graphify-busy', 'still one writer per root');
    assert.equal(spawnCalls.length, 1);
    release();
    await waitFor(async () => (await (await fetch(`${base}/api/graph/status`)).json()).running.length === 0,
      { timeoutMs: 5000, message: 'running cleared once the background rebuild ends' });
  } finally { release(); await srv.close(); }
});

test('POST /api/graph/rebuild still answers 200 when the rebuild finishes inside the budget', { timeout: 15000 }, async () => {
  currentSpawn = async () => ({ code: 0, stdout: 'No code-graph topology changes detected', stderr: '' });
  const res = await fetch(`http://127.0.0.1:${rebuildSrv.port}/api/graph/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: rebuildCtx.projectRoot }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.running, []);
  assert.deepEqual(body.skipped, []);
});

// spawnGraphifyUpdate's default had no
// isTestProcess guard (unlike the wiki loop's runBuild default, R-M4), so a
// test process with no override given would spawn a REAL graphify process.
// NOTE: this test was NOT run against the pre-fix code to confirm red --
// doing so would have called the real default and spawned a genuine
// `graphify update` process (the exact hazard this fix exists to prevent).
// Verified instead by exact pattern match against R-M4's already-proven
// isTestProcess({ env }) guard for the wiki loop's own runBuild default.
test('the default spawnGraphifyUpdate refuses under isTestProcess(), with no override given (M2)', async () => {
  await assert.rejects(
    sharedSrv.graphifyUpdate('does-not-matter-never-reached', {}),
    /graphify update refused.*isTestProcess/,
  );
});

test('session.scope is sessionScope over file-edit paths', () => {
  const scope = sessionScope(['D:\\mc\\web\\a.js'], { projectRoot: 'D:\\mc' });
  assert.equal(scope.allDev, true);
  assert.ok(Array.isArray(scope.zones), 'zones is an array');
  assert.ok(Array.isArray(scope.protected), 'protected is an array');
  assert.equal(typeof scope.touched, 'number');
  assert.equal(scope.touched, 1);
});
