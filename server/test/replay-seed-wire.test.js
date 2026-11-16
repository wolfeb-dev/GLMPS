// glmps-82: seedFromOutcomes existed but had zero callers outside its own
// test, so the replay/eval set was never populated (GET /api/replay always
// empty, mSPRT/CUPED have no paired samples to run over). These tests cover
// the wiring: seedReplaySet() (read outcomes -> stratified-sample -> persist)
// and the POST /api/replay/seed route that fronts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedReplaySet, DEFAULT_SEED_N } from '../lib/evaluation/replay-seed.js';
import { appendOutcome } from '../lib/evaluation/outcome-store.js';
import { listReplayTasks } from '../lib/evaluation/replay-set.js';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

function tmpStateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replayseed-'));
  tmpDirs.push(d);
  return d;
}

// A "known-good" OutcomeRow: committed, verifier passed, never reverted - 
// the subset seedFromOutcomes accepts.
function goodRow(id, { taskClass = 'feature', unit = 'champion', turns = 4 } = {}) {
  return { id, taskClass, unit, turns, committed: true, verifier: { exitOk: true }, revertedLater: false };
}
function badRow(id, patch = {}) {
  return { id, taskClass: 'feature', unit: 'champion', committed: false, verifier: { exitOk: true }, revertedLater: false, ...patch };
}

test('seedReplaySet populates tasks.json from committed/verified outcomes', () => {
  const stateDir = tmpStateDir();
  appendOutcome(stateDir, goodRow('a1', { taskClass: 'feature', unit: 'champion' }));
  appendOutcome(stateDir, goodRow('a2', { taskClass: 'feature', unit: 'challenger' }));
  appendOutcome(stateDir, goodRow('b1', { taskClass: 'debug', unit: 'champion' }));
  appendOutcome(stateDir, badRow('x1')); // not committed -> excluded

  const summary = seedReplaySet(stateDir, { n: 6 });

  assert.equal(typeof summary.added, 'number');
  assert.equal(typeof summary.skipped, 'number');
  assert.equal(typeof summary.total, 'number');
  assert.equal(summary.added, 3); // a1, a2, b1 qualify; x1 does not
  assert.equal(summary.skipped, 0);
  assert.equal(summary.total, 3);

  const tasks = listReplayTasks(stateDir);
  assert.equal(tasks.length, 3);
  const ids = tasks.map(t => t.id).sort();
  assert.deepEqual(ids, ['replay-a1', 'replay-a2', 'replay-b1']);
});

test('seeded tasks are labeled cohorts: frozen task + expected outcome, paired per unit', () => {
  const stateDir = tmpStateDir();
  appendOutcome(stateDir, goodRow('c1', { taskClass: 'feature', unit: 'champion', turns: 3 }));
  appendOutcome(stateDir, goodRow('c2', { taskClass: 'feature', unit: 'challenger', turns: 5 }));

  seedReplaySet(stateDir, { n: 6 });
  const tasks = listReplayTasks(stateDir).sort((a, b) => a.id.localeCompare(b.id));

  assert.equal(tasks.length, 2);
  // Each task carries the full baseline OutcomeRow (the "expected outcome"
  // label), including the `unit` field that later pairs champion vs
  // challenger runs of this same frozen task.
  assert.equal(tasks[0].id, 'replay-c1');
  assert.equal(tasks[0].baseline.id, 'c1');
  assert.equal(tasks[0].baseline.unit, 'champion');
  assert.equal(tasks[0].baseline.turns, 3);
  assert.equal(tasks[0].promptFile, null);

  assert.equal(tasks[1].id, 'replay-c2');
  assert.equal(tasks[1].baseline.unit, 'challenger');
  assert.equal(tasks[1].baseline.turns, 5);
});

test('seedReplaySet is idempotent: re-running does not duplicate', () => {
  const stateDir = tmpStateDir();
  appendOutcome(stateDir, goodRow('d1'));
  appendOutcome(stateDir, goodRow('d2'));

  const first = seedReplaySet(stateDir, { n: 6 });
  assert.equal(first.added, 2);

  const second = seedReplaySet(stateDir, { n: 6 });
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.equal(second.total, 2);
  assert.equal(listReplayTasks(stateDir).length, 2);
});

test('seedReplaySet honors n, distributing across task classes', () => {
  const stateDir = tmpStateDir();
  // 10 qualifying rows across 2 classes; ask for a small target n.
  for (let i = 0; i < 5; i++) appendOutcome(stateDir, goodRow(`f${i}`, { taskClass: 'feature' }));
  for (let i = 0; i < 5; i++) appendOutcome(stateDir, goodRow(`g${i}`, { taskClass: 'debug' }));

  const summary = seedReplaySet(stateDir, { n: 4 });
  // Distributed roughly evenly across the 2 classes present (ceil(4/2)=2 each).
  assert.ok(summary.total <= 4, `expected total <= 4, got ${summary.total}`);
  assert.ok(summary.total >= 2, `expected total >= 2, got ${summary.total}`);
});

test('seedReplaySet defaults n to DEFAULT_SEED_N (10-20 range per Open Question 4)', () => {
  assert.ok(DEFAULT_SEED_N >= 10 && DEFAULT_SEED_N <= 20, `DEFAULT_SEED_N=${DEFAULT_SEED_N} out of 10-20 range`);

  const stateDir = tmpStateDir();
  appendOutcome(stateDir, goodRow('e1'));
  const summary = seedReplaySet(stateDir); // no opts -> default n
  assert.equal(summary.added, 1);
});


async function boot() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-replayseed-route-'));
  const claudeDir = claudeTmp();
  tmpDirs.push(stateDir, claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  return { h, stateDir, url: `http://127.0.0.1:${h.port}` };
}

test('POST /api/replay/seed returns a summary and GET /api/replay reflects it', async () => {
  const { h, url, stateDir } = await boot();
  try {
    appendOutcome(stateDir, goodRow('r1', { taskClass: 'feature' }));
    appendOutcome(stateDir, goodRow('r2', { taskClass: 'debug' }));

    const res = await fetch(`${url}/api/replay/seed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 8 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.added, 2);
    assert.equal(body.skipped, 0);
    assert.equal(body.total, 2);

    const getRes = await fetch(`${url}/api/replay`);
    const getBody = await getRes.json();
    assert.equal(getBody.tasks.length, 2);
    assert.deepEqual(getBody.tasks.map(t => t.id).sort(), ['replay-r1', 'replay-r2']);
  } finally { await h.close(); }
});

test('POST /api/replay/seed with no body uses the default n', async () => {
  const { h, url, stateDir } = await boot();
  try {
    appendOutcome(stateDir, goodRow('s1'));
    const res = await fetch(`${url}/api/replay/seed`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.added, 1);
    assert.equal(body.total, 1);
  } finally { await h.close(); }
});

test('POST /api/replay/seed with invalid json body is a 400', async () => {
  const { h, url } = await boot();
  try {
    const res = await fetch(`${url}/api/replay/seed`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  } finally { await h.close(); }
});
