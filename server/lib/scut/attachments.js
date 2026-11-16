// server/lib/scut/attachments.js
// How an image or a file attached to a Slack message reaches the agent session
// that message is routed to.
//
// Slack never puts file BYTES in an event. A message carrying an upload arrives
// as ordinary text plus a `files[]` array of metadata, each entry holding an
// authenticated `url_private` that answers only to a bot token with the
// `files:read` scope. So every path in SCUT that turned an event into text for a
// session - the launch prompt, the steer note, the park wake note, the queued
// note, the MCP channel notification - was reading `text` and nothing else, and
// the attachment simply did not exist as far as the agent was concerned. That is
// the strip this module removes: fetch the bytes here, put them on disk
// somewhere the session can read, and name the path in the message body.
//
// Three rules this file exists to keep:
//
//  1. A Slack file NAME is attacker-controlled and is about to become part of a
//     filesystem path. It is sanitized to a flat `[A-Za-z0-9._-]` token prefixed
//     with the Slack file id, so a name like `../../../.ssh/authorized_keys`
//     cannot escape the directory it was meant for. So are the channel id and
//     timestamp that key the directory.
//  2. A failed download is STATED, never swallowed. A silently missing
//     attachment is indistinguishable from an operator who forgot to attach one,
//     and the most likely failure by far - a token without `files:read` - looks
//     like success at the HTTP layer: Slack answers 200 with a sign-in page.
//     That case is named explicitly, with the fix, in the text the agent reads.
//  3. Nothing here throws at its caller. A mention whose attachments could not
//     be fetched must still reach the session with its words intact.
//
// The block this produces rides INSIDE the message text, which is deliberate:
// the steer/wake/queue paths poison-scan the note they are handed, so a hostile
// filename is scanned with everything else rather than sneaking in beside it.
import fs from 'node:fs';
import path from 'node:path';
import { resolveStateDir } from '../state-dir.js';

/** Per-message cap. A Slack message carries a handful of files, never hundreds. */
export const MAX_FILES = 10;
/** Per-file cap. Big enough for screenshots, recordings and PDFs; small enough not to fill a disk. */
export const MAX_BYTES = 25 * 1024 * 1024;
/**
 * How long a downloaded attachment is kept. This directory is the one thing
 * here that grows without bound, and it grows in megabytes rather than the
 * kilobytes the neighbouring prompt files cost, so it gets a retention window
 * instead of inheriting their keep-forever behavior. Two weeks is far longer
 * than any session that could still be referencing a path, parked ones
 * included, and short enough that a year of screenshots does not accumulate.
 */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Per-file fetch budget, body included. A stalled download must not hold the message that triggered it. */
export const FETCH_TIMEOUT_MS = 30 * 1000;

/**
 * True only for https URLs on slack.com or a subdomain of it (files.slack.com).
 * The bot token is sent to nothing else: a url_private is attacker-influenced
 * data, and an `evilslack.com` or `slack.com.evil.io` host must not get it.
 */
export function isSlackHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

// Anything outside this set becomes '_'. Deliberately narrower than "what a
// filesystem accepts": this has to be safe on Windows and POSIX at once, and
// unicode display names buy nothing when the agent only needs to open the file.
const SAFE_SEGMENT = /[^A-Za-z0-9._-]+/g;

/** One path segment, flattened and bounded. Never empty, never '.' or '..'. */
function scrub(value, fallback = 'x', max = 80) {
  let s = String(value ?? '').replace(SAFE_SEGMENT, '_').replace(/_+/g, '_').replace(/^\.+/, '');
  if (s.length > max) s = s.slice(0, max);
  s = s.replace(/^[._-]+/, '');
  return s || fallback;
}

/**
 * Where downloads live: `<GLMPS_STATE_DIR|~/.glmps>/runner/attachments`.
 * Under `runner/` on purpose - that is where the queue runner already writes the
 * `<ticket>.prompt.md` every launched agent is told to open, so an attachment
 * path is the same class of location the session already reads from.
 *
 * `env` is read the way scut/config.js reads it (not via lib/paths.js) because
 * the channel-server child process does not import paths.js.
 */
export function attachmentsDir(env = process.env) {
  const stateDir = resolveStateDir({ env });
  return path.join(stateDir, 'runner', 'attachments');
}

/** The directory for ONE Slack message, keyed by channel and message ts. */
export function attachmentDirFor({ channel, ts } = {}, env = process.env) {
  return path.join(attachmentsDir(env), scrub(channel, 'channel'), scrub(ts, 'ts'));
}

/**
 * A Slack file's on-disk name: `<id>-<name>`. The id keeps two files with the
 * same name in one message from colliding, and survives a name that sanitizes
 * down to nothing.
 */
export function safeName(file = {}) {
  const id = scrub(file.id, 'file', 24);
  const base = scrub(path.basename(String(file.name ?? '')), 'attachment', 90);
  return `${id}-${base}`.slice(0, 120);
}

/**
 * A Slack event's `files[]` -> the normalized shape the rest of this module uses.
 * A file with no `url_private` is dropped rather than carried as an entry that
 * can only ever fail: Slack omits the URL for a file this token cannot see at
 * all, and reporting that as a download failure would misname the cause.
 */
