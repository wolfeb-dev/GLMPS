import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaunchBroker } from '../lib/orchestration/launch-broker.js';
import { createAgyBroker } from '../lib/huddle/agy-broker.js';
import { AGY_MODELS } from '../lib/huddle/agy-seat.js';

const MODEL = 'Gemini 3.8 Flash (Medium)';
const mk = (opts = {}) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agybroker-')), 'queue.json');
  const launchBroker = createLaunchBroker({ file });
  return { file, launchBroker, broker: createAgyBroker({ launchBroker, pollMs: 5, ...opts }) };
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('AGY_MODELS is the verified agy 1.4.7 list', () => {
  assert.deepEqual([...AGY_MODELS], [
    'Gemini 4 Argon (Medium)', 'Gemini 4 Argon (High)', 'Gemini 4 Argon (Low)',
    'Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (Medium)', 'Gemini 3.8 Flash (Low)',
    'Claude Opus 5.5 (Low)', 'Claude Opus 5.5 (Medium)', 'Claude Opus 5.5 (High)',
    'Claude Sonnet 5.5 (Low)', 'Claude Sonnet 5.5 (Medium)', 'Claude Sonnet 5.5 (High)',
    'GPT-OSS 120B (Medium)',
  ]);
});

test('launch broker: an agy record carries model and prompt, keeps them across a reload, and keeps the result text', () => {
  const { file, launchBroker } = mk();
  const { id } = launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model: MODEL, prompt: 'hello' });
  launchBroker.claim(id, 'desktop-shell');
  launchBroker.complete(id, { text: 'hi there' });
  const again = createLaunchBroker({ file }).get(id);
  assert.deepEqual([again.origin, again.model, again.prompt, again.text, again.state], ['agy', MODEL, 'hello', 'hi there', 'done']);
});

test('launch broker: a model outside the allowlist, or a prompt that is not a string under 32000 chars, is refused at enqueue', () => {
  const { launchBroker } = mk();
  assert.throws(() => launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model: 'gpt-9', prompt: 'x' }), TypeError);
  assert.throws(() => launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model: MODEL, prompt: 'x'.repeat(32000) }), TypeError);
  assert.throws(() => launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model: MODEL, prompt: 5 }), TypeError);
  assert.equal(launchBroker.pending().length, 0);
});

test('generate enqueues an agy record and resolves with the text the shell reports', async () => {
  const { launchBroker, broker } = mk();
  const p = broker.generate('say hi', { model: MODEL });
  await settle();
  const [rec] = launchBroker.pending();
  assert.equal(rec.origin, 'agy');
  assert.equal(rec.model, MODEL);
  assert.equal(rec.prompt, 'say hi');
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { text: 'hi' });
  assert.equal(await p, 'hi');
});

test('unclaimed past the claim wait: AGY_NO_SHELL naming the cause, and the record is failed, not left pending', async () => {
  const { launchBroker, broker } = mk({ claimWaitMs: 20 });
  await assert.rejects(
    broker.generate('x', { model: MODEL }),
    (e) => e.code === 'AGY_NO_SHELL' && /no desktop shell picked this up within 20 ms \(is the GLMPS 2.0 desktop app running\?\)/.test(e.message),
  );
  assert.equal(launchBroker.pending().length, 0);
});

test('abort before the claim rejects with AbortError and removes the record from the queue', async () => {
  const { launchBroker, broker } = mk();
  const ac = new AbortController();
  const p = broker.generate('x', { model: MODEL, signal: ac.signal });
  await settle();
  assert.equal(launchBroker.pending().length, 1);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(launchBroker.pending().length, 0);
});

test('an already-aborted signal never enqueues', async () => {
  const { launchBroker, broker } = mk();
  const ac = new AbortController(); ac.abort();
  await assert.rejects(broker.generate('x', { model: MODEL, signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.equal(launchBroker.pending().length, 0);
});

test('the shell\'s error text propagates; a sign-in error keeps its code', async () => {
  const { launchBroker, broker } = mk();
  const p = broker.generate('x', { model: MODEL });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { error: 'agy is not signed in for this Windows account' });
  await assert.rejects(p, (e) => /agy is not signed in/.test(e.message) && e.code === 'AGY_NOT_SIGNED_IN');
  const q = broker.generate('x', { model: MODEL });
  await settle();
  const [rec2] = launchBroker.pending();
  launchBroker.claim(rec2.id, 'desktop-shell');
  launchBroker.complete(rec2.id, { error: 'agy exited with code 1' });
  await assert.rejects(q, (e) => e.message === 'agy exited with code 1' && e.code === undefined);
});

test('a claimed call with no result inside the timeout rejects and fails the record', async () => {
  const { launchBroker, broker } = mk({ timeoutMs: 60 });
  const p = broker.generate('x', { model: MODEL });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 'desktop-shell');
  await assert.rejects(p, /timed out after 60 ms/);
  assert.equal(launchBroker.get(rec.id).state, 'failed');
});

test('a model outside the allowlist rejects before anything is queued', async () => {
  const { launchBroker, broker } = mk();
  await assert.rejects(broker.generate('x', { model: 'gpt-9' }), /model/);
  assert.equal(launchBroker.pending().length, 0);
});
