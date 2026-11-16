// Tests for the SCUT engine (server/lib/scut/engine.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, resolveMention, defaultOnMention, makeBobToggleHandler } from '../lib/scut/engine.js';
import { resolveTheme } from '../lib/scut/bobiverse.js';
import { makeDedup } from '../lib/scut/dedup.js';

const PRO = resolveTheme(false);
const BOB = resolveTheme(true);

test('resolveMention matches by alias in either mode', () => {
  // professional handles
  assert.equal(resolveMention('<@U0> builder: build it', PRO.agents).agentId, 'bill');
  assert.equal(resolveMention('<@U0> hey Lead, status?', PRO.agents).agentId, 'riker');
  // bob names still resolve (aliases include both displays)
  assert.equal(resolveMention('<@U0> bill do X', PRO.agents).agentId, 'bill');
  assert.equal(resolveMention('<@U0> Riker?', BOB.agents).agentId, 'riker');
  assert.equal(resolveMention('<@U0> just do it', PRO.agents).agentId, null);
});

test('resolveMention picks the agent named LEFTMOST in the text, not first in iteration order', () => {
  const agents = { riker: { id: 'riker', aliases: ['riker', 'lead'] }, bill: { id: 'bill', aliases: ['bill', 'builder'] } };
  // 'bill' appears before 'riker' in the text; iteration order would wrongly pick riker.
  assert.equal(resolveMention('<@B1> bill, ask riker later', agents).agentId, 'bill');
});

test('onEvent routes an app_mention to the Lead even when it names another persona, with ctx', async () => {
  const calls = [];
  const engine = createEngine({ getTheme: () => PRO, onMention: (id, text, ctx) => calls.push({ id, text, ctx }) });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', user: 'U9', channel: 'C1', ts: '1.2', thread_ts: '1.0' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'riker');
  assert.equal(calls[0].ctx.channel, 'C1');
  assert.equal(calls[0].ctx.thread_ts, '1.0');
});

test('onEvent falls back to the default agent when none is named', async () => {
  const calls = [];
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => calls.push(id), defaultAgent: 'riker' });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> status please', channel: 'C1', ts: '1.2' });
  assert.deepEqual(calls, ['riker']);
});

test('onEvent detects a bobmode command / magic phrase and routes to onBobToggle', async () => {
  const toggles = [];
  const mentions = [];
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id) => mentions.push(id),
    onBobToggle: (arg, ctx) => toggles.push({ arg, ctx }),
  });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> bobmode on', channel: 'C1', ts: '1' });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> we are legion', channel: 'C1', ts: '2' });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', channel: 'C1', ts: '3' });
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].arg, 'on');
  assert.deepEqual(mentions, ['riker']); // only the non-toggle mention routed
});

test('onEvent ignores non-app_mention events', async () => {
  const calls = [];
  const engine = createEngine({ getTheme: () => PRO, onMention: () => calls.push(1) });
  await engine.onEvent({ type: 'message', text: 'hi', channel: 'C1' });
  await engine.onEvent(null);
  assert.equal(calls.length, 0);
});

test('defaultOnMention replies in-thread as the addressed agent (active theme)', async () => {
  const posts = [];
  const web = { chatPostMessage: async (p) => { posts.push(p); return { ok: true }; } };
  const onMention = defaultOnMention(web, () => PRO);
  await onMention('bill', 'build the thing', { channel: 'C1', thread_ts: '1.0' });
  assert.equal(posts[0].username, 'Builder'); // pro persona
  assert.match(posts[0].text, /not wired/i);
});

test('makeBobToggleHandler flips the flag and announces in the NEW theme', async () => {
  let mode = false;
  const settings = { getBobMode: () => mode, setBobMode: (v) => { mode = v; return v; } };
  const posts = [];
  const web = { chatPostMessage: async (p) => { posts.push(p); return { ok: true }; } };
  const handler = makeBobToggleHandler({ web, settings, getTheme: () => resolveTheme(mode) });
  const r = await handler('on', { channel: 'C1', thread_ts: '1.0' });
  assert.equal(r.bobMode, true);
  assert.equal(mode, true);
  assert.match(posts[0].text, /legion/i);
  assert.equal(posts[0].username, 'Riker'); // announced in the new (bob) theme
});

