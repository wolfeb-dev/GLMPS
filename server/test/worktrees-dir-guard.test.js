// server/test/worktrees-dir-guard.test.js
//
// Task 11 fix round 3, Important I2 (the round 2 ruling's residual risk,
// delivered): a clone of no-ambient-claude-dir.test.js's own approach. A
// server-booting test that overrides GLMPS_WORKTREES_DIR to a hardcoded,
// non-temp-looking path could point the runner's own worktree machinery
// (sweepWorktrees, createWorktree, removeWorktree - all guarded by
// test-write-guard.js's testRealGitWriteRefused) somewhere the containment
// check treats as legitimate, defeating condition (b) ("the target repo is
// under os.tmpdir()") by construction rather than by the predicate failing.
//
// This scans every server/test/*.test.js file at the source-text level (no
// AST parsing needed) and fails, naming the offending file and line, if a
// file boots a real server AND sets GLMPS_WORKTREES_DIR to anything other than
// a temp-dir expression (fix round 4 M2: os.tmpdir()/mkdtemp-derived,
// directly or through a const or helper, or a stateDir variable - see
// worktreesDirOffenders below and its own sample-snippet tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SELF_FILE = path.basename(fileURLToPath(import.meta.url));

// Same comment-vs-code distinction as no-ambient-claude-dir.test.js.
function commentStartIndex(line) {
  const m = /(?<!:)\/\//.exec(line);
  return m ? m.index : -1;
}

function hasRealMatchOnSomeLine(text, pattern) {
  for (const line of text.split('\n')) {
    const m = pattern.exec(line);
    pattern.lastIndex = 0;
    if (!m) continue;
    const cIdx = commentStartIndex(line);
    if (cIdx === -1 || cIdx > m.index) return true;
  }
  return false;
}

