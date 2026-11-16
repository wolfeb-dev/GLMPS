// GET /api/replay/:id/history (glmps-26): per-task run
// history/trend - every produced run for a task scored against its frozen
// baseline, oldest to newest, unlike /score (glmps-24) which only
// ever surfaces the single most-recent run. Server-boot harness copied from
// server/test/api-replay-score.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { addReplayTask } from '../lib/evaluation/replay-set.js';
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replayhist-'));
  const claudeDir = claudeTmp();
  tmpDirs.push(stateDir, claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  return { h, stateDir, url: `http://127.0.0.1:${h.port}` };
}

test('GET /api/replay/:id/history with unknown id -> 404', async () => {
  const { h, url } = await boot();
  try {
    const res = await fetch(`${url}/api/replay/nope/history`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no replay task/i);
  } finally { await h.close(); }
});

test('GET /api/replay/:id/history with a baseline and no runs -> empty history array', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-1', unit: 'replay-baseline', ts: 1000, turns: 3 });
    addReplayTask(stateDir, { id: 'rt1', project: 'demo', baseline });
    const res = await fetch(`${url}/api/replay/rt1/history`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taskId, 'rt1');
    assert.equal(body.hasBaseline, true);
    assert.deepEqual(body.history, []);
  } finally { await h.close(); }
});

test('GET /api/replay/:id/history returns every run for this task scored against the baseline, oldest first', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-2', unit: 'replay-baseline', ts: 1000, turns: 5 });
    addReplayTask(stateDir, { id: 'rt2', project: 'demo', baseline });

    // Out-of-order inserts on purpose - the route must still return oldest-first.
    appendOutcome(stateDir, emptyOutcome({ id: 'row-c', unit: 'model-x', ts: 4000, turns: 3, extra: { replayTask: 'rt2' } })); // better
    appendOutcome(stateDir, emptyOutcome({ id: 'row-a', unit: 'model-x', ts: 2000, turns: 9, extra: { replayTask: 'rt2' } })); // worse
    appendOutcome(stateDir, emptyOutcome({ id: 'row-b', unit: 'model-x', ts: 3000, turns: 5, extra: { replayTask: 'rt2' } })); // same
    // The baseline re-run row must be excluded (unit === 'replay-baseline').
    appendOutcome(stateDir, emptyOutcome({ id: 'row-baseline-rerun', unit: 'replay-baseline', ts: 3500, turns: 5, extra: { replayTask: 'rt2' } }));
    // A row for a different task must not leak in.
    appendOutcome(stateDir, emptyOutcome({ id: 'row-other', unit: 'model-x', ts: 5000, turns: 1, extra: { replayTask: 'some-other-task' } }));

    const res = await fetch(`${url}/api/replay/rt2/history`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.history.length, 3);
    assert.deepEqual(body.history.map(h => h.produced.id), ['row-a', 'row-b', 'row-c']);
    assert.equal(body.history[0].score.perMetric.turns, 'worse');
    assert.equal(body.history[1].score.perMetric.turns, 'same');
    assert.equal(body.history[2].score.perMetric.turns, 'better');
  } finally { await h.close(); }
});

test('GET /api/replay/:id/history with no baseline -> hasBaseline:false, empty history (never scores against nothing)', async () => {
  const { h, url, stateDir } = await boot();
  try {
    addReplayTask(stateDir, { id: 'rt3', project: 'demo', baseline: null });
    appendOutcome(stateDir, emptyOutcome({ id: 'row-1', unit: 'model-x', ts: 1000, turns: 3, extra: { replayTask: 'rt3' } }));
    const res = await fetch(`${url}/api/replay/rt3/history`);
    const body = await res.json();
    assert.equal(body.hasBaseline, false);
    assert.deepEqual(body.history, []);
  } finally { await h.close(); }
});
