// one guarded spawn helper for every
// editor/terminal spawn, and one validator for any request-derived path that
// must reach a shell:true command line. Every test drives an injected fake
// spawn; no process is ever created and no shell ever sees a payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { guardedSpawn, shellSafePath, shellSafePathSyntax, shellArg } from '../lib/orchestration/guarded-spawn.js';

function fake(mode) {
  const calls = [];
  const fn = (file, args, options) => {
    calls.push({ file, args, options });
    if (mode === 'throw') throw new Error('EMFILE: simulated synchronous spawn failure');
    const child = new EventEmitter();
    child.pid = 4242;
    child.unrefCalled = false;
    child.unref = () => { child.unrefCalled = true; };
    if (mode === 'error') setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' })));
    if (mode === 'exit1') setImmediate(() => child.emit('exit', 1, null));
    if (mode === 'exit0') setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  return { fn, calls };
}

test('guardedSpawn: a synchronous throw becomes one named miss and returns null', () => {
  const f = fake('throw');
  const misses = [];
  const child = guardedSpawn({ spawnFn: f.fn, file: 'x', args: [], options: {}, key: 'spawn:resume', label: 'resume', onMiss: (k, r) => misses.push([k, r]) });
  assert.equal(child, null);
  assert.equal(misses.length, 1);
  assert.equal(misses[0][0], 'spawn:resume');
  assert.match(misses[0][1], /resume: .*EMFILE/);
});

// CI fix round (glmps2 Slack lifecycle): this test was observed flaking in
// CI (ubuntu 22/26 and windows 24 in the same run; never locally across 25+
// isolated runs and a full-suite run here) with `misses` still empty after
// a fixed 10ms wait - the mocked 'error' event is scheduled with
// setImmediate, which a timer registered after it still beats when the event
// loop was stalled past the timer's delay. There is no ordering bug in guardedSpawn itself
// (the listener is attached synchronously, before the mock function
// returns). Rather than guess a longer fixed delay - which only narrows the
// window without closing it, and would slow every run to pay for a CI-only
// margin - wait on the actual miss instead of a fixed clock duration: no
// dependency on wall-clock timing survives, for whatever load/scheduling
// condition on the runner was stretching the old margin thin. A generous
// backstop timeout keeps a genuine regression (the listener never firing at
// all) failing loudly instead of hanging.
test('guardedSpawn: an async error event is listened for and reported by key', async () => {
  const f = fake('error');
  const misses = [];
  let notifyMiss;
  const missReported = new Promise((resolve) => { notifyMiss = resolve; });
  const child = guardedSpawn({
    spawnFn: f.fn, file: 'x', args: [], options: {}, key: 'spawn:terminal', label: 'terminal',
    onMiss: (k, r) => { misses.push([k, r]); notifyMiss(); },
  });
  assert.equal(child.pid, 4242);
  assert.equal(child.unrefCalled, true);
  let backstop;
  const timedOut = new Promise((_, reject) => {
    backstop = setTimeout(() => reject(new Error('onMiss was never called within 2s')), 2000);
  });
  try { await Promise.race([missReported, timedOut]); }
  finally { clearTimeout(backstop); }
  assert.deepEqual(misses.map((m) => m[0]), ['spawn:terminal']);
  assert.match(misses[0][1], /ENOENT/);
});

// With shell:true a missing command is not an ENOENT: the shell itself starts
// fine and then exits 1 ("is not recognized" / "command not found"). The exit
// code is the real signal, so a non-zero exit is a named miss.
test('guardedSpawn: a non-zero exit is a named miss; a zero exit is not', async () => {
  const bad = fake('exit1');
  const misses = [];
  // guardedSpawn's own listener was attached first, so it has run once 'exit'
  // reaches this one. A fixed timer can fire before the fake's setImmediate
  // when the event loop was stalled, which is how this flaked in CI.
  const badChild = guardedSpawn({ spawnFn: bad.fn, file: 'x', args: [], options: {}, key: 'spawn:open-in-editor', label: 'open-in-editor', onMiss: (k, r) => misses.push([k, r]) });
  await once(badChild, 'exit');
  assert.deepEqual(misses.map((m) => m[0]), ['spawn:open-in-editor']);
  assert.match(misses[0][1], /exited with code 1/);
  const good = fake('exit0');
  const goodChild = guardedSpawn({ spawnFn: good.fn, file: 'x', args: [], options: {}, key: 'spawn:ok', label: 'ok', onMiss: (k, r) => misses.push([k, r]) });
  await once(goodChild, 'exit');
  assert.equal(misses.length, 1, 'exit 0 reports nothing');
});

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gspawn-'));

test('shellSafePath: an absolute existing directory with ordinary characters is accepted', () => {
  const root = tmpRoot();
  const d = path.join(root, 'My Project-1.2_x');
  fs.mkdirSync(d);
  const r = shellSafePath(d, { kind: 'dir' });
  assert.equal(r.ok, true);
  assert.equal(r.path, path.resolve(d));
});

test('shellSafePath: shell metacharacters are refused by name even when the directory really exists', () => {
  const root = tmpRoot();
  // Real directories, so the refusal is the metacharacter check, not a missing path.
  for (const name of ['a & calc', 'b ^ c', '%PATH%', '$(whoami)', 'semi;colon', 'pipe|x', 'back`tick`', "quote'x", 'bang!']) {
    const d = path.join(root, name);
    // '|' is not a legal Windows file name; that one is tested as a string only.
    try { fs.mkdirSync(d); } catch (e) { assert.ok(e.code, `mkdir ${name} failed without a code: ${e.message}`); }
    const r = shellSafePath(d, { kind: 'dir' });
    assert.equal(r.ok, false, `${name} must be refused`);
    assert.match(r.reason, /shell metacharacter/);
  }
  // A double quote cannot be a Windows file name; it must be refused as a string.
  const q = shellSafePath(path.join(root, 'a" & calc & "'), { kind: 'dir' });
  assert.equal(q.ok, false);
  assert.match(q.reason, /shell metacharacter/);
});

test('shellSafePath: relative, missing, wrong-kind and non-string values are refused by name', () => {
  const root = tmpRoot();
  assert.match(shellSafePath('relative/dir').reason, /not an absolute path/);
  assert.match(shellSafePath(path.join(root, 'nope')).reason, /not found/);
  const f = path.join(root, 'f.txt');
  fs.writeFileSync(f, 'x');
  assert.match(shellSafePath(f, { kind: 'dir' }).reason, /not a directory/);
  assert.match(shellSafePath(root, { kind: 'file' }).reason, /not a file/);
  assert.equal(shellSafePath(f, { kind: 'file' }).ok, true);
  assert.match(shellSafePath(42).reason, /not a string/);
  assert.match(shellSafePath('').reason, /not a string/);
});

// Task 7 final review carry-in (c): \p{L} alone includes the Lm (modifier
// letter) category, and some legacy code pages best-fit a modifier letter to
// an ordinary ASCII quote character when they cannot represent it. A path
// carrying one of these would pass the old allowlist as "just a letter" and
// then be reinterpreted as a quote by whatever downstream tool best-fits it,
// which is exactly the shape of hazard this allowlist exists to refuse.
test('shellSafePath: modifier letters (Lm) that some code pages best-fit to quotes are refused', () => {
  const root = tmpRoot();
  for (const ch of ['\u02BA', '\u02BC']) {
    const label = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
    const d = path.join(root, `a${ch}b`);
    try { fs.mkdirSync(d); } catch (e) { assert.ok(e.code, `mkdir for ${label} failed without a code: ${e.message}`); }
    const r = shellSafePath(d, { kind: 'dir' });
    assert.equal(r.ok, false, `${label} must be refused`);
    assert.match(r.reason, /shell metacharacter/);
    assert.equal(shellSafePathSyntax(d).ok, false, `${label} must be refused at the syntax stage alone, with no stat involved`);
  }
});

// Task 7 final review carry-in (a): the syntax stage (character set, absolute
// path) must be usable with NO filesystem access at all, so a caller can run
// it before any allowlist check without paying for a stat on an unvetted
// path (a UNC share, for instance).
//
// CI fix round: "a well-formed absolute path" is platform-dependent (that is
// the whole point of running path.isAbsolute rather than a hardcoded regex -
// see the comment above shellSafePathSyntax), so the literal under test has
// to be absolute on whichever OS is actually running this file. A literal
// Windows drive path is never absolute under posix.
test('shellSafePathSyntax: accepts a well-formed absolute path and never touches the filesystem', () => {
  const p = process.platform === 'win32' ? 'C:\\Users\\someone\\My Project' : '/Users/someone/My Project';
  const r = shellSafePathSyntax(p);
  assert.equal(r.ok, true);
  assert.equal(r.path, path.resolve(p));
});

test('shellSafePathSyntax: refuses a shell metacharacter and a relative path by name, with no stat', () => {
  const withMeta = process.platform === 'win32' ? 'C:\\a & calc' : '/a & calc';
  assert.match(shellSafePathSyntax(withMeta).reason, /shell metacharacter/);
  assert.match(shellSafePathSyntax('relative\\dir').reason, /not an absolute path/);
  assert.match(shellSafePathSyntax(42).reason, /not a string/);
});

// a UNC path (\\host\share) or a Windows device/extended-path
// prefix (\\?\..., \\.\...) must never reach a stat at all - over SMB a stat
// is a real outbound network call, and its success/failure is an existence
// oracle for a host this validator has no business asking about. Refused at
// the syntax stage, before shellSafePath ever calls its stat seam, so every
// route built on it (resume, terminal, open-in-editor) is covered for free.
test('shellSafePathSyntax: refuses a UNC path and device/extended-path prefixes by name, with no stat', () => {
  for (const p of ['\\\\host\\share\\secret.md', '//host/share/secret.md', '\\\\?\\C:\\Windows\\System32', '\\\\.\\PhysicalDrive0']) {
    const r = shellSafePathSyntax(p);
    assert.equal(r.ok, false, `${p} must be refused`);
    assert.match(r.reason, /UNC|device/);
  }
});

test('shellSafePath: a UNC cwd never reaches the injected stat seam', () => {
  const statCalls = [];
  const fsImpl = { statSync: (...args) => { statCalls.push(args); throw new Error('must not be called'); } };
  const r = shellSafePath('\\\\host\\share\\dir', { kind: 'dir', fsImpl });
  assert.equal(r.ok, false);
  assert.match(r.reason, /UNC|device/);
  assert.equal(statCalls.length, 0, 'a UNC path must be refused before any stat is attempted');
});

// U+30FC (KATAKANA-HIRAGANA PROLONGED SOUND MARK) and U+3005
// (IDEOGRAPHIC ITERATION MARK) are both category Lm, but they are ordinary,
// extremely common Japanese characters (long-vowel mark, kanji repeat mark),
// not best-fit quote lookalikes - excluding all of Lm (carry-in c) wrongly
// refused real Japanese filenames. U+02BA/U+02BC (the actual quote
// lookalikes) must stay refused.
test('shellSafePath: ordinary Japanese characters (U+30FC, U+3005) are allowed; quote-lookalike modifier letters stay refused', () => {
  const root = tmpRoot();
  for (const ch of ['\u30FC', '\u3005']) {
    const label = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
    const d = path.join(root, `a${ch}b`);
    fs.mkdirSync(d);
    const r = shellSafePath(d, { kind: 'dir' });
    assert.equal(r.ok, true, `${label} must be allowed`);
  }
  for (const ch of ['\u02BA', '\u02BC']) {
    const label = `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
    assert.equal(shellSafePathSyntax(path.join(root, `a${ch}b`)).ok, false, `${label} must stay refused`);
  }
});

// Phase C final review, M11: \p{M} (the whole Unicode "Mark" category -
// combining diacritics) was allowed with no demonstrated real-world need,
// unlike U+30FC/U+3005 above (each carved back in by codepoint for an actual
// Japanese-filename case). Narrowed to exclude \p{M} by default; \p{N}
// (ordinary digits, needed for any numbered path) stays. U+030E (COMBINING
// DOUBLE VERTICAL LINE ABOVE) is category Mn (a combining mark) and must now
// be refused.
test('M11: a combining mark (U+030E) is refused - \\p{M} was removed from the allowlist with no demonstrated need; digits still pass', () => {
  const root = tmpRoot();
  assert.equal(shellSafePathSyntax(path.join(root, 'a\u030Eb')).ok, false, 'U+030E (a combining mark) must be refused');
  const digits = path.join(root, 'a123b');
  fs.mkdirSync(digits);
  assert.equal(shellSafePath(digits, { kind: 'dir' }).ok, true, '\\p{N} (ordinary digits) must still be allowed');
});

test('shellArg: double-quotes a validated path, and never ends in a backslash before the closing quote', () => {
  assert.equal(shellArg('C:\\a b\\c'), '"C:\\a b\\c"');
  // A trailing separator would turn \" into an escaped quote for the target's argv parser.
  assert.equal(shellArg('C:\\'), '"C:\\."');
  assert.equal(shellArg('/'), '"/."');
});

// shellArg is handed to cmd.exe via a shell spawn, and double
// quotes do not neutralise & | < > ^ % ! or an embedded quote there.
test('shellArg refuses cmd.exe metacharacters instead of quoting them', () => {
  for (const ch of ['&', '|', '<', '>', '^', '%', '!', '"', '`', '$', ';', '(', ')', '\n', '\r', '\0']) {
    assert.throws(() => shellArg(`C:\\a${ch}b`), /shell metacharacter/, JSON.stringify(ch));
  }
  assert.throws(() => shellArg('C:\\a & calc'), /shell metacharacter/);
  assert.throws(() => shellArg('C:\\%PATH%\\x'), /shell metacharacter/);
  assert.equal(shellArg('C:\\Users\\a-b_c+d,e=f@g#h~i\\x.js'), '"C:\\Users\\a-b_c+d,e=f@g#h~i\\x.js"');
});
