// server/lib/observability/alert-seen.js
// Persisted "have we already recorded a shadow-arm occurrence for this alert
// id" set - the Phase-3 piece that lets the alert -> learning loop measure
// alert RECURRENCE (server/lib/evaluation/shadow-arm.js), not just the
// existence of a guard proposal. Keyed by the alert's own dedup id (see
// alerts.js's deriveId/normalizeAlert), which already embeds target identity
// (session, path, ticket id, ...) - a genuinely NEW occurrence (different
// session, different path) derives a different id and is recorded again,
// while repeat polls of the SAME standing alert are not.
//
// Deliberately NOT pruned (unlike alert-acks.js's 90-day cap): an id that
// never recurs again is a few bytes forever, and pruning here would let a
// still-standing alert's id age out and then double-count when it re-fires.
import fs from 'node:fs';
import path from 'node:path';

/** Load the seen-id set. Missing/corrupt/non-array files resolve to an empty Set. */
export function loadAlertSeen(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((x) => typeof x === 'string'));
  } catch { return new Set(); }
}

/** Persist the seen-id set (sorted array on disk for stable diffs/inspection). */
export function saveAlertSeen(file, seen) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify([...seen].sort(), null, 2));
  fs.renameSync(tmp, file);
}
