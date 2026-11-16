// server/test/pre-compact-archive.test.js
// TDD - tests for hooks/pre-compact-archive.js's archiveTranscript + resolveArchiveRoot.
// Run: node --test server/test/pre-compact-archive.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveTranscript, resolveArchiveRoot } from '../../hooks/pre-compact-archive.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-pca-')); }

function writeTranscript(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Happy path

test('archives the transcript into <archiveRoot>/<sessionId>/<epochMs>-<trigger>.jsonl', () => {
  const srcDir = tmp();
  const archiveRoot = tmp();
  const transcriptPath = writeTranscript(srcDir, 'session.jsonl', '{"type":"user"}\n');

  const result = archiveTranscript({
    transcriptPath,
    sessionId: 'sess-1',
    trigger: 'manual',
    archiveRoot,
    now: () => 1700000000000,
  });

  assert.equal(result.archived, true);
  const expected = path.join(archiveRoot, 'sess-1', '1700000000000-manual.jsonl');
  assert.equal(result.path, expected);
  assert.ok(fs.existsSync(expected));
  assert.equal(fs.readFileSync(expected, 'utf8'), '{"type":"user"}\n');
});

test('also archives sibling subagent transcripts', () => {
  const srcDir = tmp();
  const archiveRoot = tmp();
  const transcriptPath = writeTranscript(srcDir, 'session.jsonl', '{"type":"user"}\n');
  // Subagent transcripts live at <transcriptPath-without-.jsonl>/subagents/agent-*.jsonl.
  const subDir = path.join(srcDir, 'session', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-abc.jsonl'), '{"type":"assistant"}\n');
  fs.writeFileSync(path.join(subDir, 'agent-def.jsonl'), '{"type":"assistant"}\n');

  const result = archiveTranscript({
    transcriptPath, sessionId: 'sess-sub', trigger: 'auto', archiveRoot, now: () => 1700000000005,
  });

  assert.equal(result.archived, true);
  assert.equal(result.subagents, 2);
  const files = fs.readdirSync(path.join(archiveRoot, 'sess-sub', 'subagents'));
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.startsWith('1700000000005-auto-agent-')));
});

test('sanitizes an unusual trigger value into the filename', () => {
  const srcDir = tmp();
  const archiveRoot = tmp();
  const transcriptPath = writeTranscript(srcDir, 'session.jsonl', 'a');

  const result = archiveTranscript({
    transcriptPath,
    sessionId: 'sess-2',
    trigger: 'weird/../trigger',
    archiveRoot,
    now: () => 1700000000001,
  });

  assert.equal(result.archived, true);
  assert.ok(!result.path.includes('..'));
  assert.ok(fs.existsSync(result.path));
});

// Missing / invalid transcript

test('returns archived:false when transcriptPath is missing', () => {
  const archiveRoot = tmp();
  const result = archiveTranscript({ transcriptPath: null, sessionId: 'sess-3', archiveRoot });
  assert.equal(result.archived, false);
  assert.equal(result.reason, 'no-transcript-path');
});

test('returns archived:false when transcriptPath does not exist on disk', () => {
  const archiveRoot = tmp();
  const result = archiveTranscript({
    transcriptPath: path.join(tmp(), 'does-not-exist.jsonl'),
    sessionId: 'sess-4',
    archiveRoot,
  });
  assert.equal(result.archived, false);
  assert.equal(result.reason, 'transcript-not-found');
});

test('never throws even with garbage input', () => {
  assert.doesNotThrow(() => archiveTranscript({}));
  assert.doesNotThrow(() => archiveTranscript({ transcriptPath: 123, archiveRoot: tmp() }));
});

// Dedupe guard

test('skips archiving when the most recent archive has the same byte size (unchanged)', () => {
  const srcDir = tmp();
  const archiveRoot = tmp();
  const transcriptPath = writeTranscript(srcDir, 'session.jsonl', '{"a":1}\n');

  const first = archiveTranscript({
    transcriptPath, sessionId: 'sess-5', trigger: 'auto', archiveRoot, now: () => 1000,
  });
  assert.equal(first.archived, true);

  // Same content/size, later timestamp -> should be skipped as unchanged.
  const second = archiveTranscript({
    transcriptPath, sessionId: 'sess-5', trigger: 'auto', archiveRoot, now: () => 2000,
  });
  assert.equal(second.archived, false);
  assert.equal(second.reason, 'unchanged');

  // Only the first archive file should exist.
  const files = fs.readdirSync(path.join(archiveRoot, 'sess-5'));
  assert.equal(files.length, 1);
});

test('archives again when the transcript size has changed since the last archive', () => {
  const srcDir = tmp();
  const archiveRoot = tmp();
  const transcriptPath = writeTranscript(srcDir, 'session.jsonl', '{"a":1}\n');

  const first = archiveTranscript({
    transcriptPath, sessionId: 'sess-6', trigger: 'auto', archiveRoot, now: () => 1000,
  });
  assert.equal(first.archived, true);

  // Grow the transcript (different byte size) before compacting again.
  fs.writeFileSync(transcriptPath, '{"a":1}\n{"b":2}\n', 'utf8');

  const second = archiveTranscript({
    transcriptPath, sessionId: 'sess-6', trigger: 'auto', archiveRoot, now: () => 2000,
  });
  assert.equal(second.archived, true);

  const files = fs.readdirSync(path.join(archiveRoot, 'sess-6'));
  assert.equal(files.length, 2);
});

// archiveRoot required (never defaults to the real home dir internally)

test('returns archived:false when archiveRoot is not provided', () => {
  const srcDir = tmp();
  const transcriptPath = writeTranscript(srcDir, 'session.jsonl', 'x');
  const result = archiveTranscript({ transcriptPath, sessionId: 'sess-7' });
  assert.equal(result.archived, false);
  assert.equal(result.reason, 'no-archive-root');
});

// resolveArchiveRoot: env override convention

test('resolveArchiveRoot honors GLMPS_TRANSCRIPT_ARCHIVE_DIR override', () => {
  const override = path.join(tmp(), 'custom-archive');
  const root = resolveArchiveRoot({ GLMPS_TRANSCRIPT_ARCHIVE_DIR: override });
  assert.equal(root, override);
});

// The home dir is injected: the real one may or may not hold ~/.glmps2, and
// the default follows whichever folder exists.
test('resolveArchiveRoot defaults under the legacy state folder when ~/.glmps2 is absent', () => {
  const home = tmp();
  const root = resolveArchiveRoot({}, { home });
  assert.equal(root, path.join(home, '.glmps', 'transcript-archive'));
});

test('resolveArchiveRoot defaults under ~/.glmps2 once it exists', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.glmps2'));
  const root = resolveArchiveRoot({}, { home });
  assert.equal(root, path.join(home, '.glmps2', 'transcript-archive'));
});

test('resolveArchiveRoot honors the state dir env override', () => {
  const stateDir = path.join(tmp(), 'state');
  const root = resolveArchiveRoot({ GLMPS_STATE_DIR: stateDir }, { home: tmp() });
  assert.equal(root, path.join(stateDir, 'transcript-archive'));
});
