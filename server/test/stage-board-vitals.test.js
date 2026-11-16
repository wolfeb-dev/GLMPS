// server/test/stage-board-vitals.test.js
// buildVitals() derives every state-backed Stage Board vital tile server-side
// (docs/superpowers/specs/2026-07-22-vitals-trends-design.md Step 1), ported
// verbatim from web/overview/stage-board.js's updateVitals/updateDerivedVitals/
// toolMixLabel so the client renders instead of deriving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVitals } from '../lib/observability/stage-board.js';

// Minimal board-row fixture (shape matches buildBoard()'s row output).
const row = (over = {}) => ({
  id: 'r', project: 'proj', tool: 'claude-code', stage: 1,
  committed: null, git: null, followups: 0, elapsedMs: null, ...over,
});
const session = (over = {}) => ({ id: 's', live: true, lastTs: 0, ...over });

test('empty input yields zero counts and null everywhere input is unknown, never 0', () => {
  const v = buildVitals({ rows: [], sessions: [], adapterHealth: {}, now: 1000 });
  assert.deepEqual(v.active, { count: 0, byTool: [] });
  assert.deepEqual(v.uncommitted, { count: 0, dirtyFiles: 0, worst: null });
  assert.deepEqual(v.followups, { count: 0 });
  assert.equal(v.gate.count, 0);
  assert.equal(v.gate.longestMs, null); // NOT 0
  assert.equal(v.stalled.count, 0);
  assert.equal(v.stalled.oldestMs, null); // NOT 0
  assert.equal(v.capture.degraded, 0);
  assert.equal(v.capture.worst, null);
});

test('active.count is row count; byTool sorted desc by count', () => {
  const rows = [
    row({ tool: 'claude-code' }), row({ tool: 'claude-code' }), row({ tool: 'claude-code' }),
    row({ tool: 'agy-cli' }),
  ];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.active.count, 4);
  assert.deepEqual(v.active.byTool, [{ tool: 'claude-code', count: 3 }, { tool: 'agy-cli', count: 1 }]);
});

test('active.byTool is [] when no row carries a tool at all (client falls back to "N live")', () => {
  const rows = [row({ tool: null }), row({ tool: null })];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.active.count, 2);
  assert.deepEqual(v.active.byTool, []);
});

test('active.byTool buckets tool-less rows under "unknown" once ANY row has a real tool', () => {
  const rows = [row({ tool: 'claude-code' }), row({ tool: null })];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.deepEqual(v.active.byTool, [{ tool: 'claude-code', count: 1 }, { tool: 'unknown', count: 1 }]);
});

test('uncommitted.count = rows with committed === false; git-unknown rows (committed null) are excluded', () => {
  const rows = [
    row({ committed: false, git: { dirty: 2 } }),
    row({ committed: true, git: { dirty: 0 } }),
    row({ committed: null, git: null }), // git unknown, must NOT count as uncommitted
  ];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.uncommitted.count, 1);
  assert.equal(v.uncommitted.dirtyFiles, 2);
});

test('uncommitted.dirtyFiles sums git.dirty; worst is the row with the highest dirty (first wins on tie)', () => {
  const rows = [
    row({ id: 'a', project: 'alpha', committed: false, git: { dirty: 1 } }),
    row({ id: 'b', project: 'beta', committed: false, git: { dirty: 5 } }),
    row({ id: 'c', project: 'gamma', committed: false, git: { dirty: 5 } }), // tie w/ beta, beta must win (first)
  ];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.uncommitted.count, 3);
  assert.equal(v.uncommitted.dirtyFiles, 11);
  assert.deepEqual(v.uncommitted.worst, { project: 'beta', dirty: 5 });
});

test('uncommitted.worst is null when there are no uncommitted rows', () => {
  const rows = [row({ committed: true, git: { dirty: 0 } })];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.uncommitted.worst, null);
});

test('followups.count sums row.followups across all rows', () => {
  const rows = [row({ followups: 3 }), row({ followups: 0 }), row({ followups: 2 })];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.followups.count, 5);
});

test('gate.count = rows at stage 3 or 4; longestMs = max elapsedMs among them', () => {
  const rows = [
    row({ stage: 3, elapsedMs: 1000 }),
    row({ stage: 4, elapsedMs: 5000 }),
    row({ stage: 1, elapsedMs: 99999 }), // not at gate, must not affect longestMs
  ];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.gate.count, 2);
  assert.equal(v.gate.longestMs, 5000);
});

test('gate.longestMs is null (not 0) when gate rows exist but all have unknown elapsedMs', () => {
  const rows = [row({ stage: 3, elapsedMs: null }), row({ stage: 4, elapsedMs: null })];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.gate.count, 2);
  assert.equal(v.gate.longestMs, null); // Number(null) === 0 trap: must not silently become 0
});

