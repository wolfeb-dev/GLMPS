import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernelHost, createKernelStarter, bundledKernel, checkoutKernel, CRASH_RESPAWN_DELAYS_MS, KERNEL_LOG_MAX_BYTES } from '../src/lib/kernel-host.js';

function setup({ withNode = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-khost-'));
  const kernelDir = path.join(tmp, 'kernel');
  fs.mkdirSync(path.join(kernelDir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(kernelDir, 'server', 'server.js'), '');
  fs.writeFileSync(path.join(kernelDir, 'config.example.json'), JSON.stringify({ port: 8123, pollMs: 1000 }));
  if (withNode) fs.writeFileSync(path.join(kernelDir, 'node.exe'), '');
  const spawns = [];
  const kills = [];
  let pid = 100;
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    spawns.push({ file, args, opts, child });
    return child;
  };
  const killImpl = (p) => kills.push(p);
  const opts = {
    kernelDir, stateDir: path.join(tmp, 'state'), configFile: path.join(tmp, 'userData', 'kernel', 'config.json'),
    logsDir: path.join(tmp, 'state', 'logs'), port: 8124, spawnImpl, killImpl, env: { PATH: 'p', GLMPS_SERVICE: '1' },
  };
  return { tmp, kernelDir, spawns, kills, opts, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('start seeds the config from the example with the kernel port, then runs the bundled node on the bundled server', () => {
  const t = setup();
  try {
    const host = createKernelHost(t.opts);
    assert.deepEqual(host.start(), { ok: true, code: null, reason: 'embedded-started' });
    assert.deepEqual(JSON.parse(fs.readFileSync(t.opts.configFile, 'utf8')), { port: 8124, pollMs: 1000 });
    assert.equal(t.spawns.length, 1);
    const s = t.spawns[0];
    assert.equal(s.file, path.join(t.kernelDir, 'node.exe'));
    assert.deepEqual(s.args, [path.join(t.kernelDir, 'server', 'server.js')]);
    assert.equal(s.opts.cwd, t.kernelDir);
    assert.equal(s.opts.windowsHide, true);
    assert.equal(s.opts.env.GLMPS_SUPERVISED, '1');
    assert.equal(s.opts.env.GLMPS_STATE_DIR, t.opts.stateDir);
    assert.equal(s.opts.env.GLMPS_CONFIG_FILE, t.opts.configFile);
    assert.equal(s.opts.env.PATH, 'p');
    assert.equal('GLMPS_SERVICE' in s.opts.env, false, 'the bundled kernel runs in the operator session, never in service mode');
    assert.ok(fs.existsSync(path.join(t.opts.logsDir, 'kernel.log')));
    assert.equal(host.running(), true);
  } finally { t.cleanup(); }
});

test('an existing config is never overwritten', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.dirname(t.opts.configFile), { recursive: true });
    fs.writeFileSync(t.opts.configFile, '{"port":9999,"mine":true}');
    createKernelHost(t.opts).start();
    assert.equal(fs.readFileSync(t.opts.configFile, 'utf8'), '{"port":9999,"mine":true}');
  } finally { t.cleanup(); }
});

test('a second start while the kernel runs does not spawn again', () => {
  const t = setup();
  try {
    const host = createKernelHost(t.opts);
    host.start();
    assert.deepEqual(host.start(), { ok: true, code: null, reason: 'embedded-running' });
    assert.equal(t.spawns.length, 1);
  } finally { t.cleanup(); }
});

test('exit 75 (a restart asked from the dashboard) respawns at once under the shell', () => {
  const t = setup();
  try {
    const host = createKernelHost(t.opts);
    host.start();
    t.spawns[0].child.emit('exit', 75, null);
    assert.equal(t.spawns.length, 2);
    assert.equal(host.running(), true);
  } finally { t.cleanup(); }
});

function timers() {
  const armed = [];
  return {
    armed,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; armed.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    fire: () => { const t = armed.filter((x) => !x.cleared).at(-1); t.cleared = true; t.fn(); },
  };
}

