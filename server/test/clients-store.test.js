// server/test/clients-store.test.js
// Server-and-client-tap build task 1: the clients store in kernel.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openClientStore, AUDIT_ACTIONS } from '../lib/kernel/clients.js';
import { openObligationStore } from '../lib/kernel/obligations.js';

function store(t = { v: 1000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clients-'));
  const dbFile = path.join(dir, 'kernel.db');
  return { s: openClientStore({ dbFile, now: () => t.v }), t, dir, dbFile };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('pair mints a client id and a 32-byte token, and stores only its hash', () => {
  const { s, dbFile } = store();
  const { clientId, token } = s.pair({ name: 'laptop', tapVersion: '0.1.0', dataRoots: ['C:/Users/a/.claude'], actor: 'pairing-code', source: '100.64.0.2' });
  assert.match(clientId, /^cli_[0-9a-f]{16}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const c = s.get(clientId);
  assert.deepEqual(c, { id: clientId, name: 'laptop', tapVersion: '0.1.0', dataRoots: ['C:/Users/a/.claude'], createdTs: 1000, lastSeenTs: null, spoolDepth: 0, revokedTs: null, paired: true, tools: [], projectRoots: [], certSha256: null, certNotAfter: null });
  assert.equal(Object.keys(c).some((k) => /hash|token/i.test(k)), false, 'no hash or token leaves the store');
  s.closeDb();
  const raw = fs.readFileSync(dbFile);
  assert.equal(raw.includes(Buffer.from(token)), false, 'the plaintext token is never written');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(dbFile);
  assert.equal(db.prepare('SELECT tokenHash FROM clients WHERE id = ?').get(clientId).tokenHash, sha256(token));
  db.close();
});

test('authenticate resolves a live token to its client and refuses anything else', () => {
  const { s } = store();
  const { clientId, token } = s.pair({ name: 'a', actor: 'op' });
  assert.equal(s.authenticate(token).id, clientId);
  assert.equal(s.authenticate('nope'), null);
  assert.equal(s.authenticate(''), null);
  assert.equal(s.authenticate(undefined), null);
  s.closeDb();
});

test('rotate swaps the token without re-pairing: old refused, new accepted, id kept', () => {
  const { s, t } = store();
  const { clientId, token } = s.pair({ name: 'a', actor: 'op' });
  t.v = 2000;
  const r = s.rotate(clientId, { actor: 'op' });
  assert.notEqual(r.token, token);
  assert.equal(s.authenticate(token), null);
  assert.equal(s.authenticate(r.token).id, clientId);
  assert.throws(() => s.rotate('cli_missing', { actor: 'op' }), /no client/);
  s.closeDb();
});

test('revoke deletes the hash so the next request is refused, and cannot be rotated back', () => {
  const { s, t } = store();
  const { clientId, token } = s.pair({ name: 'a', actor: 'op' });
  t.v = 3000;
  const c = s.revoke(clientId, { actor: 'op', reason: 'lost laptop' });
  assert.equal(c.paired, false); assert.equal(c.revokedTs, 3000);
  assert.equal(s.authenticate(token), null);
  assert.throws(() => s.rotate(clientId, { actor: 'op' }), /revoked/);
  assert.equal(s.revoke(clientId, { actor: 'op' }).revokedTs, 3000, 'a second revoke is a no-op');
  assert.equal(s.audit({ clientId }).filter((a) => a.action === 'revoke').length, 1);
  s.closeDb();
});

test('re-pairing a revoked client keeps its id and issues a fresh token', () => {
  const { s, t } = store();
  const first = s.pair({ name: 'a', actor: 'op' });
  s.revoke(first.clientId, { actor: 'op' });
  t.v = 4000;
  const again = s.pair({ clientId: first.clientId, name: 'a2', tapVersion: '0.2.0', actor: 'op' });
  assert.equal(again.clientId, first.clientId);
  assert.equal(s.authenticate(first.token), null);
  assert.equal(s.authenticate(again.token).id, first.clientId);
  const c = s.get(first.clientId);
  assert.equal(c.paired, true); assert.equal(c.revokedTs, null); assert.equal(c.name, 'a2'); assert.equal(c.createdTs, 1000);
  assert.equal(s.list().length, 1);
  assert.throws(() => s.pair({ clientId: 'cli_unknown0000000', name: 'x', actor: 'op' }), /no client/);
  s.closeDb();
});

test('every pair, rotate, revoke and refused pairing attempt lands in the audit log', () => {
  const { s, t } = store();
  const { clientId } = s.pair({ name: 'a', actor: 'op', source: '100.64.0.2' });
  t.v = 1100; s.rotate(clientId, { actor: 'op' });
  t.v = 1200; s.recordRefusedPair({ source: '100.64.0.9', reason: 'bad code' });
  t.v = 1300; s.revoke(clientId, { actor: 'op' });
  const all = s.audit();
  assert.deepEqual(all.map((a) => a.action), ['revoke', 'pair-refused', 'rotate', 'pair']);
  assert.deepEqual(all.map((a) => a.ts), [1300, 1200, 1100, 1000]);
  assert.equal(all[3].source, '100.64.0.2'); assert.equal(all[3].actor, 'op');
  assert.equal(all[1].clientId, null); assert.deepEqual(all[1].meta, { reason: 'bad code' });
  assert.deepEqual(s.audit({ clientId }).map((a) => a.action), ['revoke', 'rotate', 'pair']);
  assert.deepEqual([...AUDIT_ACTIONS].sort(), ['pair', 'pair-refused', 'revoke', 'rotate']);
  assert.equal(JSON.stringify(all).includes('tokenHash'), false);
  s.closeDb();
});

test('heartbeat updates last seen, spool depth, tap version and data roots for a paired client only', () => {
  const { s, t } = store();
  const { clientId } = s.pair({ name: 'a', tapVersion: '0.1.0', dataRoots: ['C:/a'], actor: 'op' });
  t.v = 5000;
  const c = s.heartbeat(clientId, { spoolDepth: 42, tapVersion: '0.1.1' });
  assert.equal(c.lastSeenTs, 5000); assert.equal(c.spoolDepth, 42); assert.equal(c.tapVersion, '0.1.1');
  assert.deepEqual(c.dataRoots, ['C:/a'], 'omitted fields keep their value');
  assert.deepEqual(s.heartbeat(clientId, { dataRoots: ['C:/a', 'D:/b'] }).dataRoots, ['C:/a', 'D:/b']);
  s.revoke(clientId, { actor: 'op' });
  assert.equal(s.heartbeat(clientId, { spoolDepth: 1 }), null);
  assert.equal(s.heartbeat('cli_missing', {}), null);
  s.closeDb();
});

test('heartbeat stores the detected tools, keeps them when omitted and refuses a non-array', () => {
  const { s } = store();
  const { clientId } = s.pair({ name: 'a', actor: 'op' });
  assert.deepEqual(s.heartbeat(clientId, { tools: ['cursor', 'zed'] }).tools, ['cursor', 'zed']);
  assert.deepEqual(s.heartbeat(clientId, { spoolDepth: 1 }).tools, ['cursor', 'zed'], 'omitted tools keep their value');
  assert.deepEqual(s.heartbeat(clientId, { tools: [] }).tools, []);
  assert.throws(() => s.heartbeat(clientId, { tools: 'cursor' }), /tools/);
  assert.throws(() => s.heartbeat(clientId, { tools: [1] }), /tools/);
  s.closeDb();
});

test('opening a kernel.db made before the tools column existed migrates it in place and keeps its rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clients-mig-'));
  const dbFile = path.join(dir, 'kernel.db');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(dbFile);
  old.exec(`CREATE TABLE clients (
    id TEXT PRIMARY KEY, tokenHash TEXT, name TEXT NOT NULL, tapVersion TEXT, dataRoots TEXT NOT NULL DEFAULT '[]',
    createdTs INTEGER NOT NULL, lastSeenTs INTEGER, spoolDepth INTEGER NOT NULL DEFAULT 0, revokedTs INTEGER);
    INSERT INTO clients (id, tokenHash, name, createdTs) VALUES ('cli_old', 'h', 'legacy', 7);`);
  old.close();
  const s = openClientStore({ dbFile, now: () => 9 });
  assert.deepEqual(s.get('cli_old').tools, []);
  assert.equal(s.get('cli_old').name, 'legacy');
  assert.deepEqual(s.heartbeat('cli_old', { tools: ['aider'] }).tools, ['aider']);
  s.closeDb();
  openClientStore({ dbFile }).closeDb();
});

