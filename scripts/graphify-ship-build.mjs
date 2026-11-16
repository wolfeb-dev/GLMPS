#!/usr/bin/env node
// graphify migration task 6 (card glmps-2-0-96, plan
// docs/specs/2026-10-25-graphify-in-glmps2.md in wolfeb-dev/glmps-2.0): build
// the ship graph from the kernel repo and the corpus repo.
//
//   node scripts/graphify-ship-build.mjs                         # update both roots, merge, publish
//   node scripts/graphify-ship-build.mjs --corpus <repo>   # corpus root when config has none
//   node scripts/graphify-ship-build.mjs --repo <kernel> --keep 3 --no-update
//
// Writes <stateDir>/graphs/ship/graph.json and ship-manifest.json, and prunes
// each ship root's dated graphify backups to the newest --keep (default 3).
// Exits non-zero, leaving the published files untouched, when an update or the
// merge fails, a node falls outside the two ship roots, or a curated community
// label did not survive the merge.
//
// The server's per-root single-flight guard lives in its own process, so do
// not run this while the server is rebuilding the same root.
//
// Env: GLMPS_STATE_DIR overrides the state dir, GLMPS_CONFIG_FILE the config file.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPaths, configFileFor, REPO_ROOT } from '../server/lib/paths.js';
import { loadPrivateDirs } from '../server/lib/private-dirs.js';
import { classifyGraphRootsAsync, mergeGraphConfig } from '../server/lib/observability/graph-scope.js';
import { buildShipGraph } from '../server/lib/observability/graph-ship-build.js';
import { resolveGraphifyBin, spawnGraphifyUpdateWith } from '../server/lib/orchestration/graphify-spawn.js';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function parseArgs(argv) {
  const out = { repo: null, corpus: null, keep: 3, update: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--corpus') out.corpus = argv[++i];
    else if (argv[i] === '--keep') out.keep = Number(argv[++i]);
    else if (argv[i] === '--no-update') out.update = false;
    else throw new Error(`unknown argument ${argv[i]} (expected --repo <dir>, --corpus <dir>, --keep <n>, --no-update)`);
  }
  if (!Number.isInteger(out.keep) || out.keep < 1) throw new Error('--keep must be a whole number of at least 1');
  return out;
}

const run = (bin, args, env, timeout = 600000) => new Promise((res) => {
  execFile(bin, args, { encoding: 'utf-8', windowsHide: true, timeout, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || String(err?.message ?? '') });
  });
});

const gitHead = (root) => run('git', ['-C', root, 'rev-parse', 'HEAD'], process.env, 10000)
  .then((r) => (r.code === 0 ? r.stdout.trim() : null));

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, deps = {} } = {}) {
  const args = parseArgs(argv);
  const P = getPaths(env);
  const stateDir = env.GLMPS_STATE_DIR ?? P.stateDir;
  const kernelRoot = args.repo ? path.resolve(args.repo) : REPO_ROOT;
  const graph = mergeGraphConfig(readJson(configFileFor({ env, repoRoot: kernelRoot }))?.graph);

  let corpusRoot = args.corpus ? path.resolve(args.corpus) : graph.ship.corpusRoot;
  if (!corpusRoot) {
    const dirs = readJson(P.settingsFile)?.permissions?.additionalDirectories;
    ({ corpusRoot } = await classifyGraphRootsAsync({
      kernelRoot, additionalDirectories: Array.isArray(dirs) ? dirs : [], graph, privateDirs: loadPrivateDirs({ env }),
      ...(deps.probeAsync ? { probeAsync: deps.probeAsync } : {}),
    }));
  }
  if (!corpusRoot) throw new Error(`no corpus root: set graph.ship.corpusRoot or pass --corpus (no known root has remote ${graph.ship.corpusRemote})`);

  // PYTHONHASHSEED=0 makes graphify's community partition reproducible, so
  // two builds of the same commits label the same communities.
  const childEnv = { ...env, PYTHONHASHSEED: '0' };
  const resolveBin = deps.resolveBin ?? resolveGraphifyBin;
  const graphify = async (a) => {
    const bin = await resolveBin();
    return bin ? run(bin, a, childEnv) : { code: 127, stdout: '', stderr: 'no graphify binary on PATH' };
  };
  const shipDir = path.join(stateDir, 'graphs', 'ship');

  log(`ship graph: kernel ${kernelRoot}, corpus ${corpusRoot} -> ${shipDir}`);
  const manifest = await buildShipGraph({
    kernelRoot, corpusRoot, shipDir, keep: args.keep, skipUpdate: !args.update, log,
    update: deps.update ?? ((root) => spawnGraphifyUpdateWith({ resolveBin }, root, { env: childEnv })),
    merge: deps.merge ?? ((inputs, out) => graphify(['merge-graphs', ...inputs, '--out', out])),
    version: deps.version ?? (async () => {
      const r = await graphify(['--version']);
      return r.code === 0 ? r.stdout.trim().replace(/^graphify\s+/i, '') : null;
    }),
    commitOf: deps.commitOf ?? gitHead,
  });
  log(`ship graph written: ${manifest.nodes} nodes, ${manifest.edges} edges, graphify ${manifest.graphifyVersion}`);
  for (const r of manifest.roots) log(`  ${r.tag}: ${r.nodes} nodes, ${r.edges} edges at ${r.commit}`);
  log(`scope checked ${manifest.scopeChecked} nodes; labels carried on ${manifest.labelsChecked} nodes`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
