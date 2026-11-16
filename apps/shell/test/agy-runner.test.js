// apps/shell/test/agy-runner.test.js
// The shell's half of the huddle's agy seats: the service kernel queues an 'agy'
// launch record, this runner (in the operator's own session, the only place agy
// can load the operator's sign-in) claims it through the authenticated launch
// protocol, runs agy and posts the text back. Nothing here starts a real agy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgyRunner, validateAgyJob, extractAgyText, AGY_MODELS, AGY_SIGNIN_MARKER, newestGeminiModel } from '../src/lib/agy-runner.js';
import { computeProof, sha256Hex } from '../src/lib/launch-auth.js';
import { extractAgyText as serverExtract } from '../../../server/lib/observability/wiki-agy.js';
import { AGY_MODELS as SERVER_MODELS, newestGeminiModel as serverNewest } from '../../../server/lib/huddle/agy-models.js';

const token = 'a'.repeat(64);
const MODEL = 'Gemini 3.8 Flash (Medium)';
const ID = 'ln_3f2a9b1c-1111-4222-8333-444455556666';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agyrunner-state-'));
const readLaunchToken = () => ({ token, reason: null });

function respondSigned(tok, url, opts, body, { ok = true, status = 200 } = {}) {
  const nonce = opts?.headers?.['x-launch-nonce'];
  const u = new URL(url);
  const proof = nonce ? computeProof(tok, { direction: 'res', method: opts?.method || 'GET', path: u.pathname + u.search, nonce, bodyHash: sha256Hex(JSON.stringify(body)) }) : null;
  return { ok, status, json: async () => body, headers: { get: (n) => (n === 'x-launch-response-proof' ? proof : null) } };
}

// A kernel: one pending record, then nothing. Results are captured.
function fakeKernel(rec, { signWith = token } = {}) {
  const calls = [];
  let handed = false;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.pathname === '/api/launches') {
      const pending = handed ? [] : [rec];
      handed = true;
      return respondSigned(signWith, url, opts, { pending, allowedCommands: ['claude'] });
    }
    if (u.pathname.endsWith('/claim')) return respondSigned(signWith, url, opts, { ...rec, state: 'claimed' });
    return { ok: true, status: 204, json: async () => null, headers: { get: () => null } };
  };
  return { fetchImpl, calls, results: () => calls.filter((c) => c.path.endsWith('/result')).map((c) => c.body) };
}

// A fake agy: prints the JSON line and closes, after optionally writing a log file and a DB.
function fakeSpawn({ stdout = JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-1' }), code = 0, onRun = null, hang = false } = {}) {
  const runs = [];
  const spawnImpl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const run = { bin, args, opts };
    runs.push(run);
    child.kill = () => child.emit('close', null, 'SIGTERM');
    setImmediate(() => {
      onRun?.(run, child);
      if (hang) return;
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code, null);
    });
    return child;
  };
  return { spawnImpl, runs };
}

const okBlob = Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b]); // field 20 { field 1: "ok" }
const rec = (over = {}) => ({ id: ID, origin: 'agy', command: 'agy', cwd: 'agy', model: MODEL, prompt: 'Say hi.', state: 'pending', ...over });

function runner(kernel, spawn, extra = {}) {
  const logs = [];
  const r = createAgyRunner({
    kernelUrl: 'http://127.0.0.1:8123', fetchImpl: kernel.fetchImpl, spawnImpl: spawn.spawnImpl, readLaunchToken, stateDir,
    readDb: () => okBlob, convDir: '/agy/conversations', env: { PATH: '/bin' }, log: (m) => logs.push(m), logWatchMs: 10, ...extra,
  });
  return { r, logs };
}

test('the shell\'s model allowlist and protobuf reader equal the server\'s (parity)', () => {
  assert.deepEqual([...AGY_MODELS], [...SERVER_MODELS]);
  assert.equal(AGY_SIGNIN_MARKER, 'triggering interactive OAuth');
  assert.equal(extractAgyText(okBlob), serverExtract(okBlob));
});

test('newestGeminiModel matches the server copy on every tier and on newer, unknown names', () => {
  const lists = [[...AGY_MODELS], ['Gemini 10 Zed (High)', 'Gemini 9.9 Yak (High)', 'Gemini 4 Argon (High)'], ['Claude Opus 5.5 (High)'], []];
  for (const l of lists) for (const t of ['High', 'Medium', 'Low']) assert.equal(newestGeminiModel(l, t), serverNewest(l, t), `${t} ${l.join('|')}`);
  assert.equal(newestGeminiModel(AGY_MODELS), 'Gemini 4 Argon (High)');
});

test('validateAgyJob: allowlisted model, string prompt under 32000 chars, nothing else is read from the record', () => {
  assert.equal(validateAgyJob(rec()).ok, true);
  assert.equal(validateAgyJob(rec({ model: 'rm -rf /' })).ok, false);
  assert.equal(validateAgyJob(rec({ prompt: 5 })).ok, false);
  assert.equal(validateAgyJob(rec({ prompt: '' })).ok, false);
  assert.equal(validateAgyJob(rec({ prompt: 'x'.repeat(32000) })).ok, false);
  assert.equal(validateAgyJob(rec({ origin: 'runner' })).ok, false);
});

