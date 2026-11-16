// taps/tap-spool.js
// The tap's on-disk spool (server-and-client-tap task 9): append-only NDJSON
// segments under the tap folder, one line per record {seq, kind, ts, payload}.
// The sequence is per client and monotonic; acked.json holds the server's
// high-water mark, and a segment whose every record is at or below it is
// deleted. Past the cap only status snapshots, heartbeats and budgets are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { KIND_RE, TAP_INGEST_MAX_BYTES } from '../server/lib/kernel/tap-ingest.js';

export const SEGMENT_BYTES = 8 * 1024 * 1024;
export const SPOOL_CAP_BYTES = 2 * 1024 * 1024 * 1024;
// Superseded by the next one, so losing one past the cap loses nothing lasting.
export const DROPPABLE_KINDS = new Set(['status', 'heartbeat', 'budget']);
// Room left in one ingest body for the envelope around a single record.
export const RECORD_MAX_BYTES = TAP_INGEST_MAX_BYTES - 4096;

const SEG_RE = /^seg-(\d+)\.ndjson$/;
const ACKED_FILE = 'acked.json';

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && Number.isSafeInteger(r.seq)) out.push(r);
  }
  return out;
}

export function openSpool({ dir, cap = SPOOL_CAP_BYTES, segmentBytes = SEGMENT_BYTES, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true });
  const ackedPath = path.join(dir, ACKED_FILE);
  const writeAcked = (v) => {
    const tmp = `${ackedPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ acked: v }));
    fs.renameSync(tmp, ackedPath);
  };

  let segments = fs.readdirSync(dir).map((f) => SEG_RE.exec(f)).filter(Boolean)
    .map((m) => ({ file: path.join(dir, m[0]), firstSeq: Number(m[1]), bytes: fs.statSync(path.join(dir, m[0])).size }))
    .sort((a, b) => a.firstSeq - b.firstSeq);

  let acked = null;
  try { const v = JSON.parse(fs.readFileSync(ackedPath, 'utf8')).acked; if (Number.isSafeInteger(v)) acked = v; } catch { acked = null; }
  let lastSeq = null;
  // A torn last line means the next append must not continue that file.
  let activeWritable = true;
  if (segments.length) {
    const last = segments.at(-1);
    const text = fs.readFileSync(last.file, 'utf8');
    const recs = parseLines(text);
    lastSeq = recs.length ? recs.at(-1).seq : last.firstSeq - 1;
    activeWritable = text.length === 0 || text.endsWith('\n');
  }
  if (acked === null) {
    // Seeded from the clock, not 1: the server's mark survives re-pairing, so a
    // lost spool restarting at 1 would have every new record dropped as a replay.
    acked = segments.length ? segments[0].firstSeq - 1 : now() * 1000 - 1;
    writeAcked(acked);
  }
  if (lastSeq === null || lastSeq < acked) lastSeq = acked;

  let totalBytes = segments.reduce((n, s) => n + s.bytes, 0);
  let droppedPending = 0;

  function append(kind, payload) {
    if (typeof kind !== 'string' || !KIND_RE.test(kind)) throw new TypeError('kind must be 1 to 32 characters of a-z, 0-9 or -');
    if (payload === undefined) throw new TypeError('a payload is required (null is allowed)');
    const seq = lastSeq + 1;
    const line = `${JSON.stringify({ seq, kind, ts: now(), payload })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > RECORD_MAX_BYTES) throw new RangeError(`record too large to ship (${bytes} bytes, max ${RECORD_MAX_BYTES})`);
    if (totalBytes + bytes > cap && DROPPABLE_KINDS.has(kind)) { droppedPending++; return { dropped: true }; }
    let active = segments.at(-1);
    if (!active || !activeWritable || (active.bytes > 0 && active.bytes + bytes > segmentBytes)) {
      active = { file: path.join(dir, `seg-${seq}.ndjson`), firstSeq: seq, bytes: 0 };
      segments.push(active);
      activeWritable = true;
    }
    fs.appendFileSync(active.file, line);
    active.bytes += bytes; totalBytes += bytes; lastSeq = seq;
    return { seq };
  }

  /** Unacked records in sequence order, at least one when any is pending. */
  function readBatch({ maxBytes = TAP_INGEST_MAX_BYTES - 2048 } = {}) {
    const out = []; let used = 2;
    for (let i = 0; i < segments.length; i++) {
      const next = segments[i + 1];
      if (next && next.firstSeq - 1 <= acked) continue;
      let text;
      try { text = fs.readFileSync(segments[i].file, 'utf8'); } catch { continue; }
      for (const r of parseLines(text)) {
        if (r.seq <= acked) continue;
        const size = Buffer.byteLength(JSON.stringify(r)) + 1;
        if (out.length && used + size > maxBytes) return out;
        out.push(r); used += size;
      }
    }
    return out;
  }

  function ack(highWater) {
    if (!Number.isSafeInteger(highWater) || highWater <= acked) return;
    acked = highWater;
    if (lastSeq < acked) lastSeq = acked;
    writeAcked(acked);
    const keep = [];
    for (let i = 0; i < segments.length; i++) {
      const next = segments[i + 1];
      const segLast = next ? next.firstSeq - 1 : lastSeq;
      if (segLast <= acked) {
        try { fs.rmSync(segments[i].file, { force: true }); totalBytes -= segments[i].bytes; continue; } catch { /* kept, retried on the next ack */ }
      }
      keep.push(segments[i]);
    }
    segments = keep;
  }

  return {
    append, readBatch, ack,
    // The shipper reports drops to the server, then clears what it reported.
    reported: ({ dropped = 0 } = {}) => { droppedPending = Math.max(0, droppedPending - dropped); },
    stats: () => ({ depth: lastSeq - acked, bytes: totalBytes, full: totalBytes > cap || droppedPending > 0, dropped: droppedPending, acked, lastSeq }),
  };
}
