// server/lib/observability/alert-acks.js
// Persisted operator acknowledge/dismiss store for the dashboard alert center
// (glmps-70). Alerts get a stable dedup id derived from source+title+target
// (see alerts.js:deriveId) - target JSON usually carries a session id and/or
// path, so a fresh occurrence (new session, new path) derives a NEW id and is
// therefore never suppressed by an old ack. That is the re-alert guarantee:
// it falls out of the existing id scheme, this store just remembers which
// ids an operator has explicitly reviewed and dismissed.
//
// Store shape on disk: { [alertId]: ackedAtMs }. Capped: entries older than
// PRUNE_AGE_MS are dropped on every save, since an acked id whose alert never
// fires again is dead weight that would otherwise grow forever.
import fs from 'node:fs';
import path from 'node:path';

export const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Read the ack store. Missing/corrupt/non-object files all resolve to {}. */
export function loadAcks(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, ts] of Object.entries(raw)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) out[id] = ts;
    }
    return out;
  } catch { return {}; }
}

function pruneAcks(acks, now) {
  const cutoff = now - PRUNE_AGE_MS;
  const out = {};
  for (const [id, ts] of Object.entries(acks)) if (ts >= cutoff) out[id] = ts;
  return out;
}

function persist(file, acks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(acks, null, 2));
  fs.renameSync(tmp, file);
  return acks;
}

/** Acknowledge/dismiss an alert id. No-op (does not create the file) when id is empty. */
export function ack(file, id, now = Date.now()) {
  if (!id) return loadAcks(file);
  const acks = pruneAcks(loadAcks(file), now);
  acks[id] = now;
  return persist(file, acks);
}

/** Undo a previous ack. No-op when the store or id doesn't exist. */
export function unack(file, id) {
  const acks = loadAcks(file);
  if (!(id in acks)) return acks;
  delete acks[id];
  return persist(file, acks);
}

/**
 * Stamp acknowledged:true (+ acknowledgedAt) on alerts whose id is in the acks
 * map. Pure - does not mutate the input alerts or their objects.
 */
export function applyAcks(alerts, acks) {
  const map = acks && typeof acks === 'object' ? acks : {};
  return (Array.isArray(alerts) ? alerts : []).map((a) => {
    if (!a || !(a.id in map)) return a;
    return { ...a, acknowledged: true, acknowledgedAt: map[a.id] };
  });
}
