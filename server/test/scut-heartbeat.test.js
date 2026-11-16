// Tests for the SCUT host-liveness heartbeat (server/lib/scut/heartbeat.js).
// Slack holds the timer: chat.scheduleMessage books a future tripwire, and a
// living host keeps pushing it out and cancelling the previous one. All Slack
// calls are injected fakes here - no network, no real token, no real timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHeartbeat, TRIPWIRE_MARKER } from '../lib/scut/heartbeat.js';

// A fake slack-web client that records every call. Matches the three method
// names Task 2 adds to server/lib/scut/slack-web.js.
function fakeWeb() {
  const calls = { scheduled: [], deleted: [], listed: 0 };
  let n = 0;
  return {
    calls,
    pending: [],
    chatScheduleMessage: async (p) => { n += 1; calls.scheduled.push(p); return { scheduled_message_id: `S${n}` }; },
    chatDeleteScheduledMessage: async (p) => { calls.deleted.push(p.scheduled_message_id); return { ok: true }; },
    chatScheduledMessagesList: async () => ({ scheduled_messages: calls.listedFixture ?? [] }),
  };
}

test('a tick books an alarm in the future and carries the marker', async () => {
  const web = fakeWeb();
  const hb = makeHeartbeat({ web, channelId: 'C1', intervalMs: 60000, graceMultiple: 3, now: () => 1_000_000_000_000, describeState: () => 'glmps-9 running' });
  await hb.tick();
  const s = web.calls.scheduled[0];
  assert.equal(s.channel, 'C1');
  assert.equal(s.post_at, Math.floor((1_000_000_000_000 + 180000) / 1000), 'fires at now + interval*grace, in SECONDS');
  assert.match(s.text, new RegExp(TRIPWIRE_MARKER));
  assert.match(s.text, /glmps-9 running/);
  assert.equal(hb.pendingId(), 'S1');
});

// The plan's literal test seeds pending state via an optional `hb._setPending?.()`
// seam. We deliberately do NOT add that seam (plan: "Prefer no seam") - instead
// this seeds real pending state with a first tick(), then clears the recorded
// order before the tick under test so the assertion covers only the second tick.
test('the next tick books before it cancels, so a crash mid-tick still leaves an alarm', async () => {
  const web = fakeWeb();
  const order = [];
  web.chatScheduleMessage = async () => { order.push('schedule'); return { scheduled_message_id: 'S2' }; };
  web.chatDeleteScheduledMessage = async () => { order.push('delete'); return { ok: true }; };
  const hb = makeHeartbeat({ web, channelId: 'C1' });
  await hb.tick();          // seed a pending alarm (no previous one to delete yet)
  order.length = 0;         // isolate the assertion to the tick under test
  await hb.tick();
  assert.deepEqual(order, ['schedule', 'delete'], 'schedule BEFORE delete');
});

test('a failed schedule keeps the old alarm rather than disarming us', async () => {
  const web = fakeWeb();
  const hb = makeHeartbeat({ web, channelId: 'C1' });
  await hb.tick();                       // pending S1
  web.chatScheduleMessage = async () => { throw new Error('slack down'); };
  await hb.tick();                       // must not throw, must not delete S1
  assert.equal(hb.pendingId(), 'S1', 'still armed with the previous alarm');
  assert.deepEqual(web.calls.deleted, [], 'nothing was cancelled');
});

test('disarm cancels the pending alarm', async () => {
  const web = fakeWeb();
  const hb = makeHeartbeat({ web, channelId: 'C1' });
  await hb.tick();
  await hb.disarm();
  assert.deepEqual(web.calls.deleted, ['S1']);
  assert.equal(hb.pendingId(), null);
});

test('reconcile sweeps our own orphans and leaves other scheduled messages alone', async () => {
  const web = fakeWeb();
  web.chatScheduledMessagesList = async () => ({ scheduled_messages: [
    { id: 'OLD1', text: `${TRIPWIRE_MARKER} host unreachable since 10:00` },
    { id: 'SOMEONE_ELSE', text: 'standup reminder' },
  ] });
  const hb = makeHeartbeat({ web, channelId: 'C1' });
  await hb.reconcile();
  assert.deepEqual(web.calls.deleted, ['OLD1'], 'only our marker is swept');
});

test('every method is best-effort and never throws', async () => {
  const web = fakeWeb();
  web.chatScheduleMessage = async () => { throw new Error('x'); };
  web.chatDeleteScheduledMessage = async () => { throw new Error('x'); };
  web.chatScheduledMessagesList = async () => { throw new Error('x'); };
  const hb = makeHeartbeat({ web, channelId: 'C1' });
  await hb.reconcile();
  await hb.tick();
  await hb.disarm();   // reaching here without throwing IS the assertion
  assert.ok(true);
});
