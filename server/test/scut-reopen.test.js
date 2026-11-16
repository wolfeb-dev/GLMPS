// server/test/scut-reopen.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionUuid, planRunSessionRecords, reopenBranch, REOPENABLE_STATES, activityEntryFor, ledgerPatchFor, diagnoseUnrecorded, recordLaunchSessionSafe } from '../lib/scut/reopen.js';
import { ticketActivityMs } from '../lib/scut/park.js';

const SID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SID2 = '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e';

test('isSessionUuid accepts a UUID and refuses anything a shell could misread', () => {
  assert.equal(isSessionUuid(SID), true);
  for (const bad of ['', null, 'abc', `${SID} & calc`, `"${SID}"`, `${SID}\n`]) assert.equal(isSessionUuid(bad), false, String(bad));
});

test('planRunSessionRecords binds a live session working in the runner worktree, once', () => {
  const ledger = {
    'p-1': { target: 'native-terminal', startedAt: 1000, worktree: { dir: 'W/p/p-1', branch: 'glmps-runner/p/p-1', repo: 'R' } },
    'p-2': { target: 'native-terminal', sessionId: 'already', startedAt: 1000, worktree: null },
    'p-3': { target: 'antigravity', startedAt: 1000, worktree: null },
  };
  const live = [
    { id: SID, live: true, firstTs: 2000, worktree: { kind: 'runner', id: 'p-1' } },
    { id: 'x', live: true, firstTs: 2000, worktree: { kind: 'runner', id: 'p-2' } },
  ];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), [
    { id: 'p-1', sessionId: SID, launcher: 'native-terminal', worktree: { dir: 'W/p/p-1', branch: 'glmps-runner/p/p-1', repo: 'R' } },
  ]);
});

// worktreePlan is deterministic on the ticket id
// (glmps-53), so a stale release or a requeue relaunches the SAME
// job id into the SAME worktree directory a prior (or foreign) session may
// still be sitting in. `live.find` on first match, written once and never
// corrected, could permanently bind that old/foreign session, and Task 7's
// reopen depends on this id being the right one. The fix requires ALL of:
// only a candidate whose first activity is at or after the job's own
// startedAt; never the card's previous runSession id; ambiguity (more than
// one qualifying candidate) records nothing that tick rather than guessing;
// and the id must pass isSessionUuid before it is ever persisted.

test('planRunSessionRecords: two qualifying live sessions in the same worktree is ambiguous - records nothing', () => {
  const ledger = { 'p-1': { target: 'native-terminal', startedAt: 1000, worktree: null } };
  const live = [
    { id: SID, firstTs: 2000, worktree: { kind: 'runner', id: 'p-1' } },
    { id: SID2, firstTs: 2500, worktree: { kind: 'runner', id: 'p-1' } },
  ];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), []);
});

test('planRunSessionRecords: a session whose first activity predates the job launch is never chosen', () => {
  const ledger = { 'p-1': { target: 'native-terminal', startedAt: 5000, worktree: null } };
  // This session was already running (in the reused worktree) before the job
  // that owns this ledger entry was even launched - exactly the "old
  // controller session" the reused-worktree bug binds if left unfiltered.
  const live = [{ id: SID, firstTs: 4000, worktree: { kind: 'runner', id: 'p-1' } }];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), []);
});

test('planRunSessionRecords: the card\'s previous runSession.sessionId is excluded, even if it is still live in the worktree', () => {
  const ledger = { 'p-1': { target: 'native-terminal', startedAt: 1000, worktree: null } };
  const live = [{ id: SID, firstTs: 2000, worktree: { kind: 'runner', id: 'p-1' } }];
  assert.deepEqual(planRunSessionRecords({ ledger, live, previousSessionIds: { 'p-1': SID } }), []);
});

test('planRunSessionRecords: a candidate whose id is not a session UUID is never recorded', () => {
  const ledger = { 'p-1': { target: 'native-terminal', startedAt: 1000, worktree: null } };
  const live = [{ id: 'x', firstTs: 2000, worktree: { kind: 'runner', id: 'p-1' } }];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), []);
});

