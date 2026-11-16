// Routes under test: server/lib/routes/guards-routes.js
// server/test/test-file-guard-hook.test.js
// K7 (D6 borrow c, decision 7): the append-only test-file guard. Pure
// functions (isTestFile, appendOnly, testGuardDecision) are tested directly.
// The fail-open error paths, the git-backed path resolution, and the bounded
// existing-file read are hook-level behavior and are tested by spawning the
// real hook script against a real (throwaway, temp-dir) git repo, with
// HOME/USERPROFILE/GLMPS_STATE_DIR/GLMPS_CLAUDE_DIR redirected and a stub HTTP
// server standing in for the kernel on an ephemeral port. Never the real
// 8123/8124, never a real git repo outside a temp dir - the same posture
// server/test/plan-gate-hook.test.js takes for Task 14's hook.
//
// Round 3 note: Edit/MultiEdit now evaluate at FILE level (C1), so every
// pure-function test below supplies `oldContent` even for Edit/MultiEdit -
// `resultTextFor` needs the real (or a stand-in) file text to find
// `old_string` in and reconstruct the edit's actual effect. Where a test
// does not care about surrounding file context, `oldContent` is simply set
// to the edit's own `old_string` (the fragment stands in for "the whole
// file"), which reproduces round 2's old per-fragment semantics exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestFile, appendOnly, testGuardDecision } from '../../hooks/test-file-guard.js';


test('test files by path', () => {
  for (const p of ['server/test/a.test.js', 'x/__tests__/b.js', 'a.spec.ts', 'plugins/gepa/test/test_x.py', 'tests/y.mjs']) assert.equal(isTestFile(p), true, p);
  for (const p of ['server/server.js', 'docs/test-plan.md', 'latest.js']) assert.equal(isTestFile(p), false, p);
});

// the directory/suffix/prefix regexes must be
// case-insensitive - repoRelativePath already lowercases on win32 before
// calling this, but isTestFile is exported and used standalone too, and
// must not silently depend on a caller normalizing case for it.
test('M1: isTestFile is case-insensitive (a mixed-case Windows path)', () => {
  assert.equal(isTestFile('Server/Test/X.Test.JS'), true);
  assert.equal(isTestFile('X/__TESTS__/b.js'), true);
  assert.equal(isTestFile('A.SPEC.TS'), true);
  // No test/tests/__tests__ directory segment here - only the test_ prefix
  // rule can match, so this specifically discriminates that rule's case.
  assert.equal(isTestFile('plugins/gepa/TEST_x.PY'), true);
  assert.equal(isTestFile('Docs/TEST-plan.MD'), false, '.md stays excluded regardless of case');
});

test('Edit may add around the old text but not change it', () => {
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'a\n', new_string: 'a\nb\n' }, oldContent: 'a\n' }).ok, true);
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'expect(1)', new_string: 'expect(2)' }, oldContent: 'expect(1)' }).ok, false);
  assert.equal(appendOnly({ tool: 'MultiEdit', input: { edits: [{ old_string: 'x', new_string: 'xy' }, { old_string: 'q', new_string: 'r' }] }, oldContent: 'x\nq' }).ok, false);
});

test('Write over an existing file must keep every old line in order', () => {
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\nnew\nl2\nl3\n' }, oldContent: 'l1\nl2\nl3\n' }).ok, true);
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\nl3\n' }, oldContent: 'l1\nl2\nl3\n' }).ok, false);
});

test('only debug cards are guarded; new test files pass; the board being down fails open', () => {
  const base = { tool: 'Edit', input: { old_string: 'a', new_string: 'b' }, oldContent: 'a', relPath: 'server/test/x.test.js', exists: true };
  assert.equal(testGuardDecision({ ...base, chain: { id: 'c', taskClass: 'feature' } }).allow, true);
  const d = testGuardDecision({ ...base, chain: { id: 'c', taskClass: 'debug' } });
  assert.equal(d.allow, false); assert.match(d.reason, /bug fix.*only add new test cases/);
  assert.equal(testGuardDecision({ ...base, exists: false, chain: { id: 'c', taskClass: 'debug' } }).allow, true);
  const open = testGuardDecision({ ...base, chain: null, unavailable: 'board unreachable' });
  assert.equal(open.allow, true); assert.equal(open.failOpen, true);
});

// fetchChain's 404 maps to unknownCard, not
// unavailable - mirrors plan-gate.js's planGateDecision, which fails open
// with its own named reason for exactly this case rather than silently
// falling through the generic "no chain" allow. (Checked before appendOnly
// ever runs, so no oldContent is needed here.)
test('C1 (round 1): an unknown card (404) fails open with a named reason, not a silent allow', () => {
  const base = { tool: 'Edit', input: { old_string: 'a', new_string: 'b' }, relPath: 'server/test/x.test.js', exists: true };
  const d = testGuardDecision({ ...base, chain: null, unknownCard: true });
  assert.equal(d.allow, true);
  assert.equal(d.failOpen, true);
  assert.match(d.reason, /unknown card/);
});

// linesInOrder/appendOnly must normalise CRLF line
// endings, per-line trailing whitespace, and a dropped final newline before
// comparing - none of those changes the test's actual meaning, and denying
// them (as the original exact-line comparison did) falsely accuses a benign
// edit of weakening a test. A genuine dropped line must still be denied.
test('C2 (round 1): benign CRLF/whitespace/final-newline normalisation is never mistaken for lost content (Write)', () => {
  // CRLF -> LF, plus a genuinely appended line.
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\r\nl2\r\nnew\r\n' }, oldContent: 'l1\nl2\n' }).ok, true);
  // Trailing whitespace stripped from an existing line.
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\nl2\nnew\n' }, oldContent: 'l1\nl2  \n' }).ok, true);
  // The final newline dropped.
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\nl2\nnew' }, oldContent: 'l1\nl2\n' }).ok, true);
  // A genuine dropped line must still be denied.
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\nnew\n' }, oldContent: 'l1\nl2\n' }).ok, false);
});

