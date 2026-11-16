// Tests for the SCUT Socket Mode client (server/lib/scut/socket-mode.js).
// A fake WebSocket + fake web are injected -> no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocketMode } from '../lib/scut/socket-mode.js';

function fakeWs() {
  const sent = [];
  const ws = {
    sent,
    send: (s) => sent.push(JSON.parse(s)),
    close: () => { ws.closed = true; },
    closed: false,
    onmessage: null, onclose: null, onopen: null, onerror: null,
    // helper for tests to push an inbound envelope
    push: (env) => ws.onmessage({ data: JSON.stringify(env) }),
  };
  return ws;
}

function fakeWeb(url = 'wss://slack/socket') {
  return { call: async (method) => { if (method === 'apps.connections.open') return { ok: true, url }; throw new Error('unexpected ' + method); } };
}

test('start() opens a connection to the url from apps.connections.open', async () => {
  const ws = fakeWs();
  const made = [];
  const sm = createSocketMode({ web: fakeWeb('wss://slack/abc'), wsFactory: (u) => { made.push(u); return ws; }, onEvent: () => {} });
  await sm.start();
  assert.deepEqual(made, ['wss://slack/abc']);
});

test('an events_api envelope is acked and its event delivered to onEvent', async () => {
  const ws = fakeWs();
  const events = [];
  const sm = createSocketMode({ web: fakeWeb(), wsFactory: () => ws, onEvent: (e) => events.push(e) });
  await sm.start();
  // onEvent is now delivered through the serialization queue (a microtask
  // chain), so awaiting the push is required to observe it - see socket-mode.js.
  await ws.push({
    type: 'events_api', envelope_id: 'env-1',
    payload: { event: { type: 'app_mention', text: '<@U1> hi bill', user: 'U9', channel: 'C1', ts: '1.2' } },
  });
  // acked with the envelope_id
  assert.deepEqual(ws.sent, [{ envelope_id: 'env-1' }]);
  // event delivered
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'app_mention');
  assert.equal(events[0].text, '<@U1> hi bill');
});

// Slack's events_api payload carries `event_id` as a
// SIBLING of `event`, not inside it. engine.js's member_joined_channel dedup
// falls back to it (event_ts is not always present on that event type), so
// it has to actually reach onEvent - dropping it here would make that
// fallback permanently unreachable in production, not just in a unit test
// that hands event_id straight to the engine.
test('the events_api payload\'s event_id is attached onto the delivered event', async () => {
  const ws = fakeWs();
  const events = [];
  const sm = createSocketMode({ web: fakeWeb(), wsFactory: () => ws, onEvent: (e) => events.push(e) });
  await sm.start();
  await ws.push({
    type: 'events_api', envelope_id: 'env-2',
    payload: { event_id: 'Ev0PQR', event: { type: 'member_joined_channel', user: 'U_OP', channel: 'C1' } },
  });
  assert.equal(events[0].event_id, 'Ev0PQR');
  assert.equal(events[0].type, 'member_joined_channel', 'the inner event itself is otherwise untouched');
});

test('a hello envelope is ignored (no ack, no event)', async () => {
  const ws = fakeWs();
  const events = [];
  const sm = createSocketMode({ web: fakeWeb(), wsFactory: () => ws, onEvent: (e) => events.push(e) });
  await sm.start();
  ws.push({ type: 'hello', num_connections: 1 });
  assert.equal(ws.sent.length, 0);
  assert.equal(events.length, 0);
});

test('stop() closes the socket and suppresses reconnect', async () => {
  const ws = fakeWs();
  const sm = createSocketMode({ web: fakeWeb(), wsFactory: () => ws, onEvent: () => {} });
  await sm.start();
  sm.stop();
  assert.equal(ws.closed, true);
});

