// server/lib/evaluation/skill-observation-log.js
//
// Idempotent "when did we first see this skill installed" ledger. Neither
// skills-view.js nor inventory.js persists any history - scanInventory() is
// pure and recomputed fresh on every call, so `uses === 0` alone can't tell
// "never invoked since logging began" apart from "installed five minutes
// ago." This ledger closes that gap by remembering the FIRST time a skill id
// was observed installed, and never updating that timestamp again - updating
// it on every tick would reset the clock and defeat skill-retire.js's whole
// "long observation window" guarantee (glmps-88, DEFAULT_MIN_OBSERVATION_DAYS).
//
// stateDir/skills/observed-since.json - { [skillId]: firstSeenTsMs }
// skillId convention: `${plugin}:${name}`.toLowerCase() - the SAME identity
// key skills-view.js's toRow() now emits (C.5) and inventory.js's
// dedupeInventory() already uses internally.
import fs from 'node:fs';
import path from 'node:path';

function storePath(stateDir) {
  return path.join(stateDir, 'skills', 'observed-since.json');
}

/** Load the observed-since map. Missing/corrupt files resolve to {}. */
export function getObservedSince(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(stateDir), 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, ts] of Object.entries(raw)) {
      if (typeof id === 'string' && typeof ts === 'number' && Number.isFinite(ts)) out[id] = ts;
    }
    return out;
  } catch { return {}; }
}

function saveObservedSince(stateDir, map) {
  const file = storePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Idempotent: only ever ADDS a key the first time it's seen; never updates an
 * existing timestamp. Malformed ids (non-string/empty) are skipped, never
 * fatal to the whole batch. No-op (does not even open the file for write) if
 * every id is already known, so a steady-state daily tick with nothing new
 * costs nothing.
 * @param {string[]} skillIds
 * @param {number} [nowMs]
 * @returns {Record<string, number>} the updated observed-since map
 */
export function recordFirstSeen(stateDir, skillIds, nowMs = Date.now()) {
  const map = getObservedSince(stateDir);
  let changed = false;
  for (const id of Array.isArray(skillIds) ? skillIds : []) {
    if (typeof id !== 'string' || !id) continue;
    if (Object.prototype.hasOwnProperty.call(map, id)) continue; // never overwrite
    map[id] = nowMs;
    changed = true;
  }
  if (changed) saveObservedSince(stateDir, map);
  return map;
}
