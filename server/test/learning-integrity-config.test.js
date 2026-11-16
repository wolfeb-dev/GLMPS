// server/test/learning-integrity-config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProvenance, normalizeProvenance } from '../lib/evaluation/lesson-provenance.js';
import { learningIntegrityConfig, a0AcceptanceStatus } from '../lib/evaluation/learning-integrity-config.js';
import { createLesson } from '../lib/evaluation/lesson-ledger.js';
import { runDecaySweep } from '../lib/evaluation/lesson-decay.js';
import { sweepInvalidations } from '../lib/evaluation/lesson-invalidate.js';
import { approvePromotion, revokePromotion } from '../lib/evaluation/reflex-gate.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-a0-status-')); }

test('learningIntegrityConfig returns the documented defaults with no cfg', () => {
  const c = learningIntegrityConfig();
  assert.equal(c.freeze, true);
  assert.deepEqual(c.halfLifeDays, { repo: 30, desk: 90, global: 90 });
  assert.equal(c.strengthFloor, 0.2);
  assert.deepEqual(c.frozenActors, ['nightly-runner']);
});

test('learningIntegrityConfig applies cfg.learningIntegrity overrides', () => {
  const c = learningIntegrityConfig({ learningIntegrity: { freeze: false, strengthFloor: 0.5 } });
  assert.equal(c.freeze, false);
  assert.equal(c.strengthFloor, 0.5);
});

test('learningIntegrityConfig merges partial halfLifeDays overrides without dropping the rest', () => {
  const c = learningIntegrityConfig({ learningIntegrity: { halfLifeDays: { repo: 45 } } });
  assert.deepEqual(c.halfLifeDays, { repo: 45, desk: 90, global: 90 });
});

test('learningIntegrityConfig ignores an absent learningIntegrity block', () => {
  const c = learningIntegrityConfig({ other: 'x' });
  assert.equal(c.freeze, true);
});

test('learningIntegrityConfig lets frozenActors be overridden entirely', () => {
  const c = learningIntegrityConfig({ learningIntegrity: { frozenActors: ['nightly-runner', 'bot'] } });
  assert.deepEqual(c.frozenActors, ['nightly-runner', 'bot']);
});

// a0AcceptanceStatus: every flag is computed from the ledger, never
// self-declared. A fresh stateDir with nothing in it must fail every check.
test('a0AcceptanceStatus on an empty stateDir: every flag false, allPassed false', () => {
  const dir = tmp();
  const s = a0AcceptanceStatus(dir);
  assert.equal(s.provenance, false, 'no lesson has ever been created');
  assert.equal(s.decay, false);
  assert.equal(s.revertSweep, false);
  assert.equal(s.promotionGate, false);
  assert.equal(s.allPassed, false);
});

test('a0AcceptanceStatus.provenance is true once at least one lesson exists (createLesson always asserts provenance first)', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  const s = a0AcceptanceStatus(dir);
  assert.equal(s.provenance, true);
  assert.equal(s.decay, false, 'provenance alone does not satisfy the other checks');
});

test('a0AcceptanceStatus.decay is true once at least one lesson.decayed event exists', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] }, now: t0 });
  assert.equal(a0AcceptanceStatus(dir).decay, false);
  runDecaySweep(dir, { now: t0 + 75 * 86400000 });
  assert.equal(a0AcceptanceStatus(dir).decay, true);
});

test('a0AcceptanceStatus.revertSweep is true only once a lesson.invalidated event with reason revert exists (an intentional_break does not count)', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['x1'] } });
  createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['x2'] } });
  sweepInvalidations(dir, { refs: ['x1'], reason: 'intentional_break' });
  assert.equal(a0AcceptanceStatus(dir).revertSweep, false, 'an intentional_break invalidation does not satisfy the revert-sweep check');
  sweepInvalidations(dir, { refs: ['x2'], reason: 'revert' });
  assert.equal(a0AcceptanceStatus(dir).revertSweep, true);
});

test('a0AcceptanceStatus.promotionGate is true only once BOTH an approved and a revoked promotion exist', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['abc'] } });
  approvePromotion(dir, { lessonId: 'l1', humanApproved: true });
  assert.equal(a0AcceptanceStatus(dir).promotionGate, false, 'an approval alone is not enough');
  revokePromotion(dir, { lessonId: 'l1', reason: 'x' });
  assert.equal(a0AcceptanceStatus(dir).promotionGate, true);
});

test('a0AcceptanceStatus.allPassed is true only once every flag is true, and the freeze-lift gate can read it', () => {
  const dir = tmp();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  createLesson(dir, { lessonId: 'l1', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['x1'] }, now: t0 });
  createLesson(dir, { lessonId: 'l2', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['x2'] }, now: t0 });
  createLesson(dir, { lessonId: 'l3', kind: 'guard', title: 't', provenance: { scope: 'repo', derivedFromRefs: ['x3'] }, now: t0 });

  runDecaySweep(dir, { now: t0 + 75 * 86400000 });
  sweepInvalidations(dir, { refs: ['x2'], reason: 'revert' });
  approvePromotion(dir, { lessonId: 'l3', humanApproved: true });

  const partial = a0AcceptanceStatus(dir);
  assert.equal(partial.allPassed, false, 'promotionGate still needs a revoke');

  revokePromotion(dir, { lessonId: 'l3', reason: 'x' });
  const full = a0AcceptanceStatus(dir);
  assert.equal(full.provenance, true);
  assert.equal(full.decay, true);
  assert.equal(full.revertSweep, true);
  assert.equal(full.promotionGate, true);
  assert.equal(full.allPassed, true);
});

test('revertScanRepos defaults to empty and is overridable', () => {
  assert.deepEqual(learningIntegrityConfig({}).revertScanRepos, []);
  assert.deepEqual(
    learningIntegrityConfig({ learningIntegrity: { revertScanRepos: ['C:/repo', 42, '  '] } }).revertScanRepos,
    ['C:/repo'],
    'non-strings and blanks are dropped, same shape as nightly repoAllowlist',
  );
});

test('there is no enforceProvenance switch: provenance is unconditional', () => {
  // The knob was defaulted, returned, and surfaced on GET /api/lessons, and
  // nothing read it: assertProvenance has always been unconditional. It
  // advertised a switch that did not exist, and the only thing turning it
  // "off" could ever have meant is weakening the one invariant A0 is built on.
  const c = learningIntegrityConfig({ learningIntegrity: { enforceProvenance: false } });
  assert.equal('enforceProvenance' in c, false, 'the knob is gone, not merely ignored');
  // and the invariant it pretended to control still holds
  assert.throws(
    () => assertProvenance(normalizeProvenance({ scope: 'repo', sourceEventIds: [], derivedFromRefs: [] })),
    /no traceable origin/,
  );
});
