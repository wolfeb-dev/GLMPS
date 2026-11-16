// server/lib/private-dirs.js
// The private-directory opt-out list.
//
// PROBLEM: scripts/sync-project-dirs.mjs adds every D:\ git repo to the
// harness's permissions.additionalDirectories, so `git init` on a directory
// silently makes its contents readable by EVERY agent session in every project.
// That is right for code and wrong for a directory like D:\Docs (resume,
// LinkedIn, job applications).
//
// SHAPE: "targeted-only" reachability. A private dir stays a real repo and is
// still resolved as a job cwd by repoForProject(), so a ticket scoped to that
// project launches in it - but it is dropped from collectGraphRoots(), which is
// the single source for /api/projects AND for the graph/wiki rebuild allowlist
// (server.js: `root not in graph allowlist`). Usable when targeted, invisible
// otherwise.
//
// The list itself lives in the STATE dir, never in the repo: this repo has a
// public mirror, and the names of a person's private directories should not be
// committed into it.
//
// Every path comparison here is string-only (no node:path), for the same reason
// as project-roots.js / zones.js: a Windows path can be classified on a POSIX
// CI host.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStateDir } from './state-dir.js';

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Where the list lives. `GLMPS_PRIVATE_DIRS_FILE` overrides outright; otherwise it
 * sits beside the other state files. `env` is injectable because
 * startServer({ env }) must be able to isolate this in tests - the exact bug
 * that made roomsPath/credsPath/settingsPath untestable when SCUT was wired.
 */
export function privateDirsPath(env = process.env) {
  if (env?.GLMPS_PRIVATE_DIRS_FILE) return env.GLMPS_PRIVATE_DIRS_FILE;
  const stateDir = resolveStateDir({ env: env ?? {} });
  return join(stateDir, 'private-dirs.json');
}

/**
 * Load the normalized private-dir list. Absent or malformed file -> [] and
 * never throws: this sits in the path of session sync and every project
 * listing, and a parse error must degrade toward "nothing is private" (visible,
 * recoverable) rather than crashing the server. It must NOT degrade toward
 * "everything is private", which would silently empty the dashboard.
 */
export function loadPrivateDirs({ env = process.env, file = privateDirsPath(env) } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const list = Array.isArray(parsed?.private) ? parsed.private : [];
    return list.map(norm).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Is `p` a private dir, or inside one? The separator is part of the comparison
 * on purpose: a bare startsWith() would classify the unrelated D:\Docs-old as
 * private because it shares a prefix with D:\Docs.
 */
export function isPrivateDir(p, dirs = []) {
  const c = norm(p).toLowerCase();
  if (!c) return false;
  for (const d of dirs) {
    const parent = norm(d).toLowerCase();
    if (!parent) continue;
    if (c === parent || c.startsWith(parent + '/')) return true;
  }
  return false;
}