// the realistic CRLF case is an LF old_string against a CRLF
// file on disk - the real Edit tool reads the file with CRLF folded to LF
// before matching, so the model only ever sends LF. (The round-1 version of
// this test used a CRLF old_string on a CRLF file, which the real tool never
// sees, and so hid the round-3 regression.)
test('C2 (round 1): the same normalisation applies to the Edit/MultiEdit containment check', () => {
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'a\nb\n', new_string: 'a\nb\nc\n' }, oldContent: 'a\r\nb\r\n' }).ok, true);
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'a\nb\n', new_string: 'a\nc\n' }, oldContent: 'a\r\nb\r\n' }).ok, false, 'an LF old_string on a CRLF file is really matched and judged');
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'a  \n', new_string: 'a\nb\n' }, oldContent: 'a  \n' }).ok, true);
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'a\nb', new_string: 'a\nb\nc' }, oldContent: 'a\nb' }).ok, true, 'a dropped final newline on old_string itself');
  assert.equal(appendOnly({ tool: 'MultiEdit', input: { edits: [{ old_string: 'x\n', new_string: 'x\ny\n' }] }, oldContent: 'x\r\n' }).ok, true);
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: 'expect(1)\n', new_string: 'expect(2)\n' }, oldContent: 'expect(1)\n' }).ok, false, 'a real content change is still denied');
});

// Round 2 judged an Edit/MultiEdit's position against old_string/new_string
// ALONE, with no idea what (if anything) followed it in the real file - an
// insertion genuinely mid-file (more kept content still follows it) looked
// identical to a harmless trailing append, since the isolated fragment has
// nothing after it either way. resultTextFor now reconstructs the edit's
// actual effect on the WHOLE file (oldContent), closing this for good.

test('C1 (round 3): a return inserted after setup(), with a kept assertion still following it, is denied', () => {
  const oldContent = "test('a', () => {\n  setup();\n  expect(1).toBe(1);\n});\n";
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: '  setup();\n', new_string: '  setup();\n  return;\n' },
    relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('C1 (round 3): the fragment case - a return appended mid-line to a fragment is denied once file context shows a kept line still follows', () => {
  const oldContent = "test('a', () => {\n  expect(x).toBe(1);\n  expect(y).toBe(2);\n});\n";
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: 'expect(x).toBe(1);', new_string: 'expect(x).toBe(1);\nreturn;' },
    relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('C1 (round 3): the MultiEdit form of the mid-file return is denied the same way', () => {
  const oldContent = "test('a', () => {\n  setup();\n  expect(1).toBe(1);\n});\n";
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'MultiEdit',
    input: { edits: [{ old_string: '  setup();\n', new_string: '  setup();\n  return;\n' }] },
    relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

// "not found" is no longer a silent allow - the fragment is
// judged, and a passing fragment allows WITH a named fail-open reason.
test('C1 (round 3) / I2 (round 4): old_string not found in oldContent judges the fragment and allows with a named reason', () => {
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: 'not present anywhere', new_string: 'not present anywhere\nreturn;' },
    relPath: 'server/test/x.test.js', exists: true, oldContent: 'test(1);\n',
  });
  assert.equal(d.allow, true);
  assert.equal(d.failOpen, true);
  assert.match(d.reason, /old_string not found in file; judged the fragment/);
});

// Supersedes round 2's position-aware KEYWORD scan for interleaved lines
// (still bypassable by keyword-free neutering like `false &&`, or wrapping a
// kept line in a brand-new function - see the round-3 findings). Any added
// line before the first kept line, or between two kept lines, is now denied
// OUTRIGHT, whatever it contains - there is no keyword list for interleaved
// lines any more.

test('interleaved: an "if" statement inserted before a kept line is denied (the POSITION alone, not the keyword)', () => {
  const oldContent = 'expect(1).toBe(1);\n';
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: 'if (x) {}\nexpect(1).toBe(1);\n' }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('interleaved: a return statement inserted before a kept line is denied', () => {
  const oldContent = "test('a', () => {\n  expect(1).toBe(1);\n});\n";
  const newContent = "test('a', () => {\n  return;\n  expect(1).toBe(1);\n});\n";
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('interleaved: a comment line inserted before a kept line is denied, even though it is harmless on its own', () => {
  const oldContent = 'expect(1).toBe(1);\n';
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: '// a note\nexpect(1).toBe(1);\n' }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('interleaved: a plain, entirely ordinary new test inserted BETWEEN two kept tests is still denied (position alone, no dangerous content at all)', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\ntest('z', () => { expect(2).toBe(2); });\n";
  const newContent = "test('a', () => { expect(1).toBe(1); });\ntest('new', () => { expect(3).toBe(3); });\ntest('z', () => { expect(2).toBe(2); });\n";
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
  assert.match(d.reason, /First inserted line, line 2 of the resulting file: test\('new'/);
});

// I3, reworded in round 4: name the card, the position, the
// remedy, and the first NON-BLANK offending line with its 1-based line
// number - checked against the exact wording.
test('I3 (round 3) / round 4: the interleaved deny message names the card, the position, the remedy, and the offending line with its number', () => {
  const oldContent = 'expect(1).toBe(1);\n';
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: 'setup();\nexpect(1).toBe(1);\n' }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
  assert.equal(
    d.reason,
    'Card c is a bug fix, so existing test files are append-only: new code inserted before or between existing lines of a test file is refused while this card is a debug card; add new tests and helpers after the last existing line of the file instead. First inserted line, line 1 of the resulting file: setup();',
  );
});

test('round 4: the interleaved deny message skips blank inserted lines and reports the first non-blank one with its line number', () => {
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: 'l1\n\nsetup();\nl2\n' }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'l1\nl2\n',
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /First inserted line, line 3 of the resulting file: setup\(\);$/);
});

test('round 4: an interleaved insertion of only blank lines is named as a blank line, with its line number', () => {
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: 'l1\n\nl2\n' }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'l1\nl2\n',
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /First inserted line, line 2 of the resulting file: \(a blank line\)$/);
});


test('PROBE: a // line-comment "hiding" a kept assertion is denied (line-level containment closes the substring bypass)', () => {
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: 'expect(1).toBe(1);\n', new_string: '// expect(1).toBe(1);\n' },
    relPath: 'server/test/x.test.js', exists: true, oldContent: 'expect(1).toBe(1);\n',
  });
  // Denied via appendOnly itself: "// expect(1).toBe(1);" is not the SAME
  // whole line as "expect(1).toBe(1);", so the old line is gone, not merely
  // wrapped - a real content loss.
  assert.equal(d.allow, false);
});

