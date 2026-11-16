// The Restart sequence (card glmps-2-0-170). Every effect is injected; nothing
// touches the scheduler, the service or a real state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRestartAll, stepsText, promotionRefusal } from '../lib/scut/restart-all.js';
import { readMaintenance, beginMaintenance } from '../lib/kernel/maintenance.js';

const START = 10_000_000;

function harness({ stale = false, bootAfterUpdate = false, failStep = null, busyFor = 0, steps = [], resume = false, bootTs = START - 60_000 } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-all-'));
  const clock = { t: START };
  const calls = [];
  const phases = [];
  const recorded = [];
  let boot = bootTs;
  let busy = busyFor;
  const phase = () => readMaintenance(stateDir, clock.t)?.phase ?? null;
  const deps = {
    stateDir,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; if (busy > 0) busy -= ms; },
    mergeBusy: () => busy > 0,
    appStale: () => stale,
    bootTs: () => boot,
    recordStep: (e) => recorded.push(e),
    runStep: async (name, opts) => {
      calls.push({ name, ...opts });
      phases.push([name, phase()]);
      if (name === 'deploy-glmps2' && bootAfterUpdate) boot = clock.t + 1000;
      if (name === 'restart-glmps2') boot = clock.t + 1000;
      return failStep === name ? { ok: false, exitCode: 1, error: 'boom' } : { ok: true, exitCode: 0 };
    },
    verify: async () => {
      calls.push({ name: 'verify' });
      phases.push(['verify', phase()]);
      return failStep === 'verify' ? { ok: false, error: 'old build serving' } : { ok: true, health: { status: 200, summary: 'up' } };
    },
  };
  const run = () => runRestartAll({ runId: 'apr-1', startedTs: START, resume, steps }, deps);
  return { deps, calls, phases, recorded, run, stateDir, clock };
}
const names = (calls) => calls.map((c) => c.name);

test('a refused update still restarts and names why the update was skipped', async () => {
  const h = harness({ failStep: 'deploy-glmps2' });
  h.deps.updateRefusal = () => 'the queue runner is disabled';
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.deepEqual(names(h.calls), ['deploy-glmps2', 'restart-glmps2', 'verify']);
  assert.match(stepsText(h.recorded), /update skipped \(the queue runner is disabled\)/);
});

test('an update that failed rather than being refused stops the run', async () => {
  const h = harness({ failStep: 'deploy-glmps2' });
  h.deps.updateRefusal = () => null;
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.deepEqual(names(h.calls), ['deploy-glmps2']);
});

test('promotionRefusal finds only a refusal recorded by this run', () => {
  const line = (ts, outcome, reason) => JSON.stringify({ ts: new Date(ts).toISOString(), outcome, reason });
  const text = [line(START - 3_600_000, 'refused:1', 'old'), line(START + 5000, 'refused:3', 'no green full run')].join('\n') + '\n';
  assert.equal(promotionRefusal(text, START), 'no green full run');
  assert.equal(promotionRefusal(line(START + 5000, 'rolled-back', 'x'), START), null);
  assert.equal(promotionRefusal(line(START - 3_600_000, 'refused:1', 'old'), START), null);
  assert.equal(promotionRefusal('{torn', START), null);
});

test('nothing waiting: update finds nothing, the app is fresh, the old process is restarted, then verified', async () => {
  const h = harness();
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.deepEqual(names(h.calls), ['deploy-glmps2', 'restart-glmps2', 'verify']);
  assert.equal(readMaintenance(h.stateDir, h.clock.t), null, 'released');
});

test('an update that restarted the kernel makes the plain restart unnecessary', async () => {
  const h = harness({ bootAfterUpdate: true });
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.deepEqual(names(h.calls), ['deploy-glmps2', 'verify']);
  assert.ok(h.recorded.some((e) => e.step === 'restart' && e.status === 'skipped'));
});

test('a stale app is rebuilt between the update and the restart', async () => {
  const h = harness({ stale: true });
  await h.run();
  assert.deepEqual(names(h.calls), ['deploy-glmps2', 'rebuild-app', 'restart-glmps2', 'verify']);
});

test('update waiting and app stale: update, rebuild, no extra restart', async () => {
  const h = harness({ stale: true, bootAfterUpdate: true });
  await h.run();
  assert.deepEqual(names(h.calls), ['deploy-glmps2', 'rebuild-app', 'verify']);
});

test('sessions are held only around the update and restart, never during the rebuild or verify', async () => {
  const h = harness({ stale: true });
  await h.run();
  assert.deepEqual(h.phases, [['deploy-glmps2', 'restarting'], ['rebuild-app', 'quiescing'], ['restart-glmps2', 'restarting'], ['verify', 'quiescing']]);
});

for (const failing of ['deploy-glmps2', 'rebuild-app', 'restart-glmps2', 'verify']) {
  test('a failed ' + failing + ' step stops the run, names the step and releases the hold', async () => {
    const h = harness({ stale: true, failStep: failing });
    const r = await h.run();
    assert.equal(r.ok, false);
    assert.match(r.error, /boom|old build serving/);
    const order = ['deploy-glmps2', 'rebuild-app', 'restart-glmps2', 'verify'];
    assert.deepEqual(names(h.calls), order.slice(0, order.indexOf(failing) + 1));
    assert.equal(readMaintenance(h.stateDir, h.clock.t), null);
  });
}

test('a throwing step is a failed run and still releases the hold', async () => {
  const h = harness();
  h.deps.runStep = async () => { throw new Error('spawn exploded'); };
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn exploded/);
  assert.equal(readMaintenance(h.stateDir, h.clock.t), null);
});

