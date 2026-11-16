// server/test/lesson-invalidate-revokes.test.js
//
// The closing link in the A0 loop.
//
// A0.3 says a revert invalidates the lessons derived from the reverted refs.
// A0.4 says demotion is automatic: "an invalidation ... emits
// promotion.revoked and returns it to session scope."
//
// Those were built as two separate mechanisms, and nothing connected them:
// sweepInvalidations marked the lesson invalidated but left its promotion
// standing, so isPromoted() kept returning true. The practical effect is the
// worst case the whole layer exists to prevent: you revert the commit a guard
// was learned from, the system records that the lesson is invalid, and the
// guard keeps shaping every future session anyway.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLesson, readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { sweepInvalidations, recordIntentionalBreak } from '../lib/evaluation/lesson-invalidate.js';
import { requestPromotion, approvePromotion, isPromoted } from '../lib/evaluation/reflex-gate.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-inval-revoke-')); }

function promotedLesson(dir, lessonId, ref) {
  createLesson(dir, { lessonId, kind: 'guard', title: lessonId, provenance: { scope: 'repo', derivedFromRefs: [ref] } });
  requestPromotion(dir, { lessonId, targetLayer: 'reflex', evidence: {} });
  approvePromotion(dir, { lessonId, humanApproved: true });
  assert.equal(isPromoted(dir, lessonId), true, 'fixture: the lesson starts promoted');
  return lessonId;
}

test('reverting the source commit revokes the lesson promotion', () => {
  const dir = tmp();
  promotedLesson(dir, 'l1', 'abc1234');
  sweepInvalidations(dir, { refs: ['abc1234'], reason: 'revert' });
  assert.equal(isPromoted(dir, 'l1'), false, 'an invalidated lesson must not remain in the reflex layer');
});

test('the revocation is recorded as an event, not just as state', () => {
  const dir = tmp();
  promotedLesson(dir, 'l1', 'abc1234');
  sweepInvalidations(dir, { refs: ['abc1234'], reason: 'revert' });
  const revoked = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REVOKED });
  assert.equal(revoked.length, 1);
  assert.match(revoked[0].payload.reason, /invalidat/i);
});

test('an intentional break revokes exactly as a revert does', () => {
  // The spec's point: deliberate demolition must clean up after itself on the
  // identical path, or intentional breakage silently poisons future runs.
  const dir = tmp();
  promotedLesson(dir, 'l1', 'dead1234');
  recordIntentionalBreak(dir, { refs: ['dead1234'], note: 'removing the old path on purpose' });
  assert.equal(isPromoted(dir, 'l1'), false);
});

test('an unrelated promoted lesson is untouched by the sweep', () => {
  const dir = tmp();
  promotedLesson(dir, 'l1', 'abc1234');
  promotedLesson(dir, 'l2', 'ffff9999');
  sweepInvalidations(dir, { refs: ['abc1234'], reason: 'revert' });
  assert.equal(isPromoted(dir, 'l1'), false);
  assert.equal(isPromoted(dir, 'l2'), true, 'the sweep must only reach lessons derived from the reverted refs');
});

test('invalidating a lesson that was never promoted emits no revocation', () => {
  const dir = tmp();
  createLesson(dir, { lessonId: 'l9', kind: 'guard', title: 'l9', provenance: { scope: 'repo', derivedFromRefs: ['abc1234'] } });
  sweepInvalidations(dir, { refs: ['abc1234'], reason: 'revert' });
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REVOKED }).length, 0, 'no spurious revocation');
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('l9').status, 'invalidated');
});

test('the lesson is still invalidated, not merely demoted', () => {
  const dir = tmp();
  promotedLesson(dir, 'l1', 'abc1234');
  sweepInvalidations(dir, { refs: ['abc1234'], reason: 'revert' });
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('l1').status, 'invalidated');
});
