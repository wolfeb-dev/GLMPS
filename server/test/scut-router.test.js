// Tests for the SCUT router (server/lib/scut/router.js) - routing model C.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRouter } from '../lib/scut/router.js';
import { createReopenLoop, REOPEN_LOOP } from '../lib/scut/reopen-loop.js';
import { createLoopRegistry } from '../lib/loops/registry.js';

function harness(overrides = {}) {
  const calls = { launched: [], steered: [], bound: [], replies: [] };
  let room = null;
  const router = makeRouter({
    getRoom: () => room,
    bindRoom: (r) => { calls.bound.push(r); room = { ...(room || {}), ...r }; return room; },
    isSessionLive: (id) => id === 'live-1',
    steer: async (id, note, ctx) => { calls.steered.push({ id, note, ctx }); return { ok: true }; },
    launch: async (input) => { calls.launched.push(input); return { id: 'glmps-42' }; },
    reply: (agentId, ctx, text) => { calls.replies.push({ agentId, text }); },
    project: 'mc',
    ...overrides,
  });
  return { router, calls, setRoom: (r) => { room = r; } };
}
const ctx = { channel: 'C1', thread_ts: '111.1', ts: '111.1', user: 'U1' };

test('an unbound thread launches a job and binds the room', async () => {
  const h = harness();
  await h.router('bill', 'build the thing', ctx);
  assert.equal(h.calls.launched.length, 1);
  assert.equal(h.calls.steered.length, 0);
  assert.equal(h.calls.launched[0].origin.via, 'slack');
  assert.equal(h.calls.launched[0].origin.thread_ts, '111.1');
  assert.equal(h.calls.launched[0].origin.user, 'U1');
  assert.equal(h.calls.bound[0].ticketId, 'glmps-42');
  assert.match(h.calls.replies[0].text, /glmps-42/);
});

test('a thread bound to a LIVE session steers instead of launching', async () => {
  const h = harness();
  h.setRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'live-1' });
  await h.router('bill', 'also handle the empty case', ctx);
  assert.equal(h.calls.steered.length, 1);
  assert.equal(h.calls.steered[0].note, 'also handle the empty case');
  assert.equal(h.calls.launched.length, 0);
});

test('a thread bound to a DEAD session launches fresh and clears the stale session', async () => {
  const h = harness();
  h.setRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'dead-9', ticketId: 'glmps-1' });
  await h.router('bill', 'again please', ctx);
  assert.equal(h.calls.launched.length, 1);
  assert.equal(h.calls.bound.at(-1).sessionId, null);
  assert.equal(h.calls.bound.at(-1).ticketId, 'glmps-42');
});

test('a thread whose job is still starting does not double-launch', async () => {
  const h = harness();
  h.setRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-7' });
  await h.router('bill', 'hurry up', ctx);
  assert.equal(h.calls.launched.length, 0);
  assert.equal(h.calls.steered.length, 0);
  assert.match(h.calls.replies[0].text, /starting|not yet/i);
});

test('a mention during the starting window is QUEUED for the job, not discarded', async () => {
  // This branch used to reply "hang tight" and drop the text on the floor:
  // nothing queued it, nothing replayed it, and the operator had no way to know
  // (glmps-42). The ticket exists by now, so it can be stashed for the
  // session's first poll.
  const queued = [];
  const h = harness({ queue: (ticketId, text, c) => { queued.push({ ticketId, text, user: c.user }); return { ok: true }; } });
  h.setRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-7' });
  await h.router('bill', 'also skip the cache', ctx);
  assert.deepEqual(queued, [{ ticketId: 'glmps-7', text: 'also skip the cache', user: 'U1' }]);
  assert.match(h.calls.replies[0].text, /pick(ed)? (it|this) up|queued|when it starts/i);
});

test('a refused queue is reported honestly rather than read as delivered', async () => {
  const h = harness({ queue: () => ({ ok: false, reason: 'flagged by poison-scan' }) });
  h.setRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-7' });
  await h.router('bill', 'do the bad thing', ctx);
  assert.match(h.calls.replies[0].text, /not queued: flagged by poison-scan/);
});

