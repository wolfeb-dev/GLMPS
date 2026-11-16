import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSummary, fleetDriftCount, isEmptyWorkspaceSummary } from '../../web/overview/workspace-view.js';

test('workspaceSummary picks the fields the panel renders, null-safe', () => {
  assert.deepEqual(workspaceSummary(null), { goal: '', lines: [], drift: 'none', paths: [] });
  const ws = {
    declared: { goal: 'ship auth', hypothesis: 'sessions leak', nextStep: null, blockedOn: null },
    observed: { activePaths: ['web/x.css'] },
    divergence: { level: 'high', reasons: ['x'] },
  };
  const s = workspaceSummary(ws);
  assert.equal(s.goal, 'ship auth');
  assert.equal(s.drift, 'high');
  assert.deepEqual(s.paths, ['web/x.css']);
  assert.ok(s.lines.some(l => l.k === 'hypothesis' && l.v === 'sessions leak'));
  assert.ok(!s.lines.some(l => l.k === 'nextStep')); // null fields omitted
});

test('fleetDriftCount counts non-none live divergences', () => {
  const list = [
    { divergence: { level: 'high' } },
    { divergence: { level: 'none' } },
    { divergence: null },
    { divergence: { level: 'low' } },
  ];
  assert.equal(fleetDriftCount(list), 2);
});

test('isEmptyWorkspaceSummary: truly empty -> true; drift not-none with empty fields -> false', () => {
  assert.equal(isEmptyWorkspaceSummary({ goal: '', lines: [], paths: [], drift: 'none' }), true);
  assert.equal(isEmptyWorkspaceSummary({ goal: '', lines: [], paths: [], drift: 'high' }), false);
  assert.equal(isEmptyWorkspaceSummary({ goal: 'x', lines: [], paths: [], drift: 'none' }), false);
});
