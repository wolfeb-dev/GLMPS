import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry, CeilingError } from '../lib/loops/registry.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loops-'));
// A fake clock and timer queue: no real waiting in any test.
function fakeTimers() {
  let t = 1_000_000; const q = new Map(); let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const k = ++id; q.set(k, { fn, at: t + ms }); return k; },
    clearTimer: (k) => { q.delete(k); },
    pending: () => [...q.values()].map((x) => x.at - t).sort((a, b) => a - b),
    advance: (ms) => { t += ms; },
  };
}
const base = (over = {}) => ({
  name: 'fixture', trigger: { everyMs: 60_000 },
  maker: async () => ({ outcome: 'done', result: { n: 1 }, fresh: { builtAtCommit: 'abc' } }),
  checker: async (r) => ({ ok: r.n === 1, verifierRef: 'check:1' }),
  ceiling: { maxAttempts: 1, maxModelCalls: 3, timeoutMs: 5_000 },
  sla: { maxAgeMs: 3_600_000 },
  ...over,
});

test('a checked done run is recorded and persisted', async () => {
  const stateDir = tmp(); const ft = fakeTimers();
  const reg = createLoopRegistry({ stateDir, ...ft });
  reg.registerLoop(base());
  const r = await reg.runNow('fixture');
  assert.deepEqual(r, { outcome: 'done', reason: null, result: { n: 1 } });
  const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'loops', 'fixture.json'), 'utf8'));
  assert.equal(rec.lastOutcome, 'done');
  assert.equal(rec.consecutiveFailures, 0);
  assert.equal(rec.lastOkTs, ft.now());
  assert.deepEqual(rec.fresh, { builtAtCommit: 'abc' });
  reg.stop();
});

test('nothing-to-do skips the checker', async () => {
  let checked = 0; const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ maker: async () => ({ outcome: 'nothing-to-do' }), checker: async () => { checked++; return { ok: true }; } }));
  assert.equal((await reg.runNow('fixture')).outcome, 'nothing-to-do');
  assert.equal(checked, 0);
  reg.stop();
});

test('a maker throw, a checker rejection and a bad outcome are failures with reasons', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ name: 'a', maker: async () => { throw new Error('boom'); } }));
  reg.registerLoop(base({ name: 'b', checker: async () => ({ ok: false, reason: 'stub build' }) }));
  reg.registerLoop(base({ name: 'c', maker: async () => ({ outcome: 'deferred' }) }));
  assert.deepEqual(await reg.runNow('a'), { outcome: 'failed', reason: 'boom' });
  assert.deepEqual(await reg.runNow('b'), { outcome: 'failed', reason: 'checker:stub build' });
  assert.deepEqual(await reg.runNow('c'), { outcome: 'failed', reason: 'maker returned no valid outcome (deferred)' });
  assert.equal(reg.get('b').lastOutcome, 'failed:checker:stub build');
  reg.stop();
});

test('timeout ends the run and frees the loop', async () => {
  const ft = fakeTimers(); let fire;
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft, setTimer: (fn, ms) => { if (ms === 5_000) fire = fn; return ft.setTimer(fn, ms); } });
  reg.registerLoop(base({ maker: () => new Promise(() => {}) }));
  const p = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fire();
  assert.deepEqual(await p, { outcome: 'failed', reason: 'timeout' });
  assert.equal(reg.get('fixture').nextRunTs - ft.now(), 60_000, 'the loop reschedules using its own backoff.baseMs after the timeout');
  const p2 = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fire();
  assert.equal((await p2).reason, 'timeout', 'a second run starts after the timeout: the loop was not left running');
  reg.stop();
});

test('a hanging onVerified is bounded by the ceiling timeout, and the loop is rescheduled', async () => {
  const ft = fakeTimers(); let fire;
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft, setTimer: (fn, ms) => { if (ms === 5_000) fire = fn; return ft.setTimer(fn, ms); } });
  reg.registerLoop(base({ onVerified: () => new Promise(() => {}) }));
  const p = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fire();
  // checkerPassed:true marks any onVerified-stage
  // failure (a hang bounded by its own ceiling included) - the checker
  // already passed, only the publish/close step itself did not finish.
  assert.deepEqual(await p, { outcome: 'failed', reason: 'publish:timeout', checkerPassed: true });
  assert.equal(reg.get('fixture').nextRunTs - ft.now(), 60_000, 'the loop is rescheduled after the hung publish');
  const p2 = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fire();
  assert.equal((await p2).reason, 'publish:timeout', 'a second run starts: the lock was not left held by the hung publish');
  reg.stop();
});

