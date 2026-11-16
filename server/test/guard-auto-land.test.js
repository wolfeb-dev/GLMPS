// Card glmps-2-0-201: the auto-approver's landing and the revert path, at the
// ledger and file layers. ADR 0003.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { landGuard, unlandGuard } from '../lib/evaluation/guard-lesson.js';
import { approvePromotion, autoApprovePromotion, isPromoted, PromotionApprovalRequiredError } from '../lib/evaluation/reflex-gate.js';
import { readLessonRows, lessonsCurrent } from '../lib/evaluation/lesson-ledger.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';
import { removeGuardLine } from '../lib/evaluation/learning-templates.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-guard-auto-')); }
const CFG = { freeze: false, frozenActors: [] };
const PROV = { scope: 'global', sourceEventIds: ['learning-store:abc'], derivedFromRefs: [] };
const GUARD = { assetsDir: '/assets', file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- r', message: 'm' };
const AUTO = { policy: 'guard-auto-approve', evidence: { sessions: 5, repos: 2, windowDays: 7 } };

test('approvePromotion still refuses without humanApproved: the auto path does not loosen it', () => {
  assert.throws(() => approvePromotion(tmp(), { lessonId: 'legacy:x' }), PromotionApprovalRequiredError);
});

test('autoApprovePromotion needs a named policy and evidence', () => {
  assert.throws(() => autoApprovePromotion(tmp(), { lessonId: 'legacy:x' }), PromotionApprovalRequiredError);
  assert.throws(() => autoApprovePromotion(tmp(), { lessonId: 'legacy:x', policy: 'p' }), PromotionApprovalRequiredError);
});

test('an auto landing is recorded as the auto-approver with its evidence, never as the operator', () => {
  const dir = tmp();
  const out = landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, actor: 'auto-approver', autoApproval: AUTO,
    config: CFG, guard: GUARD, applyGuardFn: () => ({ commit: 'sha', changed: true }),
  });
  assert.equal(out.created, true);
  assert.equal(isPromoted(dir, 'legacy:abc'), true);
  const promoted = readLessonRows(dir, { lessonId: 'legacy:abc' }).find((r) => r.type === 'promoted');
  assert.equal(promoted.by, 'auto-approver');
  assert.equal(promoted.auto, true);
  const approved = readSpineEvents(dir).filter((e) => e.kind === SPINE_KINDS.PROMOTION_APPROVED);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].actor, 'auto-approver');
  assert.equal(approved[0].payload.auto, true);
  assert.deepEqual(approved[0].payload.evidence, AUTO.evidence);
  assert.equal(lessonsCurrent(readLessonRows(dir, {})).get('legacy:abc').reflex, true);
});

test('landGuard refuses humanApproval and autoApproval together', () => {
  assert.throws(() => landGuard(tmp(), { itemId: 'abc', provenance: PROV, humanApproval: true, autoApproval: AUTO, config: CFG, guard: GUARD }), /exclusive/);
});

test('an auto landing is refused when the freeze names the auto-approver, and appends nothing to the file', () => {
  const dir = tmp();
  let wrote = false;
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', provenance: PROV, actor: 'auto-approver', autoApproval: AUTO,
    config: { freeze: true, frozenActors: ['auto-approver'] }, guard: GUARD, applyGuardFn: () => { wrote = true; return {}; },
  }));
  assert.equal(wrote, false);
});

