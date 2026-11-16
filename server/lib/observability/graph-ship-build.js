// server/lib/observability/graph-ship-build.js
// Ship graph build (graphify plan task 6, card glmps-2-0-96): update the two
// ship roots, merge them into <stateDir>/graphs/ship/graph.json with a
// ship-manifest.json, and refuse to publish a graph that holds anything from
// outside the two ship roots or that lost its curated community labels.
//
// WHY the label check: graphify keeps curated labels in two places, the
// .graphify_labels.json sidecar (keyed by community id) and a community_name
// attribute on every node. merge-graphs never reads the sidecar and offsets the
// second input's community ids, so the per-node attribute is the only carrier
// into the merged graph. graphify 0.9.95 keeps it (nx.compose copies node
// attributes); the build verifies that on every run instead of trusting it, so
// a graphify upgrade that drops it fails the build rather than shipping a graph
// with generic labels.
//
// All graphify and git work is injected (update, merge, version, commitOf), so
// a server caller can route update through its per-root single-flight guard
// and tests run without Python.
import fs from 'node:fs';
import path from 'node:path';

const DATED = /^\d{4}-\d{2}-\d{2}$/;
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const key = (p) => norm(p).toLowerCase();

/**
 * The repo tag merge-graphs prefixes each input's node ids with, mirroring
 * graphify's build.distinct_repo_tags for `<root>/graphify-out/graph.json`
 * inputs: the root's dir name, widened with its parent on a collision, then
 * index-suffixed.
 */
export function repoTags(roots) {
  const parts = roots.map((r) => norm(r).split('/').filter(Boolean));
  let tags = parts.map((p) => p[p.length - 1] || 'repo');
  if (new Set(tags).size !== tags.length) {
    tags = parts.map((p) => {
      const name = p[p.length - 1]; const parent = p[p.length - 2];
      return parent && name ? `${parent}_${name}` : (name || 'repo');
    });
  }
  const seen = new Map();
  return tags.map((t) => {
    const n = (seen.get(t) ?? 0) + 1; seen.set(t, n);
    return n === 1 ? t : `${t}-${n}`;
  });
}

// A module specifier such as node:fs is not a filesystem path; a single letter
// before the colon is a drive, and file: is a path in URL form.
const isModuleSpecifier = (s) => /^[a-z][a-z0-9+.-]+:/i.test(s) && !/^file:/i.test(s);
const isAbsolute = (s) => /^[a-z]:[\\/]/i.test(s) || /^[\\/]/.test(s) || /^file:/i.test(s) || s.startsWith('~');

/**
 * Why `sourceFile` falls outside `root`, or null when it is inside (or names no
 * file). Relative paths are taken relative to the root and may not climb out.
 */
