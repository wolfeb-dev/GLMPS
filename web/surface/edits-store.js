// web/surface/edits-store.js
// The recent session edits (GET /api/surface/edits), fetched after the lens
// mounts and refreshed on a timer. The Agents panel, the hover card and the
// edits window all read this one copy, so the card never needs the network.
import { normPath } from './format.js';

export const EDITS_URL = '/api/surface/edits';

export function createEditsStore() {
  let value = { status: 'loading', edits: [], error: null, ts: null };
  const subs = new Set();
  let timer = null;
  let inflight = false;
  const emit = () => { for (const f of [...subs]) f(); };
  const keyOf = (p) => normPath(p).toLowerCase();
  const store = {
    get: () => value,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    // Newest edit of a path by any session, for "last edited by".
    latestFor(path) { const k = keyOf(path); return value.edits.find((e) => keyOf(e.path) === k) ?? null; },
    forSession(id) { return value.edits.filter((e) => e.sessionId === id); },
    async refresh(isDestroyed = () => false) {
      if (inflight) return;
      inflight = true;
      try {
        const res = await fetch(EDITS_URL);
        if (!res.ok) throw new Error(`GET ${EDITS_URL} returned ${res.status}`);
        const body = await res.json();
        if (isDestroyed()) return;
        value = { status: 'ok', edits: Array.isArray(body?.edits) ? body.edits : [], error: null, ts: body?.ts ?? null };
      } catch (e) {
        if (isDestroyed()) return;
        value = { status: 'error', edits: [], error: e.message.startsWith('GET ') ? e.message : `GET ${EDITS_URL} failed: ${e.message}`, ts: null };
      } finally { inflight = false; }
      emit();
    },
    start(isDestroyed, ms = 5000) {
      store.stop();
      store.refresh(isDestroyed);
      timer = setInterval(() => store.refresh(isDestroyed), ms);
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
  return store;
}
