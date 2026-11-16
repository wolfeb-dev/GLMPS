// Tests for the persistent thread<->session room mapper
// (server/lib/scut/room-mapper.js). Temp file injected via { file }; never
// touches the real ~/.glmps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roomKey, getRoom, bindRoom, listRooms, findRoomByTicket, findRoomBySession, pruneRooms, roomsPath, planRebinds } from '../lib/scut/room-mapper.js';

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scut-rooms-'));
  return path.join(d, 'rooms.json');
}

// The injected env is what lets startServer({ env }) isolate this path; reading
// the real process.env here instead would silently fall through to the
// operator's own ~/.glmps in any test that boots a server.
test('roomsPath resolves from an injected env, not the real process env', () => {
  const explicit = path.join(os.tmpdir(), 'scut-explicit', 'rooms.json');
  assert.equal(roomsPath(undefined, { SCUT_ROOMS_FILE: explicit }), explicit);

  const stateDir = path.join(os.tmpdir(), 'scut-state');
  assert.equal(roomsPath(undefined, { GLMPS_STATE_DIR: stateDir }), path.join(stateDir, 'scut', 'rooms.json'));

  // An explicit stateDir argument wins over the env's GLMPS_STATE_DIR.
  const argDir = path.join(os.tmpdir(), 'scut-arg');
  assert.equal(roomsPath(argDir, { GLMPS_STATE_DIR: stateDir }), path.join(argDir, 'scut', 'rooms.json'));
});

test('an unbound thread has no room', () => {
  const file = tmpFile();
  assert.equal(getRoom('C1', '111.1', { file }), null);
});

test('bindRoom persists and getRoom reads it back', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-9', project: 'mc' }, { file });
  const r = getRoom('C1', '111.1', { file });
  assert.equal(r.ticketId, 'glmps-9');
  assert.equal(r.project, 'mc');
  assert.ok(r.createdTs > 0);
});

test('bindRoom merges into an existing room instead of clobbering it', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-9' }, { file });
  bindRoom({ channel: 'C1', thread_ts: '111.1', sessionId: 'sess-abc' }, { file });
  const r = getRoom('C1', '111.1', { file });
  assert.equal(r.ticketId, 'glmps-9');
  assert.equal(r.sessionId, 'sess-abc');
});

test('roomKey namespaces by channel so the same thread_ts in two channels is two rooms', () => {
  assert.notEqual(roomKey('C1', '1.1'), roomKey('C2', '1.1'));
});

test('findRoomByTicket resolves the outbound direction', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '111.1', ticketId: 'glmps-9' }, { file });
  assert.equal(findRoomByTicket('glmps-9', { file }).channel, 'C1');
  assert.equal(findRoomByTicket('nope', { file }), null);
});

test('a corrupt rooms file reads as empty and never throws', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(listRooms({ file }), []);
});

test('pruneRooms drops the oldest beyond max and anything past maxAgeMs', () => {
  const file = tmpFile();
  for (let i = 0; i < 5; i += 1) bindRoom({ channel: 'C1', thread_ts: `${i}.0`, ticketId: `t${i}` }, { file });
  const r = pruneRooms({ max: 3 }, { file });
  assert.equal(r.kept, 3);
  assert.equal(r.dropped, 2);
  assert.equal(listRooms({ file }).length, 3);
});

test('writes are atomic - no .tmp file survives', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '1.1', ticketId: 't' }, { file });
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.equal(fs.existsSync(file), true);
});

// glmps-29: the gate path knows only the blocked SESSION, never the
// ticket, so it needs the reverse lookup.

test('findRoomBySession finds the room bound to a runtime session', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '1.1', ticketId: 't1', sessionId: 'sess-a' }, { file });
  bindRoom({ channel: 'C1', thread_ts: '2.2', ticketId: 't2', sessionId: 'sess-b' }, { file });
  assert.equal(findRoomBySession('sess-b', { file }).ticketId, 't2');
});

test('findRoomBySession returns null for an unknown or empty session', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '1.1', ticketId: 't1', sessionId: 'sess-a' }, { file });
  assert.equal(findRoomBySession('nope', { file }), null);
  assert.equal(findRoomBySession(null, { file }), null);
});

test('findRoomBySession prefers the most recently updated room on a tie', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: '1.1', ticketId: 'old', sessionId: 'sess-a' }, { file });
  bindRoom({ channel: 'C1', thread_ts: '2.2', ticketId: 'new', sessionId: 'sess-a' }, { file });
  assert.equal(findRoomBySession('sess-a', { file }).ticketId, 'new');
});