// round 2's premise here was wrong. The runner
// never launches a native Antigravity agent. Every launch target runs the
// SAME seeded `claude "..."` command through server.js's launchSession, which
// now always goes through launchNative (the editor-companion record path was
// deleted with the companion), so it can take --session-id exactly like
// native-terminal, and does (server.js's launchJob mints one for every
// launch target). The two tests that used to
// live here (an antigravity candidate with a non-UUID id, or with no
// derivable firstTs, still recorded) tested a relaxation that no longer
// exists - removed rather than kept as dead weight; `candidateOk` is fully
// strict again, uniformly, for every candidate regardless of tool.

// the inverse of the two tests removed above - an
// antigravity-tool candidate gets NO relaxation, so a shape that would refuse
// any other tool (a non-UUID id) refuses this one too. Guards against a
// regression that reintroduces per-launcher leniency for antigravity.
test('planRunSessionRecords: a tool \'antigravity\' candidate with a non-UUID id is refused, same as any other tool (Task 6 review carry-in c)', () => {
  const ledger = { 'p-1': { target: 'antigravity', startedAt: 1000, worktree: null } };
  const live = [{ id: 'ag-native-id', tool: 'antigravity', firstTs: 2000, worktree: { kind: 'runner', id: 'p-1' } }];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), []);
});

// Round 2 review, M3.
test('planRunSessionRecords: a claude-code-shaped candidate with no firstTs is refused, not admitted', () => {
  const ledger = { 'p-1': { target: 'native-terminal', startedAt: 1000, worktree: null } };
  const live = [{ id: SID, firstTs: null, worktree: { kind: 'runner', id: 'p-1' } }];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), []);
});

test('planRunSessionRecords: an entry with no startedAt is skipped, even with an otherwise-perfect live candidate', () => {
  const ledger = { 'p-1': { target: 'native-terminal', worktree: null } }; // no startedAt at all
  const live = [{ id: SID, firstTs: 2000, worktree: { kind: 'runner', id: 'p-1' } }];
  assert.deepEqual(planRunSessionRecords({ ledger, live }), []);
});

// diagnoseUnrecorded names why an entry is still
// unrecorded after a tick's attempt, instead of a silent null - one of
// 'missing-startedAt', 'no-candidates', 'firstts-unavailable', or
// 'ambiguous'. An entry that WOULD be recorded (or already has a session)
// is not diagnosed at all.
test('diagnoseUnrecorded: names missing-startedAt, no-candidates, firstts-unavailable and ambiguous; is silent for a recordable or already-recorded entry', () => {
  const ledger = {
    'no-started': { target: 'native-terminal', worktree: null },
    'no-candidates': { target: 'native-terminal', startedAt: 1000, worktree: null },
    'firstts-unavailable': { target: 'native-terminal', startedAt: 5000, worktree: null },
    'ambiguous': { target: 'native-terminal', startedAt: 1000, worktree: null },
    'recordable': { target: 'native-terminal', startedAt: 1000, worktree: null },
    'already-recorded': { target: 'native-terminal', startedAt: 1000, sessionId: 'already', worktree: null },
  };
  const live = [
    // 'no-candidates': nothing in this worktree at all.
    // 'firstts-unavailable': one candidate, but it predates startedAt.
    { id: SID, firstTs: 4000, worktree: { kind: 'runner', id: 'firstts-unavailable' } },
    // 'ambiguous': two qualifying candidates.
    { id: SID, firstTs: 2000, worktree: { kind: 'runner', id: 'ambiguous' } },
    { id: SID2, firstTs: 2500, worktree: { kind: 'runner', id: 'ambiguous' } },
    // 'recordable': exactly one qualifying candidate.
    { id: SID, firstTs: 2000, worktree: { kind: 'runner', id: 'recordable' } },
  ];
  const out = diagnoseUnrecorded({ ledger, live });
  const byId = Object.fromEntries(out.map((d) => [d.id, d.reason]));
  assert.equal(byId['no-started'], 'missing-startedAt');
  assert.equal(byId['no-candidates'], 'no-candidates');
  assert.equal(byId['firstts-unavailable'], 'firstts-unavailable');
  assert.equal(byId['ambiguous'], 'ambiguous');
  assert.equal('recordable' in byId, false, 'a recordable entry is not diagnosed');
  assert.equal('already-recorded' in byId, false, 'an already-recorded entry is not diagnosed');
});

