// glmps-197: the memory plugin runs in a worker thread so a slow Mem0 search
// (brute-force vector scan + onnx embed) cannot stall the kernel's event loop.
// Fixture plugins stand in for mem0/embed so the tests need no model and never
// touch the operator's real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryWorker } from '../lib/plugins/memory-worker-client.js';

const MEM0_FIXTURE = `
let host = null;
export const CONTRACT = 'memory@1';
export function configureHost(h) { host = h; }
export async function add(a) {
  if (a.chat) {
    const r = await host.chatCompletion({ echo: a.chat });
    return { results: [{ id: 'c1', chat: r }] };
  }
  if (a.fail) { const e = new Error('add exploded'); e.code = 'E_FIX'; throw e; }
  return { results: [{ id: '1', args: a }] };
}
export async function search(a) {
  if (a.query === 'busy') { const t = Date.now(); while (Date.now() - t < 1500); }
  if (a.query === 'exit') process.exit(3);
  return { results: [{ q: a.query, k: a.k, dbDir: host.dbDir, dims: host.embedder.dims }] };
}
export async function remove(a) { return { ok: true, id: a.id }; }
`;

const EMBED_FIXTURE = `
export const CONTRACT = 'embed@1';
export async function createEmbedder({ modelDir }) {
  if (String(modelDir).includes('missing')) throw new Error('model.onnx not found\\nsecond line');
  return { dims: 4, embedQuery: async () => [0, 0, 0, 0], embedDocuments: async (t) => t.map(() => [0, 0, 0, 0]) };
}
`;

function fixturePlugins({ mem0 = MEM0_FIXTURE, embed = EMBED_FIXTURE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-memworker-'));
  const mk = (name, contract, src) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'plugin.json'), JSON.stringify({ name, contract, upstream: [], shims: {}, patches: [] }));
    fs.writeFileSync(path.join(root, name, 'adapter.js'), src);
  };
  mk('mem0', 'memory@1', mem0);
  mk('embed', 'embed@1', embed);
  return root;
}

function make(opts = {}) {
  const pluginsDir = opts.pluginsDir ?? fixturePlugins();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-memworker-db-'));
  const client = createMemoryWorker({
    modelDir: opts.modelDir ?? path.join(dbDir, 'model'),
    dbDir,
    pluginsDir,
    chatCompletion: opts.chatCompletion ?? (async (body) => ({ got: body })),
  });
  return { client, dbDir, pluginsDir };
}

test('AC-2: a slow search does not stop the main-thread event loop', async () => {
  const { client } = make();
  try {
    assert.deepEqual(await client.ready, { ok: true });
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 50);
    const r = await client.search({ query: 'busy', project: 'p' });
    clearInterval(timer);
    assert.equal(r.results[0].q, 'busy');
    assert.ok(ticks >= 10, `main thread should keep ticking during the search, got ${ticks} ticks`);
  } finally { await client.close(); }
});

test('add, search and remove round-trip with args and values intact', async () => {
  const { client, dbDir } = make();
  try {
    const a = await client.add({ project: 'p', messages: [{ role: 'user', content: 'hi' }], infer: false });
    assert.deepEqual(a.results[0].args, { project: 'p', messages: [{ role: 'user', content: 'hi' }], infer: false });
    const s = await client.search({ query: 'q', project: 'p', k: 7 });
    assert.deepEqual(s.results[0], { q: 'q', k: 7, dbDir, dims: 4 });
    assert.deepEqual(await client.remove({ id: 'abc' }), { ok: true, id: 'abc' });
  } finally { await client.close(); }
});

test('chat proxy: the worker reaches the main-side chatCompletion and gets its return', async () => {
  const seen = [];
  const { client } = make({ chatCompletion: async (body) => { seen.push(body); return { reply: 'pong' }; } });
  try {
    const r = await client.add({ chat: 'ping' });
    assert.deepEqual(seen, [{ echo: 'ping' }]);
    assert.deepEqual(r.results[0].chat, { reply: 'pong' });
  } finally { await client.close(); }
});

