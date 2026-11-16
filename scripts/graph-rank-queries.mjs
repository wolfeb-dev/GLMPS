#!/usr/bin/env node
// Regenerates the fixed query set for graph-rank-bench.mjs. A query is a
// backlog card's title and task prompt, which is what the agent working the
// card was told; its relevant set is the code files of every commit on
// origin/main or origin/glmps2/main whose message names the card. Commit
// messages alone cannot be queries here: house style keeps identifiers out of
// them, and 0 of the 20 latest named a single one.
//
// Usage: node scripts/graph-rank-queries.mjs <backlog.json from GET /api/backlog> <graph.json> <repo> <out.json>
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [blFile, graphFile, repo, outFile] = process.argv.slice(2);
const CODE_RE = /\.(m?js|cjs|ts|tsx|py)$/i;
const items = JSON.parse(fs.readFileSync(blFile, 'utf8')).items || [];
const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const inGraph = new Set(g.nodes.map(n => n.source_file).filter(Boolean));
const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
const out = [];
for (const c of items) {
  if (!['glmps', 'glmps-2.0', 'glmps-2-0', 'glmps-2'].includes(c.project)) continue;
  const prompt = `${c.title || ''}\n${c.prompt || ''}`.trim();
  if (!prompt) continue;
  const re = `${c.id.replace(/[.]/g, '\\.')}([^0-9]|$)`;
  let shas;
  try { shas = git(['log', '--no-merges', '-E', `--grep=${re}`, '--format=%H', 'origin/main', 'origin/glmps2/main']).trim().split('\n').filter(Boolean); }
  catch { continue; }
  if (!shas.length) continue;
  const files = new Set();
  for (const s of shas) for (const f of git(['show', '--name-only', '--format=', s]).split('\n')) {
    const t = f.trim();
    if (CODE_RE.test(t) && inGraph.has(t)) files.add(t);
  }
  if (files.size < 2 || files.size > 15) continue;
  out.push({ id: c.id, commits: shas.length, query: prompt, files: [...files].sort() });
}
out.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(out.length, 'queries');
