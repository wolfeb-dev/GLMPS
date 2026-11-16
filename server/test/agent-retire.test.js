import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordFirstSeen, getObservedSince } from '../lib/evaluation/agent-observation-log.js';
import { agentRetireCandidates, DEFAULT_MIN_OBSERVATION_DAYS } from '../lib/evaluation/agent-retire.js';

const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-agentlog-'));

test('first seen is recorded once and never moved forward', () => {
  const d = tmp();
  recordFirstSeen(d, ['ui-designer'], 1000);
  recordFirstSeen(d, ['ui-designer'], 9000);
  assert.equal(getObservedSince(d)['ui-designer'], 1000);
});

test('an agent inside the observation window is never proposed', () => {
  const now = 200 * DAY;
  const out = agentRetireCandidates(
    [{ name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null }],
    { 'ninjascript-coder': now - 10 * DAY }, [], { now },
  );
  assert.equal(out.length, 0);
});

test('an agent past the window with zero dispatches is proposed', () => {
  const now = 400 * DAY;
  const out = agentRetireCandidates(
    [{ name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null }],
    { 'ninjascript-coder': now - (DEFAULT_MIN_OBSERVATION_DAYS + 1) * DAY }, [], { now },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'agent-retire');
  assert.equal(out[0].id, 'agent-retire:ninjascript-coder');
  assert.equal(out[0].metric.dispatchCount, 0);
});

test('a used agent is never proposed', () => {
  const now = 400 * DAY;
  const out = agentRetireCandidates(
    [{ name: 'web-researcher', source: 'assets', dispatchCount: 45, lastUsed: now - DAY }],
    { 'web-researcher': now - 400 * DAY }, [], { now },
  );
  assert.equal(out.length, 0);
});

test('exempt agents are honored before the window check', () => {
  const now = 400 * DAY;
  const out = agentRetireCandidates(
    [{ name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null }],
    { 'ninjascript-coder': 0 }, ['ninjascript-coder'], { now },
  );
  assert.equal(out.length, 0);
});

test('an agent with no observation record is never proposed', () => {
  const now = 400 * DAY;
  const out = agentRetireCandidates(
    [{ name: 'mystery', source: 'plugin', dispatchCount: 0, lastUsed: null }], {}, [], { now },
  );
  assert.equal(out.length, 0);
});

// a malformed firstSeen (disk corruption, a hand-edit, a future
// writer bug) must never compute as NaN and slip past the `< minDays` check
// in agent-retire.js - that would be the exact inverse of the fail-open
// guarantee (a record we cannot trust proposing retirement instead of
// nothing). getObservedSince must drop any entry whose value is not a
// finite number.
test('getObservedSince drops entries with a non-numeric firstSeen', () => {
  const d = tmp();
  const logFile = path.join(d, 'agents', 'observation-log.json');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, JSON.stringify({
    'ok-agent': 1000,
    'bad-string': 'not-a-number',
    'bad-null': null,
    'bad-nan-like': 'NaN',
  }));
  assert.deepEqual(getObservedSince(d), { 'ok-agent': 1000 });
});

test('a malformed firstSeen proposes nothing, even far past the window, while a genuinely stale valid entry is still proposed', () => {
  const now = 400 * DAY;
  const d = tmp();
  const logFile = path.join(d, 'agents', 'observation-log.json');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // Deliberately NOT null here: `firstSeen == null` already short-circuits a
  // null/undefined value regardless of this fix, so a null-only case would
  // pass even under the pre-fix code and prove nothing. A string value is
  // the case that actually reaches the `(now - firstSeen) / MS_PER_DAY`
  // arithmetic in agent-retire.js and produces NaN, which is what the
  // reviewer's defect report was about.
  fs.writeFileSync(logFile, JSON.stringify({
    'corrupt-agent': 'not-a-number',
    'stale-agent': now - (DEFAULT_MIN_OBSERVATION_DAYS + 1) * DAY,
  }));
  const observedSince = getObservedSince(d);
  const out = agentRetireCandidates(
    [
      { name: 'corrupt-agent', source: 'assets', dispatchCount: 0, lastUsed: null },
      { name: 'stale-agent', source: 'assets', dispatchCount: 0, lastUsed: null },
    ],
    observedSince, [], { now },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'agent-retire:stale-agent');
});
