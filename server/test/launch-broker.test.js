// server/test/launch-broker.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaunchBroker, launchQueueStaleness } from '../lib/orchestration/launch-broker.js';

const mk = (t = { v: 1000 }) => ({ t, b: createLaunchBroker({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-')), 'queue.json'), now: () => t.v }) });

test('enqueue, claim once, complete: the record walks pending -> claimed -> done', () => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'claude --resume abc', cwd: 'D:\\r', origin: 'resume' });
  assert.equal(b.pending().length, 1);
  assert.equal(b.claim(id, 'shell').state, 'claimed');
  assert.equal(b.claim(id, 'shell'), null, 'a second claim loses');
  assert.equal(b.complete(id, { pid: 42 }).state, 'done');
  assert.equal(b.pending().length, 0);
});

test('a failed spawn is recorded with its error', () => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'x', cwd: 'D:\\r', origin: 'terminal' });
  b.claim(id, 'shell');
  assert.equal(b.complete(id, { error: 'ENOENT' }).state, 'failed');
});

test('unknown origins are refused; the queue survives a restart; oldest pending age is measured', () => {
  const t = { v: 1000 }; const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-')), 'queue.json');
  const a = createLaunchBroker({ file, now: () => t.v });
  assert.throws(() => a.enqueue({ command: 'x', cwd: 'D:\\r', origin: 'web' }), /origin/);
  a.enqueue({ command: 'x', cwd: 'D:\\r', origin: 'runner' });
  t.v = 181_000;
  const b = createLaunchBroker({ file, now: () => t.v });
  assert.equal(b.pending().length, 1);
  assert.equal(b.oldestPendingAgeMs(), 180_000);
});

// Fix round 2, R2-3 groundwork: a test mocking the global Date.now AFTER
// construction (t.mock.method(Date, 'now', ...), used for the server-side
// integration test of the launch-queue loop's claimed-timeout sweep) must
// actually affect a broker built with no explicit `now` at all - this
// fails if the default parameter captures Date.now as a plain function
// reference (a snapshot taken once, at construction time, immune to any
// later monkey-patch of the Date.now PROPERTY).
test('a broker built with the default clock still sees a later Date.now mock (no now explicitly passed)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const b = createLaunchBroker({ file: path.join(dir, 'queue.json') });
  const { id } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  // Read back the REAL ts the broker itself recorded, rather than a
  // separately-captured Date.now() - racing against the real clock
  // between two separate calls is exactly the off-by-a-millisecond
  // flakiness this rewrite avoids.
  const enqueuedAt = b.get(id).ts;
  t.mock.method(Date, 'now', () => enqueuedAt + 180_000);
  try {
    assert.equal(b.oldestPendingAgeMs(), 180_000, 'the broker\'s own clock moved with the mock, not frozen at construction time');
  } finally { t.mock.restoreAll(); }
});

// queue.json is edited (by hand, or by a bug) just as
// readily as it is written by this module. An edited/corrupt row must be
// dropped and reported, never served or allowed to break a caller - a
// bogus `ts` of "x" would otherwise make oldestPendingAgeMs() NaN (NaN >
// 120_000 is false, so the launch-queue loop's own staleness check would
// silently stop ever firing), and a null array element would throw out of
// pending() entirely.
test('a malformed row is dropped on load and reported, not served', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  const good = { id: 'ln_11111111-1111-1111-1111-111111111111', command: 'claude', cwd: 'D:\\r', origin: 'runner', state: 'pending', ts: 1000, claimedBy: null, claimedTs: null, pid: null, error: null, doneTs: null };
  const rows = [
    good,
    { ...good, id: 'ln_bad-id' },
    { ...good, origin: 'web' },
    { ...good, command: 'a\nb' },
    { ...good, cwd: 42 },
    { ...good, ts: 'x' },
    { ...good, state: 'bogus' },
    null,
  ];
  fs.writeFileSync(file, JSON.stringify(rows));
  const misses = [];
  const b = createLaunchBroker({ file, now: () => 2000, reportMiss: (key, reason) => misses.push({ key, reason }) });
  assert.equal(b.pending().length, 1, 'only the one well-formed row is served');
  assert.equal(misses.length, 7, 'every malformed row is reported, one miss each');
  assert.ok(misses.every((m) => m.key === 'launch-broker-load'));
});

