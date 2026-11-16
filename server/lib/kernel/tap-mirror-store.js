// server/lib/kernel/tap-mirror-store.js
// The file mirror's store (server-and-client-tap task 10): a manifest in
// kernel.db that is the server's record of sizes and hashes, JSONL append with
// resume and reset, hash-checked snapshots staged then renamed over the mirror
// file, and the per-client quota. The client id always comes from the caller
// (the route resolves it from the token); path rules are in tap-mirror.js.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMirrorFile, clientMirrorDir } from './tap-mirror.js';

// Raw bytes per chunk. 768 KiB would base64 to exactly the 1 MiB body cap and leave no room for the JSON envelope, so 760 KiB.
export const MIRROR_CHUNK_BYTES = 760 * 1024;
export const JSON_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
export const SQLITE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MIRROR_QUOTA_BYTES = 20 * 1024 ** 3;
const SNAPSHOT_CAPS = { json: JSON_SNAPSHOT_MAX_BYTES, sqlite: SQLITE_SNAPSHOT_MAX_BYTES };
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const SCHEMA = `CREATE TABLE IF NOT EXISTS tap_mirror_files (
  clientId TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT, updatedTs INTEGER NOT NULL, PRIMARY KEY (clientId, path));
CREATE TABLE IF NOT EXISTS tap_mirror_quota (
  clientId TEXT PRIMARY KEY, sinceTs INTEGER NOT NULL, lastTs INTEGER NOT NULL,
  usedBytes INTEGER NOT NULL, quotaBytes INTEGER NOT NULL);`;

