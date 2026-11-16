// server/lib/kernel/obligations.js
// Obligations core (upgrade item 26, D7's three imports): a promise the system
// made, with a due time and exactly three ways to close it. A missed due time
// becomes an expiry event and climbs an escalation ladder; it is never silence.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { emitSpineEvent, SPINE_KINDS } from '../observability/spine.js';

export const CLOSERS = Object.freeze(['verified.done', 'decision.deferred', 'decision.cancelled']);
export const ESCALATION_LADDER = Object.freeze(['alert', 'slack', 'slack-mention']);
// The opener registry. A kind with no closer fails the CI test.
export const OBLIGATION_KINDS = Object.freeze({
  'loop.freshness': { defaultDueMs: 24 * 3_600_000, closers: ['verified.done', 'decision.deferred', 'decision.cancelled'], escalates: true },
  'gate.independent-verdict': { defaultDueMs: 24 * 3_600_000, closers: ['verified.done', 'decision.deferred', 'decision.cancelled'], escalates: true },
  'wiki.reflects-head': { defaultDueMs: 36 * 3_600_000, closers: ['verified.done', 'decision.cancelled'], escalates: true },
});

const SCHEMA = `CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, openedBy TEXT NOT NULL, openedTs INTEGER NOT NULL,
  dueTs INTEGER NOT NULL, closedBy TEXT, closedTs INTEGER, closer TEXT, verifierRef TEXT,
  escalationLevel INTEGER NOT NULL DEFAULT -1, expiredTs INTEGER, meta TEXT);
CREATE INDEX IF NOT EXISTS obligations_open ON obligations (closedTs, dueTs);
CREATE UNIQUE INDEX IF NOT EXISTS obligations_one_open ON obligations (kind, subject) WHERE closedTs IS NULL;`;

const rowOut = (r) => (r ? { ...r, meta: r.meta ? JSON.parse(r.meta) : null } : null);

