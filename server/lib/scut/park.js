// server/lib/scut/park.js
// Pure park-state helpers over runner-ledger entries. A scut-launched session
// PARKS at phase end: it long-polls POST /api/scut/park between phases so a
// later mention in its thread continues the SAME session (spec:
// docs/superpowers/specs/2026-07-31-scut-parked-sessions-design.md).
// These helpers own every park-field transition; server.js owns all I/O
// (ledger persistence, poll resolvers, Slack posts). Entries are never
// mutated: every function returns a new object.
//
// Fields on a ledger entry: parkedSince (stretch start, null while working),
// parkLastPollTs (heartbeat), parkBankMs (sum of finished stretches, excluded
// from maxRuntimeMs), parkNote (queued wake text awaiting the next poll) with
// parkNoteProvenance ('operator' | 'external', stamped by the server).

export const STALE_MS = 25 * 60_000;      // ~2.5 poll cycles: the agent is gone
export const GATE_GRACE_MS = 5 * 60_000;  // gate posted but never parked

// D27: how long a relaunched entry (branch b/c's reopenedTs) may
// go with no sign of life before the sweep releases it back to idle. A run's
// own checker cannot wait this long inside its ceiling, so proof of life is
// deferred to the NEXT sweep tick that sees either a park poll or captured
// activity after the relaunch.
export const REOPEN_CONFIRM_MS = 15 * 60_000;

// How long a delivered-but-unacknowledged wake note waits before it is
// requeued for redelivery (glmps-57). Longer than one server hold
// (540s) plus a comfortable working margin, so an agent that is simply BUSY
// acting on the note is never treated as dead. The next poll retires the
// in-flight copy well before this fires in the healthy case.
export const INFLIGHT_TIMEOUT_MS = 20 * 60_000;

export function isParked(entry) {
  return typeof entry?.parkedSince === 'number';
}

export function stampPoll(entry, now) {
  const firstPark = !isParked(entry);
  return {
    firstPark,
    entry: {
      ...entry,
      parkedSince: firstPark ? now : entry.parkedSince,
      parkLastPollTs: now,
      parkBankMs: entry.parkBankMs ?? 0,
      // A poll AFTER a delivery is the agent's proof of life: it received the
      // note, survived, and came back for more. That retires the in-flight
      // copy. Without this the copy would sit until INFLIGHT_TIMEOUT_MS and
      // then be redelivered to an agent that already acted on it.
      parkNoteInFlight: null,
      parkNoteInFlightTs: null,
      parkNoteInFlightProvenance: null,
    },
  };
}

export function bankStretch(entry, now) {
  if (!isParked(entry)) return { ...entry };
  return {
    ...entry,
    parkBankMs: (entry.parkBankMs ?? 0) + (now - entry.parkedSince),
    parkedSince: null,
  };
}

// Hand the queued note to the poller. glmps-57: this used to remove
// parkNote and return it in the SAME step, with no acknowledgement and no
// retry, which made delivery AT-MOST-ONCE. Observed 2026-08-13: a session woke
// with the operator's note, read it, and terminated without answering; the
// sweep requeued the card as stale 25 minutes later and the note was simply
// gone. The operator got silence and had to re-ask.
//
// Now the note moves to an in-flight slot instead of being dropped, making
// delivery AT-LEAST-ONCE. Delivering an operator's instruction twice is
// recoverable; losing it is not. stampPoll retires the in-flight copy on the
// next poll (proof of life), and recoverInFlight requeues it if that poll
// never comes.
export function takePending(entry, now) {
  if (!entry?.parkNote) return { entry, response: null };
  const note = entry.parkNote;
  const provenance = entry.parkNoteProvenance === 'operator' ? 'operator' : 'external';
  return {
    entry: {
      ...bankStretch(entry, now),
      parkNote: null,
      parkNoteProvenance: null,
      parkNoteInFlight: note,
      parkNoteInFlightTs: now,
      parkNoteInFlightProvenance: provenance,
    },
    response: { action: 'wake', note, provenance },
  };
}

// Requeue a wake note that was delivered but never acknowledged by a following
// poll. Returns the entry unchanged when there is nothing in flight or the
// timeout has not elapsed, so it is safe to call on every entry every tick.
//
// A note queued WHILE the first was in flight is preserved and ordered after
// it: the redelivered note was sent first and must read first.
export function recoverInFlight(entry, now, { timeoutMs = INFLIGHT_TIMEOUT_MS } = {}) {
  if (!entry?.parkNoteInFlight) return entry;
  const sentAt = entry.parkNoteInFlightTs ?? 0;
  if (now - sentAt < timeoutMs) return entry;
  const merged = entry.parkNote
    ? `${entry.parkNoteInFlight}\n\n${entry.parkNote}`
    : entry.parkNoteInFlight;
  const inFlight = entry.parkNoteInFlightProvenance === 'operator' ? 'operator' : 'external';
  const provenance = entry.parkNote ? mergeProvenance(inFlight, entry.parkNoteProvenance) : inFlight;
  return { ...entry, parkNote: merged, parkNoteProvenance: provenance, parkNoteInFlight: null, parkNoteInFlightTs: null, parkNoteInFlightProvenance: null };
}

