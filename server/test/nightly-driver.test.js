// server/test/nightly-driver.test.js
//
// The nightly driver's decision flow, with every side effect injected: no
// agent is spawned, no PR is filed, no git command runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNightly, nightlyExitCode, reportNightlyOutcome, fetchQueuedBacklog, appendNightlyLog } from '../../scripts/nightly-run.mjs';
import { nightlyConfig } from '../lib/orchestration/nightly-config.js';
import { readSpineEvents, SPINE_KINDS } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nightly-')); }

const NOW = Date.parse('2026-08-16T05:00:00.000Z');
const card = (id, over = {}) => ({ id, state: 'queued', project: 'glmps', order: 1, ...over });

const enabled = (over = {}) => nightlyConfig({
  nightly: { enabled: true, repoAllowlist: ['glmps'], maxItems: 1, ...over },
});

// A driver invocation with everything stubbed to the boring success path.
function deps(stateDir, over = {}) {
  return {
    stateDir,
    repoRoot: stateDir,
    config: enabled(),
    now: NOW,
    backlog: [card('a')],
    lock: { acquire: () => true, release: () => {} },
    lastRunTs: null,
    execItem: async () => ({ ok: true, branch: 'glmps-nightly/a', gateResults: [{ gateName: 'tests', status: 'pass' }], spend: { usd: 0.5, tokens: 100 } }),
    filePr: () => ({ filed: true, url: 'https://github.com/o/r/pull/1', reason: null }),
    log: () => {},
    ...over,
  };
}

// Lock and dedup

test('a run that cannot take the lock defers rather than failing', async () => {
  const dir = tmp();
  let released = false;
  const out = await runNightly(deps(dir, { lock: { acquire: () => false, release: () => { released = true; } } }));
  assert.equal(out.status, 'deferred');
  assert.equal(out.reason, 'locked');
  assert.equal(released, false, 'a run that never took the lock must not release someone else\'s');
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.RUN_STARTED }).length, 0);
});

test('the lock is released even when the run fails', async () => {
  const dir = tmp();
  let released = false;
  await runNightly(deps(dir, {
    lock: { acquire: () => true, release: () => { released = true; } },
    execItem: async () => { throw new Error('agent exploded'); },
  }));
  assert.equal(released, true);
});

test('a recent successful run is skipped unless forced', async () => {
  const dir = tmp();
  const recent = { lastRunTs: NOW - 2 * 3600000 };
  assert.equal((await runNightly(deps(dir, recent))).status, 'skipped');
  assert.equal((await runNightly(deps(dir, { ...recent, force: true }))).status, 'completed');
});

// Guardrails

test('an engaged kill switch prevents the run entirely, with no run.started', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'nightly'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nightly', 'nightly.kill'), '');
  let launched = false;
  const out = await runNightly(deps(dir, { execItem: async () => { launched = true; return { ok: true }; } }));
  assert.equal(out.status, 'stopped');
  assert.equal(out.stop, 'kill-switch');
  assert.equal(launched, false);
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.RUN_STARTED }).length, 0, 'a killed run must not even announce itself');
});

test('a disabled config is the same stop as the kill file', async () => {
  const dir = tmp();
  const out = await runNightly(deps(dir, { config: nightlyConfig({ nightly: { enabled: false, repoAllowlist: ['glmps'] } }) }));
  assert.equal(out.stop, 'kill-switch');
});

test('nothing allowlisted means nothing to do, and no agent is launched', async () => {
  const dir = tmp();
  let launched = false;
  const out = await runNightly(deps(dir, {
    config: nightlyConfig({ nightly: { enabled: true, repoAllowlist: [] } }),
    execItem: async () => { launched = true; return { ok: true }; },
  }));
  assert.equal(out.status, 'idle');
  assert.equal(launched, false);
});

test('an empty backlog completes idle without launching anything', async () => {
  const dir = tmp();
  const out = await runNightly(deps(dir, { backlog: [] }));
  assert.equal(out.status, 'idle');
});

// Budget

test('a budget overrun produces exactly one run.failed at stage budget and files no PR', async () => {
  const dir = tmp();
  let prCalls = 0;
  const out = await runNightly(deps(dir, {
    config: enabled({ budget: { maxUsd: 1 } }),
    execItem: async () => ({ ok: true, branch: 'b', gateResults: [], spend: { usd: 9, tokens: 1 } }),
    filePr: () => { prCalls++; return { filed: true, url: 'x' }; },
  }));
  assert.equal(out.status, 'failed');
  assert.equal(out.stage, 'budget');
  assert.equal(prCalls, 0, 'a hard budget stop must not ship work');
  const failed = readSpineEvents(dir, { kind: SPINE_KINDS.RUN_FAILED });
  assert.equal(failed.length, 1, 'exactly one run.failed');
  assert.equal(failed[0].payload.stage, 'budget');
  assert.equal(readSpineEvents(dir, { kind: SPINE_KINDS.RUN_COMPLETED }).length, 0);
});

