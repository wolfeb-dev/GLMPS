// server/lib/evaluation/agent-observation-log.js
// firstSeen per agent id, so "0 dispatches" can be told apart from "we only
// started watching yesterday". Mirrors skill-observation-log.js. Agent capture
// accrues forward-only (there is no backfill), so without this every agent
// reads as dead on day one.
import fs from 'node:fs';
import path from 'node:path';

const file = (stateDir) => path.join(stateDir, 'agents', 'observation-log.json');

export function getObservedSince(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(stateDir), 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    // Drop any entry whose value is not a finite number (disk corruption, a
    // hand-edit, a future writer bug). A malformed firstSeen must read as
    // "never watched" downstream (agent-retire.js's fail-open path), not as
    // an NaN that slips past the `< minDays` window check and gets proposed
    // for retirement - the exact inverse of this module's guarantee. Mirrors
    // skill-observation-log.js's identical per-entry filter.
    const out = {};
    for (const [id, ts] of Object.entries(raw)) {
      if (typeof id === 'string' && typeof ts === 'number' && Number.isFinite(ts)) out[id] = ts;
    }
    return out;
  } catch { return {}; }
}

export function recordFirstSeen(stateDir, agentNames = [], nowMs = Date.now()) {
  const current = getObservedSince(stateDir);
  let changed = false;
  for (const name of agentNames) {
    if (!name || current[name] != null) continue;   // never move firstSeen forward
    current[name] = nowMs;
    changed = true;
  }
  if (!changed) return current;
  const f = file(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
  fs.renameSync(tmp, f);
  return current;
}
