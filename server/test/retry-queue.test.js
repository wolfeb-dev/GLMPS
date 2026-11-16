import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRetryQueue } from '../lib/plugins/retry-queue.js';

test('jobs persist across instances; ack removes; bump counts attempts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const a = createRetryQueue({ file, now: () => 1 });
  a.push({ kind: 'memory.admit', sessionId: 's1' }); a.push({ kind: 'memory.admit', sessionId: 's2' });
  const b = createRetryQueue({ file });
  const jobs = b.take(10);
  assert.deepEqual(jobs.map((j) => j.sessionId), ['s1', 's2']);
  b.bump(jobs[1].id); b.ack(jobs[0].id);
  const left = createRetryQueue({ file }).take(10);
  assert.equal(left.length, 1); assert.equal(left[0].attempts, 1);
});

// bump() used to leave a failed job in
// place and take(n) always takes the first n, so a run of always-failing
// jobs at the head of the file starves every job behind them (a job only
// gives up, and stops being re-taken every tick, after 10 attempts - roughly
// 50 minutes at the 5-minute tick). Moving a bumped job to the end of the
// file is what lets a healthy job behind it get a turn on the very next tick.
test('bump() moves the job to the end of the file, so it does not block the jobs behind it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  q.push({ kind: 'memory.admit', sessionId: 's2' });
  q.push({ kind: 'memory.admit', sessionId: 's3' });
  const [j1] = q.take(10);
  q.bump(j1.id);
  const after = q.take(10);
  assert.deepEqual(after.map((j) => j.sessionId), ['s2', 's3', 's1']);
  assert.equal(after[2].attempts, 1);
});
test('size() reports the current queue length', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  assert.equal(q.size(), 0);
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  q.push({ kind: 'memory.admit', sessionId: 's2' });
  assert.equal(q.size(), 2);
});

test('take(n) never returns more than n jobs', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  for (let i = 0; i < 5; i++) q.push({ kind: 'memory.admit', sessionId: `s${i}` });
  assert.equal(q.take(2).length, 2);
});

test('a missing queue file reads as empty rather than throwing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'missing.ndjson');
  const q = createRetryQueue({ file });
  assert.deepEqual(q.take(10), []);
  assert.equal(q.size(), 0);
});

// the original read() did `.split('\n').map(JSON.parse)`
// in one pass, so a SINGLE torn/corrupt line threw inside .map(), the outer
// try/catch caught it, and read() returned [] -- silently discarding every
// OTHER job in the file too, not just the bad line. Each line must be
// parsed independently, skipping (and counting) only the ones that fail.
test('a single corrupt line does not empty the rest of the queue', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  fs.appendFileSync(file, 'not valid json at all\n');
  q.push({ kind: 'memory.admit', sessionId: 's2' });
  const jobs = q.take(10);
  assert.deepEqual(jobs.map((j) => j.sessionId), ['s1', 's2'], 'both real jobs survive; only the torn line is skipped');
});

test('onCorrupt is called with the count of unparseable lines', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  let reported = null;
  const q = createRetryQueue({ file, onCorrupt: (n) => { reported = n; } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage one\ngarbage two\n');
  q.take(10);
  assert.equal(reported, 2);
});

test('onCorrupt is never called when every line parses cleanly', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  let called = false;
  const q = createRetryQueue({ file, onCorrupt: () => { called = true; } });
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  q.take(10);
  assert.equal(called, false);
});

test('a throwing onCorrupt never breaks the read', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file, onCorrupt: () => { throw new Error('reporting itself is broken'); } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage\n');
  assert.doesNotThrow(() => q.take(10));
});

// a clean read must be able to clear an earlier
// corruption episode (health.js's clearMiss(), wired in by the caller) -
// onOk is the success-side counterpart to onCorrupt.
test('onOk is called when every line parses cleanly', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  let called = 0;
  const q = createRetryQueue({ file, onOk: () => { called++; } });
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  q.take(10);
  assert.equal(called, 1);
});

