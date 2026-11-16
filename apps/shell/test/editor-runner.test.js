// apps/shell/test/editor-runner.test.js
// The shell's half of "open in editor" when the kernel is a service: it claims
// an 'editor' launch record through the authenticated protocol and spawns the
// configured editor detached, in the operator's own session. Nothing here starts
// a real editor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditorRunner, validateEditorJob } from '../src/lib/editor-runner.js';
import { computeProof, sha256Hex } from '../src/lib/launch-auth.js';

const token = 'b'.repeat(64);
const ID = 'ln_3f2a9b1c-1111-4222-8333-444455556666';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-editorrunner-'));
const file = path.join(dir, 'notes.md');
fs.writeFileSync(file, 'x');
const EDITOR = { command: 'agy-editor', args: ['-g', '{path}'] };
const readLaunchToken = () => ({ token, reason: null });
const rec = (over = {}) => ({ id: ID, origin: 'editor', command: 'open-in-editor', cwd: dir, path: file, state: 'pending', ...over });

function respondSigned(url, opts, body) {
  const nonce = opts?.headers?.['x-launch-nonce'];
  const u = new URL(url);
  const proof = nonce ? computeProof(token, { direction: 'res', method: opts?.method || 'GET', path: u.pathname + u.search, nonce, bodyHash: sha256Hex(JSON.stringify(body)) }) : null;
  return { ok: true, status: 200, json: async () => body, headers: { get: (n) => (n === 'x-launch-response-proof' ? proof : null) } };
}

function fakeKernel(record, editor = EDITOR, claimBody = record) {
  const calls = [];
  let handed = false;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.pathname === '/api/launches') {
      const pending = handed ? [] : [record];
      handed = true;
      return respondSigned(url, opts, { pending, allowedCommands: ['claude'], editor });
    }
    if (u.pathname.endsWith('/claim')) return respondSigned(url, opts, { ...claimBody, state: 'claimed' });
    return { ok: true, status: 204, json: async () => null, headers: { get: () => null } };
  };
  return { fetchImpl, results: () => calls.filter((c) => c.path.endsWith('/result')).map((c) => c.body), claims: () => calls.filter((c) => c.path.endsWith('/claim')).length };
}

function fakeSpawn() {
  const runs = [];
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4242; child.unref = () => {};
    runs.push({ file, args, opts });
    return child;
  };
  return { spawnImpl, runs };
}

const run = async (kernel, spawn) => {
  const logs = [];
  const r = createEditorRunner({ kernelUrl: 'http://127.0.0.1:8123', fetchImpl: kernel.fetchImpl, spawnImpl: spawn.spawnImpl, readLaunchToken, stateDir: dir, log: (m) => logs.push(m) });
  await r.tick();
  return logs;
};

test('claims an editor record and spawns the configured editor detached with the quoted path', async () => {
  const kernel = fakeKernel(rec()); const spawn = fakeSpawn();
  await run(kernel, spawn);
  assert.equal(spawn.runs.length, 1);
  assert.equal(spawn.runs[0].file, 'agy-editor');
  assert.deepEqual(spawn.runs[0].args, ['-g', `"${file}"`]);
  assert.equal(spawn.runs[0].opts.detached, true);
  assert.equal(spawn.runs[0].opts.stdio, 'ignore');
  assert.deepEqual(kernel.results(), [{ pid: 4242 }]);
});

test('ignores records of other origins and never claims them', async () => {
  const kernel = fakeKernel(rec({ origin: 'terminal' })); const spawn = fakeSpawn();
  await run(kernel, spawn);
  assert.equal(kernel.claims(), 0);
  assert.equal(spawn.runs.length, 0);
});

test('refuses a path that is relative, missing, or carries a shell metacharacter, reporting why', async () => {
  for (const bad of ['notes.md', path.join(dir, 'missing.md'), `${file} & calc`, `${file}"`, `${dir}${path.sep}a%b.md`]) {
    const kernel = fakeKernel(rec({ path: bad })); const spawn = fakeSpawn();
    await run(kernel, spawn);
    assert.equal(spawn.runs.length, 0, bad);
    assert.match(kernel.results()[0].error, /refused by shell/, bad);
  }
});

test('the claimed record decides the path, not the pending one', async () => {
  const kernel = fakeKernel(rec(), EDITOR, rec({ path: path.join(dir, 'other.md') })); const spawn = fakeSpawn();
  await run(kernel, spawn);
  assert.equal(spawn.runs.length, 0, 'a record that changed between poll and claim is not run');
});

test('refuses without editor settings, or with an editor command or arg carrying a metacharacter', async () => {
  for (const editor of [null, { command: 'ed & calc', args: ['{path}'] }, { command: 'ed', args: ['-g', '{path}; calc'] }, { command: 'ed', args: ['--flag'] }, { command: 'ed', args: 'x' }]) {
    const kernel = fakeKernel(rec(), editor); const spawn = fakeSpawn();
    await run(kernel, spawn);
    assert.equal(spawn.runs.length, 0, JSON.stringify(editor));
    assert.match(kernel.results()[0]?.error ?? '', /refused by shell/, JSON.stringify(editor));
  }
});

test('a full editor path with spaces is quoted for the shell:true spawn', async () => {
  const cmd = 'C:\\Users\\op x\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
  const kernel = fakeKernel(rec(), { command: cmd, args: ['-g', '{path}'] }); const spawn = fakeSpawn();
  await run(kernel, spawn);
  assert.equal(spawn.runs.length, 1);
  assert.equal(spawn.runs[0].file, `"${cmd}"`);
  assert.equal(spawn.runs[0].opts.shell, true);
});

test('a plain editor command stays unquoted, and a command with a double quote is refused so quoting cannot be broken', async () => {
  assert.equal(validateEditorJob(rec(), EDITOR).file, 'agy-editor');
  for (const command of ['C:\\a b\\x" & calc & "', 'C:\\a b\\x"']) {
    const kernel = fakeKernel(rec(), { command, args: ['{path}'] }); const spawn = fakeSpawn();
    await run(kernel, spawn);
    assert.equal(spawn.runs.length, 0, command);
    assert.match(kernel.results()[0].error, /refused by shell/, command);
  }
});

test('a folder path is accepted', () => {
  assert.equal(validateEditorJob(rec({ path: dir }), EDITOR).ok, true);
});

test('does nothing without a valid launch token', async () => {
  const kernel = fakeKernel(rec()); const spawn = fakeSpawn();
  const r = createEditorRunner({ kernelUrl: 'http://127.0.0.1:8123', fetchImpl: kernel.fetchImpl, spawnImpl: spawn.spawnImpl, readLaunchToken: () => ({ token: null, reason: 'no token' }), stateDir: dir, log: () => {} });
  await r.tick();
  assert.equal(spawn.runs.length, 0);
});
