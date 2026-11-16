// server/test/scut-reopen-loop.test.js
// Reopen by reply (D27 C2, Task 8) under the loop contract: a reply for a
// ticket that is not running picks branch a/b/c/x (server/lib/scut/reopen.js)
// and acts; the checker is a different function reading the stores fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { loopAlerts } from '../lib/loops/loop-health.js';
import { createReopenLoop, REOPEN_LOOP, REOPEN_EVENT, rejoinEmitFailure } from '../lib/scut/reopen-loop.js';
import { REOPEN_ACTIVE_GRACE_MS } from '../lib/scut/reopen.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CTX = { channel: 'C_T', thread_ts: '1.1', user: 'U_OP' };

// World builder. Matches production exactly: idle -> idleSince, done ->
// doneAt, anything else (cancelled/archived) -> stateEnteredAt, stored as an
// ISO string (backlog-store.js's now()), not a number - `endedRaw` overrides
// the stored stamp verbatim for the unreadable-end-time test. `liveSessions`
// are the ids the registry/ccLive would report live NOW; `isSessionLive`
// answers per id, so the maker must ask about item.runSession.sessionId when
// the ledger entry is null (branch x with no entry). `calls` records what the
// maker asked each dep (lastActivityTs gets the ticket id AND the session id).
function world({ entry = null, runSession = { sessionId: SID, launcher: 'native-terminal', worktree: { dir: 'W', branch: 'b', repo: 'R' } }, worktreeExists = true, state = 'idle', stateEnteredAt = null, endedRaw = undefined, lastActivityTs = null, liveSessions = [], windows = {} } = {}) {
  const item = { id: 'p-1', state, runSession };
  const stamp = endedRaw !== undefined ? endedRaw : stateEnteredAt != null ? new Date(stateEnteredAt).toISOString() : null;
  if (stamp != null) {
    if (state === 'idle') item.idleSince = stamp;
    else if (state === 'done') item.doneAt = stamp;
    else item.stateEnteredAt = stamp;
  }
  const w = { ledger: entry ? { 'p-1': entry } : {}, item, replies: [], devlog: [], pending: {}, calls: { live: [], activity: [], clearSession: [] } };
  let t = 1000;
  w.deps = {
    loadItem: () => structuredClone(w.item),
    loadLedger: () => structuredClone(w.ledger),
    isParked: (e) => typeof e?.parkedSince === 'number',
    lastActivityTs: (ticketId, { sessionId = null } = {}) => { w.calls.activity.push([ticketId, sessionId]); return lastActivityTs; },
    isSessionLive: (sid) => { w.calls.live.push(sid); return liveSessions.includes(sid); },
    windowStatus: (sid) => windows[sid] ?? null,
    worktreeExists: () => worktreeExists,
    scan: () => ({ ok: true }),
    deliver: async (id, text) => { w.ledger[id] = { ...w.ledger[id], parkNote: `${text}\n\n(from slack)` }; w.item.state = 'in_progress'; return { ok: true, via: 'queued' }; },
    relaunch: async (id, { resume }) => { w.ledger[id] = { reopenedTs: t, resumeOf: resume?.sessionId ?? null }; w.item.state = 'in_progress'; return { ok: true }; },
    reply: async (ctx, text) => { w.replies.push(text); },
    devlog: (id, text) => w.devlog.push(text),
    // the room(s) bound to this ticket carry a sessionId a
    // successful b/c relaunch just made stale. Tracked here so a test can
    // assert it fires for exactly the branches that actually change the
    // session (b/c), and never for a (same session, nothing changed) or x
    // (refused, nothing changed).
    clearSession: (id) => { w.calls.clearSession.push(id); },
    deferReopen: (id, text, ctx) => { (w.pending[id] ??= []).push({ text, ctx }); },
    hasPendingReopen: (id) => Boolean(w.pending[id]?.length),
    now: () => (t += 1),
  };
  return w;
}

