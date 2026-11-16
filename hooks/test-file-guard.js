#!/usr/bin/env node
// PreToolUse (Write|Edit|MultiEdit): the append-only test-file guard
// (program K7, decision 7, D6 borrow c). While a card's taskClass is
// 'debug' (a bug fix), an existing test file may only grow - a fix cannot
// make its own failing test pass by editing the test itself. Append-only
// literally means append: any added line placed before the first existing
// line of the file, or between two existing lines, is refused outright,
// whatever it contains. A new test file is always allowed, and a non-debug
// card is never guarded at all.
//
// Fail open, never brick. Every error path below (kernel unreachable, a
// board that times out, bad stdin/board JSON, a non-2xx board response, an
// unknown card, git unavailable or timing out, an unreadable/oversized
// existing file, a non-string file_path) allows the edit and records a
// named reason - this guard never denies on an infrastructure failure it
// cannot evaluate. An Edit/MultiEdit whose old_string is not found in the
// file is not silently allowed either: its fragment is judged, and
// a passing fragment is allowed with a named fail-open reason. At most one
// fail-open report (log line plus best-effort
// POST) is made per invocation, via reportOnce's own once-fired guard in
// main() below.
//
// Path handling mirrors plan-gate.js exactly (same imported helpers, not a
// second copy of the same logic): resolved against the repo TOP LEVEL, not
// the tool call's cwd; realpath'd (or the nearest existing parent, for a
// new file); lowercased on win32; a path outside the repo is never guarded.
//
// Accepted, documented limits (a text-level line diff, not a real parser,
// so these are out of scope rather than silently missed):
// - An appended `import`/`require` of a new side-effect module is not
//   flagged, even though imports are hoisted and could run before existing
//   code - catching this needs real module-graph analysis, not a text diff.
// - The reviewer's "decoy copy" case: a Write whose APPENDED tail happens to
//   contain a verbatim copy of an old kept block (e.g. inside a template
//   literal used as a fixture) can let diffLines greedily match the OLD
//   block against the DECOY copy instead of the real one, if the decoy
//   comes first - a line-based diff has no way to prefer "the real,
//   untouched instance" over "a lookalike".
// - Trailing whitespace or CRLF changes INSIDE a multi-line template
//   literal are normalised away like any other line, even though they are
//   part of that string's actual runtime value there.
// - Unicode homoglyphs (a visually identical but code-point-different
//   character swapped into a kept line) are not detected.
// - The Bash tool can rename a test file then delete the original, which
//   this hook (matched only on Write|Edit|MultiEdit) never sees.
// - The APPENDED denylist (code after the last existing line) is heuristic,
//   not exhaustive. Not caught: bracket, Reflect.set,
//   Object.defineProperties or aliased assignments to a framework global
//   (`assert['equal'] = ...`, `const a = assert; a.equal = ...`); an aliased
//   or indented top-level hook (`const bE = beforeEach; bE(...)`); and
//   appended top-level code that monkey-patches the module under test (for
//   example `mock.method(lib, 'add', ...)`).
// - Also not caught: a SHADOWING declaration
//   of a framework global (`const expect = ...`, `let it = ...`, `var
//   assert = ...`) is deliberately excluded by the reassignment pattern's own
//   `let|const|var` lookbehind, since a shadowed local binding does not
//   change what any OTHER test's assertions do -- but a shadowed name that is
//   never used, or is used only to reassign it again later in the same
//   scope, reads identically to a real reassignment and is not distinguished
//   here; a `globalThis.expect = ...` or `global.expect = ...` assignment of
//   a framework global is not caught either (the pattern's own `(?<![.\w$])`
//   guard, there to let `opts.it = 1` stay legal, also excludes anything
//   written after a `.`, `globalThis.`/`global.` included); and a top-level
//   hook that does not start its own line (e.g. `x(); beforeEach(() => {
//   ... })` on one physical line) is unseen by the column-0-anchored hook
//   pattern, the same underlying gap as the aliased/indented hook case above.
// - Edit/MultiEdit matching emulates the real tool's CRLF fold and its
//   curly/straight quote fold. When the quote fold is what found
//   old_string, the diff runs in quote-folded text, so a quote-style-only
//   change to a kept line is not seen. The tool's \uXXXX escape swap is not
//   emulated: such an old_string is "not found" here, and its fragment is
//   judged instead (allowed only if it appends, and then logged by name).
//
// This hook is registered only by the installer, and the live install is
// held until cutover: nothing here registers it in any real settings file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCardId, fetchChain, reportRefusal, envStateDir } from './lib/card-context.js';
import { gitRun, gitRepoTop, repoRelativePath, bumpCounter, branchReadIssue } from './plan-gate.js';
import { appendCapped } from '../server/lib/observability/append-log.js';