test('presence: a successful route leaves the :eyes: receipt in place - a launch is not a finish', async () => {
  // Was: routing success called presence.done() immediately, i.e. the moment
  // the job LAUNCHED. That is the bug Task 3 fixes: a green check on launch
  // reads as "done, ignore this" when the job has barely started. The real
  // completion arrives later on notify.jobFinished (the GLMPS runner calling
  // scut.jobFinished), which is now the only thing that clears the receipt.
  const seq = [];
  const presence = { receipt: () => seq.push('receipt'), done: () => seq.push('done'), failed: () => seq.push('failed') };
  const ok = createEngine({ getTheme: () => PRO, onMention: () => {}, presence });
  await ok.onEvent({ type: 'app_mention', text: '<@U0> builder do X', channel: 'C1', ts: '1' });
  assert.deepEqual(seq, ['receipt']);
});

test('presence: a routing failure (onMention throws) still marks failed', async () => {
  const seq = [];
  const presence = { receipt: () => seq.push('receipt'), done: () => seq.push('done'), failed: () => seq.push('failed') };
  const fail = createEngine({ getTheme: () => PRO, onMention: () => { throw new Error('boom'); }, presence });
  await fail.onEvent({ type: 'app_mention', text: '<@U0> builder do X', channel: 'C1', ts: '2' });
  assert.deepEqual(seq, ['receipt', 'failed']);
});

test('presence: a bobmode toggle gets a done ack (no receipt)', async () => {
  const seq = [];
  const presence = { receipt: () => seq.push('receipt'), done: () => seq.push('done'), failed: () => seq.push('failed') };
  const engine = createEngine({ getTheme: () => PRO, onMention: () => {}, onBobToggle: () => {}, presence });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> bobmode on', channel: 'C1', ts: '3' });
  assert.deepEqual(seq, ['done']);
});

test('guard: an unauthorized/flagged mention is rejected (failed ack, never routed)', async () => {
  const mentions = [];
  const seq = [];
  const presence = { receipt: () => seq.push('receipt'), done: () => seq.push('done'), failed: () => seq.push('failed') };
  const guard = { check: () => ({ allowed: false, reason: 'not-authorized' }) };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), presence, guard });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', user: 'U9', channel: 'C1', ts: '1', event_ts: '1' });
  assert.deepEqual(mentions, []);   // never routed
  assert.deepEqual(seq, ['failed']); // x, and no receipt was posted
});

test('guard: an allowed mention routes normally', async () => {
  const mentions = [];
  const guard = { check: () => ({ allowed: true }) };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), guard });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', user: 'U1', channel: 'C1', ts: '1', event_ts: '1' });
  assert.deepEqual(mentions, ['riker']);
});

test('dedup: a redelivered event (same event_ts) is dropped, routed once', async () => {
  const mentions = [];
  const seen = new Set();
  const dedup = { isNew: (k) => (seen.has(k) ? false : (seen.add(k), true)) };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), dedup });
  const ev = { type: 'app_mention', text: '<@U0> builder do X', channel: 'C1', ts: '1', event_ts: 'E1' };
  await engine.onEvent(ev);
  await engine.onEvent(ev); // duplicate delivery
  assert.deepEqual(mentions, ['riker']);
});

test('onEvent ignores a bot message so SCUT cannot answer itself', async () => {
  let routed = 0;
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: async () => { routed += 1; }, botUserId: 'UBOT' });
  await engine.onEvent({ type: 'app_mention', text: 'hi', user: 'UBOT', channel: 'C1', ts: '1.1' });
  await engine.onEvent({ type: 'app_mention', text: 'hi', bot_id: 'B9', channel: 'C1', ts: '1.2' });
  await engine.onEvent({ type: 'app_mention', text: 'hi', subtype: 'bot_message', channel: 'C1', ts: '1.3' });
  assert.equal(routed, 0);
});


