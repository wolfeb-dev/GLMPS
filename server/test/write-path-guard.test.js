// Tests for server/lib/governance/write-path-guard.js - the single write-path
// guard shared by every vendor-file writer (cross-agent-memory push, governance
// policy push). The reason strings are part of the interface: they surface in
// push results over HTTP, so they are asserted verbatim here to catch drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeWritePathGuard } from '../lib/governance/write-path-guard.js';

const REPO = path.resolve(path.sep + 'repo');
const guard = makeWritePathGuard({ repoRoot: REPO });

test('rejects absolute paths', () => {
  assert.deepEqual(guard(path.join(REPO, 'x.md')), {
    allowed: false, reason: 'Path must be relative with no ".." components',
  });
});

test('rejects any ".." component', () => {
  assert.deepEqual(guard('../escape.md'), {
    allowed: false, reason: 'Path must be relative with no ".." components',
  });
});

test('rejects ".." anywhere in the string, even a plain filename', () => {
  // Pins the existing (aggressive) substring check: "a..b.md" is not a
  // traversal but has always been rejected, and byte-identical behavior is
  // the contract of the extraction.
  assert.equal(guard('a..b.md').allowed, false);
});

test('rejects secret / credential files', () => {
  assert.deepEqual(guard('conf/.env'), {
    allowed: false, reason: 'Secret / credential file',
  });
  assert.deepEqual(guard('keys/server.pem'), {
    allowed: false, reason: 'Secret / credential file',
  });
});

test('rejects protected and prod-zone paths', () => {
  assert.deepEqual(guard('prod/notes.md'), {
    allowed: false, reason: 'Protected or prod-zone path (zone: prod)',
  });
  assert.equal(guard('web-prod/index.html').allowed, false);
});

test('rejects writes into a configured live-install path', () => {
  const live = path.join(REPO, 'live-install');
  const g = makeWritePathGuard({ repoRoot: REPO, liveInstallPaths: live });
  const abs = path.resolve(REPO, 'live-install/bin/thing.dll');
  assert.deepEqual(g('live-install/bin/thing.dll'), {
    allowed: false, reason: `Write into live-install path: ${abs}`,
  });
});

test('a drive-relative path that resolves outside the root is rejected (win32)', { skip: process.platform !== 'win32' }, () => {
  // On Windows "Q:x.md" is not absolute and has no "..", but resolves onto
  // drive Q: - outside a repo root on another drive.
  const r = guard('Q:x.md');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'Path escapes REPO_ROOT');
});

test('allows an ordinary repo-relative file', () => {
  assert.deepEqual(guard('docs/agents/notes.md'), { allowed: true });
  assert.deepEqual(guard('CLAUDE.md'), { allowed: true });
});

test('one guard instance is reusable across calls', () => {
  assert.equal(guard('GEMINI.md').allowed, true);
  assert.equal(guard('conf/.env').allowed, false);
  assert.equal(guard('GEMINI.md').allowed, true);
});

test('review P4: a link inside the repo that points outside it cannot be written through', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wpg-'));
  try {
    const repo = path.join(base, 'repo');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(repo);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'link'), 'junction');
    const g = makeWritePathGuard({ repoRoot: repo });
    assert.deepEqual(g('link/CLAUDE.md'), { allowed: false, reason: 'Path escapes REPO_ROOT' });
    assert.deepEqual(g('link/new/dir/CLAUDE.md'), { allowed: false, reason: 'Path escapes REPO_ROOT' });
    assert.equal(g('docs/CLAUDE.md').allowed, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
