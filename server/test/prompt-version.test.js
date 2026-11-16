import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptVersionFor } from '../lib/evaluation/prompt-version.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-promptver-')); }

test('promptVersionFor returns prompt-none when no CLAUDE.md files exist', () => {
  const cwd = tmpDir();
  const homeDir = tmpDir();
  assert.equal(promptVersionFor({ cwd, homeDir }), 'prompt-none');
});

test('promptVersionFor returns prompt-none when called with no args', () => {
  assert.equal(promptVersionFor(), 'prompt-none');
  assert.equal(promptVersionFor({}), 'prompt-none');
});

test('promptVersionFor is stable for identical content', () => {
  const cwd = tmpDir();
  const homeDir = tmpDir();
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'global instructions v1');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'project instructions v1');

  const a = promptVersionFor({ cwd, homeDir });
  const b = promptVersionFor({ cwd, homeDir });
  assert.equal(a, b);
  assert.match(a, /^prompt-[0-9a-f]{8}$/);
});

test('promptVersionFor changes when the project CLAUDE.md changes', () => {
  const cwd = tmpDir();
  const homeDir = tmpDir();
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'global instructions v1');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'project instructions v1');
  const before = promptVersionFor({ cwd, homeDir });

  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'project instructions v2 \u2014 changed');
  const after = promptVersionFor({ cwd, homeDir });

  assert.notEqual(before, after);
});

test('promptVersionFor works with only the global CLAUDE.md present', () => {
  const homeDir = tmpDir();
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'global-only instructions');

  const tag = promptVersionFor({ homeDir });
  assert.match(tag, /^prompt-[0-9a-f]{8}$/);
  assert.notEqual(tag, 'prompt-none');
});

// Phase K final review (minors wave): a caller that already has
// getPaths()'s claudeDir (itself redirected off the real home in a test
// process) can pass it directly, instead of reconstructing it from homeDir +
// '.claude' - which would re-derive the WRONG dir whenever claudeDir isn't
// literally `${homeDir}/.claude` (an GLMPS_CLAUDE_DIR override, or the
// test-process redirect).
test('promptVersionFor: an explicit claudeDir alone (no cwd) is read directly, not re-derived from homeDir', () => {
  const claudeDir = tmpDir(); // NOT named '.claude', proving no homeDir + '.claude' join happens
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'global instructions via claudeDir');

  const tag = promptVersionFor({ claudeDir });
  assert.match(tag, /^prompt-[0-9a-f]{8}$/);
  assert.notEqual(tag, 'prompt-none');
});

test('promptVersionFor: claudeDir takes priority over homeDir when both are given', () => {
  const homeDir = tmpDir();
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'homeDir-derived instructions');

  const claudeDir = tmpDir();
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'claudeDir instructions');

  const viaClaudeDir = promptVersionFor({ claudeDir });
  const viaHomeDir = promptVersionFor({ homeDir });
  assert.notEqual(viaClaudeDir, viaHomeDir, 'different content must produce different tags');

  const withBoth = promptVersionFor({ homeDir, claudeDir });
  assert.equal(withBoth, viaClaudeDir, 'claudeDir must win when both are given');
});

test('promptVersionFor: a non-existent claudeDir with no cwd returns prompt-none, never falls back to homeDir', () => {
  const homeDir = tmpDir();
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'should never be read');
  const claudeDir = path.join(tmpDir(), 'does-not-exist');

  assert.equal(promptVersionFor({ claudeDir, homeDir }), 'prompt-none');
});
