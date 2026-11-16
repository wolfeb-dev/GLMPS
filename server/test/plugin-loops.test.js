// server/test/plugin-loops.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { registerPluginLoops } from '../lib/loops/plugin-loops.js';
import { createMemoryAdapter } from '../lib/loops/plugin-adapters.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-plugin-loops-'));
function fakeQueue() { const jobs = []; let id = 0; return { jobs,
  push: (j) => jobs.push({ id: ++id, attempts: 0, ...j }), take: (n) => jobs.slice(0, n), size: () => jobs.length,
  ack: (i) => { const k = jobs.findIndex((j) => j.id === i); if (k >= 0) jobs.splice(k, 1); },
  bump: (i) => { const j = jobs.find((x) => x.id === i); if (j) j.attempts += 1; } }; }

function setup(over = {}) {
  const stateDir = tmp(); const retryQueue = fakeQueue();
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  const deps = {
    memory: { admit: async () => ({ written: ['f1'] }), verifyAdmitted: async () => ({ ok: true }) },
    judge: { judge: async () => ({ pass: true }), verdictFor: (rowId) => (rowId === 'r1' ? { rowId: 'r1', pass: true } : null) },
    gepa: { run: async () => ({ ok: true, proposed: [{ sourceItemIds: ['g1'] }] }) },
    ...over,
  };
  registerPluginLoops({ registry, retryQueue, stateDir, ...deps });
  return { registry, retryQueue };
}

test('four plugin loops are registered with distinct makers and checkers', () => {
  const { registry } = setup();
  assert.deepEqual(Object.keys(registry.snapshot()).sort(), ['guard-proposals', 'memory-admission', 'plugin-retry', 'session-judge']);
});

test('a failing admission is queued for retry and shows as a loop failure (no pluginHealth)', async () => {
  const { registry, retryQueue } = setup({ memory: { admit: async () => { throw new Error('model timed out'); }, verifyAdmitted: async () => ({ ok: true }) } });
  const [r] = await registry.emit('session.condensed', { sessionId: 's1', project: 'p', condensed: 'x' });
  assert.equal(r.outcome, 'failed');
  assert.equal(retryQueue.jobs[0].kind, 'memory.admit');
  assert.equal(registry.get('memory-admission').consecutiveFailures, 1);
});

test('the judge loop fails when no verdict row landed, even if the maker said ok', async () => {
  const { registry } = setup();
  const [ok] = await registry.emit('outcome.finalized', { row: { id: 'r1' }, sessionId: 's', firstPrompt: 'x' });
  assert.equal(ok.outcome, 'done');
  const [bad] = await registry.emit('outcome.finalized', { row: { id: 'r2' }, sessionId: 's', firstPrompt: 'x' });
  assert.equal(bad.outcome, 'failed');
  assert.match(bad.reason, /checker:no verdict row for r2/);
});

test('an empty session is nothing-to-do, not a failure', async () => {
  const { registry } = setup({ judge: { judge: async () => ({ judged: false }), verdictFor: () => null } });
  const [r] = await registry.emit('outcome.finalized', { row: { id: 'r9' }, sessionId: 's', firstPrompt: '' });
  assert.equal(r.outcome, 'nothing-to-do');
  assert.equal(registry.get('session-judge').consecutiveFailures, 0);
});

test('a GEPA proposal without provenance fails the checker', async () => {
  const { registry } = setup({ gepa: { run: async () => ({ ok: true, proposed: [{ sourceItemIds: [] }] }) } });
  const [r] = await registry.emit('gepa.requested', {});
  assert.match(r.reason, /checker:proposal without provenance/);
});

test('proof it closes, per plugin loop: fail, fail again, then a good run clears the alert', async () => {
  const { loopAlerts } = await import('../lib/loops/loop-health.js');
  const count = (reg, name) => loopAlerts(reg.snapshot()).filter((a) => a.title === `Loop failing: ${name}`).length;
  // memory-admission: the checker breaks (a poisoned fact admitted), then recovers
  let poisoned = true;
  let { registry } = setup({ memory: { admit: async () => ({ written: ['f'] }), verifyAdmitted: async () => (poisoned ? { ok: false, reason: 'poisoned fact admitted' } : { ok: true }) } });
  await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'x' }); assert.equal(count(registry, 'memory-admission'), 1);
  await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'x' }); assert.equal(count(registry, 'memory-admission'), 1);
  poisoned = false; await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'x' }); assert.equal(count(registry, 'memory-admission'), 0);
  // session-judge: the maker breaks, then recovers
  let judgeDown = true;
  ({ registry } = setup({ judge: { judge: async () => { if (judgeDown) throw new Error('model timed out'); }, verdictFor: () => ({ pass: true }) } }));
  await registry.emit('outcome.finalized', { row: { id: 'r1' }, sessionId: 's', firstPrompt: 'x' });
  await registry.emit('outcome.finalized', { row: { id: 'r1' }, sessionId: 's', firstPrompt: 'x' }); assert.equal(count(registry, 'session-judge'), 1);
  judgeDown = false; await registry.emit('outcome.finalized', { row: { id: 'r1' }, sessionId: 's', firstPrompt: 'x' }); assert.equal(count(registry, 'session-judge'), 0);
  // guard-proposals: the maker breaks, then recovers
  let gepaDown = true;
  ({ registry } = setup({ gepa: { run: async () => (gepaDown ? { ok: false, error: 'python missing' } : { ok: true, proposed: [{ sourceItemIds: ['g'] }] }) } }));
  await registry.emit('gepa.requested', {}); await registry.emit('gepa.requested', {}); assert.equal(count(registry, 'guard-proposals'), 1);
  gepaDown = false; await registry.emit('gepa.requested', {}); assert.equal(count(registry, 'guard-proposals'), 0);
  // plugin-retry: the checker breaks (queue accounting), then recovers
  let lie = true; const q = fakeQueue();
  const reg2 = createLoopRegistry({ stateDir: tmp(), setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry: reg2, retryQueue: { ...q, size: () => (lie ? q.jobs.length + 5 : q.jobs.length) }, memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) }, judge: { judge: async () => {}, verdictFor: () => ({}) }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  q.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' }); await reg2.runNow('plugin-retry');
  q.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' }); await reg2.runNow('plugin-retry');
  assert.equal(count(reg2, 'plugin-retry'), 1);
  lie = false; q.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' }); await reg2.runNow('plugin-retry');
  assert.equal(count(reg2, 'plugin-retry'), 0);
});

