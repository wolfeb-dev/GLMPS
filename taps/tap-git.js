// taps/tap-git.js
// The tap's git summary watcher (card glmps-2-0-runtime-40). Once a minute it
// finds the git repos on this client, reads each one's branch, HEAD, ahead/behind,
// dirty count and origin remote with two read-only git calls, and posts the set
// to the server when it changed (or every 10 minutes as a freshness beat). The
// server keeps its own clones for commit history; this never sends commits.
// Failures follow the shipper's ladder; a 401 or 426 stops it until the agent
// sees the client paired again.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { nextBackoffMs } from './tap-shipper.js';
import { parseStatus } from '../server/lib/observability/git-status.js';
import { findRepoDirs } from '../server/lib/orchestration/project-dirs.js';

export const GIT_PATH = '/api/tap/git';
export const GIT_TICK_MS = 60_000;
export const GIT_REPEAT_MS = 10 * 60_000;
export const GIT_MAX_REPOS = 300;
const GIT_CALL_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 30_000;
const BODY_SOFT_CAP = 240 * 1024; // the server refuses a body over 256 KiB
const ERROR_MAX = 300;
const REMOTE_MAX = 512;
const PATH_MAX = 1024;

const CONTROL = /[\u0000-\u001f\u007f]/;
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/;
const fwd = (p) => String(p).replace(/\\/g, '/');

