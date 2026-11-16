// Card glmps-2-0-runtime-68: a board write costs O(change), not O(board). The
// store is a snapshot (store.json) plus an append-only change log; these tests
// pin the cost, the crash safety, the backup and the migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as store from '../lib/orchestration/backlog-store.js';
import { bigBoard } from './helpers/big-board.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const STORE_MODULE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'orchestration', 'backlog-store.js')).href;

function mkState(board) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-blog-')); tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'backlog'), { recursive: true });
  if (board) fs.writeFileSync(path.join(dir, 'backlog', 'store.json'), JSON.stringify(board, null, 2));
  return dir;
}
const bdir = (dir) => path.join(dir, 'backlog');
const snap = (dir) => path.join(bdir(dir), 'store.json');
const logs = (dir) => fs.readdirSync(bdir(dir)).filter((f) => /^store\..+\.log$/.test(f));
function currentLog(dir) {
  const gen = JSON.parse(fs.readFileSync(snap(dir), 'utf8')).logGen;
  return path.join(bdir(dir), `store.${gen}.log`);
}
// A fresh process: forget the in-memory board and read it from disk.
function reload(dir) { store.dropCache(dir); return store.load(dir); }

test('a devlog append writes O(change) bytes and leaves the snapshot alone', () => {
  const dir = mkState(bigBoard(1500));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'first' }); // first write migrates
  const snapStat = fs.statSync(snap(dir));
  const log = currentLog(dir);
  const before = fs.statSync(log).size;
  store.appendDevLogIn(dir, 'glmps-7', { by: 'agent', text: 'hello' });
  const grew = fs.statSync(log).size - before;
  const card = JSON.stringify(store.load(dir).items.find((i) => i.id === 'glmps-7')).length;
  assert.ok(grew > 0 && grew < card * 2, `log grew ${grew} bytes for a ${card}-byte card`);
  const after = fs.statSync(snap(dir));
  assert.equal(after.size, snapStat.size);
  assert.equal(after.mtimeMs, snapStat.mtimeMs);
  assert.equal(fs.existsSync(path.join(bdir(dir), 'store.json.bak')), true, 'migration kept the pre-log store');
  assert.equal(reload(dir).items.find((i) => i.id === 'glmps-7').devLog.at(-1).text, 'hello');
});

test('first boot on a legacy store migrates once and backs it up byte for byte', () => {
  const dir = mkState(bigBoard(5));
  const original = fs.readFileSync(snap(dir), 'utf8');
  store.updateItemIn(dir, 'glmps-2', { state: 'queued' });
  assert.equal(fs.readFileSync(path.join(bdir(dir), 'store.json.bak'), 'utf8'), original);
  const migrated = JSON.parse(fs.readFileSync(snap(dir), 'utf8'));
  assert.equal(typeof migrated.logGen, 'string');
  assert.equal(migrated.items.length, 5);
  store.updateItemIn(dir, 'glmps-3', { state: 'queued' });
  assert.equal(fs.readFileSync(path.join(bdir(dir), 'store.json.bak'), 'utf8'), original, 'later writes do not copy the store again');
  const s = reload(dir);
  assert.equal(s.items.find((i) => i.id === 'glmps-2').state, 'queued');
  assert.equal(s.items.find((i) => i.id === 'glmps-3').state, 'queued');
  assert.equal('logGen' in s, false, 'the log generation is storage, not board state');
});

test('every writer round-trips through a reload: put, delete, board fields, order', () => {
  const dir = mkState(null);
  for (const t of ['a', 'b', 'c', 'd']) store.addItemTo(dir, { project: 'nq', title: t });
  store.setGateIn(dir, 'nq-2', { status: 'PASS', evidence: ['ok'] });
  store.removeItemIn(dir, 'nq-3');
  store.setPausedIn(dir, true);
  const cur = store.load(dir);
  store.save(dir, { ...cur, items: [...cur.items].reverse() });
  const s = reload(dir);
  assert.deepEqual(s.items.map((i) => i.id), ['nq-4', 'nq-2', 'nq-1']);
  assert.equal(s.items.find((i) => i.id === 'nq-2').gate.status, 'PASS');
  assert.equal(s.paused, true);
  assert.equal(s.seqs.nq, 4);
  assert.deepEqual(reload(dir), s);
});

