// Tests for the SCUT Slack Web API client (server/lib/scut/slack-web.js).
// Transport (fetch) is injected, so no network and no real token are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlackWeb, SlackError } from '../lib/scut/slack-web.js';

// A fake fetch that records calls and returns whatever `responder` yields.
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ url, init, body });
    return { json: async () => responder(url, body) };
  };
  impl.calls = calls;
  return impl;
}

test('call() POSTs JSON with Bearer auth and returns data when ok:true', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, user: 'scut-bot', team: 'T1' }));
  const web = createSlackWeb({ token: 'xoxb-abc', fetchImpl });
  const data = await web.authTest();
  assert.equal(data.user, 'scut-bot');
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://slack.com/api/auth.test');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer xoxb-abc');
  assert.match(c.init.headers['Content-Type'], /application\/json/);
});

test('call() throws SlackError with the error code when ok:false', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: false, error: 'invalid_auth' }));
  const web = createSlackWeb({ token: 'bad', fetchImpl });
  await assert.rejects(() => web.authTest(), (e) => {
    assert.ok(e instanceof SlackError);
    assert.equal(e.code, 'invalid_auth');
    assert.equal(e.method, 'auth.test');
    return true;
  });
});

test('conversationsCreate posts the channel name to conversations.create', async () => {
  const fetchImpl = fakeFetch((url, body) => ({ ok: true, channel: { id: 'C1', name: body.name } }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  const r = await web.conversationsCreate('bob-moot');
  assert.equal(r.channel.name, 'bob-moot');
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/conversations.create');
  assert.equal(fetchImpl.calls[0].body.name, 'bob-moot');
});

test('conversationsInvite posts channel + users to conversations.invite', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, channel: { id: 'C1' } }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  await web.conversationsInvite({ channel: 'C1', users: 'U777' });
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/conversations.invite');
  assert.equal(fetchImpl.calls[0].body.channel, 'C1');
  assert.equal(fetchImpl.calls[0].body.users, 'U777');
});

test('chatPostMessage passes persona + thread params straight through', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, ts: '123.456' }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  await web.chatPostMessage({
    channel: 'C1', text: 'SCUT online', username: 'Riker',
    icon_emoji: ':military_medal:', thread_ts: '100.1',
  });
  const b = fetchImpl.calls[0].body;
  assert.equal(b.channel, 'C1');
  assert.equal(b.username, 'Riker');
  assert.equal(b.icon_emoji, ':military_medal:');
  assert.equal(b.thread_ts, '100.1');
});

test('chatGetPermalink posts channel/message_ts to chat.getPermalink', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, permalink: 'https://x.slack.com/archives/C1/p1234' }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  const r = await web.chatGetPermalink({ channel: 'C1', message_ts: '111.1' });
  assert.equal(r.permalink, 'https://x.slack.com/archives/C1/p1234');
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/chat.getPermalink');
  assert.equal(b.channel, 'C1');
  assert.equal(b.message_ts, '111.1');
});

test('reactionsAdd posts channel/timestamp/name to reactions.add', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  await web.reactionsAdd({ channel: 'C1', timestamp: '1.2', name: 'eyes' });
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/reactions.add');
  assert.equal(b.channel, 'C1');
  assert.equal(b.timestamp, '1.2');
  assert.equal(b.name, 'eyes');
});

test('a custom base url is honored (for a mock server)', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true }));
  const web = createSlackWeb({ token: 't', fetchImpl, base: 'http://127.0.0.1:9/x/' });
  await web.authTest();
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:9/x/auth.test');
});

test('call retries after a 429 and honors Retry-After', async () => {
  const calls = [];
  const slept = [];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    calls.push(n);
    if (n === 1) return { ok: false, status: 429, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '2' : null) }, json: async () => ({ ok: false, error: 'ratelimited' }) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: '1.2' }) };
  };
  const web = createSlackWeb({ token: 'xoxb-t', fetchImpl, sleep: async (ms) => { slept.push(ms); } });
  const r = await web.call('chat.postMessage', { channel: 'C1' });
  assert.equal(r.ts, '1.2');
  assert.equal(calls.length, 2);
  assert.deepEqual(slept, [2000]);
});