test('a hanging onFailed is bounded by the same ceiling timeout', async () => {
  const ft = fakeTimers(); let fire;
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft, setTimer: (fn, ms) => { if (ms === 5_000) fire = fn; return ft.setTimer(fn, ms); } });
  reg.registerLoop(base({ maker: async () => { throw new Error('boom'); }, onFailed: () => new Promise(() => {}) }));
  const p = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fire();
  // Phase K final review minor: an onFailed failure is also an explicit
  // field (onFailedError), so a caller never has to parse the reason text.
  assert.deepEqual(await p, { outcome: 'failed', reason: 'boom; onFailed: timeout', onFailedError: 'timeout' });
  assert.equal(reg.get('fixture').nextRunTs - ft.now(), 60_000, 'the loop is rescheduled after the hung onFailed');
  reg.stop();
});

test('a hanging maker times out, and a fast-but-async onFailed does not get mistaken for a second timeout', async () => {
  const ft = fakeTimers(); const fires = [];
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft, setTimer: (fn, ms) => { if (ms === 5_000) fires.push(fn); return ft.setTimer(fn, ms); } });
  let onFailedRan = false;
  reg.registerLoop(base({
    maker: () => new Promise(() => {}),
    onFailed: async () => { await new Promise((r) => setImmediate(r)); onFailedRan = true; },
  }));
  const p = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fires[0](); // the maker's own ceiling timer fires; onFailed must get a fresh bound of its own
  const r = await p;
  assert.deepEqual(r, { outcome: 'failed', reason: 'timeout' }, 'no "; onFailed: timeout" suffix: onFailed genuinely succeeded');
  assert.equal(onFailedRan, true, 'onFailed actually ran to completion');
  reg.stop();
});

test('onFailed is bounded by its own fresh timer even when the antecedent failure was itself a timeout', async () => {
  const ft = fakeTimers(); const fires = [];
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft, setTimer: (fn, ms) => { if (ms === 5_000) fires.push(fn); return ft.setTimer(fn, ms); } });
  reg.registerLoop(base({ maker: () => new Promise(() => {}), onFailed: () => new Promise(() => {}) }));
  const p = reg.runNow('fixture');
  await new Promise((r) => setImmediate(r));
  fires[0](); // the maker's ceiling timer fires first, and is already spent
  await new Promise((r) => setImmediate(r));
  fires[1](); // onFailed's own, separate fresh timer fires next
  assert.deepEqual(await p, { outcome: 'failed', reason: 'timeout; onFailed: timeout', onFailedError: 'timeout' });
  reg.stop();
});

test('model-call ceiling fails the run', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ maker: async (ctx) => { for (let i = 0; i < 5; i++) ctx.countModelCall(); return { outcome: 'done', result: { n: 1 } }; } }));
  assert.deepEqual(await reg.runNow('fixture'), { outcome: 'failed', reason: 'ceiling:model-calls' });
  assert.ok(new CeilingError('x') instanceof Error);
  reg.stop();
});

test('model-call ceiling still fails even if the maker swallows CeilingError', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({
    maker: async (ctx) => {
      for (let i = 0; i < 5; i++) { try { ctx.countModelCall(); } catch { /* swallowed by the maker */ } }
      return { outcome: 'done', result: { n: 1 } };
    },
  }));
  assert.deepEqual(await reg.runNow('fixture'), { outcome: 'failed', reason: 'ceiling:model-calls' });
  reg.stop();
});

test('a checker that throws (not a timeout) gets its reason prefixed with checker:', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ checker: async () => { throw new Error('parse error'); } }));
  assert.deepEqual(await reg.runNow('fixture'), { outcome: 'failed', reason: 'checker:parse error' });
  reg.stop();
});

test('a checker that exceeds the model-call ceiling fails as a ceiling, not a checker error', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ checker: async (r, ctx) => { for (let i = 0; i < 5; i++) ctx.countModelCall(); return { ok: true }; } }));
  assert.deepEqual(await reg.runNow('fixture'), { outcome: 'failed', reason: 'ceiling:model-calls' });
  reg.stop();
});