test('plugin-retry acks successes, bumps failures and gives up at 10 attempts with a named failure', async () => {
  let admitOk = false;
  const { registry, retryQueue } = setup({ memory: { admit: async () => { if (!admitOk) throw new Error('down'); return { written: [] }; }, verifyAdmitted: async () => ({ ok: true }) } });
  retryQueue.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' });
  await registry.runNow('plugin-retry');
  assert.equal(retryQueue.jobs[0].attempts, 1);
  retryQueue.jobs[0].attempts = 9;
  const r = await registry.runNow('plugin-retry');
  assert.equal(retryQueue.size(), 0);
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /gave up after 10 attempts: memory.admit/);
});


// a poisoned fact whose removal itself failed must never cause the whole
// (non-idempotent) admission to be retried - the memory.remove job kind is
// how a narrow, single-fact retry is expressed; plugin-retry must know how
// to drain it.
test('C1: plugin-retry acks a memory.remove job on success, bumps it on failure', async () => {
  const removed = [];
  const { registry, retryQueue } = setup({ memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }), remove: async (id) => { removed.push(id); } } });
  retryQueue.push({ kind: 'memory.remove', removeId: 'bad-fact' });
  const r = await registry.runNow('plugin-retry');
  assert.deepEqual(removed, ['bad-fact']);
  assert.equal(retryQueue.size(), 0, 'acked on success');
  assert.equal(r.outcome, 'done');
});

test('C1: a failing memory.remove is bumped, never dropped, with a named reason', async () => {
  const { registry, retryQueue } = setup({ memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }), remove: async () => { throw new Error('mem0 delete failed'); } } });
  retryQueue.push({ kind: 'memory.remove', removeId: 'bad-fact' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(retryQueue.jobs[0].attempts, 1, 'bumped, not dropped');
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /memory\.remove: mem0 delete failed/);
});

// never re-run the model for a row that already has a verdict - the
// classic "double judge" this loop must never do, whether the verdict
// landed from an earlier attempt or a genuinely concurrent one.
test('I3: a judge.session job whose rowId already has a verdict is acked without ever calling the judge', async () => {
  let judgeCalls = 0;
  const { registry, retryQueue } = setup({ judge: { judge: async () => { judgeCalls++; return { judged: true }; }, verdictFor: (rowId) => (rowId === 'r1' ? { rowId: 'r1' } : null) } });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's', firstPrompt: 'x' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(judgeCalls, 0, 'the judge was never called - the existing verdict is authoritative');
  assert.equal(retryQueue.size(), 0, 'acked as a no-op success');
  assert.equal(r.outcome, 'done');
});

// plugin-retry dispatches a due judge.session job through session-judge's
// own maker/checker (a real different-actor check), not a bare re-call of
// judge.judge - proven by the checker's own verdictFor gate actually
// deciding success/failure, and by onFailed being suppressed so the already-
// durably-queued job (the one plugin-retry itself is managing) never gets a
// duplicate pushed on top of it.
test('I2: plugin-retry runs a due judge.session job through session-judge, and never double-queues on failure', async () => {
  const { registry, retryQueue } = setup({ judge: { judge: async () => ({ judged: true }), verdictFor: () => null } });
  retryQueue.push({ kind: 'judge.session', rowId: 'r9', sessionId: 's', firstPrompt: 'x' });
  const r = await registry.runNow('plugin-retry');
  // The judge "succeeded" (judged: true) but no verdict row ever landed, so
  // session-judge's own checker (a different actor from the maker) refuses
  // it - proving the checker, not a bare maker re-call, decided this.
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /no verdict row for r9/);
  assert.equal(retryQueue.jobs.length, 1, 'still exactly the one original job - never duplicated');
  assert.equal(retryQueue.jobs[0].attempts, 1, 'bumped, not replaced by a second push');
});

test('I2: onVerified closes the ticket\'s gate obligation once session-judge\'s checker passes', async () => {
  const closed = []; const verdicted = new Set();
  const { registry, retryQueue } = setup({
    judge: {
      judge: async () => { verdicted.add('r1'); return { judged: true, ts: 42 }; },
      verdictFor: (rowId) => (verdicted.has(rowId) ? { rowId } : null),
      closeGateVerdict: async (args) => { closed.push(args); },
    },
  });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's', firstPrompt: 'x', ticketId: 'card-1' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(r.outcome, 'done');
  assert.deepEqual(closed, [{ ticketId: 'card-1', rowId: 'r1', verdictTs: 42 }]);
});

test('I2: onVerified is never called when the job carries no ticketId', async () => {
  const closed = []; const verdicted = new Set();
  const { registry, retryQueue } = setup({
    judge: {
      judge: async () => { verdicted.add('r1'); return { judged: true }; },
      verdictFor: (rowId) => (verdicted.has(rowId) ? { rowId } : null),
      closeGateVerdict: async (args) => { closed.push(args); },
    },
  });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's', firstPrompt: 'x' });
  await registry.runNow('plugin-retry');
  assert.deepEqual(closed, []);
});

// the run fails whenever anything was bumped this tick, not only once
// the retry budget is exhausted - so the alert stays up for the WHOLE
// outage, every job's own reason named, never a bare catch.
test('I5: the tick fails (not just "done" with a hidden bump) the moment any job is bumped, naming its reason', async () => {
  const { registry, retryQueue } = setup({ memory: { admit: async () => { throw new Error('mem0 down'); }, verifyAdmitted: async () => ({ ok: true }) } });
  retryQueue.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /memory\.admit: mem0 down/);
  assert.equal(retryQueue.jobs[0].attempts, 1, 'still bumped for a later attempt, not dropped');
});