// Fix round 2, m-a: an ENOENT (no queue.json yet - every first boot) is
// normal and must not be reported as anything; any OTHER load failure
// (corrupt JSON, a non-array root) is a named miss, and the unreadable
// file is renamed aside instead of being silently discarded - so it is
// still there to inspect, and a stray leftover queue.json never masks a
// corrupt one that failed to load.
test('m-a: a missing queue.json (ENOENT) is normal, no miss reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  const misses = [];
  const b = createLaunchBroker({ file, reportMiss: (key, reason) => misses.push({ key, reason }) });
  assert.equal(misses.length, 0);
  assert.equal(b.pending().length, 0);
});

test('m-a: corrupt JSON is a named miss, and the file is quarantined (renamed aside), not silently discarded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, '{ not valid json');
  const misses = [];
  const b = createLaunchBroker({ file, now: () => 5000, reportMiss: (key, reason) => misses.push({ key, reason }) });
  assert.equal(b.pending().length, 0);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].key, 'launch-broker-load');
  assert.equal(fs.existsSync(file), false, 'the corrupt file no longer sits at the path a fresh queue will write to');
  const siblings = fs.readdirSync(dir);
  assert.equal(siblings.length, 1, 'the corrupt file was renamed aside, not deleted');
  assert.match(siblings[0], /queue\.json\.corrupt/);
});

test('m-a: a non-array JSON root is a named miss and quarantined the same way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, JSON.stringify({ not: 'an array' }));
  const misses = [];
  const b = createLaunchBroker({ file, reportMiss: (key, reason) => misses.push({ key, reason }) });
  assert.equal(b.pending().length, 0);
  assert.equal(misses.length, 1);
  assert.equal(fs.existsSync(file), false);
});

// a failed quarantine rename (the corrupt file could
// not be moved aside - a permissions error, say) used to be swallowed
// silently - the very next persist() would then write straight over the
// CORRUPT file at the original path, destroying the evidence quarantine()
// exists to preserve. A failed rename is now a named miss, and this
// broker writes its queue under a different filename instead, so the
// corrupt original is never touched again by anything this broker does.
test('M-6: a failed quarantine rename is reported and the corrupt file is never overwritten by a later persist', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, '{ not valid json');
  const originalContent = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('EPERM: simulated rename failure'); });
  const misses = [];
  let b;
  try {
    b = createLaunchBroker({ file, now: () => 5000, reportMiss: (key, reason) => misses.push({ key, reason }) });
  } finally { t.mock.restoreAll(); }
  assert.ok(misses.some((m) => m.key === 'launch-broker-quarantine'), 'the failed quarantine itself is a named miss');
  assert.equal(fs.existsSync(file), true, 'the corrupt file is still there - the rename failed, so it was never moved');
  assert.equal(fs.readFileSync(file, 'utf8'), originalContent, 'and still has its ORIGINAL (corrupt) content');

  // A subsequent persist (enqueue) must not write to the same path either
  // - that would silently clobber the evidence the instant anything used
  // this broker.
  b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  assert.equal(fs.readFileSync(file, 'utf8'), originalContent, 'still untouched after a real write through this broker');
  // round 3 wrote the new queue to a .recovered-* file
  // that no later boot ever read (each boot re-reads the corrupt
  // queue.json), so it only accumulated orphan files. The broker now runs
  // memory-only instead, and says so.
  const siblings = fs.readdirSync(dir).filter((f) => f !== 'queue.json');
  assert.deepEqual(siblings, [], 'no side file is written that no boot would ever read');
  assert.equal(b.pending().length, 1, 'the queue still works, in memory');
});

// the failed-quarantine miss used to drop the rename's own
// error code (`catch { return false; }`), and the next boot re-read the
// same corrupt queue.json. Each boot must name the code, keep the corrupt
// original untouched, and run with an empty in-memory queue.
test('F6: a quarantine rename that keeps failing is named with its code on every boot, and each boot runs empty and memory-only without touching the corrupt file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, '{ not valid json');
  const originalContent = fs.readFileSync(file, 'utf8');
  for (const boot of [1, 2]) {
    const misses = [];
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); });
    let b;
    try {
      b = createLaunchBroker({ file, now: () => 5000 + boot, reportMiss: (key, reason) => misses.push({ key, reason }) });
    } finally { t.mock.restoreAll(); }
    const q = misses.find((m) => m.key === 'launch-broker-quarantine');
    assert.ok(q, `boot ${boot}: the failed quarantine is named`);
    assert.match(q.reason, /EPERM/, `boot ${boot}: with the rename's own error code`);
    assert.match(q.reason, /memory/, `boot ${boot}: and says the queue is memory-only`);
    assert.equal(b.pending().length, 0, `boot ${boot}: starts empty`);
    b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'terminal' });
    assert.equal(b.pending().length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), originalContent, `boot ${boot}: corrupt original untouched`);
    assert.deepEqual(fs.readdirSync(dir), ['queue.json'], `boot ${boot}: nothing else written`);
  }
});

