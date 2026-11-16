// embed@1: local BGE-small-en-v1.5 (384 dims) running on onnxruntime-web's
// WebAssembly backend, single-threaded and non-JSEP, so no Worker and no
// SharedArrayBuffer are required and no native binary ever loads (D24).
//
// This file imports the vendored dist file by relative path
// (./vendor/onnxruntime-web/dist/ort.wasm.mjs) rather than a bare
// `import 'onnxruntime-web'`, because this file sits outside vendor/shims
// (unowned by the resolve hook), so a bare import here would resolve two
// different, both-wrong ways depending on where it happened:
//   - From this file (adapter.js is not intercepted by the resolve hook),
//     a bare import falls through to Node's own native conditional-exports
//     resolution. onnxruntime-web's package.json lists "node" before
//     "import" in its exports map, and Node's own condition set always
//     includes "node", so real Node resolution would pick
//     dist/ort.node.min.mjs -- not vendored here, and (confirmed by reading
//     it) it is not native-binary code, but it does have a genuine external
//     dependency on the separate `onnxruntime-common` npm package (a real
//     `import ... from "onnxruntime-common"` statement, unlike this
//     self-contained ort.wasm.mjs), which is not vendored either, so it
//     would throw ERR_MODULE_NOT_FOUND under plain Node.
//   - From a file already inside vendor/ (a sibling vendored file importing
//     'onnxruntime-web' as a bare package name), plugins/host.js's own
//     `entryOf()` would instead govern resolution, and its simplified
//     `pick()` helper only inspects `.import`/`.default` -- it never looks
//     at `.node` -- so it would land on dist/ort.bundle.min.mjs, the
//     browser bundle, which is wrong for a different reason (worker/CDN
//     assumptions baked in).
// The relative import of dist/ort.wasm.mjs sidesteps both paths entirely and
// is the only one confirmed, by reading the source and by the passing
// contract test, to need neither a native binary nor an unvendored package.
//
// The tokenizer (./tokenizer.js) is our own code, not upstream, so it lives
// outside vendor/ too.
//
// modelDir must contain vocab.txt and onnx/model_quantized.onnx, both fetched
// by scripts/fetch-embed-model.mjs (data, never committed to this repo).
import fs from 'node:fs';
import path from 'node:path';
import { loadVocab, tokenize } from './tokenizer.js';

export const CONTRACT = 'embed@1';
const DIMS = 384;

function l2normalize(values) {
  let sumSquares = 0;
  for (const x of values) sumSquares += x * x;
  const norm = Math.sqrt(sumSquares) || 1;
  return Array.from(values, (x) => x / norm);
}

// CLS pooling: BGE's own recommended pooling strategy is the [CLS] token's
// row of the last hidden state (index 0 of the sequence dimension), not mean
// pooling over all tokens.
function clsPool(hiddenData, hiddenSize) {
  // hiddenData is flat [batch=1, seqLen, hiddenSize]; CLS is position 0, so
  // its row is simply the first hiddenSize values.
  return Array.from(hiddenData.subarray(0, hiddenSize));
}

// `ort` and `session` are test seams: a fake runtime can be injected so the
// feed/pool/normalise path runs without the model file or the wasm backend.
export async function createEmbedder({ modelDir, ort: injectedOrt, session: injectedSession }) {
  if (!modelDir) throw new Error('embed plugin: createEmbedder needs modelDir');
  const vocabPath = path.join(modelDir, 'vocab.txt');
  const modelPath = path.join(modelDir, 'onnx', 'model_quantized.onnx');
  const vocab = loadVocab(fs.readFileSync(vocabPath, 'utf8'));

  let ort = injectedOrt;
  let session = injectedSession;
  if (!ort) {
    ort = await import('./vendor/onnxruntime-web/dist/ort.wasm.mjs');
    // Single-threaded: no Worker, no SharedArrayBuffer, no cross-origin
    // isolation requirement. This is the controller ruling for this plugin.
    ort.env.wasm.numThreads = 1;
  }
  if (!session) {
    session = await ort.InferenceSession.create(fs.readFileSync(modelPath), {
      executionProviders: ['wasm'],
    });
  }

  const outputName = session.outputNames.includes('last_hidden_state')
    ? 'last_hidden_state'
    : session.outputNames[0];

  async function embedOne(text) {
    const { inputIds, attentionMask, tokenTypeIds } = tokenize(text, vocab);
    const len = inputIds.length;
    const dims = [1, len];
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), dims),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), dims),
      token_type_ids: new ort.Tensor('int64', BigInt64Array.from(tokenTypeIds.map(BigInt)), dims),
    };
    const outputs = await session.run(feeds);
    const hidden = outputs[outputName];
    const hiddenSize = hidden.dims[hidden.dims.length - 1];
    if (hiddenSize !== DIMS) {
      const err = new Error(`embed plugin: model output dimension ${hiddenSize} does not match expected ${DIMS}`);
      err.name = 'EmbedDimensionError';
      throw err;
    }
    return l2normalize(clsPool(hidden.data, hiddenSize));
  }

  return {
    dims: DIMS,
    embedQuery: (text) => embedOne(text),
    embedDocuments: async (texts) => {
      const out = [];
      for (const t of texts) out.push(await embedOne(t));
      return out;
    },
  };
}
