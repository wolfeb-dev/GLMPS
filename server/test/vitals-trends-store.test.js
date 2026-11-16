// server/test/vitals-trends-store.test.js
//
// Unit tests for vitals-trends-store.js (docs/superpowers/specs/
// 2026-07-22-vitals-trends-design.md, Step 2): the pure sampler (sampleVitals),
// the plain NDJSON store (append/read/prune), the window parser (parseWindowMs),
// and the GET /api/vitals-trends route against a seeded store. Mirrors
// qa-trends-store.test.js's structure and mkTmp() helper.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  vitalsTrendsFile, readVitalsTrends, appendVitalsPoint, sampleVitals,
  parseWindowMs, RETENTION_MS, DEFAULT_WINDOW_MS,
  decideAlertsSource, ALERTS_MAX_STALE_MS,
} from '../lib/observability/vitals-trends-store.js';
import { startServer } from '../server.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-vt-')); tmpDirs.push(d); return d; }

function mkServerEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-vt-srv-')); tmpDirs.push(tmp);
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
  };
}

function fullPoint(overrides = {}) {
  return {
    ts: Date.parse('2026-07-22T12:00:00Z'),
    active: 3, uncommitted: 2, dirtyFiles: 7, followups: 1, atGate: 1,
    stalled: 0, degradedAdapters: 0, budgetPct: 42, alerts: 2, queued: 5,
    ...overrides,
  };
}


test('vitalsTrendsFile: path shape is <stateDir>/vitals-trends/history.ndjson', () => {
  const stateDir = mkTmp();
  assert.equal(vitalsTrendsFile(stateDir), path.join(stateDir, 'vitals-trends', 'history.ndjson'));
});


test('readVitalsTrends: missing file -> []', () => {
  const stateDir = mkTmp();
  assert.deepEqual(readVitalsTrends(stateDir), []);
});

test('readVitalsTrends: empty file -> []', () => {
  const stateDir = mkTmp();
  fs.mkdirSync(path.join(stateDir, 'vitals-trends'), { recursive: true });
  fs.writeFileSync(vitalsTrendsFile(stateDir), '');
  assert.deepEqual(readVitalsTrends(stateDir), []);
});

test('readVitalsTrends: tolerates blank lines and malformed/incomplete records', () => {
  const stateDir = mkTmp();
  fs.mkdirSync(path.join(stateDir, 'vitals-trends'), { recursive: true });
  const good = JSON.stringify(fullPoint());
  fs.writeFileSync(vitalsTrendsFile(stateDir),
    '\n' + good + '\n' + 'not json\n' + JSON.stringify({ active: 1 }) /* no ts */ + '\n   \n');
  const rows = readVitalsTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, fullPoint().ts);
});

test('appendVitalsPoint + readVitalsTrends: round-trips a point', () => {
  const stateDir = mkTmp();
  const ok = appendVitalsPoint(stateDir, fullPoint());
  assert.equal(ok, true);
  const rows = readVitalsTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], fullPoint());
  assert.ok(fs.existsSync(vitalsTrendsFile(stateDir)));
});

test('readVitalsTrends: sorted ascending by ts regardless of append order', () => {
  const stateDir = mkTmp();
  appendVitalsPoint(stateDir, fullPoint({ ts: Date.parse('2026-07-22T12:02:00Z') }));
  appendVitalsPoint(stateDir, fullPoint({ ts: Date.parse('2026-07-22T12:00:00Z') }));
  appendVitalsPoint(stateDir, fullPoint({ ts: Date.parse('2026-07-22T12:01:00Z') }));
  const rows = readVitalsTrends(stateDir);
  assert.deepEqual(rows.map(r => r.ts), [
    Date.parse('2026-07-22T12:00:00Z'),
    Date.parse('2026-07-22T12:01:00Z'),
    Date.parse('2026-07-22T12:02:00Z'),
  ]);
});

