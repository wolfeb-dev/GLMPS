// server/test/memory-evict-salience.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evictionPlan } from '../lib/evaluation/memory-evict.js';

test('among equally-cold facts, the less-connected one is evicted first', () => {
  // Two facts, both zero reads and equal exposure and bytes; one is linked to
  // by others, one is not. The isolated one should be the eviction target.
  const entries = [
    { target: 'linked.md', line: '- [linked](linked.md) - hub', bytes: 100 },
    { target: 'island.md', line: '- [island](island.md) - lonely', bytes: 100 },
    { target: 'keep.md', line: '- [keep](keep.md) - keep', bytes: 100 },
  ];
  const usage = {
    'linked.md': { reads: 0, exposureSessions: 10 },
    'island.md': { reads: 0, exposureSessions: 10 },
    'keep.md': { reads: 5, exposureSessions: 10 },
  };
  const bodies = { 'linked.md': 'x', 'island.md': 'y', 'keep.md': '[[linked]] references linked' };
  const plan = evictionPlan({ entries, usage, budgetBytes: 250, bodies });
  assert.deepEqual(plan.map((p) => p.target), ['island.md'], 'the unconnected cold fact goes first');
});