export function describeFiles(event) {
  const files = Array.isArray(event?.files) ? event.files : [];
  const out = [];
  for (const f of files) {
    const urlPrivate = f?.url_private ?? f?.url_private_download ?? null;
    if (!urlPrivate) continue;
    out.push({
      id: String(f.id ?? ''),
      name: String(f.name ?? f.title ?? 'attachment'),
      mimetype: String(f.mimetype ?? ''),
      size: Number.isFinite(f.size) ? f.size : null,
      urlPrivate: String(urlPrivate),
      permalink: f.permalink ? String(f.permalink) : null,
    });
  }
  return out;
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The text appended to the message body. Empty string for no files, so callers
 * can append unconditionally without producing a trailing blank block.
 */
export function formatAttachmentBlock(results = []) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const lines = [
    `Attachments (${results.length}) from the Slack message, already downloaded to disk - read them from these paths:`,
  ];
  for (const r of results) {
    const meta = [r.mimetype || null, humanBytes(r.size)].filter(Boolean).join(', ');
    const head = meta ? `${r.name} (${meta})` : String(r.name);
    lines.push(`- ${head} -> ${r.ok ? r.path : `NOT DOWNLOADED: ${r.error}`}`);
  }
  return lines.join('\n');
}

// Slack answers an unauthorized url_private with 200 and an HTML sign-in page
// rather than an error, so "it worked" and "the app has no files:read scope"
// are the same status code. Content-type is the only cheap tell.
const SCOPE_HINT =
  'Slack answered with a sign-in page instead of the file, which means the bot token is missing the ' +
  'files:read scope (add it under OAuth & Permissions, then reinstall the app)';

/**
 * Fetch each file into `dir`. Serial on purpose: a message carries a handful of
 * files, and serial keeps the reported order and the failure text deterministic.
 * Never throws - every per-file failure comes back as `{ ok:false, error }`.
 *
 * @param {Array} files            - from describeFiles()
 * @param {object} opts
 * @param {string} opts.dir        - destination directory (created on first write)
 * @param {string} opts.token      - bot token (xoxb-...)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.timeoutMs] - per-file fetch timeout
 */
export async function downloadFiles(files = [], { dir, token, fetchImpl = fetch, maxBytes = MAX_BYTES, maxFiles = MAX_FILES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const out = [];
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const base = { id: f.id, name: f.name, mimetype: f.mimetype, size: f.size, permalink: f.permalink ?? null };
    if (i >= maxFiles) {
      out.push({ ...base, ok: false, error: `only the first ${maxFiles} attachments of this message were downloaded` });
      continue;
    }
    if (!token) {
      out.push({ ...base, ok: false, error: 'SCUT has no Slack bot token available to download it' });
      continue;
    }
    if (Number.isFinite(f.size) && f.size > maxBytes) {
      out.push({ ...base, ok: false, error: `too large (${humanBytes(f.size)}, the cap is ${humanBytes(maxBytes)})` });
      continue;
    }
    try {
      const init = { signal: AbortSignal.timeout(timeoutMs) };
      if (isSlackHost(f.urlPrivate)) init.headers = { Authorization: `Bearer ${token}` };
      const res = await fetchImpl(f.urlPrivate, init);
      if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'} fetching the file from Slack`);
      const type = String(res.headers?.get?.('content-type') ?? '');
      if (type.toLowerCase().startsWith('text/html') && !String(f.mimetype).toLowerCase().includes('html')) {
        throw new Error(SCOPE_HINT);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`too large (${humanBytes(buf.length)}, the cap is ${humanBytes(maxBytes)})`);
      const dest = path.join(dir, safeName(f));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, buf);
      out.push({ ...base, size: buf.length, ok: true, path: path.resolve(dest) });
    } catch (e) {
      out.push({ ...base, ok: false, error: String(e?.message ?? e) });
    }
  }
  return out;
}

/**
 * Delete message directories older than `maxAgeMs`. Best-effort and silent: a
 * failed sweep must never cost the message that triggered it. Returns how many
 * directories were removed, which is what makes it testable.
 */
export function pruneAttachments(env = process.env, { maxAgeMs = MAX_AGE_MS, now = Date.now() } = {}) {
  const root = attachmentsDir(env);
  let removed = 0;
  let channels = [];
  try { channels = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const c of channels) {
    if (!c.isDirectory()) continue;
    const channelDir = path.join(root, c.name);
    let messages = [];
    try { messages = fs.readdirSync(channelDir, { withFileTypes: true }); } catch { continue; }
    for (const m of messages) {
      if (!m.isDirectory()) continue;
      const dir = path.join(channelDir, m.name);
      try {
        if (now - fs.statSync(dir).mtimeMs <= maxAgeMs) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch { /* a locked or vanished directory is the next sweep's problem */ }
    }
    // Drop a channel directory once its last message directory is gone, so the
    // root does not silently keep one empty folder per channel forever.
    try { if (fs.readdirSync(channelDir).length === 0) fs.rmdirSync(channelDir); } catch { /* not empty, or gone */ }
  }
  return removed;
}

/**
 * One Slack message -> its downloaded files and the text block describing them.
 * This is the single entry point both callers use (the inbound router seam in
 * server.js and the MCP channel server's poll loop).
 *
 * @returns {Promise<{files: object[], block: string}>} - `{ files: [], block: '' }`
 *          when the message carried nothing, so callers append unconditionally.
 */
export async function collectAttachments(event, { channel, ts, token, env = process.env, fetchImpl = fetch, maxBytes = MAX_BYTES, maxFiles = MAX_FILES, maxAgeMs = MAX_AGE_MS } = {}) {
  const described = describeFiles(event);
  if (described.length === 0) return { files: [], block: '' };
  // Sweep here rather than on a timer: this is the only code that fills the
  // directory, so it is the only code that has to empty it, and gating it on
  // "this message actually has files" keeps the overwhelmingly common no-file
  // message from walking the disk at all.
  try { pruneAttachments(env, { maxAgeMs }); } catch { /* retention is never worth losing a message over */ }
  const dir = attachmentDirFor({ channel, ts: ts ?? event?.ts }, env);
  const files = await downloadFiles(described, { dir, token, fetchImpl, maxBytes, maxFiles });
  return { files, block: formatAttachmentBlock(files) };
}