/** Drops user:password@ from a URL remote; scp-style git@host:path carries no secret and is kept. */
export function stripUserinfo(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

const splitRoots = (v) => (typeof v === 'string' ? v.split(path.delimiter).map((x) => x.trim()).filter(Boolean) : []);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

function readJson(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** Where to look for repos: tap-config repoRoots, else the client's settings.json env, else the process env. */
export function resolveRepoSettings({ home, claudeDir, env = process.env }) {
  const cfg = home ? readJson(path.join(home, 'tap-config.json')) : null;
  const exclude = strings(cfg?.repoExclude);
  const configured = strings(cfg?.repoRoots);
  if (configured.length) return { roots: configured, exclude };
  const settings = claudeDir ? readJson(path.join(claudeDir, 'settings.json')) : null;
  const fromSettings = splitRoots(settings?.env?.GLMPS_PROJECT_ROOTS);
  if (fromSettings.length) return { roots: fromSettings, exclude };
  return { roots: splitRoots(env?.GLMPS_PROJECT_ROOTS), exclude };
}

const isUnder = (p, prefix) => {
  const a = fwd(p).toLowerCase();
  const b = fwd(prefix).toLowerCase().replace(/\/+$/, '');
  return a === b || a.startsWith(`${b}/`);
};

/** { repos: [{path, worktree}], skipped } sorted by path; skipped counts repos past the cap. */
export function discoverRepos({ roots, exclude = [] }) {
  const seen = new Set();
  const all = [];
  for (const dir of findRepoDirs(roots.map((r) => path.resolve(r)))) {
    const key = dir.toLowerCase();
    if (seen.has(key) || !ABSOLUTE.test(dir) || CONTROL.test(dir) || dir.length > PATH_MAX) continue;
    if (exclude.some((x) => isUnder(dir, x))) continue;
    seen.add(key);
    let worktree = false;
    try { worktree = fs.statSync(path.join(dir, '.git')).isFile(); } catch { worktree = false; }
    all.push({ path: dir, worktree });
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { repos: all.slice(0, GIT_MAX_REPOS), skipped: Math.max(0, all.length - GIT_MAX_REPOS) };
}

/** Real git: run(dir, args) -> {ok, stdout, stderr}. Never rejects. */
export function defaultRun(dir, args) {
  return new Promise((resolve) => {
    execFile('git', args, {
      encoding: 'utf8', windowsHide: true, timeout: GIT_CALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr || (err ? String(err.message ?? err) : '') }));
  });
}

const oneLine = (text) => String(text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, ERROR_MAX) || 'git failed';

const sound = (branch) => (typeof branch === 'string' && branch.length >= 1 && branch.length <= 255 && !CONTROL.test(branch) ? branch : null);

/** One summary row; a failed status call is a row with `error` rather than a missing repo. */
export async function summarizeRepo({ path: dir, worktree }, run = defaultRun) {
  const base = { path: dir, branch: null, head: null, detached: false, worktree: !!worktree, ahead: 0, behind: 0, dirty: 0, remote: null, error: null };
  try {
    const st = await run(dir, ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v2', '--branch']);
    if (!st.ok) return { ...base, error: oneLine(st.stderr) };
    const p = parseStatus(st.stdout);
    const rm = await run(dir, ['--no-optional-locks', '-C', dir, 'config', '--get', 'remote.origin.url']);
    let remote = rm.ok ? stripUserinfo(rm.stdout.split(/\r?\n/)[0]) : null;
    if (remote && (remote.length > REMOTE_MAX || CONTROL.test(remote))) remote = null;
    return { ...base, branch: p.detached ? null : sound(p.branch), head: p.head, detached: p.detached, ahead: p.ahead, behind: p.behind, dirty: p.dirty, remote };
  } catch (e) {
    return { ...base, error: oneLine(e?.message) };
  }
}

class Abort extends Error {
  constructor(kind, reason, extra = {}) { super(reason); this.kind = kind; Object.assign(this, extra); }
}

const digestOf = (repos) => crypto.createHash('sha256').update(JSON.stringify(repos)).digest('hex');

/** getCreds() -> {config, token} or null. getSettings() -> {roots, exclude}. */
export function createGitWatcher({
  getCreds, getSettings, run = defaultRun, fetch: fetchFn = globalThis.fetch, now = Date.now, log = console.error,
}) {
  let backoffMs = 0; let nextAt = 0;
  let inFlight = false; let stopped = null;
  let lastError = null; let lastScanTs = null; let lastPostTs = null;
  let postedDigest = null;
  let repoCount = 0; let skippedCount = 0;

  async function post(creds, body) {
    let res;
    try {
      res = await fetchFn(`${creds.config.server}${GIT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${creds.token}`, [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) { throw new Abort('fail', `server unreachable: ${e?.cause?.code || e?.message || String(e)}`); }
    if (res.status === 401) throw new Abort('stop', 'the server refused this client; pair it again', { stopped: 'unpaired' });
    if (res.status === 426) throw new Abort('stop', 'the server requires a newer tap protocol', { stopped: 'protocol-too-old' });
    if (res.status !== 200) throw new Abort('fail', `git summary answered ${res.status}`);
  }

  async function tick() {
    if (inFlight) return { skipped: 'in-flight' };
    if (stopped) return { skipped: stopped };
    if (now() < nextAt) return { skipped: 'backoff' };
    const creds = getCreds();
    if (!creds) return { skipped: 'no-credentials' };
    inFlight = true;
    try {
      const { roots, exclude } = getSettings();
      const found = discoverRepos({ roots, exclude });
      const repos = [];
      for (const r of found.repos) repos.push(await summarizeRepo(r, run));
      let skipped = found.skipped;
      while (repos.length && JSON.stringify(repos).length > BODY_SOFT_CAP) { repos.pop(); skipped++; }
      repoCount = repos.length; skippedCount = skipped; lastScanTs = now();
      const digest = digestOf(repos);
      if (digest === postedDigest && now() - lastPostTs < GIT_REPEAT_MS) return { posted: false };
      await post(creds, { scannedTs: lastScanTs, repos });
      postedDigest = digest; lastPostTs = now();
      backoffMs = 0; nextAt = 0; lastError = null;
      return { posted: true };
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      if (e.kind === 'stop') { stopped = e.stopped; lastError = e.message; return { posted: false, stopped }; }
      backoffMs = nextBackoffMs(backoffMs);
      nextAt = now() + backoffMs;
      lastError = e.message;
      log(`[tap-git] ${e.message}; retrying in ${Math.round(backoffMs / 1000)}s`);
      return { posted: false, reason: e.message, backoffMs };
    } finally { inFlight = false; }
  }

  return {
    tick,
    resume: () => { if (!stopped) return; stopped = null; backoffMs = 0; nextAt = 0; },
    busy: () => inFlight,
    status: () => ({
      state: stopped ?? (backoffMs ? 'backoff' : 'ok'),
      repos: repoCount, skipped: skippedCount, lastScanTs, lastPostTs, lastError, backoffMs, nextAttemptTs: nextAt || null,
    }),
  };
}