test('PROBE: a same-line "setup(); return;" before a kept assertion is denied (now via the outright interleaved rule)', () => {
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: 'expect(1).toBe(1);\n', new_string: 'setup(); return;\nexpect(1).toBe(1);\n' },
    relPath: 'server/test/x.test.js', exists: true, oldContent: 'expect(1).toBe(1);\n',
  });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('PROBE: if (!true) and if (1 === 2) wrapping a kept assertion are both denied (position alone, no keyword needed)', () => {
  const oldContent = 'expect(1).toBe(1);';
  const d1 = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: 'expect(1).toBe(1);', new_string: 'if (!true) {\nexpect(1).toBe(1);\n}' },
    relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  const d2 = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Edit',
    input: { old_string: 'expect(1).toBe(1);', new_string: 'if (1 === 2) {\nexpect(1).toBe(1);\n}' },
    relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d1.allow, false);
  assert.equal(d2.allow, false);
});

test('PROBE: a new helper function using return, appended after all old content, is allowed (position-aware, was a round-1 false positive)', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}\nfunction makeFixture() {\n  return { x: 1 };\n}\n\ntest('b', () => { expect(makeFixture().x).toBe(1); });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, true);
});

test('PROBE: .only() appended after all old content is still denied (can silently disable every OTHER test)', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}\ntest.only('b', () => { expect(2).toBe(2); });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('PROBE: process.exit( appended after all old content is still denied', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}\nif (process.env.STOP) process.exit(1);\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('PROBE: a token inside a string literal, appended after all kept lines, is allowed (position-aware, not content-aware)', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}\ntest('flags xit as deprecated', () => { expect(lint("xit('skip me')")).toEqual(['deprecated']); });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, true);
});

// Genuinely new, appended code is only denied for tokens that can disable
// OTHER, unrelated tests - not just this file's own history.

