// server/lib/observability/code-graph.js
import fs from 'node:fs';
import { classifyPath, DEFAULT_ZONE_CONFIG } from '../zones.js';
import { rankGraph } from './graph-rank.js';

// `focus` is conversation text (prompts, touched paths); nodes it names seed a
// personalized PageRank, so the god flag follows the work in hand. With no
// focus the undirected rank reproduces degree order (scripts/graph-rank-bench.mjs).
export function loadGraph(graphPath, { projectRoot, config = DEFAULT_ZONE_CONFIG, headCommit, verifiedAtCommit = null, focus = '' } = {}) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(graphPath, 'utf8')); } catch { return null; }
  const links = Array.isArray(raw.links) ? raw.links : [];
  const deg = new Map();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const { rank, seeds } = rankGraph(rawNodes, links, { focus });
  const nodes = rawNodes.map(n => {
    const z = classifyPath(n.source_file ?? '', { relative: true, config });
    return { ...n, zone: z.zone, env: z.env, protected: z.protected, degree: deg.get(n.id) ?? 0, rank: rank.get(n.id) ?? 0 };
  });
  const ranksDesc = nodes.map(n => n.rank).sort((a, b) => b - a);
  const cut = ranksDesc.length ? ranksDesc[Math.min(ranksDesc.length - 1, Math.floor(ranksDesc.length * 0.03))] : 0;
  for (const n of nodes) n.god = n.rank >= cut && n.degree > 2;
  const builtAtCommit = raw.built_at_commit ?? null;
  let stale = null;
  if (headCommit && (builtAtCommit || verifiedAtCommit)) {
    const a = String(headCommit);
    const same = (b) => !!b && (a.startsWith(String(b)) || String(b).startsWith(a));
    stale = !(same(builtAtCommit) || same(verifiedAtCommit));
  }
  return { nodes, links, communities: new Set(nodes.map(n => n.community)).size, builtAtCommit, verifiedAtCommit, stale, focusSeeds: seeds.size };
}