test('onOk is never called while the file has an unparseable line', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  let called = false;
  const q = createRetryQueue({ file, onOk: () => { called = true; } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'garbage\n');
  q.take(10);
  assert.equal(called, false);
});

test('onOk is never called before the queue file exists (nothing read yet, not a clean read)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  let called = false;
  const q = createRetryQueue({ file, onOk: () => { called = true; } });
  q.take(10);
  assert.equal(called, false);
});

test('a throwing onOk never breaks the read', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file, onOk: () => { throw new Error('reporting itself is broken'); } });
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  assert.doesNotThrow(() => q.take(10));
});

// judge-on-quiescence needs one durable
// job per session that a later ping updates in place (moves notBefore
// forward) rather than duplicating.
test('upsert() creates a new job when no job matches', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file, now: () => 100 });
  q.upsert((j) => j.kind === 'judge.session' && j.sessionId === 's1', { kind: 'judge.session', sessionId: 's1', notBefore: 500 });
  const jobs = q.take(10, { now: 500 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sessionId, 's1');
  assert.equal(jobs[0].notBefore, 500);
  assert.equal(jobs[0].attempts, 0);
  assert.ok(jobs[0].id);
});

test('upsert() updates the matching job in place instead of creating a duplicate, keeping its id and attempts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  q.upsert((j) => j.kind === 'judge.session' && j.sessionId === 's1', { kind: 'judge.session', sessionId: 's1', notBefore: 100 });
  const [first] = q.take(10, { now: 100 });
  q.bump(first.id); // simulate an attempt having been recorded
  q.upsert((j) => j.kind === 'judge.session' && j.sessionId === 's1', { kind: 'judge.session', sessionId: 's1', notBefore: 999 });
  const jobs = q.take(10, { now: 999 });
  assert.equal(jobs.length, 1, 'still exactly one job, not two');
  assert.equal(jobs[0].id, first.id, 'same job, updated in place');
  assert.equal(jobs[0].notBefore, 999, 'notBefore pushed forward');
  assert.equal(jobs[0].attempts, 1, 'attempts preserved across the upsert');
});

// a not-due job must not consume one of the n taken this tick - a
// judge.session job that is not due yet must never block a due job behind
// it, mirroring B1's fairness fix for always-failing jobs.
test('take(n, {now}) skips jobs whose notBefore is in the future, without consuming the n budget', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  q.upsert((j) => j.sessionId === 'notyet', { kind: 'judge.session', sessionId: 'notyet', notBefore: 10_000 });
  q.push({ kind: 'memory.admit', sessionId: 'due1' });
  const jobs = q.take(1, { now: 500 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].sessionId, 'due1', 'the not-due job is skipped entirely, not counted against the n=1 budget');
});

test('take(n, {now}) includes a job whose notBefore has passed', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  q.upsert((j) => j.sessionId === 's1', { kind: 'judge.session', sessionId: 's1', notBefore: 100 });
  assert.equal(q.take(10, { now: 100 }).length, 1);
});

test('take(n) with no job ever carrying notBefore behaves exactly as before', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  const q = createRetryQueue({ file });
  q.push({ kind: 'memory.admit', sessionId: 's1' });
  assert.equal(q.take(10).length, 1);
});

// A push() after a file whose last write was torn (no trailing newline, e.g.
// a crash mid-write) must not concatenate onto that partial line -- it would
// corrupt BOTH the prior line and the new one.
test('push() starts on a new line even if the file does not end with a newline', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rq-')), 'q.ndjson');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"id":"a","sessionId":"s1","attempts":0}'); // no trailing \n
  const q = createRetryQueue({ file });
  q.push({ kind: 'memory.admit', sessionId: 's2' });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
  assert.doesNotThrow(() => JSON.parse(lines[1]));
});
