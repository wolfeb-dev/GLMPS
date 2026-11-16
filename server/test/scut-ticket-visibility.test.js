// Tests for the Slack half of D27 close-and-hide (server/lib/scut/ticket-visibility.js).
// Transport (web) is injected, so no network and no real token are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideTicketChannel, unhideTicketChannel } from '../lib/scut/ticket-visibility.js';
import { SlackError } from '../lib/scut/slack-web.js';

const ENTRY = { channelId: 'C1', name: 'mc-7-fix', ticketId: 'mc-7' };

// `infoName`: what conversations.info reports as the channel's CURRENT name
//  - defaults to the entry's own name, which is what
// makes the pre-existing "tolerates name_taken" tests below correct: the
// channel already carries the name being confirmed.
function fakeWeb({ members = ['UBOT', 'U_OP', 'U_OTHER'], fail = {}, infoName = ENTRY.name, membersPages = null } = {}) {
  const calls = [];
  const web = {};
  const method = (name, impl = () => ({})) => async (args) => {
    calls.push([name, args]);
    if (fail[name]) throw new SlackError(name, fail[name], {});
    return impl(args);
  };
  web.chatPostMessage = method('chat.postMessage', () => ({ ts: '1' }));
  web.conversationsRename = method('conversations.rename', (a) => ({ channel: { name: a.name } }));
  if (membersPages) {
    let page = 0;
    web.conversationsMembers = method('conversations.members', () => {
      const p = membersPages[Math.min(page, membersPages.length - 1)];
      page += 1;
      return p;
    });
  } else {
    web.conversationsMembers = method('conversations.members', () => ({ members, response_metadata: { next_cursor: '' } }));
  }
  web.conversationsKick = method('conversations.kick');
  web.conversationsInvite = method('conversations.invite');
  web.conversationsInfo = method('conversations.info', () => ({ channel: { name: infoName } }));
  return { web, calls };
}

test('hide posts the summary, renames with closed-, then kicks only operators who are members', async () => {
  const { web, calls } = fakeWeb();
  const r = await hideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP', 'U_GONE'], summary: 'bye' });
  assert.deepEqual(calls.map((c) => c[0]), ['chat.postMessage', 'conversations.rename', 'conversations.members', 'conversations.kick']);
  assert.deepEqual(calls[0][1], { channel: 'C1', text: 'bye' });
  assert.deepEqual(calls[1][1], { channel: 'C1', name: 'closed-mc-7-fix' });
  assert.deepEqual(calls[3][1], { channel: 'C1', user: 'U_OP' });
  assert.deepEqual(r, { renamedTo: 'closed-mc-7-fix', kicked: ['U_OP'] });
});

test('hide without a summary posts nothing and still renames and kicks', async () => {
  const { web, calls } = fakeWeb();
  const r = await hideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP'], summary: null });
  assert.deepEqual(calls.map((c) => c[0]), ['conversations.rename', 'conversations.members', 'conversations.kick']);
  assert.deepEqual(r, { renamedTo: 'closed-mc-7-fix', kicked: ['U_OP'] });
});

test('hide treats not_in_channel on kick as done, and surfaces any other Slack error', async () => {
  const ok = fakeWeb({ fail: { 'conversations.kick': 'not_in_channel' } });
  assert.deepEqual((await hideTicketChannel({ web: ok.web, entry: ENTRY, operatorIds: ['U_OP'], summary: 's' })).kicked, []);
  const bad = fakeWeb({ fail: { 'conversations.kick': 'restricted_action' } });
  await assert.rejects(() => hideTicketChannel({ web: bad.web, entry: ENTRY, operatorIds: ['U_OP'], summary: 's' }), /restricted_action/);
});

test('unhide invites operators first, then restores the name; already_in_channel is fine', async () => {
  const { web, calls } = fakeWeb({ fail: { 'conversations.invite': 'already_in_channel' } });
  const r = await unhideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP'] });
  assert.deepEqual(calls.map((c) => c[0]), ['conversations.invite', 'conversations.rename']);
  assert.deepEqual(calls[0][1], { channel: 'C1', users: 'U_OP' });
  assert.deepEqual(calls[1][1], { channel: 'C1', name: 'mc-7-fix' });
  assert.deepEqual(r, { invited: [], renamedTo: 'mc-7-fix' });
});

test('unhide tolerates name_taken when the channel already carries its own name', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.rename': 'name_taken' } });
  const r = await unhideTicketChannel({ web, entry: ENTRY, operatorIds: [] });
  assert.equal(r.renamedTo, 'mc-7-fix');
});

// name_taken was swallowed unconditionally, so a GENUINE
// collision (some other channel already holds the target name) would still
// return success and claim a rename that never happened. Confirm against
// conversations.info before tolerating it.
test('hide throws a named error when name_taken is a genuine collision, not this channel already carrying the name', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.rename': 'name_taken' }, infoName: 'some-other-channel-name' });
  await assert.rejects(
    () => hideTicketChannel({ web, entry: ENTRY, operatorIds: [], summary: 's' }),
    (e) => { assert.equal(e.code, 'rename_not_confirmed'); return true; },
  );
});