test('F6: a successful quarantine still persists normally afterwards', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, '{ not valid json');
  const b = createLaunchBroker({ file, now: () => 7000 });
  b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'terminal' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1, 'the fresh queue.json is written');
});

// pending()/get() must return copies: a caller mutating what it got back
// (the shell's own launch-runner.js reads these records) must never be
// able to corrupt the broker's own committed state.
test('pending() and get() return copies, not live references', () => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  const viaPending = b.pending()[0];
  viaPending.state = 'done';
  viaPending.command = 'rm -rf /';
  const viaGet = b.get(id);
  viaGet.state = 'done';
  assert.equal(b.get(id).state, 'pending', 'mutating a pending() result left the committed record untouched');
  assert.equal(b.get(id).command, 'claude', 'mutating a pending() result left the committed command untouched');
});

// Fix round 1, I3/m5: enqueue/claim/complete must not leave memory mutated
// if the write fails - a caller that got an exception (and so believes
// nothing happened) must not find a ghost row served by pending()/get()
// right after, invisible to anything that reads queue.json from disk.
test('enqueue does not leave a ghost row in memory when the write fails', (t) => {
  const { b } = mk();
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: simulated'); });
  assert.throws(() => b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' }), /ENOSPC/);
  t.mock.restoreAll();
  assert.equal(b.pending().length, 0, 'the failed enqueue left no trace in memory');
});

test('claim does not commit a state change in memory when the write fails', (t) => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: simulated'); });
  assert.throws(() => b.claim(id, 'shell'), /ENOSPC/);
  t.mock.restoreAll();
  assert.equal(b.get(id).state, 'pending', 'the failed claim left the record exactly as it was');
});

test('complete does not commit a state change in memory when the write fails', (t) => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  b.claim(id, 'shell');
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: simulated'); });
  assert.throws(() => b.complete(id, { pid: 1 }), /ENOSPC/);
  t.mock.restoreAll();
  assert.equal(b.get(id).state, 'claimed', 'the failed complete left the record exactly as it was');
});

// a record claimed but never completed (the shell quit
// mid-tick, or the result POST for an earlier record in the same batch
// threw) must also be measurable - oldestPendingAgeMs() alone only ever
// sees 'pending' rows, so a stuck 'claimed' row was invisible to the
// launch-queue loop's own staleness check.
test('oldestClaimedAgeMs measures how long the oldest unresolved claim has been held', () => {
  const t = { v: 1000 };
  const { b } = mk(t);
  const { id } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  assert.equal(b.oldestClaimedAgeMs(), 0, 'nothing claimed yet');
  b.claim(id, 'shell');
  t.v = 61_000;
  assert.equal(b.oldestClaimedAgeMs(), 60_000);
  b.complete(id, { pid: 1 });
  assert.equal(b.oldestClaimedAgeMs(), 0, 'resolved - no longer counted');
});

// the claimed-age branch this test used to cover is
// removed from launchQueueStaleness - a claimed-and-stale record is now
// actively resolved by failStaleClaims() (below), not merely alerted on,
// so this function only ever needs to watch the PENDING side (nothing has
// claimed it at all).
test('launchQueueStaleness: fresh queue is never stale; a pending launch past threshold is; a claimed one never counts here (failStaleClaims owns that now)', () => {
  const t = { v: 1000 };
  const { b } = mk(t);
  assert.equal(launchQueueStaleness(b).stale, false, 'an empty queue is never stale');

  const { id: a } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  assert.equal(launchQueueStaleness(b).stale, false, 'freshly queued, not yet stale');
  t.v += 121_000;
  const p = launchQueueStaleness(b);
  assert.equal(p.stale, true);
  assert.match(p.reason, /desktop shell has not polled since the kernel started \(not running or not reaching the kernel\)/);

  b.claim(a, 'shell');
  t.v += 1; // reset pending age (nothing pending now); claimedTs is fresh
  assert.equal(launchQueueStaleness(b).stale, false, 'just claimed, not yet stale');
  t.v += 10 * 60_000; // far past the old 60s claimed threshold
  assert.equal(launchQueueStaleness(b).stale, false, 'a claimed record, however old, is not this function\'s concern');

  b.complete(a, { pid: 1 });
  assert.equal(launchQueueStaleness(b).stale, false, 'resolved - no longer stale');
});

