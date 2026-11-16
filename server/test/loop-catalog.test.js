// affected-tests: always
// Routes under test: server/lib/routes/loops-routes.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { LOOP_ABOUT, GRAPH_CATALOG } from '../lib/loops/loop-about.js';

const GROUPS = new Set(['ship', 'learn', 'graphs', 'feeds']);
const MODES = new Set(['reads', 'writes', 'indirect']);

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loop-catalog-'));
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

const base = { trigger: { external: 'test' }, maker: async () => ({ outcome: 'done' }), checker: async () => ({ ok: true }),
  ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1000 }, sla: { maxAgeMs: 60000, obligation: false } };

test('LOOP_ABOUT covers the 30 loops with valid groups and steering modes', () => {
  assert.equal(Object.keys(LOOP_ABOUT).length, 30);
  for (const [name, about] of Object.entries(LOOP_ABOUT)) {
    assert.ok(GROUPS.has(about.group), `${name} group`);
    assert.ok(about.why && about.produces, `${name} why/produces`);
    for (const s of about.steers) { assert.ok(s.card && MODES.has(s.mode), `${name} steer ${s.card}`); }
  }
  assert.equal(GRAPH_CATALOG.length, 9);
});

test('describe() returns about for a described loop and null for an undescribed one', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loop-describe-'));
  const reg = createLoopRegistry({ stateDir });
  reg.registerLoop({ ...base, name: 'launch-queue' });
  reg.registerLoop({ ...base, name: 'fixture-own', about: { group: 'feeds', why: 'w', produces: 'p', steers: [] } });
  reg.registerLoop({ ...base, name: 'fixture-none' });
  const d = Object.fromEntries(reg.describe().map((x) => [x.name, x.about]));
  assert.equal(d['launch-queue'].group, 'ship');
  assert.equal(d['fixture-own'].why, 'w');
  assert.equal(d['fixture-none'], null);
  assert.ok(!('about' in reg.snapshot()['launch-queue']), 'snapshot shape unchanged');
  reg.stop();
});

test('GET /api/loops/catalog joins health with about and lists graphs', async () => {
  const srv = await startServer({ port: 0, env: mkEnv(), pollMs: 100000, restartFn: () => {} });
  try {
    const url = `http://127.0.0.1:${srv.port}`;
    srv.loopRegistry.registerLoop({ ...base, name: 'fixture-cat', about: { group: 'feeds', why: 'a fixture', produces: 'nothing', steers: [] } });
    const r = await fetch(`${url}/api/loops/catalog`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const row = body.loops.find((l) => l.name === 'fixture-cat');
    assert.equal(row.about.why, 'a fixture');
    assert.equal(row.consecutiveFailures, 0);
    assert.ok('lastOutcome' in row && 'trigger' in row && 'sla' in row);
    assert.equal(body.graphs.length, 9);
    assert.equal(typeof body.generatedAt, 'number');
    assert.equal((await fetch(`${url}/api/loops/fixture-cat`)).status, 200, 'detail route still works');
  } finally { await srv.close(); }
});