test('a recognized command calls the matching handler and never routes to onMention', async () => {
  const mentions = [];
  const calls = [];
  const commands = {
    status: (ctx) => calls.push({ cmd: 'status', ctx }),
    stop: (arg, ctx) => calls.push({ cmd: 'stop', arg, ctx }),
    help: (ctx) => calls.push({ cmd: 'help', ctx }),
  };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> status', channel: 'C1', ts: '1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'status');
  assert.deepEqual(mentions, []); // never actuated
});

test('stop with no id passes an empty arg through - the handler must ask, never guess', async () => {
  const calls = [];
  const commands = { status: () => {}, stop: (arg) => calls.push(arg), help: () => {} };
  const engine = createEngine({ getTheme: () => PRO, onMention: () => {}, commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> stop', channel: 'C1', ts: '1' });
  assert.deepEqual(calls, ['']);
});

test('an unrecognized message still routes through onMention even when commands are wired', async () => {
  const mentions = [];
  const commands = { status: () => {}, stop: () => {}, help: () => {} };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', channel: 'C1', ts: '1' });
  assert.deepEqual(mentions, ['riker']);
});

test('a message that merely contains "status" mid-sentence still routes, does not parse as a command', async () => {
  const mentions = [];
  const calls = [];
  const commands = { status: () => calls.push('status'), stop: () => {}, help: () => {} };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> can you check the status of the build', channel: 'C1', ts: '1' });
  assert.deepEqual(calls, []);
  assert.deepEqual(mentions, ['riker']); // routed normally, no agent named -> default
});

test('a command gets a done ack with no receipt, matching the bobmode toggle pattern', async () => {
  const seq = [];
  const presence = { receipt: () => seq.push('receipt'), done: () => seq.push('done'), failed: () => seq.push('failed') };
  const commands = { status: () => {}, stop: () => {}, help: () => {} };
  const engine = createEngine({ getTheme: () => PRO, onMention: () => {}, presence, commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> status', channel: 'C1', ts: '1' });
  assert.deepEqual(seq, ['done']);
});

test('a throwing command handler marks failed, not done', async () => {
  const seq = [];
  const presence = { receipt: () => seq.push('receipt'), done: () => seq.push('done'), failed: () => seq.push('failed') };
  const commands = { status: () => { throw new Error('boom'); }, stop: () => {}, help: () => {} };
  const engine = createEngine({ getTheme: () => PRO, onMention: () => {}, presence, commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> status', channel: 'C1', ts: '1' });
  assert.deepEqual(seq, ['failed']);
});

test('onEvent bot-guard runs before dedup so a self-message never consumes a dedup slot', async () => {
  const mentions = [];
  const seen = new Set();
  const isNewCalls = [];
  const dedup = { isNew: (k) => { isNewCalls.push(k); return seen.has(k) ? false : (seen.add(k), true); } };
  const engine = createEngine({ getTheme: () => PRO, onMention: (id) => mentions.push(id), dedup, botUserId: 'UBOT' });
  // A self-message and the real mention share the same event_ts (e.g. a redelivery
  // race). If the bot-guard ran after dedup and consumed the slot, dedup.isNew
  // would be called (and the slot burned) for the self-message too, and the real
  // mention below would be wrongly dropped as a duplicate.
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', user: 'UBOT', channel: 'C1', ts: '1', event_ts: 'E1' });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> builder do X', channel: 'C1', ts: '2', event_ts: 'E1' });
  assert.deepEqual(mentions, ['riker']);
  assert.deepEqual(isNewCalls, ['E1'], 'dedup.isNew must be called exactly once - the self-message must never reach it');
});


test('close reaches commands.close with its argument and never the router', async () => {
  const calls = [];
  let routed = false;
  const commands = { status: () => {}, stop: () => {}, help: () => {}, close: (arg, ctx) => calls.push({ arg, channel: ctx.channel }) };
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => { routed = true; }, commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> close p-3', channel: 'C1', ts: '1' });
  assert.deepEqual(calls, [{ arg: 'p-3', channel: 'C1' }]);
  assert.equal(routed, false);
});

// glmps-2-0-57: approve/deny parsed but were never dispatched, so a gate reply
// was acked done and decided nothing until the agent's gate timed out.
test('approve and deny from an allowlisted user reach their handlers and never the router', async () => {
  const calls = [];
  let routed = false;
  const guard = { check: (ctx) => (ctx.user === 'U_OP' ? { allowed: true } : { allowed: false, reason: 'not-allowlisted' }) };
  const commands = {
    status: () => {}, stop: () => {}, help: () => {},
    approve: (arg, ctx) => calls.push(['approve', arg, ctx.user]),
    deny: (arg, ctx) => calls.push(['deny', arg, ctx.user]),
  };
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => { routed = true; }, guard, commands, isOpenThread: () => true });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> approve g-1-abc', user: 'U_OP', channel: 'C1', ts: '1' });
  // The gate request is posted in the session's thread, so a plain reply there is the usual answer.
  await engine.onEvent({ type: 'message', text: 'deny g-2-def', user: 'U_OP', channel: 'C1', ts: '3', thread_ts: '2' });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> approve g-3', user: 'U_STRANGER', channel: 'C1', ts: '4' });
  assert.deepEqual(calls, [['approve', 'g-1-abc', 'U_OP'], ['deny', 'g-2-def', 'U_OP']]);
  assert.equal(routed, false);
});

test('member_joined_channel reaches onRejoin only when wired, and never the router', async () => {
  const joins = []; let routed = false;
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => { routed = true; }, onRejoin: (ch, u) => joins.push([ch, u]) });
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_ts: '5' });
  assert.deepEqual(joins, [['C_T', 'U_OP']]);
  assert.equal(routed, false);
  const plain = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => { routed = true; } });
  await plain.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_ts: '6' });
  assert.equal(routed, false);
});

