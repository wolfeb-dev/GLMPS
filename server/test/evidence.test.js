import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagValue, MIN_CONSTANT_N } from '../lib/evaluation/evidence.js';

test('tagValue: no samples -> absent', () => {
  const t = tagValue(null, [], { reason: 'no observations' });
  assert.deepEqual(t, { value: null, evidence: 'absent', n: 0, reason: 'no observations' });
});

test('tagValue: varying samples -> measured, no reason field', () => {
  const t = tagValue(4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(t.evidence, 'measured');
  assert.equal(t.value, 4);
  assert.equal(t.n, 10);
  assert.equal('reason' in t, false);
});

test('tagValue: zero variance at n >= MIN_CONSTANT_N -> constant', () => {
  const samples = new Array(MIN_CONSTANT_N).fill(1);
  const t = tagValue(1, samples);
  assert.equal(t.evidence, 'constant');
  assert.equal(t.n, MIN_CONSTANT_N);
});

test('tagValue: zero variance below MIN_CONSTANT_N -> still measured (too few samples to call it constant)', () => {
  const samples = new Array(MIN_CONSTANT_N - 1).fill(1);
  const t = tagValue(1, samples);
  assert.equal(t.evidence, 'measured');
});

test('tagValue: zero-variance boolean samples (all true) also count as constant', () => {
  const samples = new Array(MIN_CONSTANT_N).fill(true);
  const t = tagValue(1, samples);
  assert.equal(t.evidence, 'constant');
});
