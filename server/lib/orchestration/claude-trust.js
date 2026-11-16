// server/lib/orchestration/claude-trust.js
// The harness trust record.
//
// WRITE SITE (2.0): server.js, once, before every interactive launch (openSession
// and the runner dry-run branch), and again from createProject.
//
// PROBLEM: adopting a directory as a project (scripts/sync-project-dirs.mjs ->
// permissions.additionalDirectories) makes it readable by every session, but the
// Claude Code harness keeps a SEPARATE per-directory consent ("do you trust the
// files in this folder") in ~/.claude.json under
// projects[<dir>].hasTrustDialogAccepted. Nothing wrote that, so the first
// interactive session in a newly created project folder or a freshly cut
// worktree stalled on a modal that no automated launch can answer.
//
// SHAPE: pure planner + atomic IO shell, like private-dirs.js / project-dirs.js.
// The grant is deliberately NOT widened: callers pass only directories that are
// already in additionalDirectories, or worktrees GLMPS itself just created under
// its own worktrees dir. Private dirs are filtered here as well as at the sync,
// so a private directory cannot be trusted through a second door.
//
// Path comparison is string-only (no node:path), for the same reason as
// zones.js: a Windows path can be classified on a POSIX CI host.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isPrivateDir } from '../private-dirs.js';

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const key = (p) => norm(p).toLowerCase();

/**
 * Where the harness config lives. The CLI keeps a `.claude` DIRECTORY and a
 * sibling `.claude.json` FILE, so the file is the directory's path plus
 * `.json`. Deriving it from GLMPS_CLAUDE_DIR (the same override paths.js uses for
 * claudeDir) is what isolates this in tests: every startServer({ env }) test
 * already points GLMPS_CLAUDE_DIR at a temp dir, so the sibling config does not
 * exist and markTrusted degrades to a no-op instead of writing trust records
 * for temp worktrees into the real harness config. GLMPS_CLAUDE_CONFIG_FILE still
 * overrides outright.
 */
export function claudeConfigPath(env = process.env) {
  if (env?.GLMPS_CLAUDE_CONFIG_FILE) return env.GLMPS_CLAUDE_CONFIG_FILE;
  const dir = env?.GLMPS_CLAUDE_DIR ?? join(homedir(), '.claude');
  return norm(dir) + '.json';
}

/**
 * Which directories still need the flag, and where to write it.
 *
 * `existing` is load-bearing: the harness keys projects by the cwd string it was
 * launched with, so ONE directory can already be present under several
 * spellings. The live config really does carry `D:/proj` alongside
 * `d:/proj`, and `D:/proj2` alongside `d:/proj2`, with
 * DIFFERENT flag values. So `existing` is every untrusted spelling, and all of
 * them get flipped: picking just one would make the result depend on key order,
 * and a session launched with the other spelling would still be prompted. A new
 * key is written only when no spelling exists at all.
 */
export function trustPlan({ projects = {}, dirs = [], privateDirs = [] } = {}) {
  const byKey = new Map();
  for (const k of Object.keys(projects)) {
    const n = key(k);
    if (!byKey.has(n)) byKey.set(n, []);
    byKey.get(n).push(k);
  }
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const k = key(dir);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (isPrivateDir(dir, privateDirs)) continue;
    const spellings = byKey.get(k) ?? [];
    const existing = spellings.filter((s) => projects[s]?.hasTrustDialogAccepted !== true);
    if (spellings.length && !existing.length) continue; // every spelling already trusted
    out.push({ key: norm(dir), existing });
  }
  return out;
}

/**
 * Set the flag for `dirs`, atomically and only when something actually changes.
 *
 * Never throws. A missing or malformed config degrades to { ok:false }: the
 * trust dialog appears, which is the status quo, not a broken launch. It must
 * NOT degrade toward rewriting a file it could not parse.
 *
 * The read-modify-write races a concurrently running harness process, which
 * rewrites this file wholesale. There is no lock; the mitigation is that the
 * steady state is a no-op (no write at all) and the window is one parse wide.
 */
export function markTrusted({ dirs = [], file = undefined, privateDirs = [], env = process.env } = {}) {
  if (env?.GLMPS_AUTO_TRUST === '0') return { ok: true, changed: false, trusted: [], reason: 'disabled' };
  const target = file ?? claudeConfigPath(env);
  let cfg;
  try { cfg = JSON.parse(readFileSync(target, 'utf8')); }
  catch (err) { return { ok: false, changed: false, trusted: [], reason: `cannot read ${target}: ${err.message}` }; }
  if (!cfg || typeof cfg !== 'object') return { ok: false, changed: false, trusted: [], reason: 'config is not an object' };

  cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
  const plan = trustPlan({ projects: cfg.projects, dirs, privateDirs });
  if (!plan.length) return { ok: true, changed: false, trusted: [] };

  for (const { key: k, existing } of plan) {
    for (const slot of (existing.length ? existing : [k])) {
      cfg.projects[slot] = { ...(cfg.projects[slot] ?? {}), hasTrustDialogAccepted: true };
    }
  }
  try {
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    renameSync(tmp, target);
  } catch (err) {
    return { ok: false, changed: false, trusted: [], reason: `cannot write ${target}: ${err.message}` };
  }
  return { ok: true, changed: true, trusted: plan.map((p) => p.key) };
}
