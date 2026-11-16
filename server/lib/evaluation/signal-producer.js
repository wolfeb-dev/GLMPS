// server/lib/evaluation/signal-producer.js
// The ONE signal-producer seam (Coordination Contract, docs/superpowers/specs/
// 2026-07-11-c1-c2-b-aligned-design.md sec 3). Any build that wants a finding to
// reach the dashboard's alert/signal feed registers a zero-arg function here
// instead of splicing into collectCurrentAlerts() directly - that splice was
// Build A's Task-8 stopgap; this module replaces it (server.js Task 2). Each
// registered producer returns an array of alert-finding-shaped objects (the
// same shape alert-sources.js's `attestation` pass-through consumes:
// { source, severity, title, detail, target, ts }) or throws - collectSignals()
// is fail-open per producer, so one broken producer never blanks the others.
const producers = [];

/** Register a zero-arg producer function. Non-functions are ignored. */
export function registerProducer(fn) {
  if (typeof fn === 'function') producers.push(fn);
}

/** Call every registered producer, concatenating their results. Fail-open per producer. */
export function collectSignals() {
  const out = [];
  for (const fn of producers) {
    try {
      const rows = fn();
      if (Array.isArray(rows)) out.push(...rows);
    } catch { /* fail-open: a broken producer contributes nothing */ }
  }
  return out;
}

/**
 * Test-only: clears the registry. server.js's startServer() also calls this
 * as its first statement, so every server instance (and every test that
 * calls startServer() more than once per process) gets a clean registry - 
 * ESM modules are process-wide singletons, so without this the registry
 * would grow unboundedly across repeated startServer() calls.
 */
export function _resetProducers() {
  producers.length = 0;
}