test('I5: a give-up writes the dead-letter file with the job\'s own payload and reason', async () => {
  const deadLetterFile = path.join(tmp(), 'retry-dead.ndjson');
  const stateDir = tmp(); const q = fakeQueue();
  const reg = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({
    registry: reg, retryQueue: q, deadLetterFile,
    memory: { admit: async () => { throw new Error('mem0 down'); }, verifyAdmitted: async () => ({ ok: true }) },
    judge: { judge: async () => ({ judged: true }), verdictFor: () => null },
    gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });
  q.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x', attempts: 9 });
  const r = await reg.runNow('plugin-retry');
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /gave up after 10 attempts: memory\.admit/);
  const lines = fs.readFileSync(deadLetterFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'memory.admit');
  assert.equal(lines[0].sessionId, 's');
  assert.match(lines[0].reason, /mem0 down/);
});

// a maker must stop taking on NEW work once the run's own ctx.signal is
// aborted - proven with a real, short-lived timeout race (a fake clock never
// fires its callback, so this specifically needs real setTimeout/clearTimeout
// and a pluginRetryTimeoutMs short enough for a fast test).
test('I6: plugin-retry stops taking new jobs once aborted, and the in-flight job stays leased for the next tick', async () => {
  const stateDir = tmp(); const q = fakeQueue();
  const reg = createLoopRegistry({ stateDir, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h) });
  const started = []; let releaseFirst;
  const firstStarted = new Promise((res) => { releaseFirst = res; });
  registerPluginLoops({
    registry: reg, retryQueue: q, pluginRetryTimeoutMs: 30,
    memory: {
      admit: async (job) => {
        started.push(job.sessionId);
        if (job.sessionId === 'slow') { releaseFirst(); await new Promise((res) => setTimeout(res, 200)); }
        return { written: [] };
      },
      verifyAdmitted: async () => ({ ok: true }),
    },
    judge: { judge: async () => ({ judged: true }), verdictFor: () => null },
    gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });
  q.push({ kind: 'memory.admit', sessionId: 'slow', project: 'p', condensed: 'x' });
  q.push({ kind: 'memory.admit', sessionId: 'fast', project: 'p', condensed: 'x' });
  const firstTick = reg.runNow('plugin-retry'); // not awaited yet: the ceiling (30ms) will time this out while 'slow' is still in flight
  await firstStarted;
  const r1 = await firstTick;
  assert.equal(r1.outcome, 'failed');
  assert.match(r1.reason, /timeout/);
  assert.deepEqual(started, ['slow'], 'the timed-out tick never even started the second (fast) job once the ceiling raced past the first');
  // The 'slow' job is still leased (its own attempt has not returned yet) - a
  // second tick, run immediately after the first gives up waiting, must not
  // re-take it.
  const r2 = await reg.runNow('plugin-retry');
  assert.deepEqual(started, ['slow', 'fast'], 'the second tick only ever took the still-untouched fast job, never re-taking the leased slow one');
  assert.equal(r2.outcome, 'done');
  // The orphaned first attempt's own jobs array was captured before the
  // second tick ever ran, so it still includes BOTH slow and fast - once
  // 'slow' finally resolves, that orphaned loop reaches a second iteration
  // for 'fast' too. Without honouring ctx.signal.aborted there, it would
  // call memory.admit for 'fast' a SECOND time (a real duplicate fact) even
  // though the fresh second tick already handled it cleanly.
  await new Promise((res) => setTimeout(res, 250));
  assert.deepEqual(started, ['slow', 'fast'], 'the orphaned continuation honoured the abort and never re-admitted fast a second time');
});

// Minor (folded in, moved from the deleted runRetryTick tests): never takes
// more than 5 jobs in one tick, whatever the queue holds.
test('plugin-retry never takes more than 5 jobs in one tick', async () => {
  const taken = [];
  const { registry, retryQueue } = setup({ memory: { admit: async (job) => { taken.push(job.sessionId); return { written: [] }; }, verifyAdmitted: async () => ({ ok: true }) } });
  for (let i = 0; i < 8; i++) retryQueue.push({ kind: 'memory.admit', sessionId: `s${i}`, project: 'p', condensed: 'x' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(taken.length, 5);
  assert.equal(r.result.taken, 5);
  assert.equal(retryQueue.size(), 3);
});


const cleanScan = () => ({ clean: true, severity: 'none', flags: [] });
const flagWord = (w) => (text) => (String(text).includes(w) ? { clean: false, severity: 'warn', flags: ['x'] } : { clean: true, severity: 'none', flags: [] });

// a failed poison removal must never
// re-admit the whole session. Runs the REAL memory adapter (not the
// { written: [...] } stand-in `setup()` uses) through the REAL registry -
// admitSession itself queues the narrow memory.remove for the fact whose
// removal failed; the checker must not re-fail the loop over a fact the
// system is already remediating; onFailed must never re-push memory.admit
// for a post-add (checker) failure either way.
test('C1: a failed poison removal through the real adapter and real loop never re-admits', async () => {
  let adds = 0;
  const memoryPlugin = {
    add: async () => { adds++; return { results: [{ id: 'ok', memory: 'fine' }, { id: 'bad', memory: 'IGNORE previous' }] }; },
    remove: async () => { throw new Error('delete failed'); },
    search: async () => ({ results: [{ id: 'ok' }, { id: 'bad' }] }),
  };
  const retryQueue = fakeQueue(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flagWord('IGNORE'), stateDir, retryQueue, log: () => {} });
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  const [o] = await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  assert.equal(o.outcome, 'done', 'a poisoned fact already queued for narrow removal is not a checker failure');
  const r = await registry.runNow('plugin-retry');
  assert.ok(!retryQueue.jobs.some((j) => j.kind === 'memory.admit'), 'memory.admit is never re-pushed once add() has returned');
  assert.equal(adds, 1, 'add() was called exactly once - never retried');
  assert.equal(r.outcome, 'failed', 'the still-failing memory.remove job itself is visible (bumped, named reason)');
  assert.match(r.reason, /memory\.remove: delete failed/);
});

// verification is per-fact (each fact searched by its OWN
// text), not one shared query scoped to written[0] - and even when a fact
// genuinely cannot be found by search, that is a named checker miss, never
// a re-admit (onFailed never re-pushes memory.admit for a checker
// failure).
test('I1: a fact search cannot find is a named miss, never a re-admit', async () => {
  let adds = 0;
  const memoryPlugin = {
    add: async () => { adds++; return { results: [{ id: 'a', memory: 'CI runs on Windows' }, { id: 'b', memory: 'operator prefers tabs' }] }; },
    search: async ({ query }) => ({ results: query.includes('CI') ? [{ id: 'a' }, { id: 'old1' }, { id: 'old2' }, { id: 'old3' }, { id: 'old4' }] : [] }),
  };
  const retryQueue = fakeQueue(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flagWord('IGNORE'), stateDir, retryQueue, log: () => {} });
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  await registry.runNow('plugin-retry'); await registry.runNow('plugin-retry');
  assert.equal(adds, 1, 'a search miss on one fact never triggers a second add()');
});

