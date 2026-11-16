// server/lib/scut/reopen-loop.js
// Reopen by reply (D27 item 1) under the loop contract. Trigger: the event
// scut.ticket-reply. Maker: pick branch a/b/c/x and act. Checker: a different
// function that re-reads the ledger and the card. Liveness of a relaunch is
// proven later by the park sweep (reason reopen-unconfirmed).
import { reopenBranch, REOPENABLE_STATES } from './reopen.js';

export const REOPEN_EVENT = 'scut.ticket-reply';
export const REOPEN_LOOP = Object.freeze({
  name: 'scut-reopen',
  trigger: { onEvent: REOPEN_EVENT },
  ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 60_000 },
  sla: { maxAgeMs: null, obligation: false },
});

/**
 * Phase C final review, I3: loopRegistry.emit() returns one plain run() result per
 * listener registered for the event and used to be
 * called for its side effects only - a rejected promise, a 'failed' outcome,
 * or the loop's own overlap lock ('nothing-to-do: already running', which is
 * exactly what a SECOND rejoin for the same ticket gets back while the first
 * is still mid-run) were all silently dropped by the rejoin caller. Returns
 * the first failure reason found, or null when every settled result is a
 * genuine success (done, or nothing-to-do for any OTHER reason, e.g. "the
 * loop's own gate declined it" is not itself a failure to report here -
 * reopenBranch's own 'x' branch already tells the operator why in-thread).
 * Pure: never touches the network, the registry, or a store - server.js's
 * onRejoin is the one place this decides reportMiss + a devlog line.
 */
export function rejoinEmitFailure(results) {
  // Since Phase K the registry's emit() returns plain run() results (a
  // rejection already mapped to { outcome: 'failed', reason }), not
  // Promise.allSettled envelopes.
  for (const v of results ?? []) {
    if (v?.outcome === 'failed') return v.reason ?? 'failed';
    if (v?.outcome === 'nothing-to-do' && v?.reason === 'already running') {
      return 'already running (a rejoin for this ticket is already being processed)';
    }
  }
  return null;
}

// SAID['x'] uses the refusal reason. reopenBranch refuses for two different
// reasons and each needs its own instruction: 'unreadable end time' is a card
// problem fixed on the board; 'session is active in its own terminal' is a
// live session to reply in instead.
// branch 'a' covers two different mechanisms behind
// reopenBranch's own 'parked'/'running' reasons - a genuinely parked session
// gets its note handed to the poll (as close to "delivered" as this ever
// gets); a session that is live but NOT parked only gets the note QUEUED for
// its next park. Claiming "delivered" for the second case is exactly the
// overclaim the module's own honesty note (router.js) warns against.
const WOULD_NOT_CLOSE = 'its open window would not close';
const SAID = {
  a: (id, why) => (why === 'running'
    ? `${id} reopened: queued for its next park (it is still working, not paused right now).`
    : `${id} reopened: delivered to the running session.`),
  b: (id) => `${id} reopened: resuming its session in its worktree.`,
  c: (id, why) => `${id} reopened: its session could not be resumed (${why}), so a fresh one is starting and will say so.`,
  x: (id, why) => (why === 'unreadable end time'
    ? `${id} not reopened: the card's end time is unreadable. Change the card's state on the board, then reply again.`
    : why === WOULD_NOT_CLOSE
      ? `${id} not reopened: its session is open in its own window and that window would not close. Reply there, or close it and reply again.`
      : 'This session is active in its own terminal. Reply there, or close it and reply again.'),
};