function bootsARealServer(text) {
  if (hasRealMatchOnSomeLine(text, /\bstartServer\s*\(/g)) return true;
  const spawnsServerJs = hasRealMatchOnSomeLine(text, /spawn\([^)]*server\.js/g);
  const authorsOwnServerJs = /writeFileSync\([^;]*?server\.js/s.test(text);
  return spawnsServerJs && !authorsOwnServerJs;
}

// the value assigned to GLMPS_WORKTREES_DIR must be a TEMP-DIR
// EXPRESSION, not merely "not a bare literal" (round 3's check looked only at
// the first character after the colon/equals, so path.join('C:/...') or a
// const holding a literal slipped through, and - contrary to its comment -
// it flagged every template literal, including one embedding a temp dir).
// Source-text heuristics, no AST:
// - an expression is temp if it calls os.tmpdir() or mkdtemp*, or if any
//   identifier in it resolves to temp: every `const|let|var NAME =`
//   declaration of that name in the file must itself be temp (recursively),
//   or it is a call to a helper whose definition line calls one of those;
// - an unresolvable `stateDir` (a parameter) is accepted by name, the one
//   convention every server-booting test in this suite follows;
// - anything else (a literal, path.join of literals, a const holding one, an
//   unresolvable identifier) is flagged.
// Quoted text is stripped before identifiers are read; a template literal
// keeps only its ${...} expressions.
const TEMP_CALL_RE = /\btmpdir\s*\(|\bmkdtemp(?:Sync)?\s*\(/;
const MODULE_NAMES = new Set(['path', 'os', 'fs', 'process', 'url', 'await', 'new', 'String']);

function stripStrings(expr) {
  return expr
    .replace(/`((?:\\.|[^`\\])*)`/g, (_, body) => ` ${[...body.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]).join(' ')} `)
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, ' ');
}

// The right-hand side after `GLMPS_WORKTREES_DIR:` / `= `, up to the first
// top-level `,` `;` or `}` (parentheses and brackets tracked).
function rhsAt(code, start) {
  let depth = 0;
  let i = start;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if ((c === ',' || c === ';') && depth === 0) break;
  }
  return code.slice(start, i).trim();
}

function declarationsOf(name, text) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(rhsAt(text, m.index + m[0].length));
  return out;
}

function helperIsTemp(name, text) {
  const def = new RegExp(`(?:function\\s+${name}\\s*\\(|\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\()[^\\n]*`).exec(text);
  return !!def && TEMP_CALL_RE.test(def[0]);
}

// a top-level ternary is temp only when EVERY branch is temp -
// `cond ? tmp : 'C:/real'` must stay flagged even though `tmp` alone is fine,
// because at runtime the real-path branch can still be the one taken.
// Depth/quote-aware so a `?`/`:` inside a nested call, array, object, or
// string never gets mistaken for the ternary's own operators.
function findTopLevelChar(s, ch) {
  let depth = 0;
  let inStr = null;
  const idxs = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ch) idxs.push(i);
  }
  return idxs;
}

function ternaryBranches(expr) {
  const qs = findTopLevelChar(expr, '?');
  if (!qs.length) return null;
  const colons = findTopLevelChar(expr, ':').filter((i) => i > qs[0]);
  if (!colons.length) return null;
  return [expr.slice(qs[0] + 1, colons[0]).trim(), expr.slice(colons[0] + 1).trim()];
}

function isTempExpr(expr, text, seen = new Set()) {
  const branches = ternaryBranches(expr);
  if (branches) return branches.every((b) => isTempExpr(b, text, seen));
  if (TEMP_CALL_RE.test(expr)) return true;
  const code = stripStrings(expr);
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(\s*\()?/g)) {
    const name = m[1];
    if (MODULE_NAMES.has(name) || seen.has(name)) continue;
    if (m[2] && helperIsTemp(name, text)) return true;
    const decls = declarationsOf(name, text);
    if (decls.length) {
      const next = new Set([...seen, name]);
      if (decls.every(d => isTempExpr(d, text, next))) return true;
      continue;
    }
    if (name === 'stateDir') return true;
  }
  return false;
}

function worktreesDirOffenders(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const cIdx = commentStartIndex(line);
    const codePart = cIdx === -1 ? line : line.slice(0, cIdx);
    // the key may be a quoted object key ('GLMPS_WORKTREES_DIR':)
    // or bracket notation (env['GLMPS_WORKTREES_DIR'] =), not only the bare
    // identifier spelling.
    for (const m of codePart.matchAll(/\[?['"]?GLMPS_WORKTREES_DIR['"]?\]?\s*(?::|=(?!=))\s*/g)) {
      const rhs = rhsAt(codePart, m.index + m[0].length);
      if (!isTempExpr(rhs, text)) { out.push(i + 1); return; }
    }
  });
  return out;
}

// the scanner's own detection, sample snippet -> verdict.
// Each sample is a whole (tiny) file so declarations can be resolved.
const SAMPLES = [
  { name: 'bare single-quoted literal', ok: false, src: "const env = { GLMPS_WORKTREES_DIR: 'C:/real/worktrees' };" },
  { name: 'bare template literal with no expression', ok: false, src: 'const env = { GLMPS_WORKTREES_DIR: `C:/real/worktrees` };' },
  { name: 'path.join of literals', ok: false, src: "const env = { GLMPS_WORKTREES_DIR: path.join('C:/', 'real', 'worktrees') };" },
  { name: 'a const holding a literal', ok: false, src: "const WT = 'C:/real/worktrees';\nconst env = { GLMPS_WORKTREES_DIR: WT };" },
  { name: 'a const holding path.join of literals', ok: false, src: "const WT = path.join('C:/real', 'wt');\nenv.GLMPS_WORKTREES_DIR = WT;" },
  { name: 'an unresolvable identifier (no declaration, not stateDir)', ok: false, src: 'env.GLMPS_WORKTREES_DIR = somewhere;' },
  { name: 'fs.mkdtempSync inline', ok: true, src: "const env = { GLMPS_WORKTREES_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wt-')) };" },
  { name: 'path.join(os.tmpdir(), ...)', ok: true, src: "const env = { GLMPS_WORKTREES_DIR: path.join(os.tmpdir(), 'wt') };" },
  { name: 'a const from mkdtempSync', ok: true, src: "const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));\nconst env = { GLMPS_WORKTREES_DIR: wt };" },
  { name: 'a helper call whose definition uses mkdtempSync', ok: true, src: "function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }\nconst worktreesDir = tmp('wt-');\nif (worktreesDir) env.GLMPS_WORKTREES_DIR = worktreesDir;" },
  { name: 'path.join under a temp stateDir const', ok: true, src: "const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 's-'));\nconst worktreesDir = path.join(stateDir, 'runner', 'worktrees');\nboot(stateDir, { GLMPS_WORKTREES_DIR: worktreesDir });" },
  { name: 'a stateDir parameter', ok: true, src: "function boot(stateDir) { return { GLMPS_WORKTREES_DIR: path.join(stateDir, 'wt') }; }" },
  { name: 'a template literal embedding a temp variable', ok: true, src: "const t = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nconst env = { GLMPS_WORKTREES_DIR: `${t}/wt` };" },
  { name: 'one of two declarations is a literal', ok: false, src: "let wt = fs.mkdtempSync(path.join(os.tmpdir(), 'a-'));\nfunction f() { const wt = 'C:/real'; return { GLMPS_WORKTREES_DIR: wt }; }" },
  { name: 'a comparison, not an assignment', ok: true, src: "if (env.GLMPS_WORKTREES_DIR === 'C:/real') throw new Error('x');" },
  { name: 'a comment mentioning it', ok: true, src: "// GLMPS_WORKTREES_DIR: 'C:/real'" },
  // quoted and bracketed keys must be scanned too, not only
  // the bare `GLMPS_WORKTREES_DIR:` / `GLMPS_WORKTREES_DIR =` spelling.
  { name: 'a quoted object key holding a literal', ok: false, src: "const env = { 'GLMPS_WORKTREES_DIR': 'C:/real/worktrees' };" },
  { name: 'a quoted object key holding a temp value', ok: true, src: "const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));\nconst env = { 'GLMPS_WORKTREES_DIR': t };" },
  { name: 'bracket-notation assignment of a literal', ok: false, src: "env['GLMPS_WORKTREES_DIR'] = 'C:/real/worktrees';" },
  { name: 'bracket-notation assignment of a temp value', ok: true, src: "const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));\nenv['GLMPS_WORKTREES_DIR'] = t;" },
  // a ternary (or similar branching expression) is temp only
  // when EVERY branch is temp - one real-path branch must still be flagged,
  // even when the other branch legitimately resolves to a temp dir.
  { name: 'a ternary with one real-path branch', ok: false, src: "const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));\nconst env = { GLMPS_WORKTREES_DIR: cond ? tmp : 'C:/real' };" },
  { name: 'a ternary where both branches are temp', ok: true, src: "const a = fs.mkdtempSync(path.join(os.tmpdir(), 'a-'));\nconst b = fs.mkdtempSync(path.join(os.tmpdir(), 'b-'));\nconst env = { GLMPS_WORKTREES_DIR: cond ? a : b };" },
];

for (const s of SAMPLES) {
  test(`M2 scanner: ${s.name} -> ${s.ok ? 'accepted' : 'flagged'}`, () => {
    const offenders = worktreesDirOffenders(s.src);
    assert.equal(offenders.length === 0, s.ok, `offending lines: ${JSON.stringify(offenders)}`);
  });
}

test('every server-booting test that overrides GLMPS_WORKTREES_DIR uses a temp-dir expression, never a hardcoded path', () => {
  const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js') && f !== SELF_FILE)
    // worktree-sweep-config.test.js's own "residual risk" test deliberately
    // sets a non-temp-LOOKING literal, to prove the test-process signals
    // alone (never GLMPS_WORKTREES_DIR's value) are what the backstop refuses
    // on - the one legitimate exception, named exactly like
    // no-ambient-claude-dir.test.js exempts shadow-instance.test.js.
    .filter((f) => f !== 'worktree-sweep-config.test.js')
    .sort();
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(TEST_DIR, file), 'utf-8');
    if (!bootsARealServer(text)) continue;
    if (!text.includes('GLMPS_WORKTREES_DIR')) continue;
    const lines = worktreesDirOffenders(text);
    if (lines.length) offenders.push(`${file}:${lines.join(',')}`);
  }
  assert.deepEqual(offenders, [],
    `test file(s) set GLMPS_WORKTREES_DIR to a hardcoded path rather than a temp-dir expression, ` +
    `which could point the runner's worktree machinery at a real, non-temp location: ${offenders.join('; ')}`);
});
