import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor, backoffMs, SUPERVISOR_DEFAULTS } from '../src/lib/supervisor.js';

const UP = { ok: true, body: { status: 'up', open_obligations: 2, last_event_ts: 1 } };
const DEGRADED = { ok: true, body: { status: 'degraded', open_obligations: 0, last_event_ts: null } };
const DOWN = { ok: false, reason: 'unreachable' };
const STARTED = { ok: true, code: 0, reason: 'start-requested' };
const DENIED = { ok: false, code: 5, reason: 'access-denied' };
const MISSING = { ok: false, code: 1060, reason: 'not-installed' };
const TIMED_OUT_START = { ok: false, code: null, reason: 'sc-timeout' };

// A scripted harness: health() and start() return the head of their queue
// (the last entry repeats); timers are captured and fired by hand. clearTimer
// really marks the handle cleared (not a no-op), so fire() on a cleared
// handle is a hard error: a real proof that stop()/settle() cleared it,
// not just that a `stopped` flag happened to gate the next tick.
function harness({ health = [UP], starts = [STARTED], canStart = true, onChange, log, onGiveUp, alive = false } = {}) {
  let t = 1_000_000;
  const timers = [];
  const giveUps = [];
  const logs = [];
  const calls = { health: 0, start: 0 };
  const next = (q) => (q.length > 1 ? q.shift() : q[0]);
  const sup = createSupervisor({
    checkHealth: async () => { calls.health++; const h = next(health); if (h instanceof Error) throw h; return h; },
    startService: async () => { calls.start++; return next(starts); },
    isKernelAlive: async () => alive,
    canStart, now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.cleared = true; },
    onChange: onChange || (() => {}),
    onGiveUp: onGiveUp || ((s) => giveUps.push(s)),
    log: log || ((...a) => logs.push(a)),
  });
  const fire = async () => {
    const h = timers.at(-1);
    if (h.cleared) throw new Error('fire(): the last-armed timer was already cleared');
    t += h.ms;
    await h.fn();
  };
  return { sup, timers, giveUps, logs, calls, fire, setHealth: (q) => { health.splice(0, health.length, ...q); } };
}

test('backoff doubles from 2 s and caps at 60 s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, SUPERVISOR_DEFAULTS)), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('kernel up at launch: no start attempt, next poll in 10 s', async () => {
  const h = harness({ health: [UP] });
  await h.sup.start();
  assert.equal(h.sup.snapshot().state, 'up');
  assert.equal(h.sup.snapshot().lastOutcome, 'nothing-to-do');
  assert.equal(h.calls.start, 0);
  assert.equal(h.timers.at(-1).ms, 10000);
});

test('degraded is reported as degraded', async () => {
  const h = harness({ health: [DEGRADED] });
  await h.sup.start();
  assert.equal(h.sup.snapshot().state, 'degraded');
});

test('kernel down: five starts with backoff, then offline and exactly one give-up per streak', async () => {
  const h = harness({ health: [DOWN], starts: [STARTED] });
  await h.sup.start();
  for (let i = 0; i < 6; i++) await h.fire();
  assert.deepEqual(h.timers.map((x) => x.ms), [2000, 4000, 8000, 16000, 32000, 10000, 10000]);
  assert.equal(h.calls.start, 5);
  const s = h.sup.snapshot();
  assert.equal(s.state, 'offline');
  assert.equal(s.reason, 'gave-up:start-requested');
  assert.equal(s.lastOutcome, 'failed:unreachable');
  assert.equal(h.giveUps.length, 1);
});

test('the checker is not the maker: sc.exe saying started never makes the state up', async () => {
  const h = harness({ health: [DOWN], starts: [STARTED] });
  await h.sup.start();
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'starting');
  assert.equal(h.sup.snapshot().attempts, 2);
});

test('proof it closes: a good health check clears the streak, and the next streak notifies again', async () => {
  const h = harness({ health: [DOWN], starts: [STARTED] });
  await h.sup.start();
  for (let i = 0; i < 5; i++) await h.fire();
  assert.equal(h.giveUps.length, 1);
  h.setHealth([UP]);
  await h.fire();
  let s = h.sup.snapshot();
  assert.equal(s.state, 'up');
  assert.equal(s.attempts, 0);
  assert.equal(s.streakStartTs, null);
  assert.equal(s.lastOutcome, 'done');
  h.setHealth([DOWN]);
  for (let i = 0; i < 10; i++) await h.fire(); // four suspect probes, then the five starts and the give-up
  s = h.sup.snapshot();
  assert.equal(s.state, 'offline');
  assert.equal(h.giveUps.length, 2);
  assert.equal(h.calls.start, 10);
});

