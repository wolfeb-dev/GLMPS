import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordSyncOutcome, graphSyncHealth, loadSyncHealth, persistSyncHealth } from '../lib/observability/graph-sync-health.js';
import { classifyGraphifyRun } from '../lib/observability/graphify-outcome.js';

test('records an outcome per root', () => {
  let s = {};
  s = recordSyncOutcome(s, 'D:/a', { outcome: 'updated', nodes: 10, existingNodes: null, reason: 'rebuilt 10 nodes' }, { now: 1000 });
  const h = graphSyncHealth(s);
  assert.equal(h['D:/a'].outcome, 'updated');
  assert.equal(h['D:/a'].ts, 1000);
  assert.equal(h['D:/a'].consecutive, 1);
});

test('counts consecutive identical outcomes and resets on change', () => {
  let s = {};
  s = recordSyncOutcome(s, 'D:/a', { outcome: 'refused', nodes: 1, existingNodes: 2, reason: 'r' }, { now: 1 });
  s = recordSyncOutcome(s, 'D:/a', { outcome: 'refused', nodes: 1, existingNodes: 2, reason: 'r' }, { now: 2 });
  assert.equal(graphSyncHealth(s)['D:/a'].consecutive, 2);
  s = recordSyncOutcome(s, 'D:/a', { outcome: 'updated', nodes: 3, existingNodes: null, reason: 'u' }, { now: 3 });
  assert.equal(graphSyncHealth(s)['D:/a'].consecutive, 1);
});

test('keeps roots independent', () => {
  let s = {};
  s = recordSyncOutcome(s, 'D:/a', { outcome: 'updated', nodes: 1, existingNodes: null, reason: 'u' }, { now: 1 });
  s = recordSyncOutcome(s, 'D:/b', { outcome: 'refused', nodes: 1, existingNodes: 2, reason: 'r' }, { now: 1 });
  const h = graphSyncHealth(s);
  assert.equal(h['D:/a'].outcome, 'updated');
  assert.equal(h['D:/b'].outcome, 'refused');
});

test('round-trips through disk and returns {} for a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-'));
  const file = path.join(dir, 'graph-sync-health.json');
  assert.deepEqual(loadSyncHealth(file), {});
  const s = recordSyncOutcome({}, 'D:/a', { outcome: 'noop', nodes: null, existingNodes: null, reason: 'n' }, { now: 5 });
  persistSyncHealth(file, s);
  assert.equal(loadSyncHealth(file)['D:/a'].outcome, 'noop');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt file loads as empty rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-'));
  const file = path.join(dir, 'graph-sync-health.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadSyncHealth(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a refusal at exit 0 is recorded, not treated as success', () => {
  // The exact regression: exit 0, refusal in stderr. Before this change the
  // tick saw code === 0 and recorded nothing at all.
  const result = classifyGraphifyRun({
    code: 0,
    stdout: 'Nothing to update or rebuild failed - check output above.\n',
    stderr: '[graphify] WARNING: new graph has 4478 nodes but existing graph.json has 4479. Refusing to overwrite.\n',
  });
  const s = recordSyncOutcome({}, 'D:/Harbor-App', result, { now: 1 });
  assert.equal(graphSyncHealth(s)['D:/Harbor-App'].outcome, 'refused');
});