// planRebinds: the pure decision behind server.js bindSessions. The 2026-07-31
// host bugcheck exposed the original inline filter (`!room.sessionId`): a room
// whose bound session DIED was never rebound, so its thread wedged - steers
// went to a corpse until someone hand-edited rooms.json. The requeue-after-
// retry path hits the same hole in normal operation (new attempt = new
// session id, room keeps the old one).

const liveRunner = (sessionId, ticketId) =>
  ({ id: sessionId, worktree: { kind: 'runner', id: ticketId } });

test('planRebinds binds an unbound room to the ticket\'s live runner session', () => {
  const plans = planRebinds({
    pairs: [{ id: 't1', room: { channel: 'C1', thread_ts: '1.1', ticketId: 't1' } }],
    live: [liveRunner('sess-new', 't1')],
    fallbackFor: () => null,
  });
  assert.deepEqual(plans, [{ channel: 'C1', thread_ts: '1.1', sessionId: 'sess-new' }]);
});

test('planRebinds rebinds a room whose bound session is no longer live', () => {
  const plans = planRebinds({
    pairs: [{ id: 't1', room: { channel: 'C1', thread_ts: '1.1', ticketId: 't1', sessionId: 'sess-dead' } }],
    live: [liveRunner('sess-new', 't1')],
    fallbackFor: () => null,
  });
  assert.deepEqual(plans, [{ channel: 'C1', thread_ts: '1.1', sessionId: 'sess-new' }]);
});

test('planRebinds leaves a room alone while its bound session is live', () => {
  const plans = planRebinds({
    pairs: [{ id: 't1', room: { channel: 'C1', thread_ts: '1.1', ticketId: 't1', sessionId: 'sess-a' } }],
    live: [{ id: 'sess-a', worktree: null }, liveRunner('sess-other', 't1')],
    fallbackFor: () => null,
  });
  assert.deepEqual(plans, []);
});

test('planRebinds never churns the store rebinding the same dead id from the fallback', () => {
  const plans = planRebinds({
    pairs: [{ id: 't1', room: { channel: 'C1', thread_ts: '1.1', ticketId: 't1', sessionId: 'sess-dead' } }],
    live: [],
    fallbackFor: () => 'sess-dead',
  });
  assert.deepEqual(plans, []);
});

test('planRebinds falls back to the ticket\'s self-reported session when no worktree matches', () => {
  const plans = planRebinds({
    pairs: [{ id: 't1', room: { channel: 'C1', thread_ts: '1.1', ticketId: 't1' } }],
    live: [{ id: 'sess-plain', worktree: null }],
    fallbackFor: (id) => (id === 't1' ? 'sess-plain' : null),
  });
  assert.deepEqual(plans, [{ channel: 'C1', thread_ts: '1.1', sessionId: 'sess-plain' }]);
});

test('planRebinds skips missing rooms and tickets with no candidate at all', () => {
  const plans = planRebinds({
    pairs: [
      { id: 't1', room: null },
      { id: 't2', room: { channel: 'C1', thread_ts: '2.2', ticketId: 't2' } },
    ],
    live: [],
    fallbackFor: () => null,
  });
  assert.deepEqual(plans, []);
});

// A ticket that owns a whole Slack channel has no thread. The key collapses to
// the channel alone, which must not collide with any thread room in it.

test('a channel-level room keys on the channel alone', () => {
  assert.equal(roomKey('C1', null), 'C1');
  assert.equal(roomKey('C1', undefined), 'C1');
  assert.equal(roomKey('C1', ''), 'C1');
  assert.equal(roomKey('C1', '123.45'), 'C1:123.45');
});

test('a channel-level room round-trips and never collides with a thread room', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: null, ticketId: 't-chan' }, { file });
  bindRoom({ channel: 'C1', thread_ts: '9.9', ticketId: 't-thread' }, { file });
  assert.equal(getRoom('C1', null, { file }).ticketId, 't-chan');
  assert.equal(getRoom('C1', '9.9', { file }).ticketId, 't-thread');
});

test('a channel-level room is found by ticket and reports a null thread', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C1', thread_ts: null, ticketId: 't1' }, { file });
  const room = findRoomByTicket('t1', { file });
  assert.equal(room.channel, 'C1');
  assert.equal(room.thread_ts, null);
});

test('findRoomByTicket prefers the channel-level room over the doorway thread', () => {
  const file = tmpFile();
  bindRoom({ channel: 'C_PROJ', thread_ts: '1.1', ticketId: 't1' }, { file });
  bindRoom({ channel: 'C_TICKET', thread_ts: null, ticketId: 't1' }, { file });
  assert.equal(findRoomByTicket('t1', { file }).channel, 'C_TICKET');
});