test('a torn last line (crash mid-append) is skipped and the next append still lands', () => {
  const dir = mkState(bigBoard(5));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'one' });
  store.appendDevLogIn(dir, 'glmps-2', { by: 'agent', text: 'two' });
  fs.appendFileSync(currentLog(dir), '{"t":"put","item":{"id":"glmps-3","devLog":[{"te');
  const origErr = console.error; console.error = () => {};
  try {
    let s = reload(dir);
    assert.equal(s.loadError, undefined);
    assert.equal(s.items.find((i) => i.id === 'glmps-2').devLog.at(-1).text, 'two');
    store.appendDevLogIn(dir, 'glmps-4', { by: 'agent', text: 'four' });
    s = reload(dir);
    assert.equal(s.items.find((i) => i.id === 'glmps-4').devLog.at(-1).text, 'four');
    assert.equal(s.items.find((i) => i.id === 'glmps-3').devLog.length, 1, 'the torn record was not applied');
  } finally { console.error = origErr; }
});

test('compaction folds the log into the snapshot and keeps the previous one as the backup', () => {
  const dir = mkState(bigBoard(20, 200));
  const prev = process.env.GLMPS_BACKLOG_COMPACT_BYTES;
  process.env.GLMPS_BACKLOG_COMPACT_BYTES = '4000';
  try {
    for (let k = 0; k < 40; k += 1) store.appendDevLogIn(dir, `glmps-${1 + (k % 20)}`, { by: 'agent', text: `w${k}` });
  } finally { if (prev === undefined) delete process.env.GLMPS_BACKLOG_COMPACT_BYTES; else process.env.GLMPS_BACKLOG_COMPACT_BYTES = prev; }
  assert.ok(fs.statSync(currentLog(dir)).size < 4000 + 2000, 'the log was compacted');
  assert.ok(logs(dir).length <= 2, `only the live and the backup generation remain: ${logs(dir)}`);
  const live = reload(dir);
  assert.equal(live.items.find((i) => i.id === 'glmps-20').devLog.at(-1).text, 'w39');
  // Restoring the backup (the documented recovery) yields a consistent board:
  // its own log generation is still on disk, so nothing past it is mixed in.
  fs.copyFileSync(path.join(bdir(dir), 'store.json.bak'), snap(dir));
  const restored = reload(dir);
  assert.equal(restored.loadError, undefined);
  assert.equal(restored.items.length, 20);
  assert.equal(restored.items.find((i) => i.id === 'glmps-1').devLog.length >= 2, true);
});

test('a crash after the new snapshot lands but before the old log is removed replays cleanly', () => {
  const dir = mkState(bigBoard(5));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'migrate' });
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'one' });
  const oldLog = currentLog(dir);
  const oldText = fs.readFileSync(oldLog);
  store.compact(dir);
  // Simulate the crash: the previous generation's log never got deleted and is
  // newer on disk than a hand-copied stale one; replay must ignore it.
  fs.writeFileSync(oldLog, oldText);
  store.appendDevLogIn(dir, 'glmps-2', { by: 'agent', text: 'two' });
  const s = reload(dir);
  assert.equal(s.items.find((i) => i.id === 'glmps-1').devLog.at(-1).text, 'one');
  assert.equal(s.items.find((i) => i.id === 'glmps-2').devLog.at(-1).text, 'two');
  assert.equal(s.items.find((i) => i.id === 'glmps-1').devLog.length, 3, 'the old log was not applied twice');
});

