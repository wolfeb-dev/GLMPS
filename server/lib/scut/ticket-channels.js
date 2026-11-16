// server/lib/scut/ticket-channels.js
// The authoritative map: Slack channel id -> the ONE ticket that channel is
// the conversation for. Everything about inbound isolation rests on this file.
//
// Why it is a separate store from channel-map.js: that one maps a channel NAME
// to a PROJECT and is about routing a new request to the right repo. This one
// maps a channel ID to an existing TICKET and is about never letting a reply
// reach the wrong session. Different keys, different lifetimes, different
// failure consequences.
//
// Three rules, enforced here rather than at the call sites:
//   1. One channel maps to exactly one ticket, and one ticket to exactly one
//      channel. A conflicting bind THROWS. Silently rebinding would be the
//      mechanism by which one operator reply lands in two sessions.
//   2. Nothing here is ever pruned by age or by count. room-mapper.js prunes
//      (500 rooms / 30 days) and that is fine for a thread whose loss only
//      costs context - but a pruned TICKET CHANNEL reads as "not a ticket
//      channel", and the next message in it would be treated as a brand new
//      request and file a second ticket. That is the exact "a reply crossed
//      into a different session" failure this feature was gated on, so the
//      cure is to never forget. At the observed rate (about 1.2 Slack tickets
//      a day) this file grows by roughly 40 small records a month.
//   3. Hiding does NOT delete the mapping. A hidden channel is still a
//      ticket channel, and a reply in it reopens the ticket (D27).
//
// Atomic tmp+rename persistence, mirroring room-mapper.js.
import { join } from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { resolveStateDir } from '../state-dir.js';

// Slack's hard limit on a channel name.
const MAX_NAME = 80;

/** Where the store lives. `env` is injectable so tests never touch the real state dir. */
export function ticketChannelsPath(stateDir, env = process.env) {
  if (env.SCUT_TICKET_CHANNELS_FILE) return env.SCUT_TICKET_CHANNELS_FILE;
  const dir = stateDir ?? resolveStateDir({ env });
  return join(dir, 'scut', 'ticket-channels.json');
}

const validStore = (v) => v && typeof v.channels === 'object' && v.channels !== null;
const emptyStore = () => ({ channels: {} });

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

function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The Slack channel name for a ticket: the ticket id, then as much of the
 * title as fits. Lowercase, hyphenated, at most 80 characters, never with a
 * trailing hyphen (Slack accepts one but it looks like a truncation bug).
 * A title with nothing sluggable in it degrades to the bare ticket id, which
 * is still unique and still legible.
 */
export function ticketChannelName(ticketId, title = '') {
  const id = slug(ticketId).slice(0, MAX_NAME).replace(/-+$/g, '');
  const rest = slug(title);
  if (!rest) return id;
  const room = MAX_NAME - id.length - 1;
  if (room <= 0) return id;
  const tail = rest.slice(0, room).replace(/-+$/g, '');
  return tail ? `${id}-${tail}` : id;
}

/** `{ channel, thread_ts }` of a Slack origin, or null when it names no thread. */
export function originThread(origin) {
  const channel = origin?.channel;
  const thread_ts = origin?.thread_ts ?? origin?.ts;
  return channel && thread_ts ? { channel: String(channel), thread_ts: String(thread_ts) } : null;
}

/**
 * Register a channel as a ticket's conversation. Idempotent for an identical
 * pair; THROWS on any conflict, because a silent rebind is how a reply would
 * reach the wrong session.
 */
export function bindTicketChannel({ channelId, name, ticketId, project = null, origin = null }, { file = ticketChannelsPath() } = {}) {
  if (!channelId || !ticketId) throw new Error('bindTicketChannel: channelId and ticketId are required');
  const store = readStore(file);
  const existing = store.channels[channelId] ?? null;
  if (existing && existing.ticketId !== ticketId) {
    throw new Error(`bindTicketChannel: ${channelId} is already bound to ${existing.ticketId}`);
  }
  for (const e of Object.values(store.channels)) {
    if (e.ticketId === ticketId && e.channelId !== channelId) {
      throw new Error(`bindTicketChannel: ${ticketId} already owns ${e.channelId}`);
    }
  }
  const now = Date.now();
  const entry = {
    ...(existing ?? {}),
    channelId,
    name: name ?? existing?.name ?? null,
    ticketId,
    project: project ?? existing?.project ?? null,
    // The thread in the operator's channel the ticket started from. The
    // closing summary is posted back there when this channel is hidden
    // (card glmps-2-0-104); board and huddle cards carry no Slack origin of
    // their own, so this is the only record of it for them.
    origin: originThread(origin) ?? existing?.origin ?? null,
    createdTs: existing?.createdTs ?? now,
    hiddenTs: existing?.hiddenTs ?? null,
  };
  store.channels[channelId] = entry;
  writeStore(file, store);
  return entry;
}

/**
 * The ticket this channel is the conversation for, or null.
 *
 * This is the ONE predicate that decides whether an inbound message is an
 * instruction. It answers for hidden channels too: a hidden channel still
 * emits messages (D27: reply-to-reopen), and answering null there would mean
 * hiding a channel silently turned it into a new-ticket doorway.
 */
export function ticketForChannel(channelId, { file = ticketChannelsPath() } = {}) {
  if (!channelId) return null;
  return readStoreForRead(file).channels[channelId]?.ticketId ?? null;
}

/** The channel entry a ticket owns, or null. */
export function channelForTicket(ticketId, { file = ticketChannelsPath() } = {}) {
  if (!ticketId) return null;
  for (const e of Object.values(readStoreForRead(file).channels)) {
    if (e.ticketId === ticketId) return e;
  }
  return null;
}

/** Flip a ticket's channel between visible and hidden. Hiding clears a legacy archivedTs. */
export function markHidden(ticketId, hidden, { file = ticketChannelsPath(), now = Date.now } = {}) {
  const store = readStore(file);
  for (const [id, e] of Object.entries(store.channels)) {
    if (e.ticketId !== ticketId) continue;
    store.channels[id] = hidden ? { ...e, hiddenTs: now(), archivedTs: null } : { ...e, hiddenTs: null };
    writeStore(file, store);
    return store.channels[id];
  }
  return null;
}

/** Every binding, newest first. */
export function listTicketChannels({ file = ticketChannelsPath() } = {}) {
  return Object.values(readStoreForRead(file).channels).sort((a, b) => (b.createdTs ?? 0) - (a.createdTs ?? 0));
}
