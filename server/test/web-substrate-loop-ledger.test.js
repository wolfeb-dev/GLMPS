// server/test/web-substrate-loop-ledger.test.js
// groupGuardChanges() (web/evaluation/substrate-loop.js) collapses guard-type
// SystemChanges that share the same rule title (one backend row per
// (code, project) learning-store item) into one group per rule. Pure
// function, no DOM - safe to import directly under node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupGuardChanges } from '../../web/evaluation/substrate-loop.js';

function guard(title, status, opts = {}) {
  return { id: `guard-${Math.random()}`, type: 'guard', title, status, evidence: opts.evidence || {}, measuredEffect: opts.measuredEffect ?? null, ts: opts.ts ?? null };
}

test('groups only type=guard changes, ignoring memory/promotion entirely', () => {
  const changes = [
    guard('rule-a', 'measuring'),
    { id: 'm1', type: 'memory', title: 'some memory', status: 'proposed', ts: 1 },
    { id: 'p1', type: 'promotion', title: 'v2 vs v1', status: 'kept', ts: 2 },
  ];
  const groups = groupGuardChanges(changes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'rule-a');
});

test('same title collapses into one group; count == number of instances', () => {
  const changes = [
    guard('ui without frontend design', 'measuring'),
    guard('ui without frontend design', 'measuring'),
    guard('ui without frontend design', 'reverted'),
  ];
  const groups = groupGuardChanges(changes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 3);
  assert.deepEqual(groups[0].statusCounts, { measuring: 2, reverted: 1 });
  assert.equal(groups[0].instances.length, 3);
});

test('different titles produce distinct groups, preserving first-seen order', () => {
  const changes = [guard('b-rule', 'measuring'), guard('a-rule', 'measuring'), guard('b-rule', 'reverted')];
  const groups = groupGuardChanges(changes);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.title), ['b-rule', 'a-rule']);
  assert.equal(groups.find((g) => g.title === 'b-rule').count, 2);
});

test('ts on a group is the max ts among its instances (for ledger sort position)', () => {
  const changes = [
    guard('r', 'measuring', { ts: 100 }),
    guard('r', 'reverted', { ts: 500 }),
    guard('r', 'measuring', { ts: 300 }),
  ];
  const groups = groupGuardChanges(changes);
  assert.equal(groups[0].ts, 500);
});

test('measuredEffect: null when no instance has shadow data (never invents a rate)', () => {
  const changes = [guard('r', 'measuring'), guard('r', 'proposed')];
  const groups = groupGuardChanges(changes);
  assert.equal(groups[0].measuredEffect, null);
});

test('measuredEffect: reduces to the single instance data when only one instance has it', () => {
  const changes = [
    guard('r', 'measuring', { measuredEffect: { fireCount: 3, episodes: 2, evidence: 'exercised' } }),
    guard('r', 'measuring'), // no shadow data
  ];
  const groups = groupGuardChanges(changes);
  assert.deepEqual(groups[0].measuredEffect, { fireCount: 3, episodes: 2, evidence: 'exercised' });
});

test('measuredEffect: sums fireCount and episodes across multiple instances with data', () => {
  const changes = [
    guard('r', 'measuring', { measuredEffect: { fireCount: 2, episodes: 1, evidence: 'exercised' } }),
    guard('r', 'measuring', { measuredEffect: { fireCount: 6, episodes: 3, evidence: 'exercised' } }),
  ];
  const groups = groupGuardChanges(changes);
  assert.deepEqual(groups[0].measuredEffect, { fireCount: 8, episodes: 4, evidence: 'exercised' });
});

test('empty/malformed input never throws and returns []', () => {
  assert.deepEqual(groupGuardChanges([]), []);
  assert.deepEqual(groupGuardChanges(undefined), []);
  assert.deepEqual(groupGuardChanges(null), []);
  assert.deepEqual(groupGuardChanges([null, undefined, { type: 'memory' }]), []);
});

test('missing/empty title falls back to a stable "untitled change" bucket', () => {
  const changes = [{ id: 'g1', type: 'guard', status: 'proposed' }, { id: 'g2', type: 'guard', status: 'measuring', title: '' }];
  const groups = groupGuardChanges(changes);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'untitled change');
  assert.equal(groups[0].count, 2);
});

// (77 guard rows) collapses to 12 distinct rules. Locks in the rollup ratio
// so a future backend change to guard title generation gets caught here.
test('empirical fixture: 77 guard instances across 12 rule titles collapse to 12 groups summing back to 77', () => {
  const titles = {
    'done without verification': 13, 'serial agents no parallel': 11, 'bash grep over grep tool': 11,
    'sleep poll': 9, 'ui without frontend design': 8, 'opus on mechanical': 6,
    'plan skipped on large change': 5, 'heavy edits no subagents': 5, 'ui design too late': 3,
    'reread loop': 3, 'backtest result without skeptic': 2, 'egress': 1,
  };
  const changes = [];
  for (const [title, count] of Object.entries(titles)) {
    for (let i = 0; i < count; i++) changes.push(guard(title, 'measuring', { ts: i }));
  }
  assert.equal(changes.length, 77);
  const groups = groupGuardChanges(changes);
  assert.equal(groups.length, 12);
  assert.equal(groups.reduce((sum, g) => sum + g.count, 0), 77);
});
