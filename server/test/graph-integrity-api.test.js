// End to end through a real server: a graph collapse reaches the alert center
// (upgrade-plan item 7), and a verified no-op turns a stale graph fresh
// (item 7b step 3). graphify is injected via spawnGraphifyUpdate, which writes
// graph.json the way the real binary would, so no real graphify runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpRoot } from './helpers/tmp.js';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { gitProbeAsync } from '../lib/observability/graph-scope.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function graphOf(n, builtAtCommit) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `fn${i}()`, source_file: `src/f${i % 50}.js` }));
  const links = nodes.slice(1).map((x, i) => ({ source: x.id, target: nodes[i].id }));
  return { built_at_commit: builtAtCommit, nodes, links };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function mkEnv() {
  const base = fs.mkdtempSync(path.join(tmpRoot(), 'mc-graph-int-')); tmpDirs.push(base);
  const claudeDir = path.join(base, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'proj');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'graphify-out'), { recursive: true });
  const transcript = path.join(projDir, 'sess1.jsonl');
  fs.writeFileSync(transcript, '');
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'),
    JSON.stringify([{ sessionId: 'sess1', ppid: process.pid, cwd: projectRoot, transcriptPath: transcript, ts: Date.now() }]));
  // /api/graph and /api/graph/rebuild only answer for an allowlisted root.
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [projectRoot.replace(/\\/g, '/')] },
  }));
  // The shape sampler acts only on in-scope roots (card glmps-2-0-93):
  // configFile opts the project in; without it the root is out of scope.
  git(projectRoot, 'init', '-q');
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ graph: { machine: { enabled: true, include: [projectRoot] } } }));
  return {
    projectRoot,
    configFile,
    base,
    graphFile: path.join(projectRoot, 'graphify-out', 'graph.json'),
    env: { GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
           GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode-storage'),
           GLMPS_AGY_CLI_DIR: path.join(base, 'agy-cli'), GLMPS_CODEX_DIR: path.join(base, 'codex'),
           GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'), GLMPS_HERMES_DIR: path.join(base, 'hermes'),
           GLMPS_OPENCODE_DIR: path.join(base, 'opencode') },
  };
}

async function rebuild(srv, root) {
  const res = await fetch(`http://127.0.0.1:${srv.port}/api/graph/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

async function integrityAlerts(srv) {
  const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/alerts`)).json();
  return body.alerts.filter(a => a.source === 'graph-integrity');
}

test('a rebuild that collapses a graph from N to under 10 percent of N raises a visible alert', { timeout: 30000 }, async () => {
  const { env, projectRoot, graphFile } = mkEnv();
  fs.writeFileSync(graphFile, JSON.stringify(graphOf(2000, 'c1')));
  let nextNodes = 2000;
  const srv = await startServer({
    port: 0, pollMs: 100000, env,
    // Reports success, as the collapse did in July: the outcome alone says "updated".
    spawnGraphifyUpdate: async () => {
      fs.writeFileSync(graphFile, JSON.stringify(graphOf(nextNodes, 'c2')));
      return { code: 0, stdout: `Rebuilt: ${nextNodes} nodes`, stderr: '' };
    },
  });
  try {
    await rebuild(srv, projectRoot);
    assert.equal((await integrityAlerts(srv)).length, 0, 'a healthy baseline raises nothing');

    nextNodes = 55;
    await rebuild(srv, projectRoot);
    const alerts = await integrityAlerts(srv);
    assert.equal(alerts.length, 1, 'expected one graph-integrity alert');
    assert.equal(alerts[0].severity, 'critical');
    assert.equal(alerts[0].title, `Graph collapsed: ${path.basename(projectRoot)}`);
    assert.match(alerts[0].detail, /55 nodes .* down from 2000/);

    const sync = JSON.parse(fs.readFileSync(path.join(env.GLMPS_STATE_DIR, 'state', 'graph-sync-health.json'), 'utf8'));
    assert.deepEqual(Object.keys(sync), [projectRoot.replace(/\\/g, '/')], 'one forward-slash sync-health key per root');
  } finally { await srv.close(); }
});

