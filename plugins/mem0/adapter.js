// memory@1 over our copy of Mem0 (mem0ai 3.2.0, Apache-2.0).
import path from 'node:path';
import { setChatCompletion } from './shims/openai.js';

export const CONTRACT = 'memory@1';
let memory = null; let host = null;

// Mem0's Memory has no close(); its history and vector-store sqlite handles
// are reached directly so a reconfigure does not leak them.
function closeMemory(m) {
  if (!m) return;
  for (const h of [m.db, m.vectorStore?.db, m._entityStore?.db]) {
    try { h?.close?.(); } catch { /* already closed */ }
  }
}

export function configureHost({ chatCompletion, embedder, dbDir }) {
  if (!chatCompletion || !embedder || !dbDir) throw new Error('mem0 plugin: configureHost needs chatCompletion, embedder, dbDir');
  closeMemory(memory);
  host = { chatCompletion, embedder, dbDir }; memory = null;
  setChatCompletion(chatCompletion);
}
async function mem() {
  if (memory) return memory;
  if (!host) throw new Error('mem0 plugin: configureHost was not called');
  process.env.MEM0_TELEMETRY = 'false';
  // Mem0 also keeps an anonymous telemetry id at MEM0_DIR/config.json
  // (default os.homedir()/.mem0), read/written unconditionally on every
  // Memory instantiation regardless of MEM0_TELEMETRY (the flag only gates
  // the network call that would use that id). Pointing MEM0_DIR at our own
  // dbDir keeps that file, and any other MEM0_DIR-relative default Mem0
  // might use, inside the plugin's sandbox instead of the operator's real
  // home directory.
  process.env.MEM0_DIR = host.dbDir;
  const { Memory } = await import('./vendor/mem0ai/dist/oss/index.mjs');
  memory = new Memory({
    llm: { provider: 'openai', config: { apiKey: 'glmps', model: 'haiku' } },
    embedder: { provider: 'langchain', config: { model: host.embedder } },
    vectorStore: { provider: 'memory', config: { collectionName: 'glmps', dimension: host.embedder.dims, dbPath: path.join(host.dbDir, 'vector_store.db') } },
    historyDbPath: path.join(host.dbDir, 'history.db'),
  });
  return memory;
}
export async function add({ sessionId = null, project, messages, infer = true }) {
  if (!project) throw new Error('project is required');
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages must be a non-empty array');
  const r = await (await mem()).add(messages, { userId: project, metadata: { sessionId, project }, infer });
  return { results: (r?.results || []).map((x) => ({ id: x.id, memory: x.memory, event: x.event ?? x.metadata?.event ?? null })) };
}
export async function search({ query, project, k = 5 }) {
  if (!project) throw new Error('project is required');
  if (!query) throw new Error('query is required');
  const r = await (await mem()).search(query, { topK: k, filters: { user_id: project } });
  return { results: (r?.results || []).map((x) => ({ id: x.id, memory: x.memory, score: x.score ?? null, metadata: x.metadata || {} })) };
}
export async function remove({ id }) {
  if (!id) throw new Error('id is required');
  await (await mem()).delete(id);
  return { ok: true };
}