test('access denied is refused at once: one attempt, one give-up, then health polls only', async () => {
  const h = harness({ health: [DOWN], starts: [DENIED] });
  await h.sup.start();
  for (let i = 0; i < 3; i++) await h.fire();
  const s = h.sup.snapshot();
  assert.equal(s.state, 'refused');
  assert.equal(s.reason, 'access-denied');
  assert.equal(h.calls.start, 1);
  assert.equal(h.giveUps.length, 1);
  assert.equal(h.timers.at(-1).ms, 10000);
  assert.ok(h.calls.health >= 4);
});

test('a service that is not installed is refused, and the shell never installs it', async () => {
  const h = harness({ health: [DOWN], starts: [MISSING] });
  await h.sup.start();
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'refused');
  assert.equal(h.sup.snapshot().reason, 'not-installed');
  assert.equal(h.calls.start, 1);
});

test('a refused service that comes up anyway (installed by hand) goes straight to up', async () => {
  const h = harness({ health: [DOWN], starts: [MISSING] });
  await h.sup.start();
  h.setHealth([UP]);
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'up');
});

test('retryNow after giving up resets the attempt budget', async () => {
  const h = harness({ health: [DOWN], starts: [STARTED] });
  await h.sup.start();
  for (let i = 0; i < 5; i++) await h.fire();
  assert.equal(h.calls.start, 5);
  await h.sup.retryNow();
  assert.equal(h.calls.start, 6);
  assert.equal(h.sup.snapshot().state, 'starting');
  assert.equal(h.sup.snapshot().gaveUpNotified, false);
});

test('a remote kernel is never started from here', async () => {
  const h = harness({ health: [DOWN], canStart: false });
  await h.sup.start();
  await h.fire();
  assert.equal(h.calls.start, 0);
  assert.equal(h.sup.snapshot().state, 'offline');
  assert.equal(h.sup.snapshot().reason, 'remote-kernel:unreachable');
});

test('a remote kernel that stays down still gets exactly one give-up per down streak', async () => {
  const h = harness({ health: [DOWN], canStart: false });
  await h.sup.start();
  await h.fire();
  await h.fire();
  assert.equal(h.giveUps.length, 1);
  assert.equal(h.calls.start, 0);
  h.setHealth([UP]);
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'up');
  h.setHealth([DOWN]);
  for (let i = 0; i < 5; i++) await h.fire();
  assert.equal(h.giveUps.length, 2);
});

test('a throwing health check is shown and logged, not swallowed', async () => {
  const h = harness({ health: [new Error('boom')] });
  await h.sup.start();
  assert.equal(h.sup.snapshot().state, 'offline');
  assert.equal(h.sup.snapshot().reason, 'supervisor-error:boom');
  assert.equal(h.logs[0][0], 'error');
  assert.equal(h.timers.at(-1).ms, 10000);
});

test('a throwing health check still starts a down streak, so a later recovery reports done, not nothing-to-do', async () => {
  const h = harness({ health: [new Error('boom'), UP] });
  await h.sup.start();
  assert.equal(h.sup.snapshot().state, 'offline');
  assert.notEqual(h.sup.snapshot().streakStartTs, null);
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'up');
  assert.equal(h.sup.snapshot().lastOutcome, 'done');
});

test('sc.exe timing out is not a refusal: it backs off and retries like any failed start, then gives up', async () => {
  const h = harness({ health: [DOWN], starts: [TIMED_OUT_START] });
  await h.sup.start();
  for (let i = 0; i < 5; i++) await h.fire();
  assert.deepEqual(h.timers.map((x) => x.ms), [2000, 4000, 8000, 16000, 32000, 10000]);
  assert.equal(h.calls.start, 5);
  assert.equal(h.sup.snapshot().state, 'offline');
  assert.equal(h.sup.snapshot().reason, 'gave-up:sc-timeout');
});

test('retryNow from refused clears the refusal and tries again', async () => {
  const h = harness({ health: [DOWN], starts: [DENIED, STARTED] });
  await h.sup.start();
  assert.equal(h.sup.snapshot().state, 'refused');
  assert.equal(h.calls.start, 1);
  await h.sup.retryNow();
  assert.equal(h.calls.start, 2);
  assert.equal(h.sup.snapshot().state, 'starting');
  assert.equal(h.sup.snapshot().gaveUpNotified, false);
});

