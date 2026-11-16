// The suite glmps-92's no-@ step is gated on. The operator's
// condition was: no cross-session communication, and no reply crossing into a
// different session. Each test below is one way that could happen.
//
// If any test here cannot be made to pass, `scut.channelMessages` stays false
// and @mentions remain the only way to address a session. That is the deal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../lib/scut/engine.js';

function harness({ ticketChannels = ['C_TICKET'], allow = () => true } = {}) {
  const routed = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }),
    onMention: (agentId, text, ctx) => { routed.push({ agentId, text, channel: ctx.channel }); },
    guard: { check: (ctx) => (allow(ctx.user) ? { allowed: true } : { allowed: false, reason: 'not-authorized' }) },
    dedup: (() => { const seen = new Set(); return { isNew: (k) => (seen.has(k) ? false : (seen.add(k), true)) }; })(),
    isTicketChannel: (c) => ticketChannels.includes(c),
    botUserId: 'UBOT',
  });
  return { engine, routed };
}

const msg = (over = {}) => ({ type: 'message', channel: 'C_TICKET', user: 'U1', ts: '1.1', event_ts: '1.1', text: 'carry on', ...over });

test('a plain message in a ticket channel is routed', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg());
  assert.equal(routed.length, 1);
  assert.equal(routed[0].channel, 'C_TICKET');
});

test('a plain message in a NON-ticket channel is ignored entirely', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg({ channel: 'C_PROJECT', event_ts: '2.2' }));
  assert.deepEqual(routed, [], 'a project channel must still require an @mention');
});

test('the bot never hears itself', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg({ user: 'UBOT', event_ts: '3.1' }));
  await engine.onEvent(msg({ bot_id: 'B1', event_ts: '3.2' }));
  await engine.onEvent(msg({ subtype: 'bot_message', event_ts: '3.3' }));
  assert.deepEqual(routed, []);
});

test('system and edit subtypes never route', async () => {
  const { engine, routed } = harness();
  for (const [i, subtype] of ['channel_join', 'channel_leave', 'message_changed', 'message_deleted', 'channel_topic', 'channel_purpose', 'channel_archive'].entries()) {
    await engine.onEvent(msg({ subtype, event_ts: `4.${i}` }));
  }
  assert.deepEqual(routed, []);
});

test('a file_share message DOES route - an attachment is a real message', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg({ subtype: 'file_share', event_ts: '5.1' }));
  assert.equal(routed.length, 1);
});

test('a redelivered message routes exactly once', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg({ event_ts: '6.1' }));
  await engine.onEvent(msg({ event_ts: '6.1' }));
  assert.equal(routed.length, 1);
});

test('an unauthorized sender is rejected in a ticket channel too', async () => {
  const { engine, routed } = harness({ allow: (u) => u === 'U_OK' });
  await engine.onEvent(msg({ user: 'U_BAD', event_ts: '7.1' }));
  assert.deepEqual(routed, []);
});

test('one message reaches exactly one ticket channel handler', async () => {
  // Two ticket channels are registered. A message in one must not be seen as
  // belonging to the other: the channel id is the whole identity.
  const { engine, routed } = harness({ ticketChannels: ['C_A', 'C_B'] });
  await engine.onEvent(msg({ channel: 'C_A', event_ts: '8.1' }));
  await engine.onEvent(msg({ channel: 'C_B', event_ts: '8.2' }));
  assert.deepEqual(routed.map(r => r.channel), ['C_A', 'C_B']);
});

test('an empty message body never routes', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg({ text: '   ', event_ts: '9.1' }));
  assert.deepEqual(routed, []);
});

test('an app_mention in a ticket channel still routes once, not twice', async () => {
  // Slack delivers BOTH an app_mention and a message event for a message that
  // @-mentions the bot inside a channel the bot is in. Deduping on event_ts is
  // what stops that becoming two launches or two steers.
  const { engine, routed } = harness();
  await engine.onEvent({ ...msg({ event_ts: '10.1' }), type: 'app_mention' });
  await engine.onEvent(msg({ event_ts: '10.1' }));
  assert.equal(routed.length, 1);
});

test('the channel door is shut when isTicketChannel is not supplied at all', async () => {
  // The default must be the pre-existing behaviour: mentions only. A caller
  // that has not opted in cannot accidentally widen its own inbound surface.
  const routed = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }),
    onMention: (a, t, ctx) => routed.push(ctx.channel),
  });
  await engine.onEvent(msg());
  assert.deepEqual(routed, []);
});

test('a direct message is ignored: a DM is not a registered ticket channel', async () => {
  const { engine, routed } = harness();
  await engine.onEvent(msg({ channel: 'D_DM', event_ts: '12.1' }));
  assert.deepEqual(routed, []);
});