// the original version of this test called
// ticketActivityMs directly with a summaries fixture whose worktree ALSO
// matched the ticket id, so it passed unchanged even with the runSession
// fallback deleted entirely - the worktree-match arm alone supplied the
// answer, and the test never actually exercised the fallback it claimed to
// prove. Fixed by extracting the substitution server.js's activityTs closure
// performs (server/server.js, the parkSweepLoop wiring) into activityEntryFor,
// and by using a summaries fixture whose ONLY link to the ticket is the
// session id itself (no worktree on the entry at all) - so if the fallback is
// missing, ticketActivityMs has no other way to find the session and this
// test fails.
//
// RED, with the fallback removed (activityEntryFor implemented as
// `entry?.sessionId ? entry : {}`, i.e. no runSession lookup):
//   AssertionError: checker must resolve the session via runSession when
//   nothing else links them
//   + actual: null
//   - expected: 5000
test('activityEntryFor: the checker (ledger entry already gone) resolves the same session as the maker (ledger entry still has sessionId), when the ONLY link is the recorded session id', () => {
  const summaries = [{ id: SID, lastTs: 5000, worktree: null }]; // no worktree match possible
  const tailTsOf = () => null;
  const card = { id: 'p-1', runSession: { sessionId: SID } };

  // Maker time: the real ledger entry, still carrying sessionId.
  const makerEntry = activityEntryFor({ sessionId: SID }, card);
  // Checker time: the ledger entry for this id is already gone post-release
  // (createParkSweepLoop's checker calls this with an empty entry).
  const checkerEntry = activityEntryFor({}, card);

  const makerMs = ticketActivityMs({ ticketId: 'p-1', entry: makerEntry, summaries, tailTsOf });
  const checkerMs = ticketActivityMs({ ticketId: 'p-1', entry: checkerEntry, summaries, tailTsOf });

  assert.equal(makerMs, 5000);
  assert.equal(checkerMs, 5000, 'checker must resolve the session via runSession when nothing else links them');
});

test('activityEntryFor: with no card (or no runSession recorded yet), the checker resolves to no session, not a crash', () => {
  assert.deepEqual(activityEntryFor({}, undefined), { sessionId: null });
  assert.deepEqual(activityEntryFor({}, { id: 'p-1' }), { sessionId: null });
});

// the card write (setRunSessionIn) is what Task 7's
// reopen actually reads; the ledger's copy is only a same-tick fast path. If
// the card write did not land (e.g. the card was deleted or never existed),
// mirroring the session onto the ledger anyway would leave the ledger
// claiming a session the card never recorded, and the ledger's own
// `if (entry?.sessionId) continue` guard means that entry would then never
// be retried even though the card still has nothing.
test('ledgerPatchFor: mirrors onto the ledger only once the card write has actually landed', () => {
  const rec = { id: 'p-1', sessionId: SID, launcher: 'native-terminal', worktree: null };
  assert.deepEqual(ledgerPatchFor(rec, { item: { id: 'p-1', runSession: { sessionId: SID } } }), { sessionId: SID, launcher: 'native-terminal' });
  assert.equal(ledgerPatchFor(rec, { item: null }), null, 'a missing/failed card write must never mark the ledger');
});

// recordLaunchSessionSafe runs AFTER launchJob has
// already spawned the session - a throw from the card write must never
// escape to the dispatch caller (it used to fall into runnerTick's outer
// bare catch, which then skipped writing the ledger entry for a job that was
// already running - untracked, no reconcile, no reclaim).
test('recordLaunchSessionSafe: a throwing write is caught, reported by name, and returns {} so the ledger entry is still written', () => {
  const misses = [];
  const patch = recordLaunchSessionSafe(
    { sessionId: SID, launcher: 'native-terminal' },
    () => { throw new Error('EPERM: card write failed'); },
    (reason) => misses.push(reason),
  );
  assert.deepEqual(patch, {});
  assert.deepEqual(misses, ['EPERM: card write failed']);
});

test('recordLaunchSessionSafe: a successful write returns the ledger patch, and never calls onMiss', () => {
  const misses = [];
  const patch = recordLaunchSessionSafe(
    { sessionId: SID, launcher: 'native-terminal' },
    () => ({ item: { id: 'p-1', runSession: { sessionId: SID } } }),
    (reason) => misses.push(reason),
  );
  assert.deepEqual(patch, { sessionId: SID, launcher: 'native-terminal' });
  assert.deepEqual(misses, []);
});