test('a crash is respawned on the service schedule (5 s, 30 s, then 2 min), with no ceiling', () => {
  const t = setup();
  const tm = timers();
  try {
    const host = createKernelHost({ ...t.opts, setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => 0 });
    host.start();
    assert.deepEqual(CRASH_RESPAWN_DELAYS_MS, [5000, 30000, 120000]);
    const delays = [];
    for (let i = 0; i < 5; i++) {
      t.spawns.at(-1).child.emit('exit', 1, null);
      assert.equal(host.running(), false);
      assert.equal(host.owned(), true, 'a pending respawn is still a kernel this app owns');
      delays.push(tm.armed.at(-1).ms);
      tm.fire();
    }
    assert.deepEqual(delays, [5000, 30000, 120000, 120000, 120000]);
    assert.equal(t.spawns.length, 6);
  } finally { t.cleanup(); }
});

test('an hour up resets the crash schedule, as WinSW resetfailure did', () => {
  const t = setup();
  const tm = timers();
  let clock = 0;
  try {
    const host = createKernelHost({ ...t.opts, setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => clock });
    host.start();
    t.spawns.at(-1).child.emit('exit', 1, null); tm.fire();
    t.spawns.at(-1).child.emit('exit', 1, null);
    assert.equal(tm.armed.at(-1).ms, 30000);
    tm.fire();
    clock += 3_600_000;
    t.spawns.at(-1).child.emit('exit', 1, null);
    assert.equal(tm.armed.at(-1).ms, 5000);
  } finally { t.cleanup(); }
});

test('a supervisor start during a pending respawn starts at once and cancels the timer; stop cancels it too', () => {
  const t = setup();
  const tm = timers();
  try {
    const host = createKernelHost({ ...t.opts, setTimer: tm.setTimer, clearTimer: tm.clearTimer, now: () => 0 });
    host.start();
    t.spawns[0].child.emit('exit', 1, null);
    assert.equal(host.start().reason, 'embedded-started');
    assert.equal(tm.armed.at(-1).cleared, true);
    assert.equal(t.spawns.length, 2);
    t.spawns[1].child.emit('exit', 1, null);
    host.stop();
    assert.equal(tm.armed.at(-1).cleared, true);
    assert.equal(host.owned(), false);
  } finally { t.cleanup(); }
});

test('kernel.log is rolled to kernel.log.1 once it passes 10 MB', () => {
  const t = setup();
  try {
    fs.mkdirSync(t.opts.logsDir, { recursive: true });
    const log = path.join(t.opts.logsDir, 'kernel.log');
    fs.writeFileSync(log, Buffer.alloc(KERNEL_LOG_MAX_BYTES + 1));
    createKernelHost(t.opts).start();
    assert.equal(fs.statSync(path.join(t.opts.logsDir, 'kernel.log.1')).size, KERNEL_LOG_MAX_BYTES + 1);
    assert.equal(fs.statSync(log).size, 0);
  } finally { t.cleanup(); }
});

test('checkout mode runs the configured node on the checkout, with the service assets dir and no config of its own', () => {
  const t = setup();
  try {
    const node = path.join(t.tmp, 'nodejs', 'node.exe');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, '');
    const host = createKernelHost({ ...t.opts, nodePath: node, configFile: null, extraEnv: { GLMPS_ASSETS_DIR: 'A' },
      env: { PATH: 'p', GLMPS_CONFIG_FILE: 'stale' } });
    assert.equal(host.start().reason, 'embedded-started');
    const s = t.spawns[0];
    assert.equal(s.file, node);
    assert.deepEqual(s.args, [path.join(t.kernelDir, 'server', 'server.js')]);
    assert.equal(s.opts.cwd, t.kernelDir);
    assert.equal(s.opts.env.GLMPS_ASSETS_DIR, 'A');
    assert.equal(s.opts.env.GLMPS_SUPERVISED, '1');
    assert.equal('GLMPS_CONFIG_FILE' in s.opts.env, false, 'the kernel reads the config the service read');
    assert.equal(fs.existsSync(t.opts.configFile), false, 'nothing is seeded');
  } finally { t.cleanup(); }
});