test('appendVitalsPoint: rejects a non-object point / missing or invalid ts, never throws', () => {
  const stateDir = mkTmp();
  assert.equal(appendVitalsPoint(stateDir, null), false);
  assert.equal(appendVitalsPoint(stateDir, undefined), false);
  assert.equal(appendVitalsPoint(stateDir, 'nope'), false);
  assert.equal(appendVitalsPoint(stateDir, { active: 1 }), false); // no ts
  assert.equal(appendVitalsPoint(stateDir, { ts: 'not-a-number', active: 1 }), false);
  assert.deepEqual(readVitalsTrends(stateDir), []);
});


test('appendVitalsPoint: prunes to the trailing 24h, a point just inside is kept, just outside is dropped', () => {
  const stateDir = mkTmp();
  const now = Date.parse('2026-07-22T12:00:00Z');
  const justInside = now - RETENTION_MS + 60_000;  // 23h59m inside
  const justOutside = now - RETENTION_MS - 60_000; // 24h01m ago
  appendVitalsPoint(stateDir, fullPoint({ ts: justOutside, active: 111 }));
  appendVitalsPoint(stateDir, fullPoint({ ts: justInside, active: 222 }));
  // The append that carries `now` as its own ts is what triggers pruning
  // relative to `now` -- mirrors the sampler always appending its own current tick.
  appendVitalsPoint(stateDir, fullPoint({ ts: now, active: 333 }));
  const rows = readVitalsTrends(stateDir);
  const actives = rows.map(r => r.active).sort((a, b) => a - b);
  assert.deepEqual(actives, [222, 333]); // 111 (outside 24h) pruned; 222 and 333 kept
});

test('appendVitalsPoint: pruning tolerates malformed lines already on disk, never throws', () => {
  const stateDir = mkTmp();
  const now = Date.parse('2026-07-22T12:00:00Z');
  fs.mkdirSync(path.join(stateDir, 'vitals-trends'), { recursive: true });
  fs.writeFileSync(vitalsTrendsFile(stateDir),
    JSON.stringify(fullPoint({ ts: now - 1000, active: 1 })) + '\n' +
    'not json at all\n' +
    JSON.stringify({ active: 2 }) /* no ts */ + '\n');
  assert.doesNotThrow(() => appendVitalsPoint(stateDir, fullPoint({ ts: now, active: 3 })));
  const rows = readVitalsTrends(stateDir);
  assert.deepEqual(rows.map(r => r.active), [1, 3]); // malformed lines silently dropped
});


test('sampleVitals: passes through finite numeric inputs unchanged', () => {
  const p = sampleVitals(fullPoint());
  assert.deepEqual(p, fullPoint());
});

test('sampleVitals: missing/null/undefined inputs become null, never 0', () => {
  const p = sampleVitals({ ts: 1000 });
  assert.deepEqual(p, {
    ts: 1000, active: null, uncommitted: null, dirtyFiles: null, followups: null,
    atGate: null, stalled: null, degradedAdapters: null, budgetPct: null,
    alerts: null, queued: null,
  });
  // Explicit non-zero assertions: Number(null) is 0, not NaN, so this is the
  // exact bug class the null-discipline rule guards against.
  for (const k of ['active', 'uncommitted', 'dirtyFiles', 'followups', 'atGate', 'stalled', 'degradedAdapters', 'budgetPct', 'alerts', 'queued']) {
    assert.notEqual(p[k], 0);
    assert.equal(p[k], null);
  }
});

test('sampleVitals: explicit null inputs stay null (not coerced to 0 by Number())', () => {
  const p = sampleVitals({ ts: 1000, active: null, budgetPct: null });
  assert.equal(p.active, null);
  assert.equal(p.budgetPct, null);
});

test('sampleVitals: non-numeric garbage inputs become null rather than NaN or passing through', () => {
  const p = sampleVitals({ ts: 1000, active: 'three', uncommitted: NaN, dirtyFiles: {}, followups: [] });
  assert.equal(p.active, null);
  assert.equal(p.uncommitted, null);
  assert.equal(p.dirtyFiles, null);
  assert.equal(p.followups, null);
});

