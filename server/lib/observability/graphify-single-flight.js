// server/lib/observability/graphify-single-flight.js
// One per-root in-flight guard shared by every `graphify update <root>`
// caller (graphRebuildTick, the wiki loop maker's refreshGraph,
// POST /api/graph/rebuild -- task-10-findings.md R-M6). Two writers racing
// on the same root's graph.json is the 2026-07-28 collapse-incident class:
// a second caller for the SAME root while the first is still running is
// refused immediately with a named reason, never allowed to run as a
// second writer. A DIFFERENT root is unaffected -- each root writes its
// own file, so only same-root callers need to serialize.
//
// Pure coordination, no fs/process/git -- each of the three real call
// sites passes its OWN async function (the actual spawn-and-wait) as `fn`.
import path from 'node:path';

export class GraphifyBusyError extends Error {
  constructor(root) {
    super(`graphify-busy: an update for ${root} is already running`);
    this.code = 'graphify-busy';
    this.root = root;
  }
}

// Roots are filesystem paths, compared the same way isRepoRoot() already
// does elsewhere in server.js (path.resolve + toLowerCase): Windows paths
// are case-insensitive, and this guard must treat 'D:/x' and 'd:\\x\\' as
// the same root, not two different ones that could both run at once.
const keyOf = (root) => path.resolve(String(root)).toLowerCase();

// reserve(roots) is the graphify version audit's claim on its roots: from the
// upgrade to the verdict, any caller that does not pass the reservation is
// refused as busy, so a routine rebuild can no longer take a root between the
// install and the audit (2026-11-03 4:48 PM PT). A root already reserved by
// someone else is left to them.
export function createGraphifySingleFlight() {
  // key -> the root as its caller named it, so running() lists real paths.
  const inFlight = new Map();
  const reserved = new Map();
  return {
    async run(root, fn, { reservation } = {}) {
      const key = keyOf(root);
      const owner = reserved.get(key);
      if (inFlight.has(key) || (owner && owner !== reservation)) throw new GraphifyBusyError(key);
      inFlight.set(key, String(root));
      try { return await fn(); }
      finally { inFlight.delete(key); }
    },
    isRunning(root) { return inFlight.has(keyOf(root)); },
    running() { return [...inFlight.values()]; },
    // Resolves once none of `roots` is in flight, or at the deadline or when
    // stop() turns true, with the roots still busy.
    async waitIdle(roots, {
      maxWaitMs = 60 * 60 * 1000, pollMs = 5000, now = Date.now, stop = () => false,
      sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
    } = {}) {
      const deadline = now() + maxWaitMs;
      for (;;) {
        const busy = roots.filter((r) => inFlight.has(keyOf(r)));
        if (!busy.length || stop() || now() >= deadline) return { idle: !busy.length, busy };
        await sleep(pollMs);
      }
    },
    reserve(roots) {
      const token = Symbol('graphify-reservation');
      const keys = [...new Set(roots.map(keyOf))].filter((k) => !reserved.has(k));
      for (const k of keys) reserved.set(k, token);
      return {
        token,
        release() { for (const k of keys) if (reserved.get(k) === token) reserved.delete(k); },
      };
    },
  };
}

// graphifyVersionTick's own post-upgrade
// rebuild loop used to treat a GraphifyBusyError (another caller already
// holding the root) as an unrecoverable per-tick failure -- it escaped to
// the tick's outer catch, which only logs, skipping auditRebuild and the
// rollback decision entirely. The NEXT tick then sees installed === latest
// and never re-attempts the audit: the upgrade is kept permanently
// unaudited, exactly what the audit exists to prevent. Waits for the root
// (retrying on GraphifyBusyError) with a bounded timeout; a root still busy
// past the deadline rethrows GraphifyBusyError, which the caller folds into
// a named per-root failure rather than an unrelated crash -- see
// auditRebuildWithFailures in graphify-version.js. `graphifyUpdate` is
// passed in (never imported) so this stays pure and testable with a fake.
export async function waitForGraphifyUpdate(root, graphifyUpdate, {
  timeout, maxWaitMs = 60_000, pollMs = 500, now = Date.now,
  // unref'd -- this wait has no
  // shutdown tie-in of its own (a plain function call, not a registered
  // loop the registry's own stop()/abort() ever reaches), so a pending
  // timer here must never be the thing keeping the whole process alive
  // past close().
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
} = {}) {
  const deadline = now() + maxWaitMs;
  for (;;) {
    try { return await graphifyUpdate(root, { timeout }); }
    catch (e) {
      if (!(e instanceof GraphifyBusyError) || now() >= deadline) throw e;
      await sleep(pollMs);
    }
  }
}
