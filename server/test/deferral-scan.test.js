// server/test/deferral-scan.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDeferrals } from '../lib/governance/deferral-scan.js';

test('flags deferral language in a plan', () => {
  const text = [
    '### Task 4: build the thing',
    'We will file a ticket for the retry logic.',
    'The rest is done.',
  ].join('\n');
  const f = scanDeferrals(text);
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 2);
  assert.match(f[0].marker, /file a ticket/i);
});

test('an explicit OUT-OF-SCOPE justification is allowed', () => {
  const text = 'Payment webhooks are deferred. OUT-OF-SCOPE: separate billing epic, no dependency.';
  assert.deepEqual(scanDeferrals(text), []);
});

test('clean plan text yields nothing', () => {
  assert.deepEqual(scanDeferrals('Task 1 does X. Task 2 does Y. All executed here.'), []);
});

test('a fenced code block quoting a marker is not flagged', () => {
  const text = [
    'Some prose about the linter.',
    '```',
    'We will file a ticket for the retry logic.',
    '```',
    'The rest is done.',
  ].join('\n');
  assert.deepEqual(scanDeferrals(text), []);
});

test('a lint-ok justification is allowed (documented exemption)', () => {
  const text = 'The Stop feeder files a ticket for out-of-scope work. lint-ok: describes the mechanism.';
  assert.deepEqual(scanDeferrals(text), []);
});

test('a negation near a destination word does not trip (requires the "defer ... to" link)', () => {
  // These read like deferral only by coincidental proximity; none is an
  // imperative decision to punt work, and all must pass.
  assert.deepEqual(scanDeferrals('Nothing is deferred here; everything ships in this PR.'), []);
  assert.deepEqual(scanDeferrals('deferred - no ticket exists for this; do not file one.'), []);
});

test('a genuine "defer ... to a later ticket" IS flagged', () => {
  const f = scanDeferrals('We will defer the retry logic to a later ticket.');
  assert.equal(f.length, 1);
  assert.match(f[0].marker, /defer/i);
});

test('"defer ... until <bucket>" is also flagged, but a bare conditional is not', () => {
  assert.equal(scanDeferrals('We defer the migration until the next sprint.').length, 1);
  // "until we know more" has no destination bucket -> a legit conditional, not a punt.
  assert.deepEqual(scanDeferrals('This is deferred until we know more about load.'), []);
});

test('colloquial punts without a "to/until" link are still flagged (real deferrals)', () => {
  // The discriminator is negation, not the preposition: these are all real
  // punts and must flag even though none says "defer TO".
  for (const s of [
    'This edge case is deferred for later.',
    'The retry logic is deferred; see the backlog ticket.',
    'This work is deferred, ticket to follow.',
    'We defer this, to be picked up later.',
  ]) {
    assert.equal(scanDeferrals(s).length, 1, `should flag: ${s}`);
  }
});

// The convergence set: negation must sit ON the defer verb (or be its subject),
// not merely nearby, so a real punt carrying an unrelated negation still flags.
test('negation exempts only when it negates the deferral itself', () => {
  const noFlag = [
    'Nothing is deferred here; everything ships in this PR.',
    'deferred - no ticket exists for this; do not file one.',
    'This is deferred until we know more about load.',
    'We do not defer this to a ticket.',
    'This is not deferred.',
    'The migration was not deferred to a later sprint.',
  ];
  const flag = [
    // real punts whose negation modifies a DIFFERENT word (not the deferral)
    'Not urgent; defer to next sprint.',
    'Not blocking; defer to backlog.',
    'Not a blocker, defer to later ticket.',
    'This is not optional; we defer this to the backlog.',
    // subject-negation form: "nothing <adjective> but/so defer" is a real punt
    'Nothing major but defer this to next sprint anyway.',
    'Nothing urgent so defer to next sprint.',
    'Nobody blocked so we defer to the backlog.',
    // "for now" punts
    'Deferring the auth refactor for now.',
    'Deferred for now.',
  ];
  for (const s of noFlag) assert.deepEqual(scanDeferrals(s), [], `should NOT flag: ${s}`);
  for (const s of flag) assert.equal(scanDeferrals(s).length, 1, `should flag: ${s}`);
});

// Modal/passive negation is genuine negation and must be exempt, not over-flagged.
test('modal and passive negations of the deferral are exempt', () => {
  for (const s of [
    'This is a P0 security fix and must not be deferred to next sprint.',
    "This can't be deferred to the backlog, it blocks release.",
    'This should not be deferred to a later PR given the deadline.',
    'Nothing has been deferred to a later sprint.',
  ]) {
    assert.deepEqual(scanDeferrals(s), [], `should NOT flag: ${s}`);
  }
});