// unhideTicketChannel's own re-invite makes the bot the
// `inviter` of the resulting member_joined_channel event. Without this
// guard, turning rejoin-reopens on would make every unhide immediately
// re-trigger itself via its own invite - a feedback loop, not a rejoin.
test('member_joined_channel with the bot as inviter never reaches onRejoin, even for an allowlisted operator', async () => {
  const joins = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }), onMention: () => {}, botUserId: 'UBOT',
    onRejoin: (ch, u, inviter) => joins.push([ch, u, inviter]),
  });
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', inviter: 'UBOT', event_ts: '7' });
  assert.deepEqual(joins, [], 'a join the bot itself caused must never be read as an operator rejoining');
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', inviter: 'U_SOMEONE_ELSE', event_ts: '8' });
  assert.deepEqual(joins, [['C_T', 'U_OP', 'U_SOMEONE_ELSE']], 'a genuine invite by someone else still reaches onRejoin, with its inviter');
});

// Phase C final review, I2: server.js's onRejoin closure decides whether to
// trust an invited join (self-join, or an allowlisted inviter) - it can only
// do that if the inviter actually reaches it. Previously only (channel, user)
// were passed through, so server.js had no way to tell a stranger's invite
// from a self-join at all.
test('Phase C final review, I2: onRejoin receives the inviter as a third argument, null for a self-join', async () => {
  const joins = [];
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => {}, onRejoin: (ch, u, inviter) => joins.push(inviter) });
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_ts: '9' }); // no inviter field: a self-join
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', inviter: 'U_X', event_ts: '10' });
  assert.deepEqual(joins, [null, 'U_X']);
});