test('retryNow after an sc-timeout give-up resets the backoff back to 2 s, not a continued climb', async () => {
  const h = harness({ health: [DOWN], starts: [TIMED_OUT_START] });
  await h.sup.start();
  for (let i = 0; i < 5; i++) await h.fire();
  assert.equal(h.sup.snapshot().state, 'offline');
  await h.sup.retryNow();
  assert.equal(h.calls.start, 6);
  assert.equal(h.timers.at(-1).ms, 2000);
});

test('a throwing onChange does not kill the loop: the timer still arms and ticking continues', async () => {
  const h = harness({ health: [DOWN], starts: [STARTED], onChange: () => { throw new Error('Object has been destroyed'); } });
  await h.sup.start();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers.at(-1).cleared, false);
  await h.fire();
  assert.equal(h.timers.length, 2);
  assert.equal(h.calls.start, 2);
});

test('a log that throws only on the sc.exe start line does not bypass the 5-attempt ceiling', async () => {
  const h = harness({ health: [DOWN], starts: [STARTED], log: (lvl, msg) => { if (msg === 'sc.exe start') throw new Error('EBUSY shell.log'); } });
  await h.sup.start();
  for (let i = 0; i < 6; i++) await h.fire();
  assert.equal(h.calls.start, 5);
  assert.equal(h.sup.snapshot().state, 'offline');
  assert.match(h.sup.snapshot().reason, /^gave-up:/);
});

test('retryNow while a tick is running queues exactly one immediate follow-up tick, not a concurrent one', async () => {
  // Mirrors the coordinator's probe pattern: retryNow() is awaited BEFORE the
  // gate that the in-flight tick itself is blocked on is released. If
  // retryNow() ever depended on the queued follow-up finishing, this would
  // deadlock (the follow-up cannot start until the gate opens, and the gate
  // does not open until this very await returns).
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let secondCheckStarted;
  const secondCheckRunning = new Promise((r) => { secondCheckStarted = r; });
  let checkCalls = 0;
  let concurrentCheckSeen = false;
  let inFlight = false;
  const startCalls = { n: 0 };
  const sup = createSupervisor({
    checkHealth: async () => {
      checkCalls++;
      if (checkCalls === 1) {
        if (inFlight) concurrentCheckSeen = true;
        inFlight = true;
        await gate;
        inFlight = false;
      } else {
        if (inFlight) concurrentCheckSeen = true;
        secondCheckStarted();
      }
      return DOWN;
    },
    startService: async () => { startCalls.n++; return STARTED; },
    now: () => 0, setTimer: () => ({ cleared: false }), clearTimer: () => {},
    onChange: () => {}, onGiveUp: () => {}, log: () => {},
  });
  const p = sup.start();
  const r1 = sup.retryNow();
  const r2 = sup.retryNow();
  releaseGate();
  await Promise.all([p, r1, r2]);
  await secondCheckRunning; // the queued follow-up tick has started its own check
  await new Promise((r) => setImmediate(r)); // let it finish (startService + settle)
  assert.equal(concurrentCheckSeen, false);
  assert.equal(checkCalls, 2);
  assert.equal(startCalls.n, 2);
  // retryNow's attempt-budget reset applies when the queued follow-up
  // actually runs, so the follow-up starts a fresh
  // cycle at attempt 1, not a continuation to attempt 2.
  assert.equal(sup.snapshot().attempts, 1);
});

test('retryNow while a refusal is still resolving does not corrupt it: the refusal lands untouched, then the queued retry gets a genuinely fresh attempt', async () => {
  // Mirrors the coordinator's refused-probe.mjs exactly: the operator clicks
  // Retry while sc.exe is still running (about to report access-denied). The
  // reset must not land on the state `s` the in-flight tick is still going to
  // settle with: if it resets attempts/state at click
  // time, the in-flight tick's own settle() overwrites state back to
  // 'refused' with the stale (reset) attempts count, and the queued
  // follow-up then sees state 'refused' and only polls health, so the
  // operator's retry never actually retries (probe symptom: starts stays 1).
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  let starts = 0;
  let giveUps = 0;
  const sup = createSupervisor({
    checkHealth: async () => DOWN,
    startService: async () => {
      starts++;
      if (starts === 1) { await gate; return DENIED; }
      return STARTED;
    },
    now: () => 0, setTimer: () => ({}), clearTimer: () => {},
    onGiveUp: () => { giveUps++; }, onChange: () => {}, log: () => {},
  });
  const p = sup.start();
  await new Promise((r) => setImmediate(r));
  await sup.retryNow(); // operator clicks Retry while sc.exe is still running
  releaseGate();
  await p;
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(starts, 2);
  assert.equal(sup.snapshot().state, 'starting');
  assert.equal(giveUps, 1);
});

