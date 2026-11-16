// server/lib/kernel/clients.js
// Clients store (server-and-client-tap build task 1): one row per paired client
// tap in kernel.db, holding only a hash of its token, plus an append-only audit
// log of every pair, rotate, revoke and refused pairing attempt. Routes, the
// access-guard token class and pairing codes are later tasks; this is the store.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_ACTIONS = Object.freeze(['pair', 'pair-refused', 'rotate', 'revoke']);
const NAME_MAX = 100;

// tokenHash is NULL once revoked, so a revoked client can never authenticate
// and the UNIQUE index still allows any number of revoked rows.
const SCHEMA = `CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, tokenHash TEXT, name TEXT NOT NULL, tapVersion TEXT, dataRoots TEXT NOT NULL DEFAULT '[]',
  createdTs INTEGER NOT NULL, lastSeenTs INTEGER, spoolDepth INTEGER NOT NULL DEFAULT 0, revokedTs INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS clients_token ON clients (tokenHash) WHERE tokenHash IS NOT NULL;
CREATE TABLE IF NOT EXISTS client_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, clientId TEXT, action TEXT NOT NULL,
  actor TEXT, source TEXT, meta TEXT);
CREATE INDEX IF NOT EXISTS client_audit_client ON client_audit (clientId, seq);`;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

const rowOut = (r) => (r ? {
  id: r.id, name: r.name, tapVersion: r.tapVersion, dataRoots: JSON.parse(r.dataRoots),
  createdTs: r.createdTs, lastSeenTs: r.lastSeenTs, spoolDepth: r.spoolDepth, revokedTs: r.revokedTs,
  paired: r.tokenHash != null, tools: JSON.parse(r.tools ?? '[]'), projectRoots: JSON.parse(r.projectRoots ?? '[]'),
  certSha256: r.certSha256 ?? null, certNotAfter: r.certNotAfter ?? null,
} : null);
const auditOut = (r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null });

function cleanName(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s || s.length > NAME_MAX) throw new TypeError(`client name must be 1 to ${NAME_MAX} characters`);
  return s;
}
function cleanRoots(roots) {
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string' || !r)) throw new TypeError('dataRoots must be an array of non-empty strings');
  return JSON.stringify(roots);
}
const TAP_VERSION_MAX = 64;
// null or undefined keeps the stored value; anything else must be a short version string.
// Exported so pairing can refuse a bad body before it consumes the one-time code.
export const validTapVersion = (v) => v == null || (typeof v === 'string' && v.length > 0 && v.length <= TAP_VERSION_MAX);
function cleanTapVersion(v) {
  if (!validTapVersion(v)) throw new TypeError(`tapVersion must be a string of 1 to ${TAP_VERSION_MAX} characters`);
  return v;
}
function cleanTools(tools) {
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || !t)) throw new TypeError('tools must be an array of non-empty strings');
  return JSON.stringify(tools);
}
const PROJECT_ROOTS_MAX = 64;
const PROJECT_ROOT_LEN = 1024;
function cleanProjectRoots(roots) {
  if (!Array.isArray(roots) || roots.length > PROJECT_ROOTS_MAX || roots.some((r) => typeof r !== 'string' || !r || r.length > PROJECT_ROOT_LEN)) {
    throw new TypeError(`projectRoots must be an array of at most ${PROJECT_ROOTS_MAX} path strings of 1 to ${PROJECT_ROOT_LEN} characters`);
  }
  return JSON.stringify(roots);
}
function needActor(actor) {
  if (!actor) throw new TypeError('an actor is required for the audit log');
  return String(actor);
}