test('gate.longestMs skips null elapsedMs rows when computing max in a mixed set', () => {
  const rows = [row({ stage: 3, elapsedMs: null }), row({ stage: 4, elapsedMs: 2500 })];
  const v = buildVitals({ rows, sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.gate.longestMs, 2500);
});

test('stalled: from sessions (not rows), live && now - lastTs > stalledMs (default 10min)', () => {
  const now = 1_000_000;
  const sessions = [
    session({ id: 'a', live: true, lastTs: now - 20 * 60_000 }),  // stalled: 20min gap
    session({ id: 'b', live: true, lastTs: now - 1 * 60_000 }),   // fresh
    session({ id: 'c', live: false, lastTs: now - 60 * 60_000 }), // not live -> excluded regardless of gap
  ];
  const v = buildVitals({ rows: [], sessions, adapterHealth: {}, now });
  assert.equal(v.stalled.count, 1);
  assert.equal(v.stalled.oldestMs, 20 * 60_000);
});

test('stalled honors a custom stalledMs threshold', () => {
  const now = 1_000_000;
  const sessions = [session({ live: true, lastTs: now - 2 * 60_000 })];
  const v0 = buildVitals({ rows: [], sessions, adapterHealth: {}, now, stalledMs: 60_000 });
  assert.equal(v0.stalled.count, 1);
  const v1 = buildVitals({ rows: [], sessions, adapterHealth: {}, now, stalledMs: 5 * 60_000 });
  assert.equal(v1.stalled.count, 0);
});

test('stalled: missing lastTs is treated as "just now" (never counted as stalled)', () => {
  const sessions = [session({ live: true, lastTs: undefined })];
  const v = buildVitals({ rows: [], sessions, adapterHealth: {}, now: 1_000_000 });
  assert.equal(v.stalled.count, 0);
  assert.equal(v.stalled.oldestMs, null);
});

test('stalled.oldestMs picks the largest gap among stalled sessions, null when count is 0', () => {
  const now = 1_000_000;
  const sessions = [
    session({ id: 'a', live: true, lastTs: now - 15 * 60_000 }),
    session({ id: 'b', live: true, lastTs: now - 40 * 60_000 }),
  ];
  const v = buildVitals({ rows: [], sessions, adapterHealth: {}, now });
  assert.equal(v.stalled.count, 2);
  assert.equal(v.stalled.oldestMs, 40 * 60_000);
});

test('capture.degraded counts adapterHealth entries with degraded === true; worst carries lastReason', () => {
  const adapterHealth = {
    'agy-cli': { degraded: true, misses: 170, lastReason: 'steps query failed: database is locked', lastMissTs: 1 },
    'codex': { degraded: true, misses: 3, lastReason: 'no session dir', lastMissTs: 2 },
  };
  const v = buildVitals({ rows: [], sessions: [], adapterHealth, now: 0 });
  assert.equal(v.capture.degraded, 2);
  assert.deepEqual(v.capture.worst, { adapter: 'agy-cli', reason: 'steps query failed: database is locked' });
  assert.deepEqual(v.capture.adapters.map((a) => a.adapter), ['agy-cli', 'codex']);
});

test('capture.worst is null when adapterHealth is {} (no degraded adapters)', () => {
  const v = buildVitals({ rows: [], sessions: [], adapterHealth: {}, now: 0 });
  assert.equal(v.capture.degraded, 0);
  assert.equal(v.capture.worst, null);
});

test('capture ignores entries with degraded !== true', () => {
  const adapterHealth = { healthy: { degraded: false }, weird: {} };
  const v = buildVitals({ rows: [], sessions: [], adapterHealth, now: 0 });
  assert.equal(v.capture.degraded, 0);
  assert.equal(v.capture.worst, null);
});

test('capture.worst.reason is null (not a fabricated string) when lastReason is missing', () => {
  const adapterHealth = { x: { degraded: true } };
  const v = buildVitals({ rows: [], sessions: [], adapterHealth, now: 0 });
  assert.deepEqual(v.capture.worst, { adapter: 'x', reason: null });
});

test('buildVitals is pure: does not mutate its inputs', () => {
  const rows = [row({ committed: false, git: { dirty: 2 } })];
  const sessions = [session({ live: true, lastTs: 0 })];
  const adapterHealth = { a: { degraded: true, lastReason: 'x' } };
  const rowsCopy = JSON.parse(JSON.stringify(rows));
  const sessionsCopy = JSON.parse(JSON.stringify(sessions));
  const healthCopy = JSON.parse(JSON.stringify(adapterHealth));
  buildVitals({ rows, sessions, adapterHealth, now: 999 });
  assert.deepEqual(rows, rowsCopy);
  assert.deepEqual(sessions, sessionsCopy);
  assert.deepEqual(adapterHealth, healthCopy);
});

test('buildVitals tolerates missing/malformed inputs without throwing', () => {
  assert.doesNotThrow(() => buildVitals({}));
  assert.doesNotThrow(() => buildVitals({ rows: null, sessions: null, adapterHealth: null, now: null }));
  const v = buildVitals({ rows: undefined, sessions: undefined, adapterHealth: undefined, now: undefined });
  assert.equal(v.active.count, 0);
  assert.equal(v.stalled.count, 0);
});

// Phase K final review I4: kernel-health ids share the adapterHealth registry
// (reportMiss) with the capture adapters, and buildCaptureVital counted them,
// so a mem0-lookup miss read as a degraded capture tool on the vitals row.
// KERNEL_HEALTH_IDS is one exported list, filtered here and in alert-sources.
test('I4: a kernel-health miss (mem0-lookup) is not counted on the capture vital', async () => {
  const { KERNEL_HEALTH_IDS } = await import('../lib/adapters/health.js');
  assert.ok(KERNEL_HEALTH_IDS.has('mem0-lookup'));
  const v = buildVitals({ rows: [], sessions: [], now: 1000, adapterHealth: {
    'mem0-lookup': { degraded: true, lastReason: 'mem0 search failed' },
    'agy-cli': { degraded: true, lastReason: 'steps query failed' },
  } });
  assert.equal(v.capture.degraded, 1, 'only the real capture adapter counts');
  assert.deepEqual(v.capture.worst, { adapter: 'agy-cli', reason: 'steps query failed' });
  assert.deepEqual(v.capture.adapters, [{ adapter: 'agy-cli', reason: 'steps query failed' }], 'the list the Pulse row shows matches the count');
  const only = buildVitals({ rows: [], sessions: [], now: 1000, adapterHealth: { 'judge-load': { degraded: true, lastReason: 'x' } } });
  assert.equal(only.capture.degraded, 0);
  assert.equal(only.capture.worst, null);
});
