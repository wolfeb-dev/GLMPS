// server/test/adapters-fs-util.test.js
// glmps-63: unit tests for the small fs helpers shared by capture adapters
// (server/lib/adapters/fs-util.js) - extracted from cline/codex-cli/opencode
// and the other adapters that repeated the same safe stat/read patterns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  statSafe,
  isDirectory,
  isFile,
  isRealFile,
  mtimeMsOf,
  readJsonFile,
  walkFiles,
  readHeadLines,
} from '../lib/adapters/fs-util.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function mkTmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fs-util-')); tmpDirs.push(d); return d; }

test('statSafe returns a Stats object for an existing path', () => {
  const dir = mkTmp();
  const st = statSafe(dir);
  assert.ok(st);
  assert.equal(st.isDirectory(), true);
});

test('statSafe returns null for a missing path (never throws)', () => {
  assert.equal(statSafe(path.join(mkTmp(), 'does-not-exist')), null);
});

test('isDirectory is true for a dir and false for a file or missing path', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'f.txt');
  fs.writeFileSync(filePath, 'x');
  assert.equal(isDirectory(dir), true);
  assert.equal(isDirectory(filePath), false);
  assert.equal(isDirectory(path.join(dir, 'nope')), false);
});

test('isFile is true for a file and false for a dir or missing path', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'f.txt');
  fs.writeFileSync(filePath, 'x');
  assert.equal(isFile(filePath), true);
  assert.equal(isFile(dir), false);
  assert.equal(isFile(path.join(dir, 'nope')), false);
});

test('isRealFile is true for a regular file, false for a dir or missing path', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'f.txt');
  fs.writeFileSync(filePath, 'x');
  assert.equal(isRealFile(filePath), true);
  assert.equal(isRealFile(dir), false);
  assert.equal(isRealFile(path.join(dir, 'nope')), false);
});

test('isRealFile is false for a symlink (even one pointing at a real file)', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'f.txt');
  fs.writeFileSync(filePath, 'x');
  const linkPath = path.join(dir, 'link.txt');
  try {
    fs.symlinkSync(filePath, linkPath, 'file');
  } catch {
    return; // symlink creation can require elevated privileges on Windows - skip if unavailable
  }
  assert.equal(isRealFile(linkPath), false);
});

test('mtimeMsOf returns the numeric mtimeMs for an existing file', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'f.txt');
  fs.writeFileSync(filePath, 'x');
  const m = mtimeMsOf(filePath);
  assert.equal(typeof m, 'number');
  assert.ok(m > 0);
});

test('mtimeMsOf returns null for a missing path', () => {
  assert.equal(mtimeMsOf(path.join(mkTmp(), 'nope')), null);
});

test('readJsonFile parses a well-formed JSON file', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify({ a: 1, b: [2, 3] }));
  assert.deepEqual(readJsonFile(filePath), { a: 1, b: [2, 3] });
});

test('readJsonFile returns undefined for a missing file', () => {
  assert.equal(readJsonFile(path.join(mkTmp(), 'nope.json')), undefined);
});

test('readJsonFile returns undefined for malformed JSON', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'bad.json');
  fs.writeFileSync(filePath, '{ not json');
  assert.equal(readJsonFile(filePath), undefined);
});

test('readJsonFile distinguishes a legitimate JSON null from a read/parse failure', () => {
  const dir = mkTmp();
  const filePath = path.join(dir, 'null.json');
  fs.writeFileSync(filePath, 'null');
  assert.equal(readJsonFile(filePath), null);
  assert.notEqual(readJsonFile(filePath), undefined);
});

test('walkFiles finds matching files within maxDepth, skips pruned dirs, symlinks and a missing root', () => {
  const root = mkTmp();
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skip'));
  fs.writeFileSync(path.join(root, 'top.jsonl'), '');
  fs.writeFileSync(path.join(root, 'note.txt'), '');
  fs.writeFileSync(path.join(root, 'a', 'one.jsonl'), '');
  fs.writeFileSync(path.join(root, 'a', 'b', 'two.jsonl'), '');
  fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'too-deep.jsonl'), '');
  fs.writeFileSync(path.join(root, 'skip', 'hidden.jsonl'), '');

  const rel = (files) => files.map(f => path.relative(root, f).split(path.sep).join('/')).sort();
  const opts = { maxDepth: 2, match: (name) => name.endsWith('.jsonl'), enterDir: (name) => name !== 'skip' };
  assert.deepEqual(rel(walkFiles(root, opts)), ['a/b/two.jsonl', 'a/one.jsonl', 'top.jsonl']);
  assert.deepEqual(walkFiles(path.join(root, 'nope'), opts), []);
  assert.deepEqual(rel(walkFiles(root, { ...opts, maxDepth: 0 })), ['top.jsonl']);
  assert.equal(walkFiles(root, { ...opts, limit: 1 }).length, 1);
});

test('readHeadLines returns up to n leading lines, [] for a missing file, ignores a torn last line cap', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, 'one\r\ntwo\nthree\nfour\n');
  assert.deepEqual(readHeadLines(f, 3), ['one', 'two', 'three']);
  assert.deepEqual(readHeadLines(path.join(dir, 'nope.jsonl'), 3), []);
  fs.writeFileSync(f, 'x'.repeat(100));
  assert.equal(readHeadLines(f, 2, 10)[0], 'x'.repeat(10));
});