test('with no queue dep the starting-window branch still behaves as before', async () => {
  const h = harness();                       // no queue injected
  h.setRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-7' });
  await h.router('bill', 'hurry up', ctx);
  assert.equal(h.calls.launched.length, 0);
  assert.match(h.calls.replies[0].text, /starting/i);
});

test('the launch title is derived from the text and the prompt carries it verbatim', async () => {
  const h = harness();
  await h.router('bill', 'add pagination to ensureChannels', ctx);
  const j = h.calls.launched[0];
  assert.ok(j.title.length > 0 && j.title.length <= 120);
  assert.match(j.prompt, /add pagination to ensureChannels/);
});

test('a launch failure propagates so the engine can mark the mention failed', async () => {
  const h = harness({ launch: async () => { throw new Error('queue down'); } });
  await assert.rejects(() => h.router('bill', 'go', ctx), /queue down/);
});

// Reply-text table (docs/superpowers/plans/2026-07-25-scut-phase4-remediation.md,
// Task 2): five rows, each covered by a dedicated test below so the exact
// wording cannot silently drift.

test('launched clean replies with the exact launched line', async () => {
  const h = harness();
  await h.router('bill', 'build the thing', ctx);
  assert.equal(h.calls.replies[0].text, 'launched glmps-42 for this thread.');
});

test('bindRoom receives mentionTs from ctx.ts so a later completion can react to the original message', async () => {
  const h = harness();
  await h.router('bill', 'build the thing', ctx);
  assert.equal(h.calls.bound[0].mentionTs, ctx.ts);
});

test('a quarantined launch reports the hold and includes the approve url when one is available', async () => {
  const h = harness({
    launch: async () => ({ id: 'glmps-9', note: 'quarantined' }),
    approveUrlFor: (id) => `http://127.0.0.1:8123/backlog/${id}/approve`,
  });
  await h.router('bill', 'do it', ctx);
  assert.equal(
    h.calls.replies[0].text,
    'filed glmps-9, held for review - the text tripped the poison scan. Approve: http://127.0.0.1:8123/backlog/glmps-9/approve',
  );
});

test('a quarantined launch omits the approve clause when approveUrlFor yields null', async () => {
  const h = harness({
    launch: async () => ({ id: 'glmps-9', note: 'quarantined' }),
    approveUrlFor: () => null,
  });
  await h.router('bill', 'do it', ctx);
  assert.equal(h.calls.replies[0].text, 'filed glmps-9, held for review - the text tripped the poison scan.');
});

test('a quarantined launch omits the approve clause when approveUrlFor is not provided at all', async () => {
  const h = harness({ launch: async () => ({ id: 'glmps-9', note: 'quarantined' }) });
  await h.router('bill', 'do it', ctx);
  assert.equal(h.calls.replies[0].text, 'filed glmps-9, held for review - the text tripped the poison scan.');
});

test('any other note is reported plainly and does not claim the job launched', async () => {
  const h = harness({ launch: async () => ({ id: 'glmps-11', note: 'runner at capacity' }) });
  await h.router('bill', 'do it', ctx);
  assert.equal(h.calls.replies[0].text, 'filed glmps-11, not started yet: runner at capacity');
});

test('a successful steer replies with the steered line', async () => {
  const h = harness({ steer: async () => ({ ok: true }) });
  h.setRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'live-1' });
  await h.router('bill', 'also handle the empty case', ctx);
  assert.match(h.calls.replies[0].text, /note for this thread's running session/);
  assert.match(h.calls.replies[0].text, /next action/, 'the reply admits delivery is deferred, not done');
});

test('a rejected steer replies with the reason and does not throw out of onMention', async () => {
  const h = harness({ steer: async () => ({ ok: false, reason: 'session busy' }) });
  h.setRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'live-1' });
  await assert.doesNotReject(() => h.router('bill', 'also handle the empty case', ctx));
  assert.equal(h.calls.replies[0].text, 'not steered: session busy');
});

// The router has no visibility into socket-mode's envelope serialization or
// engine's event_ts dedup - those are cross-module invariants it cannot see.
// It must defend itself: a second concurrent mention for the SAME thread
// must not race the first into a double launch, while a mention for a
// DIFFERENT thread must not be blocked by an in-flight one.

