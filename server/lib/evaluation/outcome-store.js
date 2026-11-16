import fs from 'node:fs';
import path from 'node:path';

export function outcomeFile(stateDir) {
  return path.join(stateDir, 'outcomes', 'rows.ndjson');
}

export function appendOutcome(stateDir, row) {
  const dir = path.join(stateDir, 'outcomes');
  fs.mkdirSync(dir, { recursive: true });
  const file = outcomeFile(stateDir);
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return { row };
}

export function readOutcomes(stateDir, { unit, taskClass } = {}) {
  const file = outcomeFile(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return rows.filter(r =>
    (unit === undefined || r.unit === unit) &&
    (taskClass === undefined || r.taskClass === taskClass)
  );
}

// a plain `{...row, ...patch}` merge let
// a patch's `extra` object wipe every OTHER field already recorded under
// row.extra (e.g. the judge's { outcomeClass, judge } patch erasing
// readEditRatio, written earlier by a completely different code path) -
// extra is deep-merged one level so a patch only ever adds/overwrites its
// own keys there, never the whole object.
export function updateOutcome(stateDir, id, patch) {
  const file = outcomeFile(stateDir);
  const rows = readOutcomes(stateDir);
  let found = null;
  const updated = rows.map(r => {
    if (r.id !== id) return r;
    found = { ...r, ...patch };
    if (patch && patch.extra) found.extra = { ...(r.extra || {}), ...patch.extra };
    return found;
  });
  if (!found) return { row: null };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, updated.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
  return { row: found };
}
