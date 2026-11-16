// server/lib/scut/channel-health.js
// SCUT Slack channel poll-failure visibility (glmps-44).
//
// channel-server.js is a spawned MCP child process, one per session's bound
// Slack channel - it is NOT the dashboard server, so there is no shared
// in-memory registry to write a miss into the way an adapter's reportMiss()
// does (server/lib/adapters/health.js). Every write here lands on disk the
// instant a poll fails - there is no host process left to batch persistence
// on a timer for, the way capture-health does on its inventory tick - and
// every read (the dashboard's alert pass, a different process again) re-reads
// straight from disk on every request, because nothing here can push into the
// dashboard's memory across a process boundary.
//
// Before this, a broken poll only ever wrote `poll failed (missing_scope)` to
// the child's own stderr, which the harness captures as MCP server logs
// nobody watches. A session with that failure looks perfectly healthy on the
// dashboard forever: live, apparently working, and never hearing the operator
// again. That cost a full test cycle (2026-08-04).
//
// Keyed by CHANNEL alone, not channel+thread: whatever conversations.replies
// checks (the bot's token scope, its channel membership) is a property of the
// channel, not the thread, so two broken threads on the same channel share one
// cause. Collapsing them into a single file both satisfies "one ackable alert
// per unresolved failure" and stops the operator from re-acking the same root
// cause twice.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonStore, readJsonStoreOrDegrade, writeJsonStore } from '../json-store.js';
import { resolveStateDir } from '../state-dir.js';

// A failure recorded this many polls in a row, with no success in between,
// reads as durably broken even when the error code is not one we recognize.
// The default cadence is one poll every 3s, so 5 straight failures is ~15s of
// continuous failure - long enough that "it'll clear on the next tick" is no
// longer a credible read of what is happening.
const CONSECUTIVE_CRITICAL = 5;

// Slack error codes that mean a human has to act - grant a scope, re-invite
// the bot, un-archive the channel - before the NEXT poll could possibly
// succeed either. These read critical from the FIRST failure: waiting for a
// streak to build only delays the alert for something that provably cannot
// self-heal on retry. Everything else (rate limits, timeouts, a dropped
// connection) is presumed to clear on its own and is scored on the streak
// instead (see CONSECUTIVE_CRITICAL above).
const CONFIG_FATAL = new Set([
  'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
  'token_revoked', 'token_expired', 'not_in_channel', 'channel_not_found', 'is_archived',
]);

/** Pure: config-fatal (needs an operator) vs transient (worth just retrying). */
export function classifyPollError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return typeof code === 'string' && CONFIG_FATAL.has(code) ? 'auth' : 'transient';
}

// Same GLMPS_STATE_DIR resolution server/lib/scut/config.js#credsPath already
// uses for this child process, duplicated rather than imported from
// server/lib/paths.js on purpose: paths.js pulls in editor-root scanning and
// zone config that a small stdio MCP child has no use for and should not pay
// startup cost for. server/lib/paths.js#getPaths derives
// `scutChannelHealthDir` with the identical 'state/scut-channel-health'
// suffix so the dashboard (reader) and the channel process (writer) agree on
// one location without either importing the other.
export function channelHealthDir(env = process.env) {
  const stateDir = resolveStateDir({ env });
  return path.join(stateDir, 'state', 'scut-channel-health');
}

function fileFor(dir, channel) {
  // Channel ids are already filesystem-safe Slack ids (C0123ABC...), but this
  // value came from an env var, so sanitize before it touches a path rather
  // than trust it.
  const safe = String(channel).replace(/[^A-Za-z0-9_-]/g, '_') || '_';
  return path.join(dir, `${safe}.json`);
}

// Strict (throws on a failed read, null only when absent) for the writer; the
// dashboard reader below degrades instead.
function readRecord(file) {
  return readJsonStore(file, { fallback: null });
}

function writeRecord(file, record) {
  try {
    writeJsonStore(file, record);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record one poll failure. Never throws (fail open): the caller has already
 * logged the failure to stderr before calling this, so a health file we
 * cannot write must not take the channel down - it only loses the surfaced
 * copy, not the original log.
 * @param {string} dir - channelHealthDir()
 * @param {{channel:string, threadTs?:string, ticket?:string}} ids
 * @param {unknown} err - whatever the failed poll caught
 * @param {{now?:number}} [opts] - injectable clock; tests only
 */
export function recordPollFailure(dir, { channel, threadTs = null, ticket = null }, err, { now } = {}) {
  const ts = Number.isFinite(now) ? now : Date.now();
  const cls = classifyPollError(err);
  const reason = (err && typeof err === 'object' && (err.code || err.message)) || String(err ?? 'unknown error');
  const file = fileFor(dir, channel);
  // Derived data, not a store to protect: a corrupt record is logged by name and
  // replaced, because a blind alert matters more than a lost failure counter.
  let prev = null;
  try {
    prev = readRecord(file);
  } catch (e) {
    console.error(`[scut-channel-health] corrupt health record for ${channel}, resetting: ${e.message}`);
  }
  const record = {
    channel,
    threadTs: threadTs ?? prev?.threadTs ?? null,
    ticket: ticket ?? prev?.ticket ?? null,
    failures: (Number.isFinite(prev?.failures) ? prev.failures : 0) + 1,
    lastReason: reason,
    lastClass: cls,
    firstFailTs: Number.isFinite(prev?.firstFailTs) ? prev.firstFailTs : ts,
    lastFailTs: ts,
  };
  writeRecord(file, record);
  return record;
}

/**
 * A poll that succeeds clears the failure file: the alert must not outlive
 * the problem it reports. Never throws - clearing a channel that was never
 * recorded (the common case, most polls succeed) is a no-op, not an error.
 */
export function clearChannelHealth(dir, { channel }) {
  try { fs.unlinkSync(fileFor(dir, channel)); } catch { /* already clear, or never existed */ }
}

/**
 * Snapshot every channel currently recorded as failing, in the same shape
 * server/lib/adapters/health.js#adapterHealth uses (`degraded` present means
 * degraded; healthy channels are simply absent). A missing/unreadable
 * directory reads as empty rather than throwing - a fresh install has never
 * had a SCUT channel fail yet.
 */
export function scutChannelHealth(dir) {
  const out = {};
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const record = readJsonStoreOrDegrade(path.join(dir, name), { fallback: null });
    if (!record || !record.channel) continue;
    out[record.channel] = {
      degraded: true,
      channel: record.channel,
      threadTs: record.threadTs ?? null,
      ticket: record.ticket ?? null,
      failures: record.failures ?? 0,
      lastReason: record.lastReason ?? null,
      lastClass: record.lastClass ?? null,
      firstFailTs: record.firstFailTs ?? null,
      lastFailTs: record.lastFailTs ?? null,
      // The rate-based severity capture-health uses (misses/min) would take a
      // full minute to notice a channel that has been dead since boot at the
      // 3s default cadence - see the header comment for why type + streak
      // decide this instead.
      critical: record.lastClass === 'auth' || (record.failures ?? 0) >= CONSECUTIVE_CRITICAL,
    };
  }
  return out;
}