// glmps-2-0-61: with the shell stopped, the reason names how long since its
// last poll (or since boot, when it never polled), and tells a gone shell from
// one that polls but does not claim.
test('launchQueueStaleness names the shell heartbeat age', () => {
  const t = { v: 1_000_000 };
  const { b } = mk(t);
  b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  t.v += 5_580_000; // 93 minutes
  const now = () => t.v;

  const gone = launchQueueStaleness(b, { shellPolledAt: t.v - 5_600_000, now });
  assert.equal(gone.stale, true);
  assert.equal(gone.reason, '1 launch(es) waiting 5580 s: the desktop shell last polled 5600 s ago (not running or not reaching the kernel)');

  const refusing = launchQueueStaleness(b, { shellPolledAt: t.v - 2_000, now });
  assert.match(refusing.reason, /last polled 2 s ago \(running but not claiming\)/);

  const never = launchQueueStaleness(b, { shellPolledAt: null, bootedAt: t.v - 7_200_000, now });
  assert.match(never.reason, /has not polled since the kernel started 7200 s ago/);
});

// a stale-refused claim must not be left pending
// forever (the shell will keep retrying it every poll, and after 120s
// the loop would falsely report "the desktop shell is not running").
// fail() moves ANY non-terminal record straight to failed.
test('fail: moves a pending or claimed record straight to failed; a terminal record is left alone', () => {
  const { b } = mk();
  const { id: a } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  const failedA = b.fail(a, 'stale: runner job relaunched under a different launchId');
  assert.equal(failedA.state, 'failed');
  assert.equal(failedA.error, 'stale: runner job relaunched under a different launchId');
  assert.equal(b.pending().length, 0);

  const { id: c } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  b.claim(c, 'shell');
  const failedC = b.fail(c, 'some other reason');
  assert.equal(failedC.state, 'failed');

  assert.equal(b.fail(a, 'again'), null, 'already failed - a no-op, not a second transition');
});

test('fail does not commit a state change in memory when the write fails', (t) => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('ENOSPC: simulated'); });
  assert.throws(() => b.fail(id, 'x'), /ENOSPC/);
  t.mock.restoreAll();
  assert.equal(b.get(id).state, 'pending', 'the failed write left the record exactly as it was');
});

// a claimed record with no result (the shell quit
// mid-tick, or its result POST was lost) must not keep the launch-queue
// loop red forever by itself - failStaleClaims actively resolves it.
test('failStaleClaims: moves only claims older than the threshold to failed, with the given reason; pending and fresh claims are untouched', () => {
  const t = { v: 1000 };
  const { b } = mk(t);
  const { id: old } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'runner' });
  b.claim(old, 'shell');
  t.v += 61_000;
  const { id: fresh } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'terminal' });
  b.claim(fresh, 'shell');
  const { id: neverClaimed } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'learning' });

  const timedOut = b.failStaleClaims(60_000, 'no result from shell');
  assert.deepEqual(timedOut.map((r) => r.id), [old]);
  assert.equal(timedOut[0].error, 'no result from shell');
  assert.equal(b.get(old).state, 'failed');
  assert.equal(b.get(fresh).state, 'claimed', 'not yet past the threshold');
  assert.equal(b.get(neverClaimed).state, 'pending', 'never claimed at all - not this sweep\'s concern');

  assert.deepEqual(b.failStaleClaims(60_000, 'no result from shell'), [], 'nothing left to sweep');
});

// Fix round 2, m-e: a pending record (never even claimed) never expired
// on its own - resume/terminal/learning are bounded by a fixed idle-too-
// long time; runner by the job's own remaining runtime budget, which only
// the caller (server.js, with the runner ledger/config) knows. expirePending
// takes a per-record predicate instead of a single fixed threshold, so
// each origin's own rule lives with its own caller, not hardcoded here.
test('expirePending: a per-record predicate decides; only pending records matching it are moved to failed', () => {
  const t = { v: 1000 };
  const { b } = mk(t);
  const { id: old } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'resume' });
  t.v += 700_000; // old is now 700s old
  const { id: fresh } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'terminal' });
  const { id: claimedToo } = b.enqueue({ command: 'claude', cwd: 'D:\\r', origin: 'learning' });
  b.claim(claimedToo, 'shell');

  const expired = b.expirePending((r, nowMs) => (nowMs - r.ts) > 600_000, 'expired before the shell opened it');
  assert.deepEqual(expired.map((r) => r.id), [old]);
  assert.equal(expired[0].error, 'expired before the shell opened it');
  assert.equal(b.get(old).state, 'failed');
  assert.equal(b.get(fresh).state, 'pending', 'enqueued after the clock moved forward - not old enough yet (age 0)');
  assert.equal(b.get(claimedToo).state, 'claimed', 'claimed records are never this sweep\'s concern, whatever the predicate says');
});