// isTestFile: a repo-relative path is a test file if it sits under a
// test/tests/__tests__ directory segment, or its own filename carries a
// .test./.spec. suffix, or (Python's convention) a test_ prefix. A .md file
// is never a test file even if its name happens to contain "test" (e.g. a
// docs/test-plan.md) - checked first so the directory/suffix rules below
// never have to separately exclude documentation.
//
// Every rule here is case-insensitive: repoRelativePath already lowercases on
// win32 before this is called in the real hook flow, but isTestFile is
// exported and usable standalone, and must not depend on the caller having
// normalized case.
export function isTestFile(p) {
  const s = String(p).replace(/\\/g, '/');
  if (/\.md$/i.test(s)) return false;
  return /(^|\/)(test|tests|__tests__)\//i.test(s) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(s) || /(^|\/)test_[^/]+\.py$/i.test(s);
}

// normalizeText: folds CRLF line endings and per-line trailing
// whitespace before ANY comparison, so a purely cosmetic change (CRLF->LF,
// trailing-whitespace stripped) is never mistaken for lost test content.
// Line count/structure is otherwise preserved (this does not drop empty
// lines in the middle - only normalizedLines(), below, drops the single
// FINAL empty line, which is what "the file ends with a trailing newline"
// looks like once split).
function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