test('unhide throws a named error when name_taken is a genuine collision, not this channel already carrying the name', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.rename': 'name_taken' }, infoName: 'some-other-channel-name' });
  await assert.rejects(
    () => unhideTicketChannel({ web, entry: ENTRY, operatorIds: [] }),
    (e) => { assert.equal(e.code, 'rename_not_confirmed'); return true; },
  );
});

// Phase C final review, M3: when the confirming conversations.info call
// itself fails (not just comes back with a different name), the thrown
// rename_not_confirmed reason must say so - "the channel does not already
// carry it" reads as a confirmed mismatch, not as "the confirmation call
// itself could not be made", and an operator chasing the wrong cause wastes
// the retry.
test('M3: a rename_not_confirmed reason names the info call\'s own error code when info itself fails', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.rename': 'name_taken', 'conversations.info': 'channel_not_found' } });
  await assert.rejects(
    () => hideTicketChannel({ web, entry: ENTRY, operatorIds: [], summary: 's' }),
    (e) => { assert.equal(e.code, 'rename_not_confirmed'); assert.match(e.message, /channel_not_found/); return true; },
  );
});

// markHidden(true) in server.js runs from an `onRenamed`
// callback fired right after the rename lands, so a LATER kick failure
// cannot leave the store claiming a visible channel that Slack already shows
// renamed and partially emptied.
test('hide calls onRenamed right after a successful rename, even when a later kick then fails', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.kick': 'restricted_action' } });
  let renamedCalledBefore = null;
  const onRenamed = () => { renamedCalledBefore = true; };
  await assert.rejects(() => hideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP'], summary: 's', onRenamed }), /restricted_action/);
  assert.equal(renamedCalledBefore, true, 'onRenamed must fire even though the kick afterward failed');
});

test('hide never calls onRenamed when the rename itself is refused (a genuine collision)', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.rename': 'name_taken' }, infoName: 'some-other-channel-name' });
  let called = false;
  await assert.rejects(() => hideTicketChannel({ web, entry: ENTRY, operatorIds: [], summary: 's', onRenamed: () => { called = true; } }));
  assert.equal(called, false);
});

// Round 1 review, M9
test('hide treats cant_kick_self on kick as done, same as not_in_channel', async () => {
  const { web } = fakeWeb({ fail: { 'conversations.kick': 'cant_kick_self' } });
  const r = await hideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP'], summary: 's' });
  assert.deepEqual(r.kicked, []);
});

test('hide walks every page of conversations.members before deciding who to kick', async () => {
  const { web, calls } = fakeWeb({
    membersPages: [
      { members: ['UBOT'], response_metadata: { next_cursor: 'page2' } },
      { members: ['U_OP'], response_metadata: { next_cursor: '' } },
    ],
  });
  const r = await hideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP'], summary: 's' });
  assert.deepEqual(r.kicked, ['U_OP'], 'U_OP is only on page 2 - the kick decision needs the full member list');
  assert.equal(calls.filter((c) => c[0] === 'conversations.members').length, 2);
});

test('glmps-2-0-104: hide posts the main-channel copy as a broadcast thread reply once the rename lands', async () => {
  const { web, calls } = fakeWeb();
  const order = [];
  const r = await hideTicketChannel({
    web, entry: ENTRY, operatorIds: ['U_OP'], summary: 'bye',
    main: { channel: 'C_MAIN', thread_ts: '111.222', text: 'bye, main' },
    onRenamed: () => order.push(calls.length),
  });
  assert.deepEqual(calls.map((c) => c[0]), ['chat.postMessage', 'conversations.rename', 'chat.postMessage', 'conversations.members', 'conversations.kick']);
  assert.deepEqual(calls[2][1], { channel: 'C_MAIN', thread_ts: '111.222', reply_broadcast: true, text: 'bye, main' });
  assert.deepEqual(order, [2]);
  assert.deepEqual(r, { renamedTo: 'closed-mc-7-fix', kicked: ['U_OP'] });
});

test('glmps-2-0-104: a failed main-channel post is returned, and the hide still completes', async () => {
  const calls = [];
  const { web } = fakeWeb();
  const inner = web.chatPostMessage;
  web.chatPostMessage = async (a) => { calls.push(a.channel); if (a.channel === 'C_MAIN') throw new SlackError('chat.postMessage', 'not_in_channel', {}); return inner(a); };
  const r = await hideTicketChannel({ web, entry: ENTRY, operatorIds: ['U_OP'], summary: 'bye', main: { channel: 'C_MAIN', thread_ts: '1', text: 't' } });
  assert.deepEqual(calls, ['C1', 'C_MAIN']);
  assert.equal(r.mainError?.code, 'not_in_channel');
  assert.deepEqual(r.kicked, ['U_OP']);
});

test('glmps-2-0-104: an incomplete main target posts nothing extra', async () => {
  const { web, calls } = fakeWeb();
  await hideTicketChannel({ web, entry: ENTRY, operatorIds: [], summary: 'bye', main: { channel: 'C_MAIN', text: 't' } });
  assert.equal(calls.filter((c) => c[0] === 'chat.postMessage').length, 1);
});