// the in-flight dedupe key is sessionId PLUS a hash of the
// condensed text - two genuinely different deltas for the SAME session
// must both reach memory.add(), never collapse the second onto the
// first's in-flight promise.
test('I6: two different deltas for the same session both reach memory.add(), never collapsed', async () => {
  const sent = []; let release; const gate = new Promise((r) => { release = r; });
  const memoryPlugin = { add: async ({ messages }) => { sent.push(messages.map((m) => m.content).join('|')); await gate; return { results: [] }; } };
  const memory = createMemoryAdapter({ memoryPlugin, scan: cleanScan, stateDir: tmp(), retryQueue: fakeQueue() });
  const p1 = memory.admit({ sessionId: 's', project: 'p', condensed: 'USER: delta one' });
  const p2 = memory.admit({ sessionId: 's', project: 'p', condensed: 'USER: delta two' });
  release(); await Promise.all([p1, p2]);
  assert.equal(sent.length, 2, 'both deltas were sent to mem0, not collapsed into one');
});

// I2/I5a: a shutdown mid-tick (registry.stop()) must never ack a
// judge.session job as if it had been judged - the job stays queued,
// untouched, for a later tick.
test('I2/I5a: a judge.session job in flight when the registry stops stays queued, not acked', async () => {
  const retryQueue = fakeQueue(); const stateDir = tmp(); let judged = 0; let release;
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  const gate = new Promise((r) => { release = r; });
  registerPluginLoops({
    registry, retryQueue,
    memory: { admit: async () => { await gate; return { written: [] }; }, verifyAdmitted: async () => ({ ok: true }) },
    judge: { judge: async () => { judged++; return { judged: true }; }, verdictFor: () => null },
    gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });
  retryQueue.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's1', firstPrompt: 'x' });
  const tick = registry.runNow('plugin-retry');
  await new Promise((r) => setImmediate(r));
  registry.stop(); release();
  const r = await tick;
  assert.equal(retryQueue.jobs.length, 1, 'the unjudged judge.session job must stay queued');
  assert.equal(retryQueue.jobs[0].kind, 'judge.session');
  assert.equal(retryQueue.jobs[0].attempts, 0, 'never bumped - a shutdown is not the job\'s own fault');
  assert.equal(judged, 0, 'the judge itself was never called');
  assert.equal(r.outcome, 'nothing-to-do', 'a graceful mid-tick stop is not itself a loop failure');
});

// plugin-retry's own backoff never grows past its own tick
// interval - a run of consecutive failures must not push the WHOLE
// queue's next tick out toward registerLoop's generic 24h ceiling.
test('I5b: plugin-retry backoff never exceeds its own tick interval', async () => {
  // Five consecutive bumped ticks (a run of failures, matching I5's own
  // "fail on any bump" design) must never push the next scheduled run more
  // than one tick interval past `now` - registerLoop's generic default
  // (maxMs: 24h) would otherwise let this climb toward a full day.
  const q = fakeQueue();
  const registry = createLoopRegistry({ stateDir: tmp(), setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({
    registry, retryQueue: q, pluginRetryEveryMs: 5 * 60_000,
    memory: { admit: async () => { throw new Error('down'); }, verifyAdmitted: async () => ({ ok: true }) },
    judge: { judge: async () => ({ judged: true }), verdictFor: () => null },
    gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });
  q.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'x' });
  let before;
  for (let i = 0; i < 5; i++) {
    before = Date.now();
    await registry.runNow('plugin-retry');
  }
  const nextRunTs = registry.snapshot()['plugin-retry'].nextRunTs;
  // A small tolerance absorbs real wall-clock jitter between capturing
  // `before` and the loop's own now() call - the flat-backoff FIX keeps
  // this near one tick interval; the OLD exponential default would have
  // put it up around 80 minutes after only 5 consecutive failures.
  assert.ok(nextRunTs - before <= 5 * 60_000 + 1000, `next run must be within one tick interval, got ${nextRunTs - before}ms`);
});

// Minor: if closeGateVerdict throws in onVerified (the
// verdict already landed, only the close itself failed), session-judge's
// onFailed queues a narrow judge.close retry - never a full re-judge,
// which would both waste two model calls AND get silently skipped by the
// I3 double-judge guard, leaving the close never retried at all.
test('minor: a closeGateVerdict failure after a verdict landed retries only the close, never re-judges', async () => {
  let judgeCalls = 0; const closeAttempts = [];
  const { registry, retryQueue } = setup({
    judge: {
      judge: async () => { judgeCalls++; return { judged: true, ts: 123 }; },
      verdictFor: (rowId) => (rowId === 'r1' ? { rowId: 'r1', ts: 123 } : null),
      closeGateVerdict: async (args) => { closeAttempts.push(args); throw new Error('obligation store down'); },
    },
  });
  const [r] = await registry.emit('outcome.finalized', { row: { id: 'r1' }, sessionId: 's', firstPrompt: 'x', ticketId: 'card-1' });
  assert.equal(r.outcome, 'failed');
  assert.equal(retryQueue.jobs[0].kind, 'judge.close', 'a narrow close retry, not a full judge.session re-push');
  assert.equal(judgeCalls, 1);
  // Draining the retry queue retries only the close (verdictFor already
  // resolves, so judge.judge is never called again).
  const closeOk = [];
  const { registry: registry2, retryQueue: retryQueue2 } = setup({
    judge: {
      judge: async () => { judgeCalls++; return { judged: true, ts: 123 }; },
      verdictFor: (rowId) => (rowId === 'r1' ? { rowId: 'r1', ts: 123 } : null),
      closeGateVerdict: async (args) => { closeOk.push(args); },
    },
  });
  retryQueue2.push({ kind: 'judge.close', rowId: 'r1', ticketId: 'card-1' });
  await registry2.runNow('plugin-retry');
  assert.deepEqual(closeOk, [{ ticketId: 'card-1', rowId: 'r1', verdictTs: 123 }]);
  assert.equal(judgeCalls, 1, 'still the one original judge call from above - never re-judged');
});