export function createReopenLoop(d) {
  async function maker({ payload }) {
    const { ticketId, text = '', ctx = null } = payload ?? {};
    const item = d.loadItem(ticketId);
    if (!item) throw new Error(`no card ${ticketId}`);
    if (!REOPENABLE_STATES.has(item.state)) return { outcome: 'nothing-to-do', result: { ticketId, state: item.state } };
    const scan = d.scan(text);
    if (!scan.ok) {
      if (ctx) await d.reply(ctx, `not reopened: ${scan.reason}`);
      return { outcome: 'nothing-to-do', result: { ticketId, refused: scan.reason } };
    }
    const entry = d.loadLedger()[ticketId] ?? null;
    // The reference time is when the card entered its CURRENT reopenable
    // state - idleSince/doneAt/stateEnteredAt (backlog-store.js) - not "when
    // it was released": those per-state stamps are set fresh on every entry
    // and cleared on exit, so they can never carry a stale value from a PRIOR
    // episode. Passed straight through: reopenBranch normalises it itself (a
    // number as given, an ISO string via Date.parse).
    //
    // Liveness with no ledger entry comes from the card's OWN recorded
    // runSession.sessionId - the whole point of this feature is a session
    // that may be open in its own terminal outside the runner's worktree
    // tracking, so skipping the check just because the entry is gone would
    // defeat it. lastActivityTs is looked up by BOTH the ticket id (the
    // ticket/worktree activity bridge) and the session id (a session outside
    // the runner worktree, exactly the case this feature is about, has no
    // worktree id to bridge through).
    const runSid = item.runSession?.sessionId ?? null;
    const liveSid = entry ? (entry.sessionId ?? null) : runSid;
    const choice = reopenBranch({
      entry, item,
      parked: d.isParked(entry),
      sessionLive: Boolean(liveSid && d.isSessionLive(liveSid)),
      worktreeExists: Boolean(item.runSession?.worktree?.dir && d.worktreeExists(item.runSession.worktree.dir)),
      endedTs: item.idleSince ?? item.doneAt ?? item.stateEnteredAt ?? null,
      lastActivityTs: d.lastActivityTs(ticketId, { sessionId: runSid }),
      windowStatus: liveSid ? (d.windowStatus?.(liveSid) ?? null) : null,
    });
    const startedTs = d.now();
    // Branch 'x' never relaunches and never delivers - it is a pure refusal,
    // synthesized as an already-ok result so the reply below still fires and
    // the outcome still reads 'done' (a correct DETERMINATION, not a failure).
    const r = choice.branch === 'a'
      ? await d.deliver(ticketId, text, ctx)
      : choice.branch === 'x'
        ? { ok: true }
        : await d.relaunch(ticketId, { resume: choice.branch === 'b' ? { sessionId: item.runSession.sessionId } : null, note: text, reason: choice.reason });
    // A full runner is a wait, not a failure: the reply is kept and the drain
    // (server.js scutDrainPendingReopens) replays it through this same loop
    // once a slot frees. Before glmps-2-0-108 it threw like any refusal and
    // the operator's words were lost.
    if (!r?.ok && r?.code === 'at-capacity' && d.deferReopen) {
      d.deferReopen(ticketId, text, ctx);
      if (ctx) await d.reply(ctx, `${ticketId} is waiting for a free runner slot (all are busy). Your message is saved and the session restarts with it when one frees.`);
      return { outcome: 'done', result: { ticketId, branch: choice.branch, reason: choice.reason, deferred: true, startedTs, text, priorState: item.state } };
    }
    // Phase C final review, M1: the maker itself must not reply here - it
    // used to reply AND throw, and the throw's own reason reaches the
    // caller (router.js folds it into its own single reply; a rejoin has no
    // router reply at all and reports this through reportMiss + a devlog
    // line instead, I3). Replying from both places duplicated every
    // relaunch-refusal message in the thread.
    // The resume closes an idle open window first; one that would not close
    // gets the branch (x) answer, since the session is still there to reply in.
    if (!r?.ok && r?.code === 'session-would-not-close') {
      if (ctx) await d.reply(ctx, SAID.x(ticketId, WOULD_NOT_CLOSE));
      return { outcome: 'done', result: { ticketId, branch: 'x', reason: WOULD_NOT_CLOSE, via: null, startedTs, text, priorState: item.state } };
    }
    if (!r?.ok) throw new Error(`${choice.branch}:${r?.reason ?? 'unknown'}`);
    // The launch found the session still working (its window is busy, or wrote
    // within the guard's active window) and adopted it with the reply queued:
    // that is branch (a)'s queued case, not a relaunch.
    if (r.adopted) {
      if (ctx) await d.reply(ctx, SAID.a(ticketId, 'running'));
      return { outcome: 'done', result: { ticketId, branch: 'a', reason: 'running', via: 'queued', startedTs, text, priorState: item.state } };
    }
    // a successful b/c relaunch means the SESSION changed
    // (resumed under the same id, or a brand-new one) - any room bound to
    // this ticket (the doorway thread, the ticket channel, or both) still
    // carries the OLD sessionId, which reads as "still live" to a naive
    // check. Branch (a) never changes the session (same session, message
    // just delivered or queued to it) and branch (x) never relaunches at
    // all, so neither has anything to clear.
    if (choice.branch === 'b' || choice.branch === 'c') await d.clearSession(ticketId);
    if (ctx) await d.reply(ctx, SAID[choice.branch](ticketId, choice.reason));
    return { outcome: 'done', result: { ticketId, branch: choice.branch, reason: choice.reason, via: r.via ?? null, startedTs, text, priorState: item.state } };
  }

  async function checker(result) {
    const item = d.loadItem(result.ticketId);
    if (result.deferred) {
      return d.hasPendingReopen(result.ticketId)
        ? { ok: true, verifierRef: `pending:${result.ticketId}` }
        : { ok: false, reason: 'the deferred reply was not saved' };
    }
    // Branch 'x' asserts the OPPOSITE of every other branch - nothing
    // launched, the card state is exactly what it was before the reply, and
    // no ledger entry appeared for it.
    if (result.branch === 'x') {
      if (item?.state !== result.priorState) return { ok: false, reason: `card state changed to ${item?.state} after a refused reopen` };
      if (d.loadLedger()[result.ticketId]) return { ok: false, reason: 'a ledger entry appeared after a refused reopen' };
      return { ok: true, verifierRef: `card:${result.ticketId}:unchanged` };
    }
    if (item?.state !== 'in_progress') return { ok: false, reason: `card is ${item?.state ?? 'missing'} after reopen` };
    const entry = d.loadLedger()[result.ticketId];
    if (!entry) return { ok: false, reason: 'no ledger entry after reopen' };
    if (result.branch === 'a') {
      if (result.via === 'queued' && !String(entry.parkNote ?? '').includes(result.text)) return { ok: false, reason: 'the reply was not queued for the session' };
      if (result.via === 'waiter' && typeof entry.parkedSince === 'number') return { ok: false, reason: 'the wake left the session parked' };
      return { ok: true, verifierRef: `ledger:${result.ticketId}:note` };
    }
    if (!(entry.reopenedTs >= result.startedTs)) return { ok: false, reason: 'the relaunch is not recorded on the ledger' };
    const expected = result.branch === 'b' ? item.runSession?.sessionId : null;
    if ((entry.resumeOf ?? null) !== (expected ?? null)) return { ok: false, reason: `resumeOf is ${entry.resumeOf ?? 'null'}, expected ${expected ?? 'null'}` };
    return { ok: true, verifierRef: `ledger:${result.ticketId}:${entry.reopenedTs}` };
  }

  async function onFailed(ctx, reason) {
    const id = ctx?.payload?.ticketId;
    if (!id) return;
    const state = d.loadItem(id)?.state ?? 'unknown';
    d.devlog(id, `reopen failed: ${reason}; the card stays ${state}`);
  }

  return { maker, checker, onFailed };
}
