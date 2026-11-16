// Routes under test: server/lib/routes/lessons-routes.js
// server/test/api-promotion-evidence.test.js
//
// A0.4 spells out three steps, not two:
//
//   promotion.requested(lesson_id, target_layer=reflex, evidence)
//     -> evaluation over a frozen replay set
//       -> promotion.approved (human confirmation required in this phase)
//          or promotion.denied(reason)
//
// The promote route originally went straight from requested to approved, so
// the evidence was recorded and then ignored: a human could approve a lesson
// whose replay evidence showed a regression, and nothing would object. Human
// confirmation is the LAST gate, not the only one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { createLesson } from '../lib/evaluation/lesson-ledger.js';
import { isPromoted } from '../lib/evaluation/reflex-gate.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }

async function boot(stateDir) {
  const claudeDir = tmp('mc-claude-');
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  const h = await startServer({
    port: 0,
    env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ASSETS_DIR: tmp('mc-assets-'), GLMPS_UNMERGED_SCAN: 'off' },
    configFile: path.join(stateDir, 'no-config.json'),
  });
  const base = `http://127.0.0.1:${h.port}`;
  return {
    h,
    post: async (p, obj) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    cleanup: async () => { await h.close?.(); fs.rmSync(stateDir, { recursive: true, force: true }); },
  };
}

function seed(dir, lessonId = 'l1') {
  createLesson(dir, { lessonId, kind: 'guard', title: lessonId, provenance: { scope: 'repo', derivedFromRefs: ['abc1234'] } });
  return lessonId;
}

// A replay comparison where the challenger is worse on a lower-is-better
// metric, which scoreReplay reads as a regression.
const REGRESSED = { baseline: { turns: 5 }, evidence: { turns: 40 } };
const IMPROVED = { baseline: { turns: 40 }, evidence: { turns: 5 } };

test('evidence showing a regression denies the promotion, even with human approval', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    seed(dir);
    const r = await s.post('/api/lessons/l1/promote', { humanApproved: true, ...REGRESSED });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.body), /regression/i);
    assert.equal(isPromoted(dir, 'l1'), false, 'a regressing lesson must not reach the reflex layer');
  } finally { await s.cleanup(); }
});

test('a denial is recorded as promotion.denied with its reason', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    seed(dir);
    await s.post('/api/lessons/l1/promote', { humanApproved: true, ...REGRESSED });
    const denied = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_DENIED });
    assert.equal(denied.length, 1);
    assert.match(JSON.stringify(denied[0].payload), /regression/i);
    assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_APPROVED }).length, 0);
  } finally { await s.cleanup(); }
});

test('evidence showing an improvement still requires human approval', async () => {
  // Evaluation is a gate, not a substitute for the human one.
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    seed(dir);
    const r = await s.post('/api/lessons/l1/promote', { ...IMPROVED });
    assert.equal(r.status, 409);
    assert.equal(isPromoted(dir, 'l1'), false);
  } finally { await s.cleanup(); }
});

test('improvement plus human approval promotes', async () => {
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    seed(dir);
    const r = await s.post('/api/lessons/l1/promote', { humanApproved: true, ...IMPROVED });
    assert.equal(r.status, 200);
    assert.equal(isPromoted(dir, 'l1'), true);
  } finally { await s.cleanup(); }
});

test('with no evidence supplied the human remains the only gate', async () => {
  // The replay harness is not wired into every lesson source yet, so a
  // promotion with no evidence at all is still possible. It must not silently
  // claim to have been evaluated: no evidence, no evaluation, and the human
  // carries the decision alone.
  const dir = tmp('mc-state-');
  const s = await boot(dir);
  try {
    seed(dir);
    const r = await s.post('/api/lessons/l1/promote', { humanApproved: true });
    assert.equal(r.status, 200);
    assert.equal(isPromoted(dir, 'l1'), true);
    assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_DENIED }).length, 0);
  } finally { await s.cleanup(); }
});
