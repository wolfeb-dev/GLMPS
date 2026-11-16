// The globe's lowest layer (D17): a repository's folders and every file that
// differs from its upstream, and one file's diff in the change shape
// renderDiff (web/shared/diff-view.js) already draws. Repositories are named,
// never passed as paths: a name must be a row of the K5 residency feed.
// Git runs through async execFile (the event-loop rule), never execFileSync.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitLimiter } from '../git-limiter.js';

const execFileAsync = promisify(execFile);
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
// A real filesystem path or a raw git stderr line names the operator's
// machine layout; that never belongs in a client-facing error body (fix
// round 1, D-surface Task 9). The route stays on a small set of fixed
// strings and the actual reason goes to the server's own log instead.
const logRefused = (reason) => console.error(`[surface] ${reason}`);

// repoTree alone fans out 4 concurrent git calls per repo, and every
// tree/diff request goes through defaultExec: gitLimiter (lib/git-limiter.js)
// is the same process-wide pool server.js's own git scan uses, so the two
// callers' concurrent git usage is capped together rather than each keeping
// an independent pool.
export function defaultExec(file, args, opts = {}) {
  return gitLimiter(() => execFileAsync(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: gitChildEnv(process.env), ...opts }));
}

// the server's own environment may carry variables that
// point git at a different repository, index or config (a GIT_DIR left by
// a hook, a GIT_CONFIG_* injection). A named residency repository is read
// as itself, so those never reach the child. Matched case-insensitively
// (Windows environment names are).
const REDIRECTING_GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXEC_PATH|EXTERNAL_DIFF|CONFIG.*)$/i;
export function gitChildEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!REDIRECTING_GIT_ENV.test(k)) out[k] = v;
  return out;
}

