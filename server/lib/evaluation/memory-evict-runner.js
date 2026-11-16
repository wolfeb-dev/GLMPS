// server/lib/evaluation/memory-evict-runner.js
//
// I/O edge for memory-evict.js: parse MEMORY.md, decide which facts are
// pinned, apply the plan, and record what was evicted.
//
// The invariant that makes auto-eviction acceptable: THIS MODULE NEVER TOUCHES
// A BODY .md FILE. It removes index lines only. The fact itself stays on disk
// and stays greppable, and every removed line is recorded verbatim, so
// restoring one is mechanical rather than a rewrite.

import fs from 'node:fs';
import path from 'node:path';
import { evictionPlan, isPinned } from './memory-evict.js';
import { indexFooter, faultedTargets } from './memory-fault.js';
import { readProbes, scoreProbes, demotionAllowed } from './memory-probe.js';

const INDEX_FILE = 'MEMORY.md';

// The fault-signal footer (glmps-157). Matched so it can be replaced rather
// than stacked, and so parseIndex never mistakes it for an entry.
const FOOTER_RE = /^_\d+ older memor(?:y is|ies are) not listed above\./;

// The harness's own memory-compaction warning (built into Claude Code, not a
// hook we own and not configurable) uses a 25,000-byte read limit and starts
// nagging around 20,000. The default budget sits just under that warn line:
// it retains as much memory as possible without triggering the nag on every
// write. At ~127 bytes/line that is roughly 150 entries.
export const DEFAULT_INDEX_BUDGET = 19000;

export function budgetFromEnv(env = process.env) {
  const n = Number(env.GLMPS_MEMORY_INDEX_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INDEX_BUDGET;
}

export function evictedFile(stateDir) {
  return path.join(stateDir, 'memory', 'evicted.json');
}

// Index lines are `- [Human Title](slug.md) <sep> hook`. The separator may be
// a spaced hyphen (current) or an em/en dash (legacy lines predating the
// no-em-dash switch), so both are accepted on read.
const LINE_RE = new RegExp(
  `^- \\[([^\\]]+)\\]\\(([^)]+\\.md)\\)\\s*[${String.fromCharCode(0x2014, 0x2013)}-]\\s*(.*)$`,
);

/**
 * @returns {Array<{ i:number, target:string, line:string, hook:string, bytes:number }>}
 *   `bytes` includes the trailing newline, since that is the real context cost.
 */
export function parseIndex(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    out.push({
      i,
      target: m[2],
      line: lines[i],
      hook: m[3],
      bytes: Buffer.byteLength(`${lines[i]}\n`, 'utf8'),
    });
  }
  return out;
}

/**
 * Targets that must never be evicted. Checks the body file AND the index line:
 * a warning may live in either, and missing one would silently drop the fact
 * whose absence is most expensive. A body that cannot be read is treated as
 * unpinned rather than throwing, but note this fails OPEN - see runEviction,
 * which is the only caller and only ever drops index lines.
 */
export function pinnedTargets(memoryDir, entries, stateDir) {
  // A fact that was faulted back in is permanently pinned: the earlier
  // eviction was demonstrably wrong, and repeating it is how an evict/fault
  // loop thrashes. Second-chance, in CLOCK terms.
  const pinned = stateDir ? new Set(faultedTargets(stateDir)) : new Set();
  for (const e of entries) {
    if (isPinned(e.line)) { pinned.add(e.target); continue; }
    let body = '';
    try {
      body = fs.readFileSync(path.join(memoryDir, e.target), 'utf8');
    } catch {
      continue; // unreadable body: nothing to inspect
    }
    if (isPinned(body)) pinned.add(e.target);
  }
  return pinned;
}

// Distinct targets currently recorded as evicted. Deduped because a fact can
// be evicted, faulted back in, and evicted again; the footer must state how
// many facts are hidden, not how many eviction events occurred.
function readEvictedTargets(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(evictedFile(stateDir), 'utf8'));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((r) => r && r.target).filter(Boolean));
  } catch {
    return new Set();
  }
}

function appendEvicted(stateDir, rows) {
  if (!rows.length) return;
  try {
    const file = evictedFile(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prev = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) prev = parsed;
    } catch {
      // fresh or corrupt: start a new record rather than losing the eviction
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...prev, ...rows], null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Fail open: failing to RECORD an eviction must not also fail the
    // eviction, but see runEviction - the record is written BEFORE the index
    // is rewritten, so a failure here means nothing was lost either way.
  }
}

/**
 * Bring MEMORY.md under `budgetBytes` by dropping the coldest unpinned index
 * lines. Returns `{ evicted, indexBytes, entries }`; `evicted` is `[]` in the
 * steady state, which is the expected outcome while the index fits.
 *
 * `now` is injectable so tests stay deterministic.
 */
export function runEviction({ memoryDir, stateDir, budgetBytes, usage, now = Date.now }) {
  // Actuated gate for the recall-gated demotion path: demotion only proceeds
  // while the fault path is measurably finding facts. Checked FIRST, before
  // any plan is computed or applied, so a closed gate never touches the index.
  const gate = demotionAllowed(scoreProbes(memoryDir, readProbes(stateDir)));
  if (!gate.allowed) return { skipped: true, reason: gate.reason, evicted: [] };

  const indexPath = path.join(memoryDir, INDEX_FILE);
  let content;
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return { evicted: [], indexBytes: 0, entries: [] };
  }

  const entries = parseIndex(content);
  // Full-corpus body map so eviction's salience tie-break sees the
  // real inbound-link graph. It must cover EVERY index entry, not a subset:
  // inboundLinks derives its known-target set from Object.keys(bodies), so a
  // missing entry would make in-corpus links to it look dangling and undercount
  // its salience. An unreadable body is kept as '' - still a valid link target,
  // it just contributes no outbound links.
  const bodies = {};
  for (const e of entries) {
    try { bodies[e.target] = fs.readFileSync(path.join(memoryDir, e.target), 'utf8'); }
    catch { bodies[e.target] = ''; }
  }
  const plan = evictionPlan({
    entries,
    usage: usage || {},
    budgetBytes,
    pinned: pinnedTargets(memoryDir, entries, stateDir),
    bodies,
  });
  const indexBytes = Buffer.byteLength(content, 'utf8');
  if (!plan.length) return { evicted: [], indexBytes, entries };

  // Record first: if the rewrite then fails, we have the lines; if the record
  // fails, the rewrite has not happened yet.
  const at = now();
  appendEvicted(stateDir, plan.map((p) => ({
    target: p.target,
    line: p.line,
    reason: p.reason,
    reads: p.reads,
    exposureSessions: p.exposureSessions,
    evictedAt: at,
  })));

  const drop = new Set(plan.map((p) => p.target));
  const kept = String(content).split(/\r?\n/).filter((line) => {
    if (FOOTER_RE.test(line)) return false; // replaced below, never stacked
    const m = LINE_RE.exec(line);
    return !(m && drop.has(m[2]));
  });

  // The fault SIGNAL. Without it the model never learns that a fact it cannot
  // see might exist, and eviction becomes silent permanent loss. The count is
  // the cumulative eviction record, not just this run.
  const hidden = readEvictedTargets(stateDir).size;
  const footer = indexFooter(hidden);
  if (footer) {
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    kept.push('', footer, '');
  }

  const out = kept.join('\n');
  fs.writeFileSync(indexPath, out);
  return { evicted: plan, indexBytes: Buffer.byteLength(out, 'utf8'), entries, hidden };
}
