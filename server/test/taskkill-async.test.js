// Process-tree kills must not block the event loop: taskkill is an async spawn
// whose result is awaited, so a caller can still wait for the tree to be gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { killProcessTree } from '../lib/plugins/claude-model.js';
import { defaultKillTree as wikiKillTree } from '../lib/observability/wiki-loop.js';

function fakeTaskkill(exitCode) {
  const calls = [];
  const impl = (file, args, opts) => {
    calls.push({ file, args, opts });
    const ee = new EventEmitter();
    setTimeout(() => ee.emit('close', exitCode), 15);
    return ee;
  };
  return { impl, calls };
}

test('claude-model killProcessTree on win32 spawns taskkill and resolves after it exits', async () => {
  const t = fakeTaskkill(0);
  let settled = false;
  const p = Promise.resolve(killProcessTree({ pid: 77, kill() {} }, 'win32', { spawnImpl: t.impl })).then(() => { settled = true; });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].file, 'taskkill');
  assert.deepEqual(t.calls[0].args, ['/pid', '77', '/T', '/F']);
  assert.equal(settled, false, 'the caller is not blocked: nothing has resolved yet');
  await p;
  assert.equal(settled, true);
});

test('claude-model killProcessTree uses child.kill off win32', async () => {
  let killed = null;
  await killProcessTree({ pid: 5, kill: (s) => { killed = s; } }, 'linux', { spawnImpl: () => { throw new Error('no spawn'); } });
  assert.equal(killed, 'SIGKILL');
});

test('wiki-loop defaultKillTree resolves null when taskkill succeeds or the pid is already gone (128)', async () => {
  for (const code of [0, 128]) {
    const t = fakeTaskkill(code);
    assert.equal(await wikiKillTree({ pid: 9, kill() {} }, { platform: 'win32', spawnImpl: t.impl }), null);
    assert.deepEqual(t.calls[0].args, ['/pid', '9', '/T', '/F']);
  }
});

test('wiki-loop defaultKillTree returns a named reason when taskkill fails', async () => {
  const t = fakeTaskkill(1);
  assert.match(await wikiKillTree({ pid: 9, kill() {} }, { platform: 'win32', spawnImpl: t.impl }), /taskkill \/T exited 1 for pid 9/);
});
