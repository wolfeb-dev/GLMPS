// server/test/spine.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SPINE_KINDS, isSpineKind, emitSpineEvent, readSpineEvents } from '../lib/observability/spine.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-spine-')); }

test('emitSpineEvent rejects an unknown kind', () => {
  const dir = tmp();
  assert.throws(() => emitSpineEvent(dir, { kind: 'run.exploded' }), TypeError);
});

test('emitSpineEvent stamps lane and actor on the envelope', () => {
  const dir = tmp();
  const e = emitSpineEvent(dir, {
    kind: SPINE_KINDS.RUN_STARTED,
    actor: 'nightly-runner',
    payload: { runId: 'r1' },
  });
  assert.equal(e.lane, 'spine');
  assert.equal(e.actor, 'nightly-runner');
  assert.equal(e.sessionId, null);
  assert.equal(typeof e.ts, 'string');
  const back = readSpineEvents(dir, { kind: SPINE_KINDS.RUN_STARTED });
  assert.equal(back.length, 1);
  assert.equal(back[0].payload.runId, 'r1');
});

test('emitSpineEvent defaults actor to operator and carries no goalId', () => {
  const dir = tmp();
  const e = emitSpineEvent(dir, { kind: SPINE_KINDS.RUN_STARTED });
  assert.equal(e.actor, 'operator');
  assert.equal('goalId' in e, false);
});

test('readSpineEvents never returns capture events or retired goal rows', () => {
  const dir = tmp();
  emitSpineEvent(dir, { kind: SPINE_KINDS.RUN_STARTED });
  emitSpineEvent(dir, { kind: SPINE_KINDS.RUN_COMPLETED });
  // A capture event written by the ordinary pushEvents path, sharing the ledger,
  // and a goal.created row left behind by the retired goal graph.
  fs.appendFileSync(
    path.join(dir, 'events', 'log.ndjson'),
    JSON.stringify({ kind: 'tool', sessionId: 's1', ts: new Date().toISOString() }) + '\n'
    + JSON.stringify({ kind: 'goal.created', lane: 'spine', goalId: 'A1', ts: new Date().toISOString() }) + '\n',
  );
  assert.equal(readSpineEvents(dir, {}).length, 2);
  assert.equal(isSpineKind('goal.created'), false);
});

test('readSpineEvents filters by since', () => {
  const dir = tmp();
  emitSpineEvent(dir, { kind: SPINE_KINDS.RUN_STARTED, ts: '2026-01-01T00:00:00.000Z' });
  emitSpineEvent(dir, { kind: SPINE_KINDS.RUN_COMPLETED, ts: '2026-01-03T00:00:00.000Z' });
  const rows = readSpineEvents(dir, { since: '2026-01-02T00:00:00.000Z' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, SPINE_KINDS.RUN_COMPLETED);
});

test('readSpineEvents on a missing log returns an empty list', () => {
  assert.deepEqual(readSpineEvents(tmp(), {}), []);
});

test('isSpineKind is true only for typed kinds', () => {
  assert.ok(isSpineKind('lesson.created'));
  assert.ok(isSpineKind('reconciliation.integrity_finding'));
  assert.equal(isSpineKind('tool'), false);
  assert.equal(isSpineKind('memory'), false);
  assert.equal(isSpineKind('skill'), false);
});

test('no spine kind collides with a capture kind that existing readers filter on', () => {
  // memory-usage-store filters kind==='memory'; three server.js call sites filter
  // kind==='skill'. A collision would silently corrupt those consumers.
  for (const k of Object.values(SPINE_KINDS)) {
    assert.notEqual(k, 'memory');
    assert.notEqual(k, 'skill');
    assert.ok(k.includes('.'), `spine kind ${k} must be dotted so it cannot collide with a bare capture kind`);
  }
});

test('SPINE_KINDS is frozen', () => {
  assert.ok(Object.isFrozen(SPINE_KINDS));
});

test('huddle kinds exist, are dotted, and round-trip through emit/read with a huddle sessionId', () => {
  assert.equal(SPINE_KINDS.HUDDLE_STARTED, 'huddle.started');
  assert.equal(SPINE_KINDS.HUDDLE_UTTERANCE, 'huddle.utterance');
  assert.equal(SPINE_KINDS.HUDDLE_ENDED, 'huddle.ended');
  const dir = tmp();
  emitSpineEvent(dir, { kind: SPINE_KINDS.HUDDLE_UTTERANCE, label: 'hello', sessionId: 'huddle:abc', payload: { speaker: 'operator', model: null } });
  const rows = readSpineEvents(dir, { kind: SPINE_KINDS.HUDDLE_UTTERANCE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, 'huddle:abc');
  assert.equal(rows[0].payload.speaker, 'operator');
  assert.equal(rows[0].payload.model, null);
});
