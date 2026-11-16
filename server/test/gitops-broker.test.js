import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaunchBroker } from '../lib/orchestration/launch-broker.js';
import { waitFor } from './helpers/wait-for.js';
import { createGitopsBroker, createShellSeams, isGitopsInfraError, pickupSummary, PICKUP_SAMPLES } from '../lib/orchestration/gitops-broker.js';

const ROOTS = { repos: ['D:\\glmps'], worktrees: 'C:\\wt' };
const mk = (opts = {}) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gitops-')), 'queue.json');
  const launchBroker = createLaunchBroker({ file });
  return { file, launchBroker, broker: createGitopsBroker({ launchBroker, roots: () => ROOTS, pollMs: 5, ...opts }) };
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('launch broker: a gitops record carries its op and result across a reload; a bad op is refused at enqueue', () => {
  const { file, launchBroker } = mk();
  const op = { kind: 'git', cwd: 'D:\\glmps', args: ['status'], timeoutMs: 1000 };
  const { id } = launchBroker.enqueue({ origin: 'gitops', command: 'gitops git', cwd: 'D:\\glmps', op });
  launchBroker.claim(id, 'desktop-shell');
  launchBroker.complete(id, { result: { status: 0, stdout: 'clean', stderr: '' } });
  const again = createLaunchBroker({ file }).get(id);
  assert.deepEqual([again.origin, again.state, again.op, again.result], ['gitops', 'done', op, { status: 0, stdout: 'clean', stderr: '' }]);
  assert.throws(() => launchBroker.enqueue({ origin: 'gitops', command: 'gitops x', cwd: 'x', op: { kind: 'sh' } }), TypeError);
  assert.throws(() => launchBroker.enqueue({ origin: 'gitops', command: 'gitops x', cwd: 'x' }), TypeError);
});

test('launch broker: a claimed gitops record is exempt from the stale-claim sweep when the caller says so, others are not', () => {
  let t = 1000;
  const { launchBroker } = mk();
  const b = createLaunchBroker({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gitops-')), 'q.json'), now: () => t });
  const g = b.enqueue({ origin: 'gitops', command: 'gitops test', cwd: 'x', op: { kind: 'test', cwd: 'x', command: 'npm test' } }).id;
  const a = b.enqueue({ origin: 'terminal', command: 'claude', cwd: 'x' }).id;
  b.claim(g, 's'); b.claim(a, 's');
  t += 120000;
  const moved = b.failStaleClaims(60000, 'no result', (r) => r.origin === 'gitops');
  assert.deepEqual(moved.map((r) => r.id), [a]);
  assert.equal(b.get(g).state, 'claimed');
  void launchBroker;
});

test('launch broker: scrub drops the op and result of a finished gitops record', () => {
  const { launchBroker } = mk();
  const { id } = launchBroker.enqueue({ origin: 'gitops', command: 'gitops git', cwd: 'x', op: { kind: 'git', cwd: 'x', args: ['status'] } });
  launchBroker.claim(id, 's');
  launchBroker.complete(id, { result: { status: 0, stdout: 'big', stderr: '' } });
  launchBroker.scrub(id);
  const r = launchBroker.get(id);
  assert.deepEqual([r.state, r.result, r.op], ['done', null, null]);
});

test('run enqueues a gitops record with the op and the allowed roots, and resolves with the shell result', async () => {
  const { launchBroker, broker } = mk();
  const p = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['fetch', '-q', 'origin'], timeoutMs: 5000 });
  await settle();
  const [rec] = launchBroker.pending();
  assert.equal(rec.origin, 'gitops');
  assert.deepEqual(rec.op, { kind: 'git', cwd: 'D:\\glmps', args: ['fetch', '-q', 'origin'], timeoutMs: 5000, roots: ROOTS, maxOutput: 200 * 1024 });
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: 'ok', stderr: 'warn' } });
  assert.deepEqual(await p, { status: 0, stdout: 'ok', stderr: 'warn', timedOut: false });
  assert.equal(launchBroker.get(rec.id).result, null, 'the output is scrubbed from the queue once read');
});

test('extraRepos widens the roots of that one call only', async () => {
  const { launchBroker, broker } = mk();
  const widened = broker.run({ kind: 'git', cwd: 'C:/clones', args: ['fetch', '-q', 'origin'], extraRepos: ['C:/clones', ROOTS.repos[0]] });
  await waitFor(() => launchBroker.pending().length === 1);
  const [rec] = launchBroker.pending();
  assert.deepEqual(rec.op.roots, { repos: [...ROOTS.repos, 'C:/clones'], worktrees: ROOTS.worktrees });
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: '', stderr: '' } });
  await widened;
  const plain = broker.run({ kind: 'git', cwd: ROOTS.repos[0], args: ['status'] });
  await waitFor(() => launchBroker.pending().length === 1);
  const [rec2] = launchBroker.pending();
  assert.deepEqual(rec2.op.roots, ROOTS, 'the next call is back to the configured roots');
  launchBroker.claim(rec2.id, 'desktop-shell');
  launchBroker.complete(rec2.id, { result: { status: 0, stdout: '', stderr: '' } });
  await plain;
});