// an out-of-process caller (Mem0's own internal
// extraction, GEPA's python subprocess) cannot be counted through
// ctx.countModelCall() at all - the calls happen outside this process. Their
// ceiling is documented as advisory via maxModelCalls: null, which must
// actually disable the ceiling rather than validate as 0 (a bare `null >= 0`
// is true in JS, so this needs its own explicit skip, not just permissive
// validation).
test('maxModelCalls: null disables the model-call ceiling entirely (advisory, for an out-of-process caller)', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({
    ceiling: { maxAttempts: 1, maxModelCalls: null, timeoutMs: 5_000 },
    maker: async (ctx) => { for (let i = 0; i < 50; i++) ctx.countModelCall(); return { outcome: 'done', result: { n: 1 } }; },
  }));
  assert.deepEqual(await reg.runNow('fixture'), { outcome: 'done', reason: null, result: { n: 1 } });
  reg.stop();
});

test('maxModelCalls: null also skips the checker\'s own ceiling and the maker.modelCalls self-report ceiling', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({
    ceiling: { maxAttempts: 1, maxModelCalls: null, timeoutMs: 5_000 },
    maker: async () => ({ outcome: 'done', result: { n: 1 }, modelCalls: 999 }),
    checker: async (r, ctx) => { for (let i = 0; i < 50; i++) ctx.countModelCall(); return { ok: true }; },
  }));
  assert.equal((await reg.runNow('fixture')).outcome, 'done');
  reg.stop();
});

// plugin-retry dispatches a due judge.session job through
// session-judge's own maker/checker (a real check, not just re-calling the
// judge), but the job it drains is already durably queued - session-judge's
// own onFailed would otherwise push a SECOND, duplicate retry job on top of
// the one plugin-retry is already managing. runNow's third argument lets a
// caller suppress onFailed for that one dispatch, without touching the
// loop's own onEvent-triggered behavior.
test('runNow(name, payload, { suppressOnFailed: true }) skips onFailed for that one call only', async () => {
  const queued = []; const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ maker: async () => { throw new Error('boom'); }, onFailed: async (ctx, reason) => queued.push(reason) }));
  const suppressed = await reg.runNow('fixture', null, { suppressOnFailed: true });
  assert.equal(suppressed.outcome, 'failed');
  assert.deepEqual(queued, [], 'onFailed did not run for the suppressed call');
  const normal = await reg.runNow('fixture');
  assert.equal(normal.outcome, 'failed');
  assert.deepEqual(queued, ['boom'], 'onFailed still runs for an ordinary call');
  reg.stop();
});

test('maxAttempts retries a throwing maker within one run', async () => {
  let calls = 0; const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ ceiling: { maxAttempts: 3, maxModelCalls: 1, timeoutMs: 5_000 }, maker: async () => { if (++calls < 3) throw new Error('flaky'); return { outcome: 'done', result: { n: 1 } }; } }));
  assert.equal((await reg.runNow('fixture')).outcome, 'done');
  assert.equal(calls, 3);
  reg.stop();
});

test('failures back off exponentially up to the cap, and a success resets the delay', async () => {
  const ft = fakeTimers(); let fail = true;
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft });
  reg.registerLoop(base({ backoff: { baseMs: 60_000, maxMs: 200_000 }, maker: async () => { if (fail) throw new Error('x'); return { outcome: 'done', result: { n: 1 } }; } }));
  await reg.runNow('fixture'); assert.equal(reg.get('fixture').nextRunTs - ft.now(), 60_000);
  await reg.runNow('fixture'); assert.equal(reg.get('fixture').nextRunTs - ft.now(), 120_000);
  await reg.runNow('fixture'); assert.equal(reg.get('fixture').nextRunTs - ft.now(), 200_000);
  fail = false;
  await reg.runNow('fixture'); assert.equal(reg.get('fixture').nextRunTs - ft.now(), 60_000);
  reg.stop();
});