test('checkoutKernel: a packaged Windows build, a loopback kernel, a checkout with a server entry and an existing node', () => {
  const t = setup();
  try {
    const node = path.join(t.kernelDir, 'node.exe');
    const settings = { kernelCheckout: t.kernelDir, kernelNode: node, kernelAssetsDir: 'A' };
    const ok = { isPackaged: true, platform: 'win32', isLoopback: true, settings };
    assert.deepEqual(checkoutKernel(ok), { kernelDir: t.kernelDir, nodePath: node, extraEnv: { GLMPS_ASSETS_DIR: 'A' } });
    assert.deepEqual(checkoutKernel({ ...ok, settings: { ...settings, kernelAssetsDir: null } }).extraEnv, {});
    assert.equal(checkoutKernel({ ...ok, isPackaged: false }), null);
    assert.equal(checkoutKernel({ ...ok, platform: 'linux' }), null);
    assert.equal(checkoutKernel({ ...ok, isLoopback: false }), null);
    assert.equal(checkoutKernel({ ...ok, settings: { ...settings, kernelCheckout: null } }), null);
    assert.equal(checkoutKernel({ ...ok, settings: { ...settings, kernelNode: null } }), null);
    assert.equal(checkoutKernel({ ...ok, settings: { ...settings, kernelNode: 'node.exe' } }), null, 'a relative node is never resolved from PATH');
    assert.equal(checkoutKernel({ ...ok, settings: { ...settings, kernelNode: path.join(t.tmp, 'none.exe') } }), null);
    assert.equal(checkoutKernel({ ...ok, settings: { ...settings, kernelCheckout: t.tmp } }), null, 'no server/server.js');
  } finally { t.cleanup(); }
});

test('checkoutKernel merges kernelEnv after GLMPS_ASSETS_DIR', () => {
  const t = setup();
  try {
    const node = path.join(t.kernelDir, 'node.exe');
    const base = { isPackaged: true, platform: 'win32', isLoopback: true };
    const settings = { kernelCheckout: t.kernelDir, kernelNode: node, kernelAssetsDir: 'A', kernelEnv: { GLMPS_ASSETS_WRITE_DIR: 'W' } };
    assert.deepEqual(checkoutKernel({ ...base, settings }).extraEnv, { GLMPS_ASSETS_DIR: 'A', GLMPS_ASSETS_WRITE_DIR: 'W' });
    assert.deepEqual(checkoutKernel({ ...base, settings: { ...settings, kernelAssetsDir: null } }).extraEnv, { GLMPS_ASSETS_WRITE_DIR: 'W' });
    assert.deepEqual(checkoutKernel({ ...base, settings: { ...settings, kernelEnv: undefined } }).extraEnv, { GLMPS_ASSETS_DIR: 'A' });
  } finally { t.cleanup(); }
});

test('a spawn error is reported and leaves the host stopped', () => {
  const t = setup();
  try {
    const host = createKernelHost(t.opts);
    host.start();
    t.spawns[0].child.emit('error', new Error('EACCES'));
    assert.equal(host.running(), false);
  } finally { t.cleanup(); }
});

test('stop kills the whole process tree and an exit after stop is never respawned', () => {
  const t = setup();
  try {
    const host = createKernelHost(t.opts);
    host.start();
    host.stop();
    assert.deepEqual(t.kills, [t.spawns[0].child.pid]);
    t.spawns[0].child.emit('exit', 75, null);
    assert.equal(t.spawns.length, 1);
    assert.equal(host.running(), false);
  } finally { t.cleanup(); }
});

test('stop with nothing running kills nothing', () => {
  const t = setup();
  try {
    createKernelHost(t.opts).stop();
    assert.deepEqual(t.kills, []);
  } finally { t.cleanup(); }
});

test('a missing bundled node reports embedded-missing and spawns nothing', () => {
  const t = setup({ withNode: false });
  try {
    assert.deepEqual(createKernelHost(t.opts).start(), { ok: false, code: null, reason: 'embedded-missing' });
    assert.equal(t.spawns.length, 0);
  } finally { t.cleanup(); }
});

test('a throwing spawn reports spawn-failed', () => {
  const t = setup();
  try {
    const host = createKernelHost({ ...t.opts, spawnImpl: () => { throw new Error('boom'); } });
    assert.deepEqual(host.start(), { ok: false, code: null, reason: 'embedded-spawn-failed' });
    assert.equal(host.running(), false);
  } finally { t.cleanup(); }
});

