import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leasePath, readLease, writeLease, clearLease } from '../lib/governance/push-lease-store.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lease-'));
}

test('leasePath lives inside the supplied git common dir', () => {
  const d = tmpDir();
  assert.equal(leasePath(d), path.join(d, 'mc-push-lease.json'));
  // Inside .git means it can never be committed and needs no .gitignore entry.
  assert.ok(leasePath('/repo/.git').includes('.git'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('write then read round-trips the lease', () => {
  const d = tmpDir();
  const lease = { ref: 'main', sessionId: 'abc', cwd: 'D:/repo', acquiredAt: 5, renewedAt: 7 };
  writeLease(d, lease);
  assert.deepEqual(readLease(d), lease);
  fs.rmSync(d, { recursive: true, force: true });
});

test('reading a missing lease returns null', () => {
  const d = tmpDir();
  assert.equal(readLease(d), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('a corrupt lease file is treated as absent, not as a crash', () => {
  const d = tmpDir();
  fs.writeFileSync(leasePath(d), '{not json');
  assert.equal(readLease(d), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('writing replaces an existing lease and leaves no temp file behind', () => {
  const d = tmpDir();
  writeLease(d, { ref: 'main', sessionId: 'first', acquiredAt: 1 });
  writeLease(d, { ref: 'main', sessionId: 'second', acquiredAt: 2 });
  assert.equal(readLease(d).sessionId, 'second');
  const stray = fs.readdirSync(d).filter((f) => f !== 'mc-push-lease.json');
  assert.deepEqual(stray, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('clearLease removes the lease and is safe to call twice', () => {
  const d = tmpDir();
  writeLease(d, { ref: 'main', sessionId: 'abc', acquiredAt: 1 });
  clearLease(d);
  assert.equal(readLease(d), null);
  clearLease(d); // must not throw
  fs.rmSync(d, { recursive: true, force: true });
});

test('an unwritable dir fails soft rather than throwing', () => {
  // A guard that throws would brick every Bash call in the session.
  assert.doesNotThrow(() => writeLease(path.join(os.tmpdir(), 'mc-lease-does-not-exist-xyz'), { ref: 'main', sessionId: 'a' }));
  assert.equal(readLease(path.join(os.tmpdir(), 'mc-lease-does-not-exist-xyz')), null);
});
