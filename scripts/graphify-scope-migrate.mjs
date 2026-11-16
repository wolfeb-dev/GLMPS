#!/usr/bin/env node
// graphify migration task 3 (card glmps-2-0-93, plan
// docs/specs/2026-10-25-graphify-in-glmps2.md in wolfeb-dev/glmps-2.0): show
// what the server's boot-time scope cleanup of the graph stores will do.
//
//   node scripts/graphify-scope-migrate.mjs                          # dry run (default)
//   node scripts/graphify-scope-migrate.mjs --repo <runtime-checkout>
//   node scripts/graphify-scope-migrate.mjs --apply                  # only with the server stopped
//
// The server runs the same plan once at boot (migrateGraphScopeState), because
// it holds both stores in memory and would overwrite an outside edit on its
// next persist. --apply is for a machine whose server is not running.
//
// Env: GLMPS_STATE_DIR overrides the state dir, GLMPS_CONFIG_FILE the config file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPaths, configFileFor, REPO_ROOT } from '../server/lib/paths.js';
import { loadPrivateDirs } from '../server/lib/private-dirs.js';
import { classifyGraphRootsAsync, inScopeRoots, mergeGraphConfig } from '../server/lib/observability/graph-scope.js';
import { planScopeMigration, appendScopeArchive } from '../server/lib/observability/graph-scope-migrate.js';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

function parseArgs(argv) {
  const out = { apply: false, repo: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--repo') out.repo = argv[++i];
    else throw new Error(`unknown argument ${argv[i]} (expected --apply, --repo <dir>)`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, probeAsync } = {}) {
  const args = parseArgs(argv);
  const P = getPaths(env);
  const stateDir = env.GLMPS_STATE_DIR ?? P.stateDir;
  const repoRoot = args.repo ? path.resolve(args.repo) : REPO_ROOT;
  const graph = mergeGraphConfig(readJson(configFileFor({ env, repoRoot }))?.graph);
  const syncFile = path.join(stateDir, 'state', 'graph-sync-health.json');
  const integrityFile = path.join(stateDir, 'state', 'graph-integrity.json');
  const snapshotFile = path.join(stateDir, 'migrations', 'graphify-settings.json');
  const syncHealth = readJson(syncFile) || {};
  const integrity = readJson(integrityFile) || {};
  const dirs = readJson(P.settingsFile)?.permissions?.additionalDirectories;

  // Store keys stand in for the server's session cwds: they are the roots the
  // stores name, and they let the corpus repo be found by remote URL.
  const storeRoots = [...Object.keys(syncHealth), ...Object.keys(integrity)].filter((k) => !k.startsWith('graphify@'));
  const { roots } = await classifyGraphRootsAsync({
    kernelRoot: repoRoot, sessionCwds: storeRoots, additionalDirectories: Array.isArray(dirs) ? dirs : [],
    graph, privateDirs: loadPrivateDirs({ env }), ...(probeAsync ? { probeAsync } : {}),
  });
  const kernelKey = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!roots.some((r) => r.scope === 'ship' && r.root.toLowerCase() === kernelKey)) {
    throw new Error(`kernel root ${repoRoot} did not classify as ship; refusing to plan (pass --repo <kernel checkout>)`);
  }
  const inScope = inScopeRoots(roots).map((r) => r.root);
  const plan = planScopeMigration({ syncHealth, integrity, inScope });

  log(`${args.apply ? 'APPLY' : 'DRY RUN'}: graph store scope migration (state ${stateDir})`);
  log(`in scope (${inScope.length}): ${inScope.join(', ')}`);
  log(`sync health: ${Object.keys(syncHealth).length} keys -> ${Object.keys(plan.syncHealth).length}; integrity: ${Object.keys(integrity).length} keys -> ${Object.keys(plan.integrity).length}`);
  for (const m of [...plan.merged.syncHealth.map((x) => ['sync health', x]), ...plan.merged.integrity.map((x) => ['integrity', x])]) {
    log(`  merge (${m[0]}): ${m[1].from.join(' + ')} -> ${m[1].key}`);
  }
  const reasons = new Map(roots.map((r) => [r.root.toLowerCase(), `${r.scope}: ${r.reason}`]));
  const why = (k) => reasons.get(k.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()) ?? 'not a known root';
  for (const [store, entries] of [['sync health', plan.archive.syncHealth], ['integrity', plan.archive.integrity]]) {
    for (const k of Object.keys(entries)) log(`  archive (${store}): ${k} [${why(k)}]`);
  }
  if (!plan.changed) log('nothing to move: stores already scoped');
  else if (!args.apply) log(`dry run: nothing written; the server applies this at boot into ${snapshotFile}`);
  else {
    appendScopeArchive(snapshotFile, plan, { inScope });
    fs.writeFileSync(syncFile, JSON.stringify(plan.syncHealth, null, 2));
    fs.writeFileSync(integrityFile, JSON.stringify(plan.integrity, null, 2));
    log(`archived into ${snapshotFile}; stores rewritten`);
  }
  return { plan, inScope, roots };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
