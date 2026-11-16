// server/lib/scut/close-sync.js
// A closed card owns nothing open (card glmps-2-0-85). The close paths that
// call ticketStateChanged hide the channel at once; this is the backstop for
// the ones that do not (the merge queue's, bulk archives, any added later),
// and it also ends the card's park and its Claude sessions, which no close
// path did. Pure: server.js gathers the inputs and performs the actions.
import { CLOSED_STATES } from '../orchestration/backlog-store.js';

export const SUMMARY_WINDOW_MS = 24 * 3600 * 1000;
export const SESSION_GRACE_MS = 3 * 60 * 1000;
export const MAX_HIDES_PER_RUN = 5;
const WORKING_STATES = new Set(['in_progress', 'in_review']);
export const PROMOTED_NOTE = 'promoted:';

export function closedAtMs(card) {
  for (const v of [card?.doneAt, card?.stateEnteredAt, card?.updatedAt]) {
    const t = Date.parse(v ?? '');
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * @param {object} input
 * @param {object[]} input.items - backlog cards
 * @param {object[]} input.channels - ticket channel entries
 * @param {Iterable<string>} [input.parked] - ticket ids with a park poll held open
 * @param {{pid:number, rootPid?:number, ticketId:string, sessionId:string|null}[]} [input.sessions] - live Claude sessions by card
 * @param {Map<string, number>} [input.activity] - session id -> last transcript write (ms)
 * @param {Iterable<string>} [input.running] - card ids the runner ledger holds (a headless run is not in the session list)
 * @param {number} input.now
 * @returns {{hides:{ticketId:string, summary:boolean}[], parks:string[], sessions:{ticketId:string, pid:number, rootPid:number}[], keptForChildren:string[], promotions:{id:string, host:string, requeue:boolean}[], pendingHides:number}}
 */
export function planCloseSync({ items, channels, parked = [], sessions = [], activity = new Map(), running = [], now }) {
  const closed = new Map();
  const sessionIds = new Map();
  for (const c of items ?? []) {
    if (!CLOSED_STATES.has(c.state)) continue;
    closed.set(c.id, closedAtMs(c));
    sessionIds.set(c.id, new Set([c.runSession?.sessionId, c.sessionId].filter(Boolean).map((x) => String(x).toLowerCase())));
  }

  // A legacy archived channel (archivedTs, no hiddenTs) is already invisible
  // and Slack refuses to rename it; the D27 migration owns it.
  const due = (channels ?? [])
    .filter((e) => closed.has(e.ticketId) && !e.hiddenTs && !e.archivedTs)
    .map((e) => ({ ticketId: e.ticketId, at: closed.get(e.ticketId) }))
    // Newest first: the card that just closed is the one the operator is
    // looking at, so it is never queued behind a backlog of old ones.
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const hides = due.slice(0, MAX_HIDES_PER_RUN).map(({ ticketId, at }) => ({
    ticketId, summary: at !== null && now - at <= SUMMARY_WINDOW_MS,
  }));

  const parks = [...parked].filter((id) => closed.has(id));

  // The grace lets a parked session hear its release and sign off first; an
  // unknown close time never counts as old enough. The session id must be one
  // the card recorded: GLMPS 1.0 writes prompt files to the same runner
  // folder, and its card ids can repeat ours. Its transcript must also have
  // been quiet for the grace period: a worker the merge queue closed under it,
  // or one that marked its own card done, may still be mid-turn.
  const sessionsOut = (sessions ?? [])
    .filter((s) => closed.has(s.ticketId) && s.sessionId && sessionIds.get(s.ticketId).has(String(s.sessionId).toLowerCase()))
    .filter((s) => { const at = closed.get(s.ticketId); return at !== null && now - at >= SESSION_GRACE_MS; })
    .filter((s) => { const last = activity.get(String(s.sessionId).toLowerCase()); return Number.isFinite(last) && now - last >= SESSION_GRACE_MS; });

  // A closed card's session may still be building the cards it filed (card
  // glmps-2-0-runtime-89: 118's session was closed mid-build of 87 and 88).
  // Only children being worked hold it; a held child could hold it forever.
  const workingParents = new Set();
  for (const c of items ?? []) if (c.parentId && WORKING_STATES.has(c.state)) workingParents.add(c.parentId);
  const keptForChildren = [...new Set(sessionsOut.filter((s) => workingParents.has(s.ticketId)).map((s) => s.ticketId))];

  // glmps-2-0-163: an open child whose host is closed, with no live session on
  // it or on the host that filed it, has nobody managing it, so it is promoted
  // once (its own channel, interactive from then on). One that was being
  // worked is requeued so a session picks it up; a held, idle or queued one
  // keeps its state, and its channel shows the operator why it stopped. A card
  // the operator pinned headless is theirs to leave without a channel.
  const liveTickets = new Set([...(sessions ?? []).map((s) => s.ticketId), ...running]);
  const promotions = (items ?? [])
    .filter((c) => c.parentId && closed.has(c.parentId) && !CLOSED_STATES.has(c.state) && !c.promoted && c.mode !== 'headless')
    .filter((c) => !liveTickets.has(c.id) && !liveTickets.has(c.parentId))
    .filter((c) => !(c.devLog ?? []).some((d) => String(d?.text ?? '').startsWith(PROMOTED_NOTE)))
    .map((c) => ({ id: c.id, host: c.parentId, requeue: c.state === 'in_progress' }));

  return {
    hides, parks,
    sessions: sessionsOut.filter((s) => !workingParents.has(s.ticketId)).map((s) => ({ ticketId: s.ticketId, pid: s.pid, rootPid: s.rootPid ?? s.pid })),
    keptForChildren, promotions, pendingHides: due.length - hides.length,
  };
}

// One session per card. On 2026-10-24 a bounced merge resumed card 85's
// session while the first copy was still running (its ledger entry had been
// dropped), and both wrote to one worktree and one transcript. Every launch
// asks this first.
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

const recordedIds = (card) => new Set([card?.runSession?.sessionId, card?.sessionId].filter(Boolean).map((x) => String(x).toLowerCase()));

/**
 * @param {object} input
 * @param {object} input.card
 * @param {{pid:number, rootPid?:number, ticketId:string, sessionId:string|null}[]} input.sessions
 * @param {Map<string, number>} input.activity - session id -> last transcript write (ms)
 * @param {Map<string, {pid:number, status:string|null}>} [input.windows] - Claude Code's own registry
 *   (readClaudeSessionRegistry): session id -> its open window's pid and idle|busy status
 * @param {number} input.now
 * @returns {{action:'launch'} | {action:'adopt', session:object, extra:object[]} | {action:'replace', sessions:object[]}}
 */
export function planSessionGuard({ card, sessions = [], activity = new Map(), windows = new Map(), now }) {
  const ids = recordedIds(card);
  const win = new Map([...windows].map(([k, w]) => [String(k).toLowerCase(), w]));
  const live = sessions.filter((s) => s.ticketId === card?.id && s.sessionId && ids.has(String(s.sessionId).toLowerCase()));
  // A window the process list cannot tie to the card (started outside the
  // runner, so no prompt file on its command line) is still this card's
  // session when the registry names a recorded id. Only its own process tree
  // is ended, never the shell it was started from.
  const listed = new Set(live.map((s) => String(s.sessionId).toLowerCase()));
  for (const [sid, w] of win) {
    if (ids.has(sid) && !listed.has(sid) && Number.isInteger(w?.pid) && w.pid > 0) live.push({ ticketId: card.id, sessionId: sid, pid: w.pid, rootPid: w.pid });
  }
  if (!live.length) return { action: 'launch' };
  const withRoot = (s) => ({ ...s, rootPid: s.rootPid ?? s.pid });
  const statusOf = (s) => win.get(String(s.sessionId).toLowerCase())?.status ?? null;
  // Claude Code's own idle|busy status outranks the transcript clock: a busy
  // window is mid-turn and never closed (card glmps-2-0-109, operator option
  // B), and a window idle at its prompt never pulls a queued note, so adopting
  // it would strand the note.
  const busy = live.filter((s) => statusOf(s) === 'busy');
  if (busy.length) {
    const [session, ...extra] = [...busy, ...live.filter((s) => statusOf(s) !== 'busy')];
    return { action: 'adopt', session: withRoot(session), extra: extra.map(withRoot) };
  }
  if (live.every((s) => statusOf(s) === 'idle')) return { action: 'replace', sessions: live.map(withRoot) };
  // An unknown last write counts as active: closing a session that may be
  // mid-turn loses work, adopting an idle one only delays the note.
  const last = Math.max(...live.map((s) => activity.get(String(s.sessionId).toLowerCase()) ?? Infinity));
  if (now - last <= ACTIVE_WINDOW_MS) {
    const [session, ...extra] = live;
    return { action: 'adopt', session: withRoot(session), extra: extra.map(withRoot) };
  }
  return { action: 'replace', sessions: live.map(withRoot) };
}
