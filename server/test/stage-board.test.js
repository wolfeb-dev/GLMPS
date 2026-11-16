// server/test/stage-board.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, buildVitals, followupsBySession } from '../lib/observability/stage-board.js';

const sess = (id, stage, extra = {}) => ({
  id,
  cwd: `D:/work/${id}-proj`,
  tool: 'claude-code',
  live: true,
  loop: stage == null ? null : { stage, key: 'x', status: 'active', enteredTs: 1000, ...(extra.loop ?? {}) },
  ...extra,
});

test('board has exactly the 6 named stages in order, incl. Commit as 5th', () => {
  const { stages } = buildBoard([]);
  assert.deepEqual(stages.map((s) => s.key), ['orchestrate', 'execute', 'adversarial', 'gate', 'commit', 'learning']);
  assert.deepEqual(stages.map((s) => s.name), ['Orchestrate', 'Execute', 'Adversarial', 'Gate', 'Commit', 'Learning']);
});

test('loop stage maps to board position (learning=5 -> board 6, commit skipped)', () => {
  const rows = buildBoard([
    sess('a', 1), sess('b', 2), sess('c', 3), sess('d', 4), sess('e', 5),
  ]).rows;
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.stage, 1); assert.equal(by.a.stageKey, 'orchestrate');
  assert.equal(by.b.stage, 2); assert.equal(by.b.stageKey, 'execute');
  assert.equal(by.c.stage, 3); assert.equal(by.c.stageKey, 'adversarial');
  assert.equal(by.d.stage, 4); assert.equal(by.d.stageKey, 'gate');
  assert.equal(by.e.stage, 6); assert.equal(by.e.stageKey, 'learning');
});

test('session with no loop defaults to orchestrate (stage 1)', () => {
  const [r] = buildBoard([sess('x', null)]).rows;
  assert.equal(r.stage, 1);
  assert.equal(r.stageKey, 'orchestrate');
});

test('project is the last path segment of cwd (windows or posix)', () => {
  const rows = buildBoard([
    { id: 'a', cwd: 'D:\\repos\\glmps', live: true, loop: { stage: 2, enteredTs: 1 } },
    { id: 'b', cwd: '/home/u/data-research/', live: true, loop: { stage: 2, enteredTs: 1 } },
  ]).rows;
  assert.equal(rows[0].project, 'glmps');
  assert.equal(rows[1].project, 'data-research');
});

test('git drives committed + Commit stage count/detail', () => {
  const gitBySession = new Map([
    ['dirty', { dirty: 3, ahead: 1, behind: 0, branch: 'main' }],
    ['clean', { dirty: 0, ahead: 2, behind: 0, branch: 'main' }],
  ]);
  const { rows, stages } = buildBoard([sess('dirty', 2), sess('clean', 4), sess('nogit', 2)], { gitBySession });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.dirty.committed, false);
  assert.equal(by.clean.committed, true);
  assert.equal(by.nogit.committed, null); // git unknown
  const commit = stages.find((s) => s.key === 'commit');
  assert.equal(commit.count, 1); // only 'dirty' has uncommitted work
  assert.equal(commit.detail, '1 uncommitted \u00B7 3 unpushed'); // ahead 1 + ahead 2 = 3
});

test('elapsedMs = now - enteredTs, and null when now or enteredTs missing', () => {
  const withNow = buildBoard([sess('a', 2, { loop: { stage: 2, enteredTs: 1000 } })], { now: 6000 }).rows[0];
  assert.equal(withNow.elapsedMs, 5000);
  const noNow = buildBoard([sess('a', 2)]).rows[0];
  assert.equal(noNow.elapsedMs, null);
  const noEntered = buildBoard([{ id: 'a', cwd: '/x/p', live: true, loop: { stage: 2 } }], { now: 6000 }).rows[0];
  assert.equal(noEntered.elapsedMs, null);
});