// Pop EXACTLY ONE trailing empty line, not every one. A
// single trailing empty element (from a file ending in one newline) is
// insignificant - but a SECOND (or third) trailing blank line is real
// content (an intentional blank line at the end of the file), and dropping
// it must still be denied, not silently normalised away alongside the one
// truly insignificant newline.
function normalizedLines(text) {
  const lines = normalizeText(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// diffLines: a greedy subsequence match of `want` (the old lines) against
// `have` (the new lines). `ok` is true iff every old line is still found,
// in order (extra lines interleaved anywhere are fine - that is exactly
// "the file may only grow"). `addedRuns` collects every run of unmatched
// `have` lines, in the order encountered: addedRuns[k] is the text inserted
// immediately BEFORE the (k+1)-th preserved old line, and the final element
// is the trailing tail after the last preserved line (or the only run, if
// nothing matched at all). Each added entry is { line, n }, n being its
// 1-based line number in the new text.
function diffLines(oldText, newText) {
  const want = normalizedLines(oldText);
  const have = normalizedLines(newText);
  let i = 0;
  const addedRuns = [[]];
  have.forEach((line, k) => {
    if (i < want.length && line === want[i]) {
      i++;
      addedRuns.push([]);
    } else {
      addedRuns[addedRuns.length - 1].push({ line, n: k + 1 });
    }
  });
  return { ok: i === want.length, addedRuns };
}

// toLf: the real Edit tool reads the file with CRLF folded
// to LF, matches the model's (LF) old_string against that, and writes CRLF
// back. Matching raw CRLF bytes here made every multi-line old_string on a
// CRLF file "not found" - a silent allow, even for an outright assertion
// rewrite. So the file text and both strings are folded to LF before any
// match; the diff below normalises line endings anyway.
function toLf(s) { return String(s).replace(/\r\n/g, '\n'); }

// The real tool also retries a failed match with curly quotes
// folded to straight ones. Each fold is one UTF-16 unit for one, so indexes
// line up; the fallback match below runs entirely in the folded text.
const QUOTE_FOLD = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"' };
function foldQuotes(s) { return s.replace(/[\u2018\u2019\u201C\u201D]/g, (c) => QUOTE_FOLD[c]); }

// spliceEdit: one exact substring replacement (honouring replace_all), or
// null when old_string does not occur in text at all.
function spliceEdit(text, old, neu, replaceAll) {
  if (!text.includes(old)) return null;
  if (replaceAll) return text.split(old).join(neu);
  const idx = text.indexOf(old);
  return text.slice(0, idx) + neu + text.slice(idx + old.length);
}

// applyEdits: simulates the real Edit/MultiEdit mechanics so the guard can
// evaluate an edit's effect against the WHOLE file, not the edited fragment
// alone. Every edit applies in order to the result of the one
// before it, as the real MultiEdit does. Each edit is first matched exactly
// (after the LF fold); failing that, with quotes folded, in which case the
// working text and the diff baseline both switch to the quote-folded form
// (so a quote-style difference alone is never read as lost content).
// Returns { base, text } for the diff, or null when some old_string is still
// not found - the caller then judges the fragments instead.
function applyEdits(fileText, edits) {
  let text = toLf(fileText);
  let folded = false;
  for (const e of edits) {
    const old = toLf(e.old_string);
    const neu = toLf(e.new_string);
    let next = spliceEdit(text, old, neu, e.replace_all);
    if (next == null) {
      next = spliceEdit(foldQuotes(text), foldQuotes(old), foldQuotes(neu), e.replace_all);
      if (next == null) return null;
      folded = true;
    }
    text = next;
  }
  return { base: folded ? foldQuotes(toLf(fileText)) : String(fileText), text };
}

function editsOf(tool, input) {
  if (tool === 'Edit') return [input];
  if (tool === 'MultiEdit') return Array.isArray(input.edits) ? input.edits : [];
  return null;
}

// resultTextFor: the ONE place a tool call is turned into the file's
// resulting text, so every check below evaluates the SAME reconstructed
// file for Edit, MultiEdit and Write alike (judging an Edit's position
// against its fragment alone let a mid-file insertion look like a harmless
// trailing append). Returns { base, text }, or null for an Edit/
// MultiEdit whose old_string is not found even after the CRLF and quote
// folds, or for an unknown tool.
function resultTextFor(tool, input, oldContent) {
  if (tool === 'Write') return { base: oldContent, text: input.content };
  const edits = editsOf(tool, input);
  return edits ? applyEdits(oldContent, edits) : null;
}

// judgeText: the one line-level + position rule, over a baseline and a
// result. Order matters: lost/changed old lines first, then any line added
// before or between kept lines (INTERLEAVED, refused outright), then the
// appended-tail denylist.
function judgeText(base, result) {
  const { ok, addedRuns } = diffLines(base, result);
  if (!ok) return { ok: false, kind: 'lost' };
  const interleaved = addedRuns.slice(0, -1).flat();
  if (interleaved.length) {
    const first = interleaved.find((a) => a.line.trim() !== '') || interleaved[0];
    return { ok: false, kind: 'interleaved', line: first.line, lineNo: first.n };
  }
  const tail = (addedRuns[addedRuns.length - 1] || []).map((a) => a.line).join('\n');
  const token = appendedToken(tail);
  return token ? { ok: false, kind: 'token', token } : { ok: true };
}

// evaluate: the whole verdict for one tool call. `fragment: true` marks the
// fallback: old_string was not found even after the CRLF and
// quote folds (the real tool also tries \uXXXX escape swaps, which this does
// not emulate), so each edit's old_string/new_string pair is judged as its
// own tiny file by the same rule. A deny there costs nothing on a call that
// would truly fail; a pass is never silent - the caller logs it by name.
function evaluate({ tool, input, oldContent = '' }) {
  const r = resultTextFor(tool, input || {}, oldContent);
  if (r) return judgeText(r.base, r.text);
  const edits = editsOf(tool, input || {});
  if (!edits) return { ok: true };
  for (const e of edits) {
    const v = judgeText(toLf(e.old_string), toLf(e.new_string));
    if (!v.ok) return { ...v, fragment: true };
  }
  return { ok: true, fragment: true };
}

function lostReason(tool) {
  if (tool === 'Write') return 'the rewrite drops or reorders existing test lines';
  if (tool === 'MultiEdit') return 'an edit changes or removes existing test text';
  return 'the edit changes or removes existing test text';
}

export function appendOnly({ tool, input, oldContent = '' }) {
  const v = evaluate({ tool, input, oldContent });
  return v.kind === 'lost' ? { ok: false, reason: lostReason(tool) } : { ok: true };
}

// Append-only literally means append:
// - INTERLEAVED (any added line before the first kept line, or between two
//   kept lines, judged against the WHOLE FILE via resultTextFor above) is
//   refused OUTRIGHT, whatever it contains. There is no keyword list for
//   interleaved lines: the position alone is disqualifying, so it cannot be
//   bypassed by content that avoids a keyword list (`false &&`, wrapping a
//   kept line in a new function) and never falsely denies content that
//   happens to mention one.
// - APPENDED (everything after the LAST kept line - genuinely new code, not
//   a rewrite of anything old) is scanned against a denylist of tokens that
//   can disable OTHER, unrelated tests. A new helper, a new ordinary test, or
//   a new `.skip()`/`.todo()`'d test is ordinary new code and is never
//   denied.
// The appended denylist is HEURISTIC, NOT EXHAUSTIVE: see the
// accepted limits in this file's header.
const APPENDED_DISABLE_TOKENS = [
  { re: /\.only\s*\(/, label: '.only(' },
  { re: /process\.exit\s*\(/, label: 'process.exit(' },
  // A top-level lifecycle hook (column 0) runs for EVERY test in the file,
  // old and new alike - e.g. a new beforeEach that throws disables every
  // kept test too. One nested inside a new describe() block only affects
  // tests inside that block, so it stays legal (this pattern is anchored to
  // the start of a line, not indented).
  { re: /^(?:beforeEach|afterEach|beforeAll|afterAll|before|after)\s*\(/m, label: 'a top-level lifecycle hook' },
  // Reassigning a test-framework global (assert.equal = ..., expect = ...)
  // silently changes what EVERY test's assertions do, old and new alike.
  // The pattern is not after `.`/word/`$` (so `opts.it = 1` is a property of
  // something else), not a `let`/`const`/`var` declaration (`for (let t =
  // 0`), and `=` not followed by `=` or `>` (a comparison, or an arrow such
  // as `t => ...`).
  { re: /(?<![.\w$])(?<!\b(?:let|const|var)\s+)\b(?:assert|expect|test|it|describe|t)\b(?:\.\w+)*\s*=(?![=>])/, label: 'reassigning a test-framework global' },
  { re: /Object\.(?:defineProperty|assign|setPrototypeOf)\s*\(\s*(?:assert|expect)\b/, label: 'patching assert/expect via Object.*' },
  { re: /\bmock\.method\s*\(\s*(?:assert|expect)\b/, label: 'mocking assert/expect via mock.method' },
  // There is no `t.skip(` pattern: t.skip() skips only the test whose
  // context it is called on; it reaches an OLD test only from inside a
  // top-level hook, which the column-0 hook rule above already denies.
];

function appendedToken(text) {
  for (const { re, label } of APPENDED_DISABLE_TOKENS) if (re.test(text)) return label;
  return null;
}

export function neuteringCheck({ tool, input, oldContent = '' }) {
  const v = evaluate({ tool, input, oldContent });
  if (v.kind === 'interleaved') return { ok: false, interleavedLine: v.line, lineNo: v.lineNo, fragment: !!v.fragment };
  if (v.kind === 'token') return { ok: false, token: v.token };
  return { ok: true };
}

const FRAGMENT_REASON = 'test-file guard: old_string not found in file; judged the fragment (the real tool may still match it, e.g. via an escape swap), and the fragment only appends; the edit is allowed and logged';

/**
 * Pure decision over an already-resolved test-file edit. `unavailable` (the
 * board could not answer - unreachable, timed out, bad JSON, non-2xx) and
 * `unknownCard` (the board answered 404 - the card was never
 * found, not merely "not debug") both fail open with their own named
 * reason; a missing/non-debug `chain` passes free. Only a genuinely
 * reachable `debug` card's non-append-only OR interleaved/disabling edit is
 * ever denied.
 */
export function testGuardDecision(args) {
  const d = baseTestGuardDecision(args);
  if (d.allow) return d;
  const ap = args.chain?.testEditsApproved;
  const dec = args.chain?.testEditsDeclared;
  // A token refusal needs the operator; the agent's own declaration covers only
  // the lost and interleaved kinds.
  if (!ap && dec && d.kind !== 'token') {
    return { allow: true, declared: true, reason: `test-file guard: card ${args.chain.id} declared test edits (${dec.reason}); the edit is allowed and logged` };
  }
  if (!ap) return d;
  // The operator's per-card approval turns a refusal into a logged allow.
  return { allow: true, approved: true, reason: `test-file guard: operator approved test edits on card ${args.chain.id} (${ap.at}); the edit is allowed and logged` };
}

function baseTestGuardDecision({ chain, unavailable = null, unknownCard = false, tool, input, relPath, exists, oldContent }) {
  if (!isTestFile(relPath) || !exists) return { allow: true };
  if (unavailable) {
    return { allow: true, failOpen: true, reason: `test-file guard skipped: board unreachable (${unavailable}); the edit is allowed and logged` };
  }
  if (unknownCard) {
    return { allow: true, failOpen: true, reason: 'test-file guard skipped: unknown card (not found on the board, it may have been deleted or renamed); the edit is allowed and logged' };
  }
  if (!chain || chain.taskClass !== 'debug') return { allow: true };
  const v = evaluate({ tool, input, oldContent });
  if (v.kind === 'lost') {
    return { allow: false, kind: 'lost', reason: `Card ${chain.id} is a bug fix, so existing test files are append-only: only add new test cases. Refused because ${lostReason(tool)}. If the existing test itself is wrong, declare why with PATCH /api/backlog/${chain.id} {"testEditsDeclared":{"reason":"<why the existing test is wrong>"}}, which posts the reason to the thread and lets the edit through.` };
  }
  if (v.kind === 'interleaved') {
    // Name the card, the position, the
    // remedy, and the first NON-BLANK inserted line with its 1-based line
    // number. The remedy (move the new code to the end of the file) is
    // always correct, so no "may be a false positive" hedge here.
    const where = v.fragment ? "of the edit's new_string" : 'of the resulting file';
    const shown = v.line.trim() === '' ? '(a blank line)' : v.line;
    return { allow: false, kind: 'interleaved', reason: `Card ${chain.id} is a bug fix, so existing test files are append-only: new code inserted before or between existing lines of a test file is refused while this card is a debug card; add new tests and helpers after the last existing line of the file instead. First inserted line, line ${v.lineNo} ${where}: ${shown}` };
  }
  if (v.kind === 'token') {
    return { allow: false, kind: 'token', reason: `Card ${chain.id} is a bug fix, so existing test files are append-only: only add new test cases. The edit adds ${v.token}, which can disable an existing test. Adding a skip/only token needs the operator's approval, and declaring a reason does not unlock it. If it is a false positive, write the reason and your recommendation in a devlog entry on the card rather than asking an open question.` };
  }
  if (v.fragment) return { allow: true, failOpen: true, reason: FRAGMENT_REASON };
  return { allow: true };
}

// maxOldContentBytes: env-overridable (mirrors gitTimeoutMs()'s own pattern
// in plan-gate.js - a fresh read per call, not a module-load-time snapshot),
// so a test can lower the bound to prove the size check trips without ever
// allocating a genuinely huge fixture file.
function maxOldContentBytes() { return Number(process.env.GLMPS_TEST_GUARD_MAX_BYTES) || 5 * 1024 * 1024; }

// readOldContentBounded: the ONLY place this hook reads an existing file's
// bytes. A stat check runs first, so an oversized file fails open on its
// SIZE alone and never reaches readFileSync at all - it cannot hang or
// throw reading a file of unbounded size. Any stat/read failure (permission
// denied, EISDIR, a race where the file disappears) is the same
// "unreadable state" - a named reason this hook cannot verify, not a
// reason to deny.
function readOldContentBounded(abs) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    return { ok: false, reason: `unreadable state: could not stat the existing test file (${e.code || e.message})` };
  }
  const max = maxOldContentBytes();
  if (stat.size > max) {
    return { ok: false, reason: `unreadable state: the existing test file is ${stat.size} bytes, over the ${max} byte bound for this check` };
  }
  try {
    return { ok: true, content: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { ok: false, reason: `unreadable state: could not read the existing test file (${e.code || e.message})` };
  }
}

function logFailOpen(stateDir, entry) {
  try {
    appendCapped(path.join(stateDir, 'guards', 'fail-open.ndjson'), { ts: Date.now(), hook: 'test-file-guard', ...entry });
  } catch (e) {
    process.stderr.write(`test-file-guard: could not write the fail-open log (${e.message})\n`);
  }
}

// the SAME field shape on every report this hook
// makes, fail-open or deny - the repo-relative path when it is known
// (`rel`, once path resolution has succeeded), the raw tool-call path
// otherwise (a repoTop-resolution failure happens before any repo-relative
// path could exist) - with `pathIsRepoRelative` saying which, so a consumer
// never has to guess from the string's shape alone.
function pathFields(rel, target) {
  return rel != null ? { path: rel, pathIsRepoRelative: true } : { path: target, pathIsRepoRelative: false };
}

async function main() {
  // GLMPS_STATE_DIR, else ~/.glmps-2 (the 2.0
  // kernel's own state dir; the cutover flips it, see card-context.js).
  const stateDir = envStateDir();
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input = {};
  try {
    input = JSON.parse(raw) || {};
  } catch (e) {
    // No card is even resolved yet at this point (mirrors plan-gate.js's own
    // not a guard fail-open to log or report - stderr only.
    process.stderr.write(`test-file-guard: could not parse the tool-call payload (${e.message}); allowing (failing open)\n`);
    return;
  }
  const cwd = input.cwd || process.cwd();
  const tool = input.tool_name;
  const target = input.tool_input?.file_path;
  // A non-string file_path (an object, a number, ...) would otherwise reach
  // path.resolve() and throw - guard it the same way a missing one is.
  if (!target || typeof target !== 'string') return;

  // Routed through gitRun so this spawn shares its one bounded timeout.
  // Same rule as plan-gate.js: only a definitive
  // no-branch answer (a detached HEAD, a cwd outside any repository) is "no
  // card"; any other failure is a named fail-open below, never silence.
  let branch = '';
  let branchIssue = null;
  try {
    branch = gitRun(cwd, ['symbolic-ref', '--short', 'HEAD']).trim();
  } catch (e) {
    branchIssue = branchReadIssue(e);
  }
  const cardId = resolveCardId({ branch });

  let rel = null;
  let reported = false;
  const emit = (o) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));
  const reportOnce = async (reason) => {
    if (reported) return;
    reported = true;
    const fields = pathFields(rel, target);
    logFailOpen(stateDir, { cardId, reason, ...fields });
    await reportRefusal({ hook: 'test-file-guard', cardId, sessionId: input.session_id, tool, ...fields, reason, failOpen: true }, { stateDir });
  };

  if (branchIssue) {
    const reason = `test-file guard skipped: could not read the current branch (${branchIssue}); the edit is allowed and logged`;
    await reportOnce(reason);
    emit({ additionalContext: reason });
    return;
  }
  if (!cardId) return; // no card on this branch: the guard does nothing

  // Repo-root resolution failing (git missing, git timing out, not a repo)
  // means nothing below can be evaluated safely - fail this whole call open.
  let repoTop;
  try {
    repoTop = gitRepoTop(cwd);
  } catch (e) {
    const reason = `test-file guard skipped: ${e.message}; the edit is allowed and logged`;
    await reportOnce(reason);
    emit({ additionalContext: reason });
    return;
  }

  rel = repoRelativePath({ abs: path.resolve(cwd, target), repoTop });
  if (rel == null) return; // outside the repo top level: never guarded
  if (!isTestFile(rel)) return; // not a test file: nothing to guard

  const abs = path.resolve(repoTop, rel);
  if (!fs.existsSync(abs)) return; // a new test file is always allowed

  const { chain, unavailable, unknownCard } = await fetchChain(cardId);

  // the bounded read now runs for Edit and MultiEdit too, not
  // just Write - file-level evaluation needs the real file's content for
  // all three tools alike. Every other combination (a non-debug,
  // unreachable-board, or unknown-card case short-circuits inside
  // testGuardDecision itself) never touches the file's bytes at all.
  let oldContent = '';
  if (!unavailable && !unknownCard && chain?.taskClass === 'debug' && (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit')) {
    const read = readOldContentBounded(abs);
    if (!read.ok) {
      // Mirrors plan-gate.js's own repoTop-failure path: an infrastructure
      // failure before the decision function ever runs is never counted as
      // a "check" either - the counters file tracks decisions made, not
      // every early return.
      const reason = `test-file guard skipped: ${read.reason}; the edit is allowed and logged`;
      await reportOnce(reason);
      emit({ additionalContext: reason });
      return;
    }
    oldContent = read.content;
  }

  const d = testGuardDecision({ chain, unavailable, unknownCard, tool, input: input.tool_input, relPath: rel, exists: true, oldContent });
  bumpCounter(stateDir, 'test-file-guard', d.allow ? 0 : 1);

  if (d.failOpen || d.approved || d.declared) {
    await reportOnce(d.reason);
    emit({ additionalContext: d.reason });
    return;
  }
  if (!d.allow) {
    await reportRefusal({ hook: 'test-file-guard', cardId, sessionId: input.session_id, tool, ...pathFields(rel, target), reason: d.reason, failOpen: false }, { stateDir });
    emit({ permissionDecision: 'deny', permissionDecisionReason: d.reason });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    const reason = `test-file guard skipped: unexpected error (${e?.message || e}); the edit is allowed and logged`;
    process.stderr.write(`test-file-guard: ${reason} (failing open)\n`);
    try {
      logFailOpen(envStateDir(), { cardId: null, reason });
    } catch { /* stderr above already recorded this; never let logging itself crash the exit */ }
    // CI regression (Windows), mirrors plan-gate.js's own fix: this safety
    // net used to stop at stderr/the log file, never writing the
    // hookSpecificOutput JSON every OTHER fail-open path here emits on
    // stdout - a caller parsing stdout for a decision saw EMPTY stdout
    // instead of a fail-open one whenever something unexpected threw this
    // late (root cause: bumpCounter's unguarded mkdirSync, shared with
    // plan-gate.js and fixed there). Every call to the in-main `emit` is
    // immediately followed by `return` (or is main()'s own last statement),
    // so main() can never reach this catch after already having written to
    // stdout. exit() is deferred to the write's own callback: stdout is a
    // pipe here, a pipe write on Windows is asynchronous, and process.exit()
    // fired right after queuing it can truncate this very write back to
    // empty before it reaches the pipe.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason } }),
      () => process.exit(0),
    );
  });
}
