// agy answers are correlated by newest-DB mtime, so calls must never overlap
// anywhere in the process (the wiki builder and the huddle's Gemini seat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { agyGenerate, defaultKillTree } from '../lib/observability/wiki-agy.js';
import { waitFor } from './helpers/wait-for.js';

test('two concurrent agyGenerate calls never run at the same time', async () => {
  let inFlight = 0; let maxInFlight = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => { inFlight--; child.emit('close', 0); }, 20);
    return child;
  };
  const readDb = () => Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b]); // field 20 { field 1: "ok" }
  const opts = { spawnImpl, readDb, cwd: '.' };
  const [a, b] = await Promise.all([agyGenerate('one', opts), agyGenerate('two', opts)]);
  assert.equal(a, 'ok');
  assert.equal(b, 'ok');
  assert.equal(maxInFlight, 1);
});

test('a failed call does not wedge the chain', async () => {
  const bad = { spawnImpl: () => { const c = new EventEmitter(); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; }, readDb: () => null, cwd: '.' };
  await assert.rejects(agyGenerate('x', bad), /ENOENT/);
  const good = { spawnImpl: () => { const c = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c; }, readDb: () => Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b]), cwd: '.' };
  assert.equal(await agyGenerate('y', good), 'ok');
});

test('a test process refuses the real spawn, and the refusal does not hold the lock', async () => {
  await assert.rejects(agyGenerate('x', { cwd: '.' }), /isTestProcess/);
  const good = { spawnImpl: () => { const c = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c; }, readDb: () => Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b]), cwd: '.' };
  assert.equal(await agyGenerate('y', good), 'ok');
});

// A child that never exits (the live seat hang) unless killed; `--help` answers at once.
function stuckSpawn(log) {
  return (cmd, args) => {
    const child = new EventEmitter();
    if (args[0] === '--help') { setImmediate(() => child.emit('close', 0)); return child; }
    log.spawned += 1;
    child.kill = () => { log.killed.push('kill'); };
    return child;
  };
}
const OK_DB = () => Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b]);
const goodSpawn = () => (cmd, args) => { const c = new EventEmitter(); setImmediate(() => c.emit('close', 0)); return c; };

test('abort kills only the spawned child tree, rejects promptly, and releases the chain', async () => {
  const log = { spawned: 0, killed: [] };
  const killed = [];
  const ac = new AbortController();
  const p = agyGenerate('x', { spawnImpl: stuckSpawn(log), readDb: OK_DB, cwd: '.', signal: ac.signal,
    killTree: (child) => { killed.push(child); setImmediate(() => child.emit('close', null, 'SIGTERM')); } });
  await waitFor(() => log.spawned === 1, { message: 'the call to spawn' });
  const t0 = Date.now();
  ac.abort();
  await assert.rejects(p, /aborted/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(killed.length, 1, 'the call killed its own child');
  assert.equal(await agyGenerate('y', { spawnImpl: goodSpawn(), readDb: OK_DB, cwd: '.' }), 'ok', 'the chain is free again');
});

test('a call aborted while queued behind another never spawns', async () => {
  const log = { spawned: 0, killed: [] };
  const first = new AbortController();
  const second = new AbortController();
  const killTree = (child) => setImmediate(() => child.emit('close', null, 'SIGTERM'));
  const spawnImpl = stuckSpawn(log);
  const a = agyGenerate('a', { spawnImpl, readDb: OK_DB, cwd: '.', signal: first.signal, killTree });
  const b = agyGenerate('b', { spawnImpl, readDb: OK_DB, cwd: '.', signal: second.signal, killTree });
  await waitFor(() => log.spawned === 1, { message: 'the first call to spawn' });
  second.abort();
  first.abort();
  await assert.rejects(a, /aborted/);
  await assert.rejects(b, /aborted/);
  assert.equal(log.spawned, 1, 'only the first call ever reached agy');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timers = () => process.getActiveResourcesInfo().filter((t) => t === 'Timeout').length;

test('an abort during the format probe spawns nothing and releases the queue at once', async () => {
  let spawned = 0;
  const spawnImpl = (cmd, args) => {
    const c = new EventEmitter();
    if (args[0] === '--help') { setTimeout(() => c.emit('close', 0), 300); return c; }
    spawned += 1;
    setImmediate(() => c.emit('close', 0));
    return c;
  };
  const ac = new AbortController();
  const p = agyGenerate('x', { spawnImpl, readDb: OK_DB, cwd: '.', signal: ac.signal });
  await sleep(20);
  const t0 = Date.now();
  ac.abort();
  await assert.rejects(p, /aborted/);
  assert.ok(Date.now() - t0 < 200, 'not held until the probe finishes');
  assert.equal(await agyGenerate('y', { spawnImpl: goodSpawn(), readDb: OK_DB, cwd: '.' }), 'ok', 'the queue is free');
  await sleep(350);
  assert.equal(spawned, 0, 'agy itself was never spawned, even after the probe finished');
});

test('the timeout kills the child tree through killTree, not spawn\'s own timeout', async () => {
  const log = { spawned: 0, killed: [] };
  const opts = [];
  const inner = stuckSpawn(log);
  const spawnImpl = (cmd, args, o) => { opts.push(o); return inner(cmd, args, o); };
  const killed = [];
  const before = timers();
  await assert.rejects(agyGenerate('x', { spawnImpl, readDb: OK_DB, cwd: '.', timeout: 30,
    killTree: (c) => { killed.push(c); setImmediate(() => c.emit('close', null, 'SIGTERM')); } }), /timed out after 30 ms/);
  assert.equal(killed.length, 1);
  assert.equal(opts.at(-1).timeout, undefined, 'spawn gets no timeout of its own');
  assert.equal(timers(), before, 'no timer outlives the call');
});

test('a call that closes in time never reaches killTree, and leaves no timer behind', async () => {
  let kills = 0;
  const before = timers();
  assert.equal(await agyGenerate('x', { spawnImpl: goodSpawn(), readDb: OK_DB, cwd: '.', timeout: 50, killTree: () => { kills += 1; } }), 'ok');
  assert.equal(timers(), before);
  await sleep(80);
  assert.equal(kills, 0);
});

test('an aborted call whose child closes clears the give-up timer', async () => {
  const log = { spawned: 0, killed: [] };
  const ac = new AbortController();
  const before = timers();
  const p = agyGenerate('x', { spawnImpl: stuckSpawn(log), readDb: OK_DB, cwd: '.', signal: ac.signal, timeout: 0,
    killTree: (c) => setImmediate(() => c.emit('close', null, 'SIGTERM')) });
  await sleep(10);
  ac.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(timers(), before, 'the 5 s give-up timer was cleared');
});

test('defaultKillTree leaves a child that has already exited alone (its pid may be reused)', () => {
  let kills = 0;
  defaultKillTree({ pid: 4242, exitCode: 0, signalCode: null, kill: () => { kills += 1; } });
  defaultKillTree({ pid: 4242, exitCode: null, signalCode: 'SIGTERM', kill: () => { kills += 1; } });
  assert.equal(kills, 0);
  defaultKillTree({ exitCode: null, signalCode: null, kill: () => { kills += 1; } });
  assert.equal(kills, 1, 'a live child (no pid here, so child.kill) is killed');
});