test('I2: a top-level lifecycle hook appended after all kept lines is denied (runs for every test, old and new alike)', () => {
  const oldContent = "test('kept', () => { });\n";
  const newContent = `${oldContent}beforeEach(() => { throw new Error('boom'); });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('I2: a lifecycle hook NESTED inside a new describe() stays legal (only a TOP-LEVEL hook is denied)', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}describe('new group', () => {\n  beforeEach(() => { setup(); });\n  test('b', () => { expect(2).toBe(2); });\n});\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, true);
});

test('I2: reassigning a test-framework global appended after all kept lines is denied', () => {
  const oldContent = "test('kept', () => { assert.equal(1, 2); });\n";
  const newContent = `${oldContent}assert.equal = () => {};\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('I2: patching assert/expect via Object.defineProperty/assign/setPrototypeOf appended is denied', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}Object.defineProperty(assert, 'equal', { value: () => {} });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('I2: mocking assert/expect via mock.method appended is denied', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}mock.method(assert, 'equal', () => {});\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('I2: beforeEach((t) => t.skip()) appended is denied (matches the reviewer\'s own skiphook.test.mjs example)', () => {
  const oldContent = "test('kept', () => { assert.equal(1, 2); });\n";
  const newContent = `${oldContent}beforeEach((t) => { t.skip(); });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

// the t.skip( pattern is gone. t.skip() only reaches an OLD
// test from inside a top-level hook, which the column-0 hook rule already
// denies; inside a new test body it skips only that new test.
test('round 4: t.skip() inside a new appended TEST body is allowed (it can only skip that new test)', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}test('b', (t) => { t.skip(); });\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, true);
});

test('I2: test.skip()/it.skip()/describe.skip() appended is allowed - t.skip() is a distinct pattern, not these', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  for (const call of ["test.skip('b', () => {});", "it.skip('b', () => {});", "describe.skip('b', () => {});"]) {
    const newContent = `${oldContent}${call}\n`;
    const d = testGuardDecision({
      chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
      input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
    });
    assert.equal(d.allow, true, call);
  }
});


test('PROBE (accepted limit, I3 template literal): trailing whitespace inside a multi-line template literal is normalised away like any other line', () => {
  // Documented, accepted limitation: this whitespace is part of the
  // template literal's actual runtime string value, not incidental
  // formatting - but distinguishing "inside a template literal" from an
  // ordinary code line needs real parsing, not a line-based text diff. The
  // realistic editor-reformatting case (trailing whitespace on ordinary
  // code, CRLF) that this guard exists to allow matters far more than this
  // narrow one.
  const oldStr = '  const expected = `first line   \nsecond line`;\n';
  const newStr = '  const expected = `first line\nsecond line`;\n';
  assert.notEqual(oldStr, newStr, 'sanity: the two strings really do differ');
  assert.equal(appendOnly({ tool: 'Edit', input: { old_string: oldStr, new_string: newStr }, oldContent: oldStr }).ok, true);
});

test('PROBE (accepted limit): a decoy copy of an old block inside a template literal is a known fragility, not a guaranteed catch', () => {
  // Documented, accepted limitation: diffLines is a greedy, first-match
  // line diff. If a Write's added text happens to contain an EARLIER,
  // verbatim copy of an old kept block (e.g. inside a template-literal
  // fixture) before the real, modified copy, the greedy match can pair the
  // old block against the DECOY rather than the real copy - a real parser
  // tracking template-literal boundaries would be needed to close this
  // properly. In THIS construction the deny still lands (the decoy's own
  // setup line is itself interleaved before the matched line), but that is
  // not guaranteed for every possible construction - accepted rather than
  // chased further.
  const oldContent = "test('a', () => {\n  expect(1).toBe(1);\n});\n";
  const newContent = `const decoy = \`\n${oldContent}\`;\ntest('a', () => {\n  return;\n  expect(1).toBe(1);\n});\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, false);
});

test('PROBE (accepted limit): an appended import statement is allowed, even though ES module imports are hoisted and would run before existing code', () => {
  const oldContent = "test('a', () => { expect(1).toBe(1); });\n";
  const newContent = `${oldContent}import h from './do.js';\n`;
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: newContent }, relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, true);
});

// M-b: exactly one trailing empty line is insignificant, not every one -

test('M-b (round 2): dropping trailing blank lines beyond the final newline is denied (a real content loss)', () => {
  // oldContent has TWO blank lines after "l1" (three trailing newlines);
  // newContent has none. Only the single, final "the file ends with a
  // newline" empty line is insignificant - the other blank line is real
  // content, and dropping it must still be denied.
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\n' }, oldContent: 'l1\n\n\n' }).ok, false);
});

test('M-b (round 2): a genuinely single trailing newline on both sides is still fine', () => {
  assert.equal(appendOnly({ tool: 'Write', input: { content: 'l1\nl2\n' }, oldContent: 'l1\nl2\n' }).ok, true);
});


test('position: an ordinary appended assertion is still allowed', () => {
  const oldContent = 'expect(1).toBe(1);\n';
  const d = testGuardDecision({
    chain: { id: 'c', taskClass: 'debug' }, tool: 'Write',
    input: { content: 'expect(1).toBe(1);\nexpect(2).toBe(2);\n' },
    relPath: 'server/test/x.test.js', exists: true, oldContent,
  });
  assert.equal(d.allow, true);
});

// The real Edit tool reads the file with CRLF folded to LF, matches the
// model's LF old_string, then writes CRLF back. Round 3 matched raw CRLF
// bytes, so any multi-line LF old_string on a CRLF file was "not found" and
// silently allowed - including an outright assertion rewrite (t15-r3/crlf.mjs
// and probe.mjs, as committed tests).

const debugChain = { id: 'c', taskClass: 'debug' };
const crlfFile = "test('a', () => {\r\n  setup();\r\n  expect(1).toBe(1);\r\n});\r\n";
const decideOn = (oldContent, tool, input) => testGuardDecision({ chain: debugChain, tool, input, relPath: 'server/test/x.test.js', exists: true, oldContent });

test('C1 (round 4): an outright assertion rewrite with an LF old_string on a CRLF file is denied (Edit)', () => {
  const d = decideOn(crlfFile, 'Edit', { old_string: '  expect(1).toBe(1);\n});', new_string: '  expect(2).toBe(2);\n});' });
  assert.equal(d.allow, false);
  assert.match(d.reason, /changes or removes existing test text/);
});

test('C1 (round 4): an outright assertion rewrite with an LF old_string on a CRLF file is denied (MultiEdit)', () => {
  const d = decideOn(crlfFile, 'MultiEdit', { edits: [{ old_string: '  expect(1).toBe(1);\n});', new_string: '  expect(2).toBe(2);\n});' }] });
  assert.equal(d.allow, false);
  assert.match(d.reason, /changes or removes existing test text/);
});

test('C1 (round 4): a return inserted mid-file with an LF old_string on a CRLF file is denied (Edit, probe A)', () => {
  const d = decideOn(crlfFile, 'Edit', { old_string: '  setup();\n', new_string: '  setup();\n  return;\n' });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
  assert.match(d.reason, /line 3 of the resulting file:   return;$/);
});

test('C1 (round 4): a return inserted mid-file with an LF old_string on a CRLF file is denied (MultiEdit)', () => {
  const d = decideOn(crlfFile, 'MultiEdit', { edits: [{ old_string: '  setup();\n', new_string: '  setup();\n  return;\n' }] });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('C1 (round 4): wrapping a kept assertion in if (0) via a multi-line LF old_string on a CRLF file is denied', () => {
  const d = decideOn(crlfFile, 'Edit', { old_string: '  setup();\n  expect(1).toBe(1);', new_string: '  setup();\n  if (0) expect(1).toBe(1);' });
  assert.equal(d.allow, false);
});

test('C1 (round 4): a single-line old_string on a CRLF file still judges the same-line return', () => {
  const d = decideOn(crlfFile, 'Edit', { old_string: '  setup();', new_string: '  setup(); return;' });
  assert.equal(d.allow, false);
});

test('C1 (round 4): a CRLF old_string on an LF file is folded too, and a mid-file return is denied at file level', () => {
  const lfFile = crlfFile.replace(/\r\n/g, '\n');
  const d = decideOn(lfFile, 'Edit', { old_string: '  setup();\r\n', new_string: '  setup();\r\n  return;\r\n' });
  assert.equal(d.allow, false);
  assert.match(d.reason, /line 3 of the resulting file/);
});

test('C1 (round 4): a genuine append with an LF old_string on a CRLF file is allowed at file level (no fail-open)', () => {
  const d = decideOn(crlfFile, 'Edit', { old_string: '  expect(1).toBe(1);\n});\n', new_string: "  expect(1).toBe(1);\n});\ntest('b', () => {\n  expect(2).toBe(2);\n});\n" });
  assert.equal(d.allow, true);
  assert.equal(d.failOpen, undefined, 'found and judged at file level, not the fragment fallback');
});

// The real tool also matches curly quotes against straight ones (and swaps
// \uXXXX escapes), so "not found by an exact match" does not mean the call
// will fail. Curly/straight quotes are matched here too, at file level;
// anything still not found has its old_string/new_string FRAGMENT judged by
// the same line-level and position rule.

const quoteFile = "test('a', () => {\n  setup('x');\n  expect(f('x')).toBe(1);\n});\n";

test('I2 (round 4): a curly-quote old_string with a weakening new_string is denied', () => {
  const d = decideOn(quoteFile, 'Edit', { old_string: '  expect(f(\u2018x\u2019)).toBe(1);', new_string: '  expect(f(\u2018x\u2019)).toBe(2);' });
  assert.equal(d.allow, false);
});

test('I2 (round 4): a curly-quote old_string whose new_string appends a new test is allowed', () => {
  // The first case's old_string itself carries curly quotes ('x') against the
  // file's straight ones ('x'), so an exact match fails and the curly/straight
  // quote fold is what actually finds it - a straight-quote old_string like
  // '});\n' would match without ever exercising the fold this test names.
  const d = decideOn(quoteFile, 'Edit', { old_string: '  expect(f(\u2018x\u2019)).toBe(1);\n});\n', new_string: "  expect(f(\u2018x\u2019)).toBe(1);\n});\ntest(\u2018b\u2019, () => {});\n" });
  assert.equal(d.allow, true);
  const d2 = decideOn("test('a', () => {});\n", 'Edit', { old_string: 'test(\u2018a\u2019, () => {});', new_string: 'test(\u2018a\u2019, () => {});\ntest(\u2018b\u2019, () => {});' });
  assert.equal(d2.allow, true);
});

test('I2 (round 4): a curly-quote old_string cannot hide a mid-file return behind the fragment view (located at file level)', () => {
  const d = decideOn(quoteFile, 'Edit', { old_string: '  setup(\u2018x\u2019);', new_string: '  setup(\u2018x\u2019);\n  return;' });
  assert.equal(d.allow, false);
  assert.match(d.reason, /before or between/);
});

test('I2 (round 4): an old_string not found at all, with a weakening fragment, is denied', () => {
  const d = decideOn(quoteFile, 'Edit', { old_string: '  expect(g(1)).toBe(1);', new_string: '  // expect(g(1)).toBe(1);' });
  assert.equal(d.allow, false);
});

test('I2 (round 4): an old_string not found at all, with a fragment that inserts before a kept fragment line, is denied', () => {
  const d = decideOn(quoteFile, 'Edit', { old_string: '  expect(g(1)).toBe(1);', new_string: '  return;\n  expect(g(1)).toBe(1);' });
  assert.equal(d.allow, false);
  assert.match(d.reason, /line 1 of the edit's new_string:   return;$/);
});

test('I2 (round 4): a MultiEdit with one edit not found judges every fragment and denies a weakening one', () => {
  const d = decideOn(quoteFile, 'MultiEdit', { edits: [
    { old_string: '});\n', new_string: "});\ntest('b', () => {});\n" },
    { old_string: '  expect(g(1)).toBe(1);', new_string: '  expect(g(1)).toBe(2);' },
  ] });
  assert.equal(d.allow, false);
});

test('I2 (round 4): a MultiEdit with one edit not found and only appending fragments allows with a named reason', () => {
  const d = decideOn(quoteFile, 'MultiEdit', { edits: [
    { old_string: '});\n', new_string: "});\ntest('b', () => {});\n" },
    { old_string: 'nowhere();', new_string: 'nowhere();\nalsoNew();' },
  ] });
  assert.equal(d.allow, true);
  assert.equal(d.failOpen, true);
  assert.match(d.reason, /old_string not found in file; judged the fragment/);
});


for (const line of [
  "test('n', t => { assert.ok(true); });",
  'const names = tests.map(t => t.name);',
  'for (let t = 0; t < 3; t++) {}',
  'opts.it = 1;',
]) {
  test(`I3 (round 4): appended ordinary code is allowed: ${line}`, () => {
    const oldContent = "test('kept', () => { assert.equal(add(1, 2), 3); });\n";
    const d = decideOn(oldContent, 'Write', { content: `${oldContent}${line}\n` });
    assert.equal(d.allow, true, d.reason);
  });
}

// Accepted limits: the appended denylist is heuristic, not
// exhaustive. These record the CURRENT (allowed) behaviour so a future
// change to it is a deliberate one.
for (const line of [
  "assert['equal'] = () => {};",
  "Reflect.set(assert, 'equal', () => {});",
  'Object.defineProperties(assert, { equal: { value: () => {} } });',
  'const a = assert; a.equal = () => {};',
  'const bE = beforeEach; bE(() => { throw new Error(); });',
  '  beforeEach(() => { throw new Error(); });',
  "mock.method(lib, 'add', () => 3);",
]) {
  test(`accepted limit (round 4): appended ${line} is not caught`, () => {
    const oldContent = "test('kept', () => { assert.equal(lib.add(1, 2), 3); });\n";
    const d = decideOn(oldContent, 'Write', { content: `${oldContent}${line}\n` });
    assert.equal(d.allow, true);
  });
}

test('I3 (round 4): reassigning expect itself, appended, is still denied', () => {
  const oldContent = "test('kept', () => { expect(1).toBe(1); });\n";
  const d = decideOn(oldContent, 'Write', { content: `${oldContent}expect = () => ({ toBe() {} });\n` });
  assert.equal(d.allow, false);
  assert.match(d.reason, /Card c is a bug fix/);
});


const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const hookScript = path.join(repoRoot, 'hooks', 'test-file-guard.js');

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-file-guard-'));
  try { return await fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function gitBin(cwd) {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGitRepo(dir) {
  const git = gitBin(dir);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  git(['add', '.gitkeep']);
  git(['commit', '-q', '-m', 'initial commit']);
  return git;
}

function startStubKernel({ onChain } = {}) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ method: req.method, url: req.url, body });
        if (req.url.endsWith('/chain')) return onChain(req, res);
        if (req.url === '/api/guards/refusal') { res.writeHead(204); return res.end(); }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      calls,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

function chainResponse(res, taskClass) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: null, taskClass }));
}

function baseEnv(home, stateDir, port) {
  return {
    ...process.env,
    HOME: home, USERPROFILE: home,
    GLMPS_CLAUDE_DIR: path.join(home, '.claude'),
    GLMPS_STATE_DIR: stateDir,
    GLMPS_CARD_ID: 'mc-1',
    GLMPS_PORT: String(port),
    // Generous on purpose: a loaded Windows CI runner has taken over 2 s for
    // the hook's git calls. Tests of the timeouts set their own short value.
    GLMPS_HOOK_HTTP_TIMEOUT_MS: '5000',
    GLMPS_HOOK_GIT_TIMEOUT_MS: '20000',
    // Phase K final I6: GLMPS_BOARD_URL outranks GLMPS_PORT; never let an
    // ambient one steer these tests away from their own stub port.
    GLMPS_BOARD_URL: undefined,
  };
}

// Async spawn, not execFileSync: the stub kernel lives in THIS process, and a
// synchronous spawn would block this process's event loop for the child's
// whole lifetime, so the stub could never accept or answer the child's
// request - an artificial deadlock, not a real product behavior.
function runHook(env, { cwd, toolName, filePath, extra = {}, sessionId = 'sess-1' }) {
  const toolInput = { file_path: path.join(cwd, filePath), ...extra };
  const input = { cwd, tool_name: toolName, tool_input: toolInput, session_id: sessionId };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(JSON.stringify(input));
  });
}

function readFailOpenLines(stateDir) {
  const f = path.join(stateDir, 'guards', 'fail-open.ndjson');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}


test('hook: a new test file is always allowed on a debug card, and never needs the board', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'new.test.js'),
        extra: { old_string: 'a', new_string: 'b' },
      });
      assert.equal(stdout.trim(), '', 'a new test file is always allowed, silently');
      assert.equal(stub.calls.filter((c) => c.url.endsWith('/chain')).length, 0, 'a new file never needs the chain at all');
    } finally { await stub.close(); }
  });
});

test('hook: an existing test file may be freely edited on a non-debug card', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'feature') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.equal(stdout.trim(), '', 'a feature card is never guarded');
    } finally { await stub.close(); }
  });
});

test('hook: a debug card Edit that only appends around old text is allowed', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);\n', new_string: 'expect(1).toBe(1);\nexpect(2).toBe(2);\n' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'appending around unchanged old text must be allowed');
    } finally { await stub.close(); }
  });
});

test('hook: a debug card Edit that changes existing test text is denied, exactly the documented PreToolUse shape', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      const parsed = JSON.parse(stdout);
      assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(typeof parsed.hookSpecificOutput.permissionDecisionReason, 'string');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /bug fix.*only add new test cases/);
      const lines = readFailOpenLines(stateDir);
      assert.equal(lines.length, 0, 'a real deny is not a fail-open');
    } finally { await stub.close(); }
  });
});

test('hook: a debug card MultiEdit with one violating edit is denied', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "a\nq\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'MultiEdit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { edits: [{ old_string: 'a', new_string: 'ab' }, { old_string: 'q', new_string: 'r' }] },
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    } finally { await stub.close(); }
  });
});

test('hook: a debug card Write that appends a line AFTER every existing line is allowed', async () => {
  // append-only now literally means append - a new line landing
  // BETWEEN existing lines (even an entirely ordinary one) is denied
  // outright (see the "interleaved" tests above); only a line placed AFTER
  // every existing line is allowed.
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "l1\nl2\nl3\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Write', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { content: 'l1\nl2\nl3\nnew\n' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'appending a line after every existing line must be allowed');
    } finally { await stub.close(); }
  });
});

test('hook: a debug card Write that inserts a line BETWEEN existing lines is denied, even though every old line is preserved in order', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "l1\nl2\nl3\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Write', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { content: 'l1\nnew\nl2\nl3\n' },
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /before or between/);
    } finally { await stub.close(); }
  });
});

test('hook: a debug card Write that drops an existing line is denied', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "l1\nl2\nl3\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Write', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { content: 'l1\nl3\n' },
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /drops or reorders/);
    } finally { await stub.close(); }
  });
});


test('hook: C1 end-to-end - an Edit inserting a return mid-file (a kept line still follows it) is denied', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "test('a', () => {\n  setup();\n  expect(1).toBe(1);\n});\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: '  setup();\n', new_string: '  setup();\n  return;\n' },
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /before or between/);
    } finally { await stub.close(); }
  });
});


test('hook: an unreachable board (closed port) allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: () => {} });
    await stub.close(); // nothing listens on this port now
    const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
      cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
      extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
    });
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'no deny, the tool call proceeds');
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => l.hook === 'test-file-guard' && /unreachable/.test(l.reason)), 'a fail-open line naming the unreachable board');
  });
});

test('hook: a board that never answers times out, allows, and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: () => { /* never responds */ } });
    try {
      const { stdout } = await runHook({ ...baseEnv(home, stateDir, stub.port), GLMPS_HOOK_HTTP_TIMEOUT_MS: '300' }, {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /did not answer within/i.test(l.reason)), 'a fail-open line naming the timeout');
    } finally { await stub.close(); }
  });
});

test('hook: invalid JSON from the board allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not-json'); } });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /invalid JSON/i.test(l.reason)), 'a fail-open line naming the bad board JSON');
    } finally { await stub.close(); }
  });
});

test('hook: a non-2xx response from the board allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(500); res.end(); } });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /HTTP 500/.test(l.reason)), 'a fail-open line naming the non-2xx board response');
    } finally { await stub.close(); }
  });
});

test('hook: an unknown card (404) allows and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(404); res.end(); } });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /unknown card/i.test(l.reason)), 'a fail-open line naming the unknown card');
      const posted = stub.calls.find((c) => c.method === 'POST' && c.url === '/api/guards/refusal');
      assert.ok(posted, 'expected a POST to /api/guards/refusal');
      assert.equal(JSON.parse(posted.body).failOpen, true);
      assert.equal(JSON.parse(posted.body).sessionId, 'sess-1');
    } finally { await stub.close(); }
  });
});

// the reported path must use the SAME field
// shape whether it is a fail-open or a real deny - the repo-relative path
// when it is known (after path resolution succeeded), the raw tool-call
// path otherwise (a repoTop-resolution failure, before any repo-relative
// path could exist) - and a `pathIsRepoRelative` field says which, so a
// consumer of these reports never has to guess from the string's shape.
test('M2: the reported path is repo-relative when known, else the raw path, and says which', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => { res.writeHead(500); res.end(); } });
    try {
      await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      const line = readFailOpenLines(stateDir).find((l) => /HTTP 500/.test(l.reason));
      assert.ok(line, 'expected the HTTP 500 fail-open line');
      assert.equal(line.pathIsRepoRelative, true, 'rel was known by this point (path resolution already succeeded)');
      assert.equal(line.path, 'server/test/x.test.js');
    } finally { await stub.close(); }
  });

  await withTempHome(async (home) => {
    initGitRepo(home); // built with the real PATH still in scope
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65598);
    const pathKey = Object.keys(env).find((k) => /^path$/i.test(k));
    if (pathKey) delete env[pathKey];
    env.PATH = path.join(home, 'no-git-here');
    const filePath = path.join('server', 'test', 'x.test.js');
    await runHook(env, { cwd: home, toolName: 'Edit', filePath, extra: { old_string: 'a', new_string: 'b' } });
    const line = readFailOpenLines(stateDir).find((l) => /git is not installed/i.test(l.reason));
    assert.ok(line, 'expected the missing-git fail-open line');
    assert.equal(line.pathIsRepoRelative, false, 'the repoTop resolution itself failed, so no repo-relative path exists yet');
    assert.equal(line.path, path.join(home, filePath));
  });
});

test('hook: bad stdin JSON allows and does NOT write a fail-open line (no card is known yet)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65540);
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, code }));
      child.stdin.end('{ this is not valid json for the hook itself');
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), '');
    assert.match(out.stderr, /could not parse the tool-call payload/);
    assert.deepEqual(readFailOpenLines(stateDir), [], 'no card is resolved yet: stderr only, never a fail-open line');
  });
});

test('hook: a non-string file_path allows quietly, no crash, no report', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65541);
    const input = { cwd: home, tool_name: 'Edit', tool_input: { file_path: 12345, old_string: 'a', new_string: 'b' }, session_id: 'sess-1' };
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookScript], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, code }));
      child.stdin.end(JSON.stringify(input));
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), '');
    assert.deepEqual(readFailOpenLines(stateDir), [], 'a non-string file_path must never crash or report');
  });
});

test('hook: git missing on PATH allows the test-file check and records why', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home); // built with the real PATH still in scope
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const env = baseEnv(home, stateDir, stub.port);
      const pathKey = Object.keys(env).find((k) => /^path$/i.test(k));
      if (pathKey) delete env[pathKey];
      env.PATH = path.join(home, 'no-git-here'); // guaranteed not to contain git
      const { stdout } = await runHook(env, {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'a broken git must never turn into a wrongful deny');
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /git is not installed or not on PATH/i.test(l.reason)), 'a fail-open line naming the missing git');
    } finally { await stub.close(); }
  });
});

test('hook: unreadable state - a directory in place of the test file fails open and records why (Write)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    // x.test.js is a DIRECTORY, not a file: it "exists" (fs.existsSync is
    // true for directories too), so the hook proceeds as far as trying to
    // read it - which fails with EISDIR, not a hang or a crash.
    fs.mkdirSync(path.join(home, 'server', 'test', 'x.test.js'), { recursive: true });
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Write', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { content: 'whatever' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'an unreadable existing file must never turn into a deny');
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /unreadable state/i.test(l.reason)), 'a fail-open line naming the unreadable state');
    } finally { await stub.close(); }
  });
});

// the bounded read now runs for Edit too, not just Write.
test('hook: unreadable state - a directory in place of the test file fails open for Edit too (C1: the bounded read now covers Edit/MultiEdit)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test', 'x.test.js'), { recursive: true });
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'a', new_string: 'b' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'an unreadable existing file must never turn into a deny');
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /unreadable state/i.test(l.reason)), 'a fail-open line naming the unreadable state');
    } finally { await stub.close(); }
  });
});

test('hook: unreadable state - an existing test file over the configured byte bound fails open quickly, never reading it', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    // 200 bytes, well over a deliberately tiny 50-byte test bound - proves
    // the stat-based size check trips WITHOUT needing a genuinely huge
    // fixture file (the code never reaches readFileSync for this file).
    fs.writeFileSync(path.join(home, 'server', 'test', 'big.test.js'), 'x'.repeat(200));
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const env = { ...baseEnv(home, stateDir, stub.port), GLMPS_TEST_GUARD_MAX_BYTES: '50' };
      const t0 = Date.now();
      const { stdout } = await runHook(env, {
        cwd: home, toolName: 'Write', filePath: path.join('server', 'test', 'big.test.js'),
        extra: { content: 'y'.repeat(10) },
      });
      const elapsed = Date.now() - t0;
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/, 'an oversized existing file must never turn into a deny');
      assert.ok(elapsed < 5000, `must fail open quickly, not hang (took ${elapsed}ms)`);
      const lines = readFailOpenLines(stateDir);
      assert.ok(lines.some((l) => /unreadable state.*over the 50 byte bound/i.test(l.reason)), 'a fail-open line naming the byte bound');
    } finally { await stub.close(); }
  });
});


test('hook: a nested test-directory file is still recognized from a cwd inside the test/ directory itself (no cwd-relative shortcut)', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const testDir = path.join(home, 'server', 'test');
    fs.mkdirSync(testDir, { recursive: true });
    // helpers.js is a test file only because it sits under server/test/ - its
    // bare filename matches none of isTestFile's suffix/prefix rules. A
    // cwd-relative rel string computed from cwd=testDir would be just
    // "helpers.js" and would WRONGLY read as not-a-test-file; the correct
    // repo-root-relative rel is "server/test/helpers.js".
    fs.writeFileSync(path.join(testDir, 'helpers.js'), "module.exports = 1;\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: testDir, toolName: 'Edit', filePath: 'helpers.js',
        extra: { old_string: 'module.exports = 1;', new_string: 'module.exports = 2;' },
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', 'a nested test-dir file must be recognized even from a cwd already inside it');
    } finally { await stub.close(); }
  });
});

test('hook: a file outside the repo top level is never guarded, even if it looks like a test file', async () => {
  await withTempHome(async (home) => {
    const repoDir = path.join(home, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);
    const scratchDir = path.join(home, 'scratch', 'test');
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, 'x.test.js'), "expect(1).toBe(1);\n");
    const stateDir = path.join(home, '.glmps');
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: repoDir, toolName: 'Edit', filePath: path.join('..', 'scratch', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.equal(stdout.trim(), '', 'a file outside the repo must never be gated');
      assert.equal(stub.calls.filter((c) => c.url.endsWith('/chain')).length, 0, 'an outside-repo file never needs the chain');
    } finally { await stub.close(); }
  });
});


test('hook: C1 (round 4) - an LF-old_string assertion rewrite on a CRLF file on disk is denied', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "test('a', () => {\r\n  setup();\r\n  expect(1).toBe(1);\r\n});\r\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: '  expect(1).toBe(1);\n});', new_string: '  expect(2).toBe(2);\n});' },
      });
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /Card mc-1 is a bug fix/);
      assert.deepEqual(readFailOpenLines(stateDir), [], 'a real deny is not a fail-open');
    } finally { await stub.close(); }
  });
});

test('hook: I2 (round 4) - an old_string not in the file, with an appending fragment, allows and logs the named reason', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => chainResponse(res, 'debug') });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'nowhere();', new_string: 'nowhere();\nalsoNew();' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /old_string not found in file; judged the fragment/);
      const lines = readFailOpenLines(stateDir);
      assert.equal(lines.length, 1);
      assert.match(lines[0].reason, /old_string not found in file; judged the fragment/);
      assert.equal(lines[0].path, 'server/test/x.test.js');
    } finally { await stub.close(); }
  });
});

// the empty catch around `git symbolic-ref` read every failure as "no
// card", silently switching the guard off. A missing git (deterministic: an
// empty PATH dir first, the real PATH dropped) is not a definitive no-branch
// answer, so it must be a named fail-open, not silence.
test('I5: a branch read that fails for a reason other than a detached HEAD is a named fail-open', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65520);
    delete env.GLMPS_CARD_ID; // the card would come from the branch
    const pathKey = Object.keys(env).find((k) => /^path$/i.test(k));
    if (pathKey) delete env[pathKey];
    env.PATH = path.join(home, 'no-git-here');
    const { stdout } = await runHook(env, { cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'a.test.js'), extra: { old_string: 'a', new_string: 'b' } });
    assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
    assert.match(stdout, /could not read the current branch/);
    const lines = readFailOpenLines(stateDir);
    assert.ok(lines.some((l) => /could not read the current branch.*not installed or not on PATH/i.test(l.reason)), `got ${JSON.stringify(lines)}`);
  });
});

test('I5: a detached HEAD with no GLMPS_CARD_ID stays "no card" for the guard: silent', async () => {
  await withTempHome(async (home) => {
    const git = initGitRepo(home);
    git(['checkout', '-q', '--detach']);
    const stateDir = path.join(home, '.glmps');
    const env = baseEnv(home, stateDir, 65519);
    delete env.GLMPS_CARD_ID;
    const { stdout } = await runHook(env, { cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'a.test.js'), extra: { old_string: 'a', new_string: 'b' } });
    assert.equal(stdout.trim(), '');
    assert.deepEqual(readFailOpenLines(stateDir), []);
  });
});

test('I6: with GLMPS_STATE_DIR unset, the guard writes under ~/.glmps-2, never ~/.glmps', async () => {
  await withTempHome(async (home) => {
    const notRepo = path.join(home, 'not-a-repo');
    fs.mkdirSync(notRepo);
    const env = baseEnv(home, 'unused', 65518);
    delete env.GLMPS_STATE_DIR;
    await runHook(env, { cwd: notRepo, toolName: 'Edit', filePath: path.join('server', 'test', 'a.test.js'), extra: { old_string: 'a', new_string: 'b' } });
    assert.ok(readFailOpenLines(path.join(home, '.glmps-2')).length >= 1, 'fail-open logged under ~/.glmps-2');
    assert.equal(fs.existsSync(path.join(home, '.glmps')), false, 'production state dir untouched');
  });
});

const approvedChain = { id: 'mc-9', taskClass: 'debug', testEditsApproved: { by: 'operator', at: '2026-10-26T20:00:00.000Z', note: null } };
const rewriteInput = { old_string: "expect(1).toBe(1);", new_string: "expect(2).toBe(2);" };
const decideRewrite = (chain) => testGuardDecision({ chain, tool: 'Edit', input: rewriteInput, relPath: 'server/test/x.test.js', exists: true, oldContent: "expect(1).toBe(1);\n" });

test("a debug card's test rewrite is refused without the operator approval", () => {
  const d = decideRewrite({ id: 'mc-9', taskClass: 'debug', testEditsApproved: null });
  assert.equal(d.allow, false);
  assert.equal(decideRewrite({ id: 'mc-9', taskClass: 'debug' }).allow, false);
});

test("a debug card's test rewrite is allowed with the operator approval and logs it as the reason", () => {
  const d = decideRewrite(approvedChain);
  assert.equal(d.allow, true);
  assert.equal(d.approved, true);
  assert.match(d.reason, /operator approved test edits on card mc-9/);
  assert.match(d.reason, /2026-10-26T20:00:00\.000Z/);
});

test('an approved debug card edit that is append-only anyway is allowed silently, not logged', () => {
  const d = testGuardDecision({ chain: approvedChain, tool: 'Edit', input: { old_string: 'expect(1).toBe(1);\n', new_string: 'expect(1).toBe(1);\nexpect(2).toBe(2);\n' }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'expect(1).toBe(1);\n' });
  assert.deepEqual(d, { allow: true });
});

test('hook: an approved debug card rewrite is allowed, logged to fail-open and surfaced as additionalContext', async () => {
  await withTempHome(async (home) => {
    initGitRepo(home);
    const stateDir = path.join(home, '.glmps');
    fs.mkdirSync(path.join(home, 'server', 'test'), { recursive: true });
    fs.writeFileSync(path.join(home, 'server', 'test', 'x.test.js'), "expect(1).toBe(1);\n");
    const stub = await startStubKernel({ onChain: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mc-1', intent: 'x', plan: null, taskClass: 'debug', testEditsApproved: { by: 'operator', at: '2026-10-26T20:00:00.000Z', note: null } }));
    } });
    try {
      const { stdout } = await runHook(baseEnv(home, stateDir, stub.port), {
        cwd: home, toolName: 'Edit', filePath: path.join('server', 'test', 'x.test.js'),
        extra: { old_string: 'expect(1).toBe(1);', new_string: 'expect(2).toBe(2);' },
      });
      assert.doesNotMatch(stdout, /"permissionDecision":"deny"/);
      const out = JSON.parse(stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /operator approved test edits on card mc-1/);
      assert.ok(readFailOpenLines(stateDir).some((l) => /operator approved test edits/.test(l.reason)));
    } finally { await stub.close(); }
  });
});

const declaredChain = (extra = {}) => ({ id: 'mc-9', taskClass: 'debug', testEditsApproved: null, testEditsDeclared: { reason: 'the old assertion pins the bug', at: '2026-11-13T10:00:00.000Z', by: 'agent' }, ...extra });

test('declared: a lost-content rewrite is allowed and the reason names the card and the declared reason', () => {
  const d = decideRewrite(declaredChain());
  assert.equal(d.allow, true);
  assert.equal(d.declared, true);
  assert.match(d.reason, /mc-9/);
  assert.match(d.reason, /the old assertion pins the bug/);
});

test('declared: an interleaved insert is allowed', () => {
  const d = testGuardDecision({ chain: declaredChain(), tool: 'Edit', input: { old_string: 'a();\nb();', new_string: 'a();\nx();\nb();' }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'a();\nb();\n' });
  assert.equal(d.allow, true);
  assert.equal(d.declared, true);
});

test('declared: a skip/only token stays refused', () => {
  const d = testGuardDecision({ chain: declaredChain(), tool: 'Edit', input: { old_string: 'a();\n', new_string: "a();\ntest.only('x', () => {});\n" }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'a();\n' });
  assert.equal(d.allow, false);
  assert.match(d.reason, /operator/);
});

test('declared: the operator approval still allows a token edit', () => {
  const d = testGuardDecision({ chain: declaredChain({ testEditsApproved: { by: 'operator', at: 'x', note: null } }), tool: 'Edit', input: { old_string: 'a();\n', new_string: "a();\ntest.only('x', () => {});\n" }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'a();\n' });
  assert.equal(d.allow, true);
  assert.equal(d.approved, true);
});

test('refusal messages tell the agent to declare a reason instead of asking the operator', () => {
  const lost = decideRewrite({ id: 'mc-9', taskClass: 'debug' });
  assert.match(lost.reason, /testEditsDeclared/);
  assert.doesNotMatch(lost.reason, /say so to the operator/);
  const tok = testGuardDecision({ chain: { id: 'mc-9', taskClass: 'debug' }, tool: 'Edit', input: { old_string: 'a();\n', new_string: "a();\ntest.only('x', () => {});\n" }, relPath: 'server/test/x.test.js', exists: true, oldContent: 'a();\n' });
  assert.doesNotMatch(tok.reason, /explain to the operator/);
  assert.match(tok.reason, /recommendation/);
});