test('two concurrent mentions on the SAME thread produce exactly one launch', async () => {
  const calls = { launched: [], replies: [] };
  let releaseLaunch;
  const gate = new Promise((resolve) => { releaseLaunch = resolve; });
  let room = null;
  const router = makeRouter({
    getRoom: () => room,
    bindRoom: (r) => { room = { ...(room || {}), ...r }; return room; },
    isSessionLive: () => false,
    steer: () => {},
    launch: async (input) => {
      calls.launched.push(input);
      await gate; // hold the first launch open so the second mention can race in
      return { id: 'glmps-42' };
    },
    reply: (agentId, c, text) => { calls.replies.push({ agentId, text }); },
    project: 'mc',
  });

  const first = router('bill', 'build the thing', ctx);
  const second = router('bill', 'again please', ctx); // same channel:thread_ts
  releaseLaunch();
  await Promise.all([first, second]);

  assert.equal(calls.launched.length, 1);
  assert.equal(calls.replies.length, 2);
  assert.ok(calls.replies.some((r) => /already|in flight|hang tight/i.test(r.text)));
  assert.ok(calls.replies.some((r) => /glmps-42/.test(r.text)));
});

test('two concurrent mentions on DIFFERENT threads both launch, unblocked by each other', async () => {
  const calls = { launched: [], replies: [] };
  let releaseLaunch;
  const gate = new Promise((resolve) => { releaseLaunch = resolve; });
  const rooms = {};
  const router = makeRouter({
    getRoom: (channel, thread_ts) => rooms[`${channel}:${thread_ts}`] || null,
    bindRoom: (r) => {
      const key = `${r.channel}:${r.thread_ts}`;
      rooms[key] = { ...(rooms[key] || {}), ...r };
      return rooms[key];
    },
    isSessionLive: () => false,
    steer: () => {},
    launch: async (input) => {
      calls.launched.push(input);
      await gate;
      return { id: `glmps-${calls.launched.length}` };
    },
    reply: (agentId, c, text) => { calls.replies.push({ agentId, text }); },
    project: 'mc',
  });

  const ctxA = { channel: 'C1', thread_ts: '111.1', ts: '111.1', user: 'U1' };
  const ctxB = { channel: 'C1', thread_ts: '222.2', ts: '222.2', user: 'U1' };
  const a = router('bill', 'do a', ctxA);
  const b = router('bill', 'do b', ctxB);
  releaseLaunch();
  await Promise.all([a, b]);

  assert.equal(calls.launched.length, 2);
});


test('a mention on a parked thread wakes the parked session instead of steering or launching', async () => {
  const calls = [];
  const onMention = makeRouter({
    getRoom: () => ({ channel: 'C1', thread_ts: '1.1', ticketId: 't-1', sessionId: 'sess-old' }),
    bindRoom: () => {},
    isSessionLive: () => true, // a polling parked session reads as live; park must win
    steer: async () => { calls.push('steer'); return { ok: true }; },
    launch: async () => { calls.push('launch'); return { id: 'nope' }; },
    reply: async (_a, _c, text) => { calls.push(`reply:${text}`); },
    isParked: (id) => id === 't-1',
    wake: async (id, text) => { calls.push(`wake:${id}:${text}`); return { ok: true }; },
  });
  await onMention('riker', 'phase 2 please', { channel: 'C1', thread_ts: '1.1', ts: '9.9', user: 'U1' });
  assert.deepEqual(calls, ['wake:t-1:phase 2 please', 'reply:continuing in the parked session for this thread.']);
});

test('a refused wake (poison scan) is reported honestly, not claimed delivered', async () => {
  const replies = [];
  const onMention = makeRouter({
    getRoom: () => ({ channel: 'C1', thread_ts: '1.1', ticketId: 't-1', sessionId: null }),
    bindRoom: () => {},
    isSessionLive: () => false,
    steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'nope' }),
    reply: async (_a, _c, text) => { replies.push(text); },
    isParked: () => true,
    wake: async () => ({ ok: false, reason: 'flagged by poison-scan (external-url)' }),
  });
  await onMention('riker', 'see http://evil.example', { channel: 'C1', thread_ts: '1.1', ts: '9.9', user: 'U1' });
  assert.deepEqual(replies, ['not delivered: flagged by poison-scan (external-url)']);
});

