// Routes under test: server/lib/routes/learning-integrity-routes.js
// Routes under test: server/lib/routes/lessons-routes.js
// server/test/api-platform-autonomy.test.js
//
// The platform-autonomy HTTP surface, against a really booted server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { createLesson, appendLessonRow } from '../lib/evaluation/lesson-ledger.js';
import { recordGateResult } from '../lib/orchestration/nightly-run.js';
import { orphanScan } from '../lib/evaluation/lesson-invalidate.js';
import { runDecaySweep } from '../lib/evaluation/lesson-decay.js';
import { sweepInvalidations } from '../lib/evaluation/lesson-invalidate.js';
import { requestPromotion, approvePromotion, revokePromotion } from '../lib/evaluation/reflex-gate.js';
import { emitSpineEvent, readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }

function mkClaudeEnv() {
  const root = tmp('mc-claude-');
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  return root;
}

async function boot(stateDir) {
  const claudeDir = mkClaudeEnv();
  const env = {
    ...process.env,
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ASSETS_DIR: tmp('mc-assets-'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  return {
    h,
    base,
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => ({})) }; },
    post: async (p, obj) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    cleanup: async () => { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); },
  };
}

// Integrity

test('a GET never appends integrity events to the spine', async () => {
  // Every dashboard poll hits this route. Emitting on read would turn the
  // spine into a log of the fact that someone looked at it.
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    await s.get('/api/brief');
    await s.get('/api/brief');
    assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.RECONCILIATION_INTEGRITY }).length, 0);
  } finally { await s.cleanup(); }
});

test('the goal routes are gone', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    assert.equal((await s.get('/api/goals')).status, 404);
    assert.equal((await s.post('/api/goals', { goalId: 'c', title: 'C', horizon: 'annual' })).status, 404);
  } finally { await s.cleanup(); }
});

// Learning integrity

test('the freeze cannot be lifted while A0 acceptance is incomplete', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const r = await s.post('/api/learning-integrity/freeze', { frozen: false });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /acceptance/i);
    assert.equal((await s.get('/api/learning-integrity')).body.freeze, true, 'the freeze stays on');
  } finally { await s.cleanup(); }
});

test('the freeze lifts once every acceptance flag is satisfied', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const DAY = 86400000;
    // provenance: a lesson exists and carries provenance
    createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 'l1', provenance: { scope: 'repo', derivedFromRefs: ['abc1234'] }, now: t0 });
    // decay: a lesson has decayed
    runDecaySweep(dir, { now: t0 + 120 * DAY });
    // revertSweep: a lesson invalidated by a revert
    createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 'l2', provenance: { scope: 'repo', derivedFromRefs: ['dead1234'] }, now: t0 });
    sweepInvalidations(dir, { refs: ['dead1234'], reason: 'revert' });
    // promotionGate: one approved and one revoked
    createLesson(dir, { lessonId: 'l3', kind: 'guard', title: 'l3', provenance: { scope: 'repo', derivedFromRefs: ['beef1234'] }, now: t0 });
    requestPromotion(dir, { lessonId: 'l3', targetLayer: 'reflex', evidence: {} });
    approvePromotion(dir, { lessonId: 'l3', humanApproved: true });
    revokePromotion(dir, { lessonId: 'l3', reason: 'test' });

    const status = await s.get('/api/learning-integrity');
    assert.equal(status.body.acceptance.allPassed, true, JSON.stringify(status.body.acceptance));

    const lifted = await s.post('/api/learning-integrity/freeze', { frozen: false });
    assert.equal(lifted.status, 200);
    assert.equal(lifted.body.freeze, false);
  } finally { await s.cleanup(); }
});

test('re-freezing is always allowed, whatever acceptance says', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const r = await s.post('/api/learning-integrity/freeze', { frozen: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.freeze, true);
  } finally { await s.cleanup(); }
});

test('promoting a lesson without explicit human approval is refused', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 'l1', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
    const r = await s.post('/api/lessons/l1/promote', {});
    assert.equal(r.status, 409);
    const lessons = await s.get('/api/lessons');
    assert.equal(lessons.body.lessons.find((l) => l.lessonId === 'l1').promoted, false);
  } finally { await s.cleanup(); }
});

test('promote then revoke round-trips through the API', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 'l1', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
    assert.equal((await s.post('/api/lessons/l1/promote', { humanApproved: true })).status, 200);
    assert.equal((await s.get('/api/lessons')).body.lessons.find((l) => l.lessonId === 'l1').promoted, true);
    assert.equal((await s.post('/api/lessons/l1/revoke', { reason: 'regressed' })).status, 200);
    assert.equal((await s.get('/api/lessons')).body.lessons.find((l) => l.lessonId === 'l1').promoted, false);
  } finally { await s.cleanup(); }
});

// Brief, reviews, telemetry

test('GET /api/brief is empty on a fresh install rather than noisy', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const r = await s.get('/api/brief');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.lines, []);
  } finally { await s.cleanup(); }
});

test('GET /api/brief reports the last nightly run', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    emitSpineEvent(dir, {
      kind: SPINE_KINDS.RUN_COMPLETED, actor: 'nightly-runner',
      payload: { runId: 'nightly-20260816', prs: ['https://x/pull/1'], itemsDone: ['a'], itemsBlocked: [], gatesSkipped: ['critic'] },
    });
    const r = await s.get('/api/brief');
    assert.ok(r.body.lines.some((l) => l.includes('nightly-20260816')), r.body.lines.join(' | '));
    assert.ok(r.body.lines.some((l) => l.includes('critic')), 'a skipped gate must reach the brief');
  } finally { await s.cleanup(); }
});