test('quiesce waits for in-flight merge work to finish, then proceeds', async () => {
  const h = harness({ busyFor: 30_000 });
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.ok(h.clock.t >= START + 30_000);
});

test('quiesce that never gets quiet ends with still busy, restarts nothing and releases', async () => {
  const h = harness({ busyFor: Infinity });
  const r = await h.run();
  assert.equal(r.ok, false);
  assert.match(r.error, /still busy/);
  assert.deepEqual(h.calls, []);
  assert.ok(h.clock.t - START >= 15 * 60_000 && h.clock.t - START < 16 * 60_000);
  assert.equal(readMaintenance(h.stateDir, h.clock.t), null);
});

const entry = (step, status, ts = START + 1) => ({ type: 'step', id: 'apr-1', step, status, ts });

test('resume skips finished steps and continues from the in-flight one', async () => {
  const h = harness({
    resume: true, bootTs: START + 5000,
    steps: [entry('quiesce', 'finished'), entry('update', 'started', START + 100)],
  });
  beginMaintenance(h.stateDir, { runId: 'apr-1', now: START });
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.deepEqual(names(h.calls), ['deploy-glmps2', 'verify']);
  assert.equal(h.calls[0].resume, true, 'the in-flight step is waited on, not relaunched');
  assert.equal(h.calls[0].startedTs, START + 100, 'with the time it was originally started');
  assert.equal(readMaintenance(h.stateDir, h.clock.t), null);
});

test('resume after the update finished and the app rebuilt goes straight to verify', async () => {
  const h = harness({
    resume: true, bootTs: START + 5000,
    steps: [entry('quiesce', 'finished'), entry('update', 'finished'), entry('rebuild', 'finished'), entry('restart', 'skipped')],
  });
  await h.run();
  assert.deepEqual(names(h.calls), ['verify']);
});

test('resume with a restart in flight waits on it instead of starting another', async () => {
  const h = harness({
    resume: true, bootTs: START + 9000,
    steps: [entry('quiesce', 'finished'), entry('update', 'finished'), entry('rebuild', 'skipped'), entry('restart', 'started', START + 50)],
  });
  await h.run();
  assert.deepEqual(h.calls.map((c) => [c.name, c.resume]), [['restart-glmps2', true], ['verify', undefined]]);
});

test('every step is recorded as started and then finished or skipped', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.recorded.map((e) => e.step + ':' + e.status), [
    'quiesce:started', 'quiesce:finished', 'update:started', 'update:finished',
    'rebuild:started', 'rebuild:skipped', 'restart:started', 'restart:finished', 'verify:started', 'verify:finished',
  ]);
});

test('stepsText names what happened in one line', () => {
  assert.equal(stepsText([entry('update', 'finished'), entry('rebuild', 'skipped'), entry('restart', 'finished'), entry('verify', 'finished')]),
    'update done, rebuild skipped, restart done, verify done');
  assert.equal(stepsText([]), '');
});

import { makeRestartAllRunner } from '../lib/scut/restart-all.js';
import { approvalsConfig } from '../lib/scut/approvals.js';
import { verifyDeployedHealthz } from '../lib/kernel/deploy-verify.js';

function runnerHarness({ stale = false, health = { status: 200, summary: 'up' }, head = { sha: 'abc1234def' } } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-all-r-'));
  const registry = approvalsConfig({}).registry;
  const ran = [];
  const checks = [];
  const runner = makeRestartAllRunner({
    stateDir, getRegistry: () => registry,
    runApproval: async (def, opts) => { ran.push([def.name, opts]); return { ok: true, exitCode: 0 }; },
    mergeBusy: () => false,
    readTreeId: async () => 'tree1', appIsStale: () => stale,
    readHead: async () => head,
    checkHealth: async (url, o) => { checks.push({ url, probe: o.verify }); return health; },
    verifyHealthz: verifyDeployedHealthz,
    now: () => Date.now(), sleep: async () => {},
  });
  return { runner, ran, checks, registry };
}

test('the runner runs each step through the registered action and reports a steps line', async () => {
  const h = runnerHarness({ stale: true });
  const recorded = [];
  const r = await h.runner(h.registry['restart-all'], { startedTs: Date.now() + 10_000_000, resume: false, runId: 'apr-9', steps: [], recordStep: (e) => recorded.push(e) });
  assert.equal(r.ok, true);
  assert.deepEqual(h.ran.map(([n]) => n), ['deploy-glmps2', 'rebuild-app', 'restart-glmps2']);
  assert.match(r.stepsLine, /^quiesce done, update done, rebuild done, restart done, verify done$/);
  assert.equal(recorded.length, 10);
});

test('verification asks /healthz for the deployed commit from a process newer than the run', async () => {
  const h = runnerHarness();
  await h.runner(h.registry['restart-all'], { startedTs: Date.now() - 60_000, resume: false, runId: 'apr-9', steps: [] });
  const probe = h.checks[0].probe;
  assert.equal(probe({ version: '0.1.0+abc1234', uptime_s: 3600 }).ok, false, 'an old process fails');
  assert.match(probe({ version: '0.1.0+zzzzzzz', uptime_s: 1 }).reason, /expected \+abc1234/);
  assert.equal(probe({ version: '0.1.0+abc1234', uptime_s: 0 }).ok, true);
});

test('an unhealthy server fails the verify step', async () => {
  const h = runnerHarness({ health: { error: 'ECONNREFUSED' } });
  const r = await h.runner(h.registry['restart-all'], { startedTs: 5000, resume: false, runId: 'apr-9', steps: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /^verify: ECONNREFUSED/);
});
