// server/lib/scut/room-mapper.js
// Persistent thread<->session room map: does a Slack `channel:thread_ts`
// already own a running Claude Code session? This is the state routing
// model C (server/lib/scut/router.js) reads and writes. Bounded + pruned so
// the file cannot grow without bound even if nobody calls pruneRooms
// directly. Atomic tmp+rename persistence, mirrors workspace-store.js:15-20
// (NOT the plain-writeFileSync pattern in scut/settings.js).
import { join } from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { resolveStateDir } from '../state-dir.js';

const DEFAULT_MAX = 500;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

// `env` is injectable so a caller that already threads an env object (server.js
// startServer({ env })) can isolate this path too. Defaulting to process.env
// keeps every existing call site unchanged.
export function roomsPath(stateDir, env = process.env) {
  if (env.SCUT_ROOMS_FILE) return env.SCUT_ROOMS_FILE;
  const dir = stateDir ?? resolveStateDir({ env });
  return join(dir, 'scut', 'rooms.json');
}

/**
 * A room's key. A THREAD room keys on `channel:thread_ts` as it always has.
 * A CHANNEL room - a ticket that owns a whole Slack channel - has no thread,
 * and keys on the channel alone. The two forms cannot collide: `C1` and
 * `C1:1788.42` are different strings, so a channel that once hosted threads
 * and later became a ticket channel keeps both sets of rooms distinct.
 */
export function roomKey(channel, thread_ts) {
  return thread_ts ? `${channel}:${thread_ts}` : `${channel}`;
}

const validStore = (v) => v && typeof v.rooms === 'object' && v.rooms !== null;
const emptyStore = () => ({ rooms: {} });

// Strict read for read-modify-write: a failed read throws rather than becoming
// an empty map that a later write would persist.
function readStore(file) {
  return readJsonStore(file, { fallback: emptyStore, validate: validStore });
}

// Pure readers degrade to empty for this one call and log. Never written back.
function readStoreForRead(file) {
  return readJsonStoreOrDegrade(file, { fallback: emptyStore, validate: validStore });
}

function writeStore(file, store) {
  writeJsonStore(file, store, { trailingNewline: true });
}

export function getRoom(channel, thread_ts, { file = roomsPath() } = {}) {
  const store = readStoreForRead(file);
  return store.rooms[roomKey(channel, thread_ts)] ?? null;
}

// Upsert: merges the patch into any existing room, stamps updatedTs on every
// write, sets createdTs only on the first write. Prunes on every call (cheap,
// bounded) so the file cannot grow without bound even if nobody ever calls
// pruneRooms explicitly.
export function bindRoom(patch, { file = roomsPath() } = {}) {
  const { channel, thread_ts } = patch;
  const key = roomKey(channel, thread_ts);
  const store = readStore(file);
  const now = Date.now();
  const existing = store.rooms[key] ?? null;
  const room = {
    ...existing,
    ...patch,
    createdTs: existing?.createdTs ?? now,
    updatedTs: now,
  };
  store.rooms[key] = room;
  pruneStore(store, {});
  writeStore(file, store);
  return store.rooms[key];
}

export function listRooms({ file = roomsPath() } = {}) {
  const store = readStoreForRead(file);
  return Object.values(store.rooms).sort((a, b) => (b.updatedTs ?? 0) - (a.updatedTs ?? 0));
}

/**
 * The room a ticket speaks through, or null.
 *
 * A ticket that owns a Slack channel (glmps-92) has TWO rooms: the
 * doorway thread it was asked in, which only exists so the original mention
 * stays attributable, and the channel-level room where the work actually
 * happens. The channel room wins - every outbound post (relay, notify,
 * progress, park release) resolves through here, and posting into the doorway
 * thread instead would scatter the conversation back across the threads this
 * feature exists to replace.
 */
