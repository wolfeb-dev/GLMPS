// One guarded spawn for every editor/terminal launch, and the validator for any
// request-derived path that has to reach a shell:true command line.
//
// Why a helper: spawn() fails in three different ways and a bare call handles
// none of them. (1) It can throw synchronously (EMFILE, a bad argument).
// (2) It reports ENOENT/EACCES as an ASYNC 'error' event on the child; with no
// listener, EventEmitter rethrows it as an uncaught exception and the server
// dies. (3) With shell:true a missing command is neither of those: the shell
// starts fine and exits 1 ("is not recognized" / "command not found"), so a
// non-zero exit code is the only real signal. Each becomes one named miss.
//
// Misses are keyed per ROUTE (spawn:resume, spawn:terminal, ...), never per
// job or request, so the health registry holds a bounded set of entries; the
// job id, when there is one, goes in the reason text instead.
import fs from 'node:fs';
import path from 'node:path';

export function guardedSpawn({ spawnFn, file, args = [], options = {}, key, label = key, onMiss }) {
  const miss = (reason) => onMiss(key, `${label}: ${reason}`);
  let child;
  try { child = spawnFn(file, args, options); }
  catch (e) { miss(e?.message ?? String(e)); return null; }
  if (!child) { miss('spawn returned no child'); return null; }
  child.on?.('error', (e) => miss(e?.message ?? String(e)));
  child.on?.('exit', (code) => { if (code != null && code !== 0) miss(`exited with code ${code}`); });
  child.unref?.();
  return child;
}

// Characters allowed in a path that will be placed, double-quoted, on a
// shell:true command line (cmd.exe on Windows, sh elsewhere). An allowlist,
// not a denylist: letters and digits in any script, space, and . _ - : \ / ~
// + , = @ #. Everything else is refused, which covers the cmd.exe set
// (& | < > ^ % ! " ( )) and the sh set ($ ` ; ' * ? [ ] { } newline).
// Parentheses are refused too, so a path under "Program Files (x86)" is
// refused rather than trusted; the caller reports that by name.
//
// Task 7 final review carry-in (c), fix round 1 M4: \p{L} alone includes the
// Lm (modifier letter) category. Some legacy code pages "best-fit" a
// modifier letter to an ordinary ASCII quote when they cannot represent it
// (U+02BA MODIFIER LETTER DOUBLE PRIME -> ", U+02BC MODIFIER LETTER
// APOSTROPHE -> ', for instance), so a path carrying one would pass this
// allowlist as "just a letter" and then be reinterpreted as the very quote
// character this allowlist exists to keep off a shell:true command line.
// Spelling out Lu/Ll/Lt/Lo (every letter category except Lm) instead of
// \p{L} closes that gap while still accepting real-world scripts (CJK,
// Cyrillic, accented Latin, and so on). U+30FC (KATAKANA-HIRAGANA PROLONGED
// SOUND MARK) and U+3005 (IDEOGRAPHIC ITERATION MARK) are ALSO category Lm,
// but they are ordinary, extremely common Japanese characters (the long-vowel
// mark and the kanji repeat mark) - not best-fit quote lookalikes - so
// excluding the whole Lm category wrongly refused real Japanese filenames.
// Allowed back explicitly, by codepoint, while every other Lm character
// (including U+02BA/U+02BC) stays refused.
// Phase C final review, M11: \p{M} (the whole Unicode "Mark" category -
// combining diacritics) used to be allowed here with no demonstrated
// real-world need, unlike U+30FC/U+3005 above (each carved back in by exact
// codepoint for an actual Japanese-filename case). Narrowed it out by
// default; \p{N} (ordinary digits) stays, since any numbered path needs it.
// Add a specific codepoint back the same way U+30FC/U+3005 were, if a real
// need is ever demonstrated - never the whole category again.
const SAFE_PATH = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\u30FC\u3005\p{N} ._\-:\\/~+,=@#]+$/u;

// a UNC path (\\host\share, //host/share) or a Windows
// device/extended-path prefix (\\?\..., \\.\...) must never reach a stat at
// all - over SMB a stat is a real outbound network call, and its
// success/failure is an existence oracle for a host this validator has no
// business asking about. Exactly two leading path separators followed by
// anything OTHER than a third separator covers all four forms; an ordinary
// drive path (C:\...) or POSIX path (/home/...) never matches (a drive path
// has no leading separator at all, and a POSIX path has exactly one).
const UNC_OR_DEVICE = /^[\\/]{2}(?![\\/])/;

// Task 7 final review carry-in (a): the character-set and absolute-path
// checks alone, with NO filesystem access. A caller that also has an
// allowlist to enforce (server.js's open-in-editor route, against
// FileApi's roots) must be able to run this FIRST, before any stat, so an
// unallowlisted path - a UNC share, for instance - is refused without ever
// triggering an outbound stat (which, over SMB, is a real network call and
// an existence oracle). shellSafePath below is built on top of this.
//
// CI fix round (glmps2 Slack lifecycle, cross-platform CI): the UNC/device
// check must run BEFORE path.isAbsolute, not after. path.isAbsolute comes
// from node:path, which resolves to win32 or posix semantics based on
// process.platform - this server runs (and is tested) on both. A backslash
// UNC literal like \\host\share is absolute under win32 but NOT under posix
// (posix absolute paths must start with /), so on a Linux-hosted process the
// old order fell through to "path is not an absolute path" before the UNC
// regex ever ran, losing the named UNC/device reason on that platform (the
// refusal itself - no stat, 400/403 - still held either way). UNC_OR_DEVICE
// is a plain two-separator regex with no platform dependence and never
// matches a real absolute path on either platform (a win32 path starts with
// a drive letter, a posix path has exactly one leading separator), so
// running it first is safe on both and makes the reported reason consistent
// regardless of which OS the server happens to run on.
export function shellSafePathSyntax(value) {
  if (typeof value !== 'string' || value === '') return { ok: false, reason: 'path is not a string' };
  if (UNC_OR_DEVICE.test(value)) return { ok: false, reason: 'path is a UNC or device path, not a local path' };
  if (!path.isAbsolute(value)) return { ok: false, reason: 'path is not an absolute path' };
  if (!SAFE_PATH.test(value)) return { ok: false, reason: 'path contains a shell metacharacter' };
  return { ok: true, path: path.resolve(value) };
}

export function shellSafePath(value, { kind = 'dir', fsImpl = fs } = {}) {
  const syn = shellSafePathSyntax(value);
  if (!syn.ok) return syn;
  const resolved = syn.path;
  let st;
  try { st = fsImpl.statSync(resolved); }
  catch (e) { return { ok: false, reason: `path not found (${e?.code ?? 'stat failed'})` }; }
  if (kind === 'dir' && !st.isDirectory()) return { ok: false, reason: 'path is not a directory' };
  if (kind === 'file' && !st.isFile()) return { ok: false, reason: 'path is not a file' };
  return { ok: true, path: resolved };
}

// Double-quote a path that shellSafePath accepted. A trailing separator would
// put a backslash right before the closing quote, which the target program's
// argv parser reads as an escaped quote, so a root like C:\ becomes C:\. (the
// same directory).
//
// The result goes to cmd.exe, where quotes do not neutralise & | < > ^ % ! or
// an embedded quote, so anything outside the same character set shellSafePath
// enforces is refused here too rather than trusted to the caller.
export function shellArg(p) {
  if (typeof p !== 'string' || p === '' || !SAFE_PATH.test(p)) {
    throw new Error('refusing to quote a path containing a shell metacharacter');
  }
  const s = /[\\/]$/.test(p) ? `${p}.` : p;
  return `"${s}"`;
}
