// server/lib/evaluation/learning-apply.js
// Deterministic guard applier (injectable git + fs), the memory-promotion
// hand's request building, and result ingestion. Zero runtime dependencies.
//
// Guard proposer cutover: the free-form headless-composer proposer
// (buildIdeaApplyCommand, which used to compose a guard line from an idea's
// free text with no operator-specified rule) is DELETED. Composing a
// guard's RULE TEXT is now the GEPA plugin's job
// (server/lib/plugins/gepa-plugin.js); this module keeps applyGuard (the
// deterministic write-and-commit chokepoint every route lands through) and
// buildMemoryApplyCommand/ingestResults, which the 'promote to memory' path
// still uses.
//
// D20 deleted enqueueIdeaApply; server.js opens the memory-compose
// command through the same openSession the resume and new-terminal routes use
// (Antigravity when it can host it, else a native terminal, glmps-2-0-30).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { insertGuard, removeGuardLine } from './learning-templates.js';
import { recordShadow } from './shadow-arm.js';
import { DEFAULT_SIM_THRESHOLD } from './semantic-dedup.js';

// applyGuard({ assetsDir, file, section, rule, message, runGit, readFile, writeFile,
//              stateDir, taskClass, sid, recordShadow, simThreshold })
//   -> { commit, changed }
//
// Reads <assetsDir>/<file>, calls insertGuard, writes back if changed, then
// git-adds and git-commits via runGit.  Returns the HEAD sha regardless.
//
// simThreshold (optional, 0..1): forwarded to insertGuard's near-dup check
// (see semantic-dedup.js). Omit it to keep the old exact-match-only
// behavior; pass DEFAULT_SIM_THRESHOLD (the module default used by the
// live promote-to-global call site) to also treat a semantically-equivalent
// paraphrase of an existing guard line as already-present.
//
// Defaults:
//   readFile(absPath)        - node:fs readFileSync with utf-8
//   writeFile(absPath, data) - node:fs writeFileSync
//   runGit(args)             - spawnSync('git', ['-C', assetsDir, ...args]) stdout trimmed
//
// Shadow/control-arm wiring (glmps champion-challenger floor, Phase 2): when
// `stateDir` is passed, a successful apply (this function returning instead of
// throwing) is recorded as an actual "fired" shadow entry via shadow-arm.js - 
// this breaks the gap-recurrence confound described in the champion/challenger
// promotion plan. `stateDir` is opt-in: callers that omit it (e.g. the manual
// approve/promote HTTP routes in server.js) get no shadow recording at all,
// unchanged from before this wiring landed. `recordShadow` is injectable for
// tests; defaults to the real shadow-arm.js writer.

// The checkout this module runs from. A lesson commit there leaves the prod
// checkout ahead of origin and stalls every later --ff-only deploy (dev/prod T1).
function gitToplevel(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? '').trim() || null;
  } catch { return null; }
}

function samePath(a, b) {
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync.native(r); } catch { /* keep the resolved form */ }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function applyGuard(opts = {}) {
  const { section, rule, simThreshold } = opts;
  return commitGuardEdit(opts, (content) => insertGuard(content, section, rule, simThreshold), true);
}

// removeGuard(opts) -> { commit, changed }
//
// Same options and the same commit/publish path as applyGuard, removing the
// rule line instead of adding it (card glmps-2-0-201's revert). Records no
// shadow fire: taking a guard out is not the guard firing.
export function removeGuard(opts = {}) {
  const { section, rule } = opts;
  return commitGuardEdit(opts, (content) => removeGuardLine(content, section, rule), false);
}

