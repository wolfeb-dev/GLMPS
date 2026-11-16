// server/test/adapter-health.test.js
// Shared per-adapter capture-health registry (glmps-45): adapters report
// validation misses when a record that should be parseable no longer matches
// the expected shape (upstream log drift). Misses degrade the adapter instead
// of throwing or emitting bogus events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportMiss, adapterHealth, resetAdapterHealth, persistAdapterHealth, loadAdapterHealth, clearMiss } from '../lib/adapters/health.js';

test('health: starts empty', () => {
  resetAdapterHealth();
  assert.deepEqual(adapterHealth(), {});
});

test('health: reportMiss marks the adapter degraded with count + reason', () => {
  resetAdapterHealth();
  reportMiss('gemini-cli', 'message missing id/type');
  const h = adapterHealth();
  assert.equal(h['gemini-cli'].degraded, true);
  assert.equal(h['gemini-cli'].misses, 1);
  assert.equal(h['gemini-cli'].lastReason, 'message missing id/type');
  assert.ok(typeof h['gemini-cli'].lastMissTs === 'number' && h['gemini-cli'].lastMissTs > 0);
});

test('health: repeated misses accumulate; other adapters unaffected', () => {
  resetAdapterHealth();
  reportMiss('codex-cli', 'a');
  reportMiss('codex-cli', 'b');
  const h = adapterHealth();
  assert.equal(h['codex-cli'].misses, 2);
  assert.equal(h['codex-cli'].lastReason, 'b');
  assert.equal(h['opencode'], undefined);
});

test('health: snapshot is a plain serializable object (not the live registry)', () => {
  resetAdapterHealth();
  reportMiss('cline', 'x');
  const h = adapterHealth();
  h['cline'].misses = 999;
  assert.equal(adapterHealth()['cline'].misses, 1);
  assert.doesNotThrow(() => JSON.stringify(adapterHealth()));
});

test('health: resetAdapterHealth clears everything', () => {
  resetAdapterHealth();
  reportMiss('hermes', 'x');
  resetAdapterHealth();
  assert.deepEqual(adapterHealth(), {});
});

// The registry was a module-level Map with no rate and no persistence. Three
// consequences, all true before this: every miss was lost on restart so there
// was NO history of capture drift; `degraded` reached the UI only as a vitals
// field on /api/state, so it sat there indefinitely without alerting anyone;
// and a bare counter cannot tell one drift event from 208 per second, which is
// why the agy-cli re-drain defect ran unnoticed.

test('adapterHealth reports a rate and a first-seen time, not just a total', () => {
  resetAdapterHealth();
  const t0 = Date.parse('2026-08-21T12:00:00.000Z');
  for (let i = 0; i < 5; i++) reportMiss('agy-cli', 'drift', { now: t0 + i * 1000 });
  const h = adapterHealth({ now: t0 + 5000 })['agy-cli'];
  assert.equal(h.misses, 5);
  assert.equal(h.firstMissTs, t0);
  assert.equal(h.lastMissTs, t0 + 4000);
  assert.equal(h.missesPerMin, 5, 'all 5 fall inside the trailing minute');
});

test('the rate window decays: old misses stop counting toward the rate but the total stands', () => {
  resetAdapterHealth();
  const t0 = Date.parse('2026-08-21T12:00:00.000Z');
  reportMiss('agy-cli', 'old', { now: t0 });
  reportMiss('agy-cli', 'new', { now: t0 + 120000 });
  const h = adapterHealth({ now: t0 + 120000 })['agy-cli'];
  assert.equal(h.misses, 2, 'the lifetime total is not a window');
  assert.equal(h.missesPerMin, 1, 'the two-minute-old miss has aged out of the rate');
});

test('the recent-timestamp ring is bounded, so a 208-per-second storm cannot grow without limit', () => {
  resetAdapterHealth();
  const t0 = Date.parse('2026-08-21T12:00:00.000Z');
  for (let i = 0; i < 5000; i++) reportMiss('agy-cli', 'storm', { now: t0 + i });
  const h = adapterHealth({ now: t0 + 5000 })['agy-cli'];
  assert.equal(h.misses, 5000, 'the total is still honest');
  assert.ok(h.missesPerMin <= 5000 && h.missesPerMin > 0);
  assert.ok(h.recentCapped === true, 'and it says out loud that the rate is a floor, not exact');
});

test('health survives a restart: snapshot round-trips through a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-health-'));
  const file = path.join(dir, 'adapter-health.json');
  resetAdapterHealth();
  const t0 = Date.parse('2026-08-21T12:00:00.000Z');
  reportMiss('gemini-cli', 'schema drift', { now: t0 });
  persistAdapterHealth(file);

  resetAdapterHealth();
  assert.deepEqual(adapterHealth(), {}, 'precondition: the registry is empty after a reset');

  loadAdapterHealth(file);
  const h = adapterHealth({ now: t0 })['gemini-cli'];
  assert.equal(h.misses, 1);
  assert.equal(h.lastReason, 'schema drift');
  assert.equal(h.firstMissTs, t0, 'so "since when has capture been drifting" is answerable');
});

test('loading a missing or malformed file is a no-op, never a crash', () => {
  resetAdapterHealth();
  assert.doesNotThrow(() => loadAdapterHealth(path.join(os.tmpdir(), 'nope-does-not-exist.json')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-health-bad-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.doesNotThrow(() => loadAdapterHealth(bad));
  assert.deepEqual(adapterHealth(), {});
});

// reportMiss alone never had a way back to healthy - once degraded, an
// adapter stayed degraded (and alerting) forever, even after it recovered.

test('clearMiss: a cleared adapter is no longer degraded', () => {
  resetAdapterHealth();
  reportMiss('mem0-lookup', 'search failed');
  assert.ok(adapterHealth()['mem0-lookup']);
  clearMiss('mem0-lookup');
  assert.equal(adapterHealth()['mem0-lookup'], undefined);
});

test('clearMiss: a later recurrence starts a brand new episode (fresh firstMissTs)', () => {
  resetAdapterHealth();
  const t0 = Date.parse('2026-08-21T12:00:00.000Z');
  reportMiss('mem0-lookup', 'first outage', { now: t0 });
  clearMiss('mem0-lookup');
  reportMiss('mem0-lookup', 'second outage', { now: t0 + 60_000 });
  const h = adapterHealth({ now: t0 + 60_000 })['mem0-lookup'];
  assert.equal(h.misses, 1, 'the old episode is gone, not accumulated onto');
  assert.equal(h.firstMissTs, t0 + 60_000, 'a fresh episode, not the old firstMissTs');
});

test('clearMiss on an adapter with no recorded miss is a no-op, never a crash', () => {
  resetAdapterHealth();
  assert.doesNotThrow(() => clearMiss('never-missed'));
});

test('reportMiss keeps its original 2-arg signature: existing adapter call sites are unchanged', () => {
  resetAdapterHealth();
  assert.doesNotThrow(() => reportMiss('cline', 'no type'));
  const h = adapterHealth()['cline'];
  assert.equal(h.degraded, true);
  assert.equal(h.misses, 1);
  assert.equal(typeof h.lastMissTs, 'number');
});