test('heartbeat stores projectRoots, keeps them when omitted and refuses a bad list', () => {
  const { s } = store();
  const { clientId } = s.pair({ name: 'a', actor: 'op' });
  assert.deepEqual(s.get(clientId).projectRoots, []);
  assert.deepEqual(s.heartbeat(clientId, { projectRoots: ['C:/Work', '/home/u/p'] }).projectRoots, ['C:/Work', '/home/u/p']);
  assert.deepEqual(s.heartbeat(clientId, { spoolDepth: 1 }).projectRoots, ['C:/Work', '/home/u/p']);
  assert.throws(() => s.heartbeat(clientId, { projectRoots: 'C:/Work' }), /projectRoots/);
  assert.throws(() => s.heartbeat(clientId, { projectRoots: [1] }), /projectRoots/);
  assert.throws(() => s.heartbeat(clientId, { projectRoots: [''] }), /projectRoots/);
  assert.throws(() => s.heartbeat(clientId, { projectRoots: ['x'.repeat(1025)] }), /projectRoots/);
  assert.throws(() => s.heartbeat(clientId, { projectRoots: Array(65).fill('/a') }), /projectRoots/);
  s.closeDb();
});

test('a kernel.db made before the projectRoots column existed migrates in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clients-mig2-'));
  const dbFile = path.join(dir, 'kernel.db');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(dbFile);
  old.exec(`CREATE TABLE clients (
    id TEXT PRIMARY KEY, tokenHash TEXT, name TEXT NOT NULL, tapVersion TEXT, dataRoots TEXT NOT NULL DEFAULT '[]',
    createdTs INTEGER NOT NULL, lastSeenTs INTEGER, spoolDepth INTEGER NOT NULL DEFAULT 0, revokedTs INTEGER, tools TEXT NOT NULL DEFAULT '[]');
    INSERT INTO clients (id, tokenHash, name, createdTs) VALUES ('cli_old', 'h', 'legacy', 7);`);
  old.close();
  const s = openClientStore({ dbFile, now: () => 9 });
  assert.deepEqual(s.get('cli_old').projectRoots, []);
  assert.deepEqual(s.heartbeat('cli_old', { projectRoots: ['/a'] }).projectRoots, ['/a']);
  s.closeDb();
  openClientStore({ dbFile }).closeDb();
});

