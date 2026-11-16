// server/test/reconciliation-contract.test.js
//
// The contract between the integrity checks and everything that renders them.
//
// The checks emit STRUCTURED details, which is right for programmatic
// consumers. Every renderer (the morning brief) treats `details` as a string.
// Left unreconciled that produces "[object Object]" in the operator's face,
// which is how this was actually found.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReconciliation } from '../lib/observability/reconciliation.js';
import { buildBrief } from '../lib/observability/morning-brief.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-recon-contract-')); }

const NOW = Date.parse('2026-08-16T00:00:00.000Z');
const DAY = 86400000;

// Fires all three checks: three skipped runs of one gate, an artifact open for
// 8 days, and a reflex lesson with no promotion.
const FIRING = {
  now: NOW,
  gateRuns: ['nightly-20260813', 'nightly-20260814', 'nightly-20260815']
    .map((runId) => ({ runId, gateName: 'cross-model-critic', status: 'skipped' })),
  orphanedArtifacts: [{ ref: 'w1', type: 'worktree', path: '/tmp/w1', openedAt: NOW - 8 * DAY, clearedAt: null }],
  lessons: [{ lessonId: 'l1', reflex: true, promoted: false }],
};

test('every finding carries a human-readable details string', () => {
  const findings = runReconciliation(FIRING);
  assert.equal(findings.length, 3, 'this fixture is meant to produce one finding per check');
  for (const f of findings) {
    assert.equal(typeof f.details, 'string', `${f.check_name} details must render as a string`);
    assert.equal(f.details.includes('[object Object]'), false, `${f.check_name} details leaked a raw object`);
  }
});

test('the structured detail is preserved alongside the rendered string', () => {
  const skipped = runReconciliation(FIRING).find((f) => f.check_name === 'skipped_gates');
  assert.ok(skipped, 'skipped_gates should fire for three consecutive skips');
  assert.equal(typeof skipped.data, 'object', 'programmatic consumers keep the structured form');
  assert.equal(skipped.data.gateName, 'cross-model-critic');
});

test('a finding renders into the morning brief without leaking an object', () => {
  const brief = buildBrief({ runEvents: [], reviews: [], integrity: runReconciliation(FIRING), now: NOW });
  assert.ok(brief.lines.length > 0);
  for (const line of brief.lines) {
    assert.equal(line.includes('[object Object]'), false, `brief line leaked an object: ${line}`);
  }
});

test('a fresh install produces no findings and an entirely empty brief', () => {
  const findings = runReconciliation({ now: NOW });
  assert.deepEqual(findings, []);
  const brief = buildBrief({ runEvents: [], reviews: [], integrity: findings, now: NOW });
  assert.deepEqual(brief.lines, []);
});

test('findings are still emitted to the spine when a stateDir is supplied', () => {
  const dir = tmp();
  const findings = runReconciliation({ ...FIRING, stateDir: dir });
  assert.equal(findings.length, 3);
});