// Same lazy load as obligations.js: a failed open is a visible error, not an import crash.
function loadSqlite() {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite unavailable on Node ${process.versions.node} (needs 22.13+, or --experimental-sqlite on 22.5 to 22.12)`);
  return mod.DatabaseSync;
}

export function openClientStore({ dbFile, now = Date.now }) {
  const DatabaseSync = loadSqlite();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // A kernel.db created before the tools column existed gets it added in place.
  if (!db.prepare('PRAGMA table_info(clients)').all().some((c) => c.name === 'tools')) {
    db.exec("ALTER TABLE clients ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'");
  }
  if (!db.prepare('PRAGMA table_info(clients)').all().some((c) => c.name === 'projectRoots')) {
    db.exec("ALTER TABLE clients ADD COLUMN projectRoots TEXT NOT NULL DEFAULT '[]'");
  }
  // Card glmps-2-0-152: the client certificate issued at the last pair or rotate.
  if (!db.prepare('PRAGMA table_info(clients)').all().some((c) => c.name === 'certSha256')) {
    db.exec('ALTER TABLE clients ADD COLUMN certSha256 TEXT');
    db.exec('ALTER TABLE clients ADD COLUMN certNotAfter INTEGER');
  }
  const q = {
    get: db.prepare('SELECT * FROM clients WHERE id = ?'),
    byHash: db.prepare('SELECT * FROM clients WHERE tokenHash = ?'),
    insert: db.prepare('INSERT INTO clients (id, tokenHash, name, tapVersion, dataRoots, createdTs) VALUES (?, ?, ?, ?, ?, ?)'),
    repair: db.prepare('UPDATE clients SET tokenHash = ?, name = ?, tapVersion = ?, dataRoots = ?, revokedTs = NULL WHERE id = ?'),
    setHash: db.prepare('UPDATE clients SET tokenHash = ? WHERE id = ?'),
    setCert: db.prepare('UPDATE clients SET certSha256 = ?, certNotAfter = ? WHERE id = ?'),
    revoke: db.prepare('UPDATE clients SET tokenHash = NULL, revokedTs = ?, certSha256 = NULL, certNotAfter = NULL WHERE id = ?'),
    heartbeat: db.prepare('UPDATE clients SET lastSeenTs = ?, spoolDepth = ?, tapVersion = ?, dataRoots = ?, tools = ?, projectRoots = ? WHERE id = ?'),
    list: db.prepare('SELECT * FROM clients ORDER BY createdTs, id'),
    audit: db.prepare('INSERT INTO client_audit (ts, clientId, action, actor, source, meta) VALUES (?, ?, ?, ?, ?, ?)'),
    auditAll: db.prepare('SELECT * FROM client_audit ORDER BY seq DESC LIMIT ?'),
    auditFor: db.prepare('SELECT * FROM client_audit WHERE clientId = ? ORDER BY seq DESC LIMIT ?'),
  };
  const record = (action, clientId, { actor = null, source = null, meta = null } = {}) =>
    q.audit.run(now(), clientId, action, actor, source, meta ? JSON.stringify(meta) : null);
  // Each change and its audit row commit together, so the log never misses a change.
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };

  // issueCert(clientId) -> { certPem, notAfter, fingerprint256 } runs inside the
  // transaction, so a refused key leaves no client paired without a certificate.
  const storeCert = (id, issueCert) => {
    if (typeof issueCert !== 'function') { q.setCert.run(null, null, id); return null; }
    const c = issueCert(id);
    q.setCert.run(c.fingerprint256, c.notAfter, id);
    return c;
  };

  // A pair with clientId re-pairs that client (spec: re-pairing keeps the id).
  function pair({ clientId = null, name, tapVersion = null, dataRoots = [], actor, source = null, issueCert = null }) {
    const n = cleanName(name); const roots = cleanRoots(dataRoots); const who = needActor(actor);
    tapVersion = cleanTapVersion(tapVersion) ?? null;
    const token = newToken();
    return tx(() => {
      let id = clientId;
      if (id) {
        if (!q.get.get(id)) throw new Error(`no client ${id}`);
        q.repair.run(hashToken(token), n, tapVersion, roots, id);
      } else {
        id = `cli_${crypto.randomBytes(8).toString('hex')}`;
        q.insert.run(id, hashToken(token), n, tapVersion, roots, now());
      }
      const certificate = storeCert(id, issueCert);
      record('pair', id, { actor: who, source, meta: clientId ? { repair: true } : null });
      return { clientId: id, token, certificate };
    });
  }

  function rotate(clientId, { actor, source = null, issueCert = null }) {
    const who = needActor(actor);
    const row = q.get.get(clientId);
    if (!row) throw new Error(`no client ${clientId}`);
    if (row.tokenHash == null) throw new Error(`client ${clientId} is revoked; pair it again`);
    const token = newToken();
    const certificate = tx(() => {
      q.setHash.run(hashToken(token), clientId);
      const c = storeCert(clientId, issueCert);
      record('rotate', clientId, { actor: who, source });
      return c;
    });
    return { clientId, token, certificate };
  }

  function revoke(clientId, { actor, source = null, reason = null }) {
    const who = needActor(actor);
    const row = q.get.get(clientId);
    if (!row) throw new Error(`no client ${clientId}`);
    if (row.tokenHash == null) return rowOut(row);
    tx(() => { q.revoke.run(now(), clientId); record('revoke', clientId, { actor: who, source, meta: reason ? { reason } : null }); });
    return rowOut(q.get.get(clientId));
  }

  function authenticate(token) {
    if (typeof token !== 'string' || !token) return null;
    return rowOut(q.byHash.get(hashToken(token)));
  }

  // Omitted fields keep their stored value. A revoked or unknown client gets null.
  function heartbeat(clientId, { spoolDepth, tapVersion, dataRoots, tools, projectRoots } = {}) {
    const row = q.get.get(clientId);
    if (!row || row.tokenHash == null) return null;
    if (spoolDepth !== undefined && !(Number.isInteger(spoolDepth) && spoolDepth >= 0)) throw new TypeError('spoolDepth must be a non-negative integer');
    cleanTapVersion(tapVersion);
    q.heartbeat.run(now(), spoolDepth ?? row.spoolDepth, tapVersion ?? row.tapVersion,
      dataRoots !== undefined ? cleanRoots(dataRoots) : row.dataRoots,
      tools !== undefined ? cleanTools(tools) : row.tools,
      projectRoots !== undefined ? cleanProjectRoots(projectRoots) : row.projectRoots, clientId);
    return rowOut(q.get.get(clientId));
  }

  return {
    pair, rotate, revoke, authenticate, heartbeat,
    recordRefusedPair: ({ source = null, reason = null } = {}) => { record('pair-refused', null, { source, meta: reason ? { reason } : null }); },
    get: (id) => rowOut(q.get.get(id)),
    list: () => q.list.all().map(rowOut),
    audit: ({ clientId = null, limit = 500 } = {}) => (clientId ? q.auditFor.all(clientId, limit) : q.auditAll.all(limit)).map(auditOut),
    closeDb: () => db.close(),
  };
}
