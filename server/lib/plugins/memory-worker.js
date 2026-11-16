// Worker-thread entry for the memory plugin (glmps-197). Mem0's search is a
// brute-force scan of the whole vector store plus a synchronous onnx embed, so
// it runs here and the kernel's main thread only posts work and awaits results.
import { parentPort, workerData } from 'node:worker_threads';
import { loadAdapter } from '../../../plugins/host.js';

const { modelDir, dbDir, pluginsDir } = workerData;
const loadOpts = pluginsDir ? { pluginsDir } : undefined;

let nextChatId = 1;
const chatWaiting = new Map();

const chatCompletion = (body) => new Promise((resolve, reject) => {
  const id = nextChatId++;
  chatWaiting.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'chat', id, body });
});

let mem0 = null;
const OPS = new Set(['add', 'search', 'remove']);

async function init() {
  let stage = 'load';
  try {
    mem0 = await loadAdapter('mem0', loadOpts);
    stage = 'embed';
    const embedPlugin = await loadAdapter('embed', loadOpts);
    const embedder = await embedPlugin.createEmbedder({ modelDir });
    stage = 'load';
    mem0.configureHost({ chatCompletion, embedder, dbDir });
    parentPort.postMessage({ type: 'ready' });
  } catch (e) {
    parentPort.postMessage({ type: 'init-failed', stage, message: String(e?.message || e) });
  }
}

parentPort.on('message', async (m) => {
  if (m.type === 'chat-result') {
    const w = chatWaiting.get(m.id);
    if (!w) return;
    chatWaiting.delete(m.id);
    if (m.ok) w.resolve(m.value);
    else w.reject(new Error(m.error));
    return;
  }
  if (m.type !== 'call') return;
  try {
    if (!OPS.has(m.op)) throw new Error(`memory worker: unknown op ${JSON.stringify(m.op)}`);
    if (!mem0) throw new Error('mem0 plugin: failed to load (worker not initialised)');
    const value = await mem0[m.op](m.args);
    parentPort.postMessage({ type: 'result', id: m.id, ok: true, value });
  } catch (e) {
    parentPort.postMessage({
      type: 'result', id: m.id, ok: false,
      error: { message: String(e?.message || e), code: e?.code },
    });
  }
});

init();
