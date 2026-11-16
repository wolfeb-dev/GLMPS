// server/test/fixtures/claude-dir.js
//
// Shared GLMPS_CLAUDE_DIR isolation fixture. Boot-time
// measurablesTick() -> computeSkillStaleCandidates() (server/server.js) scans
// P.claudeDir for installed skills on every startServer() call, regardless of
// what a given test is actually exercising. A test that spreads process.env
// into its own env object without overriding GLMPS_CLAUDE_DIR inherits whatever
// paths.js:29's fallback resolves to - the REAL ~/.claude on the machine
// running the suite - and its real skill-usage history can leak into what the
// test believes is an isolated run (see server/test/api-measurables.test.js's
// "boot-time skill-retire scan reads only this test's own GLMPS_CLAUDE_DIR"
// regression test for the reproduction and RED/GREEN evidence).
//
// Every startServer() (or spawned server.js) call whose env sets GLMPS_STATE_DIR
// must also set GLMPS_CLAUDE_DIR, via this one shared helper - not a copy pasted
// per file. server/test/no-ambient-claude-dir.test.js is the guard that keeps
// this true.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create a fresh, empty, isolated claudeDir for one test: no installed
 * skills, no session history, so measurablesTick()'s skill-retire scan finds
 * nothing to flag. Caller is responsible for fs.rmSync(claudeDir, { recursive:
 * true, force: true }) in its own finally block, matching the stateDir
 * cleanup convention already used throughout server/test.
 * @returns {string} the isolated claudeDir's absolute path
 */
export function claudeTmp() {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'));
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  return claudeDir;
}