// Minor (folded in): the FIRST fire of an everyMs loop matches its own
// stated interval, not registerLoop's generic 30s bootDelayMs default.
test('plugin-retry and a scheduled guard-proposals both first-fire after their own interval, not the generic 30s bootDelayMs', () => {
  const stateDir = tmp(); const t0 = 1_000_000;
  const registry = createLoopRegistry({ stateDir, now: () => t0, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({
    registry, retryQueue: fakeQueue(), pluginRetryEveryMs: 5 * 60_000, gepaEveryMs: 15 * 60_000,
    memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) },
    judge: { judge: async () => ({ judged: true }), verdictFor: () => null },
    gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });
  assert.equal(registry.get('plugin-retry').nextRunTs, t0 + 5 * 60_000);
  assert.equal(registry.get('guard-proposals').nextRunTs, t0 + 15 * 60_000);
});


// glmps-2-0-runtime-84: both loops use bootDelayMs equal to their interval,
// the shape that a 30-minute deploy cadence starved; a restart must resume.
test('plugin-retry and a scheduled guard-proposals resume their persisted cadence across a restart', async () => {
  const stateDir = tmp(); let t = 1_000_000;
  const mk = () => {
    const registry = createLoopRegistry({ stateDir, now: () => t, setTimer: () => 0, clearTimer: () => {} });
    registerPluginLoops({
      registry, retryQueue: fakeQueue(), pluginRetryEveryMs: 5 * 60_000, gepaEveryMs: 15 * 60_000,
      memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) },
      judge: { judge: async () => ({ judged: true }), verdictFor: () => null },
      gepa: { run: async () => ({ ok: true, proposed: [] }) },
    });
    return registry;
  };
  const a = mk();
  await a.runNow('plugin-retry'); await a.runNow('guard-proposals');
  const ran = t; a.stop();
  t += 4 * 60_000;
  const b = mk();
  assert.equal(b.get('plugin-retry').nextRunTs, ran + 5 * 60_000);
  assert.equal(b.get('guard-proposals').nextRunTs, ran + 15 * 60_000);
  b.stop();
});

const flag = (t) => (String(t).includes('IGNORE') ? { clean: false, severity: 'warn', flags: ['x'] } : { clean: true, severity: 'none', flags: [] });

// q() with an optional failPush hook (the P4 probe's own shape), matching
// the real retry-queue.js's take/push/ack/bump/size contract.
function queueWith(opts = {}) {
  const jobs = []; let n = 0;
  return {
    jobs,
    push: (j) => { if (opts.failPush && opts.failPush(j)) throw new Error('disk full'); jobs.push({ id: `j${++n}`, attempts: 0, ...j }); },
    take: (k) => jobs.slice(0, k),
    ack: (id) => { const i = jobs.findIndex((j) => j.id === id); if (i >= 0) jobs.splice(i, 1); },
    bump: (id) => { const j = jobs.find((x) => x.id === id); if (j) j.attempts++; },
    size: () => jobs.length,
  };
}

// the k6r2 probe P1 - plugin-retry's OWN
// memory.admit branch (a job queued by a genuine maker failure) must never
// re-run add() once it has returned, no matter what verification finds on
// a LATER tick.
test('C1 (round 3): plugin-retry never re-runs add() once it has returned, even across repeated verify failures', async () => {
  let adds = 0;
  const memoryPlugin = {
    add: async () => { adds++; return { results: [{ id: 'a', memory: 'fact a' }] }; },
    search: async () => { throw new Error('search transient'); },
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'USER: hi' });
  await registry.runNow('plugin-retry'); await registry.runNow('plugin-retry'); await registry.runNow('plugin-retry');
  assert.equal(adds, 1, 'add() must not be re-run once it has returned');
  assert.equal(retryQueue.jobs.length, 0, 'the job is acked once admit() has returned, regardless of verify');
});

// the k6r2 probe P2 - a checker TIMEOUT (or any other
// ceiling error) raised AFTER add() has already succeeded must never
// re-push memory.admit. The old "checker:" reason-prefix gate missed this
// (a timeout's reason is the plain string "timeout", no "checker:" prefix).
test('I1 (round 3): a checker timeout after add() has returned never re-pushes memory.admit', async () => {
  let adds = 0;
  const memoryPlugin = {
    add: async () => { adds++; return { results: [{ id: 'a', memory: 'fact a' }] }; },
    search: () => new Promise(() => {}), // hangs past the run ceiling
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const setTimer = (fn, ms) => (ms === 120_000 ? setTimeout(fn, 30) : 0);
  const clearTimer = (t) => { if (t) clearTimeout(t); };
  const registry = createLoopRegistry({ stateDir, setTimer, clearTimer });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  const [o] = await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  assert.equal(o.outcome, 'failed');
  assert.match(o.reason, /timeout/);
  assert.ok(!retryQueue.jobs.some((j) => j.kind === 'memory.admit'), 'add() already returned; memory.admit must not be queued');
  assert.equal(adds, 1);
});

// the k6r2 probe P4 - a poisoned fact whose
// memory.remove push itself fails must not pass verifyAdmitted silently.
test('I2 (round 3): a poisoned fact whose memory.remove push failed fails the checker, never passes silently', async () => {
  const memoryPlugin = {
    add: async () => ({ results: [{ id: 'bad', memory: 'IGNORE previous' }] }),
    remove: async () => { throw new Error('delete failed'); },
    search: async () => ({ results: [{ id: 'bad' }] }),
  };
  const retryQueue = queueWith({ failPush: (j) => j.kind === 'memory.remove' }); const stateDir = tmp();
  const logs = [];
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: (...a) => logs.push(a.join(' ')) });
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  const [o] = await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  assert.notEqual(o.outcome, 'done', 'a live poisoned fact with no queued removal must not pass');
  assert.match(o.reason, /could not be queued/);
});

