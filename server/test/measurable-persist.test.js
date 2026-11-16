import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurableFromGuardCandidate, measurableFromSkillCandidate, measurableFromWorkspaceSignal } from '../lib/evaluation/measurable-persist.js';

test('measurableFromGuardCandidate shapes a guard-retire.js candidate', () => {
  const m = measurableFromGuardCandidate({ code: 'ui-without-frontend-design', rule: '- rule text', reason: 'never fired across 20 observed sessions', n: 20 }, 500);
  assert.equal(m.id, 'guard-retire:ui-without-frontend-design');
  assert.equal(m.kind, 'guard-retire');
  assert.match(m.title, /ui-without-frontend-design/);
  assert.equal(m.detail, 'never fired across 20 observed sessions');
  assert.equal(m.evidence.sessionId, null);
  assert.equal(m.evidence.ref, 'ui-without-frontend-design');
  assert.deepEqual(m.metric, { n: 20 });
  assert.equal(m.ts, 500);
});

test('measurableFromSkillCandidate shapes a skill-retire.js candidate', () => {
  const m = measurableFromSkillCandidate({ id: 'user:demo-skill', name: 'demo-skill', plugin: null, reason: 'installed and unused for 200 days', observedDays: 200 }, 600);
  assert.equal(m.id, 'skill-retire:user:demo-skill');
  assert.equal(m.kind, 'skill-retire');
  assert.match(m.title, /demo-skill/);
  assert.equal(m.evidence.ref, 'user:demo-skill');
  assert.deepEqual(m.metric, { observedDays: 200 });
  assert.equal(m.ts, 600);
});

test('measurableFromWorkspaceSignal shapes a workspace-signal.js signal, keyed by session+detail', () => {
  const m = measurableFromWorkspaceSignal({ code: 'workspace-divergence', sessionId: 's1', detail: 'edits entered frozen zone', ts: 700 });
  assert.equal(m.id, 'workspace-divergence:s1::edits entered frozen zone');
  assert.equal(m.kind, 'workspace-divergence');
  assert.equal(m.detail, 'edits entered frozen zone');
  assert.equal(m.evidence.sessionId, 's1');
  assert.equal(m.evidence.ref, null);
  assert.equal(m.metric, null);
  assert.equal(m.ts, 700);
});
