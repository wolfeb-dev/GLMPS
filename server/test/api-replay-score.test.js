// GET /api/replay/:id/score (glmps-24): per-task replay scorecard.
// Server-boot harness copied from server/test/api-replay-run.test.js.
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replayscore-'));
  const claudeDir = claudeTmp();
  tmpDirs.push(stateDir, claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  return { h, stateDir, url: `http://127.0.0.1:${h.port}` };
}

test('GET /api/replay/:id/score with unknown id -> 404', async () => {
  const { h, url } = await boot();
  try {
    const res = await fetch(`${url}/api/replay/nope/score`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no replay task/i);
  } finally { await h.close(); }
});

test('GET /api/replay/:id/score with a baseline but no run yet -> hasRun:false, score:null', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-1', unit: 'replay-baseline', ts: 1000, turns: 3 });
    addReplayTask(stateDir, { id: 'rt1', project: 'demo', promptFile: null, baseline });
    const res = await fetch(`${url}/api/replay/rt1/score`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taskId, 'rt1');
    assert.equal(body.hasBaseline, true);
    assert.equal(body.hasRun, false);
    assert.equal(body.score, null);
    assert.equal(body.produced, null);
  } finally { await h.close(); }
});

test('GET /api/replay/:id/score scores the most recent non-baseline run against the frozen baseline', async () => {
  const { h, url, stateDir } = await boot();
  try {
    const baseline = emptyOutcome({ id: 'base-2', unit: 'replay-baseline', ts: 1000, turns: 5, verifier: { exitOk: false } });
    addReplayTask(stateDir, { id: 'rt2', project: 'demo', promptFile: null, baseline });

    // A replay-baseline re-run for this task must be excluded from "produced".
    appendOutcome(stateDir, emptyOutcome({
      id: 'row-baseline-rerun', unit: 'replay-baseline', ts: 2000, turns: 5,
      extra: { replayTask: 'rt2' },
    }));
    // An older challenger run - should be superseded by the newer one below.
    appendOutcome(stateDir, emptyOutcome({
      id: 'row-old', unit: 'model-x', ts: 3000, turns: 9, verifier: { exitOk: false },
      extra: { replayTask: 'rt2' },
    }));
    // The most recent challenger run (higher ts) - this is the one that should be scored.
    appendOutcome(stateDir, emptyOutcome({
      id: 'row-new', unit: 'model-x', ts: 4000, turns: 3, verifier: { exitOk: true },
      extra: { replayTask: 'rt2' },
    }));
    // A row for a DIFFERENT task - must not leak in.
    appendOutcome(stateDir, emptyOutcome({
      id: 'row-other-task', unit: 'model-x', ts: 5000, turns: 1,
      extra: { replayTask: 'some-other-task' },
    }));

    const res = await fetch(`${url}/api/replay/rt2/score`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hasBaseline, true);
    assert.equal(body.hasRun, true);
    assert.equal(body.produced.id, 'row-new');
    assert.ok(body.score);
    assert.equal(body.score.perMetric.turns, 'better'); // 3 < 5, lower-is-better
    assert.equal(body.score.perMetric['verifier.exitOk'], 'better'); // true vs false
    assert.ok(body.score.improved.includes('turns'));
    assert.ok(body.score.improved.includes('verifier.exitOk'));
    assert.equal(body.score.regressed.length, 0);
  } finally { await h.close(); }
});

test('GET /api/replay/:id/score with no baseline and a run -> score:null, hasRun:true', async () => {
  const { h, url, stateDir } = await boot();
  try {
    addReplayTask(stateDir, { id: 'rt3', project: 'demo', promptFile: null, baseline: null });
    appendOutcome(stateDir, emptyOutcome({
      id: 'row-1', unit: 'model-x', ts: 1000, turns: 3,
      extra: { replayTask: 'rt3' },
    }));
    const res = await fetch(`${url}/api/replay/rt3/score`);
    const body = await res.json();
    assert.equal(body.hasBaseline, false);
    assert.equal(body.hasRun, true);
    assert.equal(body.score, null);
  } finally { await h.close(); }
});
