// Stages the kernel for the installer: the release builder (scripts/release-builder.mjs,
// target kernel) builds the runtime from a tested commit, then this adds a Node
// binary and the ship graph into the dir electron-builder ships as
// resources/kernel, so the installed shell can run the kernel on a machine with
// no Node and no checkout (glmps-2-0-59). What may ship, and the secret, test,
// planning and operator-instruction exclusions, live in the builder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PUBLIC_DENY, isPublicDenied } from '../../../scripts/public-deny.mjs';
import { buildRelease, classify, formatViolations, PROFILES, publicScanHits, publicScanPatterns } from '../../../scripts/release-builder.mjs';
import { shipTextPatterns } from '../../../server/lib/governance/private-text-scan.js';
import { listFilesSorted, wikiSnapshotSha256 } from '../../../server/lib/observability/wiki-ship-seed.js';
import { readCurrentWiki, wikiPaths } from '../../../server/lib/observability/wiki-publish.js';

// The scan helpers moved into the builder; kept importable from here.
export { publicScanHits, publicScanPatterns };

export function nodeVersionOk(v) {
  const m = /^v?(\d+)\.(\d+)\./.exec(String(v));
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 22 || (maj === 22 && min >= 5);
}

// Decision 2 of the graphify plan: until the corpus is cleared for
// publication a public build carries the kernel repo's half of the ship graph
// only, and only nodes from files the public mirror ships: the mirror's
// allowlist, not just the short deny list, which let planning notes under
// docs/ through (card glmps-2-0-206). External stubs stay when a kept node
// uses them.
const mirrorShips = (file) => !!file && !!classify(file, PROFILES.mirror)?.out;
export function codeOnlyShipGraph(graph, manifest, { deny = PUBLIC_DENY } = {}) {
  const tag = manifest?.roots?.[0]?.tag;
  if (!tag) throw new Error('ship manifest names no kernel root');
  const links = graph.links ?? graph.edges ?? [];
  const keep = new Set(graph.nodes.filter((n) => !n.external && n.repo === tag && !isPublicDenied(n.source_file, deny) && mirrorShips(n.source_file)).map((n) => n.id));
  const ext = new Set(graph.nodes.filter((n) => n.external).map((n) => n.id));
  for (const e of links) {
    if (keep.has(e.source) && ext.has(e.target)) keep.add(e.target);
    if (keep.has(e.target) && ext.has(e.source)) keep.add(e.source);
  }
  const keptLinks = links.filter((e) => keep.has(e.source) && keep.has(e.target));
  const out = { ...graph, nodes: graph.nodes.filter((n) => keep.has(n.id)), [graph.links ? 'links' : 'edges']: keptLinks };
  if (Array.isArray(graph.hyperedges)) out.hyperedges = graph.hyperedges.filter((h) => Array.isArray(h.nodes) && h.nodes.every((id) => keep.has(id)));
  const { root: _root, ...kernelRoot } = manifest.roots[0];
  const { backupsPruned: _pruned, ...rest } = manifest;
  const counts = { nodes: out.nodes.length, edges: keptLinks.length };
  return { graph: out, manifest: { ...rest, roots: [{ ...kernelRoot, ...counts }], ...counts } };
}