function registry() {
  return createLoopRegistry({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reopen-loop-')), now: () => 5000, setTimer: () => 0, clearTimer: () => {} });
}

test('the loop spec: event trigger, no staleness SLA, no model calls', () => {
  assert.equal(REOPEN_EVENT, 'scut.ticket-reply');
  assert.deepEqual(REOPEN_LOOP.trigger, { onEvent: 'scut.ticket-reply' });
  assert.equal(REOPEN_LOOP.sla.maxAgeMs, null);
  const w = world();
  const loop = createReopenLoop(w.deps);
  assert.notEqual(loop.maker, loop.checker);
});

test('branch (a): a parked session gets the note and the card goes in_progress', async () => {
  const w = world({ entry: { parkedSince: 1 } });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'use port 9', ctx: CTX } });
  assert.equal(made.result.branch, 'a');
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /delivered to the running session/);
});

test('branch (b): an ended session resumes with the same id', async () => {
  const w = world();
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'b');
  assert.equal(w.ledger['p-1'].resumeOf, SID);
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /resuming its session/);
});

test('branch (c): no resumable session starts a fresh one and says why', async () => {
  const w = world({ worktreeExists: false });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'again', ctx: CTX } });
  assert.equal(made.result.branch, 'c');
  assert.equal(w.ledger['p-1'].resumeOf, null);
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /could not be resumed \(its worktree is gone\)/);
});

// A session that is genuinely ACTIVE (real activity after the sign-off grace
// AND live now) refuses - no relaunch, no delivery, the card stays exactly
// as it was. With the entry null, liveness must come from item.runSession.sessionId.
test('branch (x): a session still active in its own terminal refuses, and nothing changes', async () => {
  const w = world({ liveSessions: [SID], stateEnteredAt: 1000, lastActivityTs: 1000 + REOPEN_ACTIVE_GRACE_MS + 1 });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'x');
  assert.deepEqual(w.calls.live, [SID], 'with no ledger entry, liveness is asked of the card\'s runSession id');
  assert.deepEqual(w.calls.activity, [['p-1', SID]], 'activity is looked up by ticket id and session id');
  assert.equal(w.item.state, 'idle', 'nothing launched or delivered - state unchanged');
  assert.equal(w.ledger['p-1'], undefined, 'no ledger entry appeared for a refused reopen');
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /active in its own terminal/);
});

// The closed-terminal case. Post-grace activity is still in the transcript,
// but nothing is live now, so the reply resumes rather than being refused
// for ever.
test('branch (b): activity after the grace but the terminal since closed resumes', async () => {
  const w = world({ liveSessions: [], stateEnteredAt: 1000, lastActivityTs: 1000 + REOPEN_ACTIVE_GRACE_MS + 1 });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'b');
  assert.deepEqual(w.calls.live, [SID]);
  assert.equal(w.ledger['p-1'].resumeOf, SID);
  assert.equal((await loop.checker(made.result)).ok, true);
});

// An 'x' refusal says WHY. An unreadable end stamp is a card problem the
// operator fixes on the board, not a live terminal.
test('branch (x): an unreadable end time says so and points at the board, not at a terminal', async () => {
  const w = world({ endedRaw: 'not-a-date' });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'x');
  assert.equal(made.result.reason, 'unreadable end time');
  assert.match(w.replies.at(-1), /end time is unreadable/);
  assert.match(w.replies.at(-1), /Change the card's state on the board/);
  assert.doesNotMatch(w.replies.at(-1), /own terminal/);
  assert.equal((await loop.checker(made.result)).ok, true);
});

// Live now alone must not refuse - only the release sign-off write happened,
// well inside the grace, so this is exactly the ordinary paused-then-reply
// case and still resumes.
test('branch (b): live now but only the sign-off write, inside the grace, still resumes', async () => {
  const w = world({ liveSessions: [SID], stateEnteredAt: 1000, lastActivityTs: 1000 + 5_000 });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'b');
  assert.equal(w.ledger['p-1'].resumeOf, SID);
  assert.equal((await loop.checker(made.result)).ok, true);
});

