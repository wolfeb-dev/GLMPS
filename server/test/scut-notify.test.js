// Tests for the SCUT outbound notifier (server/lib/scut/notify.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNotifier } from '../lib/scut/notify.js';

test('jobFinished posts the full outcome into the bound thread (mode: thread)', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1', agentId: 'bill' }),
    post: (agentId, msg) => { posts.push({ agentId, ...msg }); },
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true, detail: 'tests green' }), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].agentId, 'bill');
  assert.equal(posts[0].channel, 'C1');
  assert.equal(posts[0].thread_ts, '111.1');
  assert.match(posts[0].text, /glmps-42/);
  assert.match(posts[0].text, /tests green/);
});

test('mode: thread never touches the roll-up channel or the permalink lookup', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => { posts.push(msg); },
    getTheme: () => ({}),
    getOutbound: () => 'thread',
    rollupChannel: async () => { throw new Error('should not be called'); },
    permalink: async () => { throw new Error('should not be called'); },
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), true);
  assert.equal(posts.length, 1);
});

test('mode: channel posts only a compact summary to the roll-up channel, no thread post', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => { posts.push(msg); },
    getTheme: () => ({}),
    getOutbound: () => 'channel',
    rollupChannel: async () => 'C-ROLLUP',
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: false }), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C-ROLLUP');
  assert.equal(posts[0].thread_ts, undefined);
  assert.match(posts[0].text, /glmps-42/);
});

test('mode: channel with no roll-up channel configured posts nothing and returns false', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => { posts.push(msg); },
    getTheme: () => ({}),
    getOutbound: () => 'channel',
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), false);
  assert.equal(posts.length, 0);
});

test('mode: channel with a resolver that yields null posts nothing and returns false', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => { posts.push(msg); },
    getTheme: () => ({}),
    getOutbound: () => 'channel',
    rollupChannel: async () => null,
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), false);
  assert.equal(posts.length, 0);
});

test('mode: both posts the full outcome in the thread AND a compact linked summary in the roll-up channel', async () => {
  const posts = [];
  const permalinkCalls = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1', agentId: 'bill' }),
    post: (agentId, msg) => { posts.push({ agentId, ...msg }); },
    getTheme: () => ({}),
    getOutbound: () => 'both',
    rollupChannel: async () => 'C-ROLLUP',
    permalink: async (loc) => { permalinkCalls.push(loc); return 'https://x.slack.com/archives/C1/p1111'; },
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true, detail: 'tests green' }), true);
  assert.equal(posts.length, 2);

  const threadPost = posts.find((p) => p.channel === 'C1');
  assert.equal(threadPost.thread_ts, '111.1');
  assert.match(threadPost.text, /tests green/);

  const rollupPost = posts.find((p) => p.channel === 'C-ROLLUP');
  assert.equal(rollupPost.thread_ts, undefined);
  assert.match(rollupPost.text, /glmps-42/);
  assert.match(rollupPost.text, /https:\/\/x\.slack\.com\/archives\/C1\/p1111/);

  assert.deepEqual(permalinkCalls[0], { channel: 'C1', ts: '111.1' });
});

test('mode: both with no permalink available still posts the compact line, without a link', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => { posts.push(msg); },
    getTheme: () => ({}),
    getOutbound: () => 'both',
    rollupChannel: async () => 'C-ROLLUP',
    permalink: async () => { throw new Error('slack down'); },
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), true);
  const rollupPost = posts.find((p) => p.channel === 'C-ROLLUP');
  assert.ok(rollupPost);
  assert.doesNotMatch(rollupPost.text, /https?:/);
});

test('mode: both with no roll-up channel resolved still returns true from the thread post alone', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => { posts.push(msg); },
    getTheme: () => ({}),
    getOutbound: () => 'both',
    rollupChannel: async () => null,
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), true);
  assert.equal(posts.length, 1);
});

test('mode: both where the thread post succeeds and the roll-up post fails still returns true', async () => {
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (agentId, msg) => {
      if (msg.channel === 'C-ROLLUP') throw new Error('slack down');
    },
    getTheme: () => ({}),
    getOutbound: () => 'both',
    rollupChannel: async () => 'C-ROLLUP',
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), true);
});