test('call gives up after maxRetries 429s and throws SlackError', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({ ok: false, error: 'ratelimited' }) });
  const web = createSlackWeb({ token: 'xoxb-t', fetchImpl, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => web.call('chat.postMessage', {}), (e) => e.name === 'SlackError' && e.code === 'ratelimited');
});

test('a missing Retry-After header falls back to exponential backoff', async () => {
  const slept = [];
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n <= 2) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ ok: false, error: 'ratelimited' }) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
  };
  const web = createSlackWeb({ token: 'xoxb-t', fetchImpl, sleep: async (ms) => { slept.push(ms); } });
  await web.call('auth.test');
  assert.deepEqual(slept, [1000, 2000]);
});

// The three host-liveness heartbeat methods (server/lib/scut/heartbeat.js),
// added for glmps-31: schedule/cancel/list the tripwire alarm.

test('chatScheduleMessage posts channel/post_at/text to chat.scheduleMessage', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, scheduled_message_id: 'Q123' }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  const r = await web.chatScheduleMessage({ channel: 'C1', post_at: 1700000000, text: 'scut-host-tripwire: host unreachable' });
  assert.equal(r.scheduled_message_id, 'Q123');
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/chat.scheduleMessage');
  assert.equal(b.channel, 'C1');
  assert.equal(b.post_at, 1700000000);
  assert.equal(b.text, 'scut-host-tripwire: host unreachable');
});

test('chatDeleteScheduledMessage posts channel/scheduled_message_id to chat.deleteScheduledMessage', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  await web.chatDeleteScheduledMessage({ channel: 'C1', scheduled_message_id: 'Q123' });
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/chat.deleteScheduledMessage');
  assert.equal(b.channel, 'C1');
  assert.equal(b.scheduled_message_id, 'Q123');
});

test('chatScheduledMessagesList posts an optional channel filter to chat.scheduledMessages.list', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, scheduled_messages: [{ id: 'S1', channel_id: 'C1', post_at: 1700000000, text: 'x' }] }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  const r = await web.chatScheduledMessagesList({ channel: 'C1' });
  assert.equal(r.scheduled_messages[0].id, 'S1');
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/chat.scheduledMessages.list');
  assert.equal(b.channel, 'C1');
});

test('chatScheduledMessagesList works with no channel filter at all', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, scheduled_messages: [] }));
  const web = createSlackWeb({ token: 't', fetchImpl });
  await web.chatScheduledMessagesList();
  const b = fetchImpl.calls[0].body;
  assert.equal(fetchImpl.calls[0].url, 'https://slack.com/api/chat.scheduledMessages.list');
  assert.equal(b.channel, undefined);
});

// Slack does NOT accept a JSON body for this method. Proven against the live
// API once the history scopes landed: a JSON body returns
// `invalid_arguments`, while form-encoded and query-string both return the
// thread. The channel server polls this method, so a JSON body meant a session
// that connected, registered, and then heard nothing.
function fakeFormFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, raw: init?.body });
    return { json: async () => responder(url, init) };
  };
  impl.calls = calls;
  return impl;
}

test('conversationsReplies posts form-encoded, not JSON', async () => {
  const fetchImpl = fakeFormFetch(() => ({ ok: true, messages: [{ ts: '1.0' }] }));
  const web = createSlackWeb({ token: 'xoxb-abc', fetchImpl });
  const data = await web.conversationsReplies({ channel: 'C1', ts: '100.5' });
  assert.equal(data.messages.length, 1);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'https://slack.com/api/conversations.replies');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer xoxb-abc');
  assert.match(c.init.headers['Content-Type'], /x-www-form-urlencoded/);
  const params = new URLSearchParams(String(c.raw));
  assert.equal(params.get('channel'), 'C1');
  assert.equal(params.get('ts'), '100.5');
  assert.equal(params.get('limit'), '50');
});

test('conversationsReplies sends oldest as a cursor only when given', async () => {
  const fetchImpl = fakeFormFetch(() => ({ ok: true, messages: [] }));
  const web = createSlackWeb({ token: 'x', fetchImpl });
  await web.conversationsReplies({ channel: 'C1', ts: '1', oldest: '100.5' });
  assert.equal(new URLSearchParams(String(fetchImpl.calls[0].raw)).get('oldest'), '100.5');
  await web.conversationsReplies({ channel: 'C1', ts: '1' });
  assert.equal(new URLSearchParams(String(fetchImpl.calls[1].raw)).has('oldest'), false);
});

