// server/test/reflex-gate.test.js
//
// A0.4: gated reflex promotion. The reflex layer is concretely the
// '## Learned guards' section of <assetsDir>/CLAUDE.global.md - the one file
// whose content auto-changes future agent behavior - so a lesson only gets
// to write there once a human has explicitly confirmed a promotion.
// approvePromotion is non-negotiable: it throws unless humanApproved===true.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLesson, readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';
import {
  requestPromotion,
  evaluateReflexPromotion,
  approvePromotion,
  denyPromotion,
  revokePromotion,
  isPromoted,
  autoRevoke,
  activeLessonsForRun,
  PromotionApprovalRequiredError,
} from '../lib/evaluation/reflex-gate.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reflex-gate-')); }

function seedLesson(dir, lessonId) {
  return createLesson(dir, {
    lessonId, kind: 'guard', title: 't',
    provenance: { scope: 'repo', derivedFromRefs: ['abc123'] },
  });
}

test('a lesson with no promotion history reads as not promoted', () => {
  const dir = tmp();
  seedLesson(dir, 'l0');
  assert.equal(isPromoted(dir, 'l0'), false);
});

test('requestPromotion emits promotion.requested', () => {
  const dir = tmp();
  seedLesson(dir, 'l1');
  requestPromotion(dir, { lessonId: 'l1', targetLayer: 'reflex', evidence: { unit: 'v2' } });
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REQUESTED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.lessonId, 'l1');
  assert.equal(ev[0].payload.targetLayer, 'reflex');
});

test('approvePromotion refuses without explicit human approval', () => {
  const dir = tmp();
  seedLesson(dir, 'l1');
  requestPromotion(dir, { lessonId: 'l1' });
  assert.throws(() => approvePromotion(dir, { lessonId: 'l1', humanApproved: false }), PromotionApprovalRequiredError);
  assert.throws(() => approvePromotion(dir, { lessonId: 'l1' }), PromotionApprovalRequiredError);
  assert.equal(isPromoted(dir, 'l1'), false);
});

test('a lesson promoted on replay evidence plus human approval reads as promoted', () => {
  const dir = tmp();
  seedLesson(dir, 'l1');
  requestPromotion(dir, { lessonId: 'l1', targetLayer: 'reflex', evidence: { unit: 'v2' } });
  approvePromotion(dir, { lessonId: 'l1', humanApproved: true });
  assert.equal(isPromoted(dir, 'l1'), true);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_APPROVED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.lessonId, 'l1');
  const cur = lessonsCurrent(readLessonRows(dir, { lessonId: 'l1' }));
  assert.equal(cur.get('l1').reflex, true, 'lesson-ledger reflex flag reflects the approval');
});

test('denyPromotion emits promotion.denied and never promotes', () => {
  const dir = tmp();
  seedLesson(dir, 'l1');
  requestPromotion(dir, { lessonId: 'l1' });
  denyPromotion(dir, { lessonId: 'l1', reason: 'no evidence yet' });
  assert.equal(isPromoted(dir, 'l1'), false);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_DENIED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, 'no evidence yet');
});

test('revokePromotion returns a promoted lesson to session scope', () => {
  const dir = tmp();
  seedLesson(dir, 'l1');
  approvePromotion(dir, { lessonId: 'l1', humanApproved: true });
  assert.equal(isPromoted(dir, 'l1'), true);
  revokePromotion(dir, { lessonId: 'l1', reason: 'manual revoke' });
  assert.equal(isPromoted(dir, 'l1'), false);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REVOKED });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, 'manual revoke');
  const cur = lessonsCurrent(readLessonRows(dir, { lessonId: 'l1' }));
  assert.equal(cur.get('l1').reflex, false);
});

test('two attributable gate failures auto-revoke a promoted lesson', () => {
  const dir = tmp();
  seedLesson(dir, 'l1');
  approvePromotion(dir, { lessonId: 'l1', humanApproved: true });
  assert.equal(autoRevoke(dir, { lessonId: 'l1', gateFailures: 1 }), false, 'one failure is not enough');
  assert.equal(isPromoted(dir, 'l1'), true);
  assert.equal(autoRevoke(dir, { lessonId: 'l1', gateFailures: 2 }), true);
  assert.equal(isPromoted(dir, 'l1'), false);
});

test('an invalidation revokes a promoted lesson regardless of gateFailures', () => {
  const dir = tmp();
  seedLesson(dir, 'l2');
  approvePromotion(dir, { lessonId: 'l2', humanApproved: true });
  assert.equal(autoRevoke(dir, { lessonId: 'l2', invalidated: true }), true);
  assert.equal(isPromoted(dir, 'l2'), false);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REVOKED });
  assert.equal(ev[0].payload.reason, 'invalidated');
});

test('autoRevoke on a lesson that is not currently promoted is a no-op', () => {
  const dir = tmp();
  seedLesson(dir, 'l3');
  assert.equal(autoRevoke(dir, { lessonId: 'l3', gateFailures: 5 }), false);
  const ev = readSpineEvents(dir, { kind: SPINE_KINDS.PROMOTION_REVOKED });
  assert.equal(ev.length, 0, 'no spurious revoke event for a lesson that was never promoted');
});

test('activeLessonsForRun lists reflex-promoted, still-active lessons only', () => {
  const dir = tmp();
  seedLesson(dir, 'promoted-active');
  seedLesson(dir, 'never-promoted');
  seedLesson(dir, 'promoted-then-revoked');
  approvePromotion(dir, { lessonId: 'promoted-active', humanApproved: true });
  approvePromotion(dir, { lessonId: 'promoted-then-revoked', humanApproved: true });
  revokePromotion(dir, { lessonId: 'promoted-then-revoked', reason: 'x' });

  const ids = activeLessonsForRun(dir, 'nightly-20260816');
  assert.deepEqual(ids.sort(), ['promoted-active']);
});

test('evaluateReflexPromotion with explicit directions delegates to evaluatePromotion', () => {
  const verdictPromote = evaluateReflexPromotion({
    evidence: { successRate: 0.95 },
    baseline: { successRate: 0.8 },
    directions: { successRate: 'higher' },
  });
  assert.equal(verdictPromote.verdict, 'promote');
  assert.ok(verdictPromote.reasons.length > 0);

  const verdictReject = evaluateReflexPromotion({
    evidence: { successRate: 0.5 },
    baseline: { successRate: 0.8 },
    directions: { successRate: 'higher' },
  });
  assert.equal(verdictReject.verdict, 'reject');
});

test('evaluateReflexPromotion with no directions scores an OutcomeRow-shaped replay baseline via scoreReplay', () => {
  const baseline = { turns: 10, tokens: { in: 1000, out: 500 } };
  const better = { turns: 5, tokens: { in: 1000, out: 500 } };
  const r = evaluateReflexPromotion({ evidence: better, baseline });
  assert.equal(r.verdict, 'promote');
  assert.ok(r.reasons.some((x) => /turns/.test(x)));
});

test('evaluateReflexPromotion holds when nothing measurably changed', () => {
  const baseline = { turns: 10 };
  const r = evaluateReflexPromotion({ evidence: { turns: 10 }, baseline });
  assert.equal(r.verdict, 'hold');
  assert.deepEqual(r.reasons, ['no measurable improvement']);
});