test('an unmapped ticket posts nothing and does not throw', async () => {
  const n = makeNotifier({ findRoomByTicket: () => null, post: () => { throw new Error('should not post'); }, getTheme: () => ({}), getOutbound: () => 'thread' });
  assert.equal(await n.jobFinished({ ticketId: 'unknown', ok: true }), false);
});

test('a failing post is swallowed so the runner is never broken by slack', async () => {
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '1.1' }),
    post: async () => { throw new Error('slack down'); },
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  assert.equal(await n.jobFinished({ ticketId: 'glmps-42', ok: true }), false);
});


test('jobFinished renders a PASS verdict', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'PASS' });
  assert.match(posts[0].text, /glmps-42 PASS/);
});

test('jobFinished renders a CONCERNS verdict with its detail', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'CONCERNS', detail: 'flaky test retried' });
  assert.match(posts[0].text, /glmps-42 CONCERNS - flaky test retried/);
});

test('jobFinished renders a FAIL verdict with its detail', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: false, verdict: 'FAIL', detail: 'lint errors' });
  assert.match(posts[0].text, /glmps-42 FAIL - lint errors/);
});

test('jobFinished renders a WAIVED verdict with its detail', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'WAIVED', detail: 'skeptic waived the gate' });
  assert.match(posts[0].text, /glmps-42 WAIVED - skeptic waived the gate/);
});

test('with no gate verdict, a successful job says so explicitly rather than reading as a silent pass', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: true });
  assert.match(posts[0].text, /glmps-42 finished \(no gate verdict\)/);
});

test('with no gate verdict, a failed job still just says failed', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: false });
  assert.match(posts[0].text, /glmps-42 failed/);
});

test('jobFinished reacts done on the ORIGINAL mention (room.mentionTs) when the job passed', async () => {
  const reacted = [];
  const presence = {
    done: (ctx) => reacted.push({ type: 'done', ctx }),
    failed: (ctx) => reacted.push({ type: 'failed', ctx }),
  };
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1', mentionTs: '999.1' }),
    post: () => {},
    getTheme: () => ({}),
    getOutbound: () => 'thread',
    presence,
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'PASS' });
  assert.equal(reacted.length, 1);
  assert.equal(reacted[0].type, 'done');
  assert.deepEqual(reacted[0].ctx, { channel: 'C1', ts: '999.1' });
});

test('jobFinished reacts failed when ok is false, and also when verdict is FAIL despite ok being true', async () => {
  const reacted = [];
  const presence = { done: () => reacted.push('done'), failed: () => reacted.push('failed') };
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1', mentionTs: '999.1' }),
    post: () => {},
    getTheme: () => ({}),
    getOutbound: () => 'thread',
    presence,
  });
  await n.jobFinished({ ticketId: 'glmps-42', ok: false, verdict: null });
  await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'FAIL' });
  assert.deepEqual(reacted, ['failed', 'failed']);
});

test('a room with no mentionTs (bound before this change) posts but does not react', async () => {
  const reacted = [];
  const posts = [];
  const presence = { done: () => reacted.push('done'), failed: () => reacted.push('failed') };
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1' }), // no mentionTs
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
    presence,
  });
  const result = await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'PASS' });
  assert.equal(result, true);
  assert.equal(posts.length, 1);
  assert.equal(reacted.length, 0);
});

test('a throwing presence reaction does not break the post or the return value', async () => {
  const posts = [];
  const presence = {
    done: async () => { throw new Error('reaction failed'); },
    failed: async () => { throw new Error('reaction failed'); },
  };
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1', mentionTs: '999.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
    presence,
  });
  const result = await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'PASS' });
  assert.equal(result, true);
  assert.equal(posts.length, 1);
});

test('no presence dep supplied at all: jobFinished still posts and never throws', async () => {
  const posts = [];
  const n = makeNotifier({
    findRoomByTicket: () => ({ channel: 'C1', thread_ts: '111.1', mentionTs: '999.1' }),
    post: (a, msg) => posts.push(msg),
    getTheme: () => ({}),
    getOutbound: () => 'thread',
  });
  const result = await n.jobFinished({ ticketId: 'glmps-42', ok: true, verdict: 'PASS' });
  assert.equal(result, true);
  assert.equal(posts.length, 1);
});