// node:sqlite is unflagged from Node 22.13; the floor is 22.5 (D22), where it
// needs --experimental-sqlite. Load it lazily so server.js still imports on an
// older 22.x and the store failing to open is a visible loop failure, not a crash.
function loadSqlite() {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite unavailable on Node ${process.versions.node} (needs 22.13+, or --experimental-sqlite on 22.5 to 22.12)`);
  return mod.DatabaseSync;
}

export function openObligationStore({ dbFile, stateDir = null, now = Date.now, emit = emitSpineEvent }) {
  const DatabaseSync = loadSqlite();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const q = {
    get: db.prepare('SELECT * FROM obligations WHERE id = ?'),
    findOpen: db.prepare('SELECT * FROM obligations WHERE kind = ? AND subject = ? AND closedTs IS NULL'),
    insert: db.prepare('INSERT INTO obligations (id, kind, subject, openedBy, openedTs, dueTs, meta) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    close: db.prepare('UPDATE obligations SET closedBy = ?, closedTs = ?, closer = ?, verifierRef = ? WHERE id = ? AND closedTs IS NULL'),
    listOpen: db.prepare('SELECT * FROM obligations WHERE closedTs IS NULL ORDER BY dueTs'),
    listAll: db.prepare('SELECT * FROM obligations ORDER BY openedTs DESC LIMIT ?'),
    countOpen: db.prepare('SELECT COUNT(*) AS n FROM obligations WHERE closedTs IS NULL'),
    due: db.prepare('SELECT * FROM obligations WHERE closedTs IS NULL AND escalationLevel = -1 AND dueTs <= ?'),
    expire: db.prepare('UPDATE obligations SET escalationLevel = 0, expiredTs = ? WHERE id = ?'),
    level: db.prepare('UPDATE obligations SET escalationLevel = ? WHERE id = ?'),
    meta: db.prepare('UPDATE obligations SET meta = ? WHERE id = ?'),
    rebase: db.prepare('UPDATE obligations SET dueTs = ?, meta = ? WHERE id = ? AND closedTs IS NULL AND escalationLevel = -1'),
  };
  const say = (kind, row, extra = {}) => emit(stateDir, { kind, actor: 'kernel', label: `${kind} ${row.kind} ${row.subject}`, payload: { id: row.id, kind: row.kind, subject: row.subject, ...extra } });

  function open({ kind, subject, openedBy, dueTs, meta = null }) {
    if (!OBLIGATION_KINDS[kind]) throw new TypeError(`unknown obligation kind: ${kind}`);
    const existing = q.findOpen.get(kind, String(subject));
    if (existing) return { id: existing.id, created: false };
    const id = `obl_${crypto.randomUUID()}`;
    const due = dueTs ?? now() + OBLIGATION_KINDS[kind].defaultDueMs;
    q.insert.run(id, kind, String(subject), String(openedBy), now(), due, meta ? JSON.stringify(meta) : null);
    say(SPINE_KINDS.OBLIGATION_OPENED, rowOut(q.get.get(id)), { dueTs: due, openedBy });
    return { id, created: true };
  }

  function close(id, { closer, closedBy, verifierRef = null }) {
    if (!CLOSERS.includes(closer)) throw new TypeError(`closer must be one of ${CLOSERS.join(', ')}: ${closer}`);
    const row = rowOut(q.get.get(id));
    if (!row) throw new Error(`no obligation ${id}`);
    if (row.closedTs != null) return row;
    if (!OBLIGATION_KINDS[row.kind].closers.includes(closer)) throw new TypeError(`${row.kind} cannot be closed by ${closer}`);
    if (closer === 'verified.done') {
      if (!verifierRef) throw new TypeError('verified.done requires a verifierRef');
      if (String(closedBy) === row.openedBy) throw new TypeError('verified.done must come from a different actor than the opener');
    }
    q.close.run(String(closedBy), now(), closer, verifierRef, id);
    const out = rowOut(q.get.get(id));
    say(SPINE_KINDS.OBLIGATION_CLOSED, out, { closer, closedBy, verifierRef });
    return out;
  }

  function expireDue() {
    const t = now(); const rows = q.due.all(t);
    for (const r of rows) { q.expire.run(t, r.id); say(SPINE_KINDS.OBLIGATION_EXPIRED, rowOut(r), { dueTs: r.dueTs }); }
    return rows.map((r) => rowOut(q.get.get(r.id)));
  }

  function escalate(id) {
    const row = rowOut(q.get.get(id));
    if (!row || row.closedTs != null || row.escalationLevel < 0) return row;
    const next = Math.min(row.escalationLevel + 1, ESCALATION_LADDER.length - 1);
    if (next === row.escalationLevel) return row;
    q.level.run(next, id);
    const out = rowOut(q.get.get(id));
    say(SPINE_KINDS.OBLIGATION_ESCALATED, out, { level: next, step: ESCALATION_LADDER[next] });
    return out;
  }

  // Phase K final review I2: move an open, not-yet-expired row's due time
  // (a loop.freshness row re-registered after downtime). An expired row is
  // never re-based: a real miss stays a miss. The original due time is kept
  // in meta for the record. Returns the fresh row, or null when nothing
  // changed (closed, expired or unknown).
  function rebaseDue(id, dueTs) {
    const row = rowOut(q.get.get(id));
    if (!row || row.closedTs != null || row.escalationLevel !== -1) return null;
    const meta = { ...(row.meta || {}), rebasedFromDueTs: row.meta?.rebasedFromDueTs ?? row.dueTs, rebasedTs: now() };
    q.rebase.run(dueTs, JSON.stringify(meta), id);
    return rowOut(q.get.get(id));
  }

  return {
    open, close, expireDue, escalate, rebaseDue,
    get: (id) => rowOut(q.get.get(id)),
    findOpen: ({ kind, subject }) => rowOut(q.findOpen.get(kind, String(subject))),
    listOpen: () => q.listOpen.all().map(rowOut),
    listAll: (limit = 500) => q.listAll.all(limit).map(rowOut),
    countOpen: () => q.countOpen.get().n,
    setMeta: (id, meta) => { q.meta.run(meta ? JSON.stringify(meta) : null, id); return rowOut(q.get.get(id)); },
    closeDb: () => db.close(),
  };
}
