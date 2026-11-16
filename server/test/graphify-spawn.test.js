// server/test/graphify-spawn.test.js
// with graphify unresolved at boot, every rebuild ran
// `graphify update <root>` through cmd.exe unquoted (shell:true). Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnGraphifyUpdateWith } from '../lib/orchestration/graphify-spawn.js';

function fakeSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0); });
    return child;
  };
  return { fn, calls };
}

test('F23: no resolvable binary fails the rebuild by name and never spawns anything', async () => {
  const s = fakeSpawn();
  const r = await spawnGraphifyUpdateWith({ resolveBin: () => null, spawnImpl: s.fn }, 'D:/work/x&calc');
  assert.equal(r.code, 127);
  assert.match(r.stderr, /no graphify binary/);
  assert.equal(s.calls.length, 0);
});

test('F23: a resolved binary is spawned directly, never through a shell, with the root as one argv element', async () => {
  const s = fakeSpawn();
  const r = await spawnGraphifyUpdateWith({ resolveBin: () => 'C:/tools/graphify.exe', spawnImpl: s.fn }, 'D:/work/x&calc');
  assert.equal(r.code, 0);
  assert.equal(s.calls[0].file, 'C:/tools/graphify.exe');
  assert.deepEqual(s.calls[0].args, ['update', 'D:/work/x&calc']);
  assert.notEqual(s.calls[0].opts.shell, true);
});

import { createGraphifyResolver, runGraphifyWith } from '../lib/orchestration/graphify-spawn.js';
import { makeTicketEnrichExec } from '../lib/orchestration/ticket-enrich.js';

test('F23: resolver prefers the .exe over a .cmd shim on win32', async () => {
  const r = createGraphifyResolver({ platform: 'win32', exec: () => 'C:\a\graphify.cmd\r\nC:\b\graphify.exe\r\n' });
  assert.equal(await r(), 'C:\b\graphify.exe');
});

test('F23: resolver treats a lone .cmd or .bat as unresolved (needs a shell)', async () => {
  const r = createGraphifyResolver({ platform: 'win32', exec: () => 'C:\a\graphify.cmd\r\nC:\a\graphify.bat\r\n' });
  assert.equal(await r(), null);
});

test('F23: resolver takes the first hit off win32', async () => {
  const r = createGraphifyResolver({ platform: 'linux', exec: () => '/usr/bin/graphify\n' });
  assert.equal(await r(), '/usr/bin/graphify');
});

test('F23: a miss is not cached, a later install is found; a hit is cached', async () => {
  let n = 0; let out = '';
  const r = createGraphifyResolver({ platform: 'linux', exec: async () => { n++; if (!out) throw new Error('not found'); return out; } });
  assert.equal(await r(), null);
  out = '/usr/bin/graphify\n';
  assert.equal(await r(), '/usr/bin/graphify');
  await r();
  assert.equal(n, 2);
});

test('F23: non-update graphify calls fail with 127 by name when unresolved, and never spawn', async () => {
  const calls = [];
  const res = await runGraphifyWith({ resolveBin: () => null, runCmd: (...a) => { calls.push(a); } }, ['--version']);
  assert.equal(res.code, 127);
  assert.match(res.stderr, /no graphify binary/);
  assert.equal(calls.length, 0);
});

test('F23: non-update graphify calls run the resolved binary when present', async () => {
  const res = await runGraphifyWith({ resolveBin: () => '/x/graphify', runCmd: async (b, a) => ({ code: 0, stdout: b + a.join(','), stderr: '' }) }, ['--version']);
  assert.equal(res.stdout, '/x/graphify--version');
});

test('F23: ticket enrichment execs the resolved binary with no shell option, asynchronously', async () => {
  const calls = [];
  const exec = makeTicketEnrichExec({ resolveBin: async () => 'C:/t/graphify.exe', execFileImpl: (f, a, o, cb) => { calls.push({ f, a, o }); setImmediate(() => cb(null, 'x', '')); } });
  const p = exec('D:/repo', 'q');
  assert.equal(typeof p.then, 'function');
  assert.equal(await p, 'x');
  assert.equal(calls[0].f, 'C:/t/graphify.exe');
  assert.deepEqual(calls[0].a, ['query', 'q']);
  assert.ok(!('shell' in calls[0].o) || calls[0].o.shell !== true);
});

test('F23: ticket enrichment fails by name and never spawns when graphify is unresolved', async () => {
  let spawned = 0;
  const exec = makeTicketEnrichExec({ resolveBin: () => null, execFileImpl: () => { spawned++; } });
  await assert.rejects(() => exec('D:/repo', 'q'), /no graphify binary/);
  assert.equal(spawned, 0);
});

test('graphify lookup is single-flight: concurrent callers share one probe', async () => {
  let n = 0;
  const r = createGraphifyResolver({ platform: 'linux', exec: () => new Promise((res) => { n++; setTimeout(() => res('/usr/bin/graphify'), 10); }) });
  const [a, b] = await Promise.all([r(), r()]);
  assert.equal(a, '/usr/bin/graphify');
  assert.equal(b, '/usr/bin/graphify');
  assert.equal(n, 1);
});

// 11-03: spawn's own `timeout` signals only graphify.exe, the uv launcher, so
// the python rebuild under it ran on for about 23 minutes after a 600 s timeout
// while the single-flight lock was already released.
function hangingSpawn() {
  const calls = [];
  const fn = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    calls.push({ file, args, opts, child });
    return child;
  };
  return { fn, calls };
}

test('a timed-out update kills the whole process tree and reports the timeout', async () => {
  const s = hangingSpawn();
  const killed = [];
  const killTree = (child) => { killed.push(child.pid); setImmediate(() => child.emit('close', null)); return Promise.resolve(); };
  const r = await spawnGraphifyUpdateWith({ resolveBin: () => 'C:/tools/graphify.exe', spawnImpl: s.fn, killTree }, 'D:/repo', { timeout: 20 });
  assert.deepEqual(killed, [4242]);
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.match(r.stderr, /timed out after .*process tree killed/);
  assert.equal(s.calls[0].opts.timeout, undefined, 'spawn must not get its own timeout: it signals the launcher only');
});

test('an update that finishes in time never kills anything', async () => {
  const s = fakeSpawn();
  let kills = 0;
  const r = await spawnGraphifyUpdateWith({ resolveBin: () => 'C:/tools/graphify.exe', spawnImpl: s.fn, killTree: () => { kills++; } }, 'D:/repo', { timeout: 1000 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, undefined);
  assert.equal(kills, 0);
});
