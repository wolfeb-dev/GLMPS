// Which scripts/ files does a set of shipped files refer to? Used by the
// release-script test (card glmps-2-0-183) to prove the kernel and tap ship
// every script their own code calls. A reference is any of: a "scripts/<file>"
// string, a path.join('scripts', ...) call, or a relative import that resolves
// into scripts/. References in comments count too: a shipped comment that names
// an operator-only tool is a finding the test makes visible rather than hides.
import path from 'node:path';

const FILE_EXT = /\.(?:mjs|js|ps1|cmd|bat|sh|json)$/;
// Not apps/<name>/scripts/: those are the app's own, not the repo scripts dir.
const STRING_REF = /(?<![\w.-])(?<!apps[\\/][\w-]+[\\/])scripts[\\/]+((?:[\w.-]+[\\/]+)*[\w.-]+\.(?:mjs|js|ps1|cmd|bat|sh|json))(?![\w])/g;
// Not apps/<name>/scripts/, which is the app's own folder.
const JOIN_REF = /(?<!['"]apps['"]\s*,\s*['"][\w-]+['"]\s*,\s*)['"]scripts['"]((?:\s*,\s*['"][^'"]+['"])+)/g;
const IMPORT_REF = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)['"](\.{1,2}[\\/][^'"]+)['"]/g;

const norm = (p) => p.replace(/\\\\/g, '/').replace(/\\/g, '/').replace(/\/+/g, '/');

// Only real imports: a line that starts with import/export-from, or an awaited
// dynamic import. A fixture string that merely contains "import '...'" does not count.
// A `{ ... }` binding list may span lines (card glmps-2-0-227: the one-line form
// missed every multi-line import, so tests of dropped scripts shipped).
const STATIC_IMPORT = /^\s*(?:import\b(?:\{[^}'"]*\}|[^'"\n{])*?|export\b(?:\{[^}'"]*\}|[^'"\n{])*?\bfrom\s*)['"](\.{1,2}[\\/][^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /^\s*(?:(?:const|let|var)\s+[\w${},\s]+=\s*)?await\s+import\(\s*['"](\.{1,2}[\\/][^'"]+)['"]/gm;

/** Repo-relative scripts/ files `text` (a file at `from`) imports. */
export function scriptImportsIn(from, text) {
  const out = new Set();
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const m of text.matchAll(re)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(norm(from)), norm(m[1])));
      if (resolved.startsWith('scripts/') && FILE_EXT.test(resolved)) out.add(resolved);
    }
  }
  return out;
}

/** Repo-relative scripts/ files `text` (a file at repo path `from`) refers to. */
export function scriptRefsIn(from, text) {
  const refs = new Set();
  for (const m of text.matchAll(STRING_REF)) refs.add(norm(`scripts/${m[1]}`));
  for (const m of text.matchAll(JOIN_REF)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    const rel = norm(['scripts', ...parts].join('/'));
    if (FILE_EXT.test(rel)) refs.add(rel);
  }
  for (const m of text.matchAll(IMPORT_REF)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(norm(from)), norm(m[1])));
    if (resolved.startsWith('scripts/') && FILE_EXT.test(resolved)) refs.add(resolved);
  }
  return refs;
}

/**
 * Closure of script references over `files` ([{ path, text }] of the shipped
 * tree) plus the scripts they pull in. `read(path)` returns the text of a
 * script that is not already in `files`, or null when it does not exist.
 * Returns Map<scriptPath, Set<referencingPath>>.
 */
export function scriptClosure(files, read) {
  const refs = new Map();
  const queue = [...files];
  const seen = new Set(files.map((f) => norm(f.path)));
  while (queue.length) {
    const f = queue.shift();
    for (const r of scriptRefsIn(f.path, f.text)) {
      if (!refs.has(r)) refs.set(r, new Set());
      refs.get(r).add(norm(f.path));
      if (seen.has(r)) continue;
      seen.add(r);
      const text = read(r);
      if (text != null) queue.push({ path: r, text });
    }
  }
  return refs;
}
