// apps/shell/test/shell-log.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShellLog } from '../src/lib/shell-log.js';

test('appends one JSON line per call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-shell-log-'));
  const log = createShellLog({ dir, now: () => new Date('2026-09-23T10:00:00Z') });
  log('warn', 'settings', { kind: 'corrupt' });
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ ts: '2026-09-23T10:00:00.000Z', level: 'warn', msg: 'settings', data: { kind: 'corrupt' } }]);
});

test('rotates to shell.log.1 past maxBytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-shell-log-'));
  const log = createShellLog({ dir, maxBytes: 50 });
  log('info', 'a'.repeat(80));
  log('info', 'second');
  assert.equal(fs.existsSync(`${log.file}.1`), true);
  assert.match(fs.readFileSync(log.file, 'utf8'), /second/);
});

test('a failed write goes to the fallback sink, never silently', () => {
  const seen = [];
  const fsImpl = { mkdirSync() { throw new Error('EPERM'); } };
  const log = createShellLog({ dir: 'x', fsImpl, fallback: (s) => seen.push(s) });
  log('error', 'boom');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /shell log write failed \(EPERM\)/);
});