test('sampleVitals: a real zero is preserved as 0, not upgraded to null', () => {
  const p = sampleVitals(fullPoint({ stalled: 0, degradedAdapters: 0 }));
  assert.equal(p.stalled, 0);
  assert.equal(p.degradedAdapters, 0);
});

test('sampleVitals: invalid ts becomes null (pure, never reaches for Date.now())', () => {
  const p = sampleVitals({ active: 1 });
  assert.equal(p.ts, null);
});

test('readVitalsTrends: round-trips null fields exactly, never coerces to 0', () => {
  const stateDir = mkTmp();
  const point = sampleVitals({ ts: 5000, active: 4, budgetPct: null, queued: undefined });
  appendVitalsPoint(stateDir, point);
  const rows = readVitalsTrends(stateDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].budgetPct, null);
  assert.equal(rows[0].queued, null);
  assert.notEqual(rows[0].budgetPct, 0);
  assert.notEqual(rows[0].queued, 0);
});


test('readVitalsTrends: sinceMs filters out points older than the cutoff', () => {
  const stateDir = mkTmp();
  const now = Date.parse('2026-07-22T12:00:00Z');
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 3 * 60 * 60 * 1000, active: 1 })); // 3h ago
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 1 * 60 * 60 * 1000, active: 2 })); // 1h ago
  appendVitalsPoint(stateDir, fullPoint({ ts: now, active: 3 }));
  const rows = readVitalsTrends(stateDir, { sinceMs: now - 2 * 60 * 60 * 1000 }); // trailing 2h
  assert.deepEqual(rows.map(r => r.active), [2, 3]);
});

test('readVitalsTrends: no sinceMs -> returns everything in the store', () => {
  const stateDir = mkTmp();
  const now = Date.parse('2026-07-22T12:00:00Z');
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 20 * 60 * 60 * 1000, active: 1 }));
  appendVitalsPoint(stateDir, fullPoint({ ts: now, active: 2 }));
  const rows = readVitalsTrends(stateDir);
  assert.equal(rows.length, 2);
});


test('parseWindowMs: parses "2h" and "30m" forms', () => {
  assert.equal(parseWindowMs('2h'), 2 * 60 * 60 * 1000);
  assert.equal(parseWindowMs('30m'), 30 * 60 * 1000);
  assert.equal(parseWindowMs('1.5h'), 1.5 * 60 * 60 * 1000);
});

test('parseWindowMs: missing/unparseable falls back to the 2h default, never throws', () => {
  assert.equal(parseWindowMs(undefined), DEFAULT_WINDOW_MS);
  assert.equal(parseWindowMs(null), DEFAULT_WINDOW_MS);
  assert.equal(parseWindowMs(''), DEFAULT_WINDOW_MS);
  assert.equal(parseWindowMs('bogus'), DEFAULT_WINDOW_MS);
  assert.equal(parseWindowMs('2d'), DEFAULT_WINDOW_MS); // unsupported unit
  assert.equal(parseWindowMs('-5h'), DEFAULT_WINDOW_MS);
  assert.equal(parseWindowMs('0h'), DEFAULT_WINDOW_MS);
  assert.equal(DEFAULT_WINDOW_MS, 2 * 60 * 60 * 1000);
});

test('parseWindowMs: clamps to the 24h retention window', () => {
  assert.equal(parseWindowMs('48h'), RETENTION_MS);
  assert.equal(parseWindowMs('25h'), RETENTION_MS);
  assert.equal(parseWindowMs('24h'), RETENTION_MS);
});


let sharedEnv;
let sharedSrv;

before(async () => {
  sharedEnv = mkServerEnv();
  sharedSrv = await startServer({ port: 0, pollMs: 1000, env: sharedEnv });
});

beforeEach(() => {
  if (sharedEnv) fs.rmSync(vitalsTrendsFile(sharedEnv.GLMPS_STATE_DIR), { force: true });
});

after(async () => {
  await sharedSrv?.close();
});