// Phase C final review, I3: engine.js:91 used to catch an onRejoin throw with
// a log line only - nothing else ever learned a rejoin reopen failed.
test('Phase C final review, I3: an onRejoin throw is reported through reportMiss, not just logged', async () => {
  const misses = [];
  const engine = createEngine({
    getTheme: () => ({ agents: {} }), onMention: () => {},
    onRejoin: () => { throw new Error('boom'); },
    reportMiss: (key, reason) => misses.push([key, reason]),
  });
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_ts: '11' });
  assert.equal(misses.length, 1);
  assert.equal(misses[0][0], 'scut-rejoin', 'a single stable per-route key, not a per-id one (I4 discipline)');
  assert.match(misses[0][1], /C_T/);
  assert.match(misses[0][1], /U_OP/);
  assert.match(misses[0][1], /boom/);
});

// member_joined_channel does not always carry event_ts.
// The fallback used to be a synthesized `channel:user` key, which has no
// time component - a genuine SECOND join by the same user to the same
// channel (they left and rejoined) would be dropped as "already seen"
// forever. event_id (Slack's own envelope-level id, attached by
// socket-mode.js) distinguishes each delivery instead.
test('member_joined_channel dedup falls back to event_id, never a channel:user key that would blackhole a genuine second join', async () => {
  const joins = [];
  const seen = new Set();
  const dedup = { isNew: (k) => (seen.has(k) ? false : (seen.add(k), true)) };
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => {}, onRejoin: (ch, u) => joins.push([ch, u]), dedup });
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_id: 'Ev1' });
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_id: 'Ev1' }); // a redelivery of the SAME event
  await engine.onEvent({ type: 'member_joined_channel', channel: 'C_T', user: 'U_OP', event_id: 'Ev2' }); // a genuine SECOND join
  assert.deepEqual(joins, [['C_T', 'U_OP'], ['C_T', 'U_OP']], 'the redelivery is dropped; the genuine second join is not');
});

test('approvals: a consumed message never reaches the router, guard or commands', async () => {
  const mentions = [];
  const seen = [];
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id, text) => mentions.push(text),
    guard: { check: () => ({ allowed: true }) },
    approvals: { onMessage: async (m) => { seen.push(m); return true; } },
  });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> some words', user: 'U9', channel: 'C1', ts: '1.2', thread_ts: '1.0' });
  await engine.onEvent({ type: 'message', text: 'some words', user: 'U9', channel: 'C7', ts: '2.2', thread_ts: '2.0' });
  assert.deepEqual(mentions, []);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { channel: 'C1', thread_ts: '1.0', user: 'U9', fromBot: false, text: '<@U0> some words' });
});

test('approvals: an unconsumed mention routes once, and its redelivery is still deduped', async () => {
  const mentions = [];
  const seen = new Set();
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id, text) => mentions.push(text),
    dedup: { isNew: (k) => (seen.has(k) ? false : (seen.add(k), true)) },
    approvals: { onMessage: async () => false },
  });
  const ev = { type: 'app_mention', text: '<@U0> do X', user: 'U9', channel: 'C1', ts: '1.2' };
  await engine.onEvent(ev);
  await engine.onEvent(ev);
  assert.deepEqual(mentions, ['do X']);
});

// Slack delivers one @mention twice, as `message` and as `app_mention`, with the
// same ts and no guaranteed order. The plain copy used to take the dedup slot
// first and the mention was then dropped silently: no :eyes:, no ticket.
for (const order of [['message', 'app_mention'], ['app_mention', 'message']]) {
  test(`approvals: a top-level @mention routes once whichever copy arrives first (${order.join(' then ')})`, async () => {
    const mentions = [];
    const offered = [];
    const engine = createEngine({
      getTheme: () => PRO,
      onMention: (id, text) => mentions.push(text),
      dedup: makeDedup(),
      approvals: { onMessage: async (m) => { offered.push(m.text); return false; } },
    });
    const base = { text: '<@U0> do X', user: 'U9', channel: 'C1', ts: '5.5', event_ts: '5.5' };
    for (const type of order) await engine.onEvent({ ...base, type });
    await engine.onEvent({ ...base, type: order[0] });
    assert.deepEqual(mentions, ['do X']);
    assert.equal(offered.length, 1);
  });
}