// The graph the installer seeds into <stateDir>/graphs/ship on first run
// (server/lib/observability/graph-ship-seed.js), so the Map, wiki and ticket
// enrichment work before the machine has Python or graphify.
export function stageShipGraph({ shipDir, outDir, publicBuild = false, privateNames = [] }) {
  const graphFile = path.join(shipDir, 'graph.json');
  const manifestFile = path.join(shipDir, 'ship-manifest.json');
  if (!fs.existsSync(graphFile) || !fs.existsSync(manifestFile)) {
    throw new Error(`no ship graph at ${shipDir}: run node scripts/graphify-ship-build.mjs first, or stage with --no-ship-graph`);
  }
  let graphText = fs.readFileSync(graphFile, 'utf8');
  let manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (publicBuild) {
    const code = codeOnlyShipGraph(JSON.parse(graphText), manifest);
    graphText = JSON.stringify(code.graph);
    manifest = code.manifest;
    const hits = publicScanHits(graphText + '\n' + JSON.stringify(manifest), publicScanPatterns(privateNames));
    if (hits.length) {
      throw new Error(`public ship graph fails the public-flip scan (${hits.map((h) => h.pattern).join(', ')}), first: ${JSON.stringify(hits[0].sample)}`);
    }
  }
  const dst = path.join(outDir, 'graphs', 'ship');
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, 'graph.json'), graphText);
  fs.writeFileSync(path.join(dst, 'ship-manifest.json'), JSON.stringify(manifest, null, 2));
  return {
    scope: publicBuild ? 'code' : 'code+corpus',
    builtAt: manifest.builtAt,
    graphifyVersion: manifest.graphifyVersion ?? null,
    roots: (manifest.roots ?? []).map(({ tag, commit, graphCommit }) => ({ tag, commit: commit ?? null, graphCommit: graphCommit ?? null })),
    nodes: manifest.nodes,
    edges: manifest.edges,
    sha256: crypto.createHash('sha256').update(graphText).digest('hex'),
  };
}

// The wiki the installer seeds into <stateDir>/wiki on first run
// (server/lib/observability/wiki-ship-seed.js). Every text file of the published
// build is scanned for personal paths, the building account's name and dev
// history; any hit stops the stage (no stripping), because the pages are what a
// customer reads and a leak there is the operator's to fix at the source.
export function stageWikiSnapshot({ stateDir, outDir, privateNames = [] }) {
  const p = wikiPaths(stateDir);
  const current = readCurrentWiki(stateDir);
  const buildDir = current ? path.join(p.builds, current.build) : null;
  if (!current || !fs.existsSync(path.join(buildDir, 'manifest.json'))) {
    throw new Error(`no published wiki at ${p.root}: let the wiki loop publish one first, or stage with --no-wiki`);
  }
  const patterns = shipTextPatterns(privateNames);
  const currentText = fs.readFileSync(p.current, 'utf8');
  const scan = (name, buf) => {
    if (buf.subarray(0, 8000).includes(0)) return;
    const hits = publicScanHits(buf.toString('utf8'), patterns);
    if (hits.length) throw new Error(`wiki page ${name} fails the private-text scan (${hits[0].pattern}), first: ${JSON.stringify(hits[0].sample)}`);
  };
  const files = listFilesSorted(buildDir);
  for (const rel of files) scan(rel, fs.readFileSync(path.join(buildDir, ...rel.split('/'))));
  scan('current.json', Buffer.from(currentText, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'manifest.json'), 'utf8'));
  const dst = path.join(outDir, 'wiki');
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(buildDir, path.join(dst, current.build), { recursive: true });
  fs.writeFileSync(path.join(dst, 'current.json'), currentText);
  return {
    build: current.build,
    builtAt: new Date(current.builtTs).toISOString(),
    pages: Array.isArray(manifest.sections) ? manifest.sections.length : files.filter((f) => f.endsWith('.html')).length,
    sha256: wikiSnapshotSha256(path.join(dst, current.build)),
  };
}

