// server/test/tap-mirror-store.test.js
// The mirror store (server-and-client-tap task 10): manifest in kernel.db, JSONL
// append with resume and reset, hash-checked snapshots staged and renamed over
// the mirror file, confinement of every path, and the per-client quota.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clientMirrorDir } from '../lib/kernel/tap-mirror.js';
import { openTapMirror, MIRROR_CHUNK_BYTES, JSON_SNAPSHOT_MAX_BYTES, SQLITE_SNAPSHOT_MAX_BYTES } from '../lib/kernel/tap-mirror-store.js';

let sqliteOk = true;
try { if (!process.getBuiltinModule('node:sqlite')?.DatabaseSync) sqliteOk = false; } catch { sqliteOk = false; }
const SKIP = sqliteOk ? false : 'node:sqlite is unavailable on this Node, so kernel.db cannot open';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const A = 'cli_aaaaaaaaaaaaaaaa';
const B = 'cli_bbbbbbbbbbbbbbbb';
function open(opts = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mirrorstore-')); tmpDirs.push(stateDir);
  const m = openTapMirror({ dbFile: path.join(stateDir, 'kernel.db'), stateDir, ...opts });
  const file = (client, p) => path.join(clientMirrorDir(stateDir, client), ...p.split('/'));
  return { m, stateDir, file };
}
const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const P1 = 'claude/projects/p/s1.jsonl';

test('append: a new file lands at offset 0 and the manifest records its size', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    const r = m.append(A, { path: P1, offset: 0, data: b64('{"a":1}\n') });
    assert.deepEqual([r.status, r.body], [200, { size: 8 }]);
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), '{"a":1}\n');
    assert.deepEqual(m.manifest(A).files[P1], { size: 8, sha256: null });
    assert.equal(m.manifest(A).usedBytes, 8);
  } finally { m.closeDb(); }
});

test('append: resumes from the server size, and a wrong offset is 409 with the size the server holds', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    m.append(A, { path: P1, offset: 0, data: b64('one\n') });
    const ok = m.append(A, { path: P1, offset: 4, data: b64('two\n') });
    assert.deepEqual([ok.status, ok.body], [200, { size: 8 }]);
    for (const offset of [0, 3, 99]) {
      const r = m.append(A, { path: P1, offset, data: b64('x') });
      assert.deepEqual([r.status, r.body], [409, { size: 8 }], `offset ${offset}`);
    }
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), 'one\ntwo\n', 'a refused append writes nothing');
    const fresh = m.append(A, { path: 'claude/projects/p/new.jsonl', offset: 5, data: b64('x') });
    assert.deepEqual([fresh.status, fresh.body], [409, { size: 0 }]);
  } finally { m.closeDb(); }
});

test('append: reset at offset 0 truncates first, and reset at any other offset is 400', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    m.append(A, { path: P1, offset: 0, data: b64('a long first version\n') });
    const r = m.append(A, { path: P1, offset: 0, data: b64('new\n'), reset: true });
    assert.deepEqual([r.status, r.body], [200, { size: 4 }]);
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), 'new\n');
    assert.equal(m.manifest(A).usedBytes, 4);
    assert.equal(m.append(A, { path: P1, offset: 2, data: b64('x'), reset: true }).status, 400);
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), 'new\n');
  } finally { m.closeDb(); }
});

test('append: a file shorter on disk than the manifest says is trusted from the disk, so the client re-sends the gap', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    m.append(A, { path: P1, offset: 0, data: b64('0123456789') });
    fs.truncateSync(file(A, P1), 4);
    const r = m.append(A, { path: P1, offset: 10, data: b64('x') });
    assert.deepEqual([r.status, r.body], [409, { size: 4 }]);
    assert.equal(m.append(A, { path: P1, offset: 4, data: b64('456789') }).status, 200);
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), '0123456789');
  } finally { m.closeDb(); }
});

test('append: a torn tail past the manifest size (crash between write and commit) is overwritten, not appended after', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    m.append(A, { path: P1, offset: 0, data: b64('good\n') });
    fs.appendFileSync(file(A, P1), 'TORN');
    assert.equal(m.append(A, { path: P1, offset: 5, data: b64('next\n') }).status, 200);
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), 'good\nnext\n');
  } finally { m.closeDb(); }
});

