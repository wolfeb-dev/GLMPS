// server/test/huddle-record.test.js
// The four-part end-of-huddle record: built from the decide extraction, stored
// in the state dir, and turned into a card body or a spec draft. Pure plus one
// temp state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRecord, saveRecord, loadRecord, recordCard, draftSpec } from '../lib/huddle/record.js';

const EXTRACTED = {
  problem: 'Should voice ship before the typed dock?',
  decisions: ['Ship typed first', 'Keep push-to-talk'],
  against: ['Red Team', ''],
  actions: [{ title: 'Add the text box', detail: 'Typing is the default.' }],
  open: ['Does the phone need TLS?'],
};

test('buildRecord pairs each decision with the seat that argued against it', () => {
  const r = buildRecord({ id: 'h1', startedAt: '2026-10-28T10:00:00.000Z', now: '2026-10-28T10:30:00.000Z', extracted: EXTRACTED, summary: 'Sum.' });
  assert.deepEqual(r, {
    id: 'h1', startedAt: '2026-10-28T10:00:00.000Z', savedAt: '2026-10-28T10:30:00.000Z', summary: 'Sum.',
    problem: 'Should voice ship before the typed dock?',
    decisions: [{ text: 'Ship typed first', against: 'Red Team' }, { text: 'Keep push-to-talk', against: '' }],
    open: ['Does the phone need TLS?'],
    actions: [{ title: 'Add the text box', detail: 'Typing is the default.' }],
  });
});

test('saveRecord writes under the state dir and loadRecord reads it back; a missing or unsafe id reads as null', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-huddle-rec-'));
  const r = buildRecord({ id: 'h1', startedAt: 'a', now: 'b', extracted: EXTRACTED, summary: '' });
  const file = saveRecord(stateDir, r);
  assert.equal(path.dirname(file), path.join(stateDir, 'huddle-records'));
  assert.deepEqual(loadRecord(stateDir, 'h1'), r);
  assert.equal(loadRecord(stateDir, 'nope'), null);
  assert.equal(loadRecord(stateDir, '../../etc/passwd'), null);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('recordCard pre-fills acceptance criteria from the decisions and tags the card as huddle-sourced', () => {
  const r = buildRecord({ id: 'h1', startedAt: 'a', now: 'b', extracted: EXTRACTED, summary: '' });
  const c = recordCard({ record: r, project: 'glmps-2.0-runtime' });
  assert.equal(c.title, 'Huddle h1: Should voice ship before the typed dock?');
  assert.equal(c.project, 'glmps-2.0-runtime');
  assert.equal(c.source, 'huddle');
  assert.deepEqual(c.origin, { via: 'huddle', huddleId: 'h1' });
  assert.deepEqual(c.acceptanceCriteria, [{ text: 'AC-1 Ship typed first', done: false }, { text: 'AC-2 Keep push-to-talk', done: false }]);
  assert.match(c.prompt, /Problem:\nShould voice ship before the typed dock\?/);
  assert.match(c.prompt, /Add the text box: Typing is the default\./);
  assert.match(c.prompt, /Does the phone need TLS\?/);
});

test('recordCard with no problem titles itself from the first decision', () => {
  const r = buildRecord({ id: 'h2', startedAt: 'a', now: 'b', extracted: { ...EXTRACTED, problem: '' }, summary: '' });
  assert.equal(recordCard({ record: r }).title, 'Huddle h2: Ship typed first');
});

test('draftSpec renders the four parts as markdown and names the dissenter on a contested decision', () => {
  const r = buildRecord({ id: 'h1', startedAt: 'a', now: '2026-10-28T10:30:00.000Z', extracted: EXTRACTED, summary: '' });
  const md = draftSpec(r);
  assert.match(md, /^# Spec draft: Should voice ship before the typed dock\?\n/);
  for (const h of ['## Problem', '## Decisions', '## Open questions', '## Next actions', '## Acceptance criteria']) assert.ok(md.includes(h), h);
  assert.match(md, /- Ship typed first \(argued against by Red Team\)/);
  assert.match(md, /- Keep push-to-talk\n/);
  assert.match(md, /- Add the text box: Typing is the default\./);
  assert.match(md, /- \[ \] AC-1 Ship typed first/);
  assert.doesNotMatch(md, /[^\x00-\x7f]/, 'ascii only');
});
