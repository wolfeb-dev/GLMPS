import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  readWorkspace, writeDeclared, writeObserved, writeDivergence,
  writeSteer, consumeSteer, listWorkspaces, STEER_MAX_AGE_MS, STEER_REDELIVER_AFTER_MS,
} from '../lib/orchestration/workspace-store.js';

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'));
}

test('unknown session reads null', () => {
  const sd = tmpState();
  assert.equal(readWorkspace(sd, 'nope'), null);
});

test('writeDeclared merges and caps concepts to 5', () => {
  const sd = tmpState();
  writeDeclared(sd, 's1', { goal: 'ship auth', ts: 100 });
  const ws = writeDeclared(sd, 's1', { concepts: ['a','b','c','d','e','f'], ts: 200 });
  assert.equal(ws.declared.goal, 'ship auth');            // preserved across merges
  assert.equal(ws.declared.concepts.length, 5);
  assert.equal(ws.updatedTs, 200);
  assert.equal(readWorkspace(sd, 's1').declared.goal, 'ship auth'); // persisted
});

test('observed and divergence write independently', () => {
  const sd = tmpState();
  writeObserved(sd, 's1', { activePaths: ['web/x.css'], activeSkills: [], activeAgents: [], zone: 'dev', stage: 2, ts: 10 });
  writeDivergence(sd, 's1', { level: 'high', reasons: ['goal vs css'], ts: 11 });
  const ws = readWorkspace(sd, 's1');
  assert.equal(ws.observed.stage, 2);
  assert.equal(ws.divergence.level, 'high');
});

test('a steer is delivered more than once, because one read is not proof the right agent got it', () => {
  // glmps-74. This used to consume on the FIRST read. Subagents
  // inherit the parent's session_id, so a subagent's PreToolUse hook read and
  // consumed steers addressed to the main session - whichever process made a
  // tool call first won the race, and the main agent never saw it. Observed
  // 2026-08-21: an operator note consumed 4.3s after it arrived, by a
  // subagent, which had no way to know it was legitimate and refused it.
  //
  // There is no reliable way for the hook to tell a subagent from its parent,
  // so the fix does not try. It delivers the note a bounded number of times:
  // a subagent eating one delivery no longer costs the operator the message.
  const sd = tmpState();
  writeSteer(sd, 's1', { note: 'those files are FROZEN', from: 'operator', ts: 5 });

  // Timestamps are spaced past STEER_REDELIVER_AFTER_MS: redelivery is a
  // retry for a MISSED note, not a repeat within one burst of tool calls.
  const t1 = 1000;
  const t2 = t1 + STEER_REDELIVER_AFTER_MS + 1;
  const t3 = t2 + STEER_REDELIVER_AFTER_MS + 1;

  const first = consumeSteer(sd, 's1', t1);
  assert.equal(first.note, 'those files are FROZEN');
  assert.equal(readWorkspace(sd, 's1').steer.consumedTs, null, 'still pending after one read');
  assert.equal(consumeSteer(sd, 's1', t1 + 1), null, 'and NOT repeated moments later');

  assert.equal(consumeSteer(sd, 's1', t2).note, 'those files are FROZEN', 'redelivered once spaced');
  assert.equal(consumeSteer(sd, 's1', t3).note, 'those files are FROZEN');

  // Bounded: it stops rather than nagging forever. The third delivery is the
  // one that hits the cap, so it is retired at that read, not the next.
  assert.equal(readWorkspace(sd, 's1').steer.consumedTs, t3, 'retired on the capped delivery');
  assert.equal(consumeSteer(sd, 's1', t3 + STEER_REDELIVER_AFTER_MS + 1), null, 'delivery cap reached');
});

test('a DELIVERED steer stops being redelivered once it is stale, even below the cap', () => {
  // An hours-old instruction re-injected into a session that has moved on is
  // worse than not redelivering it: the operator has almost certainly re-asked.
  //
  // This originally asserted the same thing for an UNDELIVERED note, which was
  // the bug: staleness only makes sense for a note somebody already acted on.
  // See 'an UNDELIVERED note is never retired by staleness' below.
  const sd = tmpState();
  writeSteer(sd, 's2', { note: 'restart it', from: 'operator', ts: 0 });
  assert.equal(consumeSteer(sd, 's2', 1000).note, 'restart it', 'delivered once');
  assert.equal(consumeSteer(sd, 's2', STEER_MAX_AGE_MS + 2000), null);
  assert.ok(readWorkspace(sd, 's2').steer.consumedTs != null, 'marked consumed rather than left dangling');
});

