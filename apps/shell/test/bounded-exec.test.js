// apps/shell/test/bounded-exec.test.js
// the smoke probe's tryExec swallowed every error with a bare
// catch, so a failing crash-recovery check said only "false". The bounded
// exec now records the last failure so the check's detail can carry it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedExec } from '../src/lib/bounded-exec.js';

test('W6: a rejected executeJavaScript resolves undefined and is recorded by name', async () => {
  const be = createBoundedExec();
  const wc = { executeJavaScript: async () => { throw new Error('Render frame was disposed'); } };
  assert.equal(await be.tryExec(wc, '1', 50), undefined);
  assert.match(be.lastError(), /Render frame was disposed/);
});

test('W6: a call that never settles times out, resolves undefined and records the timeout', async () => {
  const be = createBoundedExec();
  const wc = { executeJavaScript: () => new Promise(() => {}) };
  assert.equal(await be.tryExec(wc, '1', 20), undefined);
  assert.match(be.lastError(), /timed out after 20 ms/);
});

test('W6: a successful call returns its value and clears the recorded error', async () => {
  const be = createBoundedExec();
  await be.tryExec({ executeJavaScript: async () => { throw new Error('x'); } }, '1', 50);
  assert.equal(await be.tryExec({ executeJavaScript: async () => 42 }, '1', 50), 42);
  assert.equal(be.lastError(), null);
});
