// server/test/scut-ticket-migration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateArchivedChannels } from '../lib/scut/ticket-migration.js';
import { bindTicketChannel, channelForTicket } from '../lib/scut/ticket-channels.js';
import { SlackError } from '../lib/scut/slack-web.js';

function store(entries) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mig-')), 'ticket-channels.json');
  for (const e of entries) bindTicketChannel(e, { file });
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of entries) if (e.archivedTs) s.channels[e.channelId].archivedTs = e.archivedTs;
  fs.writeFileSync(file, JSON.stringify(s));
  return file;
}

function fakeWeb({ archived = new Set(), botCannotUnarchive = false, notMember = new Set() } = {}) {
  const calls = [];
  const web = {
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'conversations.info') return { channel: { id: params.channel, is_archived: archived.has(params.channel), is_member: !notMember.has(params.channel) } };
      if (method === 'conversations.unarchive') {
        if (botCannotUnarchive) throw new SlackError(method, 'not_allowed_token_type', {});
        archived.delete(params.channel);
        return {};
      }
      return {};
    },
    chatPostMessage: async (m) => { calls.push(['chat.postMessage', m]); return {}; },
    conversationsRename: async (a) => { calls.push(['conversations.rename', a]); return {}; },
    conversationsMembers: async () => ({ members: ['U_OP'], response_metadata: { next_cursor: '' } }),
    conversationsKick: async (a) => { calls.push(['conversations.kick', a]); return {}; },
  };
  return { web, calls };
}

test('archived channels are unarchived then hidden, counted, and the store records hiddenTs', async () => {
  const file = store([
    { channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 },
    { channelId: 'C2', name: 'a-2-y', ticketId: 'a-2', archivedTs: 11 },
    { channelId: 'C3', name: 'a-3-z', ticketId: 'a-3' },
  ]);
  const { web } = fakeWeb({ archived: new Set(['C1', 'C2']) });
  const r = await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: () => true });
  assert.deepEqual({ total: r.total, unarchived: r.unarchived, hidden: r.hidden, failed: r.failed }, { total: 2, unarchived: 2, hidden: 2, failed: 0 });
  assert.equal(typeof channelForTicket('a-1', { file }).hiddenTs, 'number');
  assert.equal(channelForTicket('a-1', { file }).archivedTs, null);
  assert.equal(channelForTicket('a-3', { file }).hiddenTs, null, 'a never-archived channel is untouched');
});

test('a bot-token unarchive refusal is listed by channel with the manual step; a rerun after a manual unarchive finishes it', async () => {
  const file = store([{ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 }]);
  const archived = new Set(['C1']);
  const first = await migrateArchivedChannels({ web: fakeWeb({ archived, botCannotUnarchive: true }).web, file, operatorIds: ['U_OP'], isClosed: () => true });
  assert.equal(first.failed, 1);
  assert.deepEqual(first.failures[0], { channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', reason: 'unarchive refused for bot tokens (not_allowed_token_type): unarchive it in Slack (open the channel, Unarchive), then rerun' });
  archived.delete('C1');
  const second = await migrateArchivedChannels({ web: fakeWeb({ archived }).web, file, operatorIds: ['U_OP'], isClosed: () => true });
  assert.deepEqual({ total: second.total, unarchived: second.unarchived, hidden: second.hidden, failed: second.failed }, { total: 1, unarchived: 0, hidden: 1, failed: 0 });
});

test('a channel the bot is no longer in is listed, not half-hidden; an open card is unarchived but not hidden; dry run changes nothing', async () => {
  const file = store([
    { channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 },
    { channelId: 'C2', name: 'a-2-y', ticketId: 'a-2', archivedTs: 10 },
  ]);
  const { web, calls } = fakeWeb({ notMember: new Set(['C1']) });
  const r = await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: (id) => id !== 'a-2' });
  assert.equal(r.failed, 1);
  assert.match(r.failures[0].reason, /^bot is not a member: invite Riker/);
  assert.equal(r.hidden, 0);
  assert.equal(channelForTicket('a-2', { file }).archivedTs, null, 'open card: archive flag cleared, channel left visible');
  const before = calls.length;
  const dry = await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: () => true, dryRun: true });
  assert.equal(dry.total, 1);
  assert.equal(calls.length, before, 'dry run calls nothing');
});

