#!/usr/bin/env node
// scripts/memory-lookup.mjs - the memory page-fault handler (glmps-157).
//
// MEMORY.md is a fixed-size cache of one-line hooks. Under pressure the
// coldest hooks are evicted, and the body files stay on disk. This is how a
// missing fact is found again: the model cannot fault on its own, so the index
// footer names this command and this command does the lookup.
//
// D23/D24 (glmps-159 task 6): the plain lookup path now calls
// GET /api/memory/lookup over HTTP instead of calling lookupFacts() directly
// -- scripts do not import plugin internals, and the route is what fuses the
// curated tier with Mem0's own admitted memories (mem0: hits), the same
// fused result the dashboard and the SessionStart hook see. --fault-in is
// unaffected: it is a curated-index-only operation (memory-fault.js, kept
// as-is at this cutover) and stays a direct, local call.
//
// Deliberately a repo-local CLI rather than an MCP server: registering an MCP
// tool means editing the user's global settings.json, and this needs no such
// privilege to be useful.
//
//   node scripts/memory-lookup.mjs "why does my Quantower indicator not load"
//   node scripts/memory-lookup.mjs --fault-in quantower-plugin-name-required.md
//   node scripts/memory-lookup.mjs --cwd D:\proj "resampling gotcha"
//
// --fault-in restores an evicted fact's index line verbatim and pins it so it
// is never evicted again (a resolved fault proves the eviction was wrong).
// --cwd (fix round 1, finding 4; defaults to process.cwd()) scopes the Mem0
// half to that project, the same slug convention admission uses - without
// it every invocation of this script, run from anywhere, would see Mission
// Control's own Mem0 memories rather than the project it was run from.

import http from 'node:http';
import { getPaths } from '../server/lib/paths.js';
import { faultIn } from '../server/lib/evaluation/memory-fault.js';

const rawArgv = process.argv.slice(2);
const P = getPaths();
const port = Number(process.env.GLMPS_PORT || 8123);

function usage(code = 0) {
  process.stdout.write(
    'usage:\n'
    + '  node scripts/memory-lookup.mjs [--cwd <dir>] "<query>"   search curated memory + Mem0\n'
    + '  node scripts/memory-lookup.mjs --fault-in <f>            restore an evicted fact to the index\n',
  );
  process.exit(code);
}

if (!rawArgv.length || rawArgv[0] === '-h' || rawArgv[0] === '--help') usage(rawArgv.length ? 0 : 1);

if (rawArgv[0] === '--fault-in') {
  const target = rawArgv[1];
  if (!target) usage(1);
  const res = faultIn({ memoryDir: P.memoryDir, stateDir: P.stateDir, target });
  process.stdout.write(res.restored
    ? `restored to MEMORY.md: ${res.line}\n`
    : `nothing to restore for ${target} (not evicted, or already present)\n`);
  process.exit(res.restored ? 0 : 1);
}

// Pull --cwd <dir> out of argv wherever it appears; everything else joins
// into the query text.
let cwd = process.cwd();
const argv = [];
for (let i = 0; i < rawArgv.length; i++) {
  if (rawArgv[i] === '--cwd' && rawArgv[i + 1]) { cwd = rawArgv[++i]; continue; }
  argv.push(rawArgv[i]);
}
if (!argv.length) usage(1);

function getJson(reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

const query = argv.join(' ');
let result;
try {
  result = await getJson(`/api/memory/lookup?q=${encodeURIComponent(query)}&k=5&cwd=${encodeURIComponent(cwd)}`);
} catch (e) {
  process.stdout.write(`could not reach the memory server on port ${port}: ${e.message}\n`);
  process.exit(1);
}
// the route itself failing
// (a non-200 response) is the only case that exits 1 here - curated is not
// a fallback, so a Mem0-only failure (mem0Error, still a 200) is a warning,
// not a hard failure.
if (result.status !== 200) {
  process.stdout.write(`memory lookup failed (${result.status}): ${result.body?.error ?? 'unknown error'}\n`);
  process.exit(1);
}
if (result.body.mem0Error) {
  process.stdout.write(`warning: Mem0 is unavailable (${result.body.mem0Error}); showing curated memory only\n`);
}
const hits = result.body.hits || [];
if (!hits.length) {
  process.stdout.write(`no memory matched: ${query}\n`);
  process.exit(1);
}
for (const h of hits) {
  process.stdout.write(`\n${h.target}  (score ${h.score})\n  ${h.title}\n  ${h.excerpt}\n`);
}
process.stdout.write(`\nRead the full fact with: Read ${P.memoryDir}/<file>\n`);
process.exit(0);