test('GET /api/vitals-trends: returns seeded points, oldest first, default 2h window', async () => {
  const stateDir = sharedEnv.GLMPS_STATE_DIR;
  const now = Date.now();
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 90 * 60 * 1000, active: 1 })); // 1.5h ago, inside default 2h
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 30 * 60 * 1000, active: 2 })); // 30m ago
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 5 * 60 * 60 * 1000, active: 999 })); // 5h ago, outside default 2h
  const res = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/vitals-trends`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.points));
  assert.deepEqual(body.points.map(p => p.active), [1, 2]);
});

test('GET /api/vitals-trends?window=30m: honors an explicit window', async () => {
  const stateDir = sharedEnv.GLMPS_STATE_DIR;
  const now = Date.now();
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 45 * 60 * 1000, active: 1 })); // outside 30m
  appendVitalsPoint(stateDir, fullPoint({ ts: now - 10 * 60 * 1000, active: 2 })); // inside 30m
  const res = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/vitals-trends?window=30m`);
  const body = await res.json();
  assert.deepEqual(body.points.map(p => p.active), [2]);
});

test('GET /api/vitals-trends?window=bogus: unparseable window falls back to default, does not error', async () => {
  const stateDir = sharedEnv.GLMPS_STATE_DIR;
  appendVitalsPoint(stateDir, fullPoint({ ts: Date.now() - 60_000, active: 7 }));
  const res = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/vitals-trends?window=bogus`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.points.map(p => p.active), [7]);
});

test('GET /api/vitals-trends: empty store -> { points: [] }', async () => {
  const res = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/vitals-trends`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.points, []);
});

// -- decideAlertsSource (pure): the tick must never call the ~1.3-1.8s
// collectCurrentAlerts() scan on its own 30s cadence. This is the decision
// logic that keeps that true (server.js's tick only invokes
// collectCurrentAlerts() itself on the 'recompute' verdict). ------------------

test('ALERTS_MAX_STALE_MS is the documented 5 minute floor', () => {
  assert.equal(ALERTS_MAX_STALE_MS, 5 * 60 * 1000);
});

test('decideAlertsSource: fresh cache -> reuse without recomputing', () => {
  const now = 1_000_000;
  const cache = { value: 4, ts: now - 60_000 }; // 1 min old, well inside the 5 min floor
  const gate = { ts: 0 };
  const d = decideAlertsSource(cache, gate, now, ALERTS_MAX_STALE_MS);
  assert.deepEqual(d, { action: 'reuse', value: 4 });
});

test('decideAlertsSource: a real zero cached count is reused, not treated as missing', () => {
  const now = 1_000_000;
  const cache = { value: 0, ts: now - 1000 };
  const d = decideAlertsSource(cache, { ts: 0 }, now, ALERTS_MAX_STALE_MS);
  assert.deepEqual(d, { action: 'reuse', value: 0 });
});

test('decideAlertsSource: cache exactly at the floor boundary is stale (not fresh)', () => {
  const now = 1_000_000;
  const floor = 5000;
  const cache = { value: 9, ts: now - floor }; // age === floor, not < floor
  const gate = { ts: now - floor }; // gate also exactly at the boundary -> elapsed (>=)
  const d = decideAlertsSource(cache, gate, now, floor);
  assert.equal(d.action, 'recompute');
});

test('decideAlertsSource: never-set cache (fresh server, first tick) -> recompute', () => {
  const now = Date.now();
  const d = decideAlertsSource({ value: null, ts: 0 }, { ts: 0 }, now, ALERTS_MAX_STALE_MS);
  assert.deepEqual(d, { action: 'recompute', value: null });
});

test('decideAlertsSource: stale cache + the recompute gate not yet elapsed -> null, no recompute, no stale carry-forward', () => {
  const now = 1_000_000;
  const floor = 5000;
  const cache = { value: 7, ts: now - floor - 1000 }; // stale: older than the floor
  const gate = { ts: now - 1000 }; // the tick itself attempted very recently (< floor ago)
  const d = decideAlertsSource(cache, gate, now, floor);
  assert.deepEqual(d, { action: 'null', value: null });
  // Explicit non-zero, non-stale-value assertions -- this is exactly the
  // "do not carry a stale count forward, do not substitute 0" rule.
  assert.notEqual(d.value, 0);
  assert.notEqual(d.value, 7);
});