test('input validation refuses a blank name, a non-string data root and a negative spool depth', () => {
  const { s } = store();
  assert.throws(() => s.pair({ name: '  ', actor: 'op' }), /name/);
  assert.throws(() => s.pair({ name: 'x'.repeat(101), actor: 'op' }), /name/);
  assert.throws(() => s.pair({ name: 'a', dataRoots: [1], actor: 'op' }), /dataRoots/);
  assert.throws(() => s.pair({ name: 'a', dataRoots: 'C:/a', actor: 'op' }), /dataRoots/);
  assert.throws(() => s.pair({ name: 'a' }), /actor/);
  const { clientId } = s.pair({ name: ' a ', actor: 'op' });
  assert.equal(s.get(clientId).name, 'a');
  assert.throws(() => s.heartbeat(clientId, { spoolDepth: -1 }), /spoolDepth/);
  s.closeDb();
});

test('shares kernel.db with the obligations store and survives a reopen', () => {
  const { s, dbFile } = store();
  const obl = openObligationStore({ dbFile, now: () => 1, emit: () => {} });
  obl.open({ kind: 'loop.freshness', subject: 'x', openedBy: 'kernel', dueTs: 10 });
  const { clientId, token } = s.pair({ name: 'a', actor: 'op' });
  s.closeDb(); obl.closeDb();
  const again = openClientStore({ dbFile, now: () => 1 });
  assert.equal(again.authenticate(token).id, clientId);
  assert.equal(again.audit().length, 1);
  again.closeDb();
  const obl2 = openObligationStore({ dbFile, now: () => 1, emit: () => {} });
  assert.equal(obl2.countOpen(), 1);
  obl2.closeDb();
});

test('tapVersion must be a short non-empty string on pair and heartbeat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clients-tapver-'));
  const store = openClientStore({ dbFile: path.join(dir, 'kernel.db') });
  try {
    for (const tapVersion of [7, true, '', 'x'.repeat(65)]) {
      assert.throws(() => store.pair({ name: 'n', tapVersion, actor: 'test' }), /tapVersion/, JSON.stringify(tapVersion));
    }
    const { clientId } = store.pair({ name: 'n', tapVersion: '0.1.0', actor: 'test' });
    assert.throws(() => store.heartbeat(clientId, { tapVersion: 5 }), /tapVersion/);
    assert.equal(store.heartbeat(clientId, { tapVersion: '0.2.0' }).tapVersion, '0.2.0');
    assert.equal(store.heartbeat(clientId, {}).tapVersion, '0.2.0');
  } finally { store.closeDb?.(); }
});

// Card glmps-2-0-152: each pairing and rotation records the client certificate
// it issued, so the guard can match certificate to token and a rotation ends
// the old certificate with the old token.
test('pair and rotate store the issued certificate fingerprint and expiry; revoke clears them', () => {
  const { s } = store();
  const issued = [];
  const issueCert = (id) => { const c = { fingerprint256: `${'a'.repeat(63)}${issued.length}`, notAfter: 5000 + issued.length, certPem: `PEM-${id}` }; issued.push(id); return c; };
  const { clientId, certificate } = s.pair({ name: 'a', actor: 'op', issueCert });
  assert.equal(certificate.certPem, `PEM-${clientId}`);
  assert.deepEqual(issued, [clientId], 'the certificate names the id the store assigned');
  assert.equal(s.get(clientId).certSha256, `${'a'.repeat(63)}0`);
  assert.equal(s.get(clientId).certNotAfter, 5000);
  const r = s.rotate(clientId, { actor: 'op', issueCert });
  assert.equal(r.certificate.notAfter, 5001);
  assert.equal(s.get(clientId).certSha256, `${'a'.repeat(63)}1`);
  s.revoke(clientId, { actor: 'op' });
  assert.equal(s.get(clientId).certSha256, null);
  assert.equal(s.get(clientId).certNotAfter, null);
});

test('a pair without an issuer stores no certificate, and an issuer failure leaves no half-paired client', () => {
  const { s } = store();
  const { clientId, certificate } = s.pair({ name: 'a', actor: 'op' });
  assert.equal(certificate, null);
  assert.equal(s.get(clientId).certSha256, null);
  const before = s.list().length;
  assert.throws(() => s.pair({ name: 'b', actor: 'op', issueCert: () => { throw new TypeError('bad key'); } }), /bad key/);
  assert.equal(s.list().length, before);
});