test('a chatCompletion rejection propagates as an add rejection', async () => {
  const { client } = make({ chatCompletion: async () => { throw new Error('model down'); } });
  try {
    await assert.rejects(client.add({ chat: 'ping' }), /model down/);
  } finally { await client.close(); }
});

test('worker-side errors keep their message and code', async () => {
  const { client } = make();
  try {
    await assert.rejects(client.add({ fail: true }), (e) => e.message === 'add exploded' && e.code === 'E_FIX');
  } finally { await client.close(); }
});

test('embedder creation failure: ready reports the embed stage and calls reject with the stub text', async () => {
  const { client } = make({ modelDir: path.join(os.tmpdir(), 'missing-model') });
  try {
    const r = await client.ready;
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'embed');
    assert.match(r.reason, /model\.onnx not found/);
    await assert.rejects(client.search({ query: 'q', project: 'p' }), { message: 'mem0 plugin: configureHost was not called' });
    await assert.rejects(client.add({ project: 'p', messages: [{}] }), { message: 'mem0 plugin: configureHost was not called' });
  } finally { await client.close(); }
});

test('mem0 load failure: ready reports the load stage and calls reject with the failed-to-load text', async () => {
  const bad = fixturePlugins({ mem0: 'throw new Error("boom at import");' });
  const { client } = make({ pluginsDir: bad });
  try {
    const r = await client.ready;
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'load');
    assert.match(r.reason, /boom at import/);
    await assert.rejects(client.remove({ id: 'x' }), { message: `mem0 plugin: failed to load (${r.reason})` });
  } finally { await client.close(); }
});

test('a worker crash rejects the pending call with the exit code, and the next call respawns', async () => {
  const { client } = make();
  try {
    await client.ready;
    await assert.rejects(client.search({ query: 'exit', project: 'p' }), /exited.*3/);
    const r = await client.search({ query: 'again', project: 'p' });
    assert.equal(r.results[0].q, 'again');
  } finally { await client.close(); }
});

test('the real vendored mem0 adapter loads inside a worker (module hooks apply there)', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-memworker-real-'));
  // A model dir with no files: the real embed adapter fails at the embed
  // stage, which proves both real adapters were found, loaded and scanned by
  // the resolve hook inside the worker (stage 'load' would mean they were not).
  const client = createMemoryWorker({
    modelDir: path.join(dbDir, 'no-model'),
    dbDir,
    chatCompletion: async () => ({}),
  });
  try {
    const r = await client.ready;
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'embed', `expected embed-stage failure, got ${JSON.stringify(r)}`);
  } finally { await client.close(); }
});

test('real vendored mem0 stores and finds a memory inside the worker (fixture embedder)', async () => {
  const pluginsDir = fixturePlugins();
  fs.rmSync(path.join(pluginsDir, 'mem0'), { recursive: true });
  fs.cpSync(fileURLToPath(new URL('../../plugins/mem0', import.meta.url)), path.join(pluginsDir, 'mem0'), { recursive: true });
  const embed = `
export const CONTRACT = 'embed@1';
const vec = (t) => { const v = [0, 0, 0, 0]; for (const c of String(t)) v[c.charCodeAt(0) % 4] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
export async function createEmbedder() { return { dims: 4, embedQuery: async (t) => vec(t), embedDocuments: async (ts) => ts.map(vec) }; }
`;
  fs.writeFileSync(path.join(pluginsDir, 'embed', 'adapter.js'), embed);
  const { client } = make({ pluginsDir });
  try {
    assert.deepEqual(await client.ready, { ok: true });
    await client.add({ project: 'D--p', messages: [{ role: 'user', content: 'CI runs on Linux' }], infer: false });
    const s = await client.search({ query: 'CI runs on Linux', project: 'D--p', k: 3 });
    assert.equal(s.results.length, 1);
    assert.match(s.results[0].memory, /Linux/);
  } finally { await client.close(); }
});
