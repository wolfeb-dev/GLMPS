// Nightly state-dir backups (card glmps-2-0-runtime-42). Temp dirs only; both
// dirs live under os.tmpdir(), so the second-disk check is switched off with
// requireSecondDisk:false except where a test exercises it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateBackup, localDate, isoWeekKey, restoreBackup, copySqlite, checkSqlite } from '../lib/kernel/state-backup.js';
import { startServer } from '../server.js';

const roots = [];
after(() => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } });

const DB = process.getBuiltinModule('node:sqlite').DatabaseSync;
const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h, 0, 0).getTime();

function mkRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-state-backup-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  return { root, stateDir, targetDir };
}

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// A live-looking state dir: a WAL-mode db with rows still in the WAL (the
// connection stays open), JSON stores, and everything that must be excluded.
function seedState(stateDir) {
  const db = new DB(path.join(stateDir, 'kernel.db'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1),(2),(3);');
  put(path.join(stateDir, 'config.json'), '{"port":1}');
  put(path.join(stateDir, 'backlog', 'store.json'), '{"items":[]}');
  put(path.join(stateDir, 'events.ndjson'), 'a\nb\n');
  put(path.join(stateDir, 'runner', 'worktrees', 'job1', 'huge.bin'), 'x'.repeat(100));
  put(path.join(stateDir, 'logs', 'GLMPS2.out.log'), 'log');
  put(path.join(stateDir, 'scratch.tmp'), 'tmp');
  put(path.join(stateDir, 'clients', 'c1', 'mirror', 'claude', 't.jsonl'), 'line1\n');
  return db;
}

const mk = (r, extra = {}) => createStateBackup({ stateDir: r.stateDir, targetDir: r.targetDir, requireSecondDisk: false, now: () => at(2026, 11, 3), ...extra });

test('local date and ISO week keys are right across year boundaries', () => {
  assert.equal(localDate(at(2026, 11, 3, 23)), '2026-11-03');
  assert.equal(isoWeekKey(at(2021, 1, 1)), '2020-W53');
  assert.equal(isoWeekKey(at(2024, 12, 31)), '2025-W01');
  assert.equal(isoWeekKey(at(2026, 1, 1)), '2026-W01');
  assert.equal(isoWeekKey(at(2027, 1, 3)), '2026-W53');
  assert.equal(isoWeekKey(at(2026, 11, 2)), '2026-W45');
});

test('a backup copies sqlite (WAL rows included) and files, skips exclusions, writes the manifest last', async () => {
  const r = mkRoot(); const db = seedState(r.stateDir);
  const res = await mk(r).run();
  db.close();
  const dir = path.join(r.targetDir, 'daily', '2026-11-03');
  assert.equal(res.dir, dir);

  const copy = new DB(path.join(dir, 'kernel.db'), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(copy.prepare('SELECT n FROM t ORDER BY n').all().map(x => x.n), [1, 2, 3]);
  copy.close();

  for (const rel of ['config.json', 'backlog/store.json', 'events.ndjson']) assert.ok(fs.existsSync(path.join(dir, rel)), rel);
  for (const rel of ['runner/worktrees', 'logs', 'scratch.tmp', 'kernel.db-wal', 'kernel.db-shm', 'clients']) assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} must be excluded`);

  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(m.stateDir, r.stateDir);
  assert.deepEqual(m.files.map(f => f.rel).sort(), ['backlog/store.json', 'config.json', 'events.ndjson', 'kernel.db']);
  assert.equal(m.files.find(f => f.rel === 'kernel.db').kind, 'sqlite');
  assert.equal(m.files.find(f => f.rel === 'config.json').kind, 'file');
  assert.equal(m.files.find(f => f.rel === 'config.json').size, 10);
  assert.match(m.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.bytes, m.files.reduce((a, f) => a + f.size, 0));
  assert.deepEqual(await mk(r).verify(), { ok: true, checked: 4 });
});

// Batched review finding 1 and 2 (card glmps-2-0-runtime-148): WSL holds the
// Headscale distro's vhdx open, the cache is re-fetchable, and a copied CA key
// would let any backup holder mint a certificate every joined device trusts.
test('AC-1: a backup skips the remote-access WSL disk, the download cache and the CA private key', async () => {
  const r = mkRoot();
  const ra = path.join(r.stateDir, 'remote-access');
  put(path.join(ra, 'wsl', 'ext4.vhdx'), 'disk');
  put(path.join(ra, 'cache', 'headscale_0.26.1_linux_amd64'), 'bin');
  put(path.join(ra, 'headscale', 'ca.key'), 'secret');
  put(path.join(ra, 'headscale', 'ca.key.bak-20261104-010203'), 'old secret');
  put(path.join(ra, 'headscale', 'ca.crt'), 'cert');
  put(path.join(ra, 'headscale', 'server.key'), 'leaf key');
  put(path.join(ra, 'headscale', 'config.yaml'), 'cfg');
  const res = await mk(r).run();
  const m = JSON.parse(fs.readFileSync(path.join(res.dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.files.map(f => f.rel).filter(f => f.startsWith('remote-access/')).sort(),
    ['remote-access/headscale/ca.crt', 'remote-access/headscale/config.yaml', 'remote-access/headscale/server.key']);
  for (const rel of ['remote-access/wsl', 'remote-access/cache', 'remote-access/headscale/ca.key', 'remote-access/headscale/ca.key.bak-20261104-010203']) {
    assert.ok(!fs.existsSync(path.join(res.dir, ...rel.split('/'))), `${rel} must be excluded`);
    assert.ok(!fs.existsSync(path.join(r.targetDir, 'mirror', ...rel.split('/'))), `${rel} must not reach the mirror`);
  }
});

// Card glmps-2-0-152: both CA private keys of local-only mTLS stay on the box,
// and the retired Headscale folder's CA key stays out once it is moved aside.
test('a backup skips the home and client CA private keys and the retired Headscale CA key', async () => {
  const r = mkRoot();
  const tlsDir = path.join(r.stateDir, 'tls');
  for (const f of ['home-ca.key', 'client-ca.key', 'home-ca.pem', 'client-ca.pem', 'server.pem', 'server.key']) put(path.join(tlsDir, f), f);
  put(path.join(r.stateDir, 'remote-access', 'headscale.bak-20261110-101500', 'ca.key'), 'old secret');
  put(path.join(r.stateDir, 'remote-access', 'headscale.bak-20261110-101500', 'ca.crt'), 'old cert');
  const res = await mk(r).run();
  const m = JSON.parse(fs.readFileSync(path.join(res.dir, 'manifest.json'), 'utf8'));
  const rels = m.files.map(f => f.rel);
  assert.deepEqual(rels.filter(f => f.startsWith('tls/')).sort(), ['tls/client-ca.pem', 'tls/home-ca.pem', 'tls/server.key', 'tls/server.pem']);
  assert.ok(!rels.includes('remote-access/headscale.bak-20261110-101500/ca.key'));
  assert.ok(rels.includes('remote-access/headscale.bak-20261110-101500/ca.crt'));
});

test('a daily dir without a manifest is not a backup and old ones are cleaned', async () => {
  const r = mkRoot(); seedState(r.stateDir).close();
  const half = path.join(r.targetDir, 'daily', '2026-11-03');
  put(path.join(half, 'config.json'), 'partial');
  const crashed = path.join(r.targetDir, 'daily', '2026-10-30');
  put(path.join(crashed, 'config.json'), 'partial');
  const old = new Date(at(2026, 11, 1));
  fs.utimesSync(crashed, old, old);

  const sb = mk(r);
  assert.equal(sb.newestDaily(), null, 'no complete daily yet');
  await sb.run();
  assert.ok(!fs.existsSync(crashed), 'a manifest-less dir older than a day is removed');
  assert.ok(fs.existsSync(path.join(half, 'manifest.json')), 'a rerun replaces the half-written dir');
  assert.equal(fs.readFileSync(path.join(half, 'config.json'), 'utf8'), '{"port":1}');
});

test('the first daily of an ISO week is promoted to weekly once', async () => {
  const r = mkRoot(); seedState(r.stateDir).close();
  let t = at(2026, 11, 2); // Monday, 2026-W45
  const sb = mk(r, { now: () => t });
  const first = await sb.run();
  assert.equal(first.weekly, '2026-W45');
  const wk = path.join(r.targetDir, 'weekly', '2026-W45');
  const createdAt = JSON.parse(fs.readFileSync(path.join(wk, 'manifest.json'), 'utf8')).createdAt;
  assert.equal(fs.readFileSync(path.join(wk, 'config.json'), 'utf8'), '{"port":1}');

  put(path.join(r.stateDir, 'config.json'), '{"port":2}');
  t = at(2026, 11, 4);
  const second = await sb.run();
  assert.equal(second.weekly, null, 'same ISO week: not promoted again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(wk, 'manifest.json'), 'utf8')).createdAt, createdAt);
  assert.equal(fs.readFileSync(path.join(wk, 'config.json'), 'utf8'), '{"port":1}');

  t = at(2026, 11, 9); // next Monday
  assert.equal((await sb.run()).weekly, '2026-W46');
  assert.deepEqual(fs.readdirSync(path.join(r.targetDir, 'weekly')).sort(), ['2026-W45', '2026-W46']);
});

test('AC-2: daily backups skip the transcript archive, the weekly set carries it and links unchanged files', async () => {
  const r = mkRoot(); seedState(r.stateDir).close();
  put(path.join(r.stateDir, 'transcript-archive', 'p', 's1.jsonl'), 'old transcript\n');
  put(path.join(r.stateDir, 'archive', 'transcript-archive', 's2.jsonl'), 'regrouped transcript\n');
  let t = at(2026, 11, 2); // Monday, 2026-W45
  const sb = mk(r, { now: () => t });
  const mon = await sb.run();
  const archived = ['archive/transcript-archive/s2.jsonl', 'transcript-archive/p/s1.jsonl'];
  const rels = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files.map(f => f.rel);
  assert.deepEqual(rels(mon.dir).filter(x => x.includes('transcript-archive')), [], 'daily manifest');
  assert.ok(!fs.existsSync(path.join(mon.dir, 'transcript-archive')), 'daily dir');
  assert.ok(!fs.existsSync(path.join(mon.dir, 'archive', 'transcript-archive')), 'daily dir');
  const w45 = path.join(r.targetDir, 'weekly', '2026-W45');
  assert.deepEqual(rels(w45).filter(x => x.includes('transcript-archive')).sort(), archived);
  assert.equal(fs.readFileSync(path.join(w45, 'transcript-archive', 'p', 's1.jsonl'), 'utf8'), 'old transcript\n');
  assert.deepEqual(await sb.verify(w45), { ok: true, checked: rels(mon.dir).length + 2 });

  t = at(2026, 11, 3);
  const tue = await sb.run();
  assert.equal(tue.weekly, null);
  assert.deepEqual(rels(tue.dir).filter(x => x.includes('transcript-archive')), []);

  put(path.join(r.stateDir, 'transcript-archive', 'p', 's3.jsonl'), 'new transcript\n');
  t = at(2026, 11, 9); // next Monday, 2026-W46
  await sb.run();
  const w46 = path.join(r.targetDir, 'weekly', '2026-W46');
  assert.deepEqual(rels(w46).filter(x => x.includes('transcript-archive')).sort(), [...archived, 'transcript-archive/p/s3.jsonl'].sort());
  assert.equal(fs.statSync(path.join(w46, 'transcript-archive', 'p', 's1.jsonl')).nlink, 2, 'unchanged file is a link to the last weekly');
  assert.equal(fs.statSync(path.join(w46, 'transcript-archive', 'p', 's3.jsonl')).nlink, 1);
  assert.equal((await sb.verify(w46)).ok, true);

  const restored = path.join(r.root, 'restored');
  await restoreBackup(w46, restored);
  assert.equal(fs.readFileSync(path.join(restored, 'transcript-archive', 'p', 's3.jsonl'), 'utf8'), 'new transcript\n');
});

test('retention keeps 14 daily and 8 weekly and never touches anything else', async () => {
  const r = mkRoot(); put(path.join(r.stateDir, 'config.json'), '{}');
  put(path.join(r.targetDir, 'notes.txt'), 'mine');
  put(path.join(r.targetDir, 'daily', 'keep-me.txt'), 'mine');
  put(path.join(r.targetDir, 'other', 'x'), 'mine');
  let t = at(2026, 1, 1);
  const sb = mk(r, { now: () => t });
  for (let i = 0; i < 80; i++) { await sb.run(); t += 24 * 3600 * 1000; }
  const daily = fs.readdirSync(path.join(r.targetDir, 'daily')).filter(n => /^\d{4}-/.test(n)).sort();
  assert.equal(daily.length, 14);
  assert.equal(daily.at(-1), localDate(t - 24 * 3600 * 1000));
  assert.equal(fs.readdirSync(path.join(r.targetDir, 'weekly')).length, 8);
  for (const f of ['notes.txt', 'daily/keep-me.txt', 'other/x']) assert.ok(fs.existsSync(path.join(r.targetDir, f)), f);
});

test('the mirror copies only files whose size or mtime changed', async () => {
  const r = mkRoot(); put(path.join(r.stateDir, 'config.json'), '{}');
  const src = path.join(r.stateDir, 'clients', 'c1', 'mirror', 'claude', 't.jsonl');
  put(src, 'line1\n');
  put(path.join(r.stateDir, 'clients', 'c1', 'mirror', 'claude', 'u.jsonl'), 'u\n');
  const sb = mk(r);
  assert.equal((await sb.run()).mirrored, 2);
  const dest = path.join(r.targetDir, 'mirror', 'clients', 'c1', 'mirror', 'claude', 't.jsonl');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'line1\n');
  assert.equal((await sb.run()).mirrored, 0, 'nothing changed');
  fs.appendFileSync(src, 'line2\n');
  assert.equal((await sb.run()).mirrored, 1, 'only the appended file');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'line1\nline2\n');
});

test('verify fails when a backed-up byte is changed', async () => {
  const r = mkRoot(); put(path.join(r.stateDir, 'config.json'), '{"port":1}');
  const sb = mk(r); const res = await sb.run();
  assert.equal((await sb.verify(res.dir)).ok, true);
  fs.writeFileSync(path.join(res.dir, 'config.json'), '{"port":9}');
  const v = await sb.verify(res.dir);
  assert.equal(v.ok, false);
  assert.match(v.reason, /config\.json/);
  fs.rmSync(path.join(res.dir, 'manifest.json'));
  assert.equal((await sb.verify(res.dir)).ok, false, 'no manifest is not a backup');
});

test('an unsafe target fails with a named reason', async () => {
  const r = mkRoot(); put(path.join(r.stateDir, 'config.json'), '{}');
  await assert.rejects(mk(r, { targetDir: path.join(r.stateDir, 'bk') }).run(), /target-inside-state/);
  await assert.rejects(mk(r, { targetDir: path.join(r.root, 'nope') }).run(), /target-missing/);
  await assert.rejects(mk(r, { targetDir: null }).run(), /target-missing/);
  await assert.rejects(createStateBackup({ stateDir: r.stateDir, targetDir: r.targetDir }).run(), /target-same-volume/);
  await assert.rejects(mk(r, { requireSecondDisk: true, sameVolume: () => true }).run(), /target-same-volume/);
  const ok = await mk(r, { requireSecondDisk: true, sameVolume: () => false }).run();
  assert.ok(ok.dir);
});

test('maybeRun waits for the hour, runs once a day, and survives a restart', async () => {
  const r = mkRoot(); put(path.join(r.stateDir, 'config.json'), '{}');
  let t = at(2026, 11, 3, 2);
  const early = await mk(r, { now: () => t }).maybeRun();
  assert.equal(early.outcome, 'nothing-to-do');
  assert.equal(early.result.reason, 'before-hour');
  t = at(2026, 11, 3, 3);
  const ran = await mk(r, { now: () => t }).maybeRun();
  assert.equal(ran.outcome, 'done');
  assert.ok(ran.result.dir);
  t = at(2026, 11, 3, 15);
  const again = await mk(r, { now: () => t }).maybeRun(); // a fresh instance: a restart
  assert.equal(again.outcome, 'nothing-to-do');
  assert.equal(again.result.reason, 'already-done');
  t = at(2026, 11, 4, 3);
  assert.equal((await mk(r, { now: () => t }).maybeRun()).outcome, 'done');
});

test('restore copies a backup into an empty dir and refuses a non-empty or live one', async () => {
  const r = mkRoot(); seedState(r.stateDir).close();
  const sb = mk(r); const res = await sb.run();
  const out = path.join(r.root, 'restored');
  await restoreBackup(res.dir, out, { liveStateDir: r.stateDir });
  assert.equal(fs.readFileSync(path.join(out, 'config.json'), 'utf8'), '{"port":1}');
  assert.ok(!fs.existsSync(path.join(out, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(out, 'clients', 'c1', 'mirror', 'claude', 't.jsonl')), 'mirror restored too');
  const copy = new DB(path.join(out, 'kernel.db'), { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS c FROM t').get().c, 3); copy.close();
  await assert.rejects(restoreBackup(res.dir, out, { liveStateDir: r.stateDir }), /not-empty/);
  await assert.rejects(restoreBackup(res.dir, r.stateDir, { liveStateDir: r.stateDir }), /live-state/);
  fs.writeFileSync(path.join(res.dir, 'config.json'), 'tampered');
  await assert.rejects(restoreBackup(res.dir, path.join(r.root, 'r2'), { liveStateDir: r.stateDir }), /verify/);
});

test('the state-backup loop is registered only when backup.targetDir is set', async () => {
  const mkEnv = (base) => ({
    ...process.env, GLMPS_CLAUDE_DIR: path.join(base, 'claude'), GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(base, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vscode'), GLMPS_AGY_CLI_DIR: path.join(base, 'agy'),
    GLMPS_CODEX_DIR: path.join(base, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(base, 'copilot'), GLMPS_HERMES_DIR: path.join(base, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(base, 'opencode'), GLMPS_UNMERGED_SCAN: 'off',
  });
  for (const withTarget of [false, true]) {
    const r = mkRoot();
    fs.mkdirSync(path.join(r.root, 'claude', '.claude-manager'), { recursive: true });
    fs.mkdirSync(path.join(r.root, 'ag', 'brain'), { recursive: true });
    const configFile = path.join(r.root, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(withTarget ? { backup: { targetDir: r.targetDir, requireSecondDisk: false } } : {}));
    const srv = await startServer({ port: 0, pollMs: 100000, env: mkEnv(r.root), configFile, restartFn: () => {} });
    try {
      const snap = srv.loopRegistry.snapshot();
      assert.equal('state-backup' in snap, withTarget, `targetDir ${withTarget ? 'set' : 'unset'}`);
      if (withTarget) assert.equal(snap['state-backup'].sla.maxAgeMs, 36 * 3600 * 1000);
    } finally { await srv.close(); }
  }
});

test('the backlog snapshot is always backed up with the log its generation names, even across a compaction mid-run', async () => {
  const { load } = await import('../lib/orchestration/backlog-store.js');
  const r = mkRoot();
  const bdir = path.join(r.stateDir, 'backlog');
  const card = (id) => JSON.stringify({ t: 'put', item: { id, project: 'p', title: id, prompt: '', state: 'queued', labels: [] } }) + '\n';
  put(path.join(bdir, 'store.json'), JSON.stringify({ items: [], logGen: 'a1' }));
  put(path.join(bdir, 'store.a1.log'), card('c1'));
  // A compaction lands right after the snapshot is copied: new generation b2
  // carries c1 and adds c2, and the a1 log is gone.
  let compacted = false;
  const res = await mk(r, {
    afterBacklogSnapshot: () => {
      if (compacted) return;
      compacted = true;
      put(path.join(bdir, 'store.b2.log'), card('c1') + card('c2'));
      put(path.join(bdir, 'store.json'), JSON.stringify({ items: [], logGen: 'b2' }));
      fs.unlinkSync(path.join(bdir, 'store.a1.log'));
    },
  }).run();
  assert.ok(compacted);
  const restored = path.join(r.root, 'restored');
  await restoreBackup(res.dir, restored);
  const ids = load(restored).items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['c1', 'c2']);
});

// Card glmps-2-0-runtime-146 finding 4: nothing-to-do counts as a fresh run in
// the loop registry, so a stale newest backup has to fail for the 36 h SLA
// alert to mean anything.
test('maybeRun fails backup-stale before the hour when the newest backup is older than the SLA', async () => {
  const r = mkRoot(); put(path.join(r.stateDir, 'config.json'), '{}');
  let t = at(2026, 11, 3, 2);
  assert.equal((await mk(r, { now: () => t }).maybeRun()).outcome, 'nothing-to-do', 'no backup yet: a fresh install is not stale');
  t = at(2026, 11, 1, 3);
  assert.equal((await mk(r, { now: () => t }).maybeRun()).outcome, 'done');
  t = at(2026, 11, 2, 2);
  assert.equal((await mk(r, { now: () => t }).maybeRun()).result.reason, 'before-hour', '23 h old is fresh');
  t = at(2026, 11, 3, 2);
  await assert.rejects(mk(r, { now: () => t }).maybeRun(), (e) => e.reason === 'backup-stale' && /2026-11-01/.test(e.message));
  t = at(2026, 11, 3, 3);
  assert.equal((await mk(r, { now: () => t }).maybeRun()).outcome, 'done', 'past the hour it backs up as usual');
});

// Finding 5: VACUUM INTO and integrity_check on the memory stores block for
// seconds, so they run on a worker thread, never the kernel's main thread.
test('the sqlite copy and its integrity check run off the main thread', async () => {
  const r = mkRoot(); seedState(r.stateDir).close();
  const dest = path.join(r.root, 'copy.db');
  const copied = await copySqlite(path.join(r.stateDir, 'kernel.db'), dest);
  assert.notEqual(copied.threadId, 0);
  const checked = await checkSqlite(dest);
  assert.notEqual(checked.threadId, 0);
  assert.equal(checked.ok, true);
  await assert.rejects(copySqlite(path.join(r.root, 'missing', 'x.db'), path.join(r.root, 'y.db')));
});

// Finding 6: a file unchanged since the previous daily is a hard link to that
// copy, so 14 dailies do not hold 14 copies of the model and the stores.
test('a file unchanged since the previous daily is hard-linked to it, and survives that daily being pruned', async () => {
  const r = mkRoot(); seedState(r.stateDir).close();
  put(path.join(r.stateDir, 'models', 'bge.onnx'), 'w'.repeat(4096));
  const d1 = await mk(r, { now: () => at(2026, 11, 2, 4) }).run();
  put(path.join(r.stateDir, 'events.ndjson'), 'a\nb\nc\n');
  const d2 = await mk(r, { now: () => at(2026, 11, 3, 4) }).run();
  const ino = (dir, rel) => fs.statSync(path.join(dir, ...rel.split('/')), { bigint: true }).ino;
  assert.equal(ino(d2.dir, 'models/bge.onnx'), ino(d1.dir, 'models/bge.onnx'), 'unchanged model is linked');
  assert.equal(ino(d2.dir, 'config.json'), ino(d1.dir, 'config.json'));
  assert.notEqual(ino(d2.dir, 'events.ndjson'), ino(d1.dir, 'events.ndjson'), 'a changed file is a fresh copy');
  assert.equal(ino(d2.dir, 'kernel.db'), ino(d1.dir, 'kernel.db'), 'an unchanged database vacuums to the same bytes and is linked too');
  assert.equal(d2.linked, 4, 'model, config, the backlog snapshot and kernel.db');
  fs.rmSync(d1.dir, { recursive: true, force: true });
  assert.deepEqual(await verifyBackupOf(r, d2.dir), { ok: true, checked: 5 });
});
const verifyBackupOf = (r, dir) => mk(r).verify(dir);
