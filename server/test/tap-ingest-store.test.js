// server/test/tap-ingest-store.test.js
// Tap ingest store (server-and-client-tap task 9): per-client high-water
// dedupe, all-or-nothing batch validation, and the spool-full episode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTapIngest, validateBatch } from '../lib/kernel/tap-ingest.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function open({ now = () => 1000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapingest-')); tmpDirs.push(dir);
  return openTapIngest({ dbFile: path.join(dir, 'kernel.db'), now });
}
const rec = (seq, kind = 'hook', payload = { n: seq }) => ({ seq, kind, ts: 500 + seq, payload });

test('a fresh client starts at high-water 0 and accepts an ascending batch', () => {
  const s = open();
  assert.equal(s.highWater('cli_a'), 0);
  const r = s.ingest('cli_a', { records: [rec(1), rec(2), rec(5)] });
  assert.deepEqual(r, { accepted: 3, duplicates: 0, highWater: 5 });
  assert.equal(s.highWater('cli_a'), 5);
  const rows = s.records({ clientId: 'cli_a' });
  assert.deepEqual(rows.map((x) => x.seq), [1, 2, 5]);
  assert.deepEqual(rows[0], { clientId: 'cli_a', seq: 1, kind: 'hook', ts: 501, receivedTs: 1000, payload: { n: 1 } });
  s.closeDb();
});

test('anything at or below the high-water mark is dropped, so a retry lands once', () => {
  const s = open();
  s.ingest('cli_a', { records: [rec(1), rec(2), rec(3)] });
  const r = s.ingest('cli_a', { records: [rec(2), rec(3), rec(4)] });
  assert.deepEqual(r, { accepted: 1, duplicates: 2, highWater: 4 });
  assert.deepEqual(s.records({ clientId: 'cli_a' }).map((x) => x.seq), [1, 2, 3, 4]);
  const again = s.ingest('cli_a', { records: [rec(1), rec(4)] });
  assert.deepEqual(again, { accepted: 0, duplicates: 2, highWater: 4 });
  s.closeDb();
});

test('high-water marks are per client', () => {
  const s = open();
  s.ingest('cli_a', { records: [rec(10)] });
  assert.deepEqual(s.ingest('cli_b', { records: [rec(1)] }), { accepted: 1, duplicates: 0, highWater: 1 });
  assert.equal(s.highWater('cli_a'), 10);
  s.closeDb();
});

test('an empty batch is fine and reports the current mark', () => {
  const s = open();
  s.ingest('cli_a', { records: [rec(7)] });
  assert.deepEqual(s.ingest('cli_a', { records: [] }), { accepted: 0, duplicates: 0, highWater: 7 });
  s.closeDb();
});

test('validateBatch refuses non-ascending, bad seq, bad kind, bad ts, a missing payload and bad spool fields', () => {
  const bad = [
    null, [], {}, { records: 'x' },
    { records: [rec(2), rec(2)] }, { records: [rec(3), rec(1)] },
    { records: [rec(0)] }, { records: [rec(-1)] }, { records: [rec(1.5)] }, { records: [{ ...rec(1), seq: '1' }] },
    { records: [rec(Number.MAX_SAFE_INTEGER + 2)] },
    { records: [rec(1, '')] }, { records: [rec(1, 'Hook')] }, { records: [rec(1, 'a'.repeat(33))] }, { records: [rec(1, 'a b')] }, { records: [rec(1, 7)] },
    { records: [{ ...rec(1), ts: 'now' }] }, { records: [{ ...rec(1), ts: -1 }] },
    { records: [{ seq: 1, kind: 'hook', ts: 1 }] },
    { records: [], spool: { depth: -1 } }, { records: [], spool: { full: 'yes' } }, { records: [], spool: 'x' },
  ];
  for (const b of bad) assert.ok(validateBatch(b), `should refuse ${JSON.stringify(b)?.slice(0, 80)}`);
  assert.equal(validateBatch({ records: [rec(1), rec(9)] }), null);
  assert.equal(validateBatch({ records: [rec(1, 'status', null)], spool: { depth: 3, bytes: 10, full: true, dropped: 2 } }), null);
});

