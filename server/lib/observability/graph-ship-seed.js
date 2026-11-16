// server/lib/observability/graph-ship-seed.js
// First-run seed of the ship graph (graphify plan task 7, card glmps-2-0-97).
// An installed kernel carries graphs/ship next to its bundle.json; on start
// that copy goes to <stateDir>/graphs/ship when the state dir has none, has an
// unreadable one, or has one built before the bundled graph. A local graph
// built later (the app refreshing it) is left alone. A source checkout has no
// bundle.json shipGraph record, so it never seeds.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

/**
 * Returns { seeded, reason }. Throws only when the copy itself fails; a
 * bundled graph whose checksum does not match bundle.json is refused, not
 * thrown, so a damaged install still starts.
 */
export function seedShipGraph({ bundleDir, stateDir }) {
  const record = readJson(path.join(bundleDir, 'bundle.json'))?.shipGraph;
  if (!record) return { seeded: false, reason: 'no bundled ship graph' };
  const src = path.join(bundleDir, 'graphs', 'ship');
  const srcManifest = readJson(path.join(src, 'ship-manifest.json'));
  if (!srcManifest || !fs.existsSync(path.join(src, 'graph.json'))) return { seeded: false, reason: 'bundled ship graph is missing' };

  const dst = path.join(stateDir, 'graphs', 'ship');
  const local = readJson(path.join(dst, 'ship-manifest.json'));
  const localTs = Date.parse(local?.builtAt);
  let why;
  if (!local || !fs.existsSync(path.join(dst, 'graph.json'))) why = 'absent';
  else if (!Number.isFinite(localTs)) why = 'unreadable';
  else if (localTs < Date.parse(srcManifest.builtAt)) why = 'older';
  else return { seeded: false, reason: 'local ship graph is current' };

  const graph = fs.readFileSync(path.join(src, 'graph.json'));
  if (crypto.createHash('sha256').update(graph).digest('hex') !== record.sha256) {
    return { seeded: false, reason: 'bundled ship graph fails its bundle.json checksum' };
  }
  fs.mkdirSync(dst, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dst, '.seed-'));
  try {
    fs.writeFileSync(path.join(staging, 'graph.json'), graph);
    fs.copyFileSync(path.join(src, 'ship-manifest.json'), path.join(staging, 'ship-manifest.json'));
    fs.renameSync(path.join(staging, 'graph.json'), path.join(dst, 'graph.json'));
    fs.renameSync(path.join(staging, 'ship-manifest.json'), path.join(dst, 'ship-manifest.json'));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { seeded: true, reason: why };
}
