// taps/tap-mirror.js
// The tap's file mirror watcher (server-and-client-tap task 10). Every few
// seconds it lists the session files this client has, then ships them to the
// server's mirror: JSONL as appended byte ranges that resume from the size the
// server holds, JSON and SQLite as whole snapshots sent only when their SHA-256
// changed. It does not use the spool, so a lost spool never corrupts a
// transcript. Failures follow the shipper's ladder (1 s doubling to 5 minutes);
// a 401 or 426 stops it until the agent sees the client paired again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { nextBackoffMs, BACKOFF_MAX_MS } from './tap-shipper.js';
import { mirrorRoots, rootIdOfFile, validateMirrorPath } from '../server/lib/kernel/tap-mirror.js';
import { MIRROR_CHUNK_BYTES, JSON_SNAPSHOT_MAX_BYTES, SQLITE_SNAPSHOT_MAX_BYTES } from '../server/lib/kernel/tap-mirror-store.js';
import { adapters as defaultAdapters } from '../server/lib/adapters/index.js';

export const MIRROR_PATH = '/api/tap/mirror';
export const MIRROR_APPEND_PATH = '/api/tap/mirror/append';
export const MIRROR_SNAPSHOT_PATH = '/api/tap/mirror/snapshot';
export const MIRROR_RATE_BYTES = 4 * 1024 * 1024;
export const MIRROR_TICK_MS = 5000;
const REQUEST_TIMEOUT_MS = 30_000;
const PASS_MAX_MS = 30_000;
const WALK_DEPTH_MAX = 12;
const SKIPPED_LISTED = 50;
const KIND_OF = { 'jsonl-tail': 'append', 'json-snapshot': 'json', 'sqlite-steps': 'sqlite' };
const SNAPSHOT_CAP = { json: JSON_SNAPSHOT_MAX_BYTES, sqlite: SQLITE_SNAPSHOT_MAX_BYTES };
const REGISTRY_REL = ['.claude-manager', 'active-sessions.json'];

function walkJsonl(dir, out, depth = 0) {
  if (depth > WALK_DEPTH_MAX) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
}

const statOf = (file) => { try { const s = fs.statSync(file); return s.isFile() ? s : null; } catch { return null; } };

/**
 * What this client could ship: { candidates: [{path, file, kind, size, mtimeMs}], skippedOutsideRoots, skippedRefused }.
 * Under claudeDir only projects/**.jsonl and the session registry are candidates; everything else
 * (credentials, settings, plugins) is never listed. A non-Claude adapter contributes the files its own discover() returns.
 */
