// server/lib/plugins/single-flight.js
//
// A tiny in-process mutex for "at most one of this work at a time." Used by
// POST /api/memory/migrate-distilled to guard
// against two overlapping calls racing the same migration ledger file.
export function createSingleFlight() {
  let running = false;
  return async function runExclusive(fn) {
    if (running) return { busy: true, result: undefined };
    running = true;
    try {
      const result = await fn();
      return { busy: false, result };
    } finally {
      running = false;
    }
  };
}