// The companion extension package the setup wizard installs into the operator's
// IDE. Built from the working tree's companion/ (the one part of the stage that
// is not from the tested commit: it is a VS Code extension the app only copies
// onto the IDE, never runs). A checkout that never installed companion/'s
// esbuild and vsce gets them from the committed lockfile first, so a fresh build
// cannot quietly ship a picker with nothing to install (card glmps-2-0-217);
// GLMPS_NO_COMPANION=1 in stage-kernel is the only way to skip it. Any failing
// step stops the stage.
export function stageCompanion({ repoRoot, outDir, run = defaultCompanionRun }) {
  const dir = path.join(repoRoot, 'companion');
  if (!fs.existsSync(path.join(dir, 'node_modules'))) run(['ci', '--no-audit', '--no-fund'], dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const name = `${pkg.name}-${pkg.version}.vsix`;
  const dst = path.join(outDir, 'companion');
  fs.mkdirSync(dst, { recursive: true });
  const file = path.join(dst, name);
  run(['run', 'build'], dir);
  run(['run', 'package', '--', '--out', file], dir);
  if (!fs.existsSync(file)) throw new Error(`the companion package step produced no package at ${file}`);
  return { file: `companion/${name}`, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

function defaultCompanionRun(args, cwd) {
  const quoted = process.platform === 'win32' ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', quoted, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`companion: npm ${args.join(' ')} exited ${r.status ?? r.error?.message}`);
}

// CI builds the installer config on a fresh runner that has no ship graph, so
// it opts out through the environment and dist:dir stays one command.
export function parseStageArgs(argv, env = {}) {
  // Public is the default (card glmps-2-0-183): a customer installer must never carry the corpus half
  // of the ship graph or an untested tree. --private (or GLMPS_PRIVATE=1, as CI sets) is the opt-in.
  const args = { publicBuild: env.GLMPS_PRIVATE !== '1', shipDir: null, noShipGraph: env.GLMPS_NO_SHIP_GRAPH === '1', untested: env.GLMPS_UNTESTED === '1', noWiki: env.GLMPS_NO_WIKI === '1' };
  let explicitPublic = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--public') { explicitPublic = true; args.publicBuild = true; }
    else if (argv[i] === '--private') args.publicBuild = false;
    else if (argv[i] === '--ship-graph' && argv[i + 1]) args.shipDir = argv[++i];
    else if (argv[i] === '--no-ship-graph') args.noShipGraph = true;
    else if (argv[i] === '--untested') args.untested = true;
    else if (argv[i] === '--no-wiki') args.noWiki = true;
    else throw new Error(`unknown argument ${argv[i]} (expected --private, --public, --ship-graph <dir>, --no-ship-graph, --untested, --no-wiki)`);
  }
  if (explicitPublic && argv.includes('--private')) throw new Error('--public and --private cannot be combined');
  if (args.noShipGraph && (args.publicBuild || args.shipDir)) throw new Error('--no-ship-graph (or GLMPS_NO_SHIP_GRAPH=1) cannot be combined with a public build (the default) or --ship-graph; add --private for the operator\'s own build');
  if (args.untested && args.publicBuild) throw new Error('--untested needs --private: a public build needs a tested commit');
  return args;
}

export function stageKernel({ repoRoot, outDir, nodeExe, nodeVersion, commit = 'HEAD', shipGraph = null, now = Date.now, testedTree = null, untested = false, wiki = null, privateNames = shipGraph?.privateNames ?? wiki?.privateNames ?? [] }) {
  if (!nodeVersionOk(nodeVersion)) throw new Error(`Node ${nodeVersion} is too old to bundle: the kernel needs 22.5 or later (node:sqlite)`);
  const built = buildRelease({ repoRoot, commit, target: 'kernel', outDir, testedTree, untested, publicBuild: !!shipGraph?.publicBuild, privateNames, now });
  if (!built.ok) throw new Error(`release build refused ${commit}:\n${formatViolations(built.violations)}`);
  try {
    if (!built.manifest.files.some((f) => f.path === 'server/server.js')) throw new Error(`${commit} is not a kernel checkout: server/server.js is missing`);
    fs.copyFileSync(nodeExe, path.join(outDir, 'node.exe'));
    const manifest = {
      node: nodeVersion,
      commit: built.manifest.commit.slice(0, 7),
      builtAt: built.manifest.builtAt,
      release: { treeSha: built.manifest.treeSha, untested: built.manifest.untested },
    };
    if (shipGraph) manifest.shipGraph = stageShipGraph({ ...shipGraph, outDir });
    if (wiki) manifest.wiki = stageWikiSnapshot({ ...wiki, outDir, privateNames });
    fs.writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } catch (e) {
    fs.rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
}
