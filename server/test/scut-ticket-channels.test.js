// Tests for the authoritative Slack-channel-id -> ticket-id map
// (server/lib/scut/ticket-channels.js). This store is what makes a reply
// land in exactly one session, so its one-to-one guarantees are tested as
// hard invariants, not as conveniences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ticketChannelsPath,
  ticketChannelName,
  bindTicketChannel,
  ticketForChannel,
  channelForTicket,
  markHidden,
  listTicketChannels,
  originThread,
} from '../lib/scut/ticket-channels.js';

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scut-ticket-channels-'));
  return path.join(d, 'ticket-channels.json');
}

test('an unknown channel is not a ticket channel', () => {
  assert.equal(ticketForChannel('C_UNKNOWN', { file: tmpFile() }), null);
});

test('a bound channel resolves to exactly its ticket, both directions', () => {
  const file = tmpFile();
  bindTicketChannel({ channelId: 'C1', name: 'glmps-92-x', ticketId: 'glmps-92', project: 'glmps' }, { file });
  assert.equal(ticketForChannel('C1', { file }), 'glmps-92');
  assert.equal(channelForTicket('glmps-92', { file }).channelId, 'C1');
});

test('rebinding the SAME pair is idempotent, not an error', () => {
  const file = tmpFile();
  const patch = { channelId: 'C1', name: 'n', ticketId: 't1', project: 'p' };
  const first = bindTicketChannel(patch, { file });
  const second = bindTicketChannel(patch, { file });
  assert.equal(second.createdTs, first.createdTs);
  assert.equal(listTicketChannels({ file }).length, 1);
});

test('a channel may never be pointed at a second ticket', () => {
  const file = tmpFile();
  bindTicketChannel({ channelId: 'C1', name: 'n', ticketId: 't1', project: 'p' }, { file });
  assert.throws(
    () => bindTicketChannel({ channelId: 'C1', name: 'n', ticketId: 't2', project: 'p' }, { file }),
    /already bound to t1/,
  );
  assert.equal(ticketForChannel('C1', { file }), 't1');
});

test('a ticket may never be given a second channel', () => {
  const file = tmpFile();
  bindTicketChannel({ channelId: 'C1', name: 'n', ticketId: 't1', project: 'p' }, { file });
  assert.throws(
    () => bindTicketChannel({ channelId: 'C2', name: 'n2', ticketId: 't1', project: 'p' }, { file }),
    /already owns C1/,
  );
  assert.equal(ticketForChannel('C2', { file }), null);
});

test('hiding keeps the mapping, records hiddenTs, and clears a legacy archivedTs', () => {
  const file = tmpFile();
  bindTicketChannel({ channelId: 'C1', name: 'n', ticketId: 't1' }, { file });
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  store.channels.C1.archivedTs = 123;
  fs.writeFileSync(file, JSON.stringify(store));
  const e = markHidden('t1', true, { file, now: () => 999 });
  assert.equal(e.hiddenTs, 999);
  assert.equal(e.archivedTs, null);
  assert.equal(ticketForChannel('C1', { file }), 't1');
  assert.equal(markHidden('t1', false, { file }).hiddenTs, null);
  assert.equal(markHidden('nope', true, { file }), null);
});

test('a new binding starts visible and never writes archivedTs', () => {
  const file = tmpFile();
  const e = bindTicketChannel({ channelId: 'C2', name: 'n2', ticketId: 't2' }, { file });
  assert.equal(e.hiddenTs, null);
  assert.equal('archivedTs' in e, false);
});

test('a corrupt store reads as empty rather than throwing', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.equal(ticketForChannel('C1', { file }), null);
});

test('ticketChannelsPath honours the env override', () => {
  assert.equal(
    ticketChannelsPath('/state', { SCUT_TICKET_CHANNELS_FILE: '/tmp/x.json' }),
    '/tmp/x.json',
  );
});

test('a channel name is a legal Slack slug carrying the ticket id', () => {
  const n = ticketChannelName('glmps-92', "let's move our bobiverse naming one level higher");
  assert.match(n, /^[a-z0-9-]{1,80}$/);
  assert.ok(n.startsWith('glmps-92-'));
  assert.ok(!n.endsWith('-'));
});

test('a very long title is truncated to Slack 80-char limit without a trailing dash', () => {
  const n = ticketChannelName('glmps-92', 'x'.repeat(200));
  assert.ok(n.length <= 80);
  assert.ok(!n.endsWith('-'));
});

test('a title with nothing sluggable still yields the ticket id', () => {
  assert.equal(ticketChannelName('glmps-92', '!!! ???'), 'glmps-92');
});

test('glmps-2-0-104: a bind records the origin thread, and a rebind without one keeps it', () => {
  const file = tmpFile();
  const origin = { via: 'slack', channel: 'C_MAIN', thread_ts: '111.222', ts: '111.222', user: 'U1' };
  assert.deepEqual(bindTicketChannel({ channelId: 'C1', name: 'n', ticketId: 't1', origin }, { file }).origin, { channel: 'C_MAIN', thread_ts: '111.222' });
  assert.deepEqual(bindTicketChannel({ channelId: 'C1', name: 'n', ticketId: 't1' }, { file }).origin, { channel: 'C_MAIN', thread_ts: '111.222' });
  assert.equal(bindTicketChannel({ channelId: 'C2', name: 'm', ticketId: 't2', origin: { channel: 'C_MAIN' } }, { file }).origin, null);
});

test('glmps-2-0-104: originThread falls back to ts and rejects an origin with no thread', () => {
  assert.deepEqual(originThread({ channel: 'C', ts: '1.2' }), { channel: 'C', thread_ts: '1.2' });
  assert.equal(originThread(null), null);
  assert.equal(originThread({ thread_ts: '1.2' }), null);
});