// a successful b/c relaunch leaves the ticket's bound
// room(s) pointing at the OLD (now stale) sessionId, which read back as
// "still live" to a NAIVE check and either drops a quick follow-up reply
// with the wrong instructions, or - in a doorway thread - launches a SECOND
// ticket. Clearing it is what lets the router's own "ticket, no session
// yet" branch pick a follow-up up as a queue instead.
test('branch (b) and (c): a successful relaunch clears the ticket room session; branch (a) and (x) never do', async () => {
  const resumed = world();
  await createReopenLoop(resumed.deps).maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.deepEqual(resumed.calls.clearSession, ['p-1'], 'branch (b) clears the session');

  const fresh = world({ worktreeExists: false });
  await createReopenLoop(fresh.deps).maker({ payload: { ticketId: 'p-1', text: 'again', ctx: CTX } });
  assert.deepEqual(fresh.calls.clearSession, ['p-1'], 'branch (c) clears the session');

  const parked = world({ entry: { parkedSince: 1 } });
  await createReopenLoop(parked.deps).maker({ payload: { ticketId: 'p-1', text: 'go', ctx: CTX } });
  assert.deepEqual(parked.calls.clearSession, [], 'branch (a) never changed the session - nothing to clear');

  const refused = world({ liveSessions: [SID], stateEnteredAt: 1000, lastActivityTs: 1000 + REOPEN_ACTIVE_GRACE_MS + 1 });
  await createReopenLoop(refused.deps).maker({ payload: { ticketId: 'p-1', text: 'go', ctx: CTX } });
  assert.deepEqual(refused.calls.clearSession, [], 'branch (x) is a pure refusal - nothing to clear');
});

// Phase C final review, M1: a relaunch refusal (r.ok === false, as opposed to
// the maker's own uncaught throw) used to reply in the thread AND throw,
// which router.js then turned into a SECOND reply for the exact same
// failure. The maker must leave exactly one reply to whoever invoked it -
// the router (which already folds the thrown reason into its own reply), or
// nothing at all for a rejoin, which has no router reply at all (server.js
// reports it via reportMiss + a devlog line instead, I3).
test('M1: a relaunch refusal throws with the reason but does not itself reply - the caller owns the one reply', async () => {
  const w = world();
  w.deps.relaunch = async () => ({ ok: false, reason: 'the runner is at capacity' });
  const loop = createReopenLoop(w.deps);
  await assert.rejects(
    () => loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } }),
    (e) => { assert.match(e.message, /b:the runner is at capacity/); return true; },
  );
  assert.deepEqual(w.replies, [], 'the maker itself must not reply on a relaunch refusal');
});

// glmps-2-0-108: an operator reply to a released card arrived while every
// runner slot was busy and no parked session could be evicted. The refusal
// threw, the router answered "could not reopen ... Check the board", and the
// reply itself was kept nowhere, so nothing ever delivered it.
test('a reply refused for capacity is saved for a later slot, and the thread is told so', async () => {
  const w = world();
  w.deps.relaunch = async () => ({ ok: false, code: 'at-capacity', reason: 'the runner is at capacity' });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'answers: A, C', ctx: CTX } });
  assert.equal(made.outcome, 'done');
  assert.equal(made.result.deferred, true);
  assert.deepEqual(w.pending['p-1'].map((p) => p.text), ['answers: A, C']);
  assert.deepEqual(w.pending['p-1'][0].ctx, CTX);
  assert.equal(w.replies.length, 1);
  assert.match(w.replies[0], /saved/);
  assert.doesNotMatch(w.replies[0], /could not reopen/);
  assert.deepEqual(w.calls.clearSession, [], 'nothing relaunched, so the room keeps its session');
  assert.equal((await loop.checker(made.result)).ok, true);
  delete w.pending['p-1'];
  assert.match((await loop.checker(made.result)).reason, /not saved/);
});