// A combined note is only as trusted as its least trusted part.
function mergeProvenance(a, b) {
  return a === 'operator' && b === 'operator' ? 'operator' : 'external';
}

// Provenance is stamped by the server from who actually sent the note, never
// read from the note text. Unstated means external.
export function queueNote(entry, note, provenance = 'external') {
  const incoming = provenance === 'operator' ? 'operator' : 'external';
  return {
    ...entry,
    parkNote: entry.parkNote ? `${entry.parkNote}\n\n${note}` : note,
    parkNoteProvenance: entry.parkNote ? mergeProvenance(entry.parkNoteProvenance, incoming) : incoming,
  };
}

export function parkWaitMs(entry, now) {
  if (!entry) return 0;
  return (entry.parkBankMs ?? 0) + (isParked(entry) ? now - entry.parkedSince : 0);
}

export function pickEviction(ledger) {
  let best = null;
  for (const [id, entry] of Object.entries(ledger ?? {})) {
    if (!isParked(entry)) continue;
    if (!best || entry.parkedSince < best.since) best = { id, since: entry.parkedSince };
  }
  return best?.id ?? null;
}

// D27: which state a release leaves the card in. Only two things close a card
// automatically or on the operator's word: the Slack `close` verb, and a TTL
// on a card whose gate is PASS (finished work nobody answered). Every other
// release parks it as idle, reopenable by a reply.
export function releaseTarget({ reason, gateStatus }) {
  if (reason === 'close') return 'done';
  if (reason === 'ttl' && gateStatus === 'PASS') return 'done';
  return 'idle';
}

// One decision list per tick: which parked jobs to release, why, and to what.
// Proof of life (D27) is a park poll OR any captured activity from the
// ticket's session inside STALE_MS; activityTs(id, entry) returns the newest
// activity in epoch ms, or null. gated-unparked (an agent that posted its gate
// but never entered the park loop) is also skipped while the session is
// visibly working.
export function sweep(ledger, itemsById, { parkHours, now, activityTs = () => null }) {
  const out = [];
  const push = (id, reason) => out.push({ id, reason, to: releaseTarget({ reason, gateStatus: itemsById?.get?.(id)?.gate?.status ?? null }) });
  for (const [id, entry] of Object.entries(ledger ?? {})) {
    const act = Number(activityTs(id, entry)) || 0;
    if (isParked(entry)) {
      const lastSign = Math.max(entry.parkLastPollTs ?? 0, act);
      if (now - lastSign > STALE_MS) { push(id, 'stale'); continue; }
      if (parkHours > 0 && now - entry.parkedSince > parkHours * 3_600_000) push(id, 'ttl');
      continue;
    }
    // D27: a relaunched entry is not yet parked (it is running
    // fresh, or resuming) - proof of life is a park poll after the relaunch
    // OR any captured activity after it. Neither means it may simply still be
    // working; only exceeding REOPEN_CONFIRM_MS with NEITHER releases it.
    if (typeof entry?.reopenedTs === 'number') {
      const alive = (entry.parkLastPollTs ?? 0) > entry.reopenedTs || act > entry.reopenedTs;
      if (!alive && now - entry.reopenedTs > REOPEN_CONFIRM_MS) { push(id, 'reopen-unconfirmed'); continue; }
      if (!alive) continue;
    }
    if (entry?.parkLastPollTs != null) continue;
    if (now - act <= STALE_MS) continue;
    const item = itemsById?.get?.(id);
    const gateTs = item?.gate?.ts ? Date.parse(item.gate.ts) : NaN;
    if (item?.origin?.via === 'slack' && Number.isFinite(gateTs) && now - gateTs > GATE_GRACE_MS) push(id, 'gated-unparked');
  }
  return out;
}

// The one automatic close (D27): a card whose gate is PASS, idle and
// unanswered for the idle TTL. parkHours 0 disables it, like the park TTL.
export function idleClosures(items, { parkHours, now }) {
  if (!(parkHours > 0)) return [];
  const limit = parkHours * 3_600_000;
  return (items ?? [])
    .filter((i) => i?.state === 'idle' && i.gate?.status === 'PASS' && i.idleSince && now - Date.parse(i.idleSince) > limit)
    .map((i) => i.id);
}

// Newest captured activity of a ticket's session, in epoch ms, or null.
// Sessions: the one recorded on the ledger entry (C2) plus any session whose
// cwd is this ticket's runner worktree (the bridge jobGateWaitMs already uses),
// so proof of life works before C2 records anything. `summaries` are
// sessionSummaries() rows; `tailTsOf(id)` returns the newest in-memory event ts.
export function ticketActivityMs({ ticketId, entry, summaries = [], tailTsOf = () => null }) {
  const ids = new Set();
  if (entry?.sessionId) ids.add(entry.sessionId);
  for (const s of summaries) if (s?.worktree?.kind === 'runner' && s.worktree.id === ticketId) ids.add(s.id);
  let best = null;
  const take = (v) => {
    const ms = typeof v === 'number' ? v : Date.parse(v ?? '');
    if (Number.isFinite(ms) && ms > 0 && (best === null || ms > best)) best = ms;
  };
  for (const id of ids) {
    take(summaries.find((s) => s.id === id)?.lastTs);
    take(tailTsOf(id));
  }
  return best;
}
