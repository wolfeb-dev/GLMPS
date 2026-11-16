// server/lib/evaluation/memory-usage-store.js
//
// Durable per-fact usage aggregate for memory files: how often each memory
// .md is actually read, and how much OPPORTUNITY it has had to be read.
// Feeds memory-evict.js, which needs both to rank cold facts fairly.
//
// Why a separate aggregate instead of querying the event log live
//
// event-log.js is append-only NDJSON and will eventually be rotated or
// truncated. Deriving counts from it on demand would silently reset the
// evidence at rotation, which directly defeats the design goal of
// accumulating for as long as possible before evicting anything. This file is
// small, bounded by the number of memory facts, and survives rotation.
//
// exposureSessions
//
// The key term. Reads alone cannot distinguish "written yesterday" from
// "ignored for months" - and on the real corpus the never-read set was
// dominated by the most RECENT memories, so a raw zero-read rule would
// preferentially evict the newest facts. exposureSessions counts the distinct
// memory-touching sessions observed at or after a fact's firstSeen, i.e. how
// many chances it actually had. A fact created yesterday scores ~1 and is
// therefore ranked behind long-ignored facts.

import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from '../observability/event-log.js';

const INDEX_FILE = 'MEMORY.md';

export function usageFile(stateDir) {
  return path.join(stateDir, 'memory', 'usage.json');
}

const EMPTY = () => ({ watermark: 0, facts: {} });

/** Read the aggregate. Fails open to an empty aggregate on any I/O or parse error. */
export function readUsage(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageFile(stateDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return EMPTY();
    return {
      watermark: Number.isFinite(parsed.watermark) ? parsed.watermark : 0,
      facts: parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {},
    };
  } catch {
    return EMPTY();
  }
}

function writeUsage(stateDir, usage) {
  try {
    const file = usageFile(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Fail open: telemetry must never break a caller.
  }
}

// Basename across both separators; adapters emit Windows paths on this box and
// POSIX paths on CI.
function basename(p) {
  const parts = String(p ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function tsToMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * Ingest every `kind:'memory'` event newer than the stored watermark, fold it
 * into the aggregate, advance the watermark, and persist.
 *
 * Idempotent: calling twice ingests nothing the second time.
 *
 * @returns {{ watermark: number, facts: Record<string, {
 *   reads:number, writes:number, firstSeen:number, lastRead:number|null,
 *   exposureSessions:number }> }}
 */
export function refreshUsage(stateDir) {
  const usage = readUsage(stateDir);
  const events = readEvents(stateDir, { since: usage.watermark })
    .filter((e) => e && e.kind === 'memory');

  // Session timestamps are needed to compute exposure, and exposure must be
  // recomputed for every fact on each pass (a session observed now raises the
  // exposure of every fact that already existed). Persisting the session
  // ledger keeps that correct across rotation.
  const sessions = usage.sessions && typeof usage.sessions === 'object' ? usage.sessions : {};

  let maxTs = usage.watermark;

  for (const e of events) {
    const ts = tsToMs(e.ts);
    if (ts === null) continue; // unparseable ts would corrupt the watermark
    if (ts > maxTs) maxTs = ts;

    const target = basename(e.path);
    if (!target || !target.toLowerCase().endsWith('.md')) continue;
    if (target === INDEX_FILE) continue; // the index is not a fact

    if (e.sessionId) {
      // earliest observation of each session, for exposure counting
      const prev = sessions[e.sessionId];
      if (prev === undefined || ts < prev) sessions[e.sessionId] = ts;
    }

    const f = usage.facts[target] || {
      reads: 0, writes: 0, firstSeen: ts, lastRead: null, exposureSessions: 0,
    };
    if (ts < f.firstSeen) f.firstSeen = ts;
    if (e.op === 'read') {
      f.reads += 1;
      if (f.lastRead === null || ts > f.lastRead) f.lastRead = ts;
    } else if (e.op === 'write') {
      f.writes += 1;
    }
    usage.facts[target] = f;
  }

  // Recompute exposure from the full session ledger: for each fact, how many
  // distinct memory-touching sessions occurred at or after it first appeared.
  const sessionStarts = Object.values(sessions);
  for (const f of Object.values(usage.facts)) {
    f.exposureSessions = sessionStarts.filter((s) => s >= f.firstSeen).length;
  }

  usage.sessions = sessions;
  usage.watermark = maxTs;
  writeUsage(stateDir, usage);
  return usage;
}