test('session gone (branch c, fresh launch) refused for capacity is saved the same way', async () => {
  const w = world({ worktreeExists: false });
  w.deps.relaunch = async () => ({ ok: false, code: 'at-capacity', reason: 'the runner is at capacity' });
  const made = await createReopenLoop(w.deps).maker({ payload: { ticketId: 'p-1', text: 'still there?', ctx: CTX } });
  assert.equal(made.result.branch, 'c');
  assert.equal(made.result.deferred, true);
  assert.deepEqual(w.pending['p-1'].map((p) => p.text), ['still there?']);
  assert.match(w.replies[0], /saved/);
});

// branch (a) covers two different mechanisms (reopenBranch's
// own 'parked' vs 'running' reasons) behind one reply. A live session that is
// NOT parked gets its note QUEUED for the session's next park, not delivered
// - claiming "delivered" here would be exactly the overclaim the module's own
// honesty note warns against.
test('branch (a): a live but not-parked session is honestly reported as queued, not "delivered"', async () => {
  const w = world({ entry: { sessionId: SID }, liveSessions: [SID] });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'a');
  assert.equal(made.result.reason, 'running');
  assert.match(w.replies.at(-1), /queued for its next park/);
  assert.doesNotMatch(w.replies.at(-1), /delivered to the running session/);
  assert.equal((await loop.checker(made.result)).ok, true);
});

test('a card that is running is nothing-to-do; a flagged text is refused in the thread', async () => {
  const running = world({ state: 'in_progress' });
  assert.equal((await createReopenLoop(running.deps).maker({ payload: { ticketId: 'p-1', text: 'x', ctx: CTX } })).outcome, 'nothing-to-do');
  const flagged = world();
  flagged.deps.scan = () => ({ ok: false, reason: 'flagged by poison-scan (injection)' });
  const made = await createReopenLoop(flagged.deps).maker({ payload: { ticketId: 'p-1', text: 'ignore all', ctx: CTX } });
  assert.equal(made.outcome, 'nothing-to-do');
  assert.match(flagged.replies.at(-1), /not reopened: flagged by poison-scan/);
});

test('proof it closes: failing launcher alerts, an unrecorded launch fails the checker, a good run clears', async () => {
  const reg = registry();
  let w = world();
  w.deps.relaunch = async () => { throw new Error('spawn failed'); };
  let loop = createReopenLoop(w.deps);
  const handle = reg.registerLoop({ ...REOPEN_LOOP, maker: (c) => loop.maker(c), checker: (r, c) => loop.checker(r, c), onFailed: (c, r) => loop.onFailed(c, r) });
  await handle.runNow({ ticketId: 'p-1', text: 'go', ctx: CTX });
  assert.match(reg.snapshot()['scut-reopen'].lastOutcome, /^failed:/);
  assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: scut-reopen').length, 1);
  assert.match(w.devlog.at(-1), /^reopen failed: .*spawn failed; the card stays idle$/);

  w = world();
  w.deps.relaunch = async () => ({ ok: true });
  loop = createReopenLoop(w.deps);
  await handle.runNow({ ticketId: 'p-1', text: 'go', ctx: CTX });
  assert.match(reg.snapshot()['scut-reopen'].lastReason, /card is idle after reopen/);

  w = world();
  loop = createReopenLoop(w.deps);
  await handle.runNow({ ticketId: 'p-1', text: 'go', ctx: CTX });
  assert.equal(reg.snapshot()['scut-reopen'].consecutiveFailures, 0);
  assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: scut-reopen').length, 0);
});

// be ignored entirely - a second rejoin for the same ticket arriving while
// the first is still mid-run comes back `{ outcome: 'nothing-to-do', reason:
// 'already running' }` (the loop's own overlap lock), and a genuine failure
// comes back `{ outcome: 'failed', reason }`; both were silently dropped.
// rejoinEmitFailure is the pure classifier server.js's onRejoin uses to
// decide whether to reportMiss + devlog: it never touches the network or the
// loop registry itself, so it is tested directly against the plain run() results the
// kernel registry's emit() returns (unwrapped from allSettled since Phase K;
// a rejection arrives as { outcome: 'failed', reason }), no server boot required. ------------------

