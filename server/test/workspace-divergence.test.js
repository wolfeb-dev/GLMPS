import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDivergence } from '../lib/orchestration/workspace-divergence.js';

const decl = (goal) => ({ goal, hypothesis: null, concepts: [], blockedOn: null, nextStep: null, ts: 1 });
const obs = (paths, zone) => ({ activePaths: paths, activeSkills: [], activeAgents: [], zone, stage: 2, ts: 2 });

test('missing side -> null', () => {
  assert.equal(computeDivergence(null, obs(['a'], 'dev')), null);
  assert.equal(computeDivergence(decl('x'), null), null);
});

test('frozen/prod zone drift the goal did not name -> high', () => {
  const d = computeDivergence(decl('implement FVG gate'), obs(['data-research/raw/frozen_x.py'], 'frozen'));
  assert.equal(d.level, 'high');
  assert.match(d.reasons.join(' '), /frozen/i);
});

test('goal token present in a path -> none', () => {
  const d = computeDivergence(decl('refactor auth flow'), obs(['server/auth/login.js'], 'dev'));
  assert.equal(d.level, 'none');
});

test('no shared token, benign zone -> low', () => {
  const d = computeDivergence(decl('refactor auth flow'), obs(['web/theme.css'], 'dev'));
  assert.equal(d.level, 'low');
});

test('substring-only overlap does not suppress divergence (whole-word)', () => {
  const d = computeDivergence(decl('cat'), obs(['server/category/index.js'], 'dev'));
  assert.equal(d.level, 'low');
});
