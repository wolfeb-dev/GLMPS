// server/lib/orchestration/affected-tests.js
//
// Which test files a change affects, and the test command that runs only
// those (card glmps-2-0-runtime-98, F6; spec:
// docs/specs/2026-10-29-merge-queue-affected-tests.md). Pure: callers pass the
// changed paths, the tracked test files and a reader.

// Changing any of these can change how every test runs.
const FULL_SUITE_FILES = new Set(['package.json', 'package-lock.json', 'test.env']);

// cmd.exe stops at 8,191 characters and the desktop shell runs the command
// through it, so a longer list is split into several commands.
export const MAX_COMMAND_CHARS = 7000;

const norm = (p) => String(p).replace(/\\/g, '/');
const baseName = (p) => norm(p).split('/').pop();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isTestFile = (p) => /\.test\.[cm]?js$/.test(norm(p));

// A repo-wide rule test (a tree scan, an allowlist) names none of the files it
// polices, so name matching never picks it; the file opts in with this line.
const ALWAYS_RUN = /^\/\/ affected-tests: always\s*$/m;

// How many import hops from a test file are followed; deep enough for the
// server's own module graph, short enough that a cycle-free chain of
// re-exports cannot make one pick walk the whole tree.
export const MAX_IMPORT_DEPTH = 12;

const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.\.?\/[^'"\n]+)\1/g;
const RESOLVE_SUFFIXES = ['', '.js', '.mjs', '.cjs', '/index.js'];

// Collapse `.` and `..` segments; null when the path climbs out of the repo.
function joinRel(dir, spec) {
  const out = [];
  for (const seg of `${dir}/${spec}`.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

function makeImportGraph(readFile) {
  const sources = new Map();
  const read = (p) => {
    if (!sources.has(p)) {
      let s = null;
      try { const v = readFile(p); s = v == null ? null : String(v); } catch { s = null; }
      sources.set(p, s);
    }
    return sources.get(p);
  };
  const edges = new Map();
  const importsOf = (file, src) => {
    if (edges.has(file)) return edges.get(file);
    const dir = file.split('/').slice(0, -1).join('/');
    const found = [];
    for (const m of src.matchAll(IMPORT_SPEC)) {
      const base = joinRel(dir, m[2].split(/[?#]/)[0]);
      if (!base) continue;
      const hit = RESOLVE_SUFFIXES.map((s) => base + s).find((p) => read(p) != null);
      if (hit) found.push(hit);
    }
    edges.set(file, found);
    return found;
  };
  /** True when a file in `targets` is reachable from `file` within the depth bound. */
  return (file, src, targets) => {
    const seen = new Set([file]);
    let frontier = [[file, src]];
    for (let depth = 0; depth < MAX_IMPORT_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const [f, s] of frontier) {
        for (const dep of importsOf(f, s)) {
          if (targets.has(dep)) return true;
          if (seen.has(dep)) continue;
          seen.add(dep);
          next.push([dep, read(dep)]);
        }
      }
      frontier = next;
    }
    return false;
  };
}

/**
 * { files, full }: the affected test files (sorted), or `full` set to the
 * reason the whole suite must run. A test file is affected when the change
 * touches it, its source names a changed file by basename as a path segment
 * (an import, or a fixture read through path.join), or it reaches a changed
 * file through static relative imports within MAX_IMPORT_DEPTH hops (card
 * glmps-2-0-179). `readFile` is asked for source files as well as tests and
 * may throw for a missing one. A test marked always-run is affected by any
 * change beyond markdown.
 */
export function selectAffectedTests({ changed = [], testFiles = [], readFile }) {
  const paths = changed.map(norm).filter(Boolean);
  const trigger = paths.find((p) => FULL_SUITE_FILES.has(p));
  if (trigger) return { files: [], full: `the change touches ${trigger}` };
  const tests = new Set(testFiles.map(norm));
  const picked = new Set(paths.filter((p) => tests.has(p)));
  const sourceChanges = new Set(paths.filter((p) => !isTestFile(p)));
  const patterns = [...new Set([...sourceChanges].map(baseName))]
    .map((b) => new RegExp(`(?:^|[\\\\/'"\`])${esc(b)}(?=['"\`]|$)`, 'm'));
  const always = paths.some((p) => !/\.md$/i.test(p));
  const reaches = makeImportGraph(readFile);
  if (patterns.length || always) {
    for (const t of tests) {
      if (picked.has(t)) continue;
      let src;
      try { src = String(readFile(t) ?? ''); } catch { continue; }
      if ((always && ALWAYS_RUN.test(src)) || patterns.some((re) => re.test(src))
        || (sourceChanges.size && reaches(t, src, sourceChanges))) picked.add(t);
    }
  }
  return { files: [...picked].sort(), full: null };
}

// The desktop shell runs a test command only when every argument matches its
// token rule (validTestCommand in apps/shell/src/lib/gitops-allow.js, which
// core may not import): unquoted, relative, no `..`, no code-loading flag.
const SHELL_TOKEN = /^[A-Za-z0-9_.=:@*/-]+$/;
const SHELL_CODE_FLAGS = /^(--import|--require|-r|--eval|-e|-p|--print|--loader|--experimental-loader)\b/;
const shellToken = (t) => SHELL_TOKEN.test(t) && !t.startsWith('/') && !t.includes('..') && !SHELL_CODE_FLAGS.test(t);
const shellAllows = (cmd) => {
  const m = /^node --test((?: \S+)*)$/.exec(cmd);
  return !!m && m[1].split(' ').filter(Boolean).every(shellToken);
};

/**
 * The repo's `node --test ... "<glob>"` script with the trailing glob replaced
 * by the unquoted file list, split into as many commands as the length budget
 * needs (run them in order). Null when the script has another shape or any
 * command would fail the shell's token rule; the stage then runs the full
 * suite rather than be refused by the shell and held.
 */
export function affectedCommands(script, files) {
  if (!Array.isArray(files) || !files.length) return null;
  const m = /^(node\s(?:.*\s)?--test(?:\s.*)?)\s+("[^"]*\*[^"]*"|'[^']*\*[^']*'|[^\s"'&|;<>]*\*[^\s"'&|;<>]*)\s*$/.exec(String(script ?? '').trim());
  if (!m) return null;
  if (!files.every((f) => shellToken(norm(f)))) return null;
  const out = [];
  let cur = m[1];
  let n = 0;
  for (const f of files) {
    const arg = ` ${norm(f)}`;
    if (n && cur.length + arg.length > MAX_COMMAND_CHARS) { out.push(cur); cur = m[1]; n = 0; }
    cur += arg; n += 1;
  }
  out.push(cur);
  return out.every(shellAllows) ? out : null;
}

/** The single-command form, or null when the list needs more than one. */
export function affectedCommand(script, files) {
  const cmds = affectedCommands(script, files);
  return cmds?.length === 1 ? cmds[0] : null;
}
