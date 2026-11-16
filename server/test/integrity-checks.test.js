// server/test/integrity-checks.test.js
//
// The three integrity checks, one positive and one negative test each.
// Every test drives the check through runReconciliation() (its real entry
// point) rather than calling a check's run() directly, then filters the
// returned findings by check_name - the same shape morning-brief.js already
// consumes ({ check_name, desk, severity, details }).
//
// ctx contract used throughout (see integrity-checks.js for the authoritative
// doc): { now, config, gateRuns[], orphanedArtifacts[], lessons[] }. Every
// field is optional; a check with nothing to look at produces no findings
// (fail open).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runReconciliation, reconciliationConfig } from '../lib/observability/reconciliation.js';

const DAY = 86400000;
const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function findingsFor(name, ctx) {
  return runReconciliation({ now: NOW, ...ctx }).filter((f) => f.check_name === name);
}


function gateRuns(count, status = 'skipped') {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({ runId: `nightly-2026081${i}`, gateName: 'cross-model-critic', status });
  }
  return rows;
}

test('skipped_gates fires only after three consecutive runs skip the same gate', () => {
  const f = findingsFor('skipped_gates', { gateRuns: gateRuns(3) });
  assert.equal(f.length, 1);
  assert.equal(f[0].data.gateName, 'cross-model-critic');
});

test('skipped_gates does not fire after only two consecutive skips', () => {
  const f = findingsFor('skipped_gates', { gateRuns: gateRuns(2) });
  assert.equal(f.length, 0);
});


test('orphaned_artifact fires once an open artifact.orphaned has sat unresolved past 7 days', () => {
  const f = findingsFor('orphaned_artifact', {
    orphanedArtifacts: [{ ref: 'w1', type: 'worktree', path: '/tmp/w1', openedAt: iso(NOW - 8 * DAY), clearedAt: null }],
  });
  assert.equal(f.length, 1);
});

test('orphaned_artifact does not fire once cleared', () => {
  const f = findingsFor('orphaned_artifact', {
    orphanedArtifacts: [{
      ref: 'w1', type: 'worktree', path: '/tmp/w1', openedAt: iso(NOW - 8 * DAY), clearedAt: iso(NOW - 1 * DAY),
    }],
  });
  assert.equal(f.length, 0);
});

test('orphaned_artifact does not fire before the 7 day grace elapses', () => {
  const f = findingsFor('orphaned_artifact', {
    orphanedArtifacts: [{ ref: 'w1', type: 'worktree', path: '/tmp/w1', openedAt: iso(NOW - 2 * DAY), clearedAt: null }],
  });
  assert.equal(f.length, 0);
});


test('ungated_reflex is critical for a reflex lesson with no approved promotion', () => {
  const f = findingsFor('ungated_reflex', { lessons: [{ lessonId: 'l1', reflex: true, promoted: false }] });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'critical');
});

test('ungated_reflex does not fire once the lesson is promoted', () => {
  const f = findingsFor('ungated_reflex', { lessons: [{ lessonId: 'l1', reflex: true, promoted: true }] });
  assert.equal(f.length, 0);
});

test('ungated_reflex ignores a non-reflex lesson entirely', () => {
  const f = findingsFor('ungated_reflex', { lessons: [{ lessonId: 'l1', reflex: false, promoted: false }] });
  assert.equal(f.length, 0);
});

// sanity: reconciliationConfig is importable from the same module the checks
// are exercised through (used by reconciliation.test.js too).
test('reconciliationConfig is exported from reconciliation.js', () => {
  assert.equal(typeof reconciliationConfig, 'function');
});