function commitGuardEdit({
  assetsDir,
  file,
  message,
  runGit,
  readFile,
  writeFile,
  stateDir,
  taskClass = 'other',
  sid = null,
  recordShadow: recordShadowFn = recordShadow,
  serverRoot,
  toplevelOf = gitToplevel,
  publish = false,
  now = Date.now,
} = {}, edit, recordFire) {
  const ownRoot = serverRoot === undefined ? gitToplevel(path.dirname(fileURLToPath(import.meta.url))) : serverRoot;
  const assetsRoot = ownRoot ? toplevelOf(assetsDir) : null;
  if (ownRoot && assetsRoot && samePath(ownRoot, assetsRoot)) {
    throw new Error(`refusing to commit in the server's own checkout (${ownRoot}): set the assets write dir to a separate clone (dev/prod T5)`);
  }

  // Build defaults when not injected.
  const absPath = path.join(assetsDir, file);

  const _readFile = readFile ?? ((p) => {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch (e) {
      if (e.code === 'ENOENT') return '';
      throw e;
    }
  });

  const _writeFile = writeFile ?? ((p, data) => fs.writeFileSync(p, data, 'utf-8'));

  // opts.network marks pull/fetch/push: no credential prompt, bounded wait.
  const _runGit = runGit ?? ((args, opts = {}) => {
    const result = spawnSync('git', ['-C', assetsDir, ...args], opts.network
      ? { encoding: 'utf8', windowsHide: true, timeout: NETWORK_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      : { encoding: 'utf8', windowsHide: true });
    // Surface git failures instead of silently marking a bad apply "applied":
    // a non-zero exit (not a repo, nothing staged, identity unset, hook reject)
    // must throw so the route marks the item failed with a real reason.
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
    return (result.stdout ?? '').trim();
  });

  if (publish) {
    return publishGuard({ _runGit, file, absPath, _readFile, _writeFile, edit, message, now, stateDir: recordFire ? stateDir : null, taskClass, sid, recordShadowFn });
  }

  // Read the current file content (treat missing as empty string).
  const current = _readFile(absPath);

  const { content, changed } = edit(current);

  if (changed) {
    _writeFile(absPath, content);
    _runGit(['add', file]);
    _runGit(['commit', '-m', message]);
  }

  // Always return HEAD sha.
  const commit = _runGit(['rev-parse', 'HEAD']);

  // Reached without throwing -> the apply succeeded. Record the actual-fire
  // shadow arm (opt-in via stateDir; see module doc comment above).
  if (stateDir && recordFire) {
    recordShadowFn(stateDir, { taskClass, fired: true, sid });
  }

  return { commit, changed };
}

const NETWORK_TIMEOUT_MS = 60000;

// owner/name from an https or ssh remote URL; null for anything else (a local
// path remote has no owner, so it cannot match a configured auto-deploy repo).
export function repoSlug(url) {
  const m = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// Publish mode (dev/prod T5): pull, commit only under assets/, push to the
// clone's upstream with one fetch+rebase retry. Any failure after the commit
// resets the clone so the next lesson's --ff-only pull is not blocked.
function publishGuard({ _runGit, file, absPath, _readFile, _writeFile, edit, message, now, stateDir, taskClass, sid, recordShadowFn }) {
  const net = (args) => _runGit(args, { network: true });
  try { net(['pull', '--ff-only']); } catch (e) { throw new Error(`dev clone pull failed: ${e.message}`); }

  const { content, changed } = edit(_readFile(absPath));
  if (!changed) {
    const commit = _runGit(['rev-parse', 'HEAD']);
    if (stateDir) recordShadowFn(stateDir, { taskClass, fired: true, sid });
    return { commit, changed: false };
  }

  const headRef = _runGit(['symbolic-ref', '-q', 'HEAD']);
  const [remote, remoteRef] = _runGit(['for-each-ref', '--format=%(upstream:remotename)|%(upstream:remoteref)', headRef]).split('|');
  if (!remote || !remoteRef) throw new Error('dev clone has no upstream branch to push to');
  const branch = remoteRef.replace(/^refs\/heads\//, '');

  const before = _runGit(['rev-parse', 'HEAD']);
  const rollback = () => { try { _runGit(['reset', '--hard', before]); } catch { /* best effort */ } };
  try {
    _writeFile(absPath, content);
    _runGit(['add', file]);
    _runGit(['commit', '-m', message, '--', file]);
    const paths = _runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split(/\r?\n/).filter(Boolean);
    if (!paths.length || paths.some((p) => !p.startsWith('assets/'))) {
      throw new Error(`refusing to publish a lesson commit that touches paths outside assets/: ${paths.join(', ')}`);
    }
  } catch (e) { rollback(); throw e; }

  const push = () => net(['push', remote, `HEAD:refs/heads/${branch}`]);
  try {
    try { push(); } catch {
      net(['fetch', remote]);
      try { _runGit(['rebase', '@{u}']); } catch (e) {
        try { _runGit(['rebase', '--abort']); } catch { /* nothing to abort */ }
        throw e;
      }
      push();
    }
  } catch (e) {
    rollback();
    throw new Error(`lesson push failed twice: ${e.message}`);
  }

  const commit = _runGit(['rev-parse', 'HEAD']);
  let url = '';
  try { url = _runGit(['remote', 'get-url', remote]); } catch { /* repo stays null */ }
  if (stateDir) recordShadowFn(stateDir, { taskClass, fired: true, sid });
  return { commit, changed: true, pushed: { repo: repoSlug(url), branch, sha: commit, ts: now() } };
}

// buildMemoryApplyCommand(id, paths) -> string
//
// Builds a `claude -p "..."` command for promote-to-memory: instruct the headless
// hand to compose a proper memory file (frontmatter + Why/How body) into
// paths.memoryDir and add a one-line pointer to that dir's MEMORY.md, matching the
// existing memory format. The result is a shell string (openSession hands it to
// the user's terminal, whose shell is unknown), so nothing is escaped: instead
// the id must match a strict pattern and each path must be free of characters
// that any of cmd, PowerShell or sh treat specially inside double quotes, and
// the instruction text is fixed and metacharacter-free. Otherwise it throws.
// paths: { requestPath, resultPath, memoryDir }.

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Backslash and colon stay legal (Windows paths); everything a shell expands or
// terminates a quoted string with does not.
const UNSAFE_PATH_CHAR = /["`$%!^&|<>;\n\r\0]/;

function assertSafePath(name, value) {
  // Printable ASCII only: PowerShell also ends a quoted string at typographic
  // quotes (U+2018/2019/201C/201D/201E), and no list of those is complete.
  if (typeof value !== 'string' || !value || UNSAFE_PATH_CHAR.test(value) || /[^\x20-\x7e]/.test(value)) {
    throw new Error(`buildMemoryApplyCommand: unsafe ${name}`);
  }
}

export function buildMemoryApplyCommand(id, paths) {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error('buildMemoryApplyCommand: unsafe id');
  assertSafePath('requestPath', paths?.requestPath);
  assertSafePath('resultPath', paths?.resultPath);
  assertSafePath('memoryDir', paths?.memoryDir);
  const instructions = [
    `You are promoting a learning to the user memory system (id: ${id}).`,
    `1. Read the request JSON at ${paths.requestPath} (it has the learning text and metadata).`,
    `2. Compose ONE memory file for the directory ${paths.memoryDir}: a short kebab-case slug filename ending in .md, with YAML frontmatter (name, a one-line description, and metadata.type set to feedback or project as fits), then a concise body. For feedback or project add a Why line and a How to apply line.`,
    `3. Write that memory file into ${paths.memoryDir}.`,
    `4. Add a one-line pointer to ${paths.memoryDir}/MEMORY.md under its index, matching the existing line format in that file (a dash, a markdown link to the new file, then a short hook).`,
    `5. Write ${paths.resultPath} as JSON with two fields: status set to applied, and file set to the memory filename you created.`,
    `Do not ask questions. Complete all steps silently.`,
  ].join(' ');
  return `claude -p "${instructions}"`;
}

// ingestResults(stateDir) -> [{ id, ...parsed }]
//
// Reads <stateDir>/learning/results/*.json, returns an array of parsed
// objects with `id` set to the filename without the .json extension.
// Deletes each good file after reading.  Returns [] if the directory is absent.
//
// A malformed file younger than MALFORMED_GRACE_MS is left alone: the hand
// writes the result in place, so a half-written file looks exactly like a bad
// one. An older malformed file is renamed to <name>.bad (kept for inspection,
// not deleted). Every per-file fs error is confined to that file.

const MALFORMED_GRACE_MS = 60 * 1000;

export function ingestResults(stateDir, { now = Date.now() } = {}) {
  const resultsDir = path.join(stateDir, 'learning', 'results');

  let entries;
  try {
    entries = fs.readdirSync(resultsDir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = path.join(resultsDir, entry);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      try {
        if (now - fs.statSync(filePath).mtimeMs >= MALFORMED_GRACE_MS) {
          fs.renameSync(filePath, filePath.replace(/\.json$/, '.bad'));
        }
      } catch { /* vanished or locked: the next ingest retries this file */ }
      continue;
    }
    const id = entry.slice(0, -'.json'.length);
    results.push({ id, ...parsed });
    try { fs.unlinkSync(filePath); } catch { /* an undeletable result is re-ingested next time; do not drop the batch */ }
  }

  return results;
}