test('streak fires once per streak', async () => {
  const streaks = []; let fail = true;
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers(), onStreak: (s) => streaks.push(s) });
  reg.registerLoop(base({ maker: async () => { if (fail) throw new Error('down'); return { outcome: 'done', result: { n: 1 } }; } }));
  for (let i = 0; i < 6; i++) await reg.runNow('fixture');
  assert.equal(streaks.length, 1);
  assert.equal(streaks[0].record.consecutiveFailures, 3);
  assert.equal(streaks[0].record.recentFailures.length, 3);
  fail = false; await reg.runNow('fixture'); fail = true;
  for (let i = 0; i < 3; i++) await reg.runNow('fixture');
  assert.equal(streaks.length, 2, 'a new streak after a success fires again');
  reg.stop();
});

test('onVerified runs only after a passing check, and its failure fails the run as publish', async () => {
  const published = []; const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ name: 'p', onVerified: async (r, v) => published.push([r.n, v.verifierRef]) }));
  reg.registerLoop(base({ name: 'q', checker: async () => ({ ok: false, reason: 'stub' }), onVerified: async () => published.push('never') }));
  reg.registerLoop(base({ name: 'r', onVerified: async () => { throw new Error('rename failed'); } }));
  assert.equal((await reg.runNow('p')).outcome, 'done');
  assert.equal((await reg.runNow('q')).outcome, 'failed');
  assert.deepEqual(published, [[1, 'check:1']]);
  // an explicit checkerPassed:true, not a caller
  // parsing the "publish:" prefix off `reason` itself.
  assert.deepEqual(await reg.runNow('r'), { outcome: 'failed', reason: 'publish:rename failed', checkerPassed: true });
  reg.stop();
});

test('onFailed runs on failure and its own error is kept in the reason, never swallowed', async () => {
  const queued = []; const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ name: 'q', maker: async () => { throw new Error('boom'); }, onFailed: async (ctx, reason) => queued.push([ctx.payload, reason]) }));
  reg.registerLoop(base({ name: 'r', maker: async () => { throw new Error('boom'); }, onFailed: async () => { throw new Error('queue full'); } }));
  await reg.runNow('q', { job: 1 });
  assert.throws(() => reg.report('q', { outcome: 'done' }), /internal/);
  assert.deepEqual(queued, [[{ job: 1 }, 'boom']]);
  assert.equal((await reg.runNow('r')).reason, 'boom; onFailed: queue full');
  reg.stop();
});

test('validation refuses a loop that checks itself or lacks a ceiling or sla', () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  const same = async () => ({ outcome: 'done' });
  assert.throws(() => reg.registerLoop(base({ maker: same, checker: same })), /checker must differ from maker/);
  assert.throws(() => reg.registerLoop(base({ ceiling: undefined })), /ceiling/);
  assert.throws(() => reg.registerLoop(base({ sla: undefined })), /sla/);
  assert.throws(() => reg.registerLoop(base({ name: 'Bad Name' })), /kebab-case/);
  reg.registerLoop(base());
  assert.throws(() => reg.registerLoop(base()), /already registered/);
  reg.stop();
});

test('state survives a restart: a loaded streak keeps counting', async () => {
  const stateDir = tmp(); const ft = fakeTimers();
  const a = createLoopRegistry({ stateDir, ...ft });
  a.registerLoop(base({ maker: async () => { throw new Error('x'); } }));
  await a.runNow('fixture'); await a.runNow('fixture'); a.stop();
  const streaks = [];
  const b = createLoopRegistry({ stateDir, ...ft, onStreak: (s) => streaks.push(s) });
  b.registerLoop(base({ maker: async () => { throw new Error('x'); } }));
  await b.runNow('fixture');
  assert.equal(streaks.length, 1);
  b.stop();
});

test('onEvent loops run on emit with the payload; external loops only accept reports', async () => {
  const seen = []; const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  reg.registerLoop(base({ name: 'ev', trigger: { onEvent: 'session.finalized' }, maker: async (ctx) => { seen.push(ctx.payload); return { outcome: 'nothing-to-do' }; } }));
  reg.registerLoop(base({ name: 'ext', trigger: { external: 'Windows Scheduled Task' }, maker: async () => ({ outcome: 'done' }) }));
  await reg.emit('session.finalized', { sessionId: 's1' });
  assert.deepEqual(seen, [{ sessionId: 's1' }]);
  await assert.rejects(reg.runNow('ext'), /external/);
  reg.report('ext', { outcome: 'failed', reason: 'exit 1' });
  assert.equal(reg.get('ext').consecutiveFailures, 1);
  reg.stop();
});

