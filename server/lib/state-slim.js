// The slim variant of GET /api/state, for the shell's periodic refresh. The
// full payload is ~2.5 MB (history and inventory dominate) and was refetched
// after every SSE tick; the readers that run every tick need only the live
// sessions, a few recent ended ones, the board, adapter health and tools.
// Fields a lens needs once (Record's history, Surface's inventory) are fetched
// by that lens at mount, never dropped silently.

// Ended sessions kept: the roster's "Recent" strip shows 12.
export const SLIM_ENDED_SESSIONS = 12;
// Recently-ended chips on the stage board read history.slice(0, 8).
export const SLIM_HISTORY = 8;

/**
 * @param {{ sessions: object[], history: object[], tools: object[], adapterHealth: object, board: object }} parts
 *   `history` must be sorted newest first (index.list order).
 * @param {{ include?: string|null }} opts include: one extra session id to keep
 *   (the session page reads its summary from state.sessions).
 */
export function buildSlimState({ sessions, history, tools, adapterHealth, board }, { include = null } = {}) {
  const keep = [];
  const ended = [];
  for (const s of sessions ?? []) {
    if (s.live || (include && s.id === include)) keep.push(s);
    else ended.push(s);
  }
  ended.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  const kept = new Set(keep);
  for (const s of ended.slice(0, SLIM_ENDED_SESSIONS)) kept.add(s);
  return {
    sessions: (sessions ?? []).filter((s) => kept.has(s)),
    history: (history ?? []).slice(0, SLIM_HISTORY),
    tools,
    adapterHealth,
    board,
    slim: true,
  };
}

/** `?fields=a,b` on the full payload: only the named top-level keys. */
export function pickFields(full, fields) {
  const out = {};
  for (const f of fields) if (Object.hasOwn(full, f)) out[f] = full[f];
  return out;
}