test('a queued follow-up tick that itself rejects is reported to stderr, not left an unhandled rejection', async () => {
  // Forces the queued follow-up tick B (spawned from tick A's finally) to
  // itself reject from its own finally, by having a second retryNow() land
  // while B is running so B's own applyRetryReset() runs the failing
  // clearTimer. That rejection is exactly what A's `tick().catch(...)` must
  // catch and report.
  const errors = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  let clearCalls = 0;
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  let releaseB;
  const gateB = new Promise((r) => { releaseB = r; });
  let checkCalls = 0;
  try {
    const sup = createSupervisor({
      checkHealth: async () => {
        checkCalls++;
        if (checkCalls === 1) await gateA;
        else if (checkCalls === 2) await gateB;
        return DOWN;
      },
      startService: async () => STARTED,
      now: () => 0, setTimer: () => ({}),
      clearTimer: () => { clearCalls++; if (clearCalls === 4) throw new Error('clearTimer boom'); },
      onChange: () => {}, onGiveUp: () => {}, log: () => {},
    });
    const p = sup.start(); // tick A: blocked on gateA
    await sup.retryNow(); // A is running -> queues follow-up B for after A
    releaseA();
    await p; // A settles, then (unawaited) spawns B, which blocks on gateB
    await sup.retryNow(); // B is running -> queues a second follow-up for after B
    releaseB();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(errors.some((e) => e.includes('queued retry tick failed') && e.includes('clearTimer boom')), errors.join(''));
  } finally {
    process.stderr.write = origWrite;
  }
});

test('stop() cancels further ticks: the armed timer is actually cleared, not just gated by a flag', async () => {
  const h = harness({ health: [UP] });
  await h.sup.start();
  const armed = h.timers.at(-1);
  h.sup.stop();
  assert.equal(armed.cleared, true);
  await assert.rejects(() => h.fire(), /already cleared/);
});

const STALL = { ok: false, reason: 'timeout' };

test('one 5 s probe stall does not leave up, does not degrade, and requests no start', async () => {
  const h = harness({ health: [UP], alive: true });
  await h.sup.start();
  h.setHealth([STALL]);
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'up');
  assert.equal(h.timers.at(-1).ms, SUPERVISOR_DEFAULTS.suspectPollMs);
  h.setHealth([UP]);
  await h.fire();
  const s = h.sup.snapshot();
  assert.equal(s.state, 'up');
  assert.equal(s.lastOutcome, 'nothing-to-do');
  assert.equal(h.calls.start, 0);
});

test('two stalls then a recovery stay up; the failure count restarts after a good probe', async () => {
  const h = harness({ health: [UP], alive: false });
  await h.sup.start();
  h.setHealth([STALL]); await h.fire(); await h.fire();
  h.setHealth([UP]); await h.fire();
  h.setHealth([STALL]); await h.fire(); await h.fire();
  assert.equal(h.sup.snapshot().state, 'up');
  assert.equal(h.calls.start, 0);
});

test('a kernel that keeps answering TCP is never sent a start request; a 5 minute hang notifies once and resets on recovery', async () => {
  const h = harness({ health: [UP], alive: true });
  await h.sup.start();
  h.setHealth([STALL]);
  for (let i = 0; i < 20; i++) await h.fire();
  assert.equal(h.sup.snapshot().state, 'degraded');
  assert.match(h.sup.snapshot().reason, /^unresponsive:/);
  assert.equal(h.giveUps.length, 0, 'no notice inside the first minute');
  for (let i = 0; i < 120; i++) await h.fire(); // 3 s each, well past 5 minutes
  assert.equal(h.giveUps.length, 1, 'exactly one notice, however long the hang lasts');
  assert.match(h.giveUps[0].reason, /^unresponsive:/);
  assert.equal(h.calls.start, 0);
  h.setHealth([UP]);
  await h.fire();
  assert.equal(h.sup.snapshot().state, 'up');
  h.setHealth([STALL]);
  for (let i = 0; i < 130; i++) await h.fire();
  assert.equal(h.giveUps.length, 2, 'a new hang notifies again');
  assert.equal(h.calls.start, 0);
});

