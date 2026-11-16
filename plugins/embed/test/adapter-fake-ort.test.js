import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAdapter } from '../../host.js';

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', 'world'];

function modelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-embed-fake-'));
  fs.writeFileSync(path.join(dir, 'vocab.txt'), VOCAB.join('\n') + '\n');
  return dir;
}

class FakeTensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

// Hidden state row 0 (the CLS position) is [3,4,0,...]; other rows are noise
// that CLS pooling must ignore.
function fakeRuntime({ hiddenSize = 384, outputNames = ['last_hidden_state'], log = [] } = {}) {
  const session = {
    outputNames,
    async run(feeds) {
      log.push(feeds);
      const len = feeds.input_ids.dims[1];
      const data = new Float32Array(len * hiddenSize).fill(9);
      data.fill(0, 0, hiddenSize);
      data[0] = 3; data[1] = 4;
      return { [outputNames[0] === 'last_hidden_state' ? 'last_hidden_state' : outputNames[0]]: new FakeTensor('float32', data, [1, len, hiddenSize]), other: { dims: [1, 1], data: new Float32Array(1) } };
    },
  };
  return { ort: { Tensor: FakeTensor }, session };
}

test('embed feeds int64 id/mask/type tensors, CLS-pools and L2-normalises', async () => {
  const { createEmbedder } = await loadAdapter('embed');
  const log = [];
  const e = await createEmbedder({ modelDir: modelDir(), ...fakeRuntime({ log }) });
  const v = await e.embedQuery('hello world');
  const feeds = log[0];
  assert.deepEqual(Object.keys(feeds).sort(), ['attention_mask', 'input_ids', 'token_type_ids']);
  for (const t of Object.values(feeds)) {
    assert.equal(t.type, 'int64');
    assert.ok(t.data instanceof BigInt64Array);
    assert.deepEqual(t.dims, [1, 4]);
  }
  assert.deepEqual([...feeds.input_ids.data], [2n, 4n, 5n, 3n]);
  assert.deepEqual([...feeds.attention_mask.data], [1n, 1n, 1n, 1n]);
  assert.deepEqual([...feeds.token_type_ids.data], [0n, 0n, 0n, 0n]);
  assert.equal(v.length, 384);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6);
  assert.ok(v.slice(2).every((x) => x === 0));
});

test('embed falls back to the first output name when last_hidden_state is absent', async () => {
  const { createEmbedder } = await loadAdapter('embed');
  const e = await createEmbedder({ modelDir: modelDir(), ...fakeRuntime({ outputNames: ['token_embeddings'] }) });
  const v = await e.embedQuery('hello');
  assert.ok(Math.abs(v[0] - 0.6) < 1e-6);
});

test('embed fails with a named error when the model output dimension differs from DIMS', async () => {
  const { createEmbedder } = await loadAdapter('embed');
  const e = await createEmbedder({ modelDir: modelDir(), ...fakeRuntime({ hiddenSize: 768 }) });
  await assert.rejects(e.embedQuery('hello'), (err) => err.name === 'EmbedDimensionError' && /768/.test(err.message) && /384/.test(err.message));
});

test('embedDocuments runs one session.run at a time, in input order', async () => {
  const { createEmbedder } = await loadAdapter('embed');
  const rt = fakeRuntime();
  let active = 0; let peak = 0; const order = [];
  const run = rt.session.run;
  rt.session.run = async (feeds) => {
    active++; peak = Math.max(peak, active); order.push(feeds.input_ids.dims[1]);
    await new Promise((r) => setImmediate(r));
    try { return await run(feeds); } finally { active--; }
  };
  const e = await createEmbedder({ modelDir: modelDir(), ...rt });
  const out = await e.embedDocuments(['hello', 'hello world', 'hello']);
  assert.equal(out.length, 3);
  assert.equal(peak, 1);
  assert.deepEqual(order, [3, 4, 3]);
});