function loadSqlite() {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite unavailable on Node ${process.versions.node} (needs 22.13+, or --experimental-sqlite on 22.5 to 22.12)`);
  return mod.DatabaseSync;
}

const refuse = (error) => ({ status: 400, body: { error } });
const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

function decodeChunk(data) {
  if (typeof data !== 'string' || !B64_RE.test(data)) return null;
  const buf = Buffer.from(data, 'base64');
  return buf.length <= MIRROR_CHUNK_BYTES ? buf : null;
}

export function openTapMirror({ dbFile, stateDir, quotaBytes = DEFAULT_MIRROR_QUOTA_BYTES, now = Date.now }) {
  const DatabaseSync = loadSqlite();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const q = {
    one: db.prepare('SELECT * FROM tap_mirror_files WHERE clientId = ? AND path = ?'),
    all: db.prepare('SELECT * FROM tap_mirror_files WHERE clientId = ? ORDER BY path'),
    used: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM tap_mirror_files WHERE clientId = ?'),
    put: db.prepare(`INSERT INTO tap_mirror_files (clientId, path, kind, size, sha256, updatedTs) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (clientId, path) DO UPDATE SET kind = excluded.kind, size = excluded.size, sha256 = excluded.sha256, updatedTs = excluded.updatedTs`),
    qOpen: db.prepare(`INSERT INTO tap_mirror_quota (clientId, sinceTs, lastTs, usedBytes, quotaBytes) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (clientId) DO UPDATE SET lastTs = excluded.lastTs, usedBytes = excluded.usedBytes, quotaBytes = excluded.quotaBytes`),
    qClose: db.prepare('DELETE FROM tap_mirror_quota WHERE clientId = ?'),
    qList: db.prepare('SELECT * FROM tap_mirror_quota ORDER BY sinceTs, clientId'),
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const mirrorDirOf = (clientId) => clientMirrorDir(stateDir, clientId);
  const stagingFile = (clientId, p) => path.join(stateDir, 'clients', clientId, 'staging', `${crypto.createHash('sha256').update(p).digest('hex')}.part`);
  const used = (clientId) => q.used.get(clientId).n;
  const fileSize = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

  // The size the server really holds: the manifest, unless the disk has less.
  const heldSize = (row, file) => (row ? Math.min(row.size, fileSize(file)) : 0);

  function overQuota(clientId, growth) {
    const u = used(clientId);
    if (u + growth <= quotaBytes) return null;
    q.qOpen.run(clientId, now(), now(), u, quotaBytes);
    return { status: 507, body: { error: 'mirror quota exceeded', usedBytes: u, quotaBytes } };
  }

  function checkCommon(clientId, body) {
    mirrorDirOf(clientId);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('body must be an object');
    if (!nonNegInt(body.offset)) return refuse('offset must be a non-negative integer');
    return null;
  }

  function append(clientId, body) {
    const bad = checkCommon(clientId, body);
    if (bad) return bad;
    let file;
    try { file = resolveMirrorFile(mirrorDirOf(clientId), body.path); } catch (e) { return refuse(e.message); }
    const buf = decodeChunk(body.data);
    if (!buf) return refuse(`data must be base64 of at most ${MIRROR_CHUNK_BYTES} bytes`);
    const reset = body.reset === true;
    if (reset && body.offset !== 0) return refuse('reset needs offset 0');
    const row = q.one.get(clientId, body.path);
    if (row && row.kind !== 'append') return refuse('path is a snapshot file');
    const held = reset ? 0 : heldSize(row, file);
    if (body.offset !== held) return { status: 409, body: { size: held } };
    const over = overQuota(clientId, buf.length - (reset ? (row?.size ?? 0) : 0));
    if (over) return over;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const size = held + buf.length;
    tx(() => {
      // Truncate to the held size first so a torn tail from a crash is overwritten, not kept.
      const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+');
      try { fs.ftruncateSync(fd, held); fs.writeSync(fd, buf, 0, buf.length, held); } finally { fs.closeSync(fd); }
      q.put.run(clientId, body.path, 'append', size, null, now());
    });
    q.qClose.run(clientId);
    return { status: 200, body: { size } };
  }

  function snapshot(clientId, body) {
    const bad = checkCommon(clientId, body);
    if (bad) return bad;
    let file;
    try { file = resolveMirrorFile(mirrorDirOf(clientId), body.path); } catch (e) { return refuse(e.message); }
    if (!(body.kind in SNAPSHOT_CAPS)) return refuse('kind must be json or sqlite');
    if (typeof body.sha256 !== 'string' || !SHA_RE.test(body.sha256)) return refuse('sha256 must be 64 lowercase hex characters');
    if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > SNAPSHOT_CAPS[body.kind]) return refuse(`size must be 1 to ${SNAPSHOT_CAPS[body.kind]} bytes for a ${body.kind} snapshot`);
    const buf = decodeChunk(body.data);
    if (!buf) return refuse(`data must be base64 of at most ${MIRROR_CHUNK_BYTES} bytes`);
    if (body.offset + buf.length > body.size) return refuse('chunk runs past the declared size');
    const row = q.one.get(clientId, body.path);
    if (row && row.kind === 'append') return refuse('path is an append file');
    const stage = stagingFile(clientId, body.path);
    if (body.offset === 0) {
      if (row && row.sha256 === body.sha256 && row.size === body.size && fileSize(file) === body.size) {
        fs.rmSync(stage, { force: true });
        return { status: 200, body: { unchanged: true } };
      }
      const over = overQuota(clientId, body.size - (row?.size ?? 0));
      if (over) return over;
      fs.mkdirSync(path.dirname(stage), { recursive: true });
      fs.writeFileSync(stage, buf);
    } else {
      const staged = fileSize(stage);
      if (body.offset !== staged) return { status: 409, body: { staged } };
      fs.appendFileSync(stage, buf);
    }
    const staged = fileSize(stage);
    if (staged < body.size) return { status: 200, body: { staged } };
    const content = fs.readFileSync(stage);
    if (content.length !== body.size || crypto.createHash('sha256').update(content).digest('hex') !== body.sha256) {
      fs.rmSync(stage, { force: true });
      return refuse('staged snapshot does not match the declared size and sha256');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tx(() => {
      try { fs.renameSync(stage, file); } catch { fs.copyFileSync(stage, file); fs.rmSync(stage, { force: true }); }
      q.put.run(clientId, body.path, body.kind, body.size, body.sha256, now());
    });
    q.qClose.run(clientId);
    return { status: 200, body: { stored: true, size: body.size } };
  }

  return {
    append, snapshot,
    manifest: (clientId) => {
      mirrorDirOf(clientId);
      const files = {};
      for (const r of q.all.all(clientId)) files[r.path] = { size: r.size, sha256: r.sha256 };
      return { files, usedBytes: used(clientId), quotaBytes };
    },
    quotaExceeded: () => q.qList.all().map((r) => ({ clientId: r.clientId, sinceTs: r.sinceTs, lastTs: r.lastTs, usedBytes: r.usedBytes, quotaBytes: r.quotaBytes })),
    closeDb: () => db.close(),
  };
}
