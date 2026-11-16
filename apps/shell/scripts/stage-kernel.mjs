// npm run stage-kernel: bundles this Node and the kernel (built by the release
// builder from the tested HEAD commit, not the working tree) into kernel-stage/,
// which electron-builder ships as resources/kernel.
//
//   npm run stage-kernel                          # public build (the default): code graph only, PII-scanned
//   npm run stage-kernel -- --private             # the operator's own build: code + corpus ship graph (or GLMPS_PRIVATE=1)
//   npm run stage-kernel -- --ship-graph <dir>    # ship graph from <dir> instead of <stateDir>/graphs/ship
//   npm run stage-kernel -- --no-ship-graph       # bundle without a ship graph (or GLMPS_NO_SHIP_GRAPH=1, as CI does)
//   npm run stage-kernel -- --no-wiki             # bundle without the wiki snapshot (or GLMPS_NO_WIKI=1, as CI does)
//   GLMPS_NO_COMPANION=1                          # bundle without the IDE companion package (otherwise a checkout without companion/node_modules installs it from the lockfile)
//   npm run stage-kernel -- --untested            # dev only: skip the tested-commit rule (or GLMPS_UNTESTED=1); needs --private
import { execFileSync } from 'node:child_process';
import { buildingPrivateNames } from '../../../server/lib/governance/private-text-scan.js';
import { load as loadBoard } from '../../../server/lib/orchestration/backlog-store.js';
import path from 'node:path';
import fs from 'node:fs';
import { parseStageArgs, stageKernel, stageCompanion } from './kernel-stage-lib.mjs';
import { resolveTestedTree } from '../../../scripts/release-builder.mjs';
import { getPaths } from '../../../server/lib/paths.js';

let args;
try {
  args = parseStageArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(`kernel-stage failed: ${e.message}`);
  process.exit(1);
}

const ROOT = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(ROOT, '..', '..');
const P = getPaths(process.env);
const stateDir = P.stateDir;
const privateNames = buildingPrivateNames({ stateDir, claudeSettingsFile: P.settingsFile, loadBoard });
const shipGraph = args.noShipGraph ? null : {
  shipDir: path.resolve(args.shipDir ?? path.join(stateDir, 'graphs', 'ship')),
  publicBuild: args.publicBuild,
  privateNames,
};
const wiki = args.noWiki ? null : { stateDir, privateNames };
let manifest;
try {
  const testedTree = args.untested ? null : resolveTestedTree({ stateDir, repoRoot, commit: 'HEAD' });
  manifest = stageKernel({
    repoRoot, outDir: path.join(ROOT, 'kernel-stage'), nodeExe: process.execPath, nodeVersion: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    shipGraph, wiki, testedTree, untested: args.untested, privateNames, publicBuild: args.publicBuild,
  });
} catch (e) {
  console.error(`kernel-stage failed: ${e.message}`);
  process.exit(1);
}
const outDir = path.join(ROOT, 'kernel-stage');
let companion = null;
if (process.env.GLMPS_NO_COMPANION !== '1') {
  try {
    companion = stageCompanion({ repoRoot, outDir });
    if (companion) {
      manifest.companion = companion;
      fs.writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
  } catch (e) {
    fs.rmSync(outDir, { recursive: true, force: true });
    console.error(`kernel-stage failed: ${e.message}`);
    process.exit(1);
  }
}
console.log(`kernel-stage: node ${manifest.node}, kernel ${manifest.commit}${manifest.release.untested ? ' (UNTESTED, dev only)' : ''}`);
const g = manifest.shipGraph;
console.log(companion ? `companion: ${companion.file}, sha256 ${companion.sha256.slice(0, 12)}` : 'companion: none (GLMPS_NO_COMPANION=1); the wizard cannot install the IDE extension');
console.log(g ? `ship graph: ${g.scope}, ${g.nodes} nodes, ${g.edges} edges, built ${g.builtAt}, sha256 ${g.sha256.slice(0, 12)}` : 'ship graph: none (--no-ship-graph or GLMPS_NO_SHIP_GRAPH=1)');
const w = manifest.wiki;
console.log(w ? `wiki: ${w.pages} pages, build ${w.build}, built ${w.builtAt}, sha256 ${w.sha256.slice(0, 12)}` : 'wiki: none (--no-wiki or GLMPS_NO_WIKI=1)');
