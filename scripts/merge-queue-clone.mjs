#!/usr/bin/env node
// Operator script (card glmps-2-0-runtime-16): give the merge queue its own
// clone of a repo and point `mergeQueue.repos[<repo>].path` in the runtime
// config.json at it, so test and reviewer worktrees stop being cut from a
// working checkout (the 1.0 `<repo>` folder until now).
//
//   node scripts/merge-queue-clone.mjs            # dry run (default)
//   node scripts/merge-queue-clone.mjs --apply    # clone or fetch, back up config.json into <stateDir>/backups/config, write it
//
// Options: --repo owner/name (default wolfeb-dev/glmps-2.0), --path <dir>
// (default <stateDir>/repos/<name>), --url <clone url> (default the GitHub https
// url), --config <file> (default the runtime config.json, GLMPS_CONFIG_FILE wins).
// Idempotent: an existing clone with the right origin is fetched, not re-cloned,
// and an entry already pointing at the clone is left alone. A config with no
// mergeQueue section is refused, since it cannot be the queue's. The kernel reads
// config.json at start, so the change takes effect after Restart server.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverLib = path.join(here, '..', 'server', 'lib');
const { getPaths, configFileFor } = await import(pathToFileURL(path.join(serverLib, 'paths.js')).href);
const { snapshotConfig } = await import(pathToFileURL(path.join(serverLib, 'config-snapshot.js')).href);
const { remoteMatchesRepo } = await import(pathToFileURL(path.join(serverLib, 'orchestration', 'merge-util.js')).href);

export const DEFAULT_REPO = 'wolfeb-dev/glmps-2.0';

/**
 * The config with `mergeQueue.repos[repo].path` set to `clonePath`. An existing
 * entry is matched case-insensitively (as the server's checkout lookup does) and
 * keeps its other fields (test command, timeout); other repos are untouched.
 */
export function planRepoEntry(cfg, { repo, clonePath }) {
  const base = cfg && typeof cfg === 'object' ? cfg : {};
  const repos = { ...(base.mergeQueue?.repos ?? {}) };
  const key = Object.keys(repos).find((k) => k.toLowerCase() === repo.toLowerCase()) ?? repo;
  const before = repos[key] ?? null;
  const changed = !before?.path || path.resolve(before.path) !== path.resolve(clonePath);
  repos[key] = { ...(before ?? {}), path: clonePath };
  return { key, before, after: repos[key], changed, next: { ...base, mergeQueue: { ...(base.mergeQueue ?? {}), repos } } };
}

function parseArgs(argv) {
  const opt = { apply: argv.includes('--apply') };
  for (const name of ['repo', 'path', 'url', 'config']) {
    const i = argv.indexOf(`--${name}`);
    if (i !== -1 && argv[i + 1]) opt[name] = argv[i + 1];
  }
  return opt;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() || r.error?.message || '' };
}

export function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  const opt = parseArgs(argv);
  const repo = opt.repo ?? DEFAULT_REPO;
  const name = repo.split('/').pop();
  const { stateDir } = getPaths(env, null, { processEnv: env });
  const clonePath = path.resolve(opt.path ?? path.join(stateDir, 'repos', name));
  const url = opt.url ?? `https://github.com/${repo}.git`;
  const configFile = opt.config ?? configFileFor({ env });
  const mode = opt.apply ? 'APPLY' : 'DRY RUN';
  log(`[${mode}] repo ${repo}`);
  log(`  clone:  ${clonePath}`);
  log(`  config: ${configFile}`);

  if (!fs.existsSync(configFile)) { log(`  refused: ${configFile} does not exist`); return 1; }
  const raw = fs.readFileSync(configFile, 'utf8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { log(`  refused: ${configFile} is not valid JSON (${e.message})`); return 1; }
  // The default config is the one beside this script, so a run from a worktree
  // lands on that worktree's copy; the first operator run did exactly that.
  if (!cfg?.mergeQueue || typeof cfg.mergeQueue !== 'object') {
    log(`  refused: ${configFile} has no mergeQueue section, so it is not the running kernel's config. Pass --config <runtime checkout>/config.json`);
    return 1;
  }

  const exists = fs.existsSync(path.join(clonePath, '.git'));
  if (exists) {
    const origin = git(['remote', 'get-url', 'origin'], clonePath);
    if (origin.status !== 0 || !(remoteMatchesRepo(origin.stdout, repo) || origin.stdout === url)) {
      log(`  refused: ${clonePath} exists but its origin is "${origin.stdout || origin.stderr}", not ${repo}`);
      return 1;
    }
    log(`  clone exists (origin ${origin.stdout}): ${opt.apply ? 'fetching' : 'would fetch'}`);
  } else if (fs.existsSync(clonePath) && fs.readdirSync(clonePath).length) {
    log(`  refused: ${clonePath} exists, is not empty and is not a git clone`);
    return 1;
  } else {
    log(`  ${opt.apply ? 'cloning' : 'would clone'} ${url} (no checkout: worktrees are cut from it, nobody edits it)`);
  }

  const plan = planRepoEntry(cfg, { repo, clonePath });
  log(`  mergeQueue.repos["${plan.key}"]: ${JSON.stringify(plan.before)} -> ${JSON.stringify(plan.after)}${plan.changed ? '' : ' (already set, no change)'}`);
  if (!opt.apply) { log('  dry run: nothing changed. Re-run with --apply to act.'); return 0; }

  const r = exists
    ? git(['fetch', '-q', '--prune', 'origin'], clonePath)
    : (fs.mkdirSync(path.dirname(clonePath), { recursive: true }), git(['clone', '-q', '--no-checkout', url, clonePath]));
  if (r.status !== 0) { log(`  failed: git ${exists ? 'fetch' : 'clone'}: ${r.stderr}`); return 1; }
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], clonePath);
  const count = refs.stdout ? refs.stdout.split('\n').length : 0;
  if (refs.status !== 0 || count === 0) { log(`  failed: the clone has no origin branches (${refs.stderr})`); return 1; }
  log(`  clone ready: ${count} origin branches`);

  if (!plan.changed) { log('  config already points at the clone; not rewritten.'); return 0; }
  const backup = snapshotConfig(configFile, { stateDir });
  fs.writeFileSync(configFile, JSON.stringify(plan.next, null, 2) + '\n');
  log(`  backed up config to ${backup}`);
  log(`  wrote ${configFile}`);
  log('  next: Restart server (settings gear) so the kernel reads the new path.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
