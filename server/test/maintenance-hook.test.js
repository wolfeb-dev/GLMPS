// The session-control hook holds tool calls while a Restart run is in its
// restarting phase (card glmps-2-0-170). Reads the record from disk, fails open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { awaitMaintenance, MAINTENANCE_HOLD_MAX_MS } from '../../hooks/workspace-steer.js';
import { beginMaintenance, setMaintenancePhase, clearMaintenance } from '../lib/kernel/maintenance.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-maint-hook-'));
const clock = (t0 = 1_000_000) => { const c = { t: t0 }; c.now = () => c.t; c.sleep = async (ms) => { c.t += ms; c.slept = (c.slept ?? 0) + ms; }; return c; };

test('no record, or the quiescing phase, does not hold the call', async () => {
  const d = tmp();
  const c = clock();
  assert.deepEqual(await awaitMaintenance(d, { now: c.now, sleep: c.sleep }), { held: false });
  beginMaintenance(d, { runId: 'r1', now: c.t });
  assert.deepEqual(await awaitMaintenance(d, { now: c.now, sleep: c.sleep }), { held: false });
  assert.equal(c.slept, undefined);
});

test('the restarting phase holds until the record is cleared, then lets the call proceed', async () => {
  const d = tmp();
  const c = clock();
  beginMaintenance(d, { runId: 'r1', now: c.t });
  setMaintenancePhase(d, 'r1', 'restarting', { now: c.t });
  let polls = 0;
  const sleep = async (ms) => { await c.sleep(ms); if (++polls === 3) clearMaintenance(d, 'r1'); };
  const r = await awaitMaintenance(d, { now: c.now, sleep });
  assert.equal(r.held, true);
  assert.equal(r.reason, 'cleared');
  assert.equal(polls, 3);
});

test('the phase moving back to quiescing releases the hold', async () => {
  const d = tmp();
  const c = clock();
  beginMaintenance(d, { runId: 'r1', phase: 'restarting', now: c.t });
  const sleep = async (ms) => { await c.sleep(ms); setMaintenancePhase(d, 'r1', 'quiescing', { now: c.t }); };
  assert.equal((await awaitMaintenance(d, { now: c.now, sleep })).reason, 'cleared');
});

test('a record that expires mid-wait ends the hold', async () => {
  const d = tmp();
  const c = clock();
  beginMaintenance(d, { runId: 'r1', phase: 'restarting', now: c.t, ttlMs: 20_000 });
  const r = await awaitMaintenance(d, { now: c.now, sleep: c.sleep, pollMs: 5000 });
  assert.equal(r.held, true);
  assert.equal(r.reason, 'cleared');
  assert.ok(c.slept <= 25_000);
});

test('the wait never exceeds its ceiling, which stays far below the hook timeout', async () => {
  const d = tmp();
  const c = clock();
  beginMaintenance(d, { runId: 'r1', phase: 'restarting', now: c.t });
  const r = await awaitMaintenance(d, { now: c.now, sleep: c.sleep });
  assert.equal(r.reason, 'timeout');
  assert.ok(c.slept <= MAINTENANCE_HOLD_MAX_MS + 5000);
  assert.ok(MAINTENANCE_HOLD_MAX_MS <= 10 * 60_000, 'registered hook timeout is 50000 s; stay far below it');
});

test('a corrupt record fails open without waiting', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'maintenance.json'), '{nope');
  const c = clock();
  assert.deepEqual(await awaitMaintenance(d, { now: c.now, sleep: c.sleep }), { held: false });
});

test('a throwing sleep fails open', async () => {
  const d = tmp();
  beginMaintenance(d, { runId: 'r1', phase: 'restarting' });
  const r = await awaitMaintenance(d, { sleep: async () => { throw new Error('boom'); } });
  assert.equal(r.reason, 'error');
});
