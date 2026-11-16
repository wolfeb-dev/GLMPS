// server/lib/scut/pending-reopens.js
// Operator replies that could not reopen their card because every runner slot
// was busy (glmps-2-0-108). The reopen loop saves them here instead of
// throwing them away; server.js drains them through the same loop once a slot
// frees. On disk, not in memory, because the server restarts on every deploy
// and a saved reply has to survive that.
//
// Atomic tmp+rename persistence, mirroring ticket-channels.js.
import { join } from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { resolveStateDir } from '../state-dir.js';

export function pendingReopensPath(stateDir, env = process.env) {
  if (env.SCUT_PENDING_REOPENS_FILE) return env.SCUT_PENDING_REOPENS_FILE;
  const dir = stateDir ?? resolveStateDir({ env });
  return join(dir, 'scut', 'pending-reopens.json');
}

const validStore = (v) => v && typeof v.tickets === 'object' && v.tickets !== null;
const emptyStore = () => ({ tickets: {} });

// A replay that fails this many times stops retrying and hands the words back
// to the thread, so a card that can never reopen does not loop every tick.
export const MAX_DRAIN_ATTEMPTS = 3;

/** Append one reply for a ticket. Several replies for one ticket keep their order. */
export function addPendingReopen(ticketId, { text, ctx = null, ts = Date.now(), attempts = 0 }, { file }) {
  const store = readJsonStore(file, { fallback: emptyStore, validate: validStore });
  (store.tickets[ticketId] ??= []).push({ text: String(text ?? ''), ctx, ts, attempts });
  writeJsonStore(file, store, { trailingNewline: true });
}

/**
 * Put taken replies back AHEAD of anything saved for the ticket since they
 * were taken, so arrival order holds across a failed replay.
 */
export function restorePendingReopens(ticketId, replies, { file }) {
  if (!replies.length) return;
  const store = readJsonStore(file, { fallback: emptyStore, validate: validStore });
  store.tickets[ticketId] = [...replies, ...(store.tickets[ticketId] ?? [])];
  writeJsonStore(file, store, { trailingNewline: true });
}

/**
 * The first saved ticket the drain can act on, longest-waiting first, or
 * null. Scanning past the head is what keeps one stuck card (queued, held,
 * in_progress with no ledger entry) from blocking every younger reply.
 * 'queue': the card is running, hand the replies to its ledger entry.
 * 'reopen': the card is reopenable and a relaunch can get a slot.
 * 'drop': the card no longer exists.
 * `canRelaunch` is a boolean or a per-ticket predicate: with a reserved
 * operator lane (glmps-2-0-111) one card can have room while another does not.
 */
export function nextDrainAction(pending, { stateOf, hasLedger, reopenable, canRelaunch }) {
  const room = typeof canRelaunch === 'function' ? canRelaunch : () => canRelaunch;
  for (const { ticketId } of pending) {
    const state = stateOf(ticketId);
    if (!state) return { ticketId, action: 'drop' };
    if (state === 'in_progress' && hasLedger(ticketId)) return { ticketId, action: 'queue' };
    if (reopenable.has(state) && room(ticketId)) return { ticketId, action: 'reopen' };
  }
  return null;
}

/**
 * Whether a replay's loop result consumed the replies. Only 'done' did: that
 * covers a real reopen, a branch-x refusal the thread was told about, and a
 * re-deferral that already saved them again, plus a poison-scan refusal the
 * maker already answered in the thread. Any other 'nothing-to-do' (another
 * reopen held the loop's overlap lock, or the card moved on) and 'failed' did
 * not.
 */
export function drainConsumed(r) {
  return r?.outcome === 'done' || Boolean(r?.result && 'refused' in r.result);
}

export function hasPendingReopen(ticketId, { file }) {
  const store = readJsonStoreOrDegrade(file, { fallback: emptyStore, validate: validStore });
  return Boolean(store.tickets[ticketId]?.length);
}

/** Tickets with saved replies, the longest-waiting first. */
export function listPendingReopens({ file }) {
  const store = readJsonStoreOrDegrade(file, { fallback: emptyStore, validate: validStore });
  return Object.entries(store.tickets)
    .filter(([, list]) => list.length)
    .sort(([, a], [, b]) => a[0].ts - b[0].ts)
    .map(([ticketId, replies]) => ({ ticketId, replies }));
}

/** Remove and return every saved reply for a ticket (empty when there were none). */
export function takePendingReopens(ticketId, { file }) {
  const store = readJsonStore(file, { fallback: emptyStore, validate: validStore });
  const list = store.tickets[ticketId] ?? [];
  if (!list.length) return [];
  delete store.tickets[ticketId];
  writeJsonStore(file, store, { trailingNewline: true });
  return list;
}