test('a budget stop names the partial artifacts so the work is not lost', async () => {
  const dir = tmp();
  await runNightly(deps(dir, {
    config: enabled({ budget: { maxUsd: 1 } }),
    execItem: async () => ({ ok: true, branch: 'glmps-nightly/a', gateResults: [], spend: { usd: 9 } }),
  }));
  const failed = readSpineEvents(dir, { kind: SPINE_KINDS.RUN_FAILED })[0];
  assert.ok(failed.payload.partialArtifacts.includes('glmps-nightly/a'));
});

test('spend under the cap completes normally', async () => {
  const dir = tmp();
  const out = await runNightly(deps(dir, { config: enabled({ budget: { maxUsd: 100 } }) }));
  assert.equal(out.status, 'completed');
});

// The happy path and the no-merge guarantee

test('a completed run emits started, planned, gate results, completed and review', async () => {
  const dir = tmp();
  const out = await runNightly(deps(dir));
  assert.equal(out.status, 'completed');
  for (const k of [SPINE_KINDS.RUN_STARTED, SPINE_KINDS.RUN_PLANNED, SPINE_KINDS.RUN_GATE_RESULT, SPINE_KINDS.RUN_COMPLETED, SPINE_KINDS.REVIEW_COMPLETED]) {
    assert.equal(readSpineEvents(dir, { kind: k }).length, 1, `expected exactly one ${k}`);
  }
  const review = readSpineEvents(dir, { kind: SPINE_KINDS.REVIEW_COMPLETED })[0];
  assert.equal(review.payload.cadence, 'nightly');
});

test('every nightly event is tagged with the nightly-runner actor', async () => {
  const dir = tmp();
  await runNightly(deps(dir));
  const all = readSpineEvents(dir, {});
  assert.ok(all.length > 0);
  for (const e of all) assert.equal(e.actor, 'nightly-runner', `${e.kind} was not attributed to the runner`);
});

test('the run files a PR and never merges or pushes to the default branch', async () => {
  const dir = tmp();
  const calls = [];
  await runNightly(deps(dir, { filePr: (a) => { calls.push(a); return { filed: true, url: 'u' }; } }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].branch, 'glmps-nightly/a');
  // The driver is handed no merge or push capability at all, which is the
  // structural version of "no autonomous merge" (A3): it cannot merge even if
  // its logic were wrong, because nothing in its dependency surface can.
  const d = deps(dir);
  assert.equal('merge' in d, false);
  assert.equal('push' in d, false);
});

test('a skipped gate reaches the run.completed payload, not just the gate event', async () => {
  const dir = tmp();
  await runNightly(deps(dir, {
    execItem: async () => ({ ok: true, branch: 'b', gateResults: [{ gateName: 'cross-model-critic', status: 'skipped', details: 'no API key' }], spend: {} }),
  }));
  const done = readSpineEvents(dir, { kind: SPINE_KINDS.RUN_COMPLETED })[0];
  assert.deepEqual(done.payload.gatesSkipped, ['cross-model-critic']);
});

test('an item that throws is reported blocked, and the run still completes and reviews', async () => {
  const dir = tmp();
  const out = await runNightly(deps(dir, { execItem: async () => { throw new Error('agent exploded'); } }));
  assert.equal(out.status, 'completed');
  const done = readSpineEvents(dir, { kind: SPINE_KINDS.RUN_COMPLETED })[0];
  assert.deepEqual(done.payload.itemsBlocked, ['a']);
  assert.deepEqual(done.payload.itemsDone, []);
});

test('a failed PR filing blocks the item rather than crashing the run', async () => {
  const dir = tmp();
  const out = await runNightly(deps(dir, { filePr: () => ({ filed: false, url: null, reason: 'gh-missing' }) }));
  assert.equal(out.status, 'completed');
  const done = readSpineEvents(dir, { kind: SPINE_KINDS.RUN_COMPLETED })[0];
  assert.deepEqual(done.payload.prs, []);
  assert.deepEqual(done.payload.itemsBlocked, ['a']);
});

// Reporting to the kernel's nightly-run external loop. The loop's
// maker always throws (an external loop's outcome only ever comes from a
// report), so runNightly's own final status is the only signal main() has to
// turn into an exit code, and that exit code is the only signal the kernel
// gets back. Both halves are exercised as pure functions -- neither spawns a
// real server -- so main() itself stays a thin wrapper with nothing left to
// unit test independently.

