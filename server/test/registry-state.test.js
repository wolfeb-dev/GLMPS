// server/test/registry-state.test.js
// Task 1 (glmps-138): pure native-status -> unified 4-state lifecycle mapper
// for the Capability Registry view. web/evaluation/registry-state.js has no
// DOM/I/O so it is importable verbatim under node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapToLifecycle } from '../../web/evaluation/registry-state.js';


test('guard applied -> active', () => {
  assert.deepEqual(mapToLifecycle({ type: 'guard', status: 'applied' }),
    { kind: 'guard', state: 'active', subLabel: 'applied' });
});

test('guard pending/dispatched -> proposed', () => {
  assert.deepEqual(mapToLifecycle({ type: 'guard', status: 'pending' }),
    { kind: 'guard', state: 'proposed', subLabel: 'pending' });
  assert.deepEqual(mapToLifecycle({ type: 'guard', status: 'dispatched' }),
    { kind: 'guard', state: 'proposed', subLabel: 'dispatched' });
});

test('guard with retireCandidate:true -> deprecated, overriding the base applied state', () => {
  assert.deepEqual(mapToLifecycle({ type: 'guard', status: 'applied', retireCandidate: true }),
    { kind: 'guard', state: 'deprecated', subLabel: 'applied' });
});

test('guard retired -> retired', () => {
  assert.deepEqual(mapToLifecycle({ type: 'guard', status: 'retired' }),
    { kind: 'guard', state: 'retired', subLabel: 'retired' });
});

test('guard discarded drops out (returns null)', () => {
  assert.equal(mapToLifecycle({ type: 'guard', status: 'discarded' }), null);
});

// glmps-138 I7 fix: failed/skipped are real, reachable learning-store guard
// statuses (markFailed/markSkipped) that previously fell through to the
// fail-open default state:'proposed', implying still-awaiting-action. They
// are terminal, same as discarded (consistent with system-changes.js's
// GUARD_STATUS, which maps discarded AND failed to 'reverted').
test('guard failed drops out (returns null), same as discarded', () => {
  assert.equal(mapToLifecycle({ type: 'guard', status: 'failed' }), null);
});

test('guard skipped drops out (returns null), same as discarded', () => {
  assert.equal(mapToLifecycle({ type: 'guard', status: 'skipped' }), null);
});


test('skill pending-approval/trialing/approved/discovered/quarantined -> proposed with matching subLabel', () => {
  for (const status of ['discovered', 'quarantined', 'pending-approval', 'approved', 'trialing']) {
    assert.deepEqual(mapToLifecycle({ type: 'skill', status }),
      { kind: 'skill', state: 'proposed', subLabel: status }, `status=${status}`);
  }
});

test('skill kept/installed -> active', () => {
  assert.deepEqual(mapToLifecycle({ type: 'skill', status: 'kept' }),
    { kind: 'skill', state: 'active', subLabel: 'kept' });
  assert.deepEqual(mapToLifecycle({ type: 'skill', status: 'installed' }),
    { kind: 'skill', state: 'active', subLabel: 'installed' });
});

test('skill with retireCandidate:true (archive candidate) -> deprecated', () => {
  assert.deepEqual(mapToLifecycle({ type: 'skill', status: 'kept', retireCandidate: true }),
    { kind: 'skill', state: 'deprecated', subLabel: 'kept' });
});

test('skill archived -> retired', () => {
  assert.deepEqual(mapToLifecycle({ type: 'skill', status: 'archived' }),
    { kind: 'skill', state: 'retired', subLabel: 'archived' });
});

test('skill rejected drops out (returns null)', () => {
  assert.equal(mapToLifecycle({ type: 'skill', status: 'rejected' }), null);
});


test('memory proposal -> proposed; written -> active', () => {
  assert.deepEqual(mapToLifecycle({ type: 'memory', status: 'proposal' }),
    { kind: 'memory', state: 'proposed', subLabel: 'proposal' });
  assert.deepEqual(mapToLifecycle({ type: 'memory', status: 'written' }),
    { kind: 'memory', state: 'active', subLabel: 'written' });
});


test('cross-agent-memory quarantined/trialing -> proposed', () => {
  assert.deepEqual(mapToLifecycle({ type: 'cross-agent-memory', status: 'quarantined' }),
    { kind: 'cross-agent-memory', state: 'proposed', subLabel: 'quarantined' });
  assert.deepEqual(mapToLifecycle({ type: 'cross-agent-memory', status: 'trialing' }),
    { kind: 'cross-agent-memory', state: 'proposed', subLabel: 'trialing' });
});

// 'pending-approval'/'approved'/'discovered' are real cross-agent-memory-
// store.js statuses with no explicit table entry - they still correctly
// resolve to 'proposed' via mapToLifecycle's own fail-open default, not a
// dedicated CROSS_AGENT_MEMORY_STATE key (glmps-138 fix pass: 'pending' and
// 'pushed', two keys the real store never actually produces, were removed
// from that table rather than left as dead/misleading entries).
test('cross-agent-memory pending-approval/approved/discovered -> proposed via fail-open, not a dedicated table entry', () => {
  for (const status of ['pending-approval', 'approved', 'discovered']) {
    assert.deepEqual(mapToLifecycle({ type: 'cross-agent-memory', status }),
      { kind: 'cross-agent-memory', state: 'proposed', subLabel: status }, `status=${status}`);
  }
});

test('cross-agent-memory kept -> active; retired -> retired', () => {
  assert.deepEqual(mapToLifecycle({ type: 'cross-agent-memory', status: 'kept' }),
    { kind: 'cross-agent-memory', state: 'active', subLabel: 'kept' });
  assert.deepEqual(mapToLifecycle({ type: 'cross-agent-memory', status: 'retired' }),
    { kind: 'cross-agent-memory', state: 'retired', subLabel: 'retired' });
});

// glmps-138 fix pass (wave2-review.md Registry Minor #3): 'rejected' is a
// real, reachable terminal status (rejectCandidate() and resolveTrial()'s
// negative verdict) that previously had no `dropped` entry and fell open to
// state:'proposed', implying a rejected candidate was still awaiting
// review. It now drops the row entirely, same as guard/skill above.
test('cross-agent-memory rejected drops out (returns null)', () => {
  assert.equal(mapToLifecycle({ type: 'cross-agent-memory', status: 'rejected' }), null);
});


test('unknown type -> proposed, kind/subLabel echoed verbatim, never throws', () => {
  assert.deepEqual(mapToLifecycle({ type: 'mystery', status: 'whatever' }),
    { kind: 'mystery', state: 'proposed', subLabel: 'whatever' });
});

test('unknown status for a known type -> proposed, fail-open', () => {
  assert.deepEqual(mapToLifecycle({ type: 'guard', status: 'some-future-status' }),
    { kind: 'guard', state: 'proposed', subLabel: 'some-future-status' });
});

test('malformed/empty input never throws', () => {
  assert.doesNotThrow(() => mapToLifecycle({}));
  assert.doesNotThrow(() => mapToLifecycle(null));
  assert.doesNotThrow(() => mapToLifecycle(undefined));
  assert.deepEqual(mapToLifecycle(null), { kind: undefined, state: 'proposed', subLabel: undefined });
});