test('onPickup hears the claim latency once, even when the claim and the result land between two polls', async () => {
  const seen = [];
  const { launchBroker, broker } = mk({ onPickup: (p) => seen.push(p) });
  const p = broker.run({ kind: 'gh', args: ['pr', 'view'] });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: '', stderr: '' } });
  await p;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'gh');
  assert.ok(seen[0].ms >= 0 && seen[0].ms < 5000);
  const never = mk({ onPickup: (x) => seen.push(x), claimWaitMs: 20 });
  await assert.rejects(never.broker.run({ kind: 'git', args: ['status'] }), (e) => e.code === 'NO_SHELL');
  assert.equal(seen.length, 1, 'an unclaimed call reports no pickup');
});

test('pickupSummary: last, median and slowest of the recent pickups, and an alert past half the wait', () => {
  const now = 1_000_000_000;
  assert.deepEqual(pickupSummary([], { now }), { stats: { last_ms: null, median_ms: null, max_ms: null, n: 0 }, alerts: [] });
  const fast = [300, 100, 200].map((ms, n) => ({ kind: 'git', ms, at: now - n }));
  assert.deepEqual(pickupSummary(fast, { claimWaitMs: 60000, now }), { stats: { last_ms: 200, median_ms: 200, max_ms: 300, n: 3 }, alerts: [] });
  const slow = [...fast, { kind: 'test', ms: 31000, at: now }];
  const r = pickupSummary(slow, { claimWaitMs: 60000, now });
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0].title, /took 31 s to pick up a test job \(limit 60 s\)/);
  assert.equal(pickupSummary(slow, { claimWaitMs: 60000, now: now + 25 * 3600 * 1000 }).alerts.length, 0, 'a day-old slow pickup no longer alerts');
  const many = Array.from({ length: PICKUP_SAMPLES + 5 }, (_, n) => ({ kind: 'git', ms: n, at: now }));
  assert.equal(pickupSummary(many, { now }).stats.n, PICKUP_SAMPLES);
});

test('run resolves a non-zero exit as a result, not an error', async () => {
  const { launchBroker, broker } = mk();
  const p = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 's');
  launchBroker.complete(rec.id, { result: { status: 128, stdout: '', stderr: 'fatal: nope', timedOut: false } });
  assert.deepEqual(await p, { status: 128, stdout: '', stderr: 'fatal: nope', timedOut: false });
});

test('run accepts the release kind: the op carries values only, no argv, and waits longer than the shell does', async () => {
  const { launchBroker, broker } = mk();
  const p = broker.run({ kind: 'release', cwd: 'D:\\glmps', args: ['push', '--force'], repo: 'o/r', base: 'main', number: 7, cardId: 'c-1', bump: 'minor', summary: 'ok' });
  await settle();
  const [rec] = launchBroker.pending();
  assert.deepEqual(rec.op, { kind: 'release', cwd: 'D:\\glmps', repo: 'o/r', base: 'main', number: 7, cardId: 'c-1', bump: 'minor', summary: 'ok', timeoutMs: 11 * 60 * 1000, roots: ROOTS, maxOutput: 200 * 1024 });
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: '{"ok":true}', stderr: '' } });
  assert.equal((await p).stdout, '{"ok":true}');
});

test('run accepts the review kind: the op carries the model and the file paths, and output keeps its tail', async () => {
  const { launchBroker, broker } = mk({ maxOutput: 10 });
  const op = { kind: 'review', cwd: 'C:\\wt\\p\\c-review-r1', model: 'sonnet', settings: 'C:\\s\\role-settings\\reviewer-c.json', promptFile: 'C:\\s\\runner\\c.prompt.md', timeoutMs: 5000 };
  const p = broker.run(op);
  await settle();
  const [rec] = launchBroker.pending();
  assert.deepEqual(rec.op, { ...op, roots: ROOTS, maxOutput: 10 });
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: '0123456789abcdef', stderr: 'xyz', timedOut: false } });
  assert.deepEqual(await p, { status: 0, stdout: '6789abcdef', stderr: 'xyz', timedOut: false });
});

