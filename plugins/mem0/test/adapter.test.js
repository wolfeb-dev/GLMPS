import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAdapter } from '../../host.js';

function fakeEmbedder(dims = 16) {
  const vec = (t) => { const v = new Array(dims).fill(0); for (const w of String(t).toLowerCase().split(/\W+/).filter(Boolean)) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % dims] += 1; } const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  return { dims, embedQuery: async (t) => vec(t), embedDocuments: async (ts) => ts.map(vec) };
}

// Mem0 3.2.0's Memory.addToVectorStore() makes exactly one chat completion
// call per add(): a single "additive extraction" prompt that is handed both
// the new messages and any existing memories in the SAME prompt, and expects
// back `{ memory: [{ id, text, attributed_to?, linked_memory_ids? }] }`
// (AdditiveExtractionSchema, vendor/mem0ai/dist/oss/index.mjs, search
// "AdditiveExtractionSchema" / "generateAdditiveExtractionPrompt"). There is
// no separate old-memory/update call in this code path: every extracted item
// is deduped locally by content hash and written with history action "ADD".
// This replaces the two-shape EXTRACT/UPDATE sketch in the task brief, which
// described an older two-phase mem0 architecture (facts[] then a second
// compare-to-existing call) that mem0ai 3.2.0's OSS Memory class no longer
// uses.
const EXTRACT = JSON.stringify({ memory: [{ id: '1', text: 'CI runs on Linux and Windows', attributed_to: 'user' }] });
const fakeChat = async () => ({ choices: [{ message: { role: 'assistant', content: EXTRACT } }] });

test('add then search round-trips through our copy of Mem0 with no network and no native module', async () => {
  const m = await loadAdapter('mem0');
  m.configureHost({ chatCompletion: fakeChat, embedder: fakeEmbedder(), dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem0-')) });
  const added = await m.add({ sessionId: 's1', project: 'D--x', messages: [{ role: 'user', content: 'Our CI runs on Linux and Windows.' }] });
  assert.ok(added.results.length >= 1);
  const found = await m.search({ query: 'which operating systems does CI use', project: 'D--x', k: 3 });
  assert.ok(found.results.some((r) => /Linux/.test(r.memory)));
  assert.equal(m.CONTRACT, 'memory@1');
  assert.equal(process.env.MEM0_TELEMETRY, 'false');
});

test('add+search never touches the network: telemetry is off and the axios shim would refuse every request anyway', async () => {
  const m = await loadAdapter('mem0');
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem0-net-'));
  m.configureHost({ chatCompletion: fakeChat, embedder: fakeEmbedder(), dbDir });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); throw new Error('network access is disabled (fetch spy)'); };
  try {
    const added = await m.add({ sessionId: 's1', project: 'D--net', messages: [{ role: 'user', content: 'Our CI runs on Linux and Windows.' }] });
    assert.ok(added.results.length >= 1);
    await m.search({ query: 'which operating systems does CI use', project: 'D--net', k: 3 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, []);
  // Mem0's own telemetry-id file also defaults under the operator's real
  // home directory (os.homedir()/.mem0/config.json) unless MEM0_DIR is set;
  // the adapter redirects it into dbDir. This asserts the redirection landed
  // rather than the real home directory.
  assert.equal(fs.existsSync(path.join(dbDir, 'config.json')), true);
});

test('remove deletes a memory: a subsequent search no longer finds it', async () => {
  const m = await loadAdapter('mem0');
  m.configureHost({ chatCompletion: fakeChat, embedder: fakeEmbedder(), dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem0-rm-')) });
  const added = await m.add({ sessionId: 's1', project: 'D--rm', messages: [{ role: 'user', content: 'Our CI runs on Linux and Windows.' }] });
  const id = added.results[0].id;
  const before = await m.search({ query: 'which operating systems does CI use', project: 'D--rm', k: 5 });
  assert.ok(before.results.some((r) => r.id === id));
  const removed = await m.remove({ id });
  assert.deepEqual(removed, { ok: true });
  const after = await m.search({ query: 'which operating systems does CI use', project: 'D--rm', k: 5 });
  assert.equal(after.results.some((r) => r.id === id), false);
});

test('add({ infer: false }) stores the message text verbatim with zero chatCompletion calls (Task 6 migration path)', async () => {
  const m = await loadAdapter('mem0');
  let chatCalls = 0;
  m.configureHost({
    chatCompletion: async (body) => { chatCalls++; return fakeChat(body); },
    embedder: fakeEmbedder(),
    dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem0-noinfer-')),
  });
  const verbatim = 'Raw note, not to be summarized: build number 482.';
  const added = await m.add({ sessionId: 's1', project: 'D--noinfer', messages: [{ role: 'user', content: verbatim }], infer: false });
  assert.equal(chatCalls, 0);
  assert.equal(added.results.length, 1);
  assert.equal(added.results[0].memory, verbatim);
  const found = await m.search({ query: 'build number', project: 'D--noinfer', k: 3 });
  assert.ok(found.results.some((r) => r.memory === verbatim));
  assert.equal(chatCalls, 0);
});

test('add and search both require a project', async () => {
  const m = await loadAdapter('mem0');
  m.configureHost({ chatCompletion: fakeChat, embedder: fakeEmbedder(), dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem0-proj-')) });
  await assert.rejects(
    m.add({ project: undefined, messages: [{ role: 'user', content: 'x' }] }),
    /project is required/,
  );
  await assert.rejects(
    m.search({ query: 'x', project: undefined }),
    /project is required/,
  );
});

test('configureHost closes the previous Memory sqlite handles before replacing it', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const realClose = DatabaseSync.prototype.close;
  let closes = 0;
  DatabaseSync.prototype.close = function close(...a) { closes++; return realClose.apply(this, a); };
  try {
    const m = await loadAdapter('mem0');
    const host = () => ({ chatCompletion: fakeChat, embedder: fakeEmbedder(), dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mem0-close-')) });
    m.configureHost(host());
    await m.add({ sessionId: 's1', project: 'D--close', messages: [{ role: 'user', content: 'Our CI runs on Linux and Windows.' }] });
    assert.equal(closes, 0);
    m.configureHost(host());
    assert.ok(closes >= 2, `expected history and vector store handles closed, got ${closes}`);
    const added = await m.add({ sessionId: 's2', project: 'D--close2', messages: [{ role: 'user', content: 'Our CI runs on Linux and Windows.' }] });
    assert.ok(added.results.length >= 1);
  } finally {
    DatabaseSync.prototype.close = realClose;
  }
});