test('the starter prefers the service, and falls back to the bundled kernel only when no service exists', async () => {
  const calls = [];
  const host = { start: () => { calls.push('host'); return { ok: true, code: null, reason: 'embedded-started' }; } };
  const svc = (r) => async () => { calls.push('sc'); return r; };
  assert.equal((await createKernelStarter({ startService: svc({ ok: true, code: 0, reason: 'start-requested' }), host })()).reason, 'start-requested');
  assert.equal((await createKernelStarter({ startService: svc({ ok: true, code: 1056, reason: 'already-running' }), host })()).reason, 'already-running');
  assert.equal((await createKernelStarter({ startService: svc({ ok: false, code: 5, reason: 'access-denied' }), host })()).reason, 'access-denied');
  assert.deepEqual(calls, ['sc', 'sc', 'sc']);
  assert.equal((await createKernelStarter({ startService: svc({ ok: false, code: 1060, reason: 'not-installed' }), host })()).reason, 'embedded-started');
  assert.equal((await createKernelStarter({ startService: svc({ ok: false, code: null, reason: 'sc-missing' }), host })()).reason, 'embedded-started');
  assert.equal((await createKernelStarter({ startService: svc({ ok: false, code: 1060, reason: 'not-installed' }), host: null })()).reason, 'not-installed');
});

test('bundledKernel: only a packaged Windows build against a loopback kernel gets a kernel dir', () => {
  const t = setup();
  try {
    const resourcesPath = path.dirname(t.kernelDir);
    const ok = { isPackaged: true, platform: 'win32', isLoopback: true, resourcesPath };
    assert.equal(bundledKernel(ok), t.kernelDir);
    assert.equal(bundledKernel({ ...ok, isPackaged: false }), null);
    assert.equal(bundledKernel({ ...ok, platform: 'linux' }), null);
    assert.equal(bundledKernel({ ...ok, isLoopback: false }), null);
    assert.equal(bundledKernel({ ...ok, resourcesPath: null }), null);
  } finally { t.cleanup(); }
});

// Card glmps-2-0-214: an install whose kernel files are gone (antivirus
// quarantine, a damaged install) once got no host at all, so the shell fell
// through to "install the GLMPS2 service from the glmps folder",
// advice a machine without a source checkout cannot follow.
test('a packaged install with its kernel files gone still gets a host, which reports embedded-missing', async () => {
  const t = setup({ withNode: false });
  try {
    const kernelDir = bundledKernel({ isPackaged: true, platform: 'win32', isLoopback: true, resourcesPath: path.dirname(t.kernelDir) });
    assert.equal(kernelDir, t.kernelDir);
    const host = createKernelHost({ ...t.opts, kernelDir });
    const r = await createKernelStarter({ startService: async () => ({ ok: false, code: 1060, reason: 'not-installed' }), host })();
    assert.equal(r.reason, 'embedded-missing');
    assert.equal(t.spawns.length, 0);
  } finally { t.cleanup(); }
});

test('GLMPS_PROFILE points at the profile file only when it exists', () => {
  const t = setup();
  try {
    const profileFile = path.join(t.tmp, 'userData', 'glmps.profile.json');
    createKernelHost({ ...t.opts, profileFile }).start();
    assert.equal('GLMPS_PROFILE' in t.spawns[0].opts.env, false);
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, '{}');
    createKernelHost({ ...t.opts, profileFile }).start();
    assert.equal(t.spawns[1].opts.env.GLMPS_PROFILE, profileFile);
    createKernelHost(t.opts).start();
    assert.equal('GLMPS_PROFILE' in t.spawns[2].opts.env, false);
  } finally { t.cleanup(); }
});

test('restart kills the running kernel, waits for it to exit, then starts a fresh one', async () => {
  const t = setup();
  try {
    const host = createKernelHost(t.opts);
    host.start();
    const first = t.spawns[0].child;
    const pending = host.restart();
    assert.deepEqual(t.kills, [first.pid]);
    assert.equal(t.spawns.length, 1, 'the old kernel still holds the port');
    first.emit('exit', 1, null);
    assert.deepEqual(await pending, { ok: true, code: null, reason: 'embedded-started' });
    assert.equal(t.spawns.length, 2);
    assert.equal(host.owned(), true);
  } finally { t.cleanup(); }
});

test('restart starts anyway when the old kernel never reports its exit, and just starts when nothing runs', async () => {
  const t = setup();
  try {
    const tm = timers();
    const host = createKernelHost({ ...t.opts, setTimer: tm.setTimer, clearTimer: tm.clearTimer });
    assert.equal((await host.restart()).ok, true);
    assert.equal(t.spawns.length, 1);
    const pending = host.restart();
    tm.fire();
    assert.equal((await pending).ok, true);
    assert.equal(t.spawns.length, 2);
  } finally { t.cleanup(); }
});
