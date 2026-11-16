// server/test/skill-retire.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveCandidates, DEFAULT_MIN_OBSERVATION_DAYS } from '../lib/evaluation/skill-retire.js';

const MS_PER_DAY = 86400000;
const daysAgo = (n) => Date.now() - n * MS_PER_DAY;

const skills = [
  { id: 'plugin-a:old-unused', name: 'old-unused', plugin: 'plugin-a', installed: true, uses: 0 },
  { id: 'plugin-a:actively-used', name: 'actively-used', plugin: 'plugin-a', installed: true, uses: 12 },
  { id: 'plugin-b:new-unused', name: 'new-unused', plugin: 'plugin-b', installed: true, uses: 0 },
  { id: 'plugin-b:never-observed', name: 'never-observed', plugin: 'plugin-b', installed: true, uses: 0 },
  { id: 'plugin-c:not-installed', name: 'not-installed', plugin: 'plugin-c', installed: false, uses: 0 },
];

test('archiveCandidates: an installed, never-used skill observed >= minObservationDays is a candidate', () => {
  const observedSince = { 'plugin-a:old-unused': daysAgo(200) };
  const out = archiveCandidates(skills, observedSince, [], { minObservationDays: 180 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'plugin-a:old-unused');
  assert.match(out[0].reason, /installed and unused for 200 days/);
  assert.ok(out[0].observedDays >= 200);
});

test('archiveCandidates: a skill with uses > 0 is NOT a candidate even if long-observed', () => {
  const observedSince = { 'plugin-a:actively-used': daysAgo(300) };
  assert.deepEqual(archiveCandidates(skills.filter(s => s.id === 'plugin-a:actively-used'), observedSince), []);
});

test('archiveCandidates: a not-installed skill is NOT a candidate', () => {
  const observedSince = { 'plugin-c:not-installed': daysAgo(300) };
  assert.deepEqual(archiveCandidates(skills.filter(s => s.id === 'plugin-c:not-installed'), observedSince), []);
});

test('archiveCandidates: observed for less than minObservationDays is NOT a candidate (could be a quarterly skill)', () => {
  const observedSince = { 'plugin-b:new-unused': daysAgo(10) };
  assert.deepEqual(archiveCandidates(skills.filter(s => s.id === 'plugin-b:new-unused'), observedSince, [], { minObservationDays: 180 }), []);
});

test('archiveCandidates: never observed at all (no ledger entry) is NOT a candidate - no evidence, fail-open', () => {
  const out = archiveCandidates(skills.filter(s => s.id === 'plugin-b:never-observed'), {});
  assert.deepEqual(out, []);
});

test('archiveCandidates: exempt list is honored BEFORE the observation-window check', () => {
  // Far past the threshold, but explicitly exempted -> excluded immediately,
  // not made to "wait out the window again" (acceptance criterion #6).
  const observedSince = { 'plugin-a:old-unused': daysAgo(9999) };
  const out = archiveCandidates(skills.filter(s => s.id === 'plugin-a:old-unused'), observedSince, ['plugin-a:old-unused']);
  assert.deepEqual(out, []);
});

test('archiveCandidates: default minObservationDays is DEFAULT_MIN_OBSERVATION_DAYS (180) when omitted', () => {
  const justUnder = { 'plugin-a:old-unused': daysAgo(DEFAULT_MIN_OBSERVATION_DAYS - 1) };
  assert.deepEqual(archiveCandidates(skills.filter(s => s.id === 'plugin-a:old-unused'), justUnder), []);
  const justOver = { 'plugin-a:old-unused': daysAgo(DEFAULT_MIN_OBSERVATION_DAYS + 1) };
  assert.equal(archiveCandidates(skills.filter(s => s.id === 'plugin-a:old-unused'), justOver).length, 1);
});

test('archiveCandidates: multiple independent candidates are each surfaced', () => {
  const observedSince = {
    'plugin-a:old-unused': daysAgo(200),
    'plugin-a:actively-used': daysAgo(200), // used -> excluded
    'plugin-b:new-unused': daysAgo(5),      // too soon -> excluded
    'plugin-b:never-observed': daysAgo(250),
  };
  const out = archiveCandidates(skills, observedSince, [], { minObservationDays: 180 });
  const ids = out.map(c => c.id).sort();
  assert.deepEqual(ids, ['plugin-a:old-unused', 'plugin-b:never-observed']);
});

test('archiveCandidates: empty skills or missing observedSince -> empty, never throws', () => {
  assert.deepEqual(archiveCandidates([], {}), []);
  assert.deepEqual(archiveCandidates(skills, undefined), []);
  assert.deepEqual(archiveCandidates(undefined, {}), []);
  assert.deepEqual(archiveCandidates(null, null, null, undefined), []);
});

test('archiveCandidates: malformed skill entries are skipped, not thrown', () => {
  const observedSince = { 'plugin-a:old-unused': daysAgo(200) };
  const out = archiveCandidates([null, { id: 'plugin-a:old-unused', name: 'old-unused', plugin: 'plugin-a', installed: true, uses: 0 }, { installed: true, uses: 0 }], observedSince);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'plugin-a:old-unused');
});

test('acceptance: skill-retire.js module source contains no filesystem-mutation calls', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const src = fs.readFileSync(url.fileURLToPath(new URL('../lib/evaluation/skill-retire.js', import.meta.url)), 'utf-8');
  assert.doesNotMatch(src, /fs\.writeFileSync|fs\.rmSync|fs\.rm\(|fs\.unlink|fs\.rename/);
});