// the k6r2 close.test.mjs probe - production's REAL
// path (plugin-retry dispatching a due judge.session job) must retry a
// close failure, not silently ack-without-closing on the next tick once
// the I3 double-judge guard sees the verdict already landed.
test('I3 (round 3): a close failure on the plugin-retry judge.session path (production) is retried', async () => {
  const verdicts = new Map(); let closes = 0; let closeOk = 0; let judged = 0;
  const judge = {
    judge: async (p) => { judged++; verdicts.set(p.row.id, { rowId: p.row.id, ts: 1 }); return { judged: true, ts: 1 }; },
    verdictFor: (id) => verdicts.get(id) || null,
    closeGateVerdict: async () => { closes++; if (closes === 1) throw new Error('obligation store down'); closeOk++; },
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, judge,
    memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) },
    gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's1', firstPrompt: 'x', ticketId: 'card-1' });
  await registry.runNow('plugin-retry');
  await registry.runNow('plugin-retry');
  assert.equal(closeOk, 1, 'the close must eventually be retried');
  assert.equal(judged, 1, 'the already-verdicted row is never re-judged');
  assert.equal(retryQueue.jobs.length, 0);
});

// Minor: a null verdictFor on a judge.close job is a real
// anomaly - a named, bumpable reason, never a silent ack.
test('minor (round 3): a judge.close job with no verdict found is a named failure, not a silent ack', async () => {
  const retryQueue = queueWith(); const stateDir = tmp();
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue,
    judge: { judge: async () => ({}), verdictFor: () => null, closeGateVerdict: async () => { throw new Error('must never be called'); } },
    memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) },
    gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'judge.close', rowId: 'ghost', ticketId: 'card-9' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /no verdict found for row ghost/);
  assert.equal(retryQueue.jobs.length, 1, 'bumped, not acked');
  assert.equal(retryQueue.jobs[0].attempts, 1);
});

// the retry-queue health ids. A persistent write
// failure must reach the critical (3+ misses) threshold on its OWN id,
// unaffected by clearMiss calls on the unrelated queue-file or
// dead-letter-read ids; a dead-letter read error on ITS OWN id must stick
// (not get cleared) across an unrelated clean queue read.
test('I5: a persistent retry-queue-write failure reaches critical, unaffected by unrelated clears', async () => {
  const { reportMiss, clearMiss, adapterHealth, resetAdapterHealth } = await import('../lib/adapters/health.js');
  const { collectAlerts } = await import('../lib/observability/alert-sources.js');
  resetAdapterHealth();
  reportMiss('retry-queue-write', 'disk full');
  clearMiss('retry-queue'); // an unrelated clean queue-file read
  clearMiss('retry-queue-deadletter'); // an unrelated clean dead-letter read
  reportMiss('retry-queue-write', 'disk full');
  reportMiss('retry-queue-write', 'disk full');
  const alerts = collectAlerts({ adapterHealth: adapterHealth() });
  const hit = alerts.find((a) => a.title === 'Kernel health: retry-queue-write');
  assert.ok(hit, 'retry-queue-write must render as its own Kernel health alert');
  assert.equal(hit.severity, 'critical', 'three unrelated-clear-surviving misses reach the critical threshold');
  resetAdapterHealth();
});

test('I5: a dead-letter EACCES ack sticks - an unrelated clean queue read must not clear it', async () => {
  const { reportMiss, clearMiss, adapterHealth, resetAdapterHealth } = await import('../lib/adapters/health.js');
  resetAdapterHealth();
  reportMiss('retry-queue-deadletter', 'EACCES');
  clearMiss('retry-queue'); // an unrelated clean queue-file read must not touch the deadletter id
  clearMiss('retry-queue-write'); // nor the write id
  const h = adapterHealth()['retry-queue-deadletter'];
  assert.ok(h, 'the dead-letter failure is still recorded');
  assert.equal(h.lastReason, 'EACCES');
  resetAdapterHealth();
});

// Minor: a direct verifyAdmitted unit test with a
// content-sensitive search (unlike the k6r2 probe's own query-insensitive
// mock) proves per-fact search genuinely fixes the I1 false negative - a
// search for fact A's own text does not return fact B, and vice versa, but
// each fact IS found by its own query.
test('minor (round 3): per-fact search finds two unrelated facts a shared written[0]-only query would miss', async () => {
  const memoryPlugin = {
    search: async ({ query }) => ({
      results: query.includes('Windows') ? [{ id: 'a' }] : (query.includes('tabs') ? [{ id: 'b' }] : []),
    }),
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const r = await memory.verifyAdmitted({
    written: [{ id: 'a', memory: 'CI runs on Windows' }, { id: 'b', memory: 'operator prefers tabs' }],
    project: 'p',
  });
  assert.equal(r.ok, true, 'each fact is found by searching for its OWN text, even though no single query would find both');
});


// A setTimer that shortens only the FIRST 120s timer it is asked for (the
// run's own ceiling timeout) to `firstMs`, leaving every later one (each
// hook's own fresh bound) at its real length, unref'd so it never holds the
// test process open.
function shortFirstCeiling(firstMs = 30) {
  let n = 0;
  return {
    setTimer: (fn, ms) => {
      if (ms !== 120_000) return 0;
      const h = setTimeout(fn, n++ === 0 ? firstMs : ms); h.unref?.(); return h;
    },
    clearTimer: (t) => { if (t) clearTimeout(t); },
  };
}

// the k6r3 probe R1. add() has RETURNED, but admitSession is
// still awaiting remove() for a poisoned fact when the maker's ceiling
// fires. The add-returned mark must be set from inside admitSession the
// instant memory.add resolves, not when admitSession itself returns.
test('I1 (round 4): a maker timeout while a post-add remove() is in flight never re-pushes memory.admit', async () => {
  let adds = 0; let releaseRemove;
  const removeGate = new Promise((r) => { releaseRemove = r; });
  const memoryPlugin = {
    add: async () => { adds++; return { results: [{ id: 'bad', memory: 'IGNORE previous' }] }; },
    remove: async () => { await removeGate; throw new Error('mem0 delete timed out'); },
    search: async () => ({ results: [{ id: 'bad' }] }),
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const setTimer = (fn, ms) => (ms === 120_000 ? setTimeout(fn, 30) : 0);
  const clearTimer = (t) => { if (t) clearTimeout(t); };
  const registry = createLoopRegistry({ stateDir, setTimer, clearTimer });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  const [o] = await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  assert.equal(o.outcome, 'failed');
  releaseRemove(); await new Promise((r) => setTimeout(r, 20));
  assert.ok(!retryQueue.jobs.some((j) => j.kind === 'memory.admit'), `add() already returned; memory.admit must not be queued, got ${JSON.stringify(retryQueue.jobs.map((j) => j.kind))}`);
  assert.ok(retryQueue.jobs.some((j) => j.kind === 'memory.remove' && j.removeId === 'bad'), 'the narrow removal is still queued');
  await registry.runNow('plugin-retry');
  assert.equal(adds, 1, 'add() returned before the timeout; it must not be re-run');
});

// a second caller riding the SAME in-flight admission (the
// dedupe key) sees the shared add-returned mark too, not only the caller
// that started it.
test('I1 (round 4): a caller riding the in-flight admission shares its add-returned state', async () => {
  let releaseRemove;
  const removeGate = new Promise((r) => { releaseRemove = r; });
  const memoryPlugin = {
    add: async () => ({ results: [{ id: 'bad', memory: 'IGNORE previous' }] }),
    remove: async () => { await removeGate; },
  };
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir: tmp(), retryQueue: queueWith(), log: () => {} });
  const payload = { sessionId: 's', project: 'p', condensed: 'USER: hi' };
  const first = {}; const rider = {};
  const p1 = memory.admit(payload, first);
  const p2 = memory.admit(payload, rider);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rider.admitState?.addReturned, true, 'the rider sees add() returned while admitSession is still awaiting remove()');
  assert.equal(first.admitState, rider.admitState, 'one shared state per in-flight key');
  releaseRemove(); await Promise.all([p1, p2]);
});

