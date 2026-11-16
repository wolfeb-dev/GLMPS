// server/test/memory-attestation-alerts.test.js
// glmps-145. computeMemoryAttestation reuses attestGuardrails unchanged, so its
// findings arrive titled "Guardrail file modified" and targeted at the
// Governance pillar, whose engagement view renders the GUARDRAIL attestation
// card. Surfacing them raw would report guardrail drift and then deep-link the
// operator to a card that does not show it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryAttestationAlerts } from '../lib/governance/cross-agent-memory.js';

const finding = (over = {}) => ({
  id: 'attest:guardrail-modified:D:\\glmps\\GEMINI.md',
  source: 'attestation',
  severity: 'critical',
  kind: 'guardrail-modified',
  title: 'Guardrail file modified: gemini',
  detail: '"D:\\glmps\\GEMINI.md" content hash does not match baseline',
  target: { view: 'governance' },
  ...over,
});

test('a memory finding names memory, not guardrails', () => {
  const [a] = memoryAttestationAlerts([finding()]);
  assert.equal(a.title, 'Cross-agent memory file modified: gemini');
  assert.equal(a.kind, 'memory-modified');
});

test('the id is namespaced so it cannot collide with a guardrail finding on the same file', () => {
  const [a] = memoryAttestationAlerts([finding()]);
  assert.ok(a.id.startsWith('attest-memory:'));
  assert.notEqual(a.id, finding().id);
});

test('the deep-link points at a view that actually shows shared memory', () => {
  const [a] = memoryAttestationAlerts([finding()]);
  assert.deepEqual(a.target, { view: 'registry' });
});

test('severity and detail are preserved verbatim', () => {
  const [a] = memoryAttestationAlerts([finding()]);
  assert.equal(a.severity, 'critical');
  assert.equal(a.detail, finding().detail);
});

test('a non-guardrail-modified kind is passed through unchanged', () => {
  const [a] = memoryAttestationAlerts([finding({ kind: 'guardrail-missing', title: 'Guardrail file missing: gemini' })]);
  assert.equal(a.kind, 'guardrail-missing');
});

test('empty and non-array input yield an empty array, never throw', () => {
  assert.deepEqual(memoryAttestationAlerts([]), []);
  assert.deepEqual(memoryAttestationAlerts(null), []);
  assert.deepEqual(memoryAttestationAlerts(undefined), []);
});