test('requestCancel: a pending gitops record fails at once, a claimed one is flagged for the shell and survives a reload', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-')), 'queue.json');
  const b = createLaunchBroker({ file });
  const op = { kind: 'review', cwd: 'x' };
  const pend = b.enqueue({ command: 'gitops review', cwd: 'x', origin: 'gitops', op }).id;
  const run = b.enqueue({ command: 'gitops review', cwd: 'x', origin: 'gitops', op }).id;
  const other = b.enqueue({ command: 'gitops review', cwd: 'x', origin: 'gitops', op }).id;
  b.claim(run, 'shell'); b.claim(other, 'shell');
  assert.deepEqual(b.cancelRequested(), []);
  assert.equal(b.requestCancel(pend).state, 'failed');
  assert.match(b.get(pend).error, /cancel/);
  assert.equal(b.requestCancel(run).state, 'claimed');
  assert.deepEqual(b.cancelRequested(), [run]);
  assert.deepEqual(createLaunchBroker({ file }).cancelRequested(), [run], 'persisted');
  b.complete(run, { result: { status: -2, stdout: '', stderr: '', cancelled: true } });
  assert.deepEqual(b.cancelRequested(), [], 'a finished record is no longer asked to cancel');
  assert.equal(b.requestCancel(run), null);
  assert.equal(b.requestCancel('ln_00000000-0000-4000-8000-000000000000'), null);
  assert.equal(b.get(run).result.cancelled, true);
});

test('gitopsRecords lists the gitops records, so the server can find a review a previous run left behind', () => {
  const { b } = mk();
  b.enqueue({ command: 'claude', cwd: 'x', origin: 'terminal' });
  const g = b.enqueue({ command: 'gitops review', cwd: 'x', origin: 'gitops', op: { kind: 'review' } }).id;
  assert.deepEqual(b.gitopsRecords().map((r) => r.id), [g]);
});

const CLI = 'cli_0123456789abcdef';
const CLI2 = 'cli_fedcba9876543210';

test('targetClient: a client record is invisible to the shell poll, visible to its client, and cross-claims are refused', () => {
  const { b } = mk();
  const mine = b.enqueue({ command: 'claude --resume x', cwd: 'C:/w', origin: 'resume', targetClient: CLI });
  const shell = b.enqueue({ command: 'claude', cwd: 'D:/r', origin: 'terminal' });
  assert.deepEqual(b.pending().map((r) => r.id), [shell.id], 'the shell sees only untargeted records');
  assert.deepEqual(b.pending({ client: CLI }).map((r) => r.id), [mine.id]);
  assert.deepEqual(b.pending({ client: CLI2 }), []);
  assert.equal(b.get(mine.id).targetClient, CLI);
  assert.equal(b.get(shell.id).targetClient, null);
  assert.equal(b.claim(mine.id, 'shell'), null, 'the shell cannot claim a client record');
  assert.equal(b.claim(mine.id, 'tap', { client: CLI2 }), null, 'another client cannot');
  assert.equal(b.claim(shell.id, 'tap', { client: CLI }), null, 'a client cannot claim the shell\'s record');
  assert.equal(b.claim(mine.id, `tap:${CLI}`, { client: CLI }).state, 'claimed');
  assert.equal(b.get(shell.id).state, 'pending');
});

test('targetClient must be a cli_ client id, and survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-')), 'queue.json');
  const a = createLaunchBroker({ file });
  for (const bad of ['laptop', 'cli_', '../x', 5, '']) assert.throws(() => a.enqueue({ command: 'x', cwd: 'C:/w', origin: 'terminal', targetClient: bad }), /targetClient/, String(bad));
  const { id } = a.enqueue({ command: 'x', cwd: 'C:/w', origin: 'terminal', targetClient: CLI });
  assert.equal(createLaunchBroker({ file }).get(id).targetClient, CLI);
});