// Minor 4: a maker timeout DURING add() itself - onFailed waits
// (bounded) on the in-flight admission before deciding; an add() that then
// returns inside that wait is never re-pushed as a whole admission.
test('minor 4 (round 4): onFailed waits on an in-flight add() before re-pushing memory.admit', async () => {
  let adds = 0; let releaseAdd;
  const addGate = new Promise((r) => { releaseAdd = r; });
  const memoryPlugin = {
    add: async () => { await addGate; adds++; return { results: [{ id: 'a', memory: 'fact a' }] }; },
    search: async () => ({ results: [{ id: 'a' }] }),
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const { setTimer, clearTimer } = shortFirstCeiling(30);
  const registry = createLoopRegistry({ stateDir, setTimer, clearTimer });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  setTimeout(releaseAdd, 60);
  const [o] = await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  assert.equal(o.outcome, 'failed');
  assert.match(o.reason, /timeout/);
  assert.ok(!retryQueue.jobs.some((j) => j.kind === 'memory.admit'), 'add() returned inside the bounded wait; no duplicate admission is queued');
  assert.equal(adds, 1);
});

test('minor 4 (round 4): an in-flight add() that then fails is still re-pushed after the wait', async () => {
  let releaseAdd;
  const addGate = new Promise((r) => { releaseAdd = r; });
  const memoryPlugin = { add: async () => { await addGate; throw new Error('mem0 down'); } };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const { setTimer, clearTimer } = shortFirstCeiling(30);
  const registry = createLoopRegistry({ stateDir, setTimer, clearTimer });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  setTimeout(releaseAdd, 60);
  await registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  assert.deepEqual(retryQueue.jobs.map((j) => j.kind), ['memory.admit'], 'add() never returned: the whole admission is retried');
});

// Minor 5: a memory.admit ack that throws must not re-run add()
// on the next tick - the add-returned mark is recorded before acking, and
// the bump path checks it.
test('minor 5 (round 4): a memory.admit ack that throws never re-runs add() on the next tick', async () => {
  let adds = 0;
  const memoryPlugin = {
    add: async () => { adds++; return { results: [{ id: 'a', memory: 'fact a' }] }; },
    search: async () => ({ results: [{ id: 'a' }] }),
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const realAck = retryQueue.ack; let ackFails = 1;
  retryQueue.ack = (id) => { if (ackFails-- > 0) throw new Error('queue write EBUSY'); realAck(id); };
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, memory, judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'memory.admit', sessionId: 's', project: 'p', condensed: 'USER: hi' });
  const t1 = await registry.runNow('plugin-retry');
  assert.equal(t1.outcome, 'failed', 'the ack failure is visible');
  assert.match(t1.reason, /EBUSY/);
  assert.equal(retryQueue.jobs[0].attempts, 0, 'never bumped: add() already returned');
  await registry.runNow('plugin-retry');
  assert.equal(adds, 1, 'add() is never re-run once it has returned');
  assert.equal(retryQueue.jobs.length, 0, 'the job is acked on the next tick without re-admitting');
});

// the k6r3 probe R2. The checkerPassed branch must push the
// narrow judge.close BEFORE acking the judge.session job - a push failure
// must never lose the close.
test('I2 (round 4): a judge.close push failure never loses the close (push before ack)', async () => {
  const verdicts = new Map(); let closeCalls = 0; let closeOk = 0; let judged = 0;
  const judge = {
    judge: async (p) => { judged++; verdicts.set(p.row.id, { rowId: p.row.id, ts: 1 }); return { judged: true, ts: 1 }; },
    verdictFor: (id) => verdicts.get(id) || null,
    closeGateVerdict: async () => { closeCalls++; if (closeCalls === 1) throw new Error('obligation store down'); closeOk++; },
  };
  const retryQueue = queueWith({ failPush: (j) => j.kind === 'judge.close' }); const stateDir = tmp();
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, judge, memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's1', firstPrompt: 'x', ticketId: 'card-1' });
  const t1 = await registry.runNow('plugin-retry');
  assert.equal(t1.outcome, 'failed');
  assert.equal(retryQueue.jobs.length, 1, 'the judge.session job survives the failed push');
  assert.equal(retryQueue.jobs[0].kind, 'judge.session');
  await registry.runNow('plugin-retry');
  assert.equal(closeOk, 1, 'the close is retried on the next tick');
  assert.equal(judged, 1, 'never re-judged');
  assert.equal(retryQueue.jobs.length, 0);
});