test('append: every confinement rule is a 400 and nothing is created', { skip: SKIP }, () => {
  const { m, stateDir } = open();
  try {
    for (const p of ['nope/x.jsonl', 'claude/../x', 'claude/./x', 'claude//x', 'claude\\x', 'claude/C:/x', '/claude/x', '//host/share/x', 'claude/a\0b', 'claude/NUL', 'claude/a.', 'claude/a ']) {
      const r = m.append(A, { path: p, offset: 0, data: b64('x') });
      assert.equal(r.status, 400, JSON.stringify(p));
      assert.match(r.body.error, /refused|must be/);
    }
    assert.equal(fs.existsSync(path.join(stateDir, 'clients', A, 'mirror', 'x')), false);
    assert.deepEqual(m.manifest(A).files, {});
  } finally { m.closeDb(); }
});

test('append: a malformed body is 400', { skip: SKIP }, () => {
  const { m } = open();
  try {
    for (const bad of [{ path: P1, offset: -1, data: '' }, { path: P1, offset: 1.5, data: '' }, { path: P1, offset: '0', data: '' }, { path: P1, offset: 0, data: 5 },
      { path: P1, offset: 0, data: '!!notbase64' }, { path: P1, offset: 0, data: Buffer.alloc(MIRROR_CHUNK_BYTES + 1).toString('base64') }, null, []]) {
      assert.equal(m.append(A, bad).status, 400, JSON.stringify(bad)?.slice(0, 60));
    }
  } finally { m.closeDb(); }
});

test('append: two clients never share a file or a manifest', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    m.append(A, { path: P1, offset: 0, data: b64('from a') });
    m.append(B, { path: P1, offset: 0, data: b64('from b!') });
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), 'from a');
    assert.equal(fs.readFileSync(file(B, P1), 'utf8'), 'from b!');
    assert.equal(m.manifest(A).files[P1].size, 6);
    assert.equal(m.manifest(B).files[P1].size, 7);
  } finally { m.closeDb(); }
});

test('append: a client id that is not a safe name is refused', { skip: SKIP }, () => {
  const { m } = open();
  try { assert.throws(() => m.append('../x', { path: P1, offset: 0, data: '' }), /client id/); } finally { m.closeDb(); }
});

const J = 'claude/.claude-manager/active-sessions.json';
function snap(m, client, p, kind, buf, { chunk = buf.length || 1, from = 0, sha256 = sha(buf), size = buf.length } = {}) {
  let last = null;
  for (let off = from; off < Math.max(buf.length, 1); off += chunk) {
    last = m.snapshot(client, { path: p, kind, sha256, size, offset: off, data: buf.subarray(off, off + chunk).toString('base64') });
    if (last.status !== 200) return last;
  }
  return last;
}

test('snapshot: chunks stage, the last one is checked against size and sha256 and renamed over the mirror file', { skip: SKIP }, () => {
  const { m, file, stateDir } = open();
  try {
    const buf = Buffer.from(JSON.stringify({ rows: Array(50).fill('x') }));
    const mid = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: buf.length, offset: 0, data: buf.subarray(0, 10).toString('base64') });
    assert.deepEqual([mid.status, mid.body], [200, { staged: 10 }]);
    assert.equal(fs.existsSync(file(A, J)), false, 'nothing is visible until the last chunk');
    const last = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: buf.length, offset: 10, data: buf.subarray(10).toString('base64') });
    assert.deepEqual([last.status, last.body], [200, { stored: true, size: buf.length }]);
    assert.deepEqual(fs.readFileSync(file(A, J)), buf);
    assert.deepEqual(m.manifest(A).files[J], { size: buf.length, sha256: sha(buf) });
    assert.deepEqual(fs.existsSync(path.join(stateDir, 'clients', A, 'staging')) ? fs.readdirSync(path.join(stateDir, 'clients', A, 'staging')) : [], [], 'staging is empty');
  } finally { m.closeDb(); }
});

test('snapshot: a hash that equals the manifest answers unchanged and moves nothing', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    const buf = Buffer.from('{"v":1}');
    assert.equal(snap(m, A, J, 'json', buf).status, 200);
    const before = fs.statSync(file(A, J)).mtimeMs;
    const r = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: buf.length, offset: 0, data: buf.toString('base64') });
    assert.deepEqual([r.status, r.body], [200, { unchanged: true }]);
    assert.equal(fs.statSync(file(A, J)).mtimeMs, before);
  } finally { m.closeDb(); }
});

