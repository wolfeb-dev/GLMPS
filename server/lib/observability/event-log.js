// server/lib/observability/event-log.js
//
// Durable, append-only, typed event log - the on-disk twin of the in-memory
// `eventLog` Map in server.js (ring-capped ~2000, rehydrated by re-parsing
// transcripts). This module gives the same per-event stream a durable NDJSON
// record so the memory distiller, replay, and any future reader can consume
// events without re-parsing transcripts, and so events survive a restart.
//
// Mirrors server/lib/evaluation/outcome-store.js's append/read/atomic-rewrite
// pattern exactly. Shared event shape: { kind, lane, label, path, tool, ts,
// sessionId } + optional fields (op, change, model, actor). No new required
// fields are introduced here.
import fs from 'node:fs';
import path from 'node:path';

export function eventLogFile(stateDir) {
  return path.join(stateDir, 'events', 'log.ndjson');
}

// Real events carry `ts` as an ISO-8601 string (extract-claude.js etc.); tests
// and other callers may pass numeric epoch ms. Normalize either to a number
// for comparison; unparseable/missing values become null (excluded by since).
// Exported so any other caller comparing an
// event's own `ts` against a numeric epoch (the judge adapter's closer-
// freshness ts, obligation-sweeper.js's verdictTs guard) uses the SAME
// normalization, rather than a second, possibly-divergent parse of its own.
export function tsToMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

// Append a batch of events as JSON lines in ONE write. Fail-open: any I/O
// error (missing/locked dir, read-only FS, etc.) is swallowed so a durability
// failure never blocks the SSE/dashboard hot path that calls this. Batching
// matters: pushEvents runs per poll tick with a batch of events, so one
// mkdir + one appendFileSync per tick beats N sync writes on the event loop
// (the exact hot-path sync-I/O pattern the perf fix removed elsewhere).
export function appendEvents(stateDir, events) {
  if (!events || events.length === 0) return;
  try {
    const dir = path.join(stateDir, 'events');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(eventLogFile(stateDir), events.map(e => JSON.stringify(e) + '\n').join(''));
  } catch {
    // fail-open: durability is best-effort, never blocks the caller
  }
}

// Append a single event (thin wrapper over appendEvents).
export function appendEvent(stateDir, event) {
  appendEvents(stateDir, [event]);
}

function parseLines(text, rows) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return rows;
}

function readRange(fd, start, end) {
  const buf = Buffer.alloc(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got === buf.length ? buf : buf.subarray(0, got);
}

// glmps-193: the log is append-only and large (53 MB, 175k rows on the live
// box), and a full re-parse cost ~250 ms of main-thread time per call, twice
// per GET /api/alerts. Rows parsed up to the last complete line are kept per
// file; a later call parses only the bytes appended since. The head and the
// bytes just before the cached offset are compared on every call, so a
// rewrite or truncation falls back to a full read.
const SIG = 256;
const parsedLogs = new Map(); // file -> { offset, rows, head, tail }

function loadRows(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { parsedLogs.delete(file); return []; }
  try {
    const size = fs.fstatSync(fd).size;
    let c = parsedLogs.get(file);
    if (c && !(size >= c.offset
      && readRange(fd, 0, c.head.length).equals(c.head)
      && readRange(fd, c.offset - c.tail.length, c.offset).equals(c.tail))) c = null;
    const start = c ? c.offset : 0;
    const rows = c ? c.rows : [];
    const chunk = readRange(fd, start, size);
    const cut = chunk.lastIndexOf(0x0a) + 1;
    parseLines(chunk.subarray(0, cut).toString('utf8'), rows);
    const offset = start + cut;
    parsedLogs.set(file, {
      offset, rows,
      head: c && c.head.length === SIG ? c.head : readRange(fd, 0, Math.min(SIG, offset)),
      tail: readRange(fd, Math.max(0, offset - SIG), offset),
    });
    // A trailing line with no newline yet is returned when it parses but never
    // cached, so a writer still mid-line is re-read next time.
    return cut < chunk.length ? parseLines(chunk.subarray(cut).toString('utf8'), rows.slice()) : rows;
  } finally {
    fs.closeSync(fd);
  }
}

// Read events back, optionally filtered by sessionId and/or since (ts).
// Tolerant of a missing file (returns []) and malformed lines (skipped).
// Returned rows are shared with the cache above: treat them as read-only.
export function readEvents(stateDir, { sessionId, since } = {}) {
  const rows = loadRows(eventLogFile(stateDir));
  const sinceMs = since === undefined ? undefined : tsToMs(since);
  return rows.filter(r =>
    (sessionId === undefined || r.sessionId === sessionId) &&
    (sinceMs === undefined || (tsToMs(r.ts) !== null && tsToMs(r.ts) > sinceMs))
  );
}
