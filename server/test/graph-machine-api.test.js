// GET /api/graph?scope= and the secondary-scan routes (card glmps-2-0-101).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function graphRepo(dir, ids) {
  fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
  execFileSync('git', ['init', '-q', dir], { windowsHide: true });
  fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify({
    nodes: ids.map((id) => ({ id, label: `${id}.js`, source_file: `${id}.js`, community: 0 })), links: [],
  }));
}

function mkEnv() {
  const base = fs.mkdtempSync(path.join(tmpRoot(), 'mc-graph-machine-')); tmpDirs.push(base);
  const claudeDir = path.join(base, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(base, 'ag', 'brain'), { recursive: true });
  const repoA = path.join(base, 'repo-a');
  const repoB = path.join(base, 'repo-b');
  const plain = path.join(base, 'plain');
  graphRepo(repoA, ['a1', 'a2']);
  graphRepo(repoB, ['b1']);
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [repoA, repoB, plain].map((p) => p.replace(/\\/g, '/')) },
  }));
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({}));
  const stateDir = path.join(base, 'state');
  return {
    repoA, repoB, plain, configFile, stateDir,
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: stateDir,
           GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(base, 'agy-cli'), GLMPS_CODEX_DIR: path.join(base, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'), GLMPS_HERMES_DIR: path.join(base, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(base, 'opencode') },
  };
}

const k = (p) => p.replace(/\\/g, '/').toLowerCase();
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let sharedE;
let sharedSrv;

before(async () => {
  sharedE = mkEnv();
  sharedSrv = await startServer({ port: 0, pollMs: 100000, env: sharedE.env, configFile: sharedE.configFile });
});

beforeEach(() => {
  if (sharedE) {
    fs.rmSync(path.join(sharedE.stateDir, 'graphs'), { recursive: true, force: true });
    fs.rmSync(path.join(sharedE.stateDir, 'state'), { recursive: true, force: true });
  }
});

after(async () => {
  await sharedSrv?.close();
});

test('GET /api/graph: ship is the default scope, an unknown scope is refused, no project serves the merged ship graph', async () => {
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  assert.equal((await fetch(`${base}/api/graph?scope=global`)).status, 400);
  let body = await (await fetch(`${base}/api/graph`)).json();
  assert.equal(body.scope, 'ship');
  assert.equal(body.graph, null);
  assert.equal(body.graphLabel, 'Ship graph');

  const shipDir = path.join(sharedE.stateDir, 'graphs', 'ship');
  fs.mkdirSync(shipDir, { recursive: true });
  fs.writeFileSync(path.join(shipDir, 'graph.json'), JSON.stringify({ nodes: [{ id: 'k', label: 'k.js', source_file: 'k.js', community: 0 }], links: [] }));
  body = await (await fetch(`${base}/api/graph?scope=ship`)).json();
  assert.ok(body.graph, 'merged ship graph served');
  assert.equal(body.graphLabel, 'Ship graph (kernel + corpus)');

  body = await (await fetch(`${base}/api/graph?project=${encodeURIComponent(sharedE.repoA)}`)).json();
  assert.equal(body.scope, 'ship');
  assert.ok(body.graph, 'a project keeps its own graph under ship scope');
  assert.match(body.graphLabel, /repo-a/);
});

