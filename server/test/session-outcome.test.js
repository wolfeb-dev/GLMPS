import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSessionOutcome, finalizeSession, backfillReverts } from '../lib/evaluation/session-outcome.js';
import { readOutcomes } from '../lib/evaluation/outcome-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sess-out-')); }

const fixture = {
  sessionId: 's1',
  firstPrompt: 'implement a new export feature',
  filesTouched: ['src/export.js'],
  usage: { input: 100, output: 50, ctxUsedPct: 30 },
  acceptanceText: '- [ ] tests pass\n- [x] builds\n',
  events: [
    { kind: 'prompt', ts: 1000 },
    { kind: 'tool', tool: 'Bash', label: 'npm test', ts: 1200 },
    { kind: 'tool_result', ok: true, ts: 1500 },
    { kind: 'git', label: 'commit abc123', ts: 1600 },
    { kind: 'answer', ts: 1700 },
  ],
};

test('buildSessionOutcome composes the modules', () => {
  const row = buildSessionOutcome(fixture);
  assert.equal(row.id, 'session-s1');
  assert.equal(row.unit, 'session');
  // D23/D24 judge cutover (glmps-159 task 8): taskClass is no longer the
  // classifyTask() heuristic - every row starts 'pending' and the judge
  // plugin fills it in (fire-and-forget, off the finalize route) once the
  // session is judged.
  assert.equal(row.taskClass, 'pending');
  assert.equal(row.turns, 1);
  assert.equal(row.verifier.tests, true);
  assert.equal(row.acceptance.stated, 2);
  assert.equal(row.committed, true);
});

test('buildSessionOutcome uses opts.unit when provided', () => {
  const row = buildSessionOutcome({ ...fixture, unit: 'prompt-abc12345' });
  assert.equal(row.unit, 'prompt-abc12345');
});

test('buildSessionOutcome defaults unit to session when omitted', () => {
  const row = buildSessionOutcome(fixture);
  assert.equal(row.unit, 'session');
});

test('buildSessionOutcome model defaults to null when no event carries one and no opt given', () => {
  const row = buildSessionOutcome(fixture);
  assert.equal(row.model, null);
});

test('buildSessionOutcome derives model from the last event (by ts) that carries one', () => {
  const events = [
    { kind: 'prompt', ts: 1000, model: 'claude-sonnet-4' },
    { kind: 'tool', tool: 'Bash', label: 'npm test', ts: 1200 },
    { kind: 'answer', ts: 1700, model: 'claude-sonnet-5' },
  ];
  const row = buildSessionOutcome({ ...fixture, events });
  assert.equal(row.model, 'claude-sonnet-5');
});

test('buildSessionOutcome derivation skips events without a model field, using the latest one that has it', () => {
  const events = [
    { kind: 'prompt', ts: 1000, model: 'claude-sonnet-4' },
    { kind: 'answer', ts: 1700 }, // later ts, but no model field
  ];
  const row = buildSessionOutcome({ ...fixture, events });
  assert.equal(row.model, 'claude-sonnet-4');
});

test('buildSessionOutcome uses opts.model when provided, overriding derivation', () => {
  const events = [
    { kind: 'prompt', ts: 1000, model: 'claude-sonnet-4' },
    { kind: 'answer', ts: 1700, model: 'claude-sonnet-5' },
  ];
  const row = buildSessionOutcome({ ...fixture, events, model: 'claude-opus-4.6' });
  assert.equal(row.model, 'claude-opus-4.6');
});

test('buildSessionOutcome actor defaults to null when no event carries one and no opt given', () => {
  const row = buildSessionOutcome(fixture);
  assert.equal(row.actor, null);
});

test('buildSessionOutcome derives actor from the last event (by ts) that carries one', () => {
  const events = [
    { kind: 'prompt', ts: 1000, actor: 'alice' },
    { kind: 'tool', tool: 'Bash', label: 'npm test', ts: 1200 },
    { kind: 'answer', ts: 1700, actor: 'bob' },
  ];
  const row = buildSessionOutcome({ ...fixture, events });
  assert.equal(row.actor, 'bob');
});

test('buildSessionOutcome actor derivation skips events without an actor field, using the latest one that has it', () => {
  const events = [
    { kind: 'prompt', ts: 1000, actor: 'alice' },
    { kind: 'answer', ts: 1700 }, // later ts, but no actor field
  ];
  const row = buildSessionOutcome({ ...fixture, events });
  assert.equal(row.actor, 'alice');
});

test('buildSessionOutcome uses opts.actor when provided, overriding derivation', () => {
  const events = [
    { kind: 'prompt', ts: 1000, actor: 'alice' },
    { kind: 'answer', ts: 1700, actor: 'bob' },
  ];
  const row = buildSessionOutcome({ ...fixture, events, actor: 'carol' });
  assert.equal(row.actor, 'carol');
});

test('finalizeSession appends once and is idempotent', () => {
  const d = tmp();
  const a = finalizeSession(d, fixture);
  assert.equal(a.appended, true);
  const b = finalizeSession(d, fixture);
  assert.equal(b.appended, false);
  assert.equal(readOutcomes(d).length, 1);
});

test('buildSessionOutcome: verifier.exitOk comes from doneGateRecords, not from events', () => {
  const row = buildSessionOutcome({
    sessionId: 's1',
    events: [{ kind: 'tool', tool: 'user', ts: 1 }],
    doneGateRecords: [{ result: 'block' }, { result: 'pass' }],
  });
  assert.equal(row.verifier.exitOk, false);
  assert.equal(row.verifier.evidence, 'measured');
});

test('buildSessionOutcome: no doneGateRecords -> exitOk null, not-applicable (not silently dropped)', () => {
  const row = buildSessionOutcome({ sessionId: 's1', events: [] });
  assert.equal(row.verifier.exitOk, null);
  assert.equal(row.verifier.evidence, 'not-applicable');
});

test('backfillReverts marks a later-reverted session', () => {
  const d = tmp();
  finalizeSession(d, fixture);
  const n = backfillReverts(d, [{ kind: 'git', label: 'revert', sessionId: 's1' }]);
  assert.equal(n, 1);
  assert.equal(readOutcomes(d)[0].revertedLater, true);
});

// Card glmps-2-0-192: the row is written at the session's first Stop, while
// the done-gate (a parallel Stop hook) is still running its tests, so the
// gate verdict always arrived after the row existed and was never recorded.
test('finalizeSession records a done-gate verdict that arrives after the row exists', () => {
  const d = tmp();
  const first = finalizeSession(d, { ...fixture, doneGateRecords: [] });
  assert.equal(first.appended, true);
  assert.equal(first.row.verifier.exitOk, null);
  const later = finalizeSession(d, { ...fixture, doneGateRecords: [{ result: 'pass' }] });
  assert.equal(later.appended, false);
  assert.equal(later.row.verifier.exitOk, true);
  assert.equal(later.row.verifier.evidence, 'measured');
  const rows = readOutcomes(d);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verifier.exitOk, true);
  const failed = finalizeSession(d, { ...fixture, doneGateRecords: [{ result: 'pass' }, { result: 'block' }] });
  assert.equal(failed.row.verifier.exitOk, false);
});

test('finalizeSession leaves a recorded verdict alone when no gate record is passed', () => {
  const d = tmp();
  finalizeSession(d, { ...fixture, doneGateRecords: [{ result: 'pass' }] });
  const again = finalizeSession(d, { ...fixture, doneGateRecords: [] });
  assert.equal(again.row.verifier.exitOk, true);
});
