// server/lib/kernel/tap-ingest.js
// Tap ingest store (server-and-client-tap task 9): the inbox of records each
// paired tap ships from its spool, deduped by a per-client high-water mark so a
// retry or a replay after a crash lands once. The client id always comes from
// the caller (the route resolves it from the token), never from the batch.
// Kinds the server applies at ingest (CONSUMED_KINDS) only advance the mark;
// every other kind waits in the inbox, pruned to the newest keepPerClient rows.
import fs from 'node:fs';
import path from 'node:path';

export const KIND_RE = /^[a-z0-9-]{1,32}$/;
// One ingest body, matching the OTLP receiver's cap; the shipper builds batches under it.
export const TAP_INGEST_MAX_BYTES = 1024 * 1024;
// OTLP spans (task 14): the ingest route maps them into session events.
export const CONSUMED_KINDS = new Set(['otel']);
// Kinds no server code reads yet are kept so a newer tap's records survive, but bounded so they cannot grow kernel.db forever.
export const INBOX_KEEP_PER_CLIENT = 10_000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS tap_highwater (
  clientId TEXT PRIMARY KEY, highWater INTEGER NOT NULL DEFAULT 0,
  fullSinceTs INTEGER, fullLastTs INTEGER, fullDropped INTEGER, fullBytes INTEGER);
CREATE TABLE IF NOT EXISTS tap_records (
  clientId TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL,
  receivedTs INTEGER NOT NULL, payload TEXT, PRIMARY KEY (clientId, seq));`;

const nonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;

/** null when the batch is acceptable, else the reason it is refused whole. */
export function validateBatch(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be an object';
  if (!Array.isArray(b.records)) return 'records must be an array';
  let prev = 0;
  for (const r of b.records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'each record must be an object';
    if (!Number.isSafeInteger(r.seq) || r.seq < 1) return 'seq must be a positive safe integer';
    if (r.seq <= prev) return 'records must be in strictly ascending seq order';
    prev = r.seq;
    if (typeof r.kind !== 'string' || !KIND_RE.test(r.kind)) return 'kind must be 1 to 32 characters of a-z, 0-9 or -';
    if (!nonNegInt(r.ts)) return 'ts must be a non-negative integer';
    if (!('payload' in r)) return 'each record needs a payload (null is allowed)';
  }
  if (b.spool !== undefined) {
    const s = b.spool;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'spool must be an object';
    for (const k of ['depth', 'bytes', 'dropped']) if (s[k] !== undefined && !nonNegInt(s[k])) return `spool.${k} must be a non-negative integer`;
    if (s.full !== undefined && typeof s.full !== 'boolean') return 'spool.full must be a boolean';
  }
  return null;
}

function loadSqlite() {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite unavailable on Node ${process.versions.node} (needs 22.13+, or --experimental-sqlite on 22.5 to 22.12)`);
  return mod.DatabaseSync;
}

export function openTapIngest({ dbFile, now = Date.now, keepPerClient = INBOX_KEEP_PER_CLIENT }) {
  const DatabaseSync = loadSqlite();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS tap_records_kind ON tap_records (kind, clientId, seq)');
  const q = {
    hw: db.prepare('SELECT * FROM tap_highwater WHERE clientId = ?'),
    ensure: db.prepare('INSERT OR IGNORE INTO tap_highwater (clientId) VALUES (?)'),
    setHw: db.prepare('UPDATE tap_highwater SET highWater = ? WHERE clientId = ?'),
    insert: db.prepare('INSERT INTO tap_records (clientId, seq, kind, ts, receivedTs, payload) VALUES (?, ?, ?, ?, ?, ?)'),
    fullOpen: db.prepare('UPDATE tap_highwater SET fullSinceTs = COALESCE(fullSinceTs, ?), fullLastTs = ?, fullDropped = ?, fullBytes = ? WHERE clientId = ?'),
    fullClose: db.prepare('UPDATE tap_highwater SET fullSinceTs = NULL, fullLastTs = NULL, fullDropped = NULL, fullBytes = NULL WHERE clientId = ?'),
    fullList: db.prepare('SELECT * FROM tap_highwater WHERE fullSinceTs IS NOT NULL ORDER BY fullSinceTs, clientId'),
    recAll: db.prepare('SELECT * FROM tap_records WHERE seq > ? ORDER BY receivedTs, clientId, seq LIMIT ?'),
    latest: db.prepare('SELECT r.* FROM tap_records r WHERE r.kind = ? AND r.seq = (SELECT MAX(seq) FROM tap_records WHERE kind = r.kind AND clientId = r.clientId) ORDER BY r.clientId'),
    prune: db.prepare('DELETE FROM tap_records WHERE clientId = ? AND seq <= (SELECT seq FROM tap_records WHERE clientId = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)'),
    recFor: db.prepare('SELECT * FROM tap_records WHERE clientId = ? AND seq > ? ORDER BY seq LIMIT ?'),
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };

  function ingest(clientId, batch) {
    if (typeof clientId !== 'string' || !clientId) throw new TypeError('clientId is required');
    const bad = validateBatch(batch);
    if (bad) throw new TypeError(bad);
    const ts = now();
    return tx(() => {
      q.ensure.run(clientId);
      let hw = q.hw.get(clientId).highWater;
      let accepted = 0; let duplicates = 0;
      for (const r of batch.records) {
        if (r.seq <= hw) { duplicates++; continue; }
        if (!CONSUMED_KINDS.has(r.kind)) q.insert.run(clientId, r.seq, r.kind, r.ts, ts, JSON.stringify(r.payload ?? null));
        hw = r.seq; accepted++;
      }
      if (accepted) q.prune.run(clientId, clientId, keepPerClient);
      q.setHw.run(hw, clientId);
      const s = batch.spool;
      if (s?.full === true) q.fullOpen.run(ts, ts, s.dropped ?? 0, s.bytes ?? 0, clientId);
      else if (s?.full === false) q.fullClose.run(clientId);
      return { accepted, duplicates, highWater: hw };
    });
  }

  return {
    ingest,
    highWater: (clientId) => q.hw.get(clientId)?.highWater ?? 0,
    spoolFull: () => q.fullList.all().map((r) => ({ clientId: r.clientId, sinceTs: r.fullSinceTs, lastTs: r.fullLastTs, dropped: r.fullDropped, bytes: r.fullBytes })),
    records: ({ clientId = null, afterSeq = 0, limit = 1000 } = {}) =>
      (clientId ? q.recFor.all(clientId, afterSeq, limit) : q.recAll.all(afterSeq, limit))
        .map((r) => ({ clientId: r.clientId, seq: r.seq, kind: r.kind, ts: r.ts, receivedTs: r.receivedTs, payload: JSON.parse(r.payload) })),
    latestByKind: (kind) => q.latest.all(kind)
      .map((r) => ({ clientId: r.clientId, seq: r.seq, kind: r.kind, ts: r.ts, receivedTs: r.receivedTs, payload: JSON.parse(r.payload) })),
    closeDb: () => db.close(),
  };
}
