// server/test/memory-distill-worker.test.js
//
// K Task 6: processRequest no longer calls admitSession or a health
// tracker/retryQueue directly - it condenses the transcript delta and emits
// 'session.condensed' (deps.emit, server.js wires loopRegistry.emit), which
// runs the registered memory-admission loop (server/lib/loops/plugin-loops.js,
// covered by plugin-loops.test.js: the admission itself, its checker, and its
// onFailed retry-queue push all live there now). markDone always runs after
// emit resolves - emit() (registry.js) never rejects, so there is no longer a
// "the queue push itself failed" case for processRequest to route around.
//
// The mc-16/mc-21 give-up/watermark tests below are UNCHANGED in spirit:
// they cover drainQueue's own outer catch (a processing exception, e.g. an
// unreadable transcript), which is independent of what emit() does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as q from '../lib/evaluation/memory-distill-queue.js';
import { drainQueue, processRequest } from '../lib/evaluation/memory-distill-worker.js';
import { sweepAbandoned } from '../lib/evaluation/memory-distill-sweeper.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mdw-'));

// Build a transcript at <root>/D--proj/sess.jsonl so memoryDir = <root>/D--proj/memory.
function writeTranscript(root, nLines, textLen) {
  const proj = path.join(root, 'D--proj');
  fs.mkdirSync(proj, { recursive: true });
  const tp = path.join(proj, 'sess.jsonl');
  const lines = [];
  for (let i = 0; i < nLines; i++) lines.push(JSON.stringify({ type: 'user', message: { content: 'x'.repeat(textLen) } }));
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  return { transcriptPath: tp, memoryDir: path.join(proj, 'memory') };
}

const cfg = { minTranscriptBytes: 50 };

function fakeDeps(over = {}) {
  return {
    cfg,
    emit: async () => [{ outcome: 'done', result: { added: 1, removed: 0, blocked: false, pendingRemovals: [] } }],
    ...over,
  };
}

test('a clean session emits session.condensed with the sessionId/project/condensed payload, and the watermark advances', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's1', transcriptPath, cwd: '/c' });
  const calls = [];
  const emit = async (kind, payload) => { calls.push([kind, payload]); return [{ outcome: 'done', result: { added: 1 } }]; };
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'session.condensed');
  assert.equal(calls[0][1].sessionId, 's1');
  assert.equal(calls[0][1].project, 'D--proj', 'project slug is read off the memory dir path');
  assert.match(calls[0][1].condensed, /x+/);
  assert.equal(q.getWatermark(state).s1, 3);
  assert.equal(q.isQueued(state, 's1'), false);
});

test('short transcript is skipped without emitting', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 1, 5);
  q.enqueue(state, { sessionId: 's3', transcriptPath, cwd: '/c' });
  let called = false;
  const emit = async () => { called = true; return [{ outcome: 'done' }]; };
  await drainQueue({ stateDir: state, ...fakeDeps({ cfg: { ...cfg, minTranscriptBytes: 100000 }, emit }) });
  assert.equal(called, false);
  assert.equal(q.getWatermark(state).s3, 1); // watermark still advances
});

test('markDone runs even when the emitted loop reports a failure - the memory-admission loop itself owns the retry, not this worker', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's5', transcriptPath, cwd: '/c' });
  const emit = async () => [{ outcome: 'failed', reason: 'model timed out' }];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 1, 'a loop failure is not a processing exception - the worker still successfully processed this request');
  assert.equal(q.getWatermark(state).s5, 3, 'markDone runs either way');
});

// A delta that was never durably handed off anywhere must not be
// markDone'd - two distinct emit() outcomes mean exactly that.

test('I4: emit reporting "registry stopped" leaves the request pending for a later drain, never markDone\'d', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's20', transcriptPath, cwd: '/c' });
  const emit = async () => [{ outcome: 'nothing-to-do', reason: 'registry stopped' }];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 0, 'never successfully processed');
  assert.equal(q.getWatermark(state).s20, undefined, 'watermark must not advance past a delta the registry never even attempted');
  assert.equal(q.isQueued(state, 's20'), true, 'left pending for a later drain, not dropped and not silently given up on');
});

