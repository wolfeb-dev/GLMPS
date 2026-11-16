// Tests for the parent watch (server/lib/kernel/parent-watch.js), card glmps-2-0-58.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchParent, isPidAlive } from '../lib/kernel/parent-watch.js';
import { waitFor } from './helpers/wait-for.js';

test('isPidAlive: a live pid is alive, ESRCH is dead, EPERM still counts as alive', () => {
  assert.equal(isPidAlive(process.pid), true);
  const err = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  assert.equal(isPidAlive(123, err('ESRCH')), false);
  assert.equal(isPidAlive(123, err('EPERM')), true);
});

test('watchParent calls onGone once, on the first check that finds the parent dead', async () => {
  const answers = [true, true, false, false];
  const gone = [];
  watchParent({ ppid: 42, intervalMs: 5, isAlive: () => answers.shift() ?? false, onGone: (pid) => gone.push(pid) });
  await waitFor(() => gone.length, { message: 'onGone' });
  assert.deepEqual(gone, [42]);
  assert.equal(answers.length, 1, 'no check after the parent was found dead');
});

test('watchParent does nothing without a parent pid, and stop() cancels it', async () => {
  let calls = 0;
  watchParent({ ppid: 0, intervalMs: 5, isAlive: () => { calls++; return false; }, onGone: () => { calls++; } });
  const stop = watchParent({ ppid: 42, intervalMs: 5, isAlive: () => { calls++; return true; }, onGone: () => {} });
  stop();
  // A quiet period: asserting that nothing fires.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 0);
});

function startPair(args = []) {
  const parent = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/parent-watch-parent.mjs', import.meta.url)), ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    parent.stdout.on('data', (d) => { out += d; if (/\d+\s/.test(out)) resolve({ parent, childPid: Number(out.trim()) }); });
    parent.on('error', reject);
  });
}


// The incident shape: the wrapper dies hard and nothing signals the child.
test('without the watch, a child outlives a parent killed hard (the orphan)', async () => {
  const { parent, childPid } = await startPair(['nowatch']);
  parent.kill('SIGKILL');
  // A quiet period: the orphan must still be alive after it.
  await new Promise((r) => setTimeout(r, 1500));
  const survived = isPidAlive(childPid);
  if (survived) process.kill(childPid);
  assert.equal(survived, true, 'the control case should orphan the child');
});

test('with the watch, the child exits within 10 s of its parent being killed hard', async () => {
  const { parent, childPid } = await startPair();
  assert.ok(isPidAlive(childPid), 'child is running before the parent dies');
  parent.kill('SIGKILL');
  const survived = await waitFor(() => !isPidAlive(childPid), { timeoutMs: 10_000, intervalMs: 100 }).then(() => false, () => true);
  if (survived) process.kill(childPid);
  assert.equal(survived, false, 'child outlived its parent by 10 s');
});
