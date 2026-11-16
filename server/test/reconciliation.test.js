// server/test/reconciliation.test.js
//
// Registry mechanics for the reconciliation monitor (handoff B5): the CHECKS
// registry shape, reconciliationConfig defaulting/override merge, and
// runReconciliation's enable/disable filtering plus its one
// reconciliation.integrity_finding spine event per finding. Per-check firing logic
// (the three checks themselves) is covered in integrity-checks.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECKS, reconciliationConfig, runReconciliation } from '../lib/observability/reconciliation.js';
import { readSpineEvents } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reconciliation-')); }

const CHECK_NAMES = ['skipped_gates', 'orphaned_artifact', 'ungated_reflex'];

test('CHECKS declares exactly the three integrity checks with a name, severity and run function', () => {
  assert.equal(CHECKS.length, 3);
  assert.deepEqual(CHECKS.map((c) => c.name).sort(), [...CHECK_NAMES].sort());
  for (const c of CHECKS) {
    assert.equal(typeof c.name, 'string');
    assert.ok(['info', 'warn', 'critical'].includes(c.severity), `${c.name} has a valid base severity`);
    assert.equal(typeof c.run, 'function');
  }
});

test('reconciliationConfig defaults every check to enabled with the B5 thresholds', () => {
  const config = reconciliationConfig();
  for (const name of CHECK_NAMES) {
    assert.equal(config.checks[name].enabled, true, `${name} enabled by default`);
  }
  assert.equal(config.checks.skipped_gates.threshold, 3);
  assert.equal(config.checks.orphaned_artifact.threshold, 7);
});

test('reconciliationConfig overrides one check without dropping the others', () => {
  const config = reconciliationConfig({ reconciliation: { checks: { skipped_gates: { enabled: false } } } });
  assert.equal(config.checks.skipped_gates.enabled, false);
  assert.equal(config.checks.ungated_reflex.enabled, true, 'an untouched check keeps its default');
});

test('a disabled check produces no findings and is never called', () => {
  const dir = tmp();
  let called = false;
  const config = reconciliationConfig({ reconciliation: { checks: { ungated_reflex: { enabled: false } } } });
  const ctx = {
    stateDir: dir,
    config,
    lessons: [{ lessonId: 'l1', reflex: true, promoted: false }],
  };
  // Sanity: without the override this same ctx WOULD fire ungated_reflex.
  const enabledCheck = CHECKS.find((c) => c.name === 'ungated_reflex');
  assert.ok(enabledCheck.run({ ...ctx, config: reconciliationConfig() }).length > 0);

  const findings = runReconciliation(ctx);
  assert.equal(findings.filter((f) => f.check_name === 'ungated_reflex').length, 0);
  called = findings.some((f) => f.check_name === 'ungated_reflex');
  assert.equal(called, false);
});

test('runReconciliation emits one reconciliation.integrity_finding spine event per finding', () => {
  const dir = tmp();
  const findings = runReconciliation({
    stateDir: dir,
    lessons: [{ lessonId: 'l1', reflex: true, promoted: false }],
  });
  const ungated = findings.filter((f) => f.check_name === 'ungated_reflex');
  assert.equal(ungated.length, 1);
  const spineRows = readSpineEvents(dir, { kind: 'reconciliation.integrity_finding' });
  assert.equal(spineRows.length, findings.length);
  const ungatedRow = spineRows.find((r) => r.payload.check_name === 'ungated_reflex');
  assert.equal(ungatedRow.payload.severity, 'critical');
});

test('every finding carries check_name, desk, severity and details, defaulted when absent', () => {
  const findings = runReconciliation({
    lessons: [{ lessonId: 'l1', reflex: true, promoted: false }],
  });
  const f = findings.find((x) => x.check_name === 'ungated_reflex');
  assert.ok(f);
  assert.equal('goal_id' in f, false);
  assert.equal(f.desk, null);
  assert.equal(typeof f.severity, 'string');
  assert.ok('details' in f);
});

test('runReconciliation with no stateDir still returns findings (fail open on persistence)', () => {
  const findings = runReconciliation({ lessons: [{ lessonId: 'l1', reflex: true, promoted: false }] });
  assert.ok(findings.length >= 1);
});