test('phase + followups come from the injected maps', () => {
  const phaseBySession = new Map([['a', { phase: 'coding', label: 'Coding', doing: 'Edit + tdd' }]]);
  const followupsBySession = new Map([['a', 2]]);
  const [r] = buildBoard([sess('a', 2)], { phaseBySession, followupsBySession }).rows;
  assert.deepEqual(r.phase, { phase: 'coding', label: 'Coding', doing: 'Edit + tdd' });
  assert.equal(r.followups, 2);
  const none = buildBoard([sess('b', 2)]).rows[0];
  assert.equal(none.phase, null);
  assert.equal(none.followups, 0);
});

test('non-commit stage counts reflect how many rows are at that stage', () => {
  const { stages } = buildBoard([sess('a', 2), sess('b', 2), sess('c', 4)]);
  assert.equal(stages.find((s) => s.key === 'execute').count, 2);
  assert.equal(stages.find((s) => s.key === 'gate').count, 1);
  assert.equal(stages.find((s) => s.key === 'orchestrate').count, 0);
});

test('followupsBySession counts backlog items by sessionId, ignoring null', () => {
  const m = followupsBySession([
    { id: '1', sessionId: 'sA' }, { id: '2', sessionId: 'sA' },
    { id: '3', sessionId: 'sB' }, { id: '4', sessionId: null }, { id: '5' },
  ]);
  assert.equal(m.get('sA'), 2);
  assert.equal(m.get('sB'), 1);
  assert.equal(m.has('null'), false);
});

test('empty input yields 6 zero-count stages and no rows', () => {
  const { stages, rows } = buildBoard([]);
  assert.equal(rows.length, 0);
  assert.equal(stages.length, 6);
  assert.ok(stages.every((s) => s.count === 0));
});

// The Stalled vitals tile was the only flow tile that could not click-to-filter,
// because the stall rule lived only inside buildVitals and never reached a row.

test('buildBoard carries lastTs and a stalled flag per row', () => {
  const now = 1_000_000;
  const rows = buildBoard([
    { id: 'fresh', live: true, lastTs: now - 1000 },
    { id: 'stale', live: true, lastTs: now - 11 * 60_000 },
  ], { now }).rows;
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.fresh.stalled, false);
  assert.equal(by.stale.stalled, true);
  assert.equal(by.fresh.lastTs, now - 1000);
});

test('an unknown lastTs is not stalled (absence of a heartbeat is not evidence)', () => {
  const now = 1_000_000;
  const [row] = buildBoard([{ id: 'nolast', live: true }], { now }).rows;
  assert.equal(row.stalled, false);
  assert.equal(row.lastTs, null, 'unknown lastTs must stay null, not be back-filled');
});

test('with no clock, nothing is reported stalled', () => {
  const [row] = buildBoard([{ id: 'x', live: true, lastTs: 1 }], {}).rows;
  assert.equal(row.stalled, false);
});

test('the stall threshold is configurable and boundary-exclusive', () => {
  const now = 1_000_000;
  const at = buildBoard([{ id: 'a', live: true, lastTs: now - 5000 }], { now, stalledMs: 5000 }).rows[0];
  const over = buildBoard([{ id: 'a', live: true, lastTs: now - 5001 }], { now, stalledMs: 5000 }).rows[0];
  assert.equal(at.stalled, false, 'exactly at the threshold is not yet stalled');
  assert.equal(over.stalled, true);
});

test('row stalled flags and the vitals stalled count cannot disagree', () => {
  const now = 1_000_000;
  const sessions = [
    { id: 'fresh', live: true, lastTs: now - 1000 },
    { id: 'stale1', live: true, lastTs: now - 11 * 60_000 },
    { id: 'stale2', live: true, lastTs: now - 40 * 60_000 },
    { id: 'nolast', live: true },
    { id: 'dead', live: false, lastTs: now - 99 * 60_000 },
  ];
  const board = buildBoard(sessions.filter((s) => s.live), { now });
  const vitals = buildVitals({ rows: board.rows, sessions, adapterHealth: {}, now });
  assert.equal(board.rows.filter((r) => r.stalled).length, vitals.stalled.count);
  assert.equal(vitals.stalled.count, 2);
  assert.equal(vitals.stalled.oldestMs, 40 * 60_000);
});
