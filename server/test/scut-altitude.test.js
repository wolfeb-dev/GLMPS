import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAltitude, internalIdentifiers, engineerAsks, LEAD_IDENTIFIER_LIMIT, UNFOLDED_CHAR_LIMIT }
  from '../lib/scut/altitude.js';

// glmps-78. The operator is an engineering manager and asked not to
// get low-level engineering terminology in the CLI or in Slack. Measured over
// the 253 agent devlogs on the live board when this landed: 36% named two or
// more internal identifiers in their FIRST line. That is the defect this
// scores - ordering, not volume.

test('internalIdentifiers finds the shapes that make a lead read like a diff', () => {
  const ids = internalIdentifiers(
    'Patched relay.js so roomMapper keys by thread_ts; ran with --watch, GLMPS_STATE_DIR set, at 4b7832f9.',
  );
  for (const want of ['relay.js', 'roomMapper', 'thread_ts', '--watch', 'GLMPS_STATE_DIR', '4b7832f9'])
    assert.ok(ids.includes(want), `expected ${want} in ${JSON.stringify(ids)}`);
});

test('internalIdentifiers counts each identifier once, however often it is repeated', () => {
  assert.deepEqual(internalIdentifiers('relay.js and relay.js and relay.js'), ['relay.js']);
});

// The exclusions are the difference between a useful signal and a saturated
// alarm. Ticket ids, endpoints and links are the operator's OWN vocabulary; he
// reads them every day and never called them jargon.
test('internalIdentifiers does not count shared vocabulary as jargon', () => {
  assert.deepEqual(internalIdentifiers('glmps-78 is done, see https://example.com/a/b/c.js'), []);
  assert.deepEqual(internalIdentifiers('glmps-161 and mc-9 are both closed'), []);
  assert.deepEqual(internalIdentifiers('POST /api/backlog to file one'), []);
});

test('internalIdentifiers does not fire on ordinary English', () => {
  const prose = 'Shipped the read/write split and a well-tested fallback - no decision needed from you, '
    + 'and the risk is low. Thread 1787371384 is unaffected.';
  assert.deepEqual(internalIdentifiers(prose), []);
});

test('scoreAltitude passes a lead that states the outcome first', () => {
  const r = scoreAltitude([
    'Slack replies were landing in the wrong thread. Fixed, covered by a test, no decision needed.',
    '',
    'Details: the room was keyed by channel alone, so a second thread in the same channel',
    'overwrote the first. Now keyed by channel + thread_ts. See relay.js and roomMapper.',
  ].join('\n'));
  assert.equal(r.level, 'ok');
  assert.equal(r.hint, null);
  assert.equal(r.signals.hasFold, true);
});

test('scoreAltitude flags a lead that opens with mechanism', () => {
  const r = scoreAltitude('Refactored roomMapper in relay.js to key by thread_ts.');
  assert.equal(r.level, 'deep');
  assert.ok(r.signals.leadIdentifiers >= LEAD_IDENTIFIER_LIMIT);
  assert.match(r.hint, /first line/i);
  // The hint has to name the actual offenders or it is unactionable.
  assert.match(r.hint, /roomMapper/);
});

test('scoreAltitude tolerates a single identifier in the lead', () => {
  // One name is how you say what you are talking about; a pile of them is a diff.
  const r = scoreAltitude('The Slack relay is fixed and covered by a test. No decision needed.');
  assert.equal(r.signals.leadIdentifiers, 0);
  assert.equal(r.level, 'ok');
  const one = scoreAltitude('The room mapper is fixed, no decision needed. Details: see relay.js.');
  assert.equal(one.signals.leadIdentifiers, 0);
  assert.equal(one.level, 'ok');
});

test('scoreAltitude flags a long post with no fold, and clears it once folded', () => {
  const long = 'The queue runner now retries a failed launch. ' + 'x'.repeat(UNFOLDED_CHAR_LIMIT);
  const bare = scoreAltitude(long);
  assert.equal(bare.level, 'deep');
  assert.equal(bare.signals.hasFold, false);
  assert.match(bare.hint, /Details:/);

  const folded = scoreAltitude('The queue runner now retries a failed launch.\n\nDetails: ' + 'x'.repeat(UNFOLDED_CHAR_LIMIT));
  assert.equal(folded.signals.hasFold, true);
  assert.equal(folded.level, 'ok');
});

test('scoreAltitude reads the fold marker case-insensitively', () => {
  const long = 'Outcome first.\n\ndetails: ' + 'y'.repeat(UNFOLDED_CHAR_LIMIT);
  assert.equal(scoreAltitude(long).signals.hasFold, true);
});

test('scoreAltitude uses the first non-empty line as the lead', () => {
  const r = scoreAltitude('\n\n   \nRefactored roomMapper in relay.js to key by thread_ts.');
  assert.equal(r.level, 'deep');
  assert.ok(r.signals.leadIdentifiers >= 2);
});

test('scoreAltitude is inert on empty and non-string input', () => {
  for (const v of ['', '   ', null, undefined, 42, {}, []]) {
    const r = scoreAltitude(v);
    assert.equal(r.level, 'ok');
    assert.equal(r.hint, null);
  }
});

// Advisory, not a gate: the scorer must never be a reason to change or reject
// the agent's words. It returns a judgement about a string and nothing else.
test('scoreAltitude never returns rewritten text', () => {
  const src = 'Refactored roomMapper in relay.js to key by thread_ts.';
  const r = scoreAltitude(src);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'text'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'rewrite'), false);
  assert.equal(r.signals.chars, src.length);
});

test('an inline fold still counts, and its tail is not scored as the lead', () => {
  // A writer who folded on the same line still folded. Scoring the tail as if
  // it were the lead would flag exactly the posts that are doing it right.
  const r = scoreAltitude('The room mapper is fixed, no decision needed. Details: relay.js, roomMapper, thread_ts.');
  assert.equal(r.signals.hasFold, true);
  assert.equal(r.signals.leadIdentifiers, 0);
  assert.ok(r.signals.identifiers >= 3, 'the folded detail is still counted in the whole-body total');
  assert.equal(r.level, 'ok');
});

// glmps-2-0-185: 40% of operator questions were engineer-owned calls.
test('engineerAsks flags permission and method questions an engineer should decide', () => {
  assert.equal(engineerAsks('May I edit 7 existing merge-queue tests?').length, 1);
  assert.equal(engineerAsks('Q5 Deliver one dated research doc via PR plus a short verdict here?').length, 1);
  assert.equal(engineerAsks('Ship it as one PR through the merge queue?').length, 1);
  assert.equal(engineerAsks('Shall I proceed?').length, 1);
});

test('engineerAsks leaves operator-owned questions and filing approvals alone', () => {
  assert.deepEqual(engineerAsks('Found while working: 1. a flaky test. File it?'), []);
  assert.deepEqual(engineerAsks('Should an agent-started restart need your approval phrase?\nWhich of the two goals matters more this week?'), []);
  assert.deepEqual(engineerAsks('No questions here.'), []);
  assert.deepEqual(engineerAsks(null), []);
});
