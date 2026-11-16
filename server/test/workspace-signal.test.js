import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSignal } from '../lib/orchestration/workspace-signal.js';

test('non-high -> null', () => {
  assert.equal(workspaceSignal({ level: 'low', reasons: ['x'], ts: 1 }, { sessionId: 's', seen: new Set() }), null);
});

test('high -> signal once, then deduped', () => {
  const seen = new Set();
  const sig = workspaceSignal({ level: 'high', reasons: ['frozen drift'], ts: 1 }, { sessionId: 's', seen });
  assert.equal(sig.code, 'workspace-divergence');
  assert.equal(sig.sessionId, 's');
  assert.match(sig.detail, /frozen drift/);
  assert.equal(workspaceSignal({ level: 'high', reasons: ['frozen drift'], ts: 1 }, { sessionId: 's', seen }), null);
});
