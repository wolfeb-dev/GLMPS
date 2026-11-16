// server/test/register-nightly-task.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'register-nightly-task.ps1');

// The task cannot be registered from a test, so the default is read from the
// param block. It follows the checkout the script runs from (card
// glmps-2-0-183), so a customer install never schedules someone else's path.
test('the nightly-task registrar defaults -RepoRoot to the checkout it runs from, with no drive path', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(/\[string\]\$RepoRoot\s*=\s*([^\r\n,]+)/);
  assert.ok(m, 'RepoRoot param default not found');
  assert.match(m[1], /Split-Path -Parent \$PSScriptRoot/);
  assert.doesNotMatch(m[1], /[A-Za-z]:\\/);
  assert.doesNotMatch(src, /D:\\(glmps|glmps)/);
});