// Task 16, S-F3 / S-L2: the single choke point every git call in this
// module goes through. --no-optional-locks keeps `git status` from
// rewriting .git/index (index.lock contention with the operator's own
// commits; mirrors kernel/git-remote-feed.js), and no fsmonitor or hook
// program is ever run on the server's behalf.
const HARDEN = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devnull}`];
export const runGit = (exec, repoPath, args) => exec('git', [...HARDEN, '-C', repoPath, ...args]);

export function resolveResidencyRepo(stateDir, repo) {
  if (typeof repo !== 'string' || !repo) return { error: 'repo is required', status: 400 };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(stateDir, 'residency', 'current.json'), 'utf8')); }
  catch (e) { return { error: `residency feed not available (${e.code ?? e.message})`, status: 503 }; }
  const row = (Array.isArray(doc?.rows) ? doc.rows : []).find((r) => r && r.repo === repo);
  return row ? { row } : { error: `unknown repository: ${repo}`, status: 404 };
}

export function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1024 || rel.includes('\0')) return null;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  if (norm.split('/').some((s) => s === '' || s === '..' || s === '.')) return null;
  return norm;
}

async function upstreamOf(repoPath, exec) {
  try {
    const { stdout } = await runGit(exec, repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    return stdout.trim() || null;
  } catch (e) {
    // git exits 128 with "no upstream configured" for a branch with no upstream:
    // that is a state, not a failure. Anything else is a real error.
    if (/no upstream|does not point to a branch|HEAD does not point/i.test(String(e.stderr ?? e.message))) return null;
    throw e;
  }
}

const splitZ = (s) => String(s || '').split('\0').filter(Boolean);

function parsePorcelainZ(s) {
  const out = []; const parts = String(s || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    out.push({ path: e.slice(3), status: xy === '??' ? 'untracked' : 'uncommitted' });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the rename source follows
  }
  return out;
}

export async function repoTree({ repoPath, repo, exec = defaultExec, maxFiles = 2000 } = {}) {
  const git = (args) => runGit(exec, repoPath, args).then((r) => r.stdout);
  let upstream, ls, status, ahead, behind;
  try {
    upstream = await upstreamOf(repoPath, exec);
    [ls, status, ahead, behind] = await Promise.all([
      git(['ls-files', '-z']),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      upstream ? git(['diff', '--name-only', '-z', '@{u}...HEAD']) : Promise.resolve(''),
      upstream ? git(['diff', '--name-only', '-z', 'HEAD...@{u}']) : Promise.resolve(''),
    ]);
  } catch (e) {
    // A raw git failure (e.g. the residency row points at a path that is not
    // actually a git repository) carries the repository's absolute path in
    // its stderr: log it, but the route only ever hears a fixed reason.
    logRefused(`repo-tree read failed for ${repoPath}: ${e.stderr ?? e.message}`);
    throw httpError(500, 'repository read failed');
  }
  const byPath = new Map();
  for (const f of parsePorcelainZ(status)) byPath.set(f.path, f.status);
  for (const p of splitZ(ahead)) if (!byPath.has(p)) byPath.set(p, 'ahead');
  for (const p of splitZ(behind)) if (!byPath.has(p)) byPath.set(p, 'behind');
  const top = (p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '.');
  const folders = new Map();
  for (const p of splitZ(ls)) { const d = top(p); const f = folders.get(d) ?? { dir: d, count: 0, drifted: 0 }; f.count++; folders.set(d, f); }
  for (const p of byPath.keys()) { const d = top(p); const f = folders.get(d) ?? { dir: d, count: 0, drifted: 0 }; f.drifted++; folders.set(d, f); }
  const files = [...byPath].map(([p, s]) => ({ path: p, status: s })).sort((a, b) => a.path.localeCompare(b.path));
  const shown = files.slice(0, maxFiles);
  for (const f of shown) {
    try {
      const st = fs.statSync(path.join(repoPath, ...f.path.split('/')));
      f.size = st.size; f.mtimeMs = st.mtimeMs;
    } catch { f.size = null; f.mtimeMs = null; }
  }
  return {
    repo, path: repoPath, base: upstream ? '@{u}' : 'HEAD',
    folders: [...folders.values()].sort((a, b) => b.count - a.count),
    files: shown, truncated: files.length > maxFiles,
  };
}

function clip(text, maxBytes) {
  if (text == null) return null;
  if (text.includes('\0')) return { text: '(binary file)', truncated: false };
  if (Buffer.byteLength(text) > maxBytes) return { text: Buffer.from(text).subarray(0, maxBytes).toString('utf8'), truncated: true };
  return { text, truncated: false };
}

// the working side is read at most maxBytes+1 bytes (stat
// first, then one bounded readSync), never the whole file before clipping.
// An over-bound file is reported truncated, with its real size.
function readWorkingHead(abs, maxBytes) {
  const size = fs.statSync(abs).size;
  const buf = Buffer.alloc(Math.min(size, maxBytes + 1));
  const fd = fs.openSync(abs, 'r');
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  const head = buf.subarray(0, n);
  if (head.includes(0)) return { text: '(binary file)', truncated: false };
  if (size > maxBytes) return { text: head.subarray(0, maxBytes).toString('utf8'), truncated: true, size };
  return { text: head.toString('utf8'), truncated: false };
}

export async function fileDiff({ repoPath, repo, relPath, exec = defaultExec, fileApi, maxBytes = 200000 } = {}) {
  const rel = safeRelPath(relPath);
  if (!rel) throw httpError(400, 'invalid path');
  // a repository's own internals are never a drifted file.
  if (rel.split('/')[0].toLowerCase() === '.git') {
    logRefused(`file-diff refused a .git path in ${repoPath}`);
    throw httpError(403, 'path not allowed');
  }
  const root = fs.realpathSync(repoPath);
  const abs = path.join(repoPath, ...rel.split('/'));
  if (!path.resolve(abs).startsWith(path.resolve(repoPath) + path.sep)) throw httpError(400, 'path escapes the repository');
  const exists = fs.existsSync(abs);
  if (exists && !fs.realpathSync(abs).startsWith(root + path.sep)) throw httpError(400, 'path escapes the repository');
  // the hardlink refusal moved into FileApi._check itself (so
  // every FileApi caller gets it, not just this one), so assertAllowed alone
  // now covers both the sensitivity/symlink check and the hardlink check.
  try { fileApi.assertAllowed(abs); }
  catch (e) {
    logRefused(`file-diff refused ${abs}: ${e.message}`);
    throw httpError(403, 'path not allowed');
  }
  const newSide = exists ? readWorkingHead(abs, maxBytes) : null;
  let upstream;
  try { upstream = await upstreamOf(repoPath, exec); }
  catch (e) {
    logRefused(`file-diff upstream lookup failed for ${repoPath}: ${e.stderr ?? e.message}`);
    throw httpError(500, 'repository read failed');
  }
  const base = upstream ? '@{u}' : 'HEAD';
  let oldText = null;
  try { oldText = (await runGit(exec, repoPath, ['show', `${base}:${rel}`])).stdout; }
  catch (e) {
    // A file that is new on this side has no committed version: that is the
    // "added" diff, not an error. Anything else is a real git failure.
    if (!/does not exist in|exists on disk, but not in|path .* does not exist/i.test(String(e.stderr ?? e.message))) {
      logRefused(`file-diff git show failed for ${repoPath}:${rel}: ${e.stderr ?? e.message}`);
      throw httpError(500, 'repository read failed');
    }
  }
  return { repo, path: rel, absPath: abs, base, change: { old: clip(oldText, maxBytes), new: newSide } };
}
