// POST /api/replay/:id/baseline-refresh (glmps-26): re-freeze a
// task's baseline from a later known-good run. addReplayTask only ever sets
// a baseline ONCE (a no-op re-call on an existing id) -- this is the missing
// action route to move that comparison point forward. Server-boot harness
// copied from server/test/api-replay-score.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { addReplayTask, listReplayTasks } from '../lib/evaluation/replay-set.js';
import { appendOutcome } from '../lib/evaluation/outcome-store.js';
import { emptyOutcome } from '../lib/evaluation/outcome-record.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
});

async function boot() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replaybaseline-'));
  const claudeDir = claudeTmp();
  tmpDirs.push(stateDir, claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  return { h, stateDir, url: `http://127.0.0.1:${h.port}` };
}

async function postJson(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json; try { json = await r.json(); } catch { json = null; }
  return { status: r.status, body: json };
}

test('POST /api/replay/:id/baseline-refresh with unknown id -> 404', async () => {
  const { h, url } = await boot();
  try {
    const r = await postJson(url, '/api/replay/nope/baseline-refresh');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no replay task/i);
  } finally { await h.close(); }
});

test('POST /api/replay/:id/baseline-refresh with no runs yet -> 400, baseline unchanged', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-1', unit: 'replay-baseline', ts: 1000, turns: 5 });
    addReplayTask(stateDir, { id: 'rt1', project: 'demo', baseline });
    const r = await postJson(url, '/api/replay/rt1/baseline-refresh');
    assert.equal(r.status, 400);
    assert.equal(listReplayTasks(stateDir).find(t => t.id === 'rt1').baseline.turns, 5);
  } finally { await h.close(); }
});

test('POST /api/replay/:id/baseline-refresh with no ts in the body defaults to the most recent run', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-2', unit: 'replay-baseline', ts: 1000, turns: 5 });
    addReplayTask(stateDir, { id: 'rt2', project: 'demo', baseline });
    appendOutcome(stateDir, emptyOutcome({ id: 'row-old', unit: 'model-x', ts: 2000, turns: 4, extra: { replayTask: 'rt2' } }));
    appendOutcome(stateDir, emptyOutcome({ id: 'row-new', unit: 'model-x', ts: 3000, turns: 2, extra: { replayTask: 'rt2' } }));

    const r = await postJson(url, '/api/replay/rt2/baseline-refresh');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.task.baseline.id, 'row-new');
    assert.ok(r.body.task.baselineRefreshedAt);

    // Persisted, not just in the response.
    const persisted = listReplayTasks(stateDir).find(t => t.id === 'rt2');
    assert.equal(persisted.baseline.turns, 2);

    // The task's original createdAt survives the refresh.
    assert.ok(persisted.createdAt);
  } finally { await h.close(); }
});

test('POST /api/replay/:id/baseline-refresh with an explicit { ts } picks THAT run, not the most recent', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-3', unit: 'replay-baseline', ts: 1000, turns: 5 });
    addReplayTask(stateDir, { id: 'rt3', project: 'demo', baseline });
    appendOutcome(stateDir, emptyOutcome({ id: 'row-reviewed', unit: 'model-x', ts: 2000, turns: 4, extra: { replayTask: 'rt3' } }));
    appendOutcome(stateDir, emptyOutcome({ id: 'row-latest-but-regressed', unit: 'model-x', ts: 3000, turns: 9, extra: { replayTask: 'rt3' } }));

    const r = await postJson(url, '/api/replay/rt3/baseline-refresh', { ts: 2000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.task.baseline.id, 'row-reviewed');
  } finally { await h.close(); }
});

test('POST /api/replay/:id/baseline-refresh with a ts that has no matching run -> 404', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-4', unit: 'replay-baseline', ts: 1000, turns: 5 });
    addReplayTask(stateDir, { id: 'rt4', project: 'demo', baseline });
    appendOutcome(stateDir, emptyOutcome({ id: 'row-1', unit: 'model-x', ts: 2000, turns: 4, extra: { replayTask: 'rt4' } }));

    const r = await postJson(url, '/api/replay/rt4/baseline-refresh', { ts: 9999 });
    assert.equal(r.status, 404);
  } finally { await h.close(); }
});
