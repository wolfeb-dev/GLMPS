// Pure decisions for how a wake note reaches a parked session (card glmps-2-0-47).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteProvenance, decideWakeDelivery } from '../lib/scut/wake-delivery.js';

const SID = '3f2a9b1c-1111-4222-8333-444455556666';

test('noteProvenance: a sender on the allowlist is the operator', () => {
  assert.equal(noteProvenance({ user: 'U_OP', allowedUsers: ['U_OP', 'U_B'] }), 'operator');
});

test('noteProvenance: unknown, missing or empty sender is external', () => {
  assert.equal(noteProvenance({ user: 'U_X', allowedUsers: ['U_OP'] }), 'external');
  assert.equal(noteProvenance({ user: null, allowedUsers: ['U_OP'] }), 'external');
  assert.equal(noteProvenance({ user: '', allowedUsers: [''] }), 'external');
  assert.equal(noteProvenance({ user: 'U_OP', allowedUsers: [] }), 'external');
  assert.equal(noteProvenance({ user: 'U_OP' }), 'external');
});

test('decideWakeDelivery: operator note with the flag on and a session id hands off', () => {
  assert.equal(decideWakeDelivery({ provenance: 'operator', handoffEnabled: true, sessionId: SID }), 'handoff');
});

test('decideWakeDelivery: a non-operator note keeps the tool-result wake', () => {
  assert.equal(decideWakeDelivery({ provenance: 'external', handoffEnabled: true, sessionId: SID }), 'tool-result');
  assert.equal(decideWakeDelivery({ provenance: undefined, handoffEnabled: true, sessionId: SID }), 'tool-result');
});

test('decideWakeDelivery: flag off keeps the tool-result wake', () => {
  assert.equal(decideWakeDelivery({ provenance: 'operator', handoffEnabled: false, sessionId: SID }), 'tool-result');
});

test('decideWakeDelivery: no resumable session id keeps the tool-result wake (fail open)', () => {
  assert.equal(decideWakeDelivery({ provenance: 'operator', handoffEnabled: true, sessionId: null }), 'tool-result');
  assert.equal(decideWakeDelivery({ provenance: 'operator', handoffEnabled: true, sessionId: 'not-a-uuid' }), 'tool-result');
});