export function outsideRoot(sourceFile, root) {
  const s = String(sourceFile ?? '').trim();
  if (!s || isModuleSpecifier(s)) return null;
  if (isAbsolute(s)) {
    const asPath = /^file:/i.test(s) ? s.replace(/^file:\/*/i, '').replace(/^(?![a-z]:)/i, '/') : s;
    const p = key(asPath);
    const r = key(root);
    return p === r || p.startsWith(r + '/') ? null : 'absolute path outside its ship root';
  }
  let depth = 0;
  for (const seg of norm(s).split('/')) {
    if (seg === '..') depth--;
    else if (seg && seg !== '.') depth++;
    if (depth < 0) return 'relative path climbs out of its ship root';
  }
  return null;
}

/**
 * Scope assertion over a merged graph. Every non-external node must carry the
 * repo tag of one of the ship roots, and its source_file must sit inside that
 * root. External nodes (stdlib and package stubs) belong to no repo and name
 * no file. Returns the violations; an empty list passes.
 */
export function assertShipScope(merged, tagRoots) {
  const violations = [];
  let checked = 0;
  for (const n of merged?.nodes ?? []) {
    if (n.external) continue;
    checked++;
    const root = tagRoots[n.repo];
    if (!root) { violations.push({ id: n.id, repo: n.repo ?? null, source_file: n.source_file ?? null, why: 'repo tag is not a ship root' }); continue; }
    const why = outsideRoot(n.source_file, root);
    if (why) violations.push({ id: n.id, repo: n.repo, source_file: n.source_file, why });
  }
  return { checked, violations };
}

/**
 * Every labelled, non-external node of each input must reach the merged graph
 * as `<tag>::<id>` with the same community_name. Returns the count checked and
 * the nodes that lost or changed their label.
 */
export function checkLabelsCarried(inputs, merged) {
  const byId = new Map((merged?.nodes ?? []).map((n) => [n.id, n]));
  const lost = [];
  let checked = 0;
  for (const { tag, graph } of inputs) {
    for (const n of graph?.nodes ?? []) {
      if (n.external || typeof n.community_name !== 'string') continue;
      checked++;
      const m = byId.get(`${tag}::${n.id}`);
      if (!m) lost.push({ id: `${tag}::${n.id}`, expected: n.community_name, got: null });
      else if (m.community_name !== n.community_name) lost.push({ id: m.id, expected: n.community_name, got: m.community_name ?? null });
    }
  }
  return { checked, lost };
}

/**
 * Remove all but the newest `keep` dated backup folders (YYYY-MM-DD, written by
 * graphify before it overwrites a curated graph) from one graphify-out dir.
 * Returns the folder names removed; a missing dir removes nothing.
 */
export function pruneBackups(outDir, { keep = 3, fsImpl = fs } = {}) {
  let names;
  try {
    names = fsImpl.readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory() && DATED.test(d.name)).map((d) => d.name);
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  const drop = names.sort().slice(0, Math.max(0, names.length - Math.max(0, keep)));
  for (const n of drop) fsImpl.rmSync(path.join(outDir, n), { recursive: true, force: true });
  return drop;
}

const readGraph = (file) => JSON.parse(fs.readFileSync(file, 'utf-8'));
const edgesOf = (g) => (g.links ?? g.edges ?? []).length;

export class ShipBuildError extends Error {
  constructor(stage, message, detail) {
    super(`ship graph ${stage} failed: ${message}`);
    this.stage = stage;
    this.detail = detail;
  }
}

/**
 * Build the ship graph. `update(root)` and `merge(inputs, out)` resolve to
 * { code, stdout, stderr }; `version()` to the graphify version string;
 * `commitOf(root)` to the root's HEAD sha. The published graph.json and
 * ship-manifest.json in `shipDir` are only replaced after every check passes;
 * any failure throws ShipBuildError and leaves them as they were.
 */
export async function buildShipGraph({
  kernelRoot, corpusRoot, shipDir, update, merge, version, commitOf,
  keep = 3, skipUpdate = false, now = () => new Date(), log = () => {},
}) {
  if (!kernelRoot || !corpusRoot) throw new ShipBuildError('setup', 'both ship roots are required (kernel and corpus)');
  if (key(kernelRoot) === key(corpusRoot)) throw new ShipBuildError('setup', `kernel and corpus are the same root ${kernelRoot}`);
  const roots = [kernelRoot, corpusRoot];

  if (!skipUpdate) {
    for (const root of roots) {
      log(`graphify update ${root}`);
      const r = await update(root);
      if (r?.code !== 0) throw new ShipBuildError('update', `graphify update ${root} exited ${r?.code}: ${String(r?.stderr || r?.stdout || '').trim().slice(-500)}`);
    }
  }

  const pruned = {};
  for (const root of roots) {
    pruned[root] = pruneBackups(path.join(root, 'graphify-out'), { keep });
    if (pruned[root].length) log(`pruned ${pruned[root].length} backup folder(s) in ${root}: ${pruned[root].join(', ')}`);
  }

  const inputFiles = roots.map((r) => path.join(r, 'graphify-out', 'graph.json'));
  for (const f of inputFiles) if (!fs.existsSync(f)) throw new ShipBuildError('merge', `no graph at ${f}`);
  const tags = repoTags(roots);
  const tagRoots = Object.fromEntries(tags.map((t, i) => [t, roots[i]]));

  fs.mkdirSync(shipDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(shipDir, '.staging-'));
  try {
    const stagedGraph = path.join(staging, 'graph.json');
    const m = await merge(inputFiles, stagedGraph);
    if (m?.code !== 0 || !fs.existsSync(stagedGraph)) {
      throw new ShipBuildError('merge', `graphify merge-graphs exited ${m?.code}: ${String(m?.stderr || m?.stdout || '').trim().slice(-500)}`);
    }
    const merged = readGraph(stagedGraph);
    const inputs = inputFiles.map((f, i) => ({ tag: tags[i], root: roots[i], graph: readGraph(f) }));

    const scope = assertShipScope(merged, tagRoots);
    if (scope.violations.length) {
      throw new ShipBuildError('scope', `${scope.violations.length} node(s) outside the ship roots, first: ${JSON.stringify(scope.violations[0])}`, scope.violations);
    }
    const labels = checkLabelsCarried(inputs, merged);
    if (labels.lost.length) {
      throw new ShipBuildError('labels', `${labels.lost.length} node(s) lost their curated community label, first: ${JSON.stringify(labels.lost[0])}`, labels.lost);
    }

    const manifest = {
      schemaVersion: 1,
      builtAt: now().toISOString(),
      graphifyVersion: await version(),
      roots: await Promise.all(inputs.map(async ({ tag, root, graph }) => ({
        root: norm(root),
        tag,
        commit: await commitOf(root),
        graphCommit: graph.built_at_commit ?? null,
        nodes: graph.nodes?.length ?? 0,
        edges: edgesOf(graph),
      }))),
      nodes: merged.nodes?.length ?? 0,
      edges: edgesOf(merged),
      scopeChecked: scope.checked,
      labelsChecked: labels.checked,
      backupsPruned: Object.fromEntries(Object.entries(pruned).map(([r, v]) => [norm(r), v])),
    };
    const stagedManifest = path.join(staging, 'ship-manifest.json');
    fs.writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2));
    fs.renameSync(stagedGraph, path.join(shipDir, 'graph.json'));
    fs.renameSync(stagedManifest, path.join(shipDir, 'ship-manifest.json'));
    return manifest;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
