// server/lib/kernel/tap-git.js
// The server side of the tap's git summaries (card glmps-2-0-runtime-40): the
// canonical remote, body validation for POST /api/tap/git, and the per-client
// summary set in kernel.db. The client id always comes from the caller (the
// route resolves it from the token). The server only ever acts on the clone
// url it builds itself from a canonical remote, never on a client-supplied string.
import fs from 'node:fs';
import path from 'node:path';

export const GIT_MAX_REPOS = 300;
export const TAP_GIT_MAX_BYTES = 256 * 1024;

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const SCP_RE = /^git@([A-Za-z0-9.-]+):([^/\s]+)\/([^/\s]+)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ABSOLUTE = /^([A-Za-z]:[\\/]|\/)/;
const SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * { host, owner, repo, key, url } for https://, ssh:// and git@host:o/r remotes, else null.
 * Userinfo, port, query, fragment and a trailing .git or slash are dropped.
 */
export function canonicalRemote(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048 || CONTROL.test(raw) || /\s/.test(raw)) return null;
  let host; let owner; let repo;
  const scp = SCP_RE.exec(raw);
  if (scp) {
    [, host, owner, repo] = scp;
  } else {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'ssh:') return null;
    host = u.hostname;
    const segs = u.pathname.replace(/\/$/, '').split('/');
    if (segs.length !== 3 || segs[0] !== '') return null;
    [, owner, repo] = segs;
  }
  host = host.toLowerCase();
  if (repo.endsWith('.git')) repo = repo.slice(0, -4);
  if (!HOST_RE.test(host) || !NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { host, owner, repo, key: `${host}/${owner}/${repo}`, url: `https://${host}/${owner}/${repo}.git` };
}

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const textOrNull = (v, max) => v === null || v === undefined || (typeof v === 'string' && v.length >= 1 && v.length <= max && !CONTROL.test(v));

/** { repos } with unknown fields dropped, or { error } naming the first bad row. */
export function validateGitBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  if (!Array.isArray(body.repos)) return { error: 'repos must be an array' };
  if (body.repos.length > GIT_MAX_REPOS) return { error: `at most ${GIT_MAX_REPOS} repos` };
  const seen = new Set();
  const repos = [];
  for (let i = 0; i < body.repos.length; i++) {
    const r = body.repos[i];
    const at = `repos[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: `${at} must be an object` };
    if (typeof r.path !== 'string' || r.path.length < 1 || r.path.length > 1024 || CONTROL.test(r.path) || !ABSOLUTE.test(r.path)) return { error: `${at}.path must be an absolute path of 1 to 1024 characters` };
    const pk = r.path.toLowerCase();
    if (seen.has(pk)) return { error: `${at}.path is a duplicate` };
    seen.add(pk);
    if (!textOrNull(r.branch, 255)) return { error: `${at}.branch must be null or 1 to 255 characters` };
    if (!(r.head === null || r.head === undefined || (typeof r.head === 'string' && SHA_RE.test(r.head)))) return { error: `${at}.head must be null or a lowercase hex sha` };
    if (typeof r.detached !== 'boolean') return { error: `${at}.detached must be a boolean` };
    if (typeof r.worktree !== 'boolean') return { error: `${at}.worktree must be a boolean` };
    for (const k of ['ahead', 'behind', 'dirty']) if (!isCount(r[k])) return { error: `${at}.${k} must be a non-negative integer` };
    if (!textOrNull(r.remote, 512)) return { error: `${at}.remote must be null or up to 512 characters` };
    if (!textOrNull(r.error, 300)) return { error: `${at}.error must be null or up to 300 characters` };
    repos.push({
      path: r.path, branch: r.branch ?? null, head: r.head ?? null, detached: r.detached, worktree: r.worktree,
      ahead: r.ahead, behind: r.behind, dirty: r.dirty, remote: r.remote ?? null, error: r.error ?? null,
    });
  }
  return { repos };
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS tap_git_repos (
  client_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT, head TEXT, detached INTEGER NOT NULL, worktree INTEGER NOT NULL,
  ahead INTEGER NOT NULL, behind INTEGER NOT NULL, dirty INTEGER NOT NULL, remote TEXT, error TEXT, reported_ts INTEGER NOT NULL,
  PRIMARY KEY (client_id, path));`;

function loadSqlite() {
  let mod = null;
  try { mod = process.getBuiltinModule('node:sqlite'); } catch { mod = null; }
  if (!mod?.DatabaseSync) throw new Error(`node:sqlite unavailable on Node ${process.versions.node} (needs 22.13+, or --experimental-sqlite on 22.5 to 22.12)`);
  return mod.DatabaseSync;
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const fromRow = (r) => ({
  path: r.path, branch: r.branch, head: r.head, detached: !!r.detached, worktree: !!r.worktree,
  ahead: r.ahead, behind: r.behind, dirty: r.dirty, remote: r.remote, error: r.error, reportedTs: r.reported_ts,
});

export function openTapGit({ dbFile, now = Date.now }) {
  const DatabaseSync = loadSqlite();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const q = {
    del: db.prepare('DELETE FROM tap_git_repos WHERE client_id = ?'),
    put: db.prepare(`INSERT INTO tap_git_repos (client_id, path, branch, head, detached, worktree, ahead, behind, dirty, remote, error, reported_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    list: db.prepare('SELECT * FROM tap_git_repos WHERE client_id = ? ORDER BY path'),
    all: db.prepare('SELECT * FROM tap_git_repos ORDER BY client_id, path'),
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };

  return {
    replace(clientId, body) {
      const v = validateGitBody(body);
      if (v.error) return { status: 400, body: { error: v.error } };
      const ts = now();
      tx(() => {
        q.del.run(clientId);
        for (const r of v.repos) {
          const remote = canonicalRemote(r.remote)?.url ?? null;
          q.put.run(clientId, r.path, r.branch, r.head, r.detached ? 1 : 0, r.worktree ? 1 : 0, r.ahead, r.behind, r.dirty, remote, r.error, ts);
        }
      });
      return { status: 200, body: { ok: true, repos: v.repos.length } };
    },
    list: (clientId) => q.list.all(clientId).map(fromRow),
    statusForCwd(clientId, cwd) {
      if (typeof cwd !== 'string' || !cwd) return null;
      const c = norm(cwd);
      let best = null; let bestLen = -1;
      for (const r of q.list.all(clientId)) {
        const p = norm(r.path);
        if ((c === p || c.startsWith(`${p}/`)) && p.length > bestLen) { best = r; bestLen = p.length; }
      }
      return best ? { dirty: best.dirty, ahead: best.ahead, behind: best.behind, branch: best.detached ? '(detached)' : best.branch } : null;
    },
    remotes() {
      const byKey = new Map();
      for (const r of q.all.all()) {
        const canon = canonicalRemote(r.remote);
        if (!canon) continue;
        const entry = byKey.get(canon.key) ?? { ...canon, clients: new Map() };
        byKey.set(canon.key, entry);
        const heads = entry.clients.get(r.client_id) ?? new Set();
        entry.clients.set(r.client_id, heads);
        if (r.head) heads.add(r.head);
      }
      return [...byKey.values()].map((e) => ({ ...e, clients: [...e.clients].map(([clientId, heads]) => ({ clientId, heads: [...heads] })) }));
    },
    closeDb() { db.close(); },
  };
}