test('a verified poll with an agy record: claim, spawn agy with --model before -p in a throwaway cwd, post the text', async () => {
  const kernel = fakeKernel(rec());
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn);
  await r.tick();
  assert.deepEqual(kernel.calls.map((c) => `${c.method} ${c.path}`), ['GET /api/launches', `POST /api/launches/${ID}/claim`, `POST /api/launches/${ID}/result`]);
  assert.equal(spawn.runs.length, 1);
  const { bin, args, opts } = spawn.runs[0];
  assert.equal(bin, 'agy');
  assert.deepEqual(args.slice(0, 5), ['--model', MODEL, '--output-format', 'json', '--log-file']);
  assert.ok(path.isAbsolute(args[5]) && args[5].startsWith(opts.cwd), 'the log file lives in the throwaway cwd');
  assert.equal(args[6], '-p');
  assert.match(args[7], /Do NOT use any tools/);
  assert.ok(args[7].endsWith('Say hi.'));
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(opts.env, { PATH: '/bin' });
  assert.equal(fs.existsSync(opts.cwd), false, 'the throwaway cwd is removed after the call');
  assert.deepEqual(kernel.results(), [{ text: 'ok' }]);
});

function varint(n) { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
const field = (num, buf) => Buffer.concat([varint(num * 8 + 2), varint(buf.length), buf]);

test('the result text is cut to 4000 characters', async () => {
  const kernel = fakeKernel(rec());
  const big = field(20, field(1, Buffer.from('a'.repeat(5000))));
  const { r } = runner(kernel, fakeSpawn(), { readDb: () => big });
  await r.tick();
  const [res] = kernel.results();
  assert.equal(res.text.length, 4000);
});

test('a record the kernel did not prove is ignored: no claim, no spawn', async () => {
  const kernel = fakeKernel(rec(), { signWith: 'b'.repeat(64) });
  const spawn = fakeSpawn();
  const { r, logs } = runner(kernel, spawn);
  await r.tick();
  assert.deepEqual(kernel.calls.map((c) => c.path), ['/api/launches']);
  assert.equal(spawn.runs.length, 0);
  assert.ok(logs.some((l) => /did not verify/.test(l)));
});

test('a record that is not agy is left for the launch runner: no claim', async () => {
  const kernel = fakeKernel({ id: ID, origin: 'terminal', command: 'claude', cwd: stateDir, state: 'pending' });
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn);
  await r.tick();
  assert.deepEqual(kernel.calls.map((c) => c.path), ['/api/launches']);
  assert.equal(spawn.runs.length, 0);
});

test('a model outside the allowlist posts an error and never spawns', async () => {
  const kernel = fakeKernel(rec({ model: 'rm -rf /' }));
  const spawn = fakeSpawn();
  const { r } = runner(kernel, spawn);
  await r.tick();
  assert.equal(spawn.runs.length, 0);
  assert.match(kernel.results()[0].error, /refused by shell: .*model/);
});

test('the sign-in marker in agy\'s log kills it and posts "agy is not signed in" at once', async () => {
  const kernel = fakeKernel(rec());
  const spawn = fakeSpawn({ hang: true, onRun: ({ args }) => setTimeout(() => fs.writeFileSync(args[args.indexOf('--log-file') + 1], `I1015 printmode.go:426] Print mode: ${AGY_SIGNIN_MARKER}\n`), 20) });
  let killed = 0;
  const { r } = runner(kernel, spawn, { killTree: (c) => { killed += 1; c.kill(); } });
  const t0 = Date.now();
  await r.tick();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(killed, 1);
  assert.match(kernel.results()[0].error, /^agy is not signed in for this Windows account/);
});

test('an agy that reports ERROR, exits non-zero or leaves no conversation posts that as the error', async () => {
  const bad = fakeKernel(rec());
  await runner(bad, fakeSpawn({ stdout: JSON.stringify({ status: 'ERROR', error: 'quota exhausted' }), code: 1 })).r.tick();
  assert.match(bad.results()[0].error, /quota exhausted/);
  const exit = fakeKernel(rec());
  await runner(exit, fakeSpawn({ stdout: '', code: 2 })).r.tick();
  assert.match(exit.results()[0].error, /exited with code 2/);
  const none = fakeKernel(rec());
  await runner(none, fakeSpawn(), { readDb: () => null }).r.tick();
  assert.match(none.results()[0].error, /no conversation/);
});

test('an agy that outlives the timeout is killed and reported', async () => {
  const kernel = fakeKernel(rec());
  const spawn = fakeSpawn({ hang: true });
  let killed = 0;
  const { r } = runner(kernel, spawn, { timeoutMs: 60, killTree: (c) => { killed += 1; c.kill(); } });
  await r.tick();
  assert.equal(killed, 1);
  assert.match(kernel.results()[0].error, /timed out after 60 ms/);
});

test('without an injected spawnImpl a test process refuses before starting anything', async () => {
  const kernel = fakeKernel(rec());
  const r = createAgyRunner({ kernelUrl: 'http://127.0.0.1:8123', fetchImpl: kernel.fetchImpl, readLaunchToken, stateDir, log: () => {} });
  await r.tick();
  assert.match(kernel.results()[0].error, /refused: test process/);
});
