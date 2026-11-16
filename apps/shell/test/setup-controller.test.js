import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupController } from '../src/lib/setup/controller.js';

const dep = (name, action = 'ok', required = false) => ({ name, required, installed: '1', latest: null, update: null, action, command: null });
const FRESH = {
  deps: [dep('node', 'ok', true), dep('git', 'install', true)],
  claude: { installed: true, signedIn: false },
  github: { installed: false, signedIn: false, scopes: [], missingScopes: [] },
  slack: { saved: false }, hooks: { installed: false }, profile: { path: 'P', exists: false },
};

function make(over = {}) {
  const calls = { probe: 0, saved: [], opened: [], logs: [], finished: [], handled: [], states: [] };
  let status = FRESH;
  const handlers = {
    'claude:sign-in': async (input) => { calls.handled.push(['claude:sign-in', input]); status = { ...status, claude: { installed: true, signedIn: true } }; return { ok: true, message: 'signed in' }; },
    'slack:connect': async (input) => { calls.handled.push(['slack:connect', input]); return { ok: false, message: 'bad token' }; },
    'deps:install-missing': async () => { throw new Error('boom'); },
  };
  const c = createSetupController({
    probe: async () => { calls.probe += 1; return status; },
    handlers, readProgress: () => ({ completed: [], skipped: [] }),
    writeProgress: (p) => calls.saved.push(p),
    openExternal: async (u) => { calls.opened.push(u); },
    finish: async (o) => { calls.finished.push(o); },
    log: (...a) => calls.logs.push(a), ...over,
  });
  c.onState((s) => calls.states.push(s));
  return { c, calls, setStatus: (s) => { status = s; } };
}

test('getState probes once and returns the contract State', async () => {
  const { c, calls } = make();
  const s = await c.getState();
  await c.getState();
  assert.equal(calls.probe, 1);
  assert.equal(s.currentId, 'welcome');
  assert.equal(s.steps.length, 9);
});

test('begin and skip move progress, persist it and push state; recheck re-probes', async () => {
  const { c, calls } = make();
  assert.deepEqual(await c.run('welcome', 'begin'), { ok: true, message: '' });
  assert.deepEqual(calls.saved.at(-1), { completed: ['welcome'], skipped: [] });
  assert.equal((await c.getState()).currentId, 'deps');
  await c.run('deps', 'skip');
  assert.deepEqual(calls.saved.at(-1), { completed: ['welcome'], skipped: ['deps'] });
  const before = calls.probe;
  await c.run('claude', 'recheck');
  assert.equal(calls.probe, before + 1);
  assert.ok(calls.states.length >= 4);
});

test('an action runs its handler with only the named string inputs, is busy meanwhile, then re-probes', async () => {
  const { c, calls } = make();
  let during;
  c.onState((s) => { if (s.busy) during = s; });
  const r = await c.run('claude', 'sign-in', { botToken: 'x', extra: 'drop', email: 5 });
  assert.deepEqual(r, { ok: true, message: 'signed in' });
  assert.deepEqual(calls.handled, [['claude:sign-in', { botToken: 'x' }]]);
  assert.equal(during.busy, true);
  assert.equal(during.steps.find((s) => s.id === 'claude').status, 'running');
  const after = await c.getState();
  assert.equal(after.busy, false);
  assert.equal(after.steps.find((s) => s.id === 'claude').status, 'ok');
  assert.equal(after.steps.find((s) => s.id === 'claude').detail, 'signed in');
});

test('a failed or throwing handler marks the step failed and never throws', async () => {
  const { c } = make();
  assert.deepEqual(await c.run('slack', 'connect', { botToken: 'xoxb-a', appToken: 'xapp-b' }), { ok: false, message: 'bad token' });
  assert.equal((await c.getState()).steps.find((s) => s.id === 'slack').status, 'failed');
  const t = await c.run('deps', 'install-missing');
  assert.equal(t.ok, false);
  assert.equal((await c.getState()).busy, false);
});

test('an action the step does not offer, an unknown step and a concurrent run are refused', async () => {
  const { c, calls } = make();
  assert.equal((await c.run('claude', 'install-hooks')).ok, false);
  assert.equal((await c.run('nope', 'x')).ok, false);
  assert.equal((await c.run('github', 'sign-in')).ok, false, 'gh is not installed, so sign-in is not offered');
  const slow = make({});
  let release;
  slow.c = createSetupController({
    probe: async () => FRESH, readProgress: () => ({ completed: [], skipped: [] }), writeProgress() {}, openExternal() {}, finish() {},
    handlers: { 'claude:sign-in': () => new Promise((res) => { release = () => res({ ok: true, message: '' }); }) },
  });
  const first = slow.c.run('claude', 'sign-in');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await slow.c.run('claude', 'sign-in'), { ok: false, message: 'Another action is still running.' });
  release();
  await first;
  assert.equal(calls.handled.length, 0);
});

test('openLink opens only a known key', async () => {
  const { c, calls } = make();
  assert.deepEqual(await c.openLink('github-tokens'), { ok: true });
  assert.deepEqual(await c.openLink('https://evil.example'), { ok: false });
  assert.deepEqual(calls.opened, ['https://github.com/settings/tokens']);
});

test('finish hands the launch-at-login choice to the shell and answers ok', async () => {
  const { c, calls } = make();
  assert.deepEqual(await c.finish({ launchAtLogin: false }), { ok: true });
  assert.deepEqual(calls.finished, [{ launchAtLogin: false }]);
  assert.equal((await c.getState()).launchAtLogin, false);
  await c.finish({});
  assert.deepEqual(calls.finished.at(-1), { launchAtLogin: true });
});

test('nothing the page sends reaches a log line', async () => {
  const { c, calls } = make();
  await c.run('slack', 'connect', { botToken: 'xoxb-leak', appToken: 'xapp-leak' });
  assert.ok(!JSON.stringify(calls.logs).includes('leak'));
});

test('a probe that fails leaves a usable degraded state', async () => {
  const c = createSetupController({
    probe: async () => { throw new Error('no kernel'); }, handlers: {}, readProgress: () => null, writeProgress() {}, openExternal() {}, finish() {},
  });
  const s = await c.getState();
  assert.equal(s.steps.length, 9);
});