test('a review is readable back from /api/reviews', async () => {
  const dir = tmp('mc-state-');
  emitSpineEvent(dir, {
    kind: SPINE_KINDS.REVIEW_COMPLETED,
    actor: 'operator',
    payload: { cadence: 'nightly', oneBigThing: 'Land the verifier stack' },
  });
  const s = await boot(dir);
  try {
    const back = await s.get('/api/reviews');
    assert.equal(back.body.reviews.length, 1);
    assert.equal(back.body.reviews[0].cadence, 'nightly');
    assert.equal(back.body.reviews[0].oneBigThing, 'Land the verifier stack');
  } finally { await s.cleanup(); }
});

test('a human touch is recorded and surfaces in the autonomy metrics', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    assert.equal((await s.post('/api/touch', { type: 'manual-edit', ref: 'pr-1', taskClass: 'docs' })).status, 201);
    const m = await s.get('/api/autonomy?windowDays=30');
    assert.equal(m.status, 200);
    assert.equal(m.body.byTaskClass.docs.touches, 1);
  } finally { await s.cleanup(); }
});

test('an unknown touch type is refused and the valid types are named', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const r = await s.post('/api/touch', { type: 'vibes', ref: 'x' });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.body.types) && r.body.types.includes('manual-edit'));
  } finally { await s.cleanup(); }
});

// The nightly tick

test('the platform-autonomy timer is off by default and clears on close', async () => {
  // glmps-8: every uncaptured setInterval leaked one interval per
  // startServer(), including in every test that boots one.
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    assert.equal(typeof s.h.platformAutonomyTick, 'function', 'the tick must be exposed for deterministic tests');
  } finally { await s.cleanup(); }
});

test('the tick decays lessons and runs the integrity checks without throwing', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const t0 = Date.now() - 400 * 86400000;
    createLesson(dir, { lessonId: 'old', kind: 'guard', title: 'old', provenance: { scope: 'repo', derivedFromRefs: ['abc'] }, now: t0 });

    await s.h.platformAutonomyTick();

    assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.LESSON_DECAYED }).length, 1, 'a long-stale lesson decays');
  } finally { await s.cleanup(); }
});

// The three drift checks, fed by the real producers' event shapes through the
// nightly tick. They fired nothing in production because the context handed
// them raw spine envelopes (fields under payload) instead of the flat rows
// they read.

const DAY = 86400000;
const integrityFindings = (dir) => readSpineEvents(dir, { kind: SPINE_KINDS.RECONCILIATION_INTEGRITY }).map((e) => e.payload);

test('the tick reports a gate skipped three nights running', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    for (const runId of ['nightly-20261001', 'nightly-20261002', 'nightly-20261003']) {
      recordGateResult(dir, { runId, gateName: 'adversarial-review', status: 'skipped' });
      recordGateResult(dir, { runId, gateName: 'tests', status: 'pass' });
    }
    await s.h.platformAutonomyTick();
    const f = integrityFindings(dir).filter((p) => p.check_name === 'skipped_gates');
    assert.equal(f.length, 1, 'only the skipped gate fires, the passing one does not');
    assert.equal(f[0].data.gateName, 'adversarial-review');
    assert.equal(f[0].data.streak, 3);
  } finally { await s.cleanup(); }
});

test('the tick reports an orphan open past the threshold and drops one the scan stopped reporting', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    const now = Date.now();
    // orphanScan re-emits every still-orphaned artifact on every nightly scan.
    for (let d = 10; d >= 1; d -= 1) {
      orphanScan(dir, { refs: ['stuck-1'], worktrees: [{ ref: 'stuck-1', path: '/wt/stuck-1' }], now: now - d * DAY });
    }
    for (let d = 10; d >= 8; d -= 1) {
      orphanScan(dir, { refs: ['gone-1'], worktrees: [{ ref: 'gone-1', path: '/wt/gone-1' }], now: now - d * DAY });
    }
    await s.h.platformAutonomyTick(now);
    const f = integrityFindings(dir).filter((p) => p.check_name === 'orphaned_artifact');
    assert.deepEqual(f.map((p) => p.data.ref), ['stuck-1']);
    assert.equal(f[0].data.ageDays, 10);
  } finally { await s.cleanup(); }
});

test('the tick flags a reflex lesson whose promotion has no approval event, and not an approved one', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    for (const lessonId of ['audited', 'rogue']) {
      createLesson(dir, { lessonId, kind: 'guard', title: lessonId, provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
    }
    approvePromotion(dir, { lessonId: 'audited', humanApproved: true });
    // The ledger row alone, bypassing approvePromotion: no promotion.approved event.
    appendLessonRow(dir, { type: 'promoted', lessonId: 'rogue', ts: new Date().toISOString() });
    await s.h.platformAutonomyTick();
    const f = integrityFindings(dir).filter((p) => p.check_name === 'ungated_reflex');
    assert.deepEqual(f.map((p) => p.data.lessonId), ['rogue']);
    assert.equal(f[0].severity, 'critical');
  } finally { await s.cleanup(); }
});