test('snapshot: an unchanged answer is not given when the mirror file is gone from disk', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    const buf = Buffer.from('{"v":1}');
    snap(m, A, J, 'json', buf);
    fs.rmSync(file(A, J));
    const r = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: buf.length, offset: 0, data: buf.toString('base64') });
    assert.deepEqual([r.status, r.body], [200, { stored: true, size: buf.length }]);
  } finally { m.closeDb(); }
});

test('snapshot: a hash or size mismatch on the last chunk is 400, the staging file is dropped and the old file stands', { skip: SKIP }, () => {
  const { m, file, stateDir } = open();
  try {
    const old = Buffer.from('{"old":true}');
    snap(m, A, J, 'json', old);
    const next = Buffer.from('{"new":true}');
    const wrongHash = m.snapshot(A, { path: J, kind: 'json', sha256: sha(Buffer.from('other')), size: next.length, offset: 0, data: next.toString('base64') });
    assert.equal(wrongHash.status, 400);
    assert.match(wrongHash.body.error, /sha256/);
    assert.deepEqual(fs.readFileSync(file(A, J)), old);
    const dir = path.join(stateDir, 'clients', A, 'staging');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
    const short = m.snapshot(A, { path: J, kind: 'json', sha256: sha(next), size: next.length + 5, offset: 0, data: next.toString('base64') });
    assert.equal(short.status, 200, 'still short of the declared size, so it stages');
    assert.deepEqual(short.body, { staged: next.length });
    assert.equal(m.manifest(A).files[J].sha256, sha(old));
  } finally { m.closeDb(); }
});

test('snapshot: an offset that is not the staged size is 409 with the staged size, and offset 0 restarts', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    const buf = Buffer.from('x'.repeat(100));
    m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: 100, offset: 0, data: buf.subarray(0, 30).toString('base64') });
    const bad = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: 100, offset: 50, data: buf.subarray(50).toString('base64') });
    assert.deepEqual([bad.status, bad.body], [409, { staged: 30 }]);
    const restart = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: 100, offset: 0, data: buf.subarray(0, 40).toString('base64') });
    assert.deepEqual(restart.body, { staged: 40 });
    const fin = m.snapshot(A, { path: J, kind: 'json', sha256: sha(buf), size: 100, offset: 40, data: buf.subarray(40).toString('base64') });
    assert.equal(fin.status, 200);
    assert.deepEqual(fs.readFileSync(file(A, J)), buf);
  } finally { m.closeDb(); }
});

test('snapshot: a chunk with no staging and a non-zero offset is 409 with staged 0', { skip: SKIP }, () => {
  const { m } = open();
  try {
    const r = m.snapshot(A, { path: J, kind: 'json', sha256: 'a'.repeat(64), size: 100, offset: 10, data: b64('x') });
    assert.deepEqual([r.status, r.body], [409, { staged: 0 }]);
  } finally { m.closeDb(); }
});

test('snapshot: kind, caps, sha256 shape, confinement and a chunk past the declared size are refused', { skip: SKIP }, () => {
  const { m } = open();
  try {
    const ok = { path: J, kind: 'json', sha256: 'a'.repeat(64), size: 10, offset: 0, data: b64('x') };
    assert.equal(m.snapshot(A, { ...ok, kind: 'append' }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, kind: 'zip' }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, sha256: 'xyz' }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, size: JSON_SNAPSHOT_MAX_BYTES + 1 }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, kind: 'sqlite', size: SQLITE_SNAPSHOT_MAX_BYTES + 1 }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, size: 0 }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, path: 'claude/../x' }).status, 400);
    assert.equal(m.snapshot(A, { ...ok, size: 3, data: b64('xxxx') }).status, 400, 'more bytes than the declared size');
  } finally { m.closeDb(); }
});

