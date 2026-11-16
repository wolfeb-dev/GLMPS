// server/lib/observability/graph-machine.js
// The secondary (machine) graph scan: the operator's per-repo opt-ins, the
// effective graph config they produce, the scope parameter of GET /api/graph,
// and the optional merged machine graph at <stateDir>/graphs/machine.
//
// WHY opt-ins live in a state file and not in config.json: config.json is the
// operator's hand-kept file, and the server never rewrites it. The state file
// layers over it: `enabled` replaces graph.machine.enabled when set, and
// machine.include becomes (config include + optIn) - optOut, so an opt-out in
// the panel wins over a config include without editing the config.
//
// The merged graph is never written into the ship graph, and a build that
// fails leaves the previous published files untouched (staged, then renamed).
import fs from 'node:fs';
import path from 'node:path';
import { mergeGraphConfig } from './graph-scope.js';

export const GRAPH_SCOPES = Object.freeze(['ship', 'machine']);
export const MACHINE_SCAN_DEFAULTS = Object.freeze({ enabled: true, checkMs: 30 * 60 * 1000 });

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const key = (p) => norm(p).toLowerCase();
const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()).map(norm) : []);

/** The ?scope= value, defaulting to ship; anything else is an error. */
export function parseGraphScope(raw) {
  if (raw == null || raw === '') return { ok: true, scope: 'ship' };
  const s = String(raw).trim().toLowerCase();
  return GRAPH_SCOPES.includes(s) ? { ok: true, scope: s } : { ok: false, error: `scope must be one of ${GRAPH_SCOPES.join(', ')}` };
}

export function emptyMachineState() {
  return { enabled: null, optIn: [], optOut: [] };
}

export function normalizeMachineState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : null,
    optIn: strList(s.optIn),
    optOut: strList(s.optOut),
  };
}

export function loadMachineState(file) {
  try { return normalizeMachineState(JSON.parse(fs.readFileSync(file, 'utf-8'))); } catch { return emptyMachineState(); }
}

export function saveMachineState(file, state) {
  const s = normalizeMachineState(state);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return s;
}

/** config.json's graph block with the panel's state layered over it. */
export function effectiveGraphConfig(graph, state) {
  const g = mergeGraphConfig(graph);
  const s = normalizeMachineState(state);
  if (s.enabled !== null) g.machine.enabled = s.enabled;
  const out = new Set(s.optOut.map(key));
  const seen = new Set();
  const include = [];
  for (const r of [...strList(g.machine.include), ...s.optIn]) {
    const k = key(r);
    if (out.has(k) || seen.has(k)) continue;
    seen.add(k);
    include.push(r);
  }
  g.machine.include = include;
  return g;
}

/** New state with `root` opted in or out; the opposite list loses it. */
export function applyOptIn(state, root, optIn) {
  const s = normalizeMachineState(state);
  const k = key(root);
  const drop = (list) => list.filter((r) => key(r) !== k);
  const optInList = drop(s.optIn);
  const optOutList = drop(s.optOut);
  if (optIn) optInList.push(norm(root)); else optOutList.push(norm(root));
  return { enabled: s.enabled, optIn: optInList, optOut: optOutList };
}

export function machineGraphPaths(stateDir) {
  const dir = path.join(stateDir, 'graphs', 'machine');
  return { dir, graph: path.join(dir, 'graph.json'), manifest: path.join(dir, 'machine-manifest.json') };
}

export function shipGraphPaths(stateDir) {
  const dir = path.join(stateDir, 'graphs', 'ship');
  return { dir, graph: path.join(dir, 'graph.json'), manifest: path.join(dir, 'ship-manifest.json') };
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };
const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };

/**
 * True when the published merged graph does not reflect `inputs`
 * ([{ root, graphPath }]): no manifest or graph, a different root set, or an
 * input graph rewritten since its recorded mtime.
 */
export function machineGraphStale(stateDir, inputs) {
  const { graph, manifest } = machineGraphPaths(stateDir);
  const m = readJson(manifest);
  if (!m || !Array.isArray(m.roots) || !fs.existsSync(graph)) return true;
  if (m.roots.length !== inputs.length) return true;
  const byKey = new Map(m.roots.map((r) => [key(r.root), r]));
  for (const i of inputs) {
    const rec = byKey.get(key(i.root));
    if (!rec || rec.mtimeMs !== mtimeOf(i.graphPath)) return true;
  }
  return false;
}

const countsOf = (g) => ({
  nodes: Array.isArray(g?.nodes) ? g.nodes.length : 0,
  edges: Array.isArray(g?.links) ? g.links.length : (Array.isArray(g?.edges) ? g.edges.length : 0),
});

/**
 * Merge the opted-in repos' graphs into <stateDir>/graphs/machine. `merge(files,
 * out)` resolves to { code, stderr } (graphify merge-graphs); a single input is
 * copied, since merge-graphs needs two. Throws, publishing nothing, when there
 * are no inputs, the merge fails or its output is not a graph.
 */
export async function buildMachineGraph({ stateDir, inputs, merge, now = () => new Date() }) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('no opted-in repo has a graph to merge');
  const { dir, graph, manifest } = machineGraphPaths(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const staged = path.join(dir, `graph.staged.${process.pid}.json`);
  const roots = inputs.map((i) => ({ root: norm(i.root), mtimeMs: mtimeOf(i.graphPath), ...countsOf(readJson(i.graphPath)) }));
  try {
    if (inputs.length === 1) {
      fs.copyFileSync(inputs[0].graphPath, staged);
    } else {
      const r = await merge(inputs.map((i) => i.graphPath), staged);
      if (!r || r.code !== 0) throw new Error(`graphify merge-graphs failed (exit ${r?.code ?? '?'}): ${String(r?.stderr ?? '').trim().slice(0, 300)}`);
    }
    const merged = readJson(staged);
    if (!merged || !Array.isArray(merged.nodes)) throw new Error('merged machine graph is not a graph.json');
    const m = { builtAt: now().toISOString(), roots, ...countsOf(merged) };
    fs.renameSync(staged, graph);
    fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
    return m;
  } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* already moved */ }
  }
}

/** What the Map should call the graph it is showing. */
export function graphLabel({ scope, project, rootScope, merged, repoCount }) {
  const name = norm(project).split('/').filter(Boolean).pop() || null;
  if (scope === 'machine') return `Machine graph${Number.isInteger(repoCount) ? ` (${repoCount} ${repoCount === 1 ? 'repo' : 'repos'})` : ''}`;
  if (merged) return 'Ship graph (kernel + corpus)';
  if (!name) return 'Ship graph';
  if (rootScope === 'ship') return `Ship graph: ${name}`;
  if (rootScope === 'machine') return `Machine repo graph: ${name}`;
  if (rootScope === 'excluded') return `Repo graph: ${name} (outside ship scope)`;
  return `Repo graph: ${name}`;
}
