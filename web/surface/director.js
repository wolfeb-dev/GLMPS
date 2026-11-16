// web/surface/director.js
// Wall mode's camera policy (no DOM): given the sessions on the ring, who the
// camera should be on. Waiting on you outranks failing, which outranks a fresh
// commit or push, which outranks the busiest; the camera holds 8 s (20 s under
// reduced motion), then moves to the least recently visited peer of the best
// tier. A session the operator picked holds it until released.
export const DWELL_MS = 8000;
export const DWELL_REDUCED_MS = 20_000;
export const FRESH_GIT_MS = 6000;

export const initialDirector = () => ({ id: null, since: 0, visited: {}, changed: false });

export function tierOf(s, now) {
  if (s.waiting) return 4;
  if (s.failing) return 3;
  if (s.lastGitTs != null && now - s.lastGitTs <= FRESH_GIT_MS) return 2;
  if (!s.idle && s.cpm > 0) return 1;
  return 0;
}

const rank = (a, b, now) => tierOf(b, now) - tierOf(a, now);

export function directorStep(state, sessions, { now, lockId = null, reduced = false }) {
  const dwell = reduced ? DWELL_REDUCED_MS : DWELL_MS;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const next = (id, since, visited = state.visited) => ({ id, since, visited, changed: id !== state.id });
  if (!sessions.length) return next(null, now);

  if (lockId && byId.has(lockId)) {
    return next(lockId, state.id === lockId ? state.since : now, { ...state.visited, [lockId]: now });
  }
  const cur = state.id != null ? byId.get(state.id) : null;
  if (cur && now - state.since < dwell) return next(cur.id, state.since);

  const top = Math.max(...sessions.map((s) => tierOf(s, now)));
  const pool = sessions.filter((s) => tierOf(s, now) === top);
  // Alone at the top tier, the session keeps the camera and the dwell restarts.
  if (cur && pool.length === 1 && pool[0].id === cur.id) return next(cur.id, now);
  const peers = pool.filter((s) => s.id !== state.id);
  const pick = (peers.length ? peers : pool)
    .sort((a, b) => (state.visited[a.id] ?? -Infinity) - (state.visited[b.id] ?? -Infinity) || rank(a, b, now) || b.cpm - a.cpm || (a.id < b.id ? -1 : 1))[0];
  return next(pick.id, now, { ...state.visited, [pick.id]: now });
}
