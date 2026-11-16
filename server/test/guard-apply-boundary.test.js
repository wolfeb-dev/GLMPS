// affected-tests: always
// server/test/guard-apply-boundary.test.js
//
// Static boundary guard (ADR-0001): landGuard is the ONLY caller of
// applyGuard. A route that calls applyGuard directly writes into the reflex
// layer ('## Learned guards' in CLAUDE.global.md) with no ledger row, no
// provenance and no gate decision - the exact hole glmps-74 found
// on two HTTP routes and glmps-80 asked to close. A guard applied
// that way is invisible to the ungated_reflex drift check, because that check
// reads the ledger.
//
// This test never imports or executes the guarded modules - it reads their
// SOURCE TEXT off disk and looks for an actual call, so it catches the
// regression even inside a branch no unit test executes, and even if the new
// caller is written months from now by someone who never read the ADR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Only two files may call applyGuard: the definition itself, and the one
// chokepoint the ADR permits.
const ALLOWED = new Set([
  path.join('server', 'lib', 'evaluation', 'learning-apply.js'),
  path.join('server', 'lib', 'evaluation', 'guard-lesson.js'),
]);

const SCANNED_DIRS = ['server', 'hooks', 'scripts', 'taps'];

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Tests legitimately stub and assert on applyGuard; the boundary is about
    // production call sites.
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

// A call, not a mention. `applyGuard(` with no leading comment marker, so the
// doc comments that describe this very boundary (several of them do) cannot
// false-positive. `applyGuardFn(` is NOT a match: passing an injected stub
// through to landGuard is exactly what the ADR permits.
export function callsApplyGuard(source) {
  return source.split('\n').some((line) => {
    const code = line.replace(/^\s*/, '');
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return false;
    return /\bapplyGuard\s*\(/.test(code);
  });
}

test('applyGuard is called from landGuard and nowhere else', () => {
  const offenders = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = path.relative(repoRoot, file);
      if (ALLOWED.has(rel)) continue;
      if (callsApplyGuard(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [],
    'these files call applyGuard directly; every guard must land through landGuard '
    + '(server/lib/evaluation/guard-lesson.js) so it carries provenance and a gate decision - see ADR-0001');
});

test('both allowlisted files exist, so the allowlist cannot rot into a no-op', () => {
  for (const rel of ALLOWED) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} is allowlisted but does not exist`);
  }
});

export function callsFn(source, name) {
  const re = new RegExp(`\\b${name}\\s*\\(`);
  return source.split('\n').some((line) => {
    const code = line.replace(/^\s*/, '');
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return false;
    return re.test(code) && !new RegExp(`function\\s+${name}\\s*\\(`).test(code);
  });
}

function offendersOf(name, allowed) {
  const out = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = path.relative(repoRoot, file);
      if (allowed.has(rel)) continue;
      if (callsFn(fs.readFileSync(file, 'utf8'), name)) out.push(rel);
    }
  }
  return out;
}

// Card glmps-2-0-201, ADR 0003: the auto-approver's promotion and the guard
// removal each have one caller, and only the server's auto-approve loop and
// the operator's revert route reach them.
test('autoApprovePromotion and removeGuard are called only from landGuard/unlandGuard', () => {
  const lesson = new Set([path.join('server', 'lib', 'evaluation', 'guard-lesson.js')]);
  assert.deepEqual(offendersOf('autoApprovePromotion', lesson), []);
  assert.deepEqual(offendersOf('removeGuard', lesson), []);
  assert.deepEqual(offendersOf('unlandGuard', new Set([path.join('server', 'server.js')])), []);
});

test('only server.js passes landGuard an autoApproval', () => {
  const out = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of sourceFiles(abs)) {
      const rel = path.relative(repoRoot, file);
      if (rel === path.join('server', 'server.js') || rel === path.join('server', 'lib', 'evaluation', 'guard-lesson.js')) continue;
      if (/\bautoApproval\s*:/.test(fs.readFileSync(file, 'utf8'))) out.push(rel);
    }
  }
  assert.deepEqual(out, []);
});

// Sanity check on the guard itself, so a typo in the pattern cannot silently
// make every case above pass for the wrong reason.
test('the detector fires on a real call and ignores prose and injected stubs', () => {
  assert.equal(callsApplyGuard('const { commit } = applyGuard({ assetsDir });'), true);
  assert.equal(callsApplyGuard('      applyGuard ({ file });'), true);
  assert.equal(callsApplyGuard('// see applyGuard(...) in learning-apply.js'), false);
  assert.equal(callsApplyGuard(' * applyGuard({ ... }) is the deterministic applier'), false);
  assert.equal(callsApplyGuard('const r = applyGuardFn({ assetsDir });'), false);
});
