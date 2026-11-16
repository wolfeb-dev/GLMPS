// taps/tap-shipper.js
// Ships the spool to POST /api/tap/ingest (server-and-client-tap task 9). One
// batch per tick when due; the server's high-water mark in the answer is what
// gets acked, so a retry after a lost answer is a harmless replay. A failure
// backs off 1 s doubling to 5 minutes; a 401 or 426 stops shipping and keeps
// the spool until the agent sees the client paired again.
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { TAP_INGEST_MAX_BYTES } from '../server/lib/kernel/tap-ingest.js';

export const INGEST_PATH = '/api/tap/ingest';
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
const INGEST_TIMEOUT_MS = 30_000;
// Leaves room in the 1 MiB body for the envelope and the spool stats.
const BATCH_BYTES = TAP_INGEST_MAX_BYTES - 2048;

export function nextBackoffMs(prev) {
  return prev > 0 ? Math.min(prev * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS;
}

// The client id is deliberately not in the body: the server resolves it from the token.
export function ingestRequest({ config, token, records, spool }) {
  return {
    url: `${config.server}${INGEST_PATH}`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) },
    body: JSON.stringify({ records, spool }),
  };
}

/** getCreds() -> {config, token} or null when the tap is not configured or paired. */
export function createShipper({ spool, getCreds, fetch: fetchFn = globalThis.fetch, now = Date.now, log = console.error }) {
  let backoffMs = 0;
  let nextAt = 0;
  let inFlight = false;
  let stopped = null;
  let lastShipTs = null;
  let lastError = null;
  // The server's view of whether this spool is full, so a cleared episode is reported once.
  let reportedFull = false;

  function fail(reason) {
    backoffMs = nextBackoffMs(backoffMs);
    nextAt = now() + backoffMs;
    lastError = reason;
    log(`[tap-shipper] ${reason}; retrying in ${Math.round(backoffMs / 1000)}s`);
    return { shipped: false, reason, backoffMs };
  }

  async function tick() {
    if (inFlight) return { skipped: 'in-flight' };
    if (stopped) return { skipped: stopped };
    if (now() < nextAt) return { skipped: 'backoff' };
    const creds = getCreds();
    if (!creds) return { skipped: 'no-credentials' };
    const records = spool.readBatch({ maxBytes: BATCH_BYTES });
    const st = spool.stats();
    if (!records.length && st.full === reportedFull) return { idle: true };
    const stats = { depth: st.depth, bytes: st.bytes, full: st.full, dropped: st.dropped };
    const req = ingestRequest({ config: creds.config, token: creds.token, records, spool: stats });
    inFlight = true;
    try {
      let res;
      try {
        res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(INGEST_TIMEOUT_MS) });
      } catch (e) { return fail(`server unreachable: ${e?.cause?.code || e?.message || String(e)}`); }
      if (res.status === 401) { stopped = 'unpaired'; lastError = 'the server refused this client; pair it again'; return { shipped: false, stopped }; }
      if (res.status === 426) { stopped = 'protocol-too-old'; lastError = 'the server requires a newer tap protocol'; return { shipped: false, stopped }; }
      if (res.status !== 200) return fail(`ingest answered ${res.status}`);
      let body;
      try { body = await res.json(); } catch { return fail('ingest answered 200 with no JSON'); }
      if (!Number.isSafeInteger(body?.highWater)) return fail('ingest answer has no highWater');
      spool.ack(body.highWater);
      spool.reported({ dropped: stats.dropped });
      reportedFull = stats.full;
      backoffMs = 0; nextAt = 0; lastError = null; lastShipTs = now();
      return { shipped: true, accepted: body.accepted, duplicates: body.duplicates, highWater: body.highWater };
    } finally { inFlight = false; }
  }

  return {
    tick,
    // Called on every paired heartbeat. Only a 401/426 stop is cleared: a paired
    // heartbeat says nothing about ingest, so a failing ingest keeps its ladder.
    resume: () => { if (!stopped) return; stopped = null; backoffMs = 0; nextAt = 0; },
    // A ship is mid-request; the updater does not restart under it.
    busy: () => inFlight,
    status: () => ({
      state: stopped ?? (backoffMs ? 'backoff' : 'ok'),
      backoffMs, nextAttemptTs: nextAt || null, lastShipTs, lastError,
    }),
  };
}
