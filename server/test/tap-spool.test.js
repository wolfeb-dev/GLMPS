// server/test/tap-spool.test.js
// The tap's on-disk spool (server-and-client-tap task 9): NDJSON segments, a
// per-client sequence that survives restarts, ack and segment deletion, the
// 2 GiB cap rule and a torn last line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSpool, SEGMENT_BYTES, SPOOL_CAP_BYTES, RECORD_MAX_BYTES, DROPPABLE_KINDS } from '../../taps/tap-spool.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const mkDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapspool-')); tmpDirs.push(d); return path.join(d, 'spool'); };
const segs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort();
const SEED_NOW = () => 1_700_000_000_000;
const SEED = 1_700_000_000_000 * 1000;

test('the spec numbers are pinned', () => {
  assert.equal(SEGMENT_BYTES, 8 * 1024 * 1024);
  assert.equal(SPOOL_CAP_BYTES, 2 * 1024 * 1024 * 1024);
  assert.deepEqual([...DROPPABLE_KINDS].sort(), ['budget', 'heartbeat', 'status']);
  assert.ok(RECORD_MAX_BYTES < 1024 * 1024);
});

test('a fresh spool seeds its sequence from the clock, and appends one NDJSON line per record', () => {
  const dir = mkDir();
  const s = openSpool({ dir, now: SEED_NOW });
  assert.deepEqual(s.append('hook', { a: 1 }), { seq: SEED });
  assert.deepEqual(s.append('status', null), { seq: SEED + 1 });
  const lines = fs.readFileSync(path.join(dir, segs(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { seq: SEED, kind: 'hook', ts: 1_700_000_000_000, payload: { a: 1 } },
    { seq: SEED + 1, kind: 'status', ts: 1_700_000_000_000, payload: null },
  ]);
  assert.equal(s.stats().depth, 2);
});

test('the sequence continues across a reopen, whether or not anything was acked', () => {
  const dir = mkDir();
  let s = openSpool({ dir, now: SEED_NOW });
  s.append('hook', 1); s.append('hook', 2);
  s = openSpool({ dir, now: () => 5 });
  assert.equal(s.append('hook', 3).seq, SEED + 2);
  s.ack(SEED + 2);
  s = openSpool({ dir, now: () => 5 });
  assert.equal(s.append('hook', 4).seq, SEED + 3, 'all acked and segments deleted: acked.json still carries the sequence');
});

test('append refuses a bad kind and a record that could never ship', () => {
  const s = openSpool({ dir: mkDir(), now: SEED_NOW });
  assert.throws(() => s.append('Hook', 1), /kind/);
  assert.throws(() => s.append('', 1), /kind/);
  assert.throws(() => s.append('hook', 'x'.repeat(RECORD_MAX_BYTES)), /too large/);
  assert.throws(() => s.append('hook', undefined), /payload/);
  assert.equal(s.stats().depth, 0);
});

test('readBatch returns unacked records in order under the byte budget, and ack moves past them', () => {
  const s = openSpool({ dir: mkDir(), now: SEED_NOW });
  for (let i = 0; i < 10; i++) s.append('hook', 'p'.repeat(100));
  const b1 = s.readBatch({ maxBytes: 500 });
  assert.ok(b1.length >= 1 && b1.length < 10, `got ${b1.length}`);
  assert.equal(b1[0].seq, SEED);
  assert.ok(JSON.stringify(b1).length <= 500);
  s.ack(b1.at(-1).seq);
  const b2 = s.readBatch({ maxBytes: 1e6 });
  assert.equal(b2[0].seq, b1.at(-1).seq + 1);
  assert.equal(b2.at(-1).seq, SEED + 9);
  assert.equal(s.stats().depth, 10 - b1.length);
  s.ack(SEED + 9);
  assert.deepEqual(s.readBatch({ maxBytes: 1e6 }), []);
  assert.equal(s.stats().depth, 0);
});

test('readBatch always returns at least one record when any is pending', () => {
  const s = openSpool({ dir: mkDir(), now: SEED_NOW });
  s.append('hook', 'p'.repeat(1000));
  assert.equal(s.readBatch({ maxBytes: 10 }).length, 1);
});

test('segments roll at the segment size, and a fully acked segment is deleted', () => {
  const dir = mkDir();
  const s = openSpool({ dir, now: SEED_NOW, segmentBytes: 300 });
  for (let i = 0; i < 6; i++) s.append('hook', 'p'.repeat(100));
  const before = segs(dir);
  assert.ok(before.length >= 3, before.join(','));
  assert.equal(before[0], `seg-${SEED}.ndjson`);
  s.ack(SEED + 2);
  const after = segs(dir);
  assert.ok(after.length < before.length);
  assert.deepEqual(s.readBatch({ maxBytes: 1e6 }).map((r) => r.seq), [SEED + 3, SEED + 4, SEED + 5]);
  s.ack(SEED + 5);
  assert.deepEqual(segs(dir), []);
  assert.equal(s.stats().bytes, 0);
  s.append('hook', 1);
  assert.deepEqual(segs(dir), [`seg-${SEED + 6}.ndjson`]);
});

test('an ack past the last record (the server is ahead) jumps the sequence past it', () => {
  const s = openSpool({ dir: mkDir(), now: SEED_NOW });
  s.append('hook', 1);
  s.ack(SEED + 50);
  assert.equal(s.stats().depth, 0);
  assert.equal(s.append('hook', 2).seq, SEED + 51);
});

test('an ack at or below the current mark is a no-op', () => {
  const s = openSpool({ dir: mkDir(), now: SEED_NOW });
  s.append('hook', 1); s.append('hook', 2);
  s.ack(SEED);
  s.ack(SEED - 5);
  assert.equal(s.stats().depth, 1);
});

test('past the cap only status and heartbeat records are dropped; the rest are kept and the spool reports full', () => {
  const probe = openSpool({ dir: mkDir(), now: SEED_NOW });
  probe.append('hook', 'p'.repeat(150)); probe.append('hook', 'p'.repeat(150));
  const cap = probe.stats().bytes + 10;
  const s = openSpool({ dir: mkDir(), now: SEED_NOW, cap });
  s.append('hook', 'p'.repeat(150));
  s.append('hook', 'p'.repeat(150));
  assert.equal(s.stats().full, false);
  assert.deepEqual(s.append('status', 'p'.repeat(150)), { dropped: true });
  assert.deepEqual(s.append('heartbeat', {}), { dropped: true });
  const kept = s.append('hook', 'p'.repeat(150));
  assert.equal(kept.seq, SEED + 2, 'a hook record is never dropped, even past the cap');
  const st = s.stats();
  assert.equal(st.full, true);
  assert.equal(st.dropped, 2);
  assert.equal(st.depth, 3);
  assert.ok(st.bytes > cap);
});

test('the full flag clears only once the drops were reported and the spool is back under the cap', () => {
  const s = openSpool({ dir: mkDir(), now: SEED_NOW, cap: 300 });
  s.append('hook', 'p'.repeat(150)); s.append('hook', 'p'.repeat(150));
  s.append('status', 1);
  assert.equal(s.stats().full, true);
  s.ack(SEED + 1);
  assert.equal(s.stats().full, true, 'under the cap but the drops were never reported');
  s.reported({ dropped: 1 });
  assert.deepEqual([s.stats().full, s.stats().dropped], [false, 0]);
});

test('a torn last line (crash mid-append) is skipped, and appends continue on a fresh segment', () => {
  const dir = mkDir();
  let s = openSpool({ dir, now: SEED_NOW });
  s.append('hook', 1); s.append('hook', 2);
  const f = path.join(dir, segs(dir)[0]);
  fs.appendFileSync(f, '{"seq":99999,"kind":"ho');
  s = openSpool({ dir, now: SEED_NOW });
  assert.deepEqual(s.readBatch({ maxBytes: 1e6 }).map((r) => r.seq), [SEED, SEED + 1]);
  assert.equal(s.append('hook', 3).seq, SEED + 2);
  assert.equal(segs(dir).length, 2);
  assert.deepEqual(s.readBatch({ maxBytes: 1e6 }).map((r) => r.seq), [SEED, SEED + 1, SEED + 2]);
});

test('bytes and depth are recomputed on reopen', () => {
  const dir = mkDir();
  let s = openSpool({ dir, now: SEED_NOW, segmentBytes: 200 });
  for (let i = 0; i < 5; i++) s.append('hook', 'p'.repeat(80));
  const { bytes, depth } = s.stats();
  s = openSpool({ dir, now: SEED_NOW, segmentBytes: 200 });
  assert.deepEqual([s.stats().bytes, s.stats().depth], [bytes, depth]);
});
