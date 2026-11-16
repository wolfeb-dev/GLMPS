// server/test/guard-retire.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retireCandidates, retireCandidatesFromTemplates, DEFAULT_MIN_OBSERVATIONS } from '../lib/evaluation/guard-retire.js';

// Guard proposer cutover: learning-templates.js's TEMPLATES map is
// deleted (server.js now builds this same { code -> { rule } } shape from
// applied learning-store items instead of a static map). This local fixture
// exercises retireCandidatesFromTemplates' own Map-shaped-input handling
// without depending on production content.
const FIXTURE_TEMPLATES = new Map([
  ['sleep-poll', { rule: '- Never poll with sleep N then cat - use run_in_background or Monitor.' }],
  ['reread-loop', { rule: '- Do not re-read an unchanged file; query graphify instead.' }],
]);

const guards = [
  { code: 'sleep-poll', rule: '- Never poll with sleep N then cat - use run_in_background or Monitor.' },
  { code: 'reread-loop', rule: '- Do not re-read an unchanged file; query graphify instead.' },
  { code: 'bash-grep-over-grep-tool', rule: '- Use the Grep/Read tools instead of Bash grep/cat.' },
];

test('retireCandidates: a guard with counterfactualRate 0 over >= minObservations is a candidate', () => {
  const rates = { byClass: { 'sleep-poll': { n: 25, fireRate: 0, counterfactualRate: 0 } } };
  const out = retireCandidates(guards, rates, { minObservations: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'sleep-poll');
  assert.equal(out[0].n, 25);
  assert.match(out[0].reason, /never fired/i);
  assert.match(out[0].reason, /25/);
});

test('retireCandidates: a guard that would have fired at least once is NOT a candidate', () => {
  const rates = { byClass: { 'sleep-poll': { n: 25, fireRate: 0.1, counterfactualRate: 0.04 } } };
  assert.deepEqual(retireCandidates(guards, rates, { minObservations: 20 }), []);
});

test('retireCandidates: below minObservations is NOT a candidate even at counterfactualRate 0', () => {
  const rates = { byClass: { 'sleep-poll': { n: 5, fireRate: 0, counterfactualRate: 0 } } };
  assert.deepEqual(retireCandidates(guards, rates, { minObservations: 20 }), []);
});

test('retireCandidates: a guard never observed at all is NOT a candidate (no evidence, fail-open)', () => {
  const rates = { byClass: {} };
  assert.deepEqual(retireCandidates(guards, rates, { minObservations: 20 }), []);
});

test('retireCandidates: default minObservations is applied when omitted', () => {
  const rates = { byClass: { 'sleep-poll': { n: DEFAULT_MIN_OBSERVATIONS - 1, fireRate: 0, counterfactualRate: 0 } } };
  assert.deepEqual(retireCandidates(guards, rates), []);
  const rates2 = { byClass: { 'sleep-poll': { n: DEFAULT_MIN_OBSERVATIONS, fireRate: 0, counterfactualRate: 0 } } };
  assert.equal(retireCandidates(guards, rates2).length, 1);
});

test('retireCandidates: multiple guards can each independently be a candidate', () => {
  const rates = {
    byClass: {
      'sleep-poll': { n: 30, fireRate: 0, counterfactualRate: 0 },
      'reread-loop': { n: 40, fireRate: 0.5, counterfactualRate: 0.3 }, // still fires -> not a candidate
      'bash-grep-over-grep-tool': { n: 22, fireRate: 0, counterfactualRate: 0 },
    },
  };
  const out = retireCandidates(guards, rates, { minObservations: 20 });
  const codes = out.map((c) => c.code).sort();
  assert.deepEqual(codes, ['bash-grep-over-grep-tool', 'sleep-poll']);
});

test('retireCandidates: empty guards or missing rates -> empty, never throws', () => {
  assert.deepEqual(retireCandidates([], { byClass: {} }), []);
  assert.deepEqual(retireCandidates(guards, {}), []);
  assert.deepEqual(retireCandidates(guards, undefined), []);
  assert.deepEqual(retireCandidates(undefined, { byClass: {} }), []);
});

test('retireCandidates: malformed guard entries are skipped, not thrown', () => {
  const rates = { byClass: { 'sleep-poll': { n: 30, fireRate: 0, counterfactualRate: 0 } } };
  const out = retireCandidates([null, { code: 'sleep-poll', rule: guards[0].rule }, { rule: 'no code' }], rates, { minObservations: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'sleep-poll');
});

// retireCandidatesFromTemplates - builds a guards list from any Map shaped
// like { code -> { rule } } (server.js now builds this from applied
// learning-store items; this test only pins the Map-input handling itself).

test('retireCandidatesFromTemplates: builds the guards list from a Map', () => {
  const rates = { byClass: { 'sleep-poll': { n: 50, fireRate: 0, counterfactualRate: 0 } } };
  const out = retireCandidatesFromTemplates(FIXTURE_TEMPLATES, rates, { minObservations: 20 });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'sleep-poll');
  assert.match(out[0].rule, /sleep/i);
});

test('retireCandidatesFromTemplates: empty rates against a Map is empty-safe', () => {
  assert.deepEqual(retireCandidatesFromTemplates(FIXTURE_TEMPLATES, { byClass: {} }), []);
});

// loop-measurement-honesty regression: counterfactualRate is now null
// (honestly absent) rather than a fabricated rate for buckets with no real
// wouldFire-carrying entries. null !== 0 must still exclude the bucket.

test('retireCandidates: a real shadowRates() bucket with no wouldFire-carrying entries never qualifies (counterfactualRate is null, not 0)', () => {
  const rates = { byClass: { 'sleep-poll': { n: 25, fireRate: 0, fireCount: 0, counterfactualRate: null, episodeCount: null } } };
  const result = retireCandidates([{ code: 'sleep-poll', rule: '- x' }], rates);
  assert.deepEqual(result, []);
});