test('recordLaunchSessionSafe: no sessionId means nothing to write - write() is never called', () => {
  let called = false;
  const patch = recordLaunchSessionSafe({ sessionId: null, launcher: 'native-terminal' }, () => { called = true; }, () => {});
  assert.deepEqual(patch, {});
  assert.equal(called, false);
});


const RS = { sessionId: SID, launcher: 'native-terminal', worktree: { dir: 'W/p/p-1', branch: 'b', repo: 'R' } };

test('reopenBranch (a): a parked or running session gets the message', () => {
  assert.deepEqual(reopenBranch({ entry: { parkedSince: 1 }, item: { runSession: RS }, parked: true, sessionLive: false, worktreeExists: true }), { branch: 'a', reason: 'parked' });
  assert.deepEqual(reopenBranch({ entry: {}, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true }), { branch: 'a', reason: 'running' });
});

test('reopenBranch (b): an ended Claude Code session with its worktree resumes', () => {
  assert.deepEqual(reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: false, worktreeExists: true }), { branch: 'b', reason: 'the session ended' });
});

// Important 1: round 1's
// blanket `sessionLive && !entry -> refuse` sent the MAIN paused-then-reply
// path to a fresh relaunch instead of a resume. A released ticket's
// interactive terminal is a REPL that stays open (nothing kills the process
// on release), and its own sign-off write refreshes the transcript - so a
// raw liveness probe (registry-alive, or "written within the last 10
// minutes") reads as "still live" for the ENTIRE normal case, not just the
// genuinely-still-working one this guard was meant to catch.
//
// Controller decision: for the reopen decision only, a released session
// counts as ACTIVE (and refuses) only when its transcript shows writes LATER
// than endedTs + REOPEN_ACTIVE_GRACE_MS (120s, covering the release
// sign-off write itself). An idle, merely-open terminal with no writes since
// the grace is safe to resume into.
//
// the parameter is renamed releasedTs -> endedTs here -
// the reference is no longer "when the card was released" (that value went
// stale: I4 below) but "when the card entered its CURRENT reopenable state"
// (idleSince/doneAt/stateEnteredAt), a concept that applies to done,
// cancelled and archived too, not just a park-release.
const ENDED_TS = 1_000_000;

test('reopenBranch: a session with no activity after the sign-off grace resumes, even with the terminal still open (Important 1, fix round 2)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS }),
    { branch: 'b', reason: 'the session ended' },
  );
});

test('reopenBranch: activity after the post-release grace is refused, not resumed (Important 1, fix round 2)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 121_000 }),
    { branch: 'x', reason: 'session is active in its own terminal' },
  );
});

// post-grace activity alone is not
// enough to refuse. Once the operator closes the terminal, the transcript
// still shows that old post-grace activity for ever, so an activity-only rule
// refused every later reply and "close it and reply again" could never clear
// it. Branch 'x' needs BOTH post-grace activity AND the session live now
// (registry-alive, or transcript written within the ccLive window).
test('reopenBranch: activity after the grace but the terminal since closed (not live now) resumes (I1, fix round 4)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: false, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 121_000 }),
    { branch: 'b', reason: 'the session ended' },
  );
});

test('reopenBranch: activity after the grace with the session live now refuses (I1, fix round 4)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 121_000 }),
    { branch: 'x', reason: 'session is active in its own terminal' },
  );
});

test('reopenBranch: the release sign-off write itself, inside the grace, still resumes (Important 1, fix round 2)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 5_000 }),
    { branch: 'b', reason: 'the session ended' },
  );
});

// endedTs is normalised inside reopenBranch (a number as
// given; a string via Date.parse, matching park.js's ticketActivityMs). If
// present but not finite after normalising, refuse with a named reason -
// never guess and resume against unreadable data.
test('reopenBranch: a NaN end time refuses, named, rather than guessing (I3)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: NaN, lastActivityTs: ENDED_TS }),
    { branch: 'x', reason: 'unreadable end time' },
  );
});

test('reopenBranch: an ISO string end time normalises the same as its epoch-ms equivalent (I3)', () => {
  const iso = new Date(ENDED_TS).toISOString();
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: iso, lastActivityTs: ENDED_TS + 121_000 }),
    { branch: 'x', reason: 'session is active in its own terminal' },
  );
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: iso, lastActivityTs: ENDED_TS + 5_000 }),
    { branch: 'b', reason: 'the session ended' },
  );
});