// Card glmps-2-0-205: the refusal used to leave the auto-approver's promotion
// rows behind, so a later operator Approve skipped its own approval.
test('a frozen auto landing appends no promotion rows, and a later operator approve is credited to the operator', () => {
  const dir = tmp();
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', provenance: PROV, actor: 'auto-approver', autoApproval: AUTO,
    config: { freeze: true, frozenActors: ['auto-approver'] }, guard: GUARD, applyGuardFn: () => ({}),
  }));
  assert.deepEqual(readLessonRows(dir, {}), []);
  assert.equal(isPromoted(dir, 'legacy:abc'), false);
  assert.equal(readSpineEvents(dir).filter((e) => e.kind === SPINE_KINDS.PROMOTION_APPROVED).length, 0);

  landGuard(dir, {
    itemId: 'abc', title: 'g', provenance: PROV, actor: 'operator', humanApproval: true,
    config: CFG, guard: GUARD, applyGuardFn: () => ({ commit: 'sha', changed: true }),
  });
  const promoted = readLessonRows(dir, { lessonId: 'legacy:abc' }).filter((r) => r.type === 'promoted');
  assert.equal(promoted.length, 1);
  assert.notEqual(promoted[0].auto, true);
  const approved = readSpineEvents(dir).filter((e) => e.kind === SPINE_KINDS.PROMOTION_APPROVED);
  assert.deepEqual(approved.map((e) => e.actor), ['operator']);
});

test('an auto landing with untraceable provenance appends no promotion rows', () => {
  const dir = tmp();
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', provenance: { scope: 'global', sourceEventIds: [], derivedFromRefs: [] }, actor: 'auto-approver', autoApproval: AUTO,
    config: CFG, guard: GUARD, applyGuardFn: () => ({}),
  }));
  assert.deepEqual(readLessonRows(dir, {}), []);
});

test('a frozen operator apply appends no promotion rows either', () => {
  const dir = tmp();
  assert.throws(() => landGuard(dir, {
    itemId: 'abc', provenance: PROV, actor: 'nightly-runner', humanApproval: true,
    config: { freeze: true, frozenActors: ['nightly-runner'] }, guard: GUARD, applyGuardFn: () => ({}),
  }));
  assert.deepEqual(readLessonRows(dir, {}), []);
});

test('unlandGuard removes the line first, then revokes the promotion', () => {
  const dir = tmp();
  landGuard(dir, { itemId: 'abc', provenance: PROV, actor: 'auto-approver', autoApproval: AUTO, config: CFG, guard: GUARD, applyGuardFn: () => ({ commit: 'a', changed: true }) });
  const order = [];
  const out = unlandGuard(dir, { itemId: 'abc', reason: 'probation failed', guard: GUARD,
    removeGuardFn: (g) => { order.push(['remove', g.rule]); return { commit: 'b', changed: true }; } });
  assert.deepEqual(order, [['remove', '- r']]);
  assert.equal(out.revoked, true);
  assert.equal(isPromoted(dir, 'legacy:abc'), false);
  const revoked = readSpineEvents(dir).filter((e) => e.kind === SPINE_KINDS.PROMOTION_REVOKED);
  assert.equal(revoked[0].payload.reason, 'probation failed');
});

test('a failed removal leaves the promotion in place', () => {
  const dir = tmp();
  landGuard(dir, { itemId: 'abc', provenance: PROV, actor: 'auto-approver', autoApproval: AUTO, config: CFG, guard: GUARD, applyGuardFn: () => ({ commit: 'a', changed: true }) });
  assert.throws(() => unlandGuard(dir, { itemId: 'abc', guard: GUARD, removeGuardFn: () => { throw new Error('git failed'); } }), /git failed/);
  assert.equal(isPromoted(dir, 'legacy:abc'), true);
});

test('removeGuardLine removes the rule only inside its section', () => {
  const text = '# T\n- r\n\n## Learned guards\n- a\n- r\n\n## Other\n- r\n';
  const out = removeGuardLine(text, 'Learned guards', '- r');
  assert.equal(out.changed, true);
  assert.equal(out.content, '# T\n- r\n\n## Learned guards\n- a\n\n## Other\n- r\n');
  assert.equal(removeGuardLine(out.content, 'Learned guards', '- r').changed, false);
  assert.equal(removeGuardLine('## Learned guards\r\n- r\r\n- b\r\n', 'Learned guards', '- r').content, '## Learned guards\r\n- b\r\n');
});