test('client records do not count toward the shell staleness age', () => {
  const t = { v: 1000 }; const { b } = mk(t);
  b.enqueue({ command: 'x', cwd: 'C:/w', origin: 'terminal', targetClient: CLI });
  t.v = 500_000;
  assert.equal(b.oldestPendingAgeMs(), 0);
  assert.equal(launchQueueStaleness(b, { now: () => t.v }).stale, false);
});

test('file origin needs a client; a client editor or file record needs a well-formed action', () => {
  const { b } = mk();
  assert.throws(() => b.enqueue({ command: 'file read', cwd: 'C:/w/a', origin: 'file', action: { op: 'read', path: 'C:/w/a' } }), /targetClient/);
  assert.throws(() => b.enqueue({ command: 'open-in-editor', cwd: 'C:/w', origin: 'editor', action: { kind: 'open', path: 'C:/w/a' } }), /path/, 'an untargeted editor record needs path, an action does not stand in for it');
  assert.throws(() => b.enqueue({ command: 'open-in-editor', cwd: 'C:/w', origin: 'editor', targetClient: CLI, action: { kind: 'zap', path: 'C:/w/a' } }), /action/);
  assert.throws(() => b.enqueue({ command: 'file read', cwd: 'C:/w/a', origin: 'file', targetClient: CLI, action: { op: 'delete', path: 'C:/w/a' } }), /action/);
  assert.throws(() => b.enqueue({ command: 'file read', cwd: 'C:/w/a', origin: 'file', targetClient: CLI }), /action/);
  const e = b.enqueue({ command: 'open-in-editor', cwd: 'C:/w', origin: 'editor', targetClient: CLI, action: { kind: 'open', path: 'C:/w/a' } });
  assert.deepEqual(b.get(e.id).action, { kind: 'open', path: 'C:/w/a' });
  assert.equal('path' in b.get(e.id), false);
  assert.deepEqual(b.pending(), [], 'the shell editor runner never sees a client editor record');
});

test('a file record carries a result, and scrub drops the content and the result', () => {
  const { b } = mk();
  const { id } = b.enqueue({ command: 'file save', cwd: 'C:/w/a', origin: 'file', targetClient: CLI, action: { op: 'save', path: 'C:/w/a', content: 'secret', hash: 'h', force: false } });
  assert.equal(b.get(id).action.content, 'secret');
  b.claim(id, 'tap', { client: CLI });
  assert.deepEqual(b.complete(id, { result: { status: 200, body: { ok: true } } }).result, { status: 200, body: { ok: true } });
  assert.equal(b.pending({ client: CLI }).length, 0);
  const s = b.scrub(id);
  assert.equal(s.result, null);
  assert.equal('content' in s.action, false);
  assert.equal(s.action.path, 'C:/w/a');
  assert.equal(b.scrub(b.enqueue({ command: 'x', cwd: 'C:/w', origin: 'terminal' }).id), null, 'only gitops and file records scrub');
});

test('a malformed client row on disk is sanitized, not trusted', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-')), 'queue.json');
  const row = { id: 'ln_00000000-0000-0000-0000-000000000001', command: 'x', cwd: 'C:/w', origin: 'file', state: 'pending', ts: 1, targetClient: '../evil', action: 'nope' };
  fs.writeFileSync(file, JSON.stringify([row]));
  const r = createLaunchBroker({ file }).get(row.id);
  assert.equal(r.targetClient, null);
  assert.equal(r.action, null);
});

test('editor origin: carries the file path, walks pending -> claimed -> done, and survives a restart', () => {
  const t = { v: 1000 }; const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-launch-')), 'queue.json');
  const a = createLaunchBroker({ file, now: () => t.v });
  const { id } = a.enqueue({ command: 'open-in-editor', cwd: '/r', origin: 'editor', path: '/r/CLAUDE.md' });
  const b = createLaunchBroker({ file, now: () => t.v });
  assert.equal(b.pending()[0].path, '/r/CLAUDE.md');
  assert.equal(b.claim(id, 'shell').state, 'claimed');
  assert.equal(b.complete(id, { pid: 7 }).state, 'done');
});

test('editor origin: an enqueue without a string path is refused', () => {
  const { b } = mk();
  assert.throws(() => b.enqueue({ command: 'open-in-editor', cwd: 'D:/r', origin: 'editor' }), /path/);
  assert.throws(() => b.enqueue({ command: 'open-in-editor', cwd: 'D:/r', origin: 'editor', path: 'D:/r/a\nb' }), /path/);
});
