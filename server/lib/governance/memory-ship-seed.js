// server/lib/governance/memory-ship-seed.js
// First-run seed of the cross-agent memory store (card glmps-2-0-183), modelled
// on ../observability/graph-ship-seed.js. An installed kernel carries
// product/seed/memory.json (the operator-approved, generic share text) next to
// its bundle.json; on start that text goes into an EMPTY or absent store as
// approved facts. A store that already has items is never touched, and a source
// checkout (no bundle.json) never seeds, so the operator's own store is safe.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { load, save, upsertCandidateInto } from './cross-agent-memory-store.js';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } };

export const SEED_SOURCE_PROJECT = 'bundle-seed';

/** Returns { seeded, reason, count? }. Never throws on a missing or damaged seed. */
export function seedMemoryStore({ bundleDir, stateDir }) {
  if (!readJson(path.join(bundleDir, 'bundle.json'))) return { seeded: false, reason: 'not an installed bundle' };
  const seed = readJson(path.join(bundleDir, 'product', 'seed', 'memory.json'));
  const rows = Array.isArray(seed?.items) ? seed.items.filter((i) => typeof i?.text === 'string' && i.text.trim()) : [];
  if (!rows.length) return { seeded: false, reason: 'no bundled memory seed' };
  if (load(stateDir).items.length) return { seeded: false, reason: 'memory store already has items' };

  let state = load(stateDir);
  let count = 0;
  for (const row of rows) {
    const name = `seed-${crypto.createHash('sha1').update(row.text).digest('hex').slice(0, 10)}`;
    const r = upsertCandidateInto(state, { name, description: row.kind === 'lesson' ? 'Starter guard' : 'Starter memory', type: row.kind === 'lesson' ? 'lesson' : 'memory', body: row.text, confidence: null }, SEED_SOURCE_PROJECT);
    if (!r.isNew || r.item.status === 'quarantined') continue;
    // The operator approved this text when he marked it shareable; intake still poison-scanned it above.
    state = { ...r.state, items: r.state.items.map((i) => (i.id === r.item.id ? { ...i, status: 'approved' } : i)) };
    count++;
  }
  if (!count) return { seeded: false, reason: 'every seed item was refused by intake' };
  save(stateDir, state);
  return { seeded: true, reason: 'empty store', count };
}