test('a collapse written outside the server (the post-commit hook) is caught by the sampler', { timeout: 30000 }, async () => {
  const { env, graphFile, configFile } = mkEnv();
  fs.writeFileSync(graphFile, JSON.stringify(graphOf(1000, 'c1')));
  const srv = await startServer({ port: 0, pollMs: 100000, env, configFile });
  try {
    await srv.graphShapeTick();
    assert.equal((await integrityAlerts(srv)).length, 0);
    fs.writeFileSync(graphFile, JSON.stringify(graphOf(40, 'c2')));
    // mtime resolution on some filesystems is coarse; make the rewrite visible.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(graphFile, later, later);
    await srv.graphShapeTick();
    assert.equal((await integrityAlerts(srv)).length, 1);
  } finally { await srv.close(); }
});

test('a verified no-op makes an unchanged-topology repo stop reading stale', { timeout: 30000 }, async () => {
  const { env, projectRoot, graphFile } = mkEnv();
  git(projectRoot, 'init', '-q');
  fs.writeFileSync(path.join(projectRoot, 'a.js'), 'export const a = 1;\n');
  git(projectRoot, 'add', 'a.js');
  git(projectRoot, 'commit', '-q', '-m', 'one');
  const first = git(projectRoot, 'rev-parse', 'HEAD');
  fs.writeFileSync(graphFile, JSON.stringify(graphOf(200, first)));
  // A docs-only commit: HEAD moves, topology does not.
  fs.writeFileSync(path.join(projectRoot, 'README.md'), 'docs\n');
  git(projectRoot, 'add', 'README.md');
  git(projectRoot, 'commit', '-q', '-m', 'docs');
  const head = git(projectRoot, 'rev-parse', 'HEAD');

  const srv = await startServer({
    port: 0, pollMs: 100000, env,
    // graphify's no-op: graph.json and its built_at_commit are left untouched.
    spawnGraphifyUpdate: async () => ({ code: 0, stdout: 'No code-graph topology changes detected; outputs left untouched.', stderr: '' }),
  });
  try {
    const statusOf = async () => {
      const body = await (await fetch(`http://127.0.0.1:${srv.port}/api/graph/status`)).json();
      return body.graphs.find(g => path.resolve(g.root).toLowerCase() === path.resolve(projectRoot).toLowerCase());
    };
    const before = await statusOf();
    assert.equal(before.freshness, 'stale');
    assert.equal(before.builtAtCommit, first);

    const body = await rebuild(srv, projectRoot);
    const after = body.graphs.find(g => path.resolve(g.root).toLowerCase() === path.resolve(projectRoot).toLowerCase());
    assert.equal(after.freshness, 'fresh');
    assert.equal(after.needsUpdate, false);
    assert.equal(after.builtAtCommit, first, 'graph.json itself is not rewritten');
    assert.equal(after.verifiedAtCommit, head);

    const map = await (await fetch(`http://127.0.0.1:${srv.port}/api/graph?project=${encodeURIComponent(projectRoot)}`)).json();
    assert.equal(map.graph.stale, false);
  } finally { await srv.close(); }
});

test('the sampler and the rebuild tick skip a root that only has graphify-out/ (card glmps-2-0-93)', { timeout: 30000 }, async () => {
  const { env, projectRoot, graphFile, configFile } = mkEnv();
  fs.writeFileSync(graphFile, JSON.stringify(graphOf(100, 'c1')));
  // The kernel checkout running the tests is a ship root and may carry its own
  // graphify-out (the post-commit hook builds one), so assert on this root only.
  const mine = (roots) => roots.filter(r => r.replace(/\\/g, '/').toLowerCase() === projectRoot.replace(/\\/g, '/').toLowerCase());
  const spawned = [];
  const spawnGraphifyUpdate = async (root) => { spawned.push(root); return { code: 0, stdout: 'No code-graph topology changes detected', stderr: '' }; };
  const off = await startServer({ port: 0, pollMs: 100000, env, spawnGraphifyUpdate });
  try {
    assert.deepEqual(mine(await off.graphShapeTick()), [], 'a repo with a graph but no opt-in is out of scope');
    await off.graphRebuildTick();
    assert.deepEqual(mine(spawned), []);
  } finally { await off.close(); }

  const on = await startServer({ port: 0, pollMs: 100000, env, configFile, spawnGraphifyUpdate });
  try {
    assert.equal(mine(await on.graphShapeTick()).length, 1);
    await on.graphRebuildTick();
    assert.equal(mine(spawned).length, 1);
  } finally { await on.close(); }
});