// emit() itself can resolve an EMPTY array (no
// loop registered for 'session.condensed' at all, e.g. a misconfigured
// registry) - a missing outcome is not a success either.
test('I4 (round 2): emit resolving with no outcome at all leaves the request pending, never markDone\'d', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's22', transcriptPath, cwd: '/c' });
  const emit = async () => [];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 0, 'never successfully processed');
  assert.equal(q.getWatermark(state).s22, undefined, 'watermark must not advance past a delta no loop ever even saw');
  assert.equal(q.isQueued(state, 's22'), true, 'left pending for a later drain, not dropped and not silently given up on');
});

test('I4: emit reporting a failed loop whose own onFailed queueing also failed leaves the request pending, never markDone\'d', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's21', transcriptPath, cwd: '/c' });
  // Phase K final review minor: registry.js now reports the loop's own
  // onFailed hook failing (its retry-queue push) as an explicit field,
  // onFailedError, instead of this worker parsing "; onFailed:" out of the
  // reason text. The reason here deliberately carries no suffix at all.
  const emit = async () => [{ outcome: 'failed', reason: 'model timed out', onFailedError: 'disk full' }];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 0, 'never successfully processed');
  assert.equal(q.getWatermark(state).s21, undefined, 'watermark must not advance past a delta that was never durably queued');
  assert.equal(q.isQueued(state, 's21'), true, 'left pending for a later drain');
});

test('I4: a plain loop failure (onFailed itself succeeded) still markDones - the delta IS durably queued by the loop', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's22', transcriptPath, cwd: '/c' });
  const emit = async () => [{ outcome: 'failed', reason: 'model timed out' }];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 1);
  assert.equal(q.getWatermark(state).s22, 3, 'markDone runs - the memory-admission loop\'s own onFailed already queued the retry');
});

test('I4: a broken registry for one session does not block another session in the same drain, and is retried at most once per drain call', async () => {
  const state = tmp();
  const broken = writeTranscript(tmp(), 3, 100);
  const good = writeTranscript(tmp(), 3, 100);
  q.enqueue(state, { sessionId: 's20', transcriptPath: broken.transcriptPath, cwd: '/c' });
  q.enqueue(state, { sessionId: 's21', transcriptPath: good.transcriptPath, cwd: '/c' });
  let brokenAttempts = 0;
  const emit = async (kind, payload) => {
    if (payload.sessionId === 's20') { brokenAttempts++; return [{ outcome: 'nothing-to-do', reason: 'registry stopped' }]; }
    return [{ outcome: 'done', result: {} }];
  };
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 1, 'the good session is still processed in the same drain');
  assert.equal(brokenAttempts, 1, 'the broken session is tried once per drain, not looped on');
  assert.equal(q.getWatermark(state).s21, 3, 'the good session watermark advances normally');
  assert.equal(q.getWatermark(state).s20, undefined, 'the broken session watermark is untouched');
  assert.equal(q.isQueued(state, 's20'), true, 'the broken session is left pending for a later drain');
});


test('a per-session processing exception (e.g. unreadable transcript) is handled without crashing the drain', async () => {
  const state = tmp(); const root = tmp();
  q.enqueue(state, { sessionId: 's10', transcriptPath: path.join(root, 'does-not-exist.jsonl'), cwd: '/c' });
  const r = await drainQueue({ stateDir: state, ...fakeDeps() });
  assert.equal(r.processed, 0);
});