test('a fresh steer overwriting an old one resets its delivery budget', () => {
  const sd = tmpState();
  writeSteer(sd, 's3', { note: 'first', from: 'operator', ts: 5 });
  consumeSteer(sd, 's3', 1000);
  consumeSteer(sd, 's3', 1000 + STEER_REDELIVER_AFTER_MS + 1);
  writeSteer(sd, 's3', { note: 'second', from: 'operator', ts: 2000 });
  assert.equal(consumeSteer(sd, 's3', 2001).note, 'second', 'a new note delivers at once, no spacing debt');
  assert.equal(consumeSteer(sd, 's3', 2001 + STEER_REDELIVER_AFTER_MS + 1).note, 'second',
    'and it gets its own delivery budget');
});

test('listWorkspaces returns only known ids', () => {
  const sd = tmpState();
  writeDeclared(sd, 'a', { goal: 'x', ts: 1 });
  const out = listWorkspaces(sd, ['a', 'b']);
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'a');
});

test('glmps-100: a legacy STRING declared.ts does not poison updatedTs to NaN/null', () => {
  const sd = tmpState();
  // Simulate a workspace file written before the numeric-nowTs fix (d756519):
  // declared.ts is an ISO string. Write it straight to disk, bypassing the store.
  const wdir = path.join(sd, 'workspace');
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, 's1.json'), JSON.stringify({
    sessionId: 's1', updatedTs: 0,
    declared: { goal: 'legacy', ts: '2026-07-16T10:00:00Z' },
    observed: null, divergence: null, steer: null,
  }));
  // Any mutate (writeObserved here) recomputes updatedTs via Math.max over ts.
  const ws = writeObserved(sd, 's1', { activePaths: [], activeSkills: [], activeAgents: [], zone: 'dev', stage: 1, ts: 20 });
  assert.ok(Number.isFinite(ws.updatedTs), `updatedTs must be finite, got ${ws.updatedTs}`);
  assert.equal(ws.updatedTs, Date.parse('2026-07-16T10:00:00Z')); // string ts coerced to epoch ms (the max)
  assert.equal(typeof readWorkspace(sd, 's1').updatedTs, 'number'); // round-trips as a number, not null
});

test('redelivery is SPACED, so a burst of tool calls does not repeat the note three times', () => {
  // Found by running the real experiment rather than reasoning about it: with
  // routing fixed, the orchestrator is the only consumer, and three tool calls
  // in quick succession burned all three deliveries and showed the operator's
  // note three times in a row. Redelivery exists to survive a MISSED delivery,
  // not to repeat a delivered one.
  const sd = tmpState();
  writeSteer(sd, 's4', { note: 'once please', from: 'op', ts: 0 });
  assert.equal(consumeSteer(sd, 's4', 1000).note, 'once please');
  assert.equal(consumeSteer(sd, 's4', 2000), null, 'a second call moments later gets nothing');
  assert.equal(consumeSteer(sd, 's4', 5000), null);
  // Once the spacing window has passed, it is offered again - that is the
  // insurance for the case where the first delivery went nowhere useful.
  assert.equal(consumeSteer(sd, 's4', 1000 + STEER_REDELIVER_AFTER_MS + 1).note, 'once please');
});

test('an UNDELIVERED note is never retired by staleness, however old it gets', () => {
  // Caught in production by the operator, hours after I shipped the staleness
  // rule. Their note sat for 164 minutes with deliveries:0 - nobody had polled,
  // because the session had signed off - and the first poll after that retired
  // it unread. That is the message-loss class this whole area exists to stop,
  // and I had reintroduced it.
  //
  // Staleness was written for a DELIVERED note going out of date: re-injecting
  // an hours-old instruction into a session that has moved on is worse than
  // dropping it. That reasoning does not apply to a note nobody has ever seen.
  const sd = tmpState();
  writeSteer(sd, 's5', { note: 'inspect the guards', from: 'operator', ts: 0 });
  const wayLater = STEER_MAX_AGE_MS * 10;

  const got = consumeSteer(sd, 's5', wayLater);
  assert.equal(got?.note, 'inspect the guards', 'an unread note still delivers, however late');
  assert.equal(readWorkspace(sd, 's5').steer.deliveries, 1);
});

test('staleness still retires a note that HAS been delivered', () => {
  const sd = tmpState();
  writeSteer(sd, 's6', { note: 'old news', from: 'operator', ts: 0 });
  assert.equal(consumeSteer(sd, 's6', 1000).note, 'old news');       // delivered once
  assert.equal(consumeSteer(sd, 's6', STEER_MAX_AGE_MS + 2000), null, 'now it may age out');
  assert.ok(readWorkspace(sd, 's6').steer.consumedTs != null, 'and is retired rather than left dangling');
});
