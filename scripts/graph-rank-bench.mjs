#!/usr/bin/env node
// Before/after measurement for upgrade-plan item 3: does personalized
// PageRank surface the files a task actually touches better than raw degree?
//
// Fixed query set: docs/bench/graph-rank-queries.json (--queries), backlog
// cards whose task prompt is the query and whose commits' code files are the
// relevant set (see graph-rank-queries.mjs). Without --queries it falls back
// to recent commit messages at --ref, which in this repo name no identifiers
// and so cannot exercise personalization. Files are scored by their
// best node. "unnamed" drops every file the query names directly (a seed's
// own file) from both the ranking and the relevant set, so a seed hit cannot
// score itself and what is left measures whether rank finds the related
// files nobody named.
//
// Caveat recorded with the numbers: the graph is built after the work, so it
// already contains each card's change.
//
// Usage: node scripts/graph-rank-bench.mjs --graph <graph.json> [--queries <file>] [--repo <dir> --ref <commit> --n 20] [--k 10] [--json]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pageRank, seedsFromText } from '../server/lib/observability/graph-rank.js';

const CODE_RE = /\.(m?js|cjs|ts|tsx|py)$/i;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

export function degreeScores(nodes, links) {
  const deg = new Map(nodes.map(n => [n.id, 0]));
  for (const l of links) {
    if (deg.has(l.source)) deg.set(l.source, deg.get(l.source) + 1);
    if (deg.has(l.target)) deg.set(l.target, deg.get(l.target) + 1);
  }
  return deg;
}

/** Files ordered by their best node's score, ties by path. */
export function rankFiles(nodes, scores, { exclude = new Set() } = {}) {
  const best = new Map();
  for (const n of nodes) {
    const f = n.source_file;
    if (!f || !CODE_RE.test(f) || exclude.has(f)) continue;
    const s = scores.get(n.id) ?? 0;
    if (!best.has(f) || s > best.get(f)) best.set(f, s);
  }
  return [...best].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
}

export function metrics(ranked, relevant, k) {
  if (!relevant.size) return null;
  const top = ranked.slice(0, k);
  const hits = top.filter(f => relevant.has(f)).length;
  const first = ranked.findIndex(f => relevant.has(f));
  return { recall: hits / relevant.size, rr: first < 0 ? 0 : 1 / (first + 1) };
}

function seededFirst(nodes, seeds, base) {
  // Control: the seeds' own files first, then degree. Separates "naming
  // things helps" from "PageRank helps".
  const boosted = new Map(base);
  for (const id of seeds.keys()) boosted.set(id, (boosted.get(id) ?? 0) + 1e9);
  return boosted;
}

function commitsAt(repo, ref, n, inGraph) {
  const log = execFileSync('git', ['-C', repo, 'log', '--no-merges', '--format=%x00%H%x01%B%x02', '--name-only', ref, '-n', '400'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const chunk of log.split('\x00').slice(1)) {
    const [sha, rest] = chunk.split('\x01');
    const [msg, files] = rest.split('\x02');
    const changed = files.split('\n').map(s => s.trim()).filter(f => CODE_RE.test(f) && inGraph.has(f));
    if (changed.length < 2 || changed.length > 10) continue;
    out.push({ sha, msg: msg.trim(), files: new Set(changed) });
    if (out.length >= n) break;
  }
  return out;
}

function main() {
  const graphPath = arg('graph');
  const repo = arg('repo', '.');
  const ref = arg('ref', 'HEAD');
  const n = Number(arg('n', 20));
  const k = Number(arg('k', 10));
  const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const nodes = g.nodes ?? [];
  const links = g.links ?? [];
  const inGraph = new Set(nodes.map(x => x.source_file).filter(Boolean));
  const qFile = arg('queries');
  const queries = qFile
    ? JSON.parse(fs.readFileSync(qFile, 'utf8'))
      .map(q => ({ sha: q.id, msg: q.query, files: new Set(q.files.filter(f => inGraph.has(f))) }))
      .filter(q => q.files.size >= 2)
    : commitsAt(repo, ref, n, inGraph);

  const degree = degreeScores(nodes, links);
  const plainPr = pageRank(nodes, links);
  const plainPrBoth = pageRank(nodes, links, { undirected: true });
  const fileOf = new Map(nodes.map(x => [x.id, x.source_file]));
  const methods = ['degree', 'seeds+degree', 'pagerank', 'personalized', 'pagerank-undirected', 'personalized-undirected'];
  const totals = { all: {}, 'names a node': {}, unnamed: {} };
  for (const set of Object.keys(totals)) for (const m of methods) totals[set][m] = { recall: 0, rr: 0, n: 0 };
  const rows = [];

  for (const q of queries) {
    const seeds = seedsFromText(nodes, q.msg);
    const ppr = seeds.size ? pageRank(nodes, links, { personalization: seeds }) : plainPr;
    const pprBoth = seeds.size ? pageRank(nodes, links, { personalization: seeds, undirected: true }) : plainPrBoth;
    const scores = {
      degree, 'seeds+degree': seededFirst(nodes, seeds, degree), pagerank: plainPr, personalized: ppr,
      'pagerank-undirected': plainPrBoth, 'personalized-undirected': pprBoth,
    };
    const named = new Set([...seeds.keys()].map(id => fileOf.get(id)).filter(Boolean));
    const unnamedRel = new Set([...q.files].filter(f => !named.has(f)));
    const row = { id: q.sha, seeds: seeds.size, relevant: q.files.size, unnamed: unnamedRel.size };
    for (const m of methods) {
      const a = metrics(rankFiles(nodes, scores[m]), q.files, k);
      const u = metrics(rankFiles(nodes, scores[m], { exclude: named }), unnamedRel, k);
      row[m] = a ? +a.recall.toFixed(3) : null;
      if (a) { totals.all[m].recall += a.recall; totals.all[m].rr += a.rr; totals.all[m].n++; }
      if (a && seeds.size) { const t = totals['names a node'][m]; t.recall += a.recall; t.rr += a.rr; t.n++; }
      if (u) { totals.unnamed[m].recall += u.recall; totals.unnamed[m].rr += u.rr; totals.unnamed[m].n++; }
    }
    rows.push(row);
  }

  const summary = {};
  for (const [set, byM] of Object.entries(totals)) {
    summary[set] = {};
    for (const [m, t] of Object.entries(byM)) {
      summary[set][m] = { [`recall@${k}`]: t.n ? +(t.recall / t.n).toFixed(3) : null, mrr: t.n ? +(t.rr / t.n).toFixed(3) : null, queries: t.n };
    }
  }
  const result = {
    graph: { path: graphPath, builtAtCommit: g.built_at_commit ?? null, nodes: nodes.length, links: links.length },
    source: qFile || `commits at ${ref}`, queries: queries.length, withSeeds: rows.filter(r => r.seeds > 0).length, k, summary, rows,
  };
  if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`graph ${result.graph.nodes} nodes / ${result.graph.links} links @ ${result.graph.builtAtCommit}; ${result.queries} queries from ${result.source}, ${result.withSeeds} name at least one node`);
  for (const [set, byM] of Object.entries(summary)) {
    console.log(`\n${set}`);
    for (const [m, v] of Object.entries(byM)) console.log(`  ${m.padEnd(24)} recall@${k} ${String(v[`recall@${k}`]).padEnd(6)} mrr ${String(v.mrr).padEnd(6)} (${v.queries} queries)`);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) main();
