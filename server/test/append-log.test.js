// Routes under test: server/lib/routes/guards-routes.js
// server/test/append-log.test.js
// the shared ndjson append log every guard writer
// (server.js's /api/guards/refusal route, hooks/plan-gate.js's fail-open
// log) uses, so growth is bounded and a torn line never blanks the rest, the
// same way in both places.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCapped, readCapped } from '../lib/observability/append-log.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-append-log-'));
  return { dir, file: path.join(dir, 'sub', 'log.ndjson') };
}

test('appendCapped writes one ndjson line per call, readCapped reads them back in order', () => {
  const { dir, file } = tmpFile();
  try {
    appendCapped(file, { a: 1 });
    appendCapped(file, { a: 2 });
    appendCapped(file, { a: 3 });
    assert.deepEqual(readCapped(file).map((r) => r.a), [1, 2, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readCapped skips a torn/corrupt line without blanking the rest', () => {
  const { dir, file } = tmpFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"a":1}\n{ this line is torn\n{"a":3}\n');
    assert.deepEqual(readCapped(file).map((r) => r.a), [1, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readCapped on a missing file returns an empty array, never throws', () => {
  const { dir, file } = tmpFile();
  try { assert.deepEqual(readCapped(file), []); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readCapped limits to the last N entries', () => {
  const { dir, file } = tmpFile();
  try {
    for (let i = 0; i < 5; i++) appendCapped(file, { i });
    assert.deepEqual(readCapped(file, { limit: 2 }).map((r) => r.i), [3, 4]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('appendCapped rotates once the file grows past maxBytes, keeping only the tail', () => {
  const { dir, file } = tmpFile();
  try {
    const big = 'x'.repeat(200);
    for (let i = 0; i < 20; i++) appendCapped(file, { i, big }, { maxBytes: 1000, maxLines: 5 });
    const rows = readCapped(file, { limit: 1000 });
    assert.ok(rows.length <= 5, `expected rotation to cap at 5 lines, got ${rows.length}`);
    assert.equal(rows[rows.length - 1].i, 19, 'the newest entry must survive rotation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Phase K final review (silent-failure): only a missing file is "no entries".
// Any other read failure throws a named error the caller must handle, never
// an empty list indistinguishable from "nothing happened".
test('readCapped: a read failure other than ENOENT throws a named error, not an empty array', () => {
  const { dir, file } = tmpFile();
  try {
    fs.mkdirSync(file, { recursive: true }); // a directory where the log should be: EISDIR
    assert.throws(() => readCapped(file), (e) => e.name === 'ReadCappedError' && /EISDIR|EPERM|unreadable/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