test('nightlyExitCode: a hard-stop failure is a non-zero exit; every other status is 0', () => {
  assert.equal(nightlyExitCode({ status: 'failed', stage: 'budget' }), 1);
  for (const status of ['completed', 'idle', 'skipped', 'deferred', 'stopped']) {
    assert.equal(nightlyExitCode({ status }), 0, status);
  }
});

test('reportNightlyOutcome posts done on exit 0 and failed with the exit code as the reason otherwise', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  await reportNightlyOutcome(0, { port: '8123', fetchImpl });
  assert.equal(calls[0].url, 'http://127.0.0.1:8123/api/loops/nightly-run/report');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { outcome: 'done' });

  await reportNightlyOutcome(1, { port: '8123', fetchImpl });
  assert.deepEqual(JSON.parse(calls[1].init.body), { outcome: 'failed', reason: 'exit 1' });
});

// Fail-soft (handoff Part A / K Task 5): the kernel being unreachable is not
// itself a nightly-run failure -- runNightly already finished and returned its
// own status before this ever runs. A thrown fetch must not propagate and
// must not change the exit code the caller already decided on.
test('reportNightlyOutcome never throws when the kernel is unreachable', async () => {
  const errors = [];
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await assert.doesNotReject(() => reportNightlyOutcome(0, { port: '8123', fetchImpl }));
  } finally { console.error = realError; }
  assert.ok(errors.some((m) => m.includes('ECONNREFUSED')), 'the failure is still logged, just not thrown');
});

// Coordinator fix round 1: the kernel's report route is on the same host, but
// a wedged process, a stuck accept queue, or a firewall black hole can still
// leave a real fetch() connecting-but-never-answering. Without its own abort
// bound, reportNightlyOutcome would hang forever on such a fetchImpl -- it
// must resolve on its own, not depend on some caller wrapping it in a
// watchdog. timeoutMs is injectable so this test proves the bound is real
// without waiting out the production 5s default.
test('reportNightlyOutcome aborts a never-answering fetch within its own timeout bound', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    // Mirrors real fetch(): a passed AbortSignal rejects the call when it
    // fires. If no signal reaches here at all, this promise never settles on
    // its own -- exactly the hang this test exists to catch.
    if (init?.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  });
  const realError = console.error;
  console.error = () => {};
  try {
    const raced = await Promise.race([
      reportNightlyOutcome(0, { port: '8123', fetchImpl, timeoutMs: 30 }).then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 500)),
    ]);
    assert.equal(raced, 'resolved', 'reportNightlyOutcome must resolve on its own within its timeout bound, not rely on an external watchdog');
  } finally { console.error = realError; }
});

test('reportNightlyOutcome carries an explicit failure reason when given one', async () => {
  const calls = [];
  await reportNightlyOutcome(1, { port: '8123', reason: 'dashboard unreachable: timeout (3 attempts)', fetchImpl: async (url, init) => { calls.push(init); return { ok: true }; } });
  assert.deepEqual(JSON.parse(calls[0].body), { outcome: 'failed', reason: 'dashboard unreachable: timeout (3 attempts)' });
});

// glmps-2-0-112: one slow answer from a busy kernel used to skip the night
// silently. The fetch now retries, and a total miss comes back as a reason.
test('fetchQueuedBacklog retries a miss and returns the items once the dashboard answers', async () => {
  let n = 0; const sleeps = [];
  const fetchImpl = async (url) => {
    n += 1;
    assert.equal(url, 'http://127.0.0.1:8123/api/backlog?status=queued');
    if (n === 1) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    if (n === 2) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ items: [card('a')] }) };
  };
  const out = await fetchQueuedBacklog({ port: '8123', fetchImpl, delayMs: 7, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.items.map((i) => i.id), ['a']);
  assert.deepEqual(sleeps, [7, 7]);
});

test('fetchQueuedBacklog gives up after its attempts with the last reason', async () => {
  let n = 0;
  const out = await fetchQueuedBacklog({ port: '8123', attempts: 3, sleep: async () => {}, fetchImpl: async () => { n += 1; throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  assert.equal(n, 3);
  assert.deepEqual(out, { ok: false, reason: 'dashboard unreachable: timeout (3 attempts)' });
});

test('appendNightlyLog appends one JSON line per run under the nightly folder', () => {
  const dir = tmp();
  appendNightlyLog(dir, { status: 'idle', exitCode: 0 }, { now: NOW });
  appendNightlyLog(dir, { status: 'failed', reason: 'r', exitCode: 1 }, { now: NOW + 1000 });
  const lines = fs.readFileSync(path.join(dir, 'nightly', 'runs.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { ts: '2026-08-16T05:00:00.000Z', status: 'idle', exitCode: 0 },
    { ts: '2026-08-16T05:00:01.000Z', status: 'failed', reason: 'r', exitCode: 1 },
  ]);
});