test('a write by another process is picked up from the log tail and named', () => {
  const dir = mkState(bigBoard(10));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'mine' });
  store.takeChanges(dir);
  const code = `import * as s from ${JSON.stringify(STORE_MODULE)}; s.appendDevLogIn(${JSON.stringify(dir)}, 'glmps-4', { by: 'hook', text: 'theirs' });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = store.load(dir);
  assert.equal(s.items.find((i) => i.id === 'glmps-4').devLog.at(-1).text, 'theirs');
  assert.equal(s.items.find((i) => i.id === 'glmps-1').devLog.at(-1).text, 'mine');
  assert.deepEqual(store.takeChanges(dir).ids, ['glmps-4']);
  store.appendDevLogIn(dir, 'glmps-5', { by: 'agent', text: 'after' });
  assert.equal(reload(dir).items.find((i) => i.id === 'glmps-4').devLog.at(-1).text, 'theirs');
});

test('a write that lands in the old log just after another process compacted is not lost', () => {
  const dir = mkState(bigBoard(10));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'migrate' });
  // A second cache over the same files stands in for a second process. Its
  // save syncs, then the first process compacts (copying the old log before
  // the second one's line is in it), then the append lands in the old log.
  const other = dir + path.sep;
  store.load(other);
  const realAppend = fs.appendFileSync;
  let fired = false;
  fs.appendFileSync = function (...args) {
    if (!fired) { fired = true; fs.appendFileSync = realAppend; store.compact(dir); }
    return realAppend.apply(this, args);
  };
  try { store.appendDevLogIn(other, 'glmps-4', { by: 'hook', text: 'raced' }); } finally { fs.appendFileSync = realAppend; }
  assert.equal(fired, true);
  assert.equal(reload(dir).items.find((i) => i.id === 'glmps-4').devLog.at(-1).text, 'raced');
  assert.equal(reload(other).items.find((i) => i.id === 'glmps-4').devLog.at(-1).text, 'raced');
});

test('a loaded card is frozen, so an in-place edit cannot silently diverge from disk', () => {
  const dir = mkState(bigBoard(3));
  const s = store.load(dir);
  assert.throws(() => { s.items[0].title = 'x'; }, TypeError);
  assert.throws(() => { s.items[0].devLog.push({}); }, TypeError);
  s.items.push({ id: 'glmps-99' });
  assert.equal(store.load(dir).items.length, 3, 'the items array itself is the caller\'s copy');
});

test('a save that changes nothing writes nothing', () => {
  const dir = mkState(bigBoard(3));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'one' });
  const size = fs.statSync(currentLog(dir)).size;
  store.save(dir, store.load(dir));
  assert.equal(fs.statSync(currentLog(dir)).size, size);
});

test('the session-card lookup sees a write that only touched the change log', async () => {
  const { createSessionCardLookup } = await import('../lib/orchestration/session-cards.js');
  const dir = mkState(bigBoard(3));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'migrate' });
  const lookup = createSessionCardLookup(dir);
  assert.equal(lookup().size, 0);
  store.setRunSessionIn(dir, 'glmps-2', { sessionId: 'sess-a' });
  assert.equal(lookup().get('sess-a')?.id, 'glmps-2');
});

// Card glmps-2-0-222: on a coarse filesystem clock the compacted snapshot can
// keep the old one's mtime, and the new generation id has the same length, so
// mtime plus size alone could not see the compaction and the append was lost.
test('a racing compaction is seen even when the new snapshot keeps the old size and mtime', () => {
  const dir = mkState(bigBoard(10));
  store.appendDevLogIn(dir, 'glmps-1', { by: 'agent', text: 'migrate' });
  const other = dir + path.sep;
  store.load(other);
  const realStat = fs.statSync;
  fs.statSync = function (f, ...rest) {
    const s = realStat.call(this, f, ...rest);
    if (!s || path.basename(String(f)) !== 'store.json') return s;
    const coarse = Object.assign(Object.create(Object.getPrototypeOf(s)), s);
    if (typeof s.mtimeMs === 'bigint') { coarse.mtimeMs = 0n; coarse.mtimeNs = 0n; } else coarse.mtimeMs = 0;
    return coarse;
  };
  const realAppend = fs.appendFileSync;
  let fired = false;
  fs.appendFileSync = function (...args) {
    if (!fired) { fired = true; fs.appendFileSync = realAppend; store.compact(dir); }
    return realAppend.apply(this, args);
  };
  try {
    store.appendDevLogIn(other, 'glmps-4', { by: 'hook', text: 'raced' });
    assert.equal(fired, true);
    assert.equal(reload(dir).items.find((i) => i.id === 'glmps-4').devLog.at(-1).text, 'raced');
  } finally { fs.appendFileSync = realAppend; fs.statSync = realStat; }
});