test('ingest throws on an invalid batch and leaves the mark where it was', () => {
  const s = open();
  s.ingest('cli_a', { records: [rec(1)] });
  assert.throws(() => s.ingest('cli_a', { records: [rec(5), rec(4)] }), /ascending/);
  assert.equal(s.highWater('cli_a'), 1);
  assert.deepEqual(s.records({ clientId: 'cli_a' }).map((x) => x.seq), [1]);
  s.closeDb();
});

test('spool full opens one episode per client, kept across reports, closed by a not-full report', () => {
  let t = 1000;
  const s = open({ now: () => t });
  assert.deepEqual(s.spoolFull(), []);
  s.ingest('cli_a', { records: [], spool: { depth: 9, bytes: 2_200_000_000, full: true, dropped: 4 } });
  t = 2000;
  s.ingest('cli_a', { records: [], spool: { depth: 9, bytes: 2_200_000_100, full: true, dropped: 6 } });
  assert.deepEqual(s.spoolFull(), [{ clientId: 'cli_a', sinceTs: 1000, lastTs: 2000, dropped: 6, bytes: 2_200_000_100 }]);
  // A report without the spool field leaves the episode alone.
  s.ingest('cli_a', { records: [rec(1)] });
  assert.equal(s.spoolFull().length, 1);
  s.ingest('cli_a', { records: [], spool: { depth: 0, bytes: 0, full: false, dropped: 0 } });
  assert.deepEqual(s.spoolFull(), []);
  t = 3000;
  s.ingest('cli_a', { records: [], spool: { full: true, dropped: 1, bytes: 5 } });
  assert.equal(s.spoolFull()[0].sinceTs, 3000, 'a later episode is a new episode');
  s.closeDb();
});

test('records() filters by client and by seq, oldest first, with a limit', () => {
  const s = open();
  s.ingest('cli_a', { records: [rec(1), rec(2), rec(3)] });
  s.ingest('cli_b', { records: [rec(1)] });
  assert.deepEqual(s.records({ clientId: 'cli_a', afterSeq: 1, limit: 1 }).map((x) => x.seq), [2]);
  assert.equal(s.records({}).length, 4);
  s.closeDb();
});

test('two handles on one kernel.db see the same marks (the server and a test both open it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapingest-')); tmpDirs.push(dir);
  const a = openTapIngest({ dbFile: path.join(dir, 'kernel.db') });
  const b = openTapIngest({ dbFile: path.join(dir, 'kernel.db') });
  a.ingest('cli_a', { records: [rec(3)] });
  assert.equal(b.highWater('cli_a'), 3);
  a.closeDb(); b.closeDb();
});

test('latestByKind returns the newest record of that kind per client, and creates its index', () => {
  const s = open();
  s.ingest('cli_a', { records: [rec(1, 'budget', { n: 1 }), rec(2, 'hook'), rec(3, 'budget', { n: 3 })] });
  s.ingest('cli_b', { records: [rec(1, 'hook'), rec(2, 'budget', { n: 9 })] });
  s.ingest('cli_c', { records: [rec(1, 'hook')] });
  const rows = s.latestByKind('budget');
  assert.deepEqual(rows.map((r) => [r.clientId, r.seq, r.payload.n]).sort(), [['cli_a', 3, 3], ['cli_b', 2, 9]]);
  assert.equal(rows[0].kind, 'budget');
  assert.equal(typeof rows[0].receivedTs, 'number');
  assert.deepEqual(s.latestByKind('nothing'), []);
  s.closeDb();
});

test('inbox retention: consumed kinds advance the mark but are not kept; other kinds keep the newest N per client', () => {
  const s = open();
  const out = s.ingest('c1', { records: [rec(1, 'otel'), rec(2, 'hook'), rec(3, 'otel')] });
  assert.deepEqual(out, { accepted: 3, duplicates: 0, highWater: 3 });
  assert.deepEqual(s.records({ clientId: 'c1' }).map((r) => r.seq), [2]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-ingest-keep-'));
  tmpDirs.push(dir);
  const k = openTapIngest({ dbFile: path.join(dir, 'kernel.db'), keepPerClient: 2 });
  k.ingest('c1', { records: [rec(1), rec(2), rec(3)] });
  k.ingest('c2', { records: [rec(1)] });
  k.ingest('c1', { records: [rec(4)] });
  assert.deepEqual(k.records({ clientId: 'c1' }).map((r) => r.seq), [3, 4]);
  assert.deepEqual(k.records({ clientId: 'c2' }).map((r) => r.seq), [1]);
  k.closeDb();
});
