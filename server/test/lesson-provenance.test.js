// server/test/lesson-provenance.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCOPES,
  LessonProvenanceError,
  normalizeProvenance,
  assertProvenance,
} from '../lib/evaluation/lesson-provenance.js';

test('assertProvenance rejects a lesson with no traceable origin', () => {
  assert.throws(() => assertProvenance(normalizeProvenance({ scope: 'repo' })), /provenance/i);
});

test('assertProvenance rejects a lesson with no traceable origin using the exported error class', () => {
  assert.throws(
    () => assertProvenance(normalizeProvenance({ scope: 'repo' })),
    LessonProvenanceError,
  );
});

test('assertProvenance accepts event-id-only provenance', () => {
  assert.doesNotThrow(() => assertProvenance(normalizeProvenance({ scope: 'repo', sourceEventIds: ['e1'] })));
});

test('assertProvenance accepts derived-from-ref-only provenance', () => {
  assert.doesNotThrow(() => assertProvenance(normalizeProvenance({ scope: 'repo', derivedFromRefs: ['abc123'] })));
});

test('assertProvenance rejects an unknown scope', () => {
  assert.throws(() => assertProvenance(normalizeProvenance({ scope: 'galaxy', derivedFromRefs: ['abc123'] })));
});

test('SCOPES is exactly repo, desk, global', () => {
  assert.deepEqual(SCOPES, ['repo', 'desk', 'global']);
});

test('normalizeProvenance fills in defaults for every field', () => {
  const p = normalizeProvenance({ scope: 'desk', derivedFromRefs: ['abc'] });
  assert.equal(p.sourceRunId, null);
  assert.deepEqual(p.sourceEventIds, []);
  assert.deepEqual(p.derivedFromRefs, ['abc']);
  assert.equal(p.scope, 'desk');
  assert.equal(typeof p.createdAt, 'string');
});

test('normalizeProvenance preserves a supplied createdAt and sourceRunId', () => {
  const p = normalizeProvenance({
    scope: 'global',
    sourceEventIds: ['e1'],
    sourceRunId: 'nightly-20260101',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(p.sourceRunId, 'nightly-20260101');
  assert.equal(p.createdAt, '2026-01-01T00:00:00.000Z');
});

test('normalizeProvenance defaults scope to null when absent', () => {
  const p = normalizeProvenance({ sourceEventIds: ['e1'] });
  assert.equal(p.scope, null);
});