test('reopenBranch: the exact grace boundary still resumes - strictly greater-than, not greater-or-equal (I3)', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 120_000 }),
    { branch: 'b', reason: 'the session ended' },
  );
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 120_001 }),
    { branch: 'x', reason: 'session is active in its own terminal' },
  );
});

// the stale-reference bug lived in WHERE endedTs comes from
// (item.release.ts was never cleared), not in reopenBranch, which is pure and
// uses whatever it is given. A reopenBranch-level test cannot discriminate it
// , so the coverage
// is the per-episode stamping in backlog-idle.test.js: "stateEnteredAt stamps
// entry into cancelled or archived, and clears on exit", "stateEnteredAt is
// stamped uniformly for idle and done too", "stateEnteredAt refreshes on a
// direct transition between two reopenable states, never left stale (I4)",
// and the sweepArchive test added in fix round 4 (M2).

// an antigravity launch runs the same claude CLI in an
// editor terminal and records a real, resumable claude session id exactly
// like native-terminal (server.js's launchJob mints for every launch target).
// This REPLACES the brief's original assertion that an antigravity launcher
// forces branch c - that premise no longer holds after Task 6.
test('reopenBranch (b): an antigravity-launched card with an ended, resumable session also resumes, not branch c (R4)', () => {
  assert.deepEqual(reopenBranch({ entry: null, item: { runSession: { ...RS, launcher: 'antigravity' } }, parked: false, sessionLive: false, worktreeExists: true }), { branch: 'b', reason: 'the session ended' });
});

test('reopenBranch (c): every way a resume is impossible names its reason', () => {
  const c = (item, worktreeExists = true) => reopenBranch({ entry: null, item, parked: false, sessionLive: false, worktreeExists });
  assert.deepEqual(c({}), { branch: 'c', reason: 'no session was recorded for this card' });
  assert.deepEqual(c({ runSession: { ...RS, sessionId: 'not-a-uuid' } }), { branch: 'c', reason: 'the recorded session id is not resumable' });
  // A launcher that is neither native-terminal nor antigravity (e.g. a legacy
  // or foreign recorded value) is the case that still cannot be resumed.
  assert.deepEqual(c({ runSession: { ...RS, launcher: 'vscode' } }), { branch: 'c', reason: 'sessions launched in vscode cannot be resumed' });
  assert.deepEqual(c({ runSession: { ...RS, worktree: null } }), { branch: 'c', reason: 'it did not run in a worktree of its own' });
  assert.deepEqual(c({ runSession: RS }, false), { branch: 'c', reason: 'its worktree is gone' });
  assert.deepEqual(c({ runSession: { ...RS, purgedTs: 5 } }), { branch: 'c', reason: 'its worktree was purged' });
});

test('REOPENABLE_STATES are the non-running states a reply can bring back', () => {
  assert.deepEqual([...REOPENABLE_STATES].sort(), ['archived', 'cancelled', 'done', 'idle']);
});

// Unattended reliability T6: a headless session exits when its run ends, so it is never live afterwards.
test('reopenBranch: a headless card resumes its session, and recent activity never refuses it as active in a terminal', () => {
  const HS = { ...RS, launcher: 'headless' };
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: HS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 121_000 }),
    { branch: 'b', reason: 'the session ended' },
  );
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: HS }, parked: false, sessionLive: false, worktreeExists: false }),
    { branch: 'c', reason: 'its worktree is gone' },
  );
});

// Card glmps-2-0-109, operator option B: Claude Code's own idle|busy for the
// open window outranks the transcript clock.
test('reopenBranch: an open window Claude reports idle resumes (its launch closes the window first), even after post-grace activity', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 121_000, windowStatus: 'idle' }),
    { branch: 'b', reason: 'the session ended' },
  );
});

test('reopenBranch: an open window Claude reports busy is refused, even with no activity after the grace', () => {
  assert.deepEqual(
    reopenBranch({ entry: null, item: { runSession: RS }, parked: false, sessionLive: true, worktreeExists: true, endedTs: ENDED_TS, lastActivityTs: ENDED_TS + 5_000, windowStatus: 'busy' }),
    { branch: 'x', reason: 'session is active in its own terminal' },
  );
});
