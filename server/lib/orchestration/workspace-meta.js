// server/lib/orchestration/workspace-meta.js
// Extracts declared-workspace updates from kind:'meta' label:'workspace'
// events and writes them to the store. Kept as its own unit so it is
// testable without booting the server (applyMetaEvents in server.js just
// delegates here).
import { writeDeclared } from './workspace-store.js';

const ALLOWED = new Set(['goal', 'hypothesis', 'concepts', 'blockedOn', 'nextStep']);

export function applyWorkspaceMeta(stateDir, sessionId, metaEvents) {
  for (const e of metaEvents) {
    if (e.label !== 'workspace' || !e.change) continue;
    const delta = {};
    for (const k of Object.keys(e.change)) if (ALLOWED.has(k)) delta[k] = e.change[k];
    if (Object.keys(delta).length) writeDeclared(stateDir, sessionId, { ...delta, ts: e.ts ?? 0 });
  }
}