test('envelopes are processed serially - a slow handler does not interleave', async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const sm = createSocketMode({
    web: { call: async () => ({ url: 'ws://x' }) },
    wsFactory: () => ({ send() {}, close() {} }),
    onEvent: async (e) => {
      order.push('start:' + e.ts);
      if (e.ts === '1') await gate;
      order.push('end:' + e.ts);
    },
  });
  const a = sm._handle({ type: 'events_api', envelope_id: 'e1', payload: { event: { ts: '1' } } });
  const b = sm._handle({ type: 'events_api', envelope_id: 'e2', payload: { event: { ts: '2' } } });
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('a throwing handler does not wedge the queue', async () => {
  const seen = [];
  const sm = createSocketMode({
    web: { call: async () => ({ url: 'ws://x' }) },
    wsFactory: () => ({ send() {}, close() {} }),
    onEvent: async (e) => { seen.push(e.ts); if (e.ts === '1') throw new Error('boom'); },
  });
  await sm._handle({ type: 'events_api', envelope_id: 'e1', payload: { event: { ts: '1' } } });
  await sm._handle({ type: 'events_api', envelope_id: 'e2', payload: { event: { ts: '2' } } });
  assert.deepEqual(seen, ['1', '2']);
});

// Before this fix, reconnect() made exactly one attempt: a rejected open()
// was logged and never retried (inbound dead until a restart), while a
// fresh socket that closed immediately produced a zero-delay retry loop.
// These tests drive the retry loop with an injected sleep/random so they
// run instantly and deterministically - no real timers.

test('a failing open is retried with growing backoff, not abandoned', async () => {
  const slept = [];
  let opens = 0;
  const web = { call: async () => { opens += 1; if (opens < 4) throw new Error('boom'); return { url: 'ws://x' }; } };
  const sm = createSocketMode({
    web, wsFactory: () => ({ send() {}, close() {} }),
    onEvent: () => {}, sleep: async (ms) => { slept.push(ms); }, random: () => 0.5,
  });
  await sm.start();
  assert.equal(opens, 4, 'kept retrying until it connected');
  assert.deepEqual(slept, [1000, 2000, 4000], 'exponential, jitter factor 1.0 at random()=0.5');
  assert.equal(sm.isConnected(), true);
});

test('backoff is capped', async () => {
  const slept = [];
  let opens = 0;
  const web = { call: async () => { opens += 1; if (opens < 12) throw new Error('boom'); return { url: 'ws://x' }; } };
  const sm = createSocketMode({ web, wsFactory: () => ({ send() {}, close() {} }), onEvent: () => {}, sleep: async (ms) => { slept.push(ms); }, random: () => 0.5 });
  await sm.start();
  assert.ok(Math.max(...slept) <= 60000);
});

test('stop() cancels a pending retry so the socket does not come back', async () => {
  // As given in the plan this calls start() then stop() back-to-back with
  // no yield between them, which lets stop() land BEFORE the first open()
  // is even observed to fail - so it also passes trivially against the OLD
  // one-shot reconnect() (which never retries at all, so opens stays at 1
  // regardless of stop()). To actually discriminate, wait for the retry
  // loop to have reached sleep() - i.e. to be a genuinely PENDING retry -
  // before calling stop(). Against the old code sleepEntered never
  // resolves (sleep is never called) and this test fails as it should.
  let opens = 0;
  let release;
  let sleepStarted;
  const sleepEntered = new Promise((r) => { sleepStarted = r; });
  const gate = new Promise((r) => { release = r; });
  const web = { call: async () => { opens += 1; throw new Error('boom'); } };
  const sm = createSocketMode({
    web, wsFactory: () => ({ send() {}, close() {} }), onEvent: () => {},
    sleep: () => { sleepStarted(); return gate; }, random: () => 0.5,
  });
  const started = sm.start();
  await sleepEntered;
  sm.stop();
  release();
  await started.catch(() => {});
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(opens, 1, 'no further open() after stop()');
});

test('onState reports the transitions', async () => {
  const states = [];
  let opens = 0;
  const web = { call: async () => { opens += 1; if (opens < 2) throw new Error('boom'); return { url: 'ws://x' }; } };
  const sm = createSocketMode({ web, wsFactory: () => ({ send() {}, close() {} }), onEvent: () => {}, sleep: async () => {}, random: () => 0.5, onState: (s) => states.push(s) });
  await sm.start();
  assert.equal(states.some((s) => s.connected === false), true);
  assert.equal(states.at(-1).connected, true);
});

// The four bodies above only exercise a failing open(). stop() can also
// race a SUCCEEDING open() that is already in flight - without a check on
// the far side of that success, the newly-arrived socket would be left
// live and "connected" even though stop() had already been called,
// resurrecting exactly the client the retry loop above was told to kill.
test('stop() called while an open() is in flight closes the socket that arrives, rather than resurrecting the client', async () => {
  const ws = { sent: [], send() {}, close() { ws.closed = true; }, closed: false };
  let resolveOpen;
  const gate = new Promise((r) => { resolveOpen = r; });
  const web = { call: async () => { await gate; return { url: 'ws://x' }; } };
  const sm = createSocketMode({ web, wsFactory: () => ws, onEvent: () => {}, sleep: async () => {}, random: () => 0.5 });
  const started = sm.start();
  sm.stop();
  resolveOpen();
  await started.catch(() => {});
  assert.equal(ws.closed, true, 'the socket that arrived after stop() must be closed, not kept alive');
  assert.equal(sm.isConnected(), false);
});

// attempt used to reset to 0 on every successful open(), so a socket that
// opens fine and then closes immediately, over and over, reconnected at
// zero delay forever - hammering apps.connections.open exactly like the
// "opposite failure" described at the top of this file, just via the
// success path instead of the failure path. A connection now only earns
// the reset if it SURVIVED for stableMs; otherwise the backoff keeps
// climbing across the flap just like it does across repeated open()
// failures.

test('flapping: open() always succeeds but the socket closes immediately, so backoff still escalates', async () => {
  // The flap is capped at the fake-socket layer itself (MAX_CYCLES), not
  // via anything the client does - a buggy zero-delay reconnect and a
  // correct backing-off one both terminate after the cap, so this test
  // cannot hang regardless of which implementation it runs against; only
  // the recorded delays differ.
  const MAX_CYCLES = 5;
  const slept = [];
  let nowVal = 0;
  let cycles = 0;
  const web = { call: async () => ({ url: 'ws://x' }) };
  const wsFactory = () => {
    const socket = { send() {}, close() {}, onclose: null };
    cycles += 1;
    if (cycles <= MAX_CYCLES) {
      // A socket that dies almost the instant it opens - never anywhere
      // near stableMs (30000 default here) - simulating the "opens fine,
      // closes immediately, repeat" flap the plan's Why section warns about.
      Promise.resolve().then(() => { nowVal += 200; socket.onclose?.(); });
    }
    return socket;
  };
  const sm = createSocketMode({
    web, wsFactory, onEvent: () => {},
    sleep: async (ms) => { slept.push(ms); },
    random: () => 0.5,
    now: () => nowVal,
  });
  await sm.start();
  // Let the bounded flap sequence run its course - it is pure microtasks
  // (or, in the fixed implementation, an instantly-resolving fake sleep),
  // so it settles well within this window.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(slept.slice(0, 3), [1000, 2000, 4000], 'a flap must escalate the backoff, not hold it at zero delay');
});

test('a genuinely stable connection resets the backoff', async () => {
  const slept = [];
  let nowVal = 0;
  let ws;
  let connectCount = 0;
  let resolveConnect;
  let connectGate = new Promise((r) => { resolveConnect = r; });
  const web = { call: async () => ({ url: 'ws://x' }) };
  const wsFactory = () => { ws = { send() {}, close() {}, onclose: null }; return ws; };
  const sm = createSocketMode({
    web, wsFactory, onEvent: () => {},
    sleep: async (ms) => { slept.push(ms); },
    random: () => 0.5,
    now: () => nowVal,
    stableMs: 30000,
    onState: (s) => { if (s.connected) { connectCount += 1; resolveConnect(); } },
  });

  await sm.start(); // connect #1
  assert.equal(connectCount, 1);

  // #1 closes almost immediately -> unstable -> backoff climbs (delay 1000)
  connectGate = new Promise((r) => { resolveConnect = r; });
  nowVal += 200;
  ws.onclose();
  await connectGate; // wait for connect #2 to come up after the backoff sleep
  assert.equal(connectCount, 2);

  // #2 stays up past stableMs -> a stable close -> attempt resets to 0
  connectGate = new Promise((r) => { resolveConnect = r; });
  nowVal += 40000;
  ws.onclose();
  await connectGate; // wait for connect #3 - a stable close reconnects with no sleep at all
  assert.equal(connectCount, 3);

  // #3 closes almost immediately again - the backoff must restart at the
  // base delay, not continue climbing from before the stable reset.
  nowVal += 200;
  ws.onclose();
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(slept, [1000, 1000], 'the stable connection must have reset the backoff to the base delay');
});