test('a form-encoded call still raises SlackError on ok:false', async () => {
  const fetchImpl = fakeFormFetch(() => ({ ok: false, error: 'missing_scope' }));
  const web = createSlackWeb({ token: 'x', fetchImpl });
  await assert.rejects(() => web.conversationsReplies({ channel: 'C1', ts: '1' }), (e) => {
    assert.equal(e.code, 'missing_scope');
    assert.equal(e.method, 'conversations.replies');
    return true;
  });
});

test('every other method keeps the JSON body it already worked with', async () => {
  const fetchImpl = fakeFormFetch(() => ({ ok: true }));
  const web = createSlackWeb({ token: 'x', fetchImpl });
  await web.chatPostMessage({ channel: 'C1', text: 'hi' });
  assert.match(fetchImpl.calls[0].init.headers['Content-Type'], /application\/json/);
});


test('rename, kick and members post the documented parameters; members is form-encoded', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init]); return { status: 200, json: async () => ({ ok: true, members: ['U1'], response_metadata: { next_cursor: '' } }) }; };
  const web = createSlackWeb({ token: 'xoxb-t', fetchImpl });
  await web.conversationsRename({ channel: 'C1', name: 'closed-x' });
  await web.conversationsKick({ channel: 'C1', user: 'U1' });
  await web.conversationsMembers({ channel: 'C1' });
  assert.match(seen[0][0], /conversations\.rename$/);
  assert.deepEqual(JSON.parse(seen[0][1].body), { channel: 'C1', name: 'closed-x' });
  assert.match(seen[1][0], /conversations\.kick$/);
  assert.deepEqual(JSON.parse(seen[1][1].body), { channel: 'C1', user: 'U1' });
  assert.match(seen[2][0], /conversations\.members$/);
  assert.equal(seen[2][1].body.get('channel'), 'C1');
  assert.equal(typeof web.conversationsArchive, 'undefined');
  assert.equal(typeof web.conversationsUnarchive, 'undefined');
});

// hide/unhide need to CONFIRM a name_taken rename
// against the channel's actual current name, not just assume it - a read
// method, form-encoded like conversationsMembers.
test('conversationsInfo posts the channel id, form-encoded, like conversationsMembers', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init]); return { status: 200, json: async () => ({ ok: true, channel: { id: 'C1', name: 'closed-x' } }) }; };
  const web = createSlackWeb({ token: 'xoxb-t', fetchImpl });
  const r = await web.conversationsInfo({ channel: 'C1' });
  assert.match(seen[0][0], /conversations\.info$/);
  assert.ok(seen[0][1].body instanceof URLSearchParams);
  assert.equal(seen[0][1].body.get('channel'), 'C1');
  assert.equal(r.channel.name, 'closed-x');
});

test('conversationsHistory is form-encoded, like conversationsReplies', async () => {
  let body = null;
  const web = createSlackWeb({
    token: 'xoxb-x',
    fetchImpl: async (_u, init) => { body = init.body; return { status: 200, json: async () => ({ ok: true, messages: [] }) }; },
  });
  await web.conversationsHistory({ channel: 'C1', oldest: '1.1' });
  assert.ok(body instanceof URLSearchParams);
  assert.equal(body.get('channel'), 'C1');
  assert.equal(body.get('oldest'), '1.1');
});

test('review P4: every fetch carries an abort signal, and a hung Slack call is cut off by the timeout', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true }));
  const web = createSlackWeb({ token: 'xoxb-abc', fetchImpl });
  await web.authTest();
  await web.chatPostMessage({ channel: 'C1', text: 'x' });
  assert.ok(fetchImpl.calls.length === 2 && fetchImpl.calls.every((c) => c.init.signal instanceof AbortSignal));

  // AbortSignal.timeout is unref'd, so on Node 22 the runner would end the
  // file while this fetch hangs; a ref'd timer keeps it open until the abort.
  const hung = (url, init) => new Promise((resolve, reject) => {
    const keepalive = setTimeout(() => {}, 10_000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepalive); reject(init.signal.reason); }, { once: true });
  });
  const slow = createSlackWeb({ token: 'xoxb-abc', fetchImpl: hung, timeoutMs: 30 });
  await assert.rejects(slow.authTest(), (e) => e?.name === 'TimeoutError');
});