// Card glmps-2-0-runtime-73: the live tick re-probed all 1,350 session cwds
// ever seen, every run, and kept spawning git after the registry timed it out.
test('the sampler probes each root once across ticks and probes nothing once aborted', { timeout: 30000 }, async () => {
  const { env, graphFile, configFile, projectRoot } = mkEnv();
  fs.writeFileSync(graphFile, JSON.stringify(graphOf(100, 'c1')));
  const probed = [];
  const graphProbeAsync = async (r) => { probed.push(r); return gitProbeAsync(r); };
  const srv = await startServer({ port: 0, pollMs: 100000, env, configFile, graphProbeAsync });
  try {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(srv.graphShapeTick({ signal: ac.signal }));
    assert.deepEqual(probed, [], 'an aborted tick probes nothing');

    const first = await srv.graphShapeTick();
    assert.ok(probed.some(p => p.toLowerCase() === projectRoot.replace(/\\/g, '/').toLowerCase()), 'first tick probes the root');
    probed.length = 0;
    assert.deepEqual(await srv.graphShapeTick(), first);
    assert.deepEqual(probed, [], 'the second tick spawns no git for already-probed paths');
  } finally { await srv.close(); }
});

test('migrateGraphScopeState archives out-of-scope entries into the snapshot, once', { timeout: 30000 }, async () => {
  const { env, projectRoot, configFile } = mkEnv();
  const stateDir = env.GLMPS_STATE_DIR;
  const fwd = projectRoot.replace(/\\/g, '/');
  const back = projectRoot.replace(/\//g, '\\');
  const entry = (ts) => ({ outcome: 'noop', nodes: 1, existingNodes: 1, reason: '', ts, consecutive: 1 });
  const shape = { last: { nodes: 500, edges: 1, builtAtCommit: null, ts: 1 }, baseline: { nodes: 500, edges: 1, builtAtCommit: null, ts: 1 }, collapsed: false, dropRatio: 0 };
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'graph-sync-health.json'), JSON.stringify({
    [fwd]: entry(1), [back + '\\']: entry(2), 'C:/gone/worktree': entry(3), 'graphify@0.9.95': entry(4),
  }));
  fs.writeFileSync(path.join(stateDir, 'state', 'graph-integrity.json'), JSON.stringify({ [fwd]: shape, 'C:/gone/worktree': shape }));
  const snapshot = path.join(stateDir, 'migrations', 'graphify-settings.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify({ schema: 1, captures: [{ capturedAt: 'baseline' }] }));

  const srv = await startServer({ port: 0, pollMs: 100000, env, configFile });
  try {
    const r = await srv.migrateGraphScopeState();
    assert.equal(r.changed, true, JSON.stringify(r));
    const sync = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'graph-sync-health.json'), 'utf8'));
    assert.deepEqual(Object.keys(sync).map(k => k.toLowerCase()).sort(), ['graphify@0.9.95', fwd.toLowerCase()].sort());
    const integ = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'graph-integrity.json'), 'utf8'));
    assert.deepEqual(Object.keys(integ).map(k => k.toLowerCase()), [fwd.toLowerCase()]);
    assert.equal(Object.values(integ)[0].baseline.nodes, 500, 'in-scope baseline kept');
    const doc = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
    assert.equal(doc.captures[0].capturedAt, 'baseline');
    assert.equal(doc.scopeArchives.length, 1);
    assert.ok(doc.scopeArchives[0].syncHealth['C:/gone/worktree']);
    assert.ok(doc.scopeArchives[0].integrity['C:/gone/worktree']);

    const again = await srv.migrateGraphScopeState();
    assert.equal(again.changed, false);
    assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).scopeArchives.length, 1, 'idempotent');
  } finally { await srv.close(); }
});