test('everyMs loops schedule the boot delay, then the interval; stop clears every timer', async () => {
  const ft = fakeTimers(); const reg = createLoopRegistry({ stateDir: tmp(), ...ft });
  reg.registerLoop(base({ bootDelayMs: 1_000 }));
  assert.deepEqual(ft.pending(), [1_000]);
  reg.stop();
  assert.deepEqual(ft.pending(), []);
});

// glmps-2-0-runtime-84: a restart resumes the persisted cadence. Deploys every
// ~30 min used to re-arm a 30-min bootDelayMs each boot, so the loop never ran.
test('a re-registered everyMs loop resumes from its persisted lastRunTs, not a fresh bootDelayMs', async () => {
  const stateDir = tmp(); const ft = fakeTimers(); const every = 30 * 60_000;
  const a = createLoopRegistry({ stateDir, ...ft });
  a.registerLoop(base({ trigger: { everyMs: every }, bootDelayMs: every }));
  await a.runNow('fixture'); const lastRunTs = ft.now(); a.stop();
  ft.advance(29 * 60_000);
  const b = createLoopRegistry({ stateDir, ...ft });
  b.registerLoop(base({ trigger: { everyMs: every }, bootDelayMs: every }));
  assert.deepEqual(ft.pending(), [60_000]);
  assert.equal(b.get('fixture').nextRunTs, lastRunTs + every);
  b.stop();
});

test('an overdue loop waits only the short boot floor; a never-run loop keeps bootDelayMs; a short bootDelayMs is never lengthened', async () => {
  const stateDir = tmp(); const ft = fakeTimers(); const every = 30 * 60_000;
  const a = createLoopRegistry({ stateDir, ...ft });
  a.registerLoop(base({ trigger: { everyMs: every }, bootDelayMs: every }));
  a.registerLoop(base({ name: 'quick', trigger: { everyMs: every }, bootDelayMs: 1_000 }));
  await a.runNow('fixture'); await a.runNow('quick'); a.stop();
  ft.advance(3 * every);
  const b = createLoopRegistry({ stateDir, ...ft });
  b.registerLoop(base({ trigger: { everyMs: every }, bootDelayMs: every }));
  assert.equal(b.get('fixture').nextRunTs - ft.now(), 30_000, 'overdue: the boot floor, not the full bootDelayMs');
  b.registerLoop(base({ name: 'quick', trigger: { everyMs: every }, bootDelayMs: 1_000 }));
  assert.equal(b.get('quick').nextRunTs - ft.now(), 1_000, 'a bootDelayMs below the floor is kept as is');
  b.registerLoop(base({ name: 'fresh', trigger: { everyMs: every }, bootDelayMs: every }));
  assert.equal(b.get('fresh').nextRunTs - ft.now(), every, 'no prior run: bootDelayMs unchanged');
  b.stop();
});

// glmps-2-0-runtime-86: every overdue loop used to wait the same 30 s floor, so
// a deploy fired them all in one 4 s busy run at boot + 30 s.
test('first runs at boot are staggered apart; a short bootDelayMs is still kept as is', async () => {
  const stateDir = tmp(); const ft = fakeTimers(); const every = 5 * 60_000;
  const names = ['l-a', 'l-b', 'l-c'];
  const a = createLoopRegistry({ stateDir, ...ft });
  for (const name of names) a.registerLoop(base({ name, trigger: { everyMs: every } }));
  for (const name of names) await a.runNow(name);
  a.stop();
  ft.advance(3 * every);
  const b = createLoopRegistry({ stateDir, ...ft });
  for (const name of names) b.registerLoop(base({ name, trigger: { everyMs: every } }));
  b.registerLoop(base({ name: 'never-run', trigger: { everyMs: every } }));
  b.registerLoop(base({ name: 'quick', trigger: { everyMs: every }, bootDelayMs: 1_000 }));
  const delay = (n) => b.get(n).nextRunTs - ft.now();
  assert.deepEqual([...names, 'never-run'].map(delay), [30_000, 32_000, 34_000, 36_000]);
  assert.equal(delay('quick'), 1_000);
  b.stop();
});

