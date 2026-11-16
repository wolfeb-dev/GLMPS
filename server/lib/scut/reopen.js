// server/lib/scut/reopen.js
// Reopen by reply (D27 item 1): which session a ticket ran in, and which of
// the three reopen branches applies. Pure; server.js does the launching.
//   (a) the session is still running or parked -> deliver the message to it
//   (b) it ended and can be resumed -> `claude --resume <id>` in its worktree
//   (c) it cannot be resumed -> a fresh session, told why in its first devlog

export const REOPENABLE_STATES = new Set(['idle', 'done', 'cancelled', 'archived']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A session id reaches a cmd.exe command line in branch (b), so only the
// exact UUID shape Claude Code writes is ever accepted.
export function isSessionUuid(s) {
  return typeof s === 'string' && UUID.test(s);
}

// whether `x` (a live session summary) clears
// the rules for binding it to ledger entry `id`. worktreePlan is deterministic
// on the ticket id (glmps-53), so a requeue or a stale release
// relaunches the SAME job id into the SAME worktree directory a prior (or
// entirely foreign) session may still be sitting in - `live` can contain more
// than the one true candidate, and a record written by the caller is written
// ONCE and never revisited (its own `if (entry?.sessionId) continue` guard),
// so a wrong bind is permanent and irreversible (Task 7's reopen resumes
// whatever id lands here).
//
// every launch target mints and records its own
// session id synchronously (server.js's launchJob: the runner never launches
// a native Antigravity agent - the antigravity companion runs the SAME
// seeded `claude` command verbatim in an editor terminal, so it can take
// --session-id exactly like native-terminal). This inference is therefore no
// longer ANY launcher's primary path - an entry only reaches here still
// lacking a sessionId if that never happened (a legacy ledger entry from
// before this existed, or the card write failed at launch - see
// recordLaunchSessionSafe below). There is no more per-launcher relaxation:
// every candidate must clear ALL of:
//   - its first observed activity (`firstTs`) is at or after the job's own
//     `entry.startedAt` - a session that already existed before this job was
//     launched cannot be the one this job spawned;
//   - it is not the card's previous `runSession.sessionId` - a leftover
//     controller from the ticket's last run is exactly the reused-worktree
//     case above;
//   - its id passes `isSessionUuid` - this id is later persisted and, in
//     Task 7's reopen branch (b), reaches a `claude --resume <id>` command
//     line.
function candidateOk(x, id, prevSid, startedAt) {
  if (x?.worktree?.kind !== 'runner' || x.worktree.id !== id) return false;
  if (x.id === prevSid) return false;
  return isSessionUuid(x.id) && Number.isFinite(x.firstTs) && x.firstTs >= startedAt;
}

// Ledger entries that have no session recorded yet, paired with the live
// session working in their runner worktree (the bridge jobGateWaitMs and
// bindSessions already use: worktreeInfo() over the session cwd). More than
// one candidate surviving candidateOk is genuine ambiguity: this tick records
// nothing for that entry rather than guessing, and tries again next tick once
// the picture is clearer (e.g. the stale one goes idle).
export function planRunSessionRecords({ ledger = {}, live = [], previousSessionIds = {} } = {}) {
  const out = [];
  for (const [id, entry] of Object.entries(ledger)) {
    if (entry?.sessionId) continue;
    const startedAt = Number(entry?.startedAt);
    if (!Number.isFinite(startedAt)) continue; // can't prove any candidate started after launch
    const prevSid = previousSessionIds[id] ?? null;
    const candidates = live.filter((x) => candidateOk(x, id, prevSid, startedAt));
    if (candidates.length !== 1) continue;
    const s = candidates[0];
    out.push({ id, sessionId: s.id, launcher: entry.target ?? null, worktree: entry.worktree ?? null });
  }
  return out;
}

// why an entry that still lacks a sessionId was not
// recorded this tick - never a silent null. One diagnosis per still-
// unrecorded ledger id (an id that already carries a sessionId, or that
// candidateOk would record right now, is not diagnosed at all):
//   'missing-startedAt'   - nothing to compare a candidate's firstTs against.
//   'no-candidates'       - no live session even sits in this ticket's
//                           worktree (after excluding the previous session id).
//   'firstts-unavailable' - at least one session IS in the worktree, but
//                           candidateOk refused every one of them (almost
//                           always: the sole candidate's firstTs could not be
//                           established, or predates startedAt).
//   'ambiguous'           - more than one candidate survived candidateOk; the
//                           same "record nothing" case planRunSessionRecords
//                           itself takes, named here so the caller can track
//                           how long it persists before it is worth a report.
export function diagnoseUnrecorded({ ledger = {}, live = [], previousSessionIds = {} } = {}) {
  const out = [];
  for (const [id, entry] of Object.entries(ledger)) {
    if (entry?.sessionId) continue;
    const startedAt = Number(entry?.startedAt);
    if (!Number.isFinite(startedAt)) { out.push({ id, reason: 'missing-startedAt' }); continue; }
    const prevSid = previousSessionIds[id] ?? null;
    const inWorktree = live.filter((x) => x?.worktree?.kind === 'runner' && x.worktree.id === id && x.id !== prevSid);
    const candidates = inWorktree.filter((x) => candidateOk(x, id, prevSid, startedAt));
    if (candidates.length === 1) continue; // would be recorded this tick; nothing to diagnose
    if (candidates.length > 1) { out.push({ id, reason: 'ambiguous' }); continue; }
    out.push({ id, reason: inWorktree.length ? 'firstts-unavailable' : 'no-candidates' });
  }
  return out;
}

// Which `entry` shape the park-sweep's activity probe (park.js's
// ticketActivityMs, via server.js's activityTs closure) should read a
// ticket's session from: the ledger entry's own sessionId while it still has
// one (maker time, inside sweep()), or the card's runSession.sessionId once
// the ledger entry is gone (checker time, after a release has already
// removed it - createParkSweepLoop's checker calls this with an empty
// entry). Extracted out of server.js so a test
// can drive both shapes without booting a server; both createParkSweepLoop
// call sites route through this SAME function via one shared closure, so
// keeping it here is what makes "maker and checker agree" a property of the
// code, not of two copies staying in sync by hand.
export function activityEntryFor(entry, card) {
  return entry?.sessionId ? entry : { sessionId: card?.runSession?.sessionId ?? null };
}

// the card write (backlogStore.setRunSessionIn) is what
// Task 7's reopen actually reads; the ledger's own sessionId/launcher fields
// are only a same-tick fast path. `setResult` is whatever that write
// returned. Only mirror the record onto the ledger once the write has
// verifiably landed (setResult.item is non-null) - a missing or
// already-deleted card must never leave the ledger claiming a session the
// card itself never recorded, since the ledger's own write-once guard
// (planRunSessionRecords's caller skips any entry that already has a
// sessionId) means that entry would then never be retried.
export function ledgerPatchFor(rec, setResult) {
  if (!setResult?.item) return null;
  return { sessionId: rec.sessionId, launcher: rec.launcher };
}

// `write()` (the launch-synchronous card write,
// backlogStore.setRunSessionIn) runs AFTER launchJob has already spawned the
// session - a throw here must never escape to the caller. Unguarded, a save
// throw on the dispatch path fell into runnerTick's outer bare catch, which
// skipped writing the ledger entry ENTIRELY (the just-launched job would have
// no ledger entry at all: no reconcile, no reclaim, an orphaned session
// nobody is tracking), and on runJobNow's path it surfaced as a 500 to the
// caller after the launch had already happened. `write` and `onMiss` are
// injected so this can be tested without a real filesystem throw (matching
// the same write-thunk-injection shape lib/evaluation/lesson-write.js already
// uses for "what happens when the write itself fails"); server.js's
// recordLaunchSession is the real caller. Always returns the ledgerPatchFor
// shape (or `{}`), never throws - so the ledger entry is always written (just
// without a sessionId yet on failure), and the next tick's fallback
// inference (planRunSessionRecords) can still heal it later.
export function recordLaunchSessionSafe(rec, write, onMiss) {
  if (!rec?.sessionId) return {};
  try {
    return ledgerPatchFor(rec, write()) ?? {};
  } catch (e) {
    onMiss?.(e?.message ?? String(e));
    return {};
  }
}

// Reopen by reply: which of the four reopen branches a
// non-running ticket's reply takes.
//   (a) the session is still running or parked -> deliver the message to it
//   (b) it ended and can be resumed -> `claude --resume <id>` in its worktree
//   (c) it cannot be resumed -> a fresh session, told why in its first devlog
//   (x) it is genuinely still active in its own terminal -> refuse, named
//
// `endedTs`/`lastActivityTs` accept either a numeric epoch-ms value (matching
// entry.startedAt, recordedTs, reopenedTs - the runner ledger's own
// convention) or an ISO string (matching backlog-store.js's own now(), which
// is what idleSince/doneAt/stateEnteredAt actually are) - `endedTs` is
// normalised internally (see below), the same way park.js's ticketActivityMs
// normalises a session's lastTs.
//
// Task 7 rulings R4: native-terminal and antigravity are BOTH resumable.
// server.js's launchJob mints and records a real claude-code session id for
// every launch target - the antigravity companion runs
// the SAME seeded `claude` command verbatim in an editor terminal, so its
// recorded session is exactly as resumable as a native-terminal one. Any
// OTHER recorded launcher value (a legacy ledger entry, or a foreign one)
// still cannot be resumed and names itself in the reason.
// 'headless' (unattended reliability T6): a print-mode run under a session id
// the runner chose, resumed headless with the reply as its prompt.
const RESUMABLE_LAUNCHERS = new Set(['native-terminal', 'antigravity', 'headless']);

// Important 1: how long after a state entry the sign-off write
// itself is still expected, before any FURTHER activity counts as the
// session genuinely still working. A released ticket's interactive terminal
// is a REPL - nothing kills the process on release - and its own sign-off
// write refreshes the transcript, so round 1's raw `sessionLive` check
// (registry-alive OR "written recently") read as "still live" for the
// ENTIRE ordinary paused-then-reply path, not just a genuinely still-working
// one. This grace absorbs the sign-off write; anything written LATER than
// endedTs + this is real, independent activity.
export const REOPEN_ACTIVE_GRACE_MS = 120_000;

export function reopenBranch({ entry, item, parked, sessionLive, worktreeExists, endedTs = null, lastActivityTs = null, windowStatus = null }) {
  if (entry && (parked || sessionLive)) return { branch: 'a', reason: parked ? 'parked' : 'running' };
  // Important 1: the ledger
  // entry can be gone (a restart cleared it, or a release removed it) while
  // the underlying claude-code process is still open in its own terminal.
  // Only refuse when there is REAL evidence of activity after the sign-off
  // grace - an idle, merely-open terminal is exactly the normal
  // paused-then-reply case and must resume, not fork into a second session
  // beside it. `endedTs`/`lastActivityTs` unavailable (nothing to compare -
  // e.g. a ticket state with no recorded entry stamp) means this never
  // blocks the branches below.
  //
  // `endedTs` is when the card entered its CURRENT
  // reopenable state (idleSince/doneAt/stateEnteredAt - backlog-store.js),
  // not "when it was released" - that value went stale across a whole
  // resume-then-done cycle (I4: item.release.ts was never cleared, so an
  // old release could permanently refuse a card long after the session it
  // named had ended). The per-state entry stamp is set fresh on every entry
  // and cleared on exit, so it can never carry a stale value from a PRIOR
  // episode. Normalised the same way park.js's ticketActivityMs normalises a
  // session's lastTs: a number as given, an ISO string via Date.parse. If
  // present but not finite after normalising, refuse rather than guess -
  // unreadable data must never read as "safe to resume."
  let endedMs = null;
  if (!entry && endedTs != null) {
    endedMs = typeof endedTs === 'number' ? endedTs : Date.parse(endedTs);
    if (!Number.isFinite(endedMs)) return { branch: 'x', reason: 'unreadable end time' };
  }
  // post-grace activity alone never
  // refuses. The session must ALSO be live now (sessionLive: registry-alive
  // or transcript written within the ccLive window), or a terminal the
  // operator has since closed would be refused on every later reply for ever.
  const rs = item?.runSession ?? null;
  // A headless session has no terminal and is never live once its run ends.
  const terminal = rs?.launcher !== 'headless';
  const activeAfterEnd = endedMs != null && lastActivityTs != null && lastActivityTs > endedMs + REOPEN_ACTIVE_GRACE_MS;
  // `windowStatus` is Claude Code's own idle|busy for the open window
  // (~/.claude/sessions), and it outranks the transcript clock (card
  // glmps-2-0-109, operator option B): a busy window is never touched, an
  // idle one resumes through branch (b), whose launch closes the window first
  // (server.js liveSessionTakesIt) so the session moves rather than doubles.
  const active = windowStatus === 'busy' || (windowStatus !== 'idle' && activeAfterEnd);
  if (!entry && terminal && active && sessionLive) return { branch: 'x', reason: 'session is active in its own terminal' };
  if (!rs?.sessionId) return { branch: 'c', reason: 'no session was recorded for this card' };
  if (!isSessionUuid(rs.sessionId)) return { branch: 'c', reason: 'the recorded session id is not resumable' };
  if (!RESUMABLE_LAUNCHERS.has(rs.launcher)) return { branch: 'c', reason: `sessions launched in ${rs.launcher ?? 'an unknown launcher'} cannot be resumed` };
  if (!rs.worktree?.dir) return { branch: 'c', reason: 'it did not run in a worktree of its own' };
  // A worktree removed after its outcome record was written can be recreated
  // from the recorded branch (the launch does it), so it resumes like a kept one.
  const recreatable = !!(rs.outcome?.branch && rs.worktree.repo);
  if (rs.purgedTs && (worktreeExists || !recreatable)) return { branch: 'c', reason: 'its worktree was purged' };
  if (!worktreeExists && !recreatable) return { branch: 'c', reason: 'its worktree is gone' };
  return { branch: 'b', reason: 'the session ended' };
}
