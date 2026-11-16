// server/test/api-measurables-tick.test.js
// glmps-140: GET /api/measurables used to self-populate by running 4
// compute+persist passes (guard-retire, skill-archive, guard-stale,
// skill-stale) on every single request - real fs reads plus a per-row fs
// write each time (see measurable-persist-wiring.test.js's older
// "self-populates" test for the pre-glmps-140 contract this file
// deliberately supersedes). That compute now runs on a scheduled tick
// (measurablesTick, exposed on the startServer() handle for deterministic
// tests, same precedent as h.runnerTick()) instead, with
// an immediate synchronous call at boot so the store is never empty before
// the first interval elapses. This file proves both halves of that contract:
// GET is now a pure read (no store writes), and the tick - invoked directly,
// the same function the interval calls - still produces the same candidates
// the old self-populate-on-GET behavior used to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { recordShadow } from '../lib/evaluation/shadow-arm.js';
import { upsertMeasurable } from '../lib/evaluation/measurables-store.js';
import * as learningStore from '../lib/evaluation/learning-store.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const storeFile = (stateDir) => path.join(stateDir, 'measurables', 'measurables.json');

// Guard proposer cutover: server.js's guard-retire routes now read
// their guard catalog from applied learning-store items (appliedGuardCatalog()),
// not a static template map - seed one the way an operator actually gets a
// gap item to 'applied' now (the 'alternative' action sets a rule, then it
// lands), so the tick has a guard the retire-candidate rule can see.
function seedAppliedGuard(stateDir, code) {
  let state = learningStore.emptyState();
  const up = learningStore.upsertGapInto(state, { code, message: 'm' }, { project: 'p', sessionId: 's1' });
  state = learningStore.applyAction(up.state, up.item.id, 'alternative', { rule: `- Guard for ${code}.` }).state;
  state = learningStore.markApplied(state, up.item.id, 'commit1').state;
  learningStore.save(stateDir, state);
}

test('GET /api/measurables is a pure read: candidates that only exist because of NEW data recorded after boot do not appear until the tick runs', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  // Empty state dir at boot: the startup measurablesTick() call computes
  // zero candidates (nothing to observe yet) and never even creates
  // measurables/measurables.json (upsertMeasurable is never called with zero
  // candidates - see measurables-store.js's writeAll, only invoked per row).
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    assert.equal(fs.existsSync(storeFile(stateDir)), false, 'empty state dir: no store file should exist yet');

    // Data that WOULD make a guard-retire candidate arrives after boot, i.e.
    // after the one-time startup tick already ran and found nothing.
    for (let i = 0; i < 20; i++) {
      recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', wouldFire: false, fired: false });
    }
    seedAppliedGuard(stateDir, 'ui-without-frontend-design');

    const before = await (await fetch(`http://127.0.0.1:${h.port}/api/measurables`)).json();
    assert.ok(!before.measurables.some((m) => m.id === 'guard-retire:ui-without-frontend-design'),
      `GET must not self-populate a fresh candidate: got ${JSON.stringify(before.measurables.map((m) => m.id))}`);
    assert.equal(fs.existsSync(storeFile(stateDir)), false,
      'GET must perform no measurables-store write even when new candidate-worthy data exists');

    // The tick - h.measurablesTick(), the SAME function the interval timer
    // calls - still produces the same candidate the old self-populate-on-GET
    // behavior used to.
    h.measurablesTick();
    assert.equal(fs.existsSync(storeFile(stateDir)), true, 'the tick itself must persist the candidate');

    const after = await (await fetch(`http://127.0.0.1:${h.port}/api/measurables`)).json();
    assert.ok(after.measurables.some((m) => m.id === 'guard-retire:ui-without-frontend-design'),
      `after the tick runs, GET must read the now-persisted candidate: got ${JSON.stringify(after.measurables.map((m) => m.id))}`);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});

test('GET /api/measurables never rewrites the store: file content is byte-identical across repeated GETs', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  // Seed one durable measurable directly (independent of any compute path)
  // so the store file exists before the server even boots.
  upsertMeasurable(stateDir, { id: 'guard-retire:x', kind: 'guard-retire', title: 'Guard retire candidate: x', detail: 'never fired', evidence: { sessionId: null, ref: 'x' }, metric: { n: 20 }, ts: 100 });
  const before = fs.readFileSync(storeFile(stateDir), 'utf-8');

  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    // Boot's own measurablesTick() runs synchronously before startServer()
    // resolves; an empty state dir otherwise (no shadow-arm/learning-store
    // fixtures) means it computes zero NEW candidates, so the seeded row
    // above is the only content and it stays untouched.
    for (let i = 0; i < 3; i++) {
      const body = await (await fetch(`http://127.0.0.1:${h.port}/api/measurables`)).json();
      assert.equal(body.measurables.length, 1);
    }
    const after = fs.readFileSync(storeFile(stateDir), 'utf-8');
    assert.equal(after, before,
      'repeated GETs must never rewrite measurables.json - old self-populate-on-GET behavior would restamp updatedTs/ts on every hit');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