test('run with no desktop shell claiming fails with code NO_SHELL naming the desktop app, and fails the record', async () => {
  const { launchBroker, broker } = mk({ claimWaitMs: 40 });
  await assert.rejects(broker.run({ kind: 'gh', args: ['pr', 'view', '1', '-R', 'a/b', '--json', 'state'] }), (e) => {
    assert.equal(e.code, 'NO_SHELL');
    assert.match(e.message, /desktop app/i);
    return true;
  });
  assert.equal(launchBroker.pending().length, 0, 'the unclaimed record is not left for a late shell to run');
});

// Card glmps-2-0-85: with the old 10 s default, a busy shell that claimed at
// 11 s found the call already failed and the merge queue held.
test('by default a shell that claims after 11 s still runs the call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { launchBroker, broker } = mk({ pollMs: 100, claimWaitMs: undefined });
  const p = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] });
  t.mock.timers.tick(11000);
  const id = launchBroker.pending()[0]?.id;
  assert.ok(id, 'still pending at 11 s, not failed');
  launchBroker.claim(id, 'desktop-shell');
  launchBroker.complete(id, { result: { status: 0, stdout: 'clean', stderr: '' } });
  t.mock.timers.tick(200);
  assert.deepEqual(await p, { status: 0, stdout: 'clean', stderr: '', timedOut: false });
});

test('a claimed record that gets no result in timeoutMs plus grace fails with GITOPS_TIMEOUT', async () => {
  const { launchBroker, broker } = mk({ graceMs: 20 });
  const p = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['status'], timeoutMs: 30 });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 's');
  await assert.rejects(p, (e) => e.code === 'GITOPS_TIMEOUT' && /timed out/i.test(e.message));
  assert.equal(launchBroker.get(rec.id).state, 'failed');
});

test('a shell refusal surfaces as code REFUSED with the shell reason; any other shell error as GITOPS_FAILED', async () => {
  const { launchBroker, broker } = mk();
  const p1 = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['push'] });
  await settle();
  const [r1] = launchBroker.pending();
  launchBroker.claim(r1.id, 's'); launchBroker.complete(r1.id, { error: 'refused by shell: git push is not allowed' });
  await assert.rejects(p1, (e) => e.code === 'REFUSED' && /git push is not allowed/.test(e.message));
  const p2 = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['status'] });
  await settle();
  const [r2] = launchBroker.pending();
  launchBroker.claim(r2.id, 's'); launchBroker.complete(r2.id, { error: 'spawn git ENOENT' });
  await assert.rejects(p2, (e) => e.code === 'GITOPS_FAILED' && /ENOENT/.test(e.message));
});

test('output beyond maxOutput is cut: a diff keeps its head, a test run keeps its tail', async () => {
  const { launchBroker, broker } = mk({ maxOutput: 10 });
  const p = broker.run({ kind: 'git', cwd: 'D:\\glmps', args: ['diff'] });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 's');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: '0123456789abcdef', stderr: 'xyz' } });
  const r = await p;
  assert.equal(r.stdout, '0123456789');
  assert.equal(r.stderr, 'xyz');
  const q = broker.run({ kind: 'test', cwd: 'C:\wt\merge-queue\a', command: 'npm test' });
  await settle();
  const rec2 = launchBroker.pending()[0];
  launchBroker.claim(rec2.id, 's');
  launchBroker.complete(rec2.id, { result: { status: 1, stdout: '0123456789abcdef', stderr: '' } });
  assert.equal((await q).stdout, '6789abcdef');
});

test('run refuses an unknown kind before queueing anything', async () => {
  const { launchBroker, broker } = mk();
  await assert.rejects(broker.run({ kind: 'sh', args: ['-c', 'x'] }), TypeError);
  assert.equal(launchBroker.pending().length, 0);
});

test('seams: git, gh and runTest have the shapes merge-tests, merge-exec and the intake route expect', async () => {
  const { launchBroker, broker } = mk();
  const seams = createShellSeams(broker);
  const answer = (result) => (async () => {
    await settle();
    const [rec] = launchBroker.pending();
    launchBroker.claim(rec.id, 's'); launchBroker.complete(rec.id, { result });
    return rec;
  })();
  const g = seams.git(['rev-parse', 'HEAD'], { cwd: 'D:\glmps' });
  const rg = await answer({ status: 0, stdout: 'abc\n', stderr: '' });
  assert.deepEqual(rg.op.args, ['rev-parse', 'HEAD']);
  assert.deepEqual(await g, { status: 0, stdout: 'abc\n', stderr: '' });

  const h = seams.gh('gh', ['pr', 'view', '1', '-R', 'a/b', '--json', 'state']);
  const rh = await answer({ status: 1, stdout: '', stderr: 'boom' });
  assert.equal(rh.op.kind, 'gh');
  assert.deepEqual(await h, { status: 1, stdout: '', stderr: 'boom' });

  const t = seams.runTest({ command: 'npm test', cwd: 'C:\wt\merge-queue\c1', timeoutMs: 5000 });
  const rt = await answer({ status: 1, stdout: 'out ', stderr: 'err', timedOut: false });
  assert.deepEqual([rt.op.kind, rt.op.command, rt.op.cwd, rt.op.timeoutMs], ['test', 'npm test', 'C:\wt\merge-queue\c1', 5000]);
  const run = await t;
  assert.deepEqual([run.exitCode, run.timedOut, run.tail], [1, false, 'out err']);
  assert.ok(Number.isFinite(run.durationMs));

  const t2 = seams.runTest({ command: 'npm test', cwd: 'C:\wt\merge-queue\c1', timeoutMs: 5000 });
  await answer({ status: -1, stdout: '', stderr: '', timedOut: true });
  assert.deepEqual([(await t2).exitCode, (await t2).timedOut], [null, true]);
});