// glmps-21: the catch-path (a thrown exception, e.g. an unreadable
// transcript) used to call markFailed (retry-capped) but NEVER advance the
// watermark, so a permanently-unreadable transcript got re-enqueued forever.
test('a catch-path give-up (permanently unreadable transcript) advances the watermark instead of leaving it stuck (mc-21)', async () => {
  const state = tmp(); const root = tmp();
  const badPath = path.join(root, 'does-not-exist.jsonl');
  q.enqueue(state, { sessionId: 's11', transcriptPath: badPath, cwd: '/c' });
  const r = await drainQueue({ stateDir: state, ...fakeDeps() });
  assert.equal(r.processed, 0, 'never successfully processed');
  assert.equal(q.isQueued(state, 's11'), false, 'dropped from the queue once the retry cap is spent');
  assert.equal(q.getWatermark(state).s11, 0, 'watermark explicitly set (not left absent/stuck) once give-up is reached');
});

test('after catch-path give-up, a later sweep does not re-enqueue the same session forever (mc-21)', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 5, 200);
  q.enqueue(state, { sessionId: 's12', transcriptPath, cwd: '/c' });
  await drainQueue({ stateDir: state, ...fakeDeps() });
  assert.equal(q.isQueued(state, 's12'), false, 'not left in the distill queue -- the retry lives in the plugin-retry loop now');
  assert.equal(q.getWatermark(state).s12, 5, 'watermark catches up to the (perfectly readable) transcript');

  const countFileLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  const { enqueued } = sweepAbandoned({
    sessions: [{ id: 's12', live: false, mtimeMs: 0, transcriptPath, cwd: '/c' }],
    watermark: q.getWatermark(state),
    nowMs: 10_000_000,
    cfg: { sweepIdleMs: 1000 },
    knownRoots: ['D:/proj'],
    enqueueFn: () => { throw new Error('should not re-enqueue -- the mc-21 perpetual-sweep-loop bug is fixed'); },
    countLines: countFileLines,
  });
  assert.deepEqual(enqueued, [], 'not re-enqueued');
});

// mc-21 hardening: markDone SETS the watermark, so a give-up while the transcript
// is transiently unreadable (bestEffortLineCount -> 0) must not REGRESS a prior
// successful admission's watermark to 0.
test('catch-path give-up never regresses a prior watermark when the transcript is transiently unreadable (mc-21 hardening)', async () => {
  const state = tmp(); const root = tmp();
  const badPath = path.join(root, 'gone.jsonl'); // unreadable at give-up -> bestEffortLineCount 0
  q.markDone(state, 's13', 100); // prior successful admission up to line 100
  q.enqueue(state, { sessionId: 's13', transcriptPath: badPath, cwd: '/c' });
  await drainQueue({ stateDir: state, ...fakeDeps() });
  assert.equal(q.getWatermark(state).s13, 100, 'give-up holds the prior watermark, does not regress to 0');
});

// Phase K final review minor: every emit() outcome is read, not just the
// first. A second loop on the same event whose onFailed queueing failed (or
// a registry that stopped under it) still means the delta is not durably
// handed off everywhere it should be.
test('every emit() outcome is read: a later outcome whose onFailed failed leaves the request pending', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's31', transcriptPath, cwd: '/c' });
  const emit = async () => [
    { outcome: 'done', result: { added: 1 } },
    { outcome: 'failed', reason: 'second loop failed', onFailedError: 'queue write EPERM' },
  ];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 0);
  assert.equal(q.getWatermark(state).s31, undefined);
  assert.equal(q.isQueued(state, 's31'), true);
});

test('every emit() outcome is read: a later "registry stopped" outcome leaves the request pending', async () => {
  const state = tmp(); const root = tmp();
  const { transcriptPath } = writeTranscript(root, 3, 100);
  q.enqueue(state, { sessionId: 's32', transcriptPath, cwd: '/c' });
  const emit = async () => [{ outcome: 'done', result: {} }, { outcome: 'nothing-to-do', reason: 'registry stopped' }];
  const r = await drainQueue({ stateDir: state, ...fakeDeps({ emit }) });
  assert.equal(r.processed, 0);
  assert.equal(q.isQueued(state, 's32'), true);
});