test('snapshot: a path that is an append file cannot be snapshotted, and the reverse', { skip: SKIP }, () => {
  const { m } = open();
  try {
    m.append(A, { path: P1, offset: 0, data: b64('x\n') });
    const buf = Buffer.from('{}');
    assert.equal(m.snapshot(A, { path: P1, kind: 'json', sha256: sha(buf), size: 2, offset: 0, data: buf.toString('base64') }).status, 400);
    snap(m, A, J, 'json', buf);
    assert.equal(m.append(A, { path: J, offset: 2, data: b64('x') }).status, 400);
  } finally { m.closeDb(); }
});

test('snapshot: a sqlite file round-trips byte for byte', { skip: SKIP }, () => {
  const { m, file } = open();
  try {
    const buf = crypto.randomBytes(300_000);
    const p = 'agy-cli/conversations/c1.db';
    const r = snap(m, A, p, 'sqlite', buf, { chunk: 100_000 });
    assert.equal(r.status, 200);
    assert.deepEqual(fs.readFileSync(file(A, p)), buf);
    assert.equal(m.manifest(A).files[p].sha256, sha(buf));
  } finally { m.closeDb(); }
});

test('quota: an append past the per-client quota is 507, writes nothing, and opens an episode that a later fitting write closes', { skip: SKIP }, () => {
  let t = 1000;
  const { m, file } = open({ quotaBytes: 20, now: () => t });
  try {
    assert.equal(m.append(A, { path: P1, offset: 0, data: b64('0123456789') }).status, 200);
    t = 2000;
    const over = m.append(A, { path: P1, offset: 10, data: b64('0123456789ABC') });
    assert.equal(over.status, 507);
    assert.deepEqual([over.body.usedBytes, over.body.quotaBytes], [10, 20]);
    assert.equal(fs.readFileSync(file(A, P1), 'utf8'), '0123456789');
    t = 3000;
    assert.equal(m.append(A, { path: P1, offset: 10, data: b64('ABCDEFGHIJK') }).status, 507);
    assert.deepEqual(m.quotaExceeded().map((e) => [e.clientId, e.sinceTs, e.lastTs, e.usedBytes, e.quotaBytes]), [[A, 2000, 3000, 10, 20]]);
    assert.equal(m.append(A, { path: P1, offset: 10, data: b64('ok') }).status, 200);
    assert.deepEqual(m.quotaExceeded(), []);
  } finally { m.closeDb(); }
});

test('quota: a snapshot that would pass the quota is 507 at its first chunk, and a replacement is charged only its growth', { skip: SKIP }, () => {
  const { m } = open({ quotaBytes: 100 });
  try {
    const small = Buffer.from('{"a":"' + 'x'.repeat(40) + '"}');
    assert.equal(snap(m, A, J, 'json', small).status, 200);
    const big = Buffer.from('{"a":"' + 'y'.repeat(120) + '"}');
    assert.equal(m.snapshot(A, { path: J, kind: 'json', sha256: sha(big), size: big.length, offset: 0, data: big.subarray(0, 10).toString('base64') }).status, 507);
    const same = Buffer.from('{"a":"' + 'z'.repeat(40) + '"}');
    assert.equal(snap(m, A, J, 'json', same).status, 200, 'same size replaces without growth');
  } finally { m.closeDb(); }
});

test('manifest survives a reopen, and the default quota is 20 GiB', { skip: SKIP }, () => {
  const { m, stateDir } = open();
  m.append(A, { path: P1, offset: 0, data: b64('abc') });
  assert.equal(m.manifest(A).quotaBytes, 20 * 1024 ** 3);
  m.closeDb();
  const again = openTapMirror({ dbFile: path.join(stateDir, 'kernel.db'), stateDir });
  try { assert.deepEqual(again.manifest(A).files[P1], { size: 3, sha256: null }); } finally { again.closeDb(); }
});

test('a symlink planted inside the mirror cannot carry an append out of it', { skip: SKIP }, (t) => {
  const { m, stateDir } = open();
  try {
    const dir = path.join(stateDir, 'clients', A, 'mirror', 'claude', 'projects');
    fs.mkdirSync(dir, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mirrorout-')); tmpDirs.push(outside);
    try { fs.symlinkSync(outside, path.join(dir, 'link'), 'junction'); } catch (e) { t.skip(`cannot create a symlink or junction here: ${e.code}`); return; }
    const r = m.append(A, { path: 'claude/projects/link/x.jsonl', offset: 0, data: b64('x') });
    assert.equal(r.status, 400);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { m.closeDb(); }
});