test('decideAlertsSource: gate exactly at the floor boundary counts as elapsed (>=), not null', () => {
  const now = 1_000_000;
  const floor = 5000;
  const cache = { value: 7, ts: now - floor - 1000 }; // stale
  const gate = { ts: now - floor }; // gate age === floor -> elapsed
  const d = decideAlertsSource(cache, gate, now, floor);
  assert.equal(d.action, 'recompute');
});

test('decideAlertsSource: malformed cache/gate objects fall back to the empty shape rather than throwing', () => {
  const now = Date.now();
  assert.doesNotThrow(() => decideAlertsSource(null, null, now));
  assert.doesNotThrow(() => decideAlertsSource(undefined, undefined, now));
  assert.doesNotThrow(() => decideAlertsSource({}, {}, now));
  const d = decideAlertsSource(null, undefined, now, ALERTS_MAX_STALE_MS);
  assert.equal(d.action, 'recompute'); // both fall back to ts:0 -> infinitely stale -> recompute
});

test('decideAlertsSource: default floor matches ALERTS_MAX_STALE_MS when omitted', () => {
  const now = 1_000_000;
  const cache = { value: 3, ts: now - (ALERTS_MAX_STALE_MS - 1) }; // just inside the default floor
  const d = decideAlertsSource(cache, { ts: 0 }, now); // floorMs omitted
  assert.deepEqual(d, { action: 'reuse', value: 3 });
});

// (server.js: vitalsTrendsTick exposed on the return value for deterministic
// tests, per the runnerTick/measurablesTick precedent.)

test('vitalsTrendsTick: a fresh server with no prior GET /api/alerts recomputes once (first tick ever)', async () => {
  const now = Date.now();
  await sharedSrv.vitalsTrendsTick(now);
  const res = await fetch(`http://127.0.0.1:${sharedSrv.port}/api/vitals-trends?window=24h`);
  const body = await res.json();
  assert.equal(body.points.length, 1);
  // A bare test env still surfaces a few deterministic coverage-gap alerts
  // (TOOL_REGISTRY entries with no adapter) -- not null. What matters here
  // is that the recompute path ran and produced a real integer, proving it
  // is reachable end-to-end rather than getting stuck recording null forever.
  assert.equal(typeof body.points[0].alerts, 'number');
  assert.ok(Number.isInteger(body.points[0].alerts) && body.points[0].alerts >= 0);
});

test('vitalsTrendsTick: reuses the value GET /api/alerts already computed, "fresh for free" with a viewer present', async () => {
  const env = mkServerEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    // Simulates a browser polling GET /api/alerts (which feeds the shared
    // cache) shortly before the sampler tick fires.
    const alertsRes = await fetch(`http://127.0.0.1:${srv.port}/api/alerts`);
    const alertsBody = await alertsRes.json();
    const expectedCount = alertsBody.alerts.length; // empty test env -> 0, non-acked already filtered by the route
    const now = Date.now(); // well within ALERTS_MAX_STALE_MS of the GET above
    await srv.vitalsTrendsTick(now);
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/vitals-trends?window=24h`);
    const body = await res.json();
    assert.equal(body.points.length, 1);
    assert.equal(body.points[0].alerts, expectedCount);
  } finally {
    await srv.close();
  }
});

test('vitalsTrendsTick: a second tick well within the floor reuses the first recompute rather than recomputing again', async () => {
  const env = mkServerEnv();
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const now = Date.now();
    await srv.vitalsTrendsTick(now);
    await srv.vitalsTrendsTick(now + 1000); // 1s later, well inside the 5 min floor
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/vitals-trends?window=24h`);
    const body = await res.json();
    assert.equal(body.points.length, 2);
    // Both points share the same alerts value -- the second call reused the
    // first's cached count rather than drifting or nulling it out.
    assert.equal(body.points[0].alerts, body.points[1].alerts);
    assert.notEqual(body.points[1].alerts, null);
  } finally {
    await srv.close();
  }
});