export function findRoomByTicket(ticketId, { file = roomsPath() } = {}) {
  const store = readStoreForRead(file);
  let fallback = null;
  for (const room of Object.values(store.rooms)) {
    if (room.ticketId !== ticketId) continue;
    if (!room.thread_ts) return room;
    if (!fallback) fallback = room;
  }
  return fallback;
}

/**
 * The room bound to a runtime session id, or null.
 *
 * The approval-gate path (glmps-29) only knows the SESSION that is
 * blocked, not the ticket, so it needs this direction of the mapping. Prefers
 * the most recently updated room: a session id is bound to one room in practice,
 * but the store is pruned by age rather than by uniqueness, so nothing enforces
 * that.
 *
 * `>=` rather than `>` is deliberate. Two binds in the same millisecond carry
 * the SAME updatedTs, and with `>` the earlier one wins, which is the opposite
 * of what "most recent" should mean. On an exact tie this falls back to store
 * order, which is insertion order (JSON.parse preserves it for string keys), so
 * the later bind wins.
 */
export function findRoomBySession(sessionId, { file = roomsPath() } = {}) {
  if (!sessionId) return null;
  let best = null;
  for (const room of Object.values(readStoreForRead(file).rooms)) {
    if (room.sessionId !== sessionId) continue;
    if (!best || (room.updatedTs ?? 0) >= (best.updatedTs ?? 0)) best = room;
  }
  return best;
}

/**
 * Which rooms need their sessionId (re)bound, as pure data - the decision
 * behind server.js bindSessions. A room needs a bind when it has no session
 * OR its bound session is no longer live: the bound session dies on a host
 * crash, and the runner's requeue-after-retry path gives the next attempt a
 * NEW session id while the room keeps the old one. Only binding never-bound
 * rooms (the original rule) wedged those threads forever - steers targeted a
 * corpse until the operator hand-edited rooms.json.
 *
 * `pairs` is [{ id: ticketId, room }], `live` is the live session summaries,
 * and `fallbackFor(ticketId)` returns the ticket's self-reported session id
 * for non-worktree runs. A plan equal to the room's current id is dropped so
 * a dead binding with no replacement does not rewrite the store every
 * reconcile tick.
 */
export function planRebinds({ pairs, live, fallbackFor }) {
  const liveIds = new Set(live.map(s => s.id));
  const plans = [];
  for (const { id, room } of pairs ?? []) {
    if (!room) continue;
    if (room.sessionId && liveIds.has(room.sessionId)) continue; // healthy bind
    let sessionId = live.find(s => s.worktree?.kind === 'runner' && s.worktree?.id === id)?.id ?? null;
    if (!sessionId) sessionId = fallbackFor(id) ?? null;
    if (!sessionId || sessionId === room.sessionId) continue;
    plans.push({ channel: room.channel, thread_ts: room.thread_ts, sessionId });
  }
  return plans;
}

// Drops rooms past maxAgeMs, then the oldest-by-updatedTs beyond max. Mutates
// store.rooms in place; callers pass the already-loaded store so bindRoom can
// prune inline without a second read-modify-write cycle.
function pruneStore(store, { max = DEFAULT_MAX, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() }) {
  const entries = Object.entries(store.rooms);
  let dropped = 0;
  const fresh = entries.filter(([, room]) => {
    const age = now - (room.updatedTs ?? 0);
    if (age > maxAgeMs) { dropped += 1; return false; }
    return true;
  });
  fresh.sort((a, b) => (b[1].updatedTs ?? 0) - (a[1].updatedTs ?? 0));
  const kept = fresh.slice(0, max);
  dropped += fresh.length - kept.length;
  store.rooms = Object.fromEntries(kept);
  return { kept: kept.length, dropped };
}

export function pruneRooms({ max = DEFAULT_MAX, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}, { file = roomsPath() } = {}) {
  const store = readStore(file);
  const result = pruneStore(store, { max, maxAgeMs, now });
  writeStore(file, store);
  return result;
}