// The router is the ONE place a mention's files are fetched, because all four
// session-delivery branches below it consume the same body.
const withFiles = (block = 'Attachments (1)\n- a.png -> /att/a.png') => ({
  attachments: async () => ({ files: [{ name: 'a.png', ok: true, path: '/att/a.png' }], block }),
});

test('router appends the attachment block to a launch prompt', async () => {
  const h = harness(withFiles());
  await h.router('bill', 'look at this', ctx);
  assert.equal(h.calls.launched.length, 1);
  assert.match(h.calls.launched[0].prompt, /look at this/);
  assert.match(h.calls.launched[0].prompt, /\/att\/a\.png/);
});

test('router appends the attachment block to a steer', async () => {
  const h = harness(withFiles());
  h.setRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'live-1' });
  await h.router('bill', 'compare against this', ctx);
  assert.equal(h.calls.steered.length, 1);
  assert.match(h.calls.steered[0].note, /compare against this/);
  assert.match(h.calls.steered[0].note, /\/att\/a\.png/);
});

test('router appends the attachment block to a parked-session wake', async () => {
  let note = null;
  const onMention = makeRouter({
    getRoom: () => ({ channel: 'C1', thread_ts: '1.1', ticketId: 't-1', sessionId: 'live-1' }),
    bindRoom: () => {},
    isSessionLive: () => true,
    steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'nope' }),
    reply: async () => {},
    isParked: () => true,
    wake: async (_id, text) => { note = text; return { ok: true }; },
    ...withFiles(),
  });
  await onMention('riker', 'here is the chart', { channel: 'C1', thread_ts: '1.1', ts: '9.9', user: 'U1' });
  assert.match(note, /here is the chart/);
  assert.match(note, /\/att\/a\.png/);
});

test('router appends the attachment block to a note queued for a starting job', async () => {
  let note = null;
  const onMention = makeRouter({
    getRoom: () => ({ channel: 'C1', thread_ts: '1.1', ticketId: 't-1', sessionId: null }),
    bindRoom: () => {},
    isSessionLive: () => false,
    steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'nope' }),
    reply: async () => {},
    queue: async (_id, text) => { note = text; return { ok: true }; },
    ...withFiles(),
  });
  await onMention('riker', 'and this too', { channel: 'C1', thread_ts: '1.1', ts: '9.9', user: 'U1' });
  assert.match(note, /and this too/);
  assert.match(note, /\/att\/a\.png/);
});

test('router titles a file-only mention after the file instead of a generic placeholder', async () => {
  const h = harness({
    attachments: async () => ({ files: [{ name: 'chart.png', ok: true, path: '/att/chart.png' }], block: 'Attachments (1)' }),
  });
  await h.router('bill', '', ctx);
  assert.match(h.calls.launched[0].title, /chart\.png/);
});

test('router still routes the message when the attachment seam throws', async () => {
  const h = harness({ attachments: async () => { throw new Error('slack down'); } });
  await h.router('bill', 'do the thing', ctx);
  assert.equal(h.calls.launched.length, 1);
  assert.match(h.calls.launched[0].prompt, /do the thing/);
  assert.match(h.calls.launched[0].prompt, /attachment/i);
  assert.match(h.calls.launched[0].prompt, /slack down/);
});

test('a mention with no attachments is byte-identical to before', async () => {
  const h = harness({ attachments: async () => ({ files: [], block: '' }) });
  h.setRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'live-1' });
  await h.router('bill', 'plain words', ctx);
  assert.equal(h.calls.steered[0].note, 'plain words');
});

// A Slack channel that IS a ticket's conversation resolves by TICKET, never by
// thread, and can never reach the launch branch. These tests are the isolation
// guarantee the feature was gated on: no reply may cross into another session,
// and no reply may quietly become a second ticket.