test('a kernel with no answer for the sustained window is started, then backs off and gives up as before', async () => {
  const h = harness({ health: [UP], alive: false });
  await h.sup.start();
  h.setHealth([DOWN]);
  let probes = 0;
  while (h.calls.start === 0 && probes < 10) { await h.fire(); probes++; }
  assert.ok(probes >= SUPERVISOR_DEFAULTS.failThreshold, `started after ${probes} probes`);
  assert.equal(h.calls.start, 1);
  assert.equal(h.sup.snapshot().state, 'starting');
  for (let i = 0; i < 6; i++) await h.fire();
  assert.equal(h.sup.snapshot().state, 'offline');
  assert.equal(h.giveUps.length, 1);
  assert.equal(h.calls.start, 5);
});

// Card glmps-2-0-214: a port that answers HTTP but not as a kernel, while this
// app's own kernel is not running, is another program's (the GLMPS Tap on the
// new machine). It is reported, never waited on and never started over; once
// the port is free the next poll starts the kernel by itself.
test('a foreign program on the kernel port is reported offline at once, and the kernel starts once it is gone', async () => {
  const conflicts = [];
  let alive = true;
  let t = 1_000_000;
  const timers = [];
  const giveUps = [];
  let starts = 0;
  const health = [{ ok: false, reason: 'http-403' }];
  const sup = createSupervisor({
    checkHealth: async () => health[0],
    startService: async () => { starts++; return STARTED; },
    isKernelAlive: async () => alive,
    portConflict: async (h) => { conflicts.push(h.reason); return 'port-conflict:tap'; },
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; },
    clearTimer: () => {},
    onGiveUp: (s) => giveUps.push(s),
  });
  await sup.start();
  assert.equal(sup.snapshot().state, 'offline');
  assert.equal(sup.snapshot().reason, 'port-conflict:tap');
  assert.equal(starts, 0);
  assert.equal(giveUps.length, 1);
  assert.deepEqual(conflicts, ['http-403']);
  t += timers.at(-1).ms; await timers.at(-1).fn();
  assert.equal(sup.snapshot().reason, 'port-conflict:tap');
  assert.equal(giveUps.length, 1, 'one notice per streak');
  alive = false;
  health[0] = DOWN;
  t += timers.at(-1).ms; await timers.at(-1).fn();
  assert.equal(starts, 1);
  assert.equal(sup.snapshot().state, 'starting');
});

test('no conflict found, or a kernel that was up: an answering port is waited on as before', async () => {
  const none = harness({ health: [{ ok: false, reason: 'http-403' }], alive: true });
  await none.sup.start();
  assert.equal(none.sup.snapshot().state, 'starting');
  assert.equal(none.sup.snapshot().reason, 'waiting:http-403');
  let asked = 0;
  let t = 0;
  const timers = [];
  const health = [UP];
  const sup = createSupervisor({
    checkHealth: async () => health[0], startService: async () => STARTED, isKernelAlive: async () => true,
    portConflict: async () => { asked++; return 'port-conflict:other'; },
    now: () => t, setTimer: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; }, clearTimer: () => {},
    failThreshold: 1, noAnswerMs: 0,
  });
  await sup.start();
  health[0] = { ok: false, reason: 'http-500' };
  t += 10_000; await timers.at(-1).fn();
  assert.equal(asked, 0, 'a kernel that was up is never second-guessed as a foreign program');
  assert.equal(sup.snapshot().state, 'degraded');
});

test('after a port-conflict notice, a later give-up with a different cause notifies once more (glmps-2-0-221)', async () => {
  let alive = true;
  let t = 1_000_000;
  const timers = [];
  const giveUps = [];
  const health = [{ ok: false, reason: 'http-403' }];
  const sup = createSupervisor({
    checkHealth: async () => health[0],
    startService: async () => STARTED,
    isKernelAlive: async () => alive,
    portConflict: async () => 'port-conflict:tap',
    now: () => t,
    setTimer: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; },
    clearTimer: () => {},
    onGiveUp: (s) => giveUps.push(s.reason),
  });
  const fire = async () => { t += timers.at(-1).ms; await timers.at(-1).fn(); };
  await sup.start();
  assert.deepEqual(giveUps, ['port-conflict:tap']);
  alive = false;
  health[0] = DOWN;
  for (let i = 0; i < SUPERVISOR_DEFAULTS.maxStartAttempts + 1; i++) await fire();
  assert.equal(sup.snapshot().state, 'offline');
  assert.match(sup.snapshot().reason, /^gave-up:/);
  assert.equal(giveUps.length, 2, 'the kernel failing to start is a new cause, so it gets its own notice');
  assert.match(giveUps[1], /^gave-up:/);
  await fire(); await fire();
  assert.equal(giveUps.length, 2, 'still one notice per cause within the streak');
});