// the k6r3 probe R3. The judge maker times out, the orphaned
// judge writes its verdict late; the next tick's double-judge guard finds
// that verdict and must run the idempotent close (with the verdict's own
// ts) before acking, never ack without closing.
test('I3 (round 4): a late verdict found by the double-judge guard is closed before the job is acked', async () => {
  const verdicts = new Map(); const closes = []; let judged = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const judge = {
    judge: async (p) => { judged++; await gate; verdicts.set(p.row.id, { rowId: p.row.id, ts: 777 }); return { judged: true, ts: 777 }; },
    verdictFor: (id) => verdicts.get(id) || null,
    closeGateVerdict: async (args) => { closes.push(args); },
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const setTimer = (fn, ms) => (ms === 120_000 ? setTimeout(fn, 30) : 0);
  const clearTimer = (t) => { if (t) clearTimeout(t); };
  const registry = createLoopRegistry({ stateDir, setTimer, clearTimer });
  registerPluginLoops({ registry, retryQueue, judge, memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's1', firstPrompt: 'x', ticketId: 'card-1' });
  const t1 = await registry.runNow('plugin-retry');
  assert.equal(t1.outcome, 'failed');
  release(); await new Promise((r) => setTimeout(r, 20));
  const t2 = await registry.runNow('plugin-retry');
  assert.equal(t2.outcome, 'done');
  assert.deepEqual(closes, [{ ticketId: 'card-1', rowId: 'r1', verdictTs: 777 }], 'the verdict landed; its gate obligation is closed with the verdict\'s own ts');
  assert.equal(judged, 1, 'never re-judged');
  assert.equal(retryQueue.jobs.length, 0);
});

test('I3 (round 4): a guard-path close failure bumps the job with a named reason, never a silent ack', async () => {
  const judge = {
    judge: async () => { throw new Error('must never be called'); },
    verdictFor: (id) => (id === 'r1' ? { rowId: 'r1', ts: 5 } : null),
    closeGateVerdict: async () => { throw new Error('obligation store down'); },
  };
  const retryQueue = queueWith(); const stateDir = tmp();
  const registry = createLoopRegistry({ stateDir, setTimer: () => 0, clearTimer: () => {} });
  registerPluginLoops({ registry, retryQueue, judge, memory: { admit: async () => ({ written: [] }), verifyAdmitted: async () => ({ ok: true }) }, gepa: { run: async () => ({ ok: true, proposed: [] }) } });
  retryQueue.push({ kind: 'judge.session', rowId: 'r1', sessionId: 's1', firstPrompt: 'x', ticketId: 'card-1' });
  const r = await registry.runNow('plugin-retry');
  assert.equal(r.outcome, 'failed');
  assert.match(r.reason, /judge\.session: obligation store down/);
  assert.equal(retryQueue.jobs[0].attempts, 1);
});

// settledWithin (the memory-admission loop's onFailed, "minor 4 round 4"
// above) used the global setTimeout/clearTimeout directly, so a test
// exercising its own 'wait-expired' branch had no way to control its clock
// without a real wall-clock wait. It must use the registry's OWN injected
// setTimer/clearTimer instead - the same pair every other registry-driven
// timeout in this file already controls via createLoopRegistry's own
// setTimer/clearTimer params.
//
// Proven with a fully fake, manually-fired clock: setTimer here records
// { fn, ms } and returns an id instead of touching the real event loop;
// fire(ms) invokes the one pending callback scheduled with that EXACT ms,
// synchronously, so the test advances the maker's own 120_000ms ceiling and
// then settledWithin's distinct admitSettleWaitMs (5_000ms) wait, in order,
// with no real delay anywhere. Before the fix, settledWithin's own expiry
// timer is invisible to this fake clock (it used the global setTimeout), so
// fire(5_000) finds nothing pending at that ms and fails outright - the
// right-reason RED this test is named for.
function fakeClock() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++nextId; pending.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    fire(ms) {
      const hit = [...pending.entries()].find(([, v]) => v.ms === ms);
      assert.ok(hit, `expected a pending timer scheduled with ms=${ms}, got ${JSON.stringify([...pending.values()].map((v) => v.ms))}`);
      const [id, { fn }] = hit;
      pending.delete(id);
      fn();
    },
  };
}
// Yields control back to the event loop repeatedly so every already-settled
// promise's .then/await continuations run - bounded (20 ticks), never a real
// timed wait: each tick only drains work already queued, so this converges
// as soon as the pending chain actually finishes, however many hops it took.
async function flush(ticks = 20) { for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r)); }

test('carry 2: settledWithin schedules its wait through the registry\'s own injected setTimer, not the global one - proven with a manually fired fake clock, no real wall-clock wait', async () => {
  const addGate = new Promise(() => {}); // add() hangs forever in this test
  const memoryPlugin = { add: async () => { await addGate; return { written: [] }; } };
  const retryQueue = queueWith(); const stateDir = tmp();
  const memory = createMemoryAdapter({ memoryPlugin, scan: flag, stateDir, retryQueue, log: () => {} });

  const clock = fakeClock();
  const registry = createLoopRegistry({ stateDir, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  registerPluginLoops({
    registry, retryQueue, memory, admitSettleWaitMs: 5_000, // distinct from the 120_000 run ceiling
    judge: { judge: async () => ({}), verdictFor: () => null }, gepa: { run: async () => ({ ok: true, proposed: [] }) },
  });

  const runPromise = registry.emit('session.condensed', { sessionId: 's', project: 'p', condensed: 'USER: hi' });
  clock.fire(120_000); // the run's own ceiling times out the hung maker
  await flush();
  clock.fire(5_000); // settledWithin's own expiry - only reachable if it uses the injected clock
  const [o] = await runPromise;
  assert.equal(o.outcome, 'failed');
  assert.ok(retryQueue.jobs.some((j) => j.kind === 'memory.admit'), 'add() never returned even after the bounded wait, so the whole admission is still re-pushed');
});
