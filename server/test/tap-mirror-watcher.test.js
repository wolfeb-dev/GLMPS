// Routes under test: server/lib/routes/tap-routes.js
// server/test/tap-mirror-watcher.test.js
// The tap's mirror watcher (server-and-client-tap task 10) against a fake server
// that answers with the real mirror store: candidates, append resume and reset,
// hash-gated snapshots, the caps, pacing, and the failure ladder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMirrorWatcher, listCandidates, dataRootIds, MIRROR_RATE_BYTES } from '../../taps/tap-mirror.js';
import { BACKOFF_MIN_MS } from '../../taps/tap-shipper.js';
import { getPaths } from '../lib/paths.js';
import { adapters } from '../lib/adapters/index.js';
import { openTapMirror, MIRROR_CHUNK_BYTES, JSON_SNAPSHOT_MAX_BYTES } from '../lib/kernel/tap-mirror-store.js';
import { clientMirrorDir } from '../lib/kernel/tap-mirror.js';
import { TAP_PROTOCOL_HEADER } from '../lib/kernel/tap-protocol.js';
import { TAP_INGEST_MAX_BYTES } from '../lib/kernel/tap-ingest.js';

let sqlite = null;
try { sqlite = process.getBuiltinModule('node:sqlite'); } catch { sqlite = null; }
const SKIP = sqlite?.DatabaseSync ? false : 'node:sqlite is unavailable on this Node, so neither kernel.db nor a SQLite snapshot can run';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mk = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mc-mirrorw-${tag}-`)); tmpDirs.push(d); return d; };
const CID = 'cli_0123456789abcdef';
const CREDS = { config: { server: 'http://100.64.0.1:8123' }, token: 'tok' };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function clientHome() {
  const base = mk('client');
  const env = { GLMPS_CLAUDE_DIR: path.join(base, 'claude'), GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode'), GLMPS_AGY_CLI_DIR: path.join(base, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(base, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot-cli'), GLMPS_HERMES_DIR: path.join(base, 'hermes'), GLMPS_OPENCODE_DIR: path.join(base, 'opencode') };
  return { base, P: getPaths(env), tmpDir: path.join(base, 'tap', 'mirror-tmp') };
}
const write = (file, text, mtimeSec) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeSec) fs.utimesSync(file, mtimeSec, mtimeSec);
};

// A fake server whose answers are the real store's, so the watcher and the
// server agree by construction. `mode` forces a status for every request.
function fakeServer() {
  const stateDir = mk('server');
  const store = openTapMirror({ dbFile: path.join(stateDir, 'kernel.db'), stateDir, quotaBytes: 1024 ** 3 });
  const f = { store, stateDir, log: [], mode: null, file: (p) => path.join(clientMirrorDir(stateDir, CID), ...p.split('/')) };
  f.fetch = async (url, init) => {
    const u = new URL(url);
    f.log.push({ method: init.method ?? 'GET', path: u.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (f.mode === 'down') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (typeof f.mode === 'number') return { status: f.mode, json: async () => ({}) };
    if (u.pathname === '/api/tap/mirror') return { status: 200, json: async () => store.manifest(CID) };
    const body = JSON.parse(init.body);
    const out = u.pathname.endsWith('/append') ? store.append(CID, body) : store.snapshot(CID, body);
    return { status: out.status, json: async () => out.body };
  };
  f.posts = () => f.log.filter((r) => r.method === 'POST');
  return f;
}
function watcher(c, f, extra = {}) {
  const clock = { t: 1_000_000, slept: 0 };
  const w = createMirrorWatcher({ getCreds: () => CREDS, getPaths: () => c.P, tmpDir: c.tmpDir, fetch: (u, i) => f.fetch(u, i), log: () => {}, now: () => clock.t,
    sleep: async (ms) => { clock.slept += ms; clock.t += ms; }, ...extra });
  return { w, clock };
}
const L = 'claude/projects/p/s1.jsonl';

test('listCandidates: Claude transcripts and the registry only, never credentials or settings', () => {
  const c = clientHome();
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), 'a\n');
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1', 'subagents', 'agent-x.jsonl'), 'b\n');
  write(path.join(c.P.claudeDir, 'projects', 'p', 'notes.txt'), 'not a transcript');
  write(path.join(c.P.claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  write(path.join(c.P.claudeDir, '.credentials.json'), '{"secret":1}');
  write(path.join(c.P.claudeDir, 'settings.json'), '{}');
  write(path.join(c.P.claudeDir, 'plugins', 'cache', 'x.jsonl'), 'c\n');
  const { candidates } = listCandidates(c.P, adapters);
  const byPath = Object.fromEntries(candidates.map((x) => [x.path, x.kind]));
  assert.deepEqual(byPath, { [L]: 'append', 'claude/projects/p/s1/subagents/agent-x.jsonl': 'append', 'claude/.claude-manager/active-sessions.json': 'json' });
});

test('listCandidates: every non-Claude adapter file maps to its root and kind, and a file outside the roots is skipped and counted', () => {
  const c = clientHome();
  write(path.join(c.P.codexDir, 'sessions', '2026', 'rollout-2026-10-26T10-00-00-a.jsonl'), '{}\n');
  write(path.join(c.P.agyCliDir, 'conversations', 'c1.db'), 'x');
  write(path.join(c.P.geminiTmpDir, 'hash1', 'chats', 'session-1.json'), '{}');
  write(path.join(c.P.antigravityDirs[0], 'brain', 'u1', '.system_generated', 'logs', 'transcript.jsonl'), '{}\n');
  const outside = path.join(mk('outside'), 'elsewhere.jsonl');
  write(outside, 'x\n');
  const fake = { id: 'fake', discover: () => [{ kind: 'jsonl-tail', file: outside }, { kind: 'pb-only', file: null }] };
  const { candidates, skippedOutsideRoots } = listCandidates(c.P, [...adapters, fake]);
  const byPath = Object.fromEntries(candidates.map((x) => [x.path, x.kind]));
  assert.equal(byPath['codex/sessions/2026/rollout-2026-10-26T10-00-00-a.jsonl'], 'append');
  assert.equal(byPath['agy-cli/conversations/c1.db'], 'sqlite');
  assert.equal(byPath['antigravity-0/brain/u1/.system_generated/logs/transcript.jsonl'], 'append');
  assert.equal(skippedOutsideRoots, 1);
  assert.ok(!Object.keys(byPath).some((p) => p.includes('elsewhere')));
});

test('listCandidates: a name the server would refuse is skipped and counted, not sent', () => {
  const c = clientHome();
  write(path.join(c.P.claudeDir, 'projects', 'p', 'NUL.jsonl'), 'x\n');
  write(path.join(c.P.claudeDir, 'projects', 'p', 'ok.jsonl'), 'x\n');
  const r = listCandidates(c.P, adapters);
  assert.deepEqual(r.candidates.map((x) => x.path), ['claude/projects/p/ok.jsonl']);
  assert.equal(r.skippedRefused, 1);
});

test('dataRootIds names the roots whose directory exists', () => {
  const c = clientHome();
  fs.mkdirSync(c.P.claudeDir, { recursive: true });
  fs.mkdirSync(c.P.codexDir, { recursive: true });
  assert.deepEqual(dataRootIds(c.P), ['claude', 'codex']);
});

test('append: a new file ships whole in chunks that fit the 1 MiB body cap and the server copy is byte-identical', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const big = crypto.randomBytes(MIRROR_CHUNK_BYTES * 2 + 1234);
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), big);
  const { w } = watcher(c, f);
  const r = await w.tick();
  assert.equal(r.shipped, true);
  assert.deepEqual(fs.readFileSync(f.file(L)), big);
  const appends = f.posts().filter((p) => p.path.endsWith('/append'));
  assert.deepEqual(appends.map((p) => p.body.offset), [0, MIRROR_CHUNK_BYTES, MIRROR_CHUNK_BYTES * 2]);
  assert.ok(appends.every((p) => Buffer.from(p.body.data, 'base64').length <= MIRROR_CHUNK_BYTES));
  assert.ok(appends.every((p) => JSON.stringify(p.body).length < TAP_INGEST_MAX_BYTES), 'every request body fits the route cap');
  assert.equal(f.posts()[0].headers[TAP_PROTOCOL_HEADER], '1');
  assert.equal(f.posts()[0].headers.authorization, 'Bearer tok');
  assert.equal(JSON.stringify(f.posts()).includes(CID), false, 'the client id is never in a request');
});

test('append: a later pass sends only the new bytes, and an unchanged file sends nothing', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const file = path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl');
  write(file, 'one\n');
  const { w } = watcher(c, f);
  await w.tick();
  const before = f.posts().length;
  await w.tick();
  assert.equal(f.posts().length, before, 'nothing changed, nothing sent');
  fs.appendFileSync(file, 'two\n');
  await w.tick();
  const last = f.posts().at(-1);
  assert.equal(last.body.offset, 4);
  assert.equal(Buffer.from(last.body.data, 'base64').toString(), 'two\n');
  assert.equal(fs.readFileSync(f.file(L), 'utf8'), 'one\ntwo\n');
});

test('append: a fresh watcher resumes from the size the server holds, not from zero', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const file = path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl');
  write(file, '0123456789');
  f.store.append(CID, { path: L, offset: 0, data: Buffer.from('01234').toString('base64') });
  const { w } = watcher(c, f);
  await w.tick();
  assert.equal(f.posts()[0].body.offset, 5);
  assert.equal(fs.readFileSync(f.file(L), 'utf8'), '0123456789');
});

test('append: a local file smaller than the server copy is re-sent whole with reset', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const file = path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl');
  f.store.append(CID, { path: L, offset: 0, data: Buffer.from('a much longer old transcript\n').toString('base64') });
  write(file, 'new\n');
  const { w } = watcher(c, f);
  await w.tick();
  assert.equal(f.posts()[0].body.reset, true);
  assert.equal(f.posts()[0].body.offset, 0);
  assert.equal(fs.readFileSync(f.file(L), 'utf8'), 'new\n');
});

test('append: a 409 adopts the server size and the pass continues from there', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const file = path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl');
  write(file, 'abcdefghij');
  const { w } = watcher(c, f);
  await w.tick(); // watcher now believes the server holds 10 bytes
  fs.appendFileSync(file, 'KLMNO');
  // another writer moved the server forward behind the watcher's back
  f.store.append(CID, { path: L, offset: 10, data: Buffer.from('KL').toString('base64') });
  await w.tick();
  assert.equal(fs.readFileSync(f.file(L), 'utf8'), 'abcdefghijKLMNO');
});

test('order: the newest file by mtime ships first', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const now = Math.floor(Date.now() / 1000);
  write(path.join(c.P.claudeDir, 'projects', 'p', 'old.jsonl'), 'old\n', now - 5000);
  write(path.join(c.P.claudeDir, 'projects', 'p', 'new.jsonl'), 'new\n', now - 10);
  write(path.join(c.P.claudeDir, 'projects', 'p', 'mid.jsonl'), 'mid\n', now - 500);
  const { w } = watcher(c, f);
  await w.tick();
  assert.deepEqual(f.posts().map((p) => p.body.path.split('/').pop()), ['new.jsonl', 'mid.jsonl', 'old.jsonl']);
});

test('pacing: shipping is held to 4 MiB a second', { skip: SKIP }, async () => {
  assert.equal(MIRROR_RATE_BYTES, 4 * 1024 * 1024);
  const c = clientHome(); const f = fakeServer();
  const size = MIRROR_CHUNK_BYTES * 8;
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), crypto.randomBytes(size));
  const { w, clock } = watcher(c, f);
  await w.tick();
  const expectedMs = ((size - MIRROR_CHUNK_BYTES) / MIRROR_RATE_BYTES) * 1000;
  assert.ok(clock.slept >= expectedMs - 5, `slept ${clock.slept} ms, expected at least ${expectedMs}`);
});

test('a pass stops after its time budget, and the next tick carries on', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const size = MIRROR_CHUNK_BYTES * 8;
  const data = crypto.randomBytes(size);
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), data);
  const { w } = watcher(c, f, { passMaxMs: 400 });
  await w.tick();
  const partial = fs.statSync(f.file(L)).size;
  assert.ok(partial > 0 && partial < size, `partial ${partial}`);
  for (let i = 0; i < 20 && fs.statSync(f.file(L)).size < size; i++) await w.tick();
  assert.deepEqual(fs.readFileSync(f.file(L)), data);
});

test('json snapshot: ships once, and an mtime-only touch or an unchanged hash sends nothing', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const file = path.join(c.P.claudeDir, '.claude-manager', 'active-sessions.json');
  write(file, JSON.stringify([{ sessionId: 'a' }]));
  const { w } = watcher(c, f);
  await w.tick();
  const jp = 'claude/.claude-manager/active-sessions.json';
  assert.deepEqual(fs.readFileSync(f.file(jp)), fs.readFileSync(file));
  assert.equal(f.store.manifest(CID).files[jp].sha256, sha(fs.readFileSync(file)));
  const n = f.posts().length;
  await w.tick();
  assert.equal(f.posts().length, n);
  const later = Date.now() / 1000 + 60;
  fs.utimesSync(file, later, later);
  await w.tick();
  assert.equal(f.posts().length, n, 'same bytes, new mtime: hashed locally, nothing sent');
  write(file, JSON.stringify([{ sessionId: 'b' }]));
  fs.utimesSync(file, later + 60, later + 60);
  await w.tick();
  assert.equal(f.posts().length, n + 1);
  assert.deepEqual(fs.readFileSync(f.file(jp)), fs.readFileSync(file));
});

test('json snapshot: a fresh watcher does not resend what the server already has', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const file = path.join(c.P.claudeDir, '.claude-manager', 'active-sessions.json');
  write(file, '[1]');
  await watcher(c, f).w.tick();
  const n = f.posts().length;
  await watcher(c, f).w.tick();
  assert.equal(f.posts().length, n);
});

test('json snapshot: a file over the 5 MiB cap is skipped and named in the status', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  write(path.join(c.P.claudeDir, '.claude-manager', 'active-sessions.json'), Buffer.alloc(JSON_SNAPSHOT_MAX_BYTES + 1, 32));
  const { w } = watcher(c, f);
  await w.tick();
  assert.equal(f.posts().length, 0);
  assert.deepEqual(w.status().skipped.map((s) => s.path), ['claude/.claude-manager/active-sessions.json']);
  assert.match(w.status().skipped[0].reason, /cap/);
});

test('sqlite snapshot: a WAL-mode database round-trips with its uncommitted-to-main WAL rows, hash-correct', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  const dbFile = path.join(c.P.agyCliDir, 'conversations', 'c1.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const live = new sqlite.DatabaseSync(dbFile);
  try {
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE steps (idx INTEGER, body TEXT);');
    for (let i = 0; i < 50; i++) live.prepare('INSERT INTO steps VALUES (?, ?)').run(i, `row ${i}`);
    const { w } = watcher(c, f);
    const r = await w.tick();
    assert.equal(r.shipped, true);
    const mp = 'agy-cli/conversations/c1.db';
    const copy = fs.readFileSync(f.file(mp));
    assert.equal(f.store.manifest(CID).files[mp].sha256, sha(copy));
    const check = new sqlite.DatabaseSync(f.file(mp));
    try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM steps').get().n, 50); } finally { check.close(); }
    const n = f.posts().length;
    await w.tick();
    assert.equal(f.posts().length, n, 'unchanged source, nothing re-snapshotted or sent');
    live.prepare('INSERT INTO steps VALUES (?, ?)').run(99, 'later');
    await w.tick();
    const check2 = new sqlite.DatabaseSync(f.file(mp));
    try { assert.equal(check2.prepare('SELECT COUNT(*) AS n FROM steps').get().n, 51); } finally { check2.close(); }
    assert.deepEqual(fs.readdirSync(c.tmpDir), [], 'temp snapshot files are removed');
  } finally { live.close(); }
});

test('sqlite snapshot: a file that is not a database is skipped for that file only', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  write(path.join(c.P.agyCliDir, 'conversations', 'bad.db'), 'this is not sqlite');
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), 'fine\n');
  const { w } = watcher(c, f);
  const r = await w.tick();
  assert.equal(r.shipped, true);
  assert.equal(fs.readFileSync(f.file(L), 'utf8'), 'fine\n');
  assert.equal(w.status().state, 'ok');
  assert.ok(w.status().skipped.some((s) => s.path === 'agy-cli/conversations/bad.db'));
});

test('failures: the backoff ladder, then a 401 or 426 stops until resume()', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), 'x\n');
  const { w, clock } = watcher(c, f);
  f.mode = 'down';
  assert.equal((await w.tick()).shipped, false);
  assert.equal(w.status().state, 'backoff');
  assert.equal(w.status().backoffMs, BACKOFF_MIN_MS);
  assert.deepEqual(await w.tick(), { skipped: 'backoff' });
  clock.t += BACKOFF_MIN_MS;
  await w.tick();
  assert.equal(w.status().backoffMs, 2 * BACKOFF_MIN_MS);
  f.mode = 500;
  clock.t += 10 * 60 * 1000;
  await w.tick();
  assert.equal(w.status().backoffMs, 4 * BACKOFF_MIN_MS);
  f.mode = 401;
  clock.t += 10 * 60 * 1000;
  await w.tick();
  assert.equal(w.status().state, 'unpaired');
  f.mode = null;
  assert.deepEqual(await w.tick(), { skipped: 'unpaired' });
  w.resume();
  assert.equal((await w.tick()).shipped, true);
  assert.equal(w.status().state, 'ok');
  f.mode = 426;
  write(path.join(c.P.claudeDir, 'projects', 'p', 's2.jsonl'), 'y\n');
  await w.tick();
  assert.equal(w.status().state, 'protocol-too-old');
});

test('a 507 stops new bytes, is shown in the status, and is retried only after the long interval', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), 'x\n');
  const { w, clock } = watcher(c, f);
  const real = f.fetch;
  let full = true;
  f.fetch = async (url, init) => (full && init.method === 'POST' ? { status: 507, json: async () => ({ error: 'mirror quota exceeded', usedBytes: 9, quotaBytes: 10 }) } : real(url, init));
  await w.tick();
  assert.equal(w.status().state, 'quota');
  assert.deepEqual(w.status().quota, { usedBytes: 9, quotaBytes: 10 });
  const n = f.log.length;
  assert.deepEqual(await w.tick(), { skipped: 'quota' });
  assert.equal(f.log.length, n);
  full = false;
  clock.t += 6 * 60 * 1000;
  assert.equal((await w.tick()).shipped, true);
  assert.equal(w.status().state, 'ok');
});

test('no credentials ships nothing, only one pass runs at a time, and busy() says so', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), 'x\n');
  const none = createMirrorWatcher({ getCreds: () => null, getPaths: () => c.P, tmpDir: c.tmpDir, fetch: f.fetch, log: () => {} });
  assert.deepEqual(await none.tick(), { skipped: 'no-credentials' });
  assert.equal(f.log.length, 0);
  const { w } = watcher(c, f);
  assert.equal(w.busy(), false);
  const first = w.tick();
  assert.equal(w.busy(), true);
  assert.deepEqual(await w.tick(), { skipped: 'in-flight' });
  await first;
  assert.equal(w.busy(), false);
});

test('the mirror GET and the posts go to the three mirror routes under the configured server', { skip: SKIP }, async () => {
  const c = clientHome(); const f = fakeServer();
  write(path.join(c.P.claudeDir, 'projects', 'p', 's1.jsonl'), 'x\n');
  write(path.join(c.P.claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  await watcher(c, f).w.tick();
  assert.deepEqual([...new Set(f.log.map((r) => `${r.method} ${r.path}`))].sort(), ['GET /api/tap/mirror', 'POST /api/tap/mirror/append', 'POST /api/tap/mirror/snapshot']);
});
