// server/lib/evaluation/internal-sessions.js
//
// Persisted set of session ids that are GLMPS's OWN internal worker
// spawns, not real user sessions. A `claude -p --output-format json` envelope
// returns its own session_id, which a spawn wrapper can record here right
// after the call so sessions.js -- which discovers the same transcript from
// the OUTSIDE, with no visibility into the child's env -- can later tag that
// session `internal: true` instead of counting it as a live user session.
//
// D23/D24 cutover (glmps-159 task 6): the pre-D23 memory distiller's own
// such spawn (memory-distill-core.js's sessionIdFromEnvelope, feeding
// markInternal right after extraction) is retired along with that pipeline.
// markInternal/loadInternal/isInternalSession stay as a general, still-live
// primitive; nothing currently calls markInternal (the shared model call
// every D23 loop plugin uses, server/lib/plugins/claude-model.js's
// runClaude, does not currently surface its own session_id to its caller).
//
// Mirrors alert-seen.js's persistence contract exactly: sorted array on disk,
// tmp-file + rename write, missing/corrupt/non-array resolves to an empty
// Set, never pruned. Not pruning is deliberate here too: an id that stops
// recurring is a few bytes forever, and the failure mode of pruning (a
// REUSED session id later reading as a real user session) is worse than the
// cost of keeping it.
import fs from 'node:fs';
import path from 'node:path';

/** Load the internal-id set. Missing/corrupt/non-array files resolve to an empty Set. */
export function loadInternal(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((x) => typeof x === 'string'));
  } catch { return new Set(); }
}

/** Persist the internal-id set (sorted array on disk for stable diffs/inspection). */
export function saveInternal(file, set) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...set].sort(), null, 2));
  fs.renameSync(tmp, file);
}

/** Record `id` as internal. Returns true when newly added, false on a repeat. */
export function markInternal(file, id) {
  const set = loadInternal(file);
  if (set.has(id)) return false;
  set.add(id);
  saveInternal(file, set);
  return true;
}
