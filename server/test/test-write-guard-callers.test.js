// server/test/test-write-guard-callers.test.js
// Phase C final review, M4: every testRealGitWriteRefused(...) call site in
// server.js must pass onResolveError: so an EPERM/ELOOP realpath failure
// (never the expected ENOENT case) reaches the adapter-health registry via
// reportMiss, not just console.error (test-write-guard.js's own default).
// Source-text scan, no AST: each call's options object (the text between its
// matching braces) must contain the literal `onResolveError`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverSource } from './helpers/server-source.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The options object following `testRealGitWriteRefused(<target>, ` - tracks
// brace depth from the opening `{` so a nested object/arrow body inside the
// options does not end the scan early.
function optionsObjectAt(text, afterIndex) {
  const openBrace = text.indexOf('{', afterIndex);
  if (openBrace === -1) return null;
  let depth = 0;
  for (let i = openBrace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(openBrace, i + 1); }
  }
  return null;
}

function findMissingOnResolveError(text) {
  const missing = [];
  const re = /testRealGitWriteRefused\(/g;
  let m;
  while ((m = re.exec(text))) {
    const opts = optionsObjectAt(text, m.index);
    const line = text.slice(0, m.index).split('\n').length;
    if (!opts || !opts.includes('onResolveError')) missing.push(line);
  }
  return missing;
}

test('the scanner itself flags a call with no onResolveError', () => {
  assert.deepEqual(findMissingOnResolveError('testRealGitWriteRefused(repo, { env });'), [1]);
});

test('the scanner accepts a call that wires onResolveError', () => {
  assert.deepEqual(findMissingOnResolveError("testRealGitWriteRefused(repo, { env, onResolveError: (r) => reportMiss('x', r) });"), []);
});

test('M4: every testRealGitWriteRefused call in server.js passes onResolveError, so EPERM/ELOOP reasons reach health', () => {
  const missing = findMissingOnResolveError(serverSource());
  assert.deepEqual(missing, [], `server.js and route modules, combined line ${missing.join(',')}: call(s) with no onResolveError`);
});