test('machine scan: candidates with reasons, opt-in persists and needs the scan on, non-candidates refused', async () => {
  const base = `http://127.0.0.1:${sharedSrv.port}`;
  let view = await (await fetch(`${base}/api/graph/machine`)).json();
  assert.equal(view.enabled, false);
  assert.equal(view.actorEnabled, true);
  const a = () => view.roots.find((r) => k(r.root) === k(sharedE.repoA));
  assert.equal(a().scope, 'machine');
  assert.equal(a().reason, 'additionalDirectories');
  assert.equal(a().optedIn, false);
  const plain = view.roots.find((r) => k(r.root) === k(sharedE.plain));
  assert.deepEqual([plain.scope, plain.reason], ['excluded', 'not a git repo']);
  assert.ok(view.roots.some((r) => r.scope === 'ship' && r.reason === 'kernel repo'));

  view = await (await post(base, '/api/graph/machine', { root: sharedE.repoA, optIn: true })).json();
  assert.equal(a().optedIn, false, 'an opt-in does nothing while the scan is off');
  view = await (await post(base, '/api/graph/machine', { enabled: true })).json();
  assert.equal(view.enabled, true);
  assert.equal(a().optedIn, true);
  const saved = JSON.parse(fs.readFileSync(path.join(sharedE.stateDir, 'state', 'graph-machine.json'), 'utf-8'));
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.optIn.map(k), [k(sharedE.repoA)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(sharedE.configFile, 'utf-8')), {}, 'config.json untouched');

  view = await (await post(base, '/api/graph/machine', { root: sharedE.repoA, optIn: false })).json();
  assert.equal(a().optedIn, false);

  assert.equal((await post(base, '/api/graph/machine', { root: sharedE.plain, optIn: true })).status, 409);
  assert.equal((await post(base, '/api/graph/machine', { root: 'D:/nowhere', optIn: true })).status, 404);
  assert.equal((await post(base, '/api/graph/machine', { root: sharedE.repoA })).status, 400);
  assert.equal((await post(base, '/api/graph/machine', {})).status, 400);
});

test('the rebuild tick builds the first graph of an opted-in repo that has none, and skips one not opted in', async () => {
  const e = mkEnv();
  fs.rmSync(path.join(e.repoB, 'graphify-out'), { recursive: true });
  const spawned = [];
  const srv = await startServer({
    port: 0, pollMs: 100000, env: e.env, configFile: e.configFile,
    spawnGraphifyUpdate: async (root) => { spawned.push(k(root)); return { code: 0, stdout: '', stderr: '' }; },
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    await post(base, '/api/graph/machine', { enabled: true });
    await post(base, '/api/graph/machine', { root: e.repoB, optIn: true });
    await srv.graphRebuildTick();
    assert.ok(spawned.includes(k(e.repoB)), `first build of the opted-in repo: ${JSON.stringify(spawned)}`);
    assert.equal(spawned.includes(k(e.repoA)), false, 'repo-a has a graph but is not opted in');
  } finally { await srv.close(); }
});

test('merged machine graph: built from opted-in repos only, served for scope=machine, never into the ship graph', async () => {
  const e = mkEnv();
  const merges = [];
  const mergeGraphs = async (files, out) => {
    merges.push(files);
    const nodes = files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf-8')).nodes);
    fs.writeFileSync(out, JSON.stringify({ nodes, links: [] }));
    return { code: 0, stdout: '', stderr: '' };
  };
  const srv = await startServer({ port: 0, pollMs: 100000, env: e.env, configFile: e.configFile, mergeGraphs });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    let r = await (await post(base, '/api/graph/machine/build', {})).json();
    assert.deepEqual(r, { built: false, reason: 'machine scan is off' });
    await post(base, '/api/graph/machine', { enabled: true });
    r = await (await post(base, '/api/graph/machine/build', {})).json();
    assert.deepEqual(r, { built: false, reason: 'no opted-in repo has a graph' });

    await post(base, '/api/graph/machine', { root: e.repoA, optIn: true });
    r = await (await post(base, '/api/graph/machine/build', {})).json();
    assert.equal(r.built, true);
    assert.equal(merges.length, 0, 'one repo is copied, not merged');
    let g = await (await fetch(`${base}/api/graph?scope=machine`)).json();
    assert.equal(g.scope, 'machine');
    assert.equal(g.graphLabel, 'Machine graph (1 repo)');
    assert.ok(g.graph);

    await post(base, '/api/graph/machine', { root: e.repoB, optIn: true });
    const run = await srv.loopRegistry.runNow('graph-machine-merge', {});
    assert.equal(run.outcome, 'done', `the registered loop rebuilds when the root set changes: ${JSON.stringify(run)}`);
    assert.equal(merges.length, 1);
    assert.equal((await srv.loopRegistry.runNow('graph-machine-merge', {})).outcome, 'nothing-to-do');
    assert.deepEqual((await srv.graphMachineScanTick()).reason, 'up to date');
    g = await (await fetch(`${base}/api/graph?scope=machine`)).json();
    assert.equal(g.graphLabel, 'Machine graph (2 repos)');
    assert.equal(fs.existsSync(path.join(e.stateDir, 'graphs', 'ship')), false, 'ship graph dir untouched');
  } finally { await srv.close(); }
});
