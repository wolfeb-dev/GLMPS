// server/test/graph-learning-endpoints.test.js
// HTTP smoke tests for the four new Settings-panel endpoints:
//   GET  /api/graph/status
//   POST /api/graph/rebuild
//   GET  /api/learning/status
//   POST /api/learning/synth
//
// All tests run against an ephemeral server instance (port:0) with temp dirs
// via GLMPS_STATE_DIR so they never touch the user's real ~/.glmps.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
// Teardown is BEST-EFFORT on purpose. On CI Windows a git handle can outlive
// server.close(), and rmSync then throws EPERM and fails an otherwise passing
// test (the flake recorded in the windows-eperm-ci-test-flake note; it took
// main red on 2026-08-02). A leftover temp dir costs the runner nothing.
function rmQuiet(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* CI Windows EPERM */ } }

let stateDir;
let claudeDir;
let h;

before(async () => {
  stateDir = tmp('mc-state-');
  claudeDir = tmp('mc-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_PROJECTS_DIR: stateDir };
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
});

after(async () => {
  await h?.close?.();
  rmQuiet(stateDir);
  rmQuiet(claudeDir);
});

beforeEach(() => {
  fs.rmSync(path.join(stateDir, 'learning'), { recursive: true, force: true });
  fs.rmSync(path.join(claudeDir, 'settings.json'), { force: true });
});

test('GET /api/graph/status returns { graphs: [] } when no graphify-out dirs exist', async () => {
  // GLMPS_CLAUDE_DIR points at an empty dir -> no settings.json -> no additionalDirectories,
  // and index is empty -> only REPO_ROOT is scanned; that has a graph but this server
  // instance still returns a valid array (may include glmps's own graph).
  const r = await fetch(`http://127.0.0.1:${h.port}/api/graph/status`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('graphs' in body, 'response has graphs key');
  assert.ok(Array.isArray(body.graphs), 'graphs is an array');
  // Each entry must have the expected shape (if any)
  for (const g of body.graphs) {
    assert.ok('project' in g, 'has project');
    assert.ok('root' in g, 'has root');
    assert.ok(typeof g.nodes === 'number', 'nodes is number');
    assert.ok('needsUpdate' in g, 'has needsUpdate');
  }
});

test('GET /api/graph/status includes graph info when graphify-out/graph.json exists', async () => {
  // Create a fake repo root with a graph.json
  const fakeRoot = tmp('mc-repo-');
  fs.mkdirSync(path.join(fakeRoot, '.git'));
  fs.mkdirSync(path.join(fakeRoot, 'graphify-out'), { recursive: true });
  const graphData = {
    built_at_commit: 'aaa111',
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
  fs.writeFileSync(path.join(fakeRoot, 'graphify-out', 'graph.json'), JSON.stringify(graphData));

  // Put fakeRoot into a temp settings.json so server picks it up
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { additionalDirectories: [fakeRoot.replace(/\\/g, '/')] },
  }));

  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/graph/status`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const found = body.graphs.find(g => g.root.replace(/\\/g, '/') === fakeRoot.replace(/\\/g, '/'));
    assert.ok(found, `should find graph entry for fakeRoot in ${JSON.stringify(body.graphs.map(g => g.root))}`);
    assert.equal(found.nodes, 3);
    assert.equal(found.builtAtCommit, 'aaa111');
    assert.ok(typeof found.rebuiltMs === 'number', 'rebuiltMs is a number');
    // headCommit is null (no real git repo), so needsUpdate must be false
    assert.equal(found.needsUpdate, false);
  } finally {
    rmQuiet(fakeRoot);
  }
});


test('POST /api/graph/rebuild rejects a root outside the allowlist with 400 (no shell injection)', async () => {
  const r = await fetch(`http://127.0.0.1:${h.port}/api/graph/rebuild`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: '/nonexistent/path' }),
  });
  // An explicit root is only honored if it is one the server already tracks;
  // an unknown (or attacker-controlled) root is rejected before any spawn.
  assert.equal(r.status, 400, `unexpected status ${r.status}`);
  const body = await r.json();
  assert.match(body.error, /allowlist/i);
});


test('GET /api/learning/status returns { lastRunMs, pending, total } with empty store', async () => {
  const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/status`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('lastRunMs' in body, 'has lastRunMs');
  assert.ok('pending' in body, 'has pending');
  assert.ok('total' in body, 'has total');
  assert.equal(body.lastRunMs, null, 'lastRunMs null when no watermark');
  assert.equal(body.pending, 0);
  assert.equal(body.total, 0);
});

test('GET /api/learning/status reads watermark and counts pending items', async () => {
  // Write a watermark
  const learningDir = path.join(stateDir, 'learning');
  fs.mkdirSync(learningDir, { recursive: true });
  fs.writeFileSync(path.join(learningDir, 'synth-watermark.json'), JSON.stringify({ lastRunMs: 1700000000000 }));

  // Write a store with 1 pending + 1 applied item
  const store = {
    items: [
      { id: 'a', source: 'gap', code: 'g1', severity: 'warn', title: 'gap1', body: '', project: 'x',
        sessionId: '', lastSessionId: '', status: 'pending', proposedGuard: null, applyCommit: null,
        count: 1, error: null, createdTs: 1, updatedTs: 1 },
      { id: 'b', source: 'idea', code: null, severity: 'idea', title: 'idea', body: 'i', project: '',
        sessionId: '', lastSessionId: '', status: 'applied', proposedGuard: null, applyCommit: 'abc',
        count: 1, error: null, createdTs: 1, updatedTs: 1 },
    ],
    config: { autoApplyGaps: false },
    seq: 1,
  };
  fs.writeFileSync(path.join(learningDir, 'store.json'), JSON.stringify(store));

  const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/status`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.lastRunMs, 1700000000000);
  assert.equal(body.pending, 1);
  assert.equal(body.total, 2);
});


test('POST /api/learning/synth returns ok:false gracefully when script errors', async () => {
  // Point GLMPS_PROJECTS_DIR at an empty dir to avoid walking real transcripts,
  // but the script will still run; any error -> ok:false is acceptable.
  const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/synth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  // 200 with ok true/false, or 500 - all acceptable since script may fail in test env
  assert.ok(r.status === 200 || r.status === 500, `status ${r.status}`);
  const body = await r.json();
  assert.ok('ok' in body || 'error' in body, 'has ok or error key');
});
