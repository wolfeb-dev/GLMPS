// server/lib/scut/dedup.js
// Bounded inbound dedup for SCUT. Slack redelivers the same event (same
// event_ts) on reconnect/slow-ack; under routing model C a duplicate = a
// double-launched worktree job or a doubled steer, not a cosmetic double-reply.
// isNew(key) records the key and returns true only the first time it is seen.
// A missing key can't be deduped, so it counts as new. Process-lifetime only;
// a restart-surviving version can come later if needed (spec: hardening).

export function makeDedup({ max = 1000 } = {}) {
  const seen = new Set(); // insertion-ordered -> oldest is first
  return {
    isNew(key) {
      if (key == null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > max) seen.delete(seen.values().next().value);
      return true;
    },
  };
}