test('a later first run is moved only when it would land within the stagger of another', async () => {
  const ft = fakeTimers(); const reg = createLoopRegistry({ stateDir: tmp(), ...ft, bootStaggerMs: 5_000 });
  reg.registerLoop(base({ name: 'x', bootDelayMs: 60_000 }));
  reg.registerLoop(base({ name: 'y', bootDelayMs: 62_000 }));
  reg.registerLoop(base({ name: 'z', bootDelayMs: 120_000 }));
  assert.deepEqual(['x', 'y', 'z'].map((n) => reg.get(n).nextRunTs - ft.now()), [60_000, 65_000, 120_000]);
  reg.stop();
});

// glmps-2-0-150: the stagger read the clock twice, so a millisecond tick between
// the reads scheduled the first run at 29999 ms and turned the suite red.
test('the first-run delay is exact on a clock that ticks between reads', () => {
  let t = 1_000_000; const pending = [];
  const reg = createLoopRegistry({ stateDir: tmp(), now: () => t++, setTimer: (fn, ms) => { pending.push(ms); return 1; }, clearTimer: () => {} });
  reg.registerLoop(base());
  assert.deepEqual(pending, [30_000]);
  reg.stop();
});

test('onRun sees every recorded run; snapshot is plain data with ageS', async () => {
  const runs = []; const ft = fakeTimers();
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft, onRun: (r) => runs.push(r) });
  reg.registerLoop(base());
  await reg.runNow('fixture'); ft.advance(10_000);
  assert.deepEqual(runs, [{ name: 'fixture', outcome: 'done', reason: null, consecutiveFailures: 0 }]);
  const snap = reg.snapshot();
  assert.equal(snap.fixture.ageS, 10);
  assert.equal(snap.fixture.lastOutcome, 'done');
  reg.stop();
});

test('a failing state write does not stop the loop being rescheduled', async () => {
  const stateDir = tmp(); const ft = fakeTimers(); const logs = [];
  const reg = createLoopRegistry({ stateDir, ...ft, log: (m) => logs.push(m) });
  reg.registerLoop(base());
  // Break the loops dir after registration's own write succeeds: every save() from here on fails.
  const loopsDir = path.join(stateDir, 'loops');
  fs.rmSync(loopsDir, { recursive: true, force: true });
  fs.writeFileSync(loopsDir, 'blocked');
  const r = await reg.runNow('fixture');
  assert.equal(r.outcome, 'done');
  assert.equal(reg.get('fixture').lastOutcome, 'done', 'the in-memory record still updates despite the failed write');
  assert.deepEqual(ft.pending(), [60_000], 'the loop is still rescheduled for its next interval despite the failed write');
  assert.ok(logs.some((m) => /state save failed/.test(m)), 'the failure is reported through log');
  reg.stop();
});

test('emit uses allSettled: one loop\'s onOk failure does not reject the whole emit call', async () => {
  const reg = createLoopRegistry({
    stateDir: tmp(), ...fakeTimers(),
    obligations: { onOk: () => { throw new Error('sink down'); } },
  });
  reg.registerLoop(base({ name: 'ev1', trigger: { onEvent: 'k' } }));
  reg.registerLoop(base({ name: 'ev2', trigger: { onEvent: 'k' } }));
  await assert.doesNotReject(() => reg.emit('k', null));
  assert.equal(reg.get('ev1').lastOutcome, 'done');
  assert.equal(reg.get('ev2').lastOutcome, 'done');
  reg.stop();
});

// Task 1 minor (deferred, folded into Task 11): obligations.onOk was called
// unguarded inside record() - a throw there escaped past the persisted state
// AND past onRun (the dashboard broadcast), for any direct (non-emit) caller
// such as runNow() or the manual /api/loops/:name/run route. allSettled
// (above) only cushions emit()'s own callers, not these.
test('a throwing obligations.onOk does not break a direct run, lose the persisted state, or skip onRun', async () => {
  const stateDir = tmp(); const ft = fakeTimers(); const logs = []; const runs = [];
  const reg = createLoopRegistry({
    stateDir, ...ft, log: (m) => logs.push(m), onRun: (r) => runs.push(r),
    obligations: { onOk: () => { throw new Error('sink down'); } },
  });
  reg.registerLoop(base());
  const r = await reg.runNow('fixture');
  assert.equal(r.outcome, 'done');
  const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'loops', 'fixture.json'), 'utf8'));
  assert.equal(rec.lastOutcome, 'done', 'the persisted record still reflects the run despite the throwing adapter');
  assert.deepEqual(runs.map((x) => x.outcome), ['done'], 'onRun still fires despite the throwing adapter');
  assert.ok(logs.some((m) => /obligations\.onOk failed/.test(m)), 'the failure is reported through log, not silence');
  reg.stop();
});

