// server/test/no-ambient-claude-dir.test.js
//
// Guard: a test that boots a real server with
// GLMPS_STATE_DIR but never sets GLMPS_CLAUDE_DIR inherits the real ambient
// ~/.claude on whatever machine runs the suite (server/lib/paths.js:29's
// fallback), and boot-time measurablesTick() -> computeSkillStaleCandidates()
// can leak real skill-usage state into what the test believes is an isolated
// run (see api-measurables.test.js's "boot-time skill-retire scan reads only
// this test's own GLMPS_CLAUDE_DIR" regression test for the reproduction).
//
// This scans every server/test/*.test.js file at the source-text level (no
// AST parsing needed - the gap is a whole-file omission, not a per-call-site
// one) and fails, naming the offending file and line, if a file boots a real
// server (startServer(...) or a spawn of the real server/server.js, as
// opposed to a self-authored stand-in - see shadow-instance.test.js, which
// writes its own throwaway server.js and is correctly never flagged) while
// setting GLMPS_STATE_DIR without ever mentioning GLMPS_CLAUDE_DIR anywhere in the
// file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_FILE = path.basename(fileURLToPath(import.meta.url));

// A `//` comment marker on the line, not counting one that is part of
// `http://`/`https://` (those are preceded by `:`, a real `//` comment
// almost never is). Used to tell a genuine call from one only mentioned in a
// comment (see scut-room-mapper.test.js: its only "startServer(" text is
// inside a doc comment explaining why the module takes an injected env, not
// an actual call - that file never boots a server and needs no fix).
function commentStartIndex(line) {
  const m = /(?<!:)\/\//.exec(line);
  return m ? m.index : -1;
}

function hasRealMatchOnSomeLine(text, pattern) {
  for (const line of text.split('\n')) {
    const m = pattern.exec(line);
    pattern.lastIndex = 0; // pattern is reused per line; reset the global-flag cursor
    if (!m) continue;
    const cIdx = commentStartIndex(line);
    if (cIdx === -1 || cIdx > m.index) return true;
  }
  return false;
}

function bootsARealServer(text) {
  if (hasRealMatchOnSomeLine(text, /\bstartServer\s*\(/g)) return true;
  // A spawn() targeting a path ending in server.js counts too, UNLESS the
  // same file also authors its own throwaway server.js stand-in (a
  // self-contained fixture, not this repo's real server - see
  // shadow-instance.test.js's writeFileSync(..., 'server.js', ...)).
  const spawnsServerJs = hasRealMatchOnSomeLine(text, /spawn\([^)]*server\.js/g);
  const authorsOwnServerJs = /writeFileSync\([^;]*?server\.js/s.test(text);
  return spawnsServerJs && !authorsOwnServerJs;
}

function offendingLines(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => { if (line.includes('GLMPS_STATE_DIR')) out.push(i + 1); });
  return out;
}

test('every test that boots a real server with GLMPS_STATE_DIR also isolates GLMPS_CLAUDE_DIR', () => {
  const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js') && f !== SELF_FILE)
    .sort();
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, file), 'utf-8');
    if (!bootsARealServer(text)) continue;
    if (!text.includes('GLMPS_STATE_DIR')) continue;
    if (text.includes('GLMPS_CLAUDE_DIR')) continue; // isolated somewhere in the file
    offenders.push(`${file}:${offendingLines(text).join(',')}`);
  }
  assert.deepEqual(offenders, [],
    `test file(s) boot a real server with GLMPS_STATE_DIR but never set GLMPS_CLAUDE_DIR, ` +
    `so they inherit the real ambient ~/.claude: ${offenders.join('; ')}`);
});
