// Text decisions of the secondary graph scan dialog (web/shared/graph-scan-panel.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortRoots, scopePill, scanSummary, mergedLine } from '../../web/shared/graph-scan-panel.js';

const roots = [
  { root: 'D:/z-excluded', scope: 'excluded', reason: 'config exclude: nq' },
  { root: 'D:/b-repo', scope: 'machine', reason: 'session cwd', optedIn: true },
  { root: 'D:/glmps-2.0-runtime', scope: 'ship', reason: 'kernel repo' },
  { root: 'D:/a-repo', scope: 'machine', reason: 'additionalDirectories', optedIn: false },
];

test('sortRoots: ship, then machine candidates, then excluded, by path', () => {
  assert.deepEqual(sortRoots(roots).map((r) => r.root), ['D:/glmps-2.0-runtime', 'D:/a-repo', 'D:/b-repo', 'D:/z-excluded']);
});

test('scopePill names what will be indexed', () => {
  assert.deepEqual(scopePill(roots[2], false), { label: 'Ship', tone: 'success' });
  assert.deepEqual(scopePill(roots[1], true), { label: 'Opted in', tone: 'success' });
  assert.deepEqual(scopePill(roots[3], true), { label: 'Not opted in', tone: 'neutral' });
  assert.deepEqual(scopePill(roots[3], false), { label: 'Candidate', tone: 'neutral' });
  assert.deepEqual(scopePill(roots[0], true), { label: 'Excluded', tone: 'neutral' });
});

test('scanSummary counts candidates and opted-in repos', () => {
  assert.equal(scanSummary({ enabled: true, roots }), '2 candidates \u00B7 1 opted in \u00B7 scan on');
  assert.equal(scanSummary({ enabled: false, roots: [roots[3]] }), '1 candidate \u00B7 0 opted in \u00B7 scan off');
});

test('mergedLine describes the merged graph or its absence', () => {
  assert.equal(mergedLine({ manifest: null }), 'No merged machine graph yet.');
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(mergedLine({ manifest: { builtAt: '2026-10-26T09:00:00Z', roots: [{}, {}], nodes: 12345 } }, now),
    'Merged machine graph: 2 repos, 12,345 nodes, built 3h ago.');
});