// close() needs to know whether a loop is
// still executing before it closes a resource (the obligations sqlite
// handle) that run might still touch - isRunning(name) is the primitive
// that check is built on.
test('isRunning reflects a loop\'s in-flight execution, true only while its maker/checker are running', async () => {
  const stateDir = tmp(); const ft = fakeTimers();
  const reg = createLoopRegistry({ stateDir, ...ft });
  let release;
  const gate = new Promise((r) => { release = r; });
  reg.registerLoop(base({ maker: async () => { await gate; return { outcome: 'done', result: { n: 1 } }; } }));
  assert.equal(reg.isRunning('fixture'), false, 'not running before the first run starts');
  const p = reg.runNow('fixture');
  assert.equal(reg.isRunning('fixture'), true, 'running while the maker is still awaiting its own gate');
  release();
  await p;
  assert.equal(reg.isRunning('fixture'), false, 'no longer running once the run has settled');
  reg.stop();
});

test('isRunning is false for an unknown loop name, never a throw', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  assert.equal(reg.isRunning('no-such-loop'), false);
  reg.stop();
});

// close() had no way to abort an in-flight run
// (only stop() cancels FUTURE scheduled runs) -- the wiki loop's build
// child (and its claude -p grandchild) outlived shutdown, and a late
// onVerified could hit an already-closed store. abort(name) aborts the
// SAME ctx.signal a maker already receives, so a caller like
// spawnWikiBuild (which already kills its child tree on abort) gets torn
// down on shutdown without any loop-specific wiring in the registry.
test('abort(name) aborts the in-flight run\'s own ctx.signal; the run settles failed and isRunning clears', async () => {
  const stateDir = tmp(); const ft = fakeTimers();
  const reg = createLoopRegistry({ stateDir, ...ft });
  let sawAbort = false;
  let sawReason = null;
  let release;
  const gate = new Promise((r) => { release = r; });
  reg.registerLoop(base({
    maker: async (ctx) => {
      ctx.signal.addEventListener('abort', () => { sawAbort = true; sawReason = ctx.signal.reason; release(); }, { once: true });
      await gate;
      throw new Error('maker aborted mid-run');
    },
  }));
  const p = reg.runNow('fixture');
  assert.equal(reg.isRunning('fixture'), true);
  assert.equal(reg.abort('fixture', 'server shutting down'), true, 'abort reports it found something in flight to abort');
  const r = await p;
  assert.equal(sawAbort, true, 'the maker\'s own ctx.signal observed the abort');
  assert.match(String(sawReason), /server shutting down/);
  assert.equal(r.outcome, 'failed');
  assert.equal(reg.isRunning('fixture'), false, 'the run is no longer tracked as in flight once it settles');
  reg.stop();
});

test('abort(name) is false for an unknown loop or one with nothing in flight, never a throw', async () => {
  const reg = createLoopRegistry({ stateDir: tmp(), ...fakeTimers() });
  assert.equal(reg.abort('no-such-loop'), false);
  reg.registerLoop(base());
  assert.equal(reg.abort('fixture'), false, 'not running yet');
  await reg.runNow('fixture');
  assert.equal(reg.abort('fixture'), false, 'already settled: nothing left in flight to abort');
  reg.stop();
});