export function listCandidates(P, adapters = defaultAdapters) {
  const roots = mirrorRoots(P);
  const raw = [];
  const jsonl = [];
  walkJsonl(P.projectsDir ?? path.join(P.claudeDir, 'projects'), jsonl);
  for (const file of jsonl) raw.push({ file, kind: 'append' });
  raw.push({ file: path.join(P.claudeDir, ...REGISTRY_REL), kind: 'json' });
  for (const adapter of adapters) {
    if (adapter.id === 'claude-code' || typeof adapter.discover !== 'function') continue;
    let descs;
    try { descs = adapter.discover(P); } catch { continue; }
    for (const d of descs ?? []) {
      const kind = KIND_OF[d?.kind];
      if (kind && d.file) raw.push({ file: d.file, kind });
    }
  }
  const seen = new Set();
  const candidates = [];
  let skippedOutsideRoots = 0; let skippedRefused = 0;
  for (const r of raw) {
    const st = statOf(r.file);
    if (!st) continue;
    const mp = rootIdOfFile(roots, r.file);
    if (!mp) { skippedOutsideRoots++; continue; }
    if (validateMirrorPath(mp)) { skippedRefused++; continue; }
    if (seen.has(mp)) continue;
    seen.add(mp);
    candidates.push({ path: mp, file: r.file, kind: r.kind, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { candidates, skippedOutsideRoots, skippedRefused };
}

/** The root ids this client has, for the heartbeat's dataRoots. */
export function dataRootIds(P) {
  return mirrorRoots(P).filter((r) => { try { return fs.statSync(r.dir).isDirectory(); } catch { return false; } }).map((r) => r.id);
}

class Abort extends Error {
  constructor(kind, reason, extra = {}) { super(reason); this.kind = kind; Object.assign(this, extra); }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleepFor = (ms) => new Promise((r) => setTimeout(r, ms));

function sqliteSnapshot(file, tmpDir, seq) {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error('node:sqlite is unavailable on this Node');
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, `snap-${process.pid}-${seq}.db`);
  fs.rmSync(out, { force: true });
  let db;
  try { db = new mod.DatabaseSync(file, { readOnly: true }); } catch { db = new mod.DatabaseSync(file); }
  try {
    // VACUUM INTO writes a consistent copy that includes what is still in the WAL.
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally { db.close(); }
  return out;
}

/** getCreds() -> {config, token} or null. getPaths() -> the client's getPaths() object. */
export function createMirrorWatcher({
  getCreds, getPaths, tmpDir, fetch: fetchFn = globalThis.fetch, now = Date.now, sleep = sleepFor, log = console.error,
  adapters = defaultAdapters, chunkBytes = MIRROR_CHUNK_BYTES, rateBytes = MIRROR_RATE_BYTES, passMaxMs = PASS_MAX_MS,
}) {
  let backoffMs = 0; let nextAt = 0;
  let inFlight = false; let stopped = null;
  let quota = null; let quotaNextAt = 0;
  let lastError = null; let lastPassTs = null; let shippedBytes = 0; let passes = 0;
  let manifest = null;
  let allowedAt = 0;
  let seq = 0;
  let counts = { append: 0, json: 0, sqlite: 0 };
  let outside = 0; let refused = 0;
  const known = new Map(); // path -> {sig, sha} for snapshot files
  const skipped = new Map(); // path -> reason
  let deadline = 0;

  function headers(token) {
    return { 'content-type': 'application/json', authorization: `Bearer ${token}`, [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) };
  }

  async function request(creds, method, route, body) {
    let res;
    try {
      res = await fetchFn(`${creds.config.server}${route}`, {
        method, headers: headers(creds.token), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) { throw new Abort('fail', `server unreachable: ${e?.cause?.code || e?.message || String(e)}`); }
    if (res.status === 401) throw new Abort('stop', 'the server refused this client; pair it again', { stopped: 'unpaired' });
    if (res.status === 426) throw new Abort('stop', 'the server requires a newer tap protocol', { stopped: 'protocol-too-old' });
    let out = null;
    try { out = await res.json(); } catch { out = null; }
    if (res.status === 507) throw new Abort('quota', 'the server mirror quota is full', { quota: { usedBytes: out?.usedBytes ?? null, quotaBytes: out?.quotaBytes ?? null } });
    if (res.status !== 200 && res.status !== 409 && res.status !== 400) throw new Abort('fail', `mirror answered ${res.status}`);
    return { status: res.status, body: out ?? {} };
  }

  // Holds shipping to rateBytes a second; false when the wait would run past the pass budget.
  async function pace() {
    const wait = allowedAt - now();
    if (wait > 0) {
      if (now() + wait > deadline) return false;
      await sleep(wait);
    }
    return true;
  }
  const account = (bytes) => { allowedAt = Math.max(now(), allowedAt) + (bytes / rateBytes) * 1000; shippedBytes += bytes; };

  const fileError = (p, reason) => { skipped.set(p, reason); log(`[tap-mirror] ${p}: ${reason}`); };

  async function shipAppend(creds, c) {
    const serverSize = manifest.files[c.path]?.size ?? 0;
    if (c.size === serverSize || c.size === 0) { skipped.delete(c.path); return; }
    let offset = c.size < serverSize ? 0 : serverSize;
    let reset = c.size < serverSize;
    let adopted = 0;
    let fd;
    try { fd = fs.openSync(c.file, 'r'); } catch (e) { fileError(c.path, `cannot open: ${e.code || e.message}`); return; }
    try {
      while (offset < c.size) {
        if (!(await pace())) return;
        const len = Math.min(chunkBytes, c.size - offset);
        const buf = Buffer.alloc(len);
        if (fs.readSync(fd, buf, 0, len, offset) < len) return; // the file shrank under us; the next pass sees it
        const res = await request(creds, 'POST', MIRROR_APPEND_PATH, { path: c.path, offset, data: buf.toString('base64'), ...(reset && offset === 0 ? { reset: true } : {}) });
        account(len);
        if (res.status === 200) {
          offset = res.body.size;
          reset = false;
          manifest.files[c.path] = { size: offset, sha256: null };
        } else if (res.status === 409) {
          if (++adopted > 3) return;
          manifest.files[c.path] = { size: res.body.size, sha256: null };
          reset = res.body.size > c.size;
          offset = reset ? 0 : res.body.size;
        } else { fileError(c.path, res.body.error || 'refused'); return; }
      }
      skipped.delete(c.path);
    } finally { fs.closeSync(fd); }
  }

  async function sendSnapshot(creds, c, buf, digest) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let restart = false;
      for (let offset = 0; offset < buf.length; offset += chunkBytes) {
        if (!(await pace())) return false;
        const part = buf.subarray(offset, offset + chunkBytes);
        const res = await request(creds, 'POST', MIRROR_SNAPSHOT_PATH, { path: c.path, kind: c.kind, sha256: digest, size: buf.length, offset, data: part.toString('base64') });
        account(part.length);
        if (res.status === 409) { restart = true; break; }
        if (res.status === 400) { fileError(c.path, res.body.error || 'refused'); return false; }
        if (res.body.unchanged || res.body.stored) break;
      }
      if (!restart) { manifest.files[c.path] = { size: buf.length, sha256: digest }; return true; }
    }
    return false;
  }

  async function shipSnapshot(creds, c) {
    let sig = `${c.size}:${c.mtimeMs}`;
    if (c.kind === 'sqlite') {
      const wal = statOf(`${c.file}-wal`);
      sig += `:${wal ? `${wal.size}:${wal.mtimeMs}` : 'nowal'}`;
    }
    const prev = known.get(c.path);
    if (prev?.sig === sig) return;
    let buf;
    if (c.kind === 'json') {
      if (c.size > SNAPSHOT_CAP.json) { skipped.set(c.path, `over the ${SNAPSHOT_CAP.json / 1048576} MiB json snapshot cap`); return; }
      try { buf = fs.readFileSync(c.file); } catch (e) { fileError(c.path, `cannot read: ${e.code || e.message}`); return; }
    } else {
      let copy;
      try {
        copy = sqliteSnapshot(c.file, tmpDir, seq++);
        const size = fs.statSync(copy).size;
        if (size > SNAPSHOT_CAP.sqlite) { skipped.set(c.path, `over the ${SNAPSHOT_CAP.sqlite / 1048576} MiB sqlite snapshot cap`); known.set(c.path, { sig, sha: null }); return; }
        buf = fs.readFileSync(copy);
      } catch (e) { fileError(c.path, `cannot snapshot: ${e.code || e.message}`); known.set(c.path, { sig, sha: null }); return; } finally { if (copy) fs.rmSync(copy, { force: true }); }
    }
    if (!buf.length) return;
    const digest = sha256(buf);
    const server = manifest.files[c.path];
    if (prev?.sha === digest || (server?.sha256 === digest && server.size === buf.length)) {
      known.set(c.path, { sig, sha: digest });
      skipped.delete(c.path);
      return;
    }
    if (await sendSnapshot(creds, c, buf, digest)) { known.set(c.path, { sig, sha: digest }); skipped.delete(c.path); }
  }

  function fail(reason) {
    backoffMs = nextBackoffMs(backoffMs);
    nextAt = now() + backoffMs;
    lastError = reason;
    manifest = null;
    log(`[tap-mirror] ${reason}; retrying in ${Math.round(backoffMs / 1000)}s`);
    return { shipped: false, reason, backoffMs };
  }

  async function tick() {
    if (inFlight) return { skipped: 'in-flight' };
    if (stopped) return { skipped: stopped };
    if (quota && now() < quotaNextAt) return { skipped: 'quota' };
    if (now() < nextAt) return { skipped: 'backoff' };
    const creds = getCreds();
    if (!creds) return { skipped: 'no-credentials' };
    inFlight = true;
    const startedBytes = shippedBytes;
    try {
      deadline = now() + passMaxMs;
      if (!manifest) {
        const m = await request(creds, 'GET', MIRROR_PATH);
        if (m.status !== 200 || !m.body?.files) throw new Abort('fail', `mirror manifest answered ${m.status}`);
        manifest = { files: m.body.files };
      }
      const list = listCandidates(getPaths(), adapters);
      outside = list.skippedOutsideRoots; refused = list.skippedRefused;
      counts = { append: 0, json: 0, sqlite: 0 };
      for (const c of list.candidates) counts[c.kind]++;
      list.candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const c of list.candidates) {
        if (now() >= deadline) break;
        if (c.kind === 'append') await shipAppend(creds, c); else await shipSnapshot(creds, c);
      }
      passes++; lastPassTs = now();
      backoffMs = 0; nextAt = 0; lastError = null; quota = null;
      return { shipped: true, bytes: shippedBytes - startedBytes };
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      if (e.kind === 'stop') { stopped = e.stopped; lastError = e.message; return { shipped: false, stopped }; }
      if (e.kind === 'quota') {
        quota = e.quota; quotaNextAt = now() + BACKOFF_MAX_MS; lastError = e.message;
        log('[tap-mirror] the server mirror quota is full; new bytes are paused');
        return { shipped: false, quota: true };
      }
      return fail(e.message);
    } finally { inFlight = false; }
  }

  return {
    tick,
    resume: () => { if (!stopped) return; stopped = null; backoffMs = 0; nextAt = 0; manifest = null; },
    busy: () => inFlight,
    status: () => ({
      state: stopped ?? (quota ? 'quota' : (backoffMs ? 'backoff' : 'ok')),
      backoffMs, nextAttemptTs: nextAt || null, lastPassTs, lastError, passes, shippedBytes,
      files: counts, skippedOutsideRoots: outside, skippedRefused: refused,
      skipped: [...skipped].slice(0, SKIPPED_LISTED).map(([p, reason]) => ({ path: p, reason })),
      quota,
    }),
  };
}
