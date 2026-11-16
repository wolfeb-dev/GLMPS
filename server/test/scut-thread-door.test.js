// glmps-2-0-29: once a thread has an open session, a plain reply in that
// thread reaches the session without an @mention. Starting a conversation
// still needs the @, and so does a thread whose session is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../lib/scut/engine.js';

function harness({ openThreads = ['C_PROJ:100.1'], allow = () => true } = {}) {
  const routed = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }),
    onMention: (agentId, text, ctx) => { routed.push({ agentId, text, channel: ctx.channel, thread_ts: ctx.thread_ts }); },
    guard: { check: (ctx) => (allow(ctx.user) ? { allowed: true } : { allowed: false, reason: 'not-authorized' }) },
    dedup: (() => { const seen = new Set(); return { isNew: (k) => (seen.has(k) ? false : (seen.add(k), true)) }; })(),
    isOpenThread: (c, t) => openThreads.includes(`${c}:${t}`),
    botUserId: 'UBOT',
  });
  return { engine, routed };
}

const reply = (over = {}) => ({ type: 'message', channel: 'C_PROJ', user: 'U1', ts: '100.5', event_ts: '100.5', thread_ts: '100.1', text: 'carry on', ...over });

test('a plain reply in a thread with an open session routes into that thread', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(reply());
  assert.equal(routed.length, 1);
  assert.equal(routed[0].thread_ts, '100.1');
  assert.equal(routed[0].text, 'carry on');
});

test('a plain reply in a thread with no open session is ignored - restarting needs the @', async () => {
  const { engine, routed } = harness({ openThreads: [] });
  await engine.onEvent(reply());
  assert.deepEqual(routed, []);
});

test('a top-level channel message never uses the thread door, even when its ts names an open thread', async () => {
  const { engine, routed } = harness({ openThreads: ['C_PROJ:100.1'] });
  await engine.onEvent(reply({ ts: '100.1', event_ts: '100.1', thread_ts: undefined }));
  await engine.onEvent(reply({ ts: '100.1', event_ts: '100.2', thread_ts: '100.1' }));
  assert.deepEqual(routed, []);
});

test('a reply in a different thread of the same channel is not routed', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(reply({ thread_ts: '200.1', event_ts: '200.5', ts: '200.5' }));
  assert.deepEqual(routed, []);
});

test('the same thread ts in another channel is not routed', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(reply({ channel: 'C_OTHER' }));
  assert.deepEqual(routed, []);
});

test('bot posts and system subtypes in an open thread never route', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(reply({ user: 'UBOT', event_ts: '3.1' }));
  await engine.onEvent(reply({ bot_id: 'B1', event_ts: '3.2' }));
  await engine.onEvent(reply({ subtype: 'bot_message', event_ts: '3.3' }));
  await engine.onEvent(reply({ subtype: 'message_changed', event_ts: '3.4' }));
  await engine.onEvent(reply({ subtype: 'thread_broadcast', event_ts: '3.5' }));
  assert.deepEqual(routed, []);
});

test('a file_share reply in an open thread routes', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(reply({ subtype: 'file_share', event_ts: '5.1' }));
  assert.equal(routed.length, 1);
});

test('an @mention reply in an open thread routes once, not twice', async () => {
  // Slack delivers both an app_mention and a message event for it.
  const { engine, routed } = harness();
  await engine.onEvent({ ...reply({ event_ts: '6.1' }), type: 'app_mention' });
  await engine.onEvent(reply({ event_ts: '6.1' }));
  assert.equal(routed.length, 1);
});

test('an unauthorized sender in an open thread is rejected', async () => {
  const { engine, routed } = harness({ allow: (u) => u === 'U_OK' });
  await engine.onEvent(reply({ user: 'U_BAD' }));
  assert.deepEqual(routed, []);
});

test('the thread door is shut when isOpenThread is not supplied', async () => {
  const routed = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }),
    onMention: (a, t, ctx) => routed.push(ctx.thread_ts),
  });
  await engine.onEvent(reply());
  assert.deepEqual(routed, []);
});

test('a throwing isOpenThread predicate fails closed', async () => {
  const routed = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }),
    onMention: (a, t, ctx) => routed.push(ctx.thread_ts),
    isOpenThread: () => { throw new Error('rooms file unreadable'); },
  });
  await engine.onEvent(reply());
  assert.deepEqual(routed, []);
});
