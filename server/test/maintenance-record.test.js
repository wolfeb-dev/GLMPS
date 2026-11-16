// Maintenance record (card glmps-2-0-170): a durable, self-expiring hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginMaintenance, setMaintenancePhase, clearMaintenance, readMaintenance, MAINTENANCE_TTL_MS } from '../lib/kernel/maintenance.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'maint-'));

test('absent means no hold', () => {
  assert.equal(readMaintenance(tmp(), 1000), null);
});

test('begin writes a record that reads back until it expires', () => {
  const d = tmp();
  beginMaintenance(d, { runId: 'apr-1', now: 1000 });
  assert.deepEqual(readMaintenance(d, 2000), { runId: 'apr-1', phase: 'quiescing', startedTs: 1000, expiresAt: 1000 + MAINTENANCE_TTL_MS });
  assert.equal(MAINTENANCE_TTL_MS, 45 * 60_000);
  assert.equal(readMaintenance(d, 1000 + MAINTENANCE_TTL_MS), null, 'an expired record counts as absent');
});

test('the phase changes without extending the expiry', () => {
  const d = tmp();
  beginMaintenance(d, { runId: 'apr-1', now: 1000 });
  setMaintenancePhase(d, 'apr-1', 'restarting', { now: 5000 });
  const r = readMaintenance(d, 6000);
  assert.equal(r.phase, 'restarting');
  assert.equal(r.expiresAt, 1000 + MAINTENANCE_TTL_MS);
});

test('only the owning run can change or clear the record', () => {
  const d = tmp();
  beginMaintenance(d, { runId: 'apr-1', now: 1000 });
  setMaintenancePhase(d, 'apr-2', 'restarting', { now: 2000 });
  clearMaintenance(d, 'apr-2');
  assert.equal(readMaintenance(d, 3000).phase, 'quiescing');
  clearMaintenance(d, 'apr-1');
  assert.equal(readMaintenance(d, 3000), null);
});

test('a corrupt file counts as absent and clearing a missing one is fine', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'maintenance.json'), '{nope');
  assert.equal(readMaintenance(d, 1000), null);
  clearMaintenance(tmp(), 'x');
});