test('a message in a ticket channel steers that ticket and never launches', async () => {
  const calls = { launch: 0, steer: [] };
  const onMention = makeRouter({
    ticketForChannel: (c) => (c === 'C_TICKET' ? 't-1' : null),
    roomForTicket: (t) => (t === 't-1' ? { channel: 'C_TICKET', thread_ts: null, ticketId: 't-1', sessionId: 'S1', agentId: 'riker' } : null),
    getRoom: () => { throw new Error('getRoom must not be consulted for a ticket channel'); },
    bindRoom: () => {},
    isSessionLive: () => true,
    steer: async (sid, note) => { calls.steer.push([sid, note]); return { ok: true }; },
    launch: async () => { calls.launch += 1; return { id: 'SHOULD-NOT-HAPPEN' }; },
    reply: async () => {},
  });
  // Deliberately carries a thread_ts: inside a ticket channel the thread is
  // irrelevant, every message belongs to the channel's one ticket.
  await onMention('riker', 'carry on', { channel: 'C_TICKET', thread_ts: '5.5', ts: '5.5', user: 'U1' });
  assert.equal(calls.launch, 0);
  assert.deepEqual(calls.steer, [['S1', 'carry on']]);
});

test('a ticket channel whose room is missing NEVER launches a replacement ticket', async () => {
  let launched = 0;
  const replies = [];
  const onMention = makeRouter({
    ticketForChannel: () => 't-gone',
    roomForTicket: () => null,          // room pruned, ticket still real
    getRoom: () => null,
    bindRoom: () => {},
    isSessionLive: () => false,
    steer: async () => ({ ok: true }),
    launch: async () => { launched += 1; return { id: 'NEW' }; },
    reply: async (_a, _c, text) => replies.push(text),
  });
  await onMention('riker', 'still there?', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U1' });
  assert.equal(launched, 0, 'a ticket channel must never file a second ticket');
  assert.match(replies.join(' '), /t-gone/);
});

test('a ticket channel with a dead session still never launches', async () => {
  let launched = 0;
  const replies = [];
  const onMention = makeRouter({
    ticketForChannel: () => 't-1',
    roomForTicket: () => ({ channel: 'C_TICKET', thread_ts: null, ticketId: 't-1', sessionId: 'S_DEAD', agentId: 'riker' }),
    getRoom: () => null,
    bindRoom: () => {},
    isSessionLive: () => false,        // the bound session is gone
    isParked: () => false,
    steer: async () => ({ ok: true }),
    launch: async () => { launched += 1; return { id: 'NEW' }; },
    reply: async (_a, _c, text) => replies.push(text),
  });
  await onMention('riker', 'hello?', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U1' });
  assert.equal(launched, 0);
  assert.match(replies.join(' '), /t-1/);
});

test('a ticket channel with a parked session wakes it, not steers it', async () => {
  const woke = [];
  const onMention = makeRouter({
    ticketForChannel: () => 't-1',
    roomForTicket: () => ({ channel: 'C_TICKET', thread_ts: null, ticketId: 't-1', sessionId: 'S1', agentId: 'riker' }),
    getRoom: () => null,
    bindRoom: () => {},
    isSessionLive: () => true,
    isParked: (t) => t === 't-1',
    wake: async (t, text) => { woke.push([t, text]); return { ok: true }; },
    steer: async () => { throw new Error('must wake, not steer'); },
    launch: async () => { throw new Error('must not launch'); },
    reply: async () => {},
  });
  await onMention('riker', 'go on', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U1' });
  assert.deepEqual(woke, [['t-1', 'go on']]);
});

test('a doorway channel is unchanged: no ticket channel, normal launch', async () => {
  let launched = null;
  const onMention = makeRouter({
    ticketForChannel: () => null,
    getRoom: () => null,
    bindRoom: () => {},
    isSessionLive: () => false,
    steer: async () => ({ ok: true }),
    launch: async (input) => { launched = input; return { id: 'glmps-1' }; },
    reply: async () => {},
  });
  await onMention('riker', 'do a thing', { channel: 'C_PROJECT', thread_ts: '2.2', ts: '2.2', user: 'U1' });
  assert.equal(launched.title, 'do a thing');
});

// A reply for a ticket that is NOT running (idle, done, cancelled, archived)
// routes through the registered reopen loop instead of launch - the ticket
// is known, so the launch branch must stay unreachable for it either way.

test('a reply in a ticket channel whose card is idle goes to reopen, never to launch', async () => {
  const replies = []; const calls = []; let launched = false;
  const onMention = makeRouter({
    getRoom: () => null, bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => { launched = true; return { id: 'x' }; }, reply: (a, c, t) => replies.push(t),
    ticketForChannel: (ch) => (ch === 'C_T' ? 'p-1' : null), roomForTicket: () => null,
    cardState: () => 'idle',
    reopen: async (id, text) => { calls.push([id, text]); return { outcome: 'done', result: { branch: 'b' } }; },
  });
  await onMention('riker', 'try again', { channel: 'C_T', thread_ts: '9.9', ts: '9.9', user: 'U' });
  assert.deepEqual(calls, [['p-1', 'try again']]);
  assert.equal(launched, false);
  assert.deepEqual(replies, [], 'the loop answers in the thread itself on success');
});

test('a failed reopen is answered in the thread; a running card keeps the old path', async () => {
  const replies = [];
  const base = {
    getRoom: () => null, bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'x' }), reply: (a, c, t) => replies.push(t),
    ticketForChannel: () => 'p-1', roomForTicket: () => null,
  };
  await makeRouter({ ...base, cardState: () => 'done', reopen: async () => ({ outcome: 'failed:b:the runner is at capacity', reason: 'b:the runner is at capacity' }) })('riker', 'x', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.match(replies.at(-1), /^could not reopen p-1: b:the runner is at capacity/);
  replies.length = 0;
  await makeRouter({ ...base, cardState: () => 'in_progress', reopen: async () => { throw new Error('must not be called'); } })('riker', 'x', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.match(replies.at(-1), /cannot find its session/);
});

// Phase C final review, M1: the maker used to reply in the thread AND throw;
// router.js then turned the throw into a SECOND reply for the same failure.
// Wired through the REAL reopen loop (createReopenLoop + createLoopRegistry),
// not the fake `reopen` stub the test above uses, so this actually exercises
// the double-reply path the fix removed.
test('M1: a failed reopen through the real loop replies exactly once (the router\'s, with the maker\'s reason)', async () => {
  const replies = [];
  const item = { id: 'p-1', state: 'done', runSession: { sessionId: 'not-a-uuid', worktree: { dir: 'W' } } };
  const deps = {
    loadItem: (id) => (id === 'p-1' ? item : null),
    loadLedger: () => ({}),
    isParked: () => false,
    isSessionLive: () => false,
    worktreeExists: () => true,
    lastActivityTs: () => null,
    scan: () => ({ ok: true }),
    deliver: async () => ({ ok: true }),
    relaunch: async () => ({ ok: false, reason: 'the runner is at capacity' }),
    reply: async (ctx, text) => { replies.push(text); },
    devlog: () => {},
    clearSession: () => {},
    now: () => 5000,
  };
  const loop = createReopenLoop(deps);
  const registry = createLoopRegistry({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-router-reopen-')), now: () => 5000, setTimer: () => 0, clearTimer: () => {} });
  const handle = registry.registerLoop({ ...REOPEN_LOOP, maker: loop.maker, checker: loop.checker, onFailed: loop.onFailed });

  const router = makeRouter({
    getRoom: () => null, bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'x' }), reply: (agentId, ctx, text) => replies.push(text),
    ticketForChannel: () => 'p-1', roomForTicket: () => null,
    cardState: () => 'done',
    reopen: (id, text, ctx) => handle.runNow({ ticketId: id, text, ctx }),
  });
  await router('riker', 'please resume', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.equal(replies.length, 1, 'exactly one reply - not the maker and the router both answering');
  assert.match(replies[0], /could not reopen p-1/);
  assert.match(replies[0], /the runner is at capacity/);
});

// a successful b/c relaunch clears the room's sessionId
// (server.js), but this router-level backstop must hold even if that lagged
// or somehow missed a room - a card the router can independently see is
// in_progress right now must never be dead-ended or double-launched, in
// EITHER a doorway thread or a ticket channel.
test('a doorway room whose card the router can see is in_progress is queued, never dead-ended or double-launched', async () => {
  const replies = []; const queued = []; let launched = false;
  const onMention = makeRouter({
    getRoom: () => ({ channel: 'C1', thread_ts: '1.1', ticketId: 'p-1', sessionId: 'STALE' }),
    bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => { launched = true; return { id: 'SHOULD-NOT-HAPPEN' }; },
    reply: (a, c, t) => replies.push(t),
    cardState: () => 'in_progress',
    queue: (id, text) => { queued.push([id, text]); return { ok: true }; },
  });
  await onMention('riker', 'still there?', { channel: 'C1', thread_ts: '1.1', ts: '1.1', user: 'U' });
  assert.equal(launched, false);
  assert.deepEqual(queued, [['p-1', 'still there?']]);
  assert.match(replies.at(-1), /relaunching|queued/i);
});

test('a ticket channel with a stale session but an in_progress card is queued, not told "no live session"', async () => {
  const replies = []; const queued = [];
  const onMention = makeRouter({
    ticketForChannel: () => 'p-1', roomForTicket: () => ({ channel: 'C_TICKET', thread_ts: null, ticketId: 'p-1', sessionId: 'STALE' }),
    getRoom: () => { throw new Error('must not be called for a ticket channel'); },
    bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => { throw new Error('must not launch'); },
    reply: (a, c, t) => replies.push(t),
    cardState: () => 'in_progress',
    queue: (id, text) => { queued.push([id, text]); return { ok: true }; },
  });
  await onMention('riker', 'keep going', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U' });
  assert.deepEqual(queued, [['p-1', 'keep going']]);
  assert.doesNotMatch(replies.at(-1) ?? '', /no live session/);
});

// the backstop above queues on cardState alone,
// but an in_progress card can have NO ledger entry at all (a stale state
// write that never got a runner slot, or a launch that crashed before the
// ledger was written) - queuing then is a false promise, since nothing is
// running to ever pick the note up. Checked explicitly via `hasLedgerEntry`,
// never inferred from queue()'s own failure text (that wording is for the
// ordinary "already gone" case, not this one). Scoped to ticket channels,
// which have a useful board message to fall back to; a doorway thread with
// no ledger entry still queues (it has no such fallback).
test('an in_progress ticket-channel card with NO ledger entry gets the board message, not "not queued"', async () => {
  const replies = [];
  const onMention = makeRouter({
    ticketForChannel: () => 'p-1', roomForTicket: () => ({ channel: 'C_TICKET', thread_ts: null, ticketId: 'p-1', sessionId: 'STALE' }),
    getRoom: () => { throw new Error('must not be called for a ticket channel'); },
    bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => { throw new Error('must not launch'); },
    reply: (a, c, t) => replies.push(t),
    cardState: () => 'in_progress',
    queue: () => { throw new Error('must not queue with no ledger entry'); },
    hasLedgerEntry: () => false,
  });
  await onMention('riker', 'keep going', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U' });
  assert.match(replies.at(-1), /^p-1 has no live session right now\. Reopen or requeue it on the board rather than starting a second one\.$/);
});

test('with no hasLedgerEntry dep the in_progress backstop still queues as before (fail open)', async () => {
  const replies = []; const queued = [];
  const onMention = makeRouter({
    ticketForChannel: () => 'p-1', roomForTicket: () => ({ channel: 'C_TICKET', thread_ts: null, ticketId: 'p-1', sessionId: 'STALE' }),
    getRoom: () => { throw new Error('must not be called for a ticket channel'); },
    bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => { throw new Error('must not launch'); },
    reply: (a, c, t) => replies.push(t),
    cardState: () => 'in_progress',
    queue: (id, text) => { queued.push([id, text]); return { ok: true }; },
    // hasLedgerEntry NOT wired
  });
  await onMention('riker', 'keep going', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U' });
  assert.deepEqual(queued, [['p-1', 'keep going']]);
});

// Fix round 1, M7 (part 3): the new in_progress-queue backstop above must
// never shadow the EARLIER parked-wake branch - a parked room still reaches
// wake even with cardState wired to something.
test('an in_progress card with a parked room still reaches wake, even with cardState wired', async () => {
  const calls = [];
  const onMention = makeRouter({
    getRoom: () => ({ channel: 'C1', thread_ts: '1.1', ticketId: 't-1', sessionId: 'S1' }),
    bindRoom: () => ({}), isSessionLive: () => true, steer: async () => { throw new Error('must wake, not steer'); },
    launch: async () => { throw new Error('must not launch'); },
    reply: async () => {},
    cardState: () => 'in_progress',
    isParked: (id) => id === 't-1',
    wake: async (id, text) => { calls.push([id, text]); return { ok: true }; },
  });
  await onMention('riker', 'go on', { channel: 'C1', thread_ts: '1.1', ts: '9.9', user: 'U1' });
  assert.deepEqual(calls, [['t-1', 'go on']]);
});

// a nothing-to-do reopen outcome must not be silent unless
// the maker already answered it (the poison-scan refusal replies itself).
test('a nothing-to-do reopen outcome (already running / registry stopped / no longer reopenable) is answered, not silent', async () => {
  const replies = [];
  const base = {
    getRoom: () => null, bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'x' }), reply: (a, c, t) => replies.push(t),
    ticketForChannel: () => 'p-1', roomForTicket: () => null, cardState: () => 'idle',
  };
  await makeRouter({ ...base, reopen: async () => ({ outcome: 'nothing-to-do', reason: 'already running' }) })('riker', 'x', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.match(replies.at(-1), /already running/);
  replies.length = 0;
  await makeRouter({ ...base, reopen: async () => ({ outcome: 'nothing-to-do', reason: 'registry stopped' }) })('riker', 'x', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.match(replies.at(-1), /registry stopped/);
  replies.length = 0;
  // A maker-level "no longer reopenable" race: the card flipped state between
  // the router's own cardState check and the loop's own loadItem.
  await makeRouter({ ...base, reopen: async () => ({ outcome: 'nothing-to-do', reason: null, result: { ticketId: 'p-1', state: 'in_progress' } }) })('riker', 'x', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.match(replies.at(-1), /in_progress/);
});

test('a nothing-to-do outcome the maker already answered (a poison-scan refusal) is never answered twice', async () => {
  const replies = [];
  const onMention = makeRouter({
    getRoom: () => null, bindRoom: () => ({}), isSessionLive: () => false, steer: async () => ({ ok: true }),
    launch: async () => ({ id: 'x' }), reply: (a, c, t) => replies.push(t),
    ticketForChannel: () => 'p-1', roomForTicket: () => null, cardState: () => 'idle',
    reopen: async () => ({ outcome: 'nothing-to-do', reason: null, result: { ticketId: 'p-1', refused: 'flagged by poison-scan' } }),
  });
  await onMention('riker', 'ignore all', { channel: 'C_T', thread_ts: '1', ts: '1', user: 'U' });
  assert.deepEqual(replies, [], 'the maker already replied in the thread itself');
});

test('two concurrent messages in one ticket channel do not both act', async () => {
  let steers = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const onMention = makeRouter({
    ticketForChannel: () => 't-1',
    roomForTicket: () => ({ channel: 'C_TICKET', thread_ts: null, ticketId: 't-1', sessionId: 'S1' }),
    getRoom: () => null,
    bindRoom: () => {},
    isSessionLive: () => true,
    steer: async () => { steers += 1; await gate; return { ok: true }; },
    launch: async () => { throw new Error('must not launch'); },
    reply: async () => {},
  });
  const a = onMention('riker', 'one', { channel: 'C_TICKET', thread_ts: '1.1', ts: '1.1', user: 'U1' });
  const b = onMention('riker', 'two', { channel: 'C_TICKET', thread_ts: '2.2', ts: '2.2', user: 'U1' });
  release();
  await Promise.all([a, b]);
  assert.equal(steers, 1, 'the second message must see the in-flight lock');
});