test('seams: an infrastructure failure rejects with the code intact (callers hold on it)', async () => {
  const { broker } = mk({ claimWaitMs: 20 });
  const seams = createShellSeams(broker);
  await assert.rejects(seams.git(['status'], { cwd: 'D:\glmps' }), (e) => e.code === 'NO_SHELL' && isGitopsInfraError(e));
  await assert.rejects(seams.gh('gh', ['pr', 'view', '1', '-R', 'a/b', '--json', 'state']), (e) => e.code === 'NO_SHELL');
  assert.equal(isGitopsInfraError(new Error('plain')), false);
});

test('cancel: onEnqueued hands out the record id, cancel flags a claimed run, and the cancelled result comes back as such', async () => {
  const { launchBroker, broker } = mk();
  let rid = null;
  const p = broker.run({ kind: 'review', cwd: 'C:\\wt\\p\\c-review-r1', model: 'sonnet', settings: 's', promptFile: 'p', timeoutMs: 5000, onEnqueued: (id) => { rid = id; } });
  await settle();
  const [rec] = launchBroker.pending();
  assert.equal(rid, rec.id);
  assert.equal(rec.op.onEnqueued, undefined, 'the callback is not part of the record');
  launchBroker.claim(rec.id, 'desktop-shell');
  broker.cancel(rid);
  assert.deepEqual(launchBroker.cancelRequested(), [rid]);
  launchBroker.complete(rec.id, { result: { status: -2, stdout: 'partial', stderr: '', timedOut: false, cancelled: true } });
  assert.deepEqual(await p, { status: -2, stdout: 'partial', stderr: '', timedOut: false, cancelled: true });
});

test('cancel of a record nobody claimed rejects the run as a failed call', async () => {
  const { broker } = mk({ claimWaitMs: 5000 });
  let rid = null;
  const p = broker.run({ kind: 'review', cwd: 'x', model: 'sonnet', settings: 's', promptFile: 'p', onEnqueued: (id) => { rid = id; } });
  await settle();
  broker.cancel(rid);
  await assert.rejects(p, (e) => e.code === 'GITOPS_FAILED' && /cancel/i.test(e.message));
});

// Unattended reliability T6: a headless card run.
test('run accepts the card kind: the op carries the session id, resume flag and file paths, and output keeps its tail', async () => {
  const { launchBroker, broker } = mk({ maxOutput: 10 });
  const op = { kind: 'card', cwd: 'C:\\wt\\p\\c-1', settings: 'C:\\s\\role-settings\\worker-c-1.json', promptFile: 'C:\\s\\runner\\c-1.prompt.md', sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', resume: true, timeoutMs: 5000 };
  const p = broker.run(op);
  await settle();
  const [rec] = launchBroker.pending();
  assert.deepEqual(rec.op, { ...op, model: null, roots: ROOTS, maxOutput: 10 });
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { result: { status: 0, stdout: '0123456789abcdef', stderr: '', timedOut: false } });
  assert.deepEqual(await p, { status: 0, stdout: '6789abcdef', stderr: '', timedOut: false });
});

test('a shell that does not know the card kind refuses it, and the run rejects as REFUSED with the shell reason', async () => {
  const { launchBroker, broker } = mk();
  const p = broker.run({ kind: 'card', cwd: 'C:\\wt\\p\\c-1', settings: 's', promptFile: 'p', sessionId: 'x', resume: false });
  await settle();
  const [rec] = launchBroker.pending();
  launchBroker.claim(rec.id, 'desktop-shell');
  launchBroker.complete(rec.id, { error: 'refused by shell: unknown gitops kind: card' });
  await assert.rejects(p, (e) => e.code === 'REFUSED' && /unknown gitops kind: card/.test(e.message));
});