// close() calls stop() then abort('wiki',
// 'server shutting down') -- the in-flight run then settles 'failed' and
// record() increments consecutiveFailures same as any other failure. Three
// restarts during a build (a common deploy pattern) would climb
// consecutiveFailures to STREAK_AT and fire a false "loop failing" alert
// for a build that never got a real chance to succeed or fail on its own
// merits. A run aborted by abort() AFTER stop() must leave the persisted
// record untouched entirely (never a failure, never a false success reset
// either) -- distinct from the existing "abort() alone, no stop()" test
// above, which still records failed.
test('abort(name) called AFTER stop() records nothing: never a failure, no false streak across repeated shutdowns (M1)', async () => {
  const streaks = [];
  const stateDir = tmp(); // shared across 3 fresh registries below, same as server.js reusing one state dir across restarts
  for (let i = 0; i < 3; i++) {
    const ft = fakeTimers();
    const reg = createLoopRegistry({ stateDir, ...ft, onStreak: (s) => streaks.push(s) });
    reg.registerLoop(base({
      maker: async (ctx) => new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('build killed: server shutting down')), { once: true });
      }),
    }));
    const p = reg.runNow('fixture');
    await new Promise((r) => setImmediate(r)); // let the maker start and register its own abort listener
    reg.stop();
    assert.equal(reg.abort('fixture', 'server shutting down'), true);
    const r = await p;
    assert.deepEqual(r, { outcome: 'nothing-to-do', reason: 'aborted at shutdown' });
    assert.equal(reg.get('fixture').consecutiveFailures, 0, `restart ${i + 1}: an aborted-at-shutdown run never counts as a failure`);
  }
  assert.equal(streaks.length, 0, 'no false "loop failing" streak alert from three repeated shutdown aborts');
});

// glmps-2-0-65: drain() waits for every in-flight run of any loop, through its
// record() and obligations onOk, so a caller can close what those touch.
test('drain resolves only after every in-flight run has recorded and called onOk', async () => {
  const stateDir = tmp(); const ft = fakeTimers();
  const okCalls = [];
  const reg = createLoopRegistry({ stateDir, ...ft, obligations: { onOk: (name) => okCalls.push(name) } });
  let releaseA; let releaseB;
  const gateA = new Promise((r) => { releaseA = r; });
  const gateB = new Promise((r) => { releaseB = r; });
  reg.registerLoop(base({ name: 'loop-a', maker: async () => { await gateA; return { outcome: 'nothing-to-do' }; } }));
  reg.registerLoop(base({ name: 'loop-b', maker: async () => { await gateB; return { outcome: 'done', result: { n: 1 } }; } }));
  await reg.drain(); // nothing in flight: resolves straight away
  const runs = [reg.runNow('loop-a'), reg.runNow('loop-b')];
  reg.stop();
  let drained = false;
  const d = reg.drain().then(() => { drained = true; });
  releaseA();
  await runs[0];
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, false, 'loop-b is still in flight');
  releaseB();
  await d;
  assert.deepEqual(okCalls.sort(), ['loop-a', 'loop-b']);
  assert.equal(drained, true);
});

// glmps-2-0-runtime-10 (triage glmps-189): two failures used to double the
// delay to 30 min and push the next attempt past lastOkTs + maxAgeMs, so the
// freshness obligation expired before the loop could even try again.
test('an everyMs loop with an SLA never schedules a failure retry past lastOkTs + maxAgeMs', async () => {
  const ft = fakeTimers(); let fail = false;
  const MIN = 60_000;
  const reg = createLoopRegistry({ stateDir: tmp(), ...ft });
  reg.registerLoop(base({ trigger: { everyMs: 15 * MIN }, sla: { maxAgeMs: 60 * MIN }, ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5 * MIN },
    maker: async () => { if (fail) throw new Error('x'); return { outcome: 'done', result: { n: 1 } }; } }));
  await reg.runNow('fixture');
  const lastOkTs = reg.get('fixture').lastOkTs;
  const deadline = lastOkTs + 60 * MIN;
  fail = true;
  ft.advance(20 * MIN); await reg.runNow('fixture');
  assert.equal(reg.get('fixture').nextRunTs, ft.now() + 15 * MIN, 'the first failure keeps its plain backoff, already inside the deadline');
  ft.advance(12 * MIN); await reg.runNow('fixture');
  const next = reg.get('fixture').nextRunTs;
  assert.ok(next + 5 * MIN <= deadline, `the retry plus one ceiling.timeoutMs fits before the deadline (next ${next - lastOkTs} ms after ok, deadline ${deadline - lastOkTs})`);
  assert.equal(next, deadline - 5 * MIN);
  // Once the deadline is already lost, the plain backoff resumes rather than a tight retry loop.
  ft.advance(next - ft.now()); await reg.runNow('fixture');
  assert.equal(reg.get('fixture').nextRunTs - ft.now(), 60 * MIN);
  reg.stop();
});
