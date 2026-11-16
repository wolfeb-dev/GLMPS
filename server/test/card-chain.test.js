// server/test/card-chain.test.js
// a card's chain is its prompt (intent), its declared plan, and its task
// class. Pure over its inputs - no fs, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardChain } from '../lib/kernel/chain.js';

test('the chain is the prompt as intent, the declared plan, and the classified task', () => {
  const c = cardChain({ item: { id: 'mc-1', prompt: 'Fix the broken wiki build' }, progress: { 'mc-1': { plan: 'docs/superpowers/plans/p.md' } }, classify: () => ({ taskClass: 'debug' }) });
  assert.deepEqual(c, { id: 'mc-1', intent: 'Fix the broken wiki build', plan: 'docs/superpowers/plans/p.md', taskClass: 'debug', testEditsApproved: null, testEditsDeclared: null });
  assert.equal(cardChain({ item: { id: 'x', prompt: 'p' }, progress: {}, classify: () => ({ taskClass: 'feature' }) }).plan, null);
});

test('the chain carries the operator test-edits approval, null when absent', () => {
  const ap = { by: 'operator', at: '2026-10-26T00:00:00.000Z', note: null };
  const classify = () => ({ taskClass: 'debug' });
  assert.deepEqual(cardChain({ item: { id: 'a', prompt: 'p', testEditsApproved: ap }, progress: {}, classify }).testEditsApproved, ap);
  assert.equal(cardChain({ item: { id: 'a', prompt: 'p' }, progress: {}, classify }).testEditsApproved, null);
});

test('cardChain exposes testEditsDeclared, null when absent', () => {
  const classify = () => ({ taskClass: 'debug' });
  const d = { reason: 'r', at: 'x', by: 'agent' };
  assert.deepEqual(cardChain({ item: { id: 'a', prompt: 'p', testEditsDeclared: d }, progress: {}, classify }).testEditsDeclared, d);
  assert.equal(cardChain({ item: { id: 'a', prompt: 'p' }, progress: {}, classify }).testEditsDeclared, null);
});
