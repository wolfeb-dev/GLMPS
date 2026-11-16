// Always-run regression test (no model, no network): createEmbedder must
// reach a real ONNX/model error, never the resolve hook's own createRequire
// refusal. plugins/embed/test/adapter.test.js's real 384-dim/cosine test is
// SKIPPED whenever GLMPS_EMBED_MODEL_DIR is unset (the normal case for `npm
// test`), so it never runs in CI and never would have caught B8(a) refusing
// the vendored onnxruntime-web WASM loader (which uses
// createRequire(import.meta.url) internally to load
// ort-wasm-simd-threaded.mjs even in the single-threaded, non-JSEP
// configuration this adapter forces). This test needs no real model file: a
// present-but-garbage onnx file is enough to reach onnxruntime-web's own
// model-parsing failure, proving the vendor tree loaded successfully through
// the real resolve hook first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAdapter } from '../../host.js';

function makeGarbageModelDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-embed-garbage-'));
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vocab.txt'), '[PAD]\n[UNK]\n[CLS]\n[SEP]\n');
  fs.writeFileSync(path.join(dir, 'onnx', 'model_quantized.onnx'), Buffer.from('not a real onnx model'));
  return dir;
}

test('createEmbedder on a garbage model file fails with a model/ONNX error, not the hook\'s createRequire refusal', async () => {
  const { createEmbedder } = await loadAdapter('embed');
  // A garbage (present, non-empty, invalid) model file, not a missing one:
  // onnxruntime-web's InferenceSession.create() reads its model argument
  // eagerly (fs.readFileSync happens before the async call even starts), so
  // a genuinely missing file throws ENOENT before backend init ever runs,
  // never touching the vendored WASM loader this test targets. Garbage bytes
  // let InferenceSession.create() start (and reach its own backend/WASM
  // init, which is where the vendored createRequire call lives) before
  // failing later on the model bytes themselves.
  const modelDir = makeGarbageModelDir();
  await assert.rejects(
    createEmbedder({ modelDir }),
    (err) => {
      assert.doesNotMatch(err.message, /createRequire|allowed in vendor\/shims|getBuiltinModule/, 'must not be the resolve hook\'s containment refusal');
      assert.match(err.message, /onnx|protobuf|model|backend/i, 'must be a real model/ONNX loading error');
      return true;
    },
  );
});
