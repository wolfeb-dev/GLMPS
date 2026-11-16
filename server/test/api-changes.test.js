// server/test/api-changes.test.js
// GET /api/changes - the Substrate Loop's unified SystemChange ledger route.
// Route-level (seeded stores) coverage; the pure mapping itself is covered by
// server/test/system-changes.test.js.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { recordShadow } from '../lib/evaluation/shadow-arm.js';
import { appendOutcome } from '../lib/evaluation/outcome-store.js';
import { upsertCandidate } from '../lib/evaluation/skill-adopt-store.js';
import { upsertMeasurable } from '../lib/evaluation/measurables-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

let stateDir;
let claudeDir;
let h;

before(async () => {
  stateDir = tmp('mc-state-');
  claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
});

after(async () => {
  await h?.close?.();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const sub of ['learning', 'shadow', 'outcomes', 'skill-adopt', 'measurables']) {
    fs.rmSync(path.join(stateDir, sub), { recursive: true, force: true });
  }
});

test('GET /api/changes on a fully empty state dir returns shape with empty ledger, never 500s', async () => {
  const r = await fetch(`http://127.0.0.1:${h.port}/api/changes`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.changes, []);
  assert.deepEqual(body.scoreboard, { tracked: 0, netPositive: 0, revertedNoHelp: 0, unmeasured: 0, northStar: null });
});

test('GET /api/changes reflects seeded learning-store + shadow-arm + outcome-row data across all three loops', async () => {
  // Guard loop: one applied gap item + a matching shadow bucket.
  let lq = learningStore.load(stateDir);
  const up = learningStore.upsertGapInto(lq, { code: 'ui-without-frontend-design', message: 'css edited without skill' }, { project: 'p', sessionId: 's1' });
  lq = learningStore.markApplied(up.state, up.item.id, 'abc123').state;
  learningStore.save(stateDir, lq);
  recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', fired: true, sid: 's1' });

  // Promotion loop: two units, challenger clearly better on turns.
  // firstTry/verifier are populated and identical across both units (reads
  // 'same', not 'worse'/'better') purely so this fixture clears the
  // loop-measurement-honesty two-measured-metrics gate on both sides; turns
  // alone still carries the 'better' signal that drives the kept verdict.
  appendOutcome(stateDir, { id: 'o1', unit: 'v1', ts: 1000, turns: 8, firstTry: true, verifier: { exitOk: true } });
  appendOutcome(stateDir, { id: 'o2', unit: 'v1', ts: 1001, turns: 8, firstTry: true, verifier: { exitOk: true } });
  appendOutcome(stateDir, { id: 'o3', unit: 'v1', ts: 1002, turns: 8, firstTry: true, verifier: { exitOk: true } });
  appendOutcome(stateDir, { id: 'o4', unit: 'v2', ts: 2000, turns: 2, firstTry: true, verifier: { exitOk: true } });
  appendOutcome(stateDir, { id: 'o5', unit: 'v2', ts: 2001, turns: 2, firstTry: true, verifier: { exitOk: true } });

  const r = await fetch(`http://127.0.0.1:${h.port}/api/changes`);
  assert.equal(r.status, 200);
  const body = await r.json();

  const guard = body.changes.find(c => c.type === 'guard');
  assert.ok(guard, 'guard change present');
  assert.equal(guard.status, 'measuring');
  assert.equal(guard.measuredEffect.fireCount, 1);

  const promo = body.changes.find(c => c.type === 'promotion');
  assert.ok(promo, 'promotion change present');
  assert.equal(promo.status, 'kept');

  assert.equal(body.scoreboard.tracked, body.changes.length);
  assert.ok(body.scoreboard.tracked >= 2);
});


test('GET /api/changes surfaces a seeded skill-adopt candidate as a type=skill action=adopt row', async () => {
  upsertCandidate(stateDir, {
    name: 'candidate-skill', description: 'discovered candidate', sourceRepo: 'https://example.com/repo',
    sourceRef: 'main', version: '1.0.0', registryName: 'demo-registry', format: 'skill-md',
  }, 'demo-gap');

  const r = await fetch(`http://127.0.0.1:${h.port}/api/changes`);
  assert.equal(r.status, 200);
  const body = await r.json();
  const skillRow = body.changes.find(c => c.type === 'skill' && c.action === 'adopt');
  assert.ok(skillRow, 'expected an adopt skill row');
  assert.equal(skillRow.status, 'proposed');
  assert.equal(skillRow.skillRef.name, 'candidate-skill');
  assert.ok(body.scoreboard.tracked >= 1);
});


test('GET /api/changes includes liveness keyed by type, computed over the same ledger, real HTTP round-trip', async () => {
  let lq = learningStore.load(stateDir);
  const up = learningStore.upsertGapInto(lq, { code: 'ui-without-frontend-design', message: 'css edited without skill' }, { project: 'p', sessionId: 's1' });
  lq = learningStore.markApplied(up.state, up.item.id, 'abc123').state;
  learningStore.save(stateDir, lq);

  const r = await fetch(`http://127.0.0.1:${h.port}/api/changes`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.liveness && typeof body.liveness === 'object', 'liveness present on the response');
  const guard = body.liveness.guard;
  assert.ok(guard, 'guard type present in liveness (the just-applied gap item)');
  assert.equal(typeof guard.lastTs, 'number');
  assert.equal(typeof guard.ageDays, 'number');
  assert.equal(guard.stale, false); // just written, well inside the 14-day default threshold
});

test('GET /api/changes on a fully empty state dir reports liveness as an empty object, never throws', async () => {
  const r = await fetch(`http://127.0.0.1:${h.port}/api/changes`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.liveness, {});
});

test('GET /api/changes includes durable measurables as type=measurable (C1)', async () => {
  upsertMeasurable(stateDir, { id: 'guard-retire:y', kind: 'guard-retire', title: 'Guard retire candidate: y', detail: 'never fired', evidence: { sessionId: null, ref: 'y' }, metric: { n: 25 }, ts: 500 });
  const r = await fetch(`http://127.0.0.1:${h.port}/api/changes`);
  const body = await r.json();
  const m = body.changes.find(c => c.type === 'measurable');
  assert.ok(m, 'expected a measurable-type change');
  assert.equal(m.status, 'proposed');
});