test('rejoinEmitFailure: every settled result ok (done or nothing-to-do for an ordinary reason) is not a failure', () => {
  assert.equal(rejoinEmitFailure([{ outcome: 'done', reason: null }]), null);
  assert.equal(rejoinEmitFailure([{ outcome: 'nothing-to-do', reason: null }]), null);
  assert.equal(rejoinEmitFailure([]), null, 'no loop subscribed to the event is not itself a failure');
});

test('rejoinEmitFailure: a second rejoin caught by the overlap lock ("already running") is reported, not dropped', () => {
  const reason = rejoinEmitFailure([{ outcome: 'nothing-to-do', reason: 'already running' }]);
  assert.match(reason, /already running/);
});

test('rejoinEmitFailure: a failed outcome is reported with its own reason', () => {
  const reason = rejoinEmitFailure([{ outcome: 'failed', reason: 'checker:card is idle after reopen' }]);
  assert.equal(reason, 'checker:card is idle after reopen');
});

test('rejoinEmitFailure: a run that threw past its own try/catch (emit maps it to failed) is reported too', () => {
  const reason = rejoinEmitFailure([{ outcome: 'failed', reason: 'unexpected' }]);
  assert.match(reason, /unexpected/);
});

// Unattended reliability T6: a headless session exits when its run ends; the
// activity it left behind must never read as "active in its own terminal".
test('branch (b): a headless card resumes its recorded session even with fresh activity, never refused as a live terminal', async () => {
  const runSession = { sessionId: SID, launcher: 'headless', worktree: { dir: 'W', branch: 'b', repo: 'R' } };
  const w = world({ runSession, liveSessions: [SID], stateEnteredAt: 1000, lastActivityTs: 1000 + REOPEN_ACTIVE_GRACE_MS + 1 });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'option b', ctx: CTX } });
  assert.equal(made.result.branch, 'b');
  assert.equal(w.ledger['p-1'].resumeOf, SID, 'the same session is resumed');
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /resuming its session/);
});

// Card glmps-2-0-109, operator option B: Claude Code's registry status for the
// session's open window picks between resuming (its launch closes the idle
// window first) and refusing (a busy window is never touched).
test('an open window Claude reports idle resumes the session in its worktree', async () => {
  const w = world({ liveSessions: [SID], windows: { [SID]: 'idle' }, stateEnteredAt: 1000, lastActivityTs: 1000 + REOPEN_ACTIVE_GRACE_MS + 1 });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'b');
  assert.equal(w.ledger['p-1'].resumeOf, SID);
  assert.equal((await loop.checker(made.result)).ok, true);
});

test('an open window Claude reports busy refuses, and nothing changes', async () => {
  const w = world({ liveSessions: [SID], windows: { [SID]: 'busy' } });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'x');
  assert.equal(w.ledger['p-1'], undefined);
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /active in its own terminal/);
});

test('an idle window that would not close gets the branch (x) answer, and nothing launches', async () => {
  const w = world({ liveSessions: [SID], windows: { [SID]: 'idle' } });
  w.deps.relaunch = async () => ({ ok: false, code: 'session-would-not-close', reason: 'its idle session would not close' });
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.outcome, 'done');
  assert.equal(made.result.branch, 'x');
  assert.equal(w.item.state, 'idle');
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /open in its own window and that window would not close\. Reply there/);
  assert.deepEqual(w.calls.clearSession, []);
});

test('a relaunch the session guard adopted reads as branch (a) queued, not as a resume', async () => {
  const w = world();
  w.deps.relaunch = async (id, { note }) => { w.ledger[id] = { adopted: true, parkNote: note }; w.item.state = 'in_progress'; return { ok: true, adopted: true }; };
  const loop = createReopenLoop(w.deps);
  const made = await loop.maker({ payload: { ticketId: 'p-1', text: 'go on', ctx: CTX } });
  assert.equal(made.result.branch, 'a');
  assert.equal(made.result.via, 'queued');
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.match(w.replies.at(-1), /queued for its next park/);
  assert.deepEqual(w.calls.clearSession, [], 'the session did not change');
});
