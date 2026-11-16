// server/lib/observability/graph-fingerprint.js
// Identity of a graphify graph as the wiki sees it: a SHA-256 over exactly the
// fields the wiki builder reads (node id, label, source_file, source_location;
// link source, target), each list sorted so order is irrelevant. A graph
// rebuilt at an unchanged HEAD (graphify upgrade, rebuild tick) changes this
// without moving any commit; a change only to fields the wiki ignores
// (community ids, confidence scores) does not. If the builder starts reading a
// new graph field, add it here and bump the prefix.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GRAPH_FINGERPRINT_PREFIX = 'g1:';

const SEP = '\u0001';
const str = (v) => (v == null ? '' : String(v));

export function graphFingerprint(graph) {
  if (!graph || typeof graph !== 'object') return null;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph.links) ? graph.links : [];
  const nodeRows = nodes.map(n => [n?.id, n?.label, n?.source_file, n?.source_location].map(str).join(SEP)).sort();
  const linkRows = links.map(l => [l?.source, l?.target].map(str).join(SEP)).sort();
  const h = crypto.createHash('sha256');
  h.update(`nodes ${nodeRows.length}\n`);
  for (const r of nodeRows) h.update(`${r}\n`);
  h.update(`links ${linkRows.length}\n`);
  for (const r of linkRows) h.update(`${r}\n`);
  return GRAPH_FINGERPRINT_PREFIX + h.digest('hex');
}

// For the status read (GET /api/wiki): a 20 MB graph costs ~90 ms to parse and
// digest, so it is re-read only when its mtime or size changed. A missing or
// unparseable graph is null, which computeWikiStatus reports as
// 'unknown' / graph-unreadable rather than guessing.
export function createGraphFingerprintReader({ stat = fs.promises.stat, readFile = fs.promises.readFile } = {}) {
  const cache = new Map();
  return async function readGraphFingerprint(root) {
    const file = path.join(String(root), 'graphify-out', 'graph.json');
    let st;
    try { st = await stat(file); }
    catch { cache.delete(file); return null; }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.key === key) return hit.fingerprint;
    let fingerprint = null;
    try { fingerprint = graphFingerprint(JSON.parse(await readFile(file, 'utf8'))); }
    catch { fingerprint = null; }
    cache.set(file, { key, fingerprint });
    return fingerprint;
  };
}
