import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyOutcome, mergeOutcome } from '../lib/evaluation/outcome-record.js';

test('emptyOutcome fills schema with nulls + overrides', () => {
  const o = emptyOutcome({ id: 'x', unit: 'session' });
  assert.equal(o.id, 'x');
  assert.equal(o.unit, 'session');
  assert.equal(o.turns, null);
  assert.equal(o.model, null);
  assert.equal(o.actor, null);
  assert.deepEqual(o.extra, {});
  assert.equal(o.verifier.tests, null);
  assert.equal(o.wallClockMs.total, null);
});

test('emptyOutcome accepts nested override', () => {
  const o = emptyOutcome({ verifier: { tests: true } });
  assert.equal(o.verifier.tests, true);
  assert.equal(o.verifier.lint, null);
});

test('emptyOutcome accepts model as a top-level scalar override', () => {
  const o = emptyOutcome({ model: 'claude-sonnet-5' });
  assert.equal(o.model, 'claude-sonnet-5');
});

test('emptyOutcome accepts actor as a top-level scalar override', () => {
  const o = emptyOutcome({ actor: 'alice' });
  assert.equal(o.actor, 'alice');
});

test('mergeOutcome deep-merges nested groups without dropping siblings', () => {
  const base = emptyOutcome({ verifier: { lint: true } });
  const merged = mergeOutcome(base, { verifier: { tests: true }, turns: 4, model: 'claude-sonnet-5', actor: 'alice' });
  assert.equal(merged.verifier.tests, true);
  assert.equal(merged.verifier.lint, true);
  assert.equal(merged.turns, 4);
  assert.equal(merged.model, 'claude-sonnet-5');
  assert.equal(merged.actor, 'alice');
  assert.equal(base.turns, null); // base not mutated
  assert.equal(base.model, null); // base not mutated
  assert.equal(base.actor, null); // base not mutated
});