test('approvals: a consumed phrase stops both copies, and the twin is not re-offered', async () => {
  const mentions = [];
  let offered = 0;
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id, text) => mentions.push(text),
    dedup: makeDedup(),
    approvals: { onMessage: async () => { offered += 1; return true; } },
  });
  const base = { text: '<@U0> make it so', user: 'U9', channel: 'C1', ts: '6.6', event_ts: '6.6', thread_ts: '6.0' };
  await engine.onEvent({ ...base, type: 'message' });
  await engine.onEvent({ ...base, type: 'app_mention' });
  assert.equal(offered, 1);
  assert.deepEqual(mentions, []);
});

test('approvals: in a ticket channel the two copies still route once', async () => {
  const mentions = [];
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id, text) => mentions.push(text),
    dedup: makeDedup(),
    isTicketChannel: () => true,
    approvals: { onMessage: async () => false },
  });
  const base = { text: '<@U0> do Y', user: 'U9', channel: 'C1', ts: '7.7', event_ts: '7.7' };
  await engine.onEvent({ ...base, type: 'message' });
  await engine.onEvent({ ...base, type: 'app_mention' });
  assert.deepEqual(mentions, ['do Y']);
});

test('approvals: a bot post is offered marked fromBot and is never routed', async () => {
  const mentions = [];
  const seen = [];
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id, text) => mentions.push(text),
    botUserId: 'UBOT',
    isOpenThread: () => true,
    approvals: { onMessage: async (m) => { seen.push(m); return false; } },
  });
  await engine.onEvent({ type: 'message', subtype: 'bot_message', bot_id: 'B1', text: 'relayed', channel: 'C1', ts: '3.3', thread_ts: '3.0' });
  await engine.onEvent({ type: 'message', text: 'relayed', user: 'UBOT', channel: 'C1', ts: '3.4', thread_ts: '3.0' });
  assert.deepEqual(seen.map((m) => m.fromBot), [true, true]);
  assert.deepEqual(mentions, []);
});

test('approvals: a throwing check is reported and the message still routes', async () => {
  const mentions = [];
  const misses = [];
  const engine = createEngine({
    getTheme: () => PRO,
    onMention: (id, text) => mentions.push(text),
    reportMiss: (k) => misses.push(k),
    approvals: { onMessage: async () => { throw new Error('disk full'); } },
  });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> do X', user: 'U9', channel: 'C1', ts: '1.2' });
  assert.deepEqual(mentions, ['do X']);
  assert.deepEqual(misses, ['scut-approvals']);
});

// Unattended reliability T5: the launch mode override verb.
test('mode reaches commands.mode with the parsed mode and id and never the router', async () => {
  const calls = [];
  let routed = false;
  const commands = { status: () => {}, stop: () => {}, help: () => {}, mode: (m, ctx) => calls.push({ ...m, channel: ctx.channel }) };
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => { routed = true; }, commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> mode interactive p-3', channel: 'C1', ts: '1' });
  assert.deepEqual(calls, [{ mode: 'interactive', id: 'p-3', channel: 'C1' }]);
  assert.equal(routed, false);
});

// glmps-2-0-171 D5: run/drop answer the orphan post.
test('run and drop reach commands with the parsed ids and never the router', async () => {
  const calls = [];
  let routed = false;
  const commands = { status: () => {}, stop: () => {}, help: () => {}, run: (ids, ctx) => calls.push(['run', ids, ctx.channel]), drop: (ids) => calls.push(['drop', ids]) };
  const engine = createEngine({ getTheme: () => ({ agents: {} }), onMention: () => { routed = true; }, commands });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> run p-3 p-4', channel: 'C1', ts: '1' });
  await engine.onEvent({ type: 'app_mention', text: '<@U0> drop p-5', channel: 'C1', ts: '2' });
  assert.deepEqual(calls, [['run', ['p-3', 'p-4'], 'C1'], ['drop', ['p-5']]]);
  assert.equal(routed, false);
});