// the store must be marked hidden as soon as the rename
// lands (via onRenamed), not after the whole hideTicketChannel sequence
// succeeds too - otherwise a kick failure leaves the entry claiming
// archived forever, and a rerun reposts the closing summary.
test('a kick failure after a confirmed rename still marks the channel hidden, so a rerun never reposts the closing summary (I1)', async () => {
  const file = store([{ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 }]);
  const posts = [];
  const web = {
    call: async (method, params) => {
      if (method === 'conversations.info') return { channel: { id: params.channel, is_archived: false, is_member: true } };
      return {};
    },
    chatPostMessage: async (m) => { posts.push(m); return {}; },
    conversationsRename: async () => ({}),
    conversationsMembers: async () => ({ members: ['U_OP'], response_metadata: { next_cursor: '' } }),
    conversationsKick: async () => { const e = new Error('internal_error'); e.code = 'internal_error'; throw e; },
  };
  const r = await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: () => true });
  assert.equal(r.failed, 1, 'the kick failure is still reported, not silently swallowed');
  assert.equal(typeof channelForTicket('a-1', { file }).hiddenTs, 'number', 'the store is marked hidden as soon as the rename lands, before the kick ever runs');
  const second = await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: () => true });
  assert.equal(second.total, 0, 'already hidden: a rerun does not pick this channel up again');
  assert.equal(posts.length, 1, 'a rerun never reposts the closing summary');
});

// Fix round 1, Minor (fold): the closing summary must go out through the
// same persona-wrapped client the production close path uses, not Slack's
// bare bot identity.
test('the closing summary is posted through the riker persona (Minor: persona-wrapped posting)', async () => {
  const file = store([{ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 }]);
  const { web, calls } = fakeWeb({ archived: new Set(['C1']) });
  await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: () => true });
  const post = calls.find(([m]) => m === 'chat.postMessage')[1];
  assert.equal(post.username, 'Lead', 'riker, pro-mode default theme');
  assert.ok(post.icon_emoji, "a persona icon is attached, not Slack's bot default");
});

// Fix round 1, Minor (fold): only not_allowed_token_type is the known,
// permanent "bot tokens cannot unarchive" bug and gets the manual-step
// instruction; no_permission and method_not_supported_for_channel_type are
// different failure classes and get their own named reason with the Slack
// code, so an operator does not chase a manual unarchive that will not fix
// them.
test('no_permission and method_not_supported_for_channel_type get their own named reason with the Slack code (Minor: BOT_REFUSALS split)', async () => {
  for (const code of ['no_permission', 'method_not_supported_for_channel_type']) {
    const file = store([{ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 }]);
    const archived = new Set(['C1']);
    const web = {
      call: async (method, params) => {
        if (method === 'conversations.info') return { channel: { id: params.channel, is_archived: archived.has(params.channel), is_member: true } };
        if (method === 'conversations.unarchive') throw new SlackError(method, code, {});
        return {};
      },
      chatPostMessage: async () => ({}),
      conversationsRename: async () => ({}),
      conversationsMembers: async () => ({ members: [], response_metadata: { next_cursor: '' } }),
      conversationsKick: async () => ({}),
    };
    const r = await migrateArchivedChannels({ web, file, operatorIds: [], isClosed: () => true });
    assert.equal(r.failed, 1);
    assert.equal(r.failures[0].reason, `unarchive failed: ${code}`);
    assert.doesNotMatch(r.failures[0].reason, /unarchive it in Slack/);
  }
});

// Fix round 1, Minor (fold): a channel that is both archived and missing
// the bot unarchives successfully (unarchived++) but is still listed, not
// counted hidden - unarchived and failed are independent tallies.
test('an archived channel the bot is not a member of unarchives successfully but is still listed, not hidden (Minor: is_archived && !is_member)', async () => {
  const file = store([{ channelId: 'C1', name: 'a-1-x', ticketId: 'a-1', archivedTs: 10 }]);
  const archived = new Set(['C1']);
  const { web } = fakeWeb({ archived, notMember: new Set(['C1']) });
  const r = await migrateArchivedChannels({ web, file, operatorIds: ['U_OP'], isClosed: () => true });
  assert.equal(r.unarchived, 1, 'the unarchive itself succeeds');
  assert.equal(r.hidden, 0);
  assert.equal(r.failed, 1);
  assert.match(r.failures[0].reason, /^bot is not a member: invite Riker/);
});
