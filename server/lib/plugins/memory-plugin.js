// server/lib/plugins/memory-plugin.js
//
// The memory loop on the Mem0 plugin (D23/D24 cutover, glmps-159 task 6).
// No fallback: a plugin failure throws, the caller (memory-distill-worker.js
// / the retry tick) queues the work; a health tracker passed in by the
// caller (optional - server.js's own registered loops track failures
// through the loop registry instead, K Task 6) can still surface a
// finer-grained alert (quarantine, dead-letter) for a caller that wants one.
//
// scan() is the poison-scan core (server/lib/governance/poison-scan.js,
// injected so this module has zero I/O of its own) and its REAL return shape
// is { clean, severity, flags, matches } -- NOT the { flagged } placeholder
// the original task brief sketched. isFlagged() below is the one place that
// shape is turned into a hold decision, for admission and for the
// memory-admission loop's checker alike.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { lookupFacts, DISTILLED_SUBDIR } from '../evaluation/memory-fault.js';
import { readEvents } from '../observability/event-log.js';
import { judgeSession, readVerdicts } from './judge-plugin.js';
import { quarantineDecision } from '../governance/poison-scan.js';

// Transcripts and extracted facts are external-trust content, so this applies
// the backlog gate's rule: a context-only flag (a link, an install command)
// never holds anything by itself. Treating clean === false as poisoned
// quarantined 295 of 317 runner transcripts for carrying a PR URL alone
// (glmps-2-0-runtime-96).
export function isFlagged(scanResult) {
  if (!scanResult || scanResult.clean !== false) return false;
  return quarantineDecision({ trust: 'external', severity: scanResult.severity, flags: scanResult.flags });
}

export function condensedToMessages(condensed) {
  const out = [];
  for (const block of String(condensed).split(/\n(?=(?:USER|ASSISTANT):)/)) {
    const m = block.match(/^(USER|ASSISTANT):\s*([\s\S]*)$/);
    if (m && m[2].trim()) out.push({ role: m[1] === 'USER' ? 'user' : 'assistant', content: m[2].trim() });
  }
  return out;
}

// Vendored Mem0 parses its own LLM response as JSON and, on a parse failure,
// logs to console and RESOLVES { results: [] } instead of rejecting
// (confirmed by probe against plugins/mem0/vendor/mem0ai's
// addToVectorStore). A genuine extraction failure (a garbled or truncated
// model response) then looks EXACTLY like "the model found nothing durable
// this session": admitSession reports success, health.ok('mem0')
// fires, and the delta is silently lost forever - never queued, never
// retried, never alerted. Mem0 DOES correctly propagate a chatCompletion
// call that itself REJECTS (also confirmed by probe: "LLM extraction
// failed: <message>" surfaces through memory.add()'s own rejection).
//
// This wraps any chatCompletion in that already-correct failure path:
// validate the response content is parseable JSON (after stripping a code
// fence, mirroring claude-model.js's own stripFences) BEFORE handing the
// response back to Mem0, and throw if it is not. Applied only to the copy
// of chatCompletion handed to mem0.configureHost (server.js) - the shared
// chatCompletion instance other plugins call through
// /api/plugins/model/v1/chat/completions is untouched, since they do not
// all expect JSON content.
function stripCodeFence(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : s;
}

export function wrapChatCompletionForMem0(chatCompletion) {
  return async (body) => {
    const res = await chatCompletion(body);
    const content = res && res.choices && res.choices[0] && res.choices[0].message
      ? res.choices[0].message.content
      : undefined;
    try {
      JSON.parse(stripCodeFence(content));
    } catch {
      throw new Error(`mem0 plugin: model returned non-JSON content (${String(content ?? '').slice(0, 120)})`);
    }
    return res;
  };
}

// "never silently drop poisoned content"
// (loop contract; pre-D23 invariant). A blocked transcript or a removed
// extracted fact used to be a bare no-op return value - no durable record,
// nothing an operator could ever review. Every such event is now appended to
// <stateDir>/plugins/mem0-quarantine.ndjson and reflected in a 'mem0-
// quarantine' health-tracker entry, a DIFFERENT key from the ordinary 'mem0'
// one so a later clean admission's health.ok('mem0') can never clear
// it - it clears only once the file itself is emptied (an operator action),
// recomputed from the file's actual line count on every admitSession call
// that has a stateDir (mirrors runRetryTick's dead-letter design, B2).
// stateDir/health are optional so the many admitSession unit tests
// that only care about the Mem0 call shape do not need to fake a filesystem.
const QUARANTINE_EXCERPT_MAX = 300;

function quarantineFile(stateDir) {
  return path.join(stateDir, 'plugins', 'mem0-quarantine.ndjson');
}

function appendQuarantine(stateDir, entry) {
  try {
    const file = quarantineFile(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort: the health alert below is the primary signal; a failure
    // to also persist the quarantine record must not throw out of admission.
  }
}

// exported so server.js's own kernel-health
// recompute (collectCurrentAlerts, alert-sources.js's kernelHealth param)
// can call it directly with a tiny array-collecting stand-in, the same way
// gepa-plugin.js's refreshGepaQuarantineHealth is already exported.
export function refreshQuarantineHealth(stateDir, health) {
  if (!stateDir || !health) return;
  let n = 0;
  try { n = fs.readFileSync(quarantineFile(stateDir), 'utf8').split('\n').filter(Boolean).length; } catch { /* no file yet */ }
  // this is RECOMPUTED from the
  // file's current line count on every call, not a genuinely repeated
  // distinct failure - fail()'s consecutive-increment would otherwise
  // escalate this to critical purely from repeated ticks over an unchanged
  // file. set() pins it at a deterministic warn level instead.
  if (n > 0) health.set('mem0-quarantine', { level: 'warn', reason: `${n} quarantined item(s); review ${quarantineFile(stateDir)}` });
  else health.ok('mem0-quarantine');
}

function quarantineReason(scanResult) {
  if (scanResult && Array.isArray(scanResult.flags) && scanResult.flags.length) return scanResult.flags.join(', ');
  return (scanResult && scanResult.severity) || 'flagged';
}

// The excerpt is the first 300 chars; what matched is usually further in, so
// without the samples a record cannot be reviewed. Samples are already masked
// for credentials by the scan itself.
function quarantineMatches(scanResult) {
  return ((scanResult && scanResult.matches) || []).map((m) => ({ code: m.code, sample: m.sample }));
}

// admitSession's `pendingRemovals`: a poisoned
// extracted memory whose `memory.remove()` call itself throws is no longer
// let bubble up and discard the whole admission result (that would make the
// worker treat a partially-successful add as a total failure and, worse,
// retry by calling memory.add() AGAIN with the same messages - Mem0's add is
// not idempotent, see migrateDistilled's ledger comment below, so a retried
// admission would duplicate every already-added fact, not just retry the
// removal). Instead the failed removal is reported in the result so the
// caller can queue a narrow `memory.remove` retry job instead.
// `written`: the facts genuinely LIVE in the
// store once this call returns - every add() result except one that was
// successfully removed. Exposed so a caller (the memory-admission loop's
// checker) can independently re-scan and re-search for exactly what is
// actually sitting in Mem0 right now, rather than trusting this function's
// own bookkeeping (pendingRemovals) as a self-report. A fact whose removal
// itself failed stays in `written` on purpose - it IS still live, and is
// exactly the case the checker most needs to catch.
// signal: an AbortSignal the caller aborts once
// its own run ceiling times out. Checked before the one real memory.add()
// call and before each memory.remove() attempt - the only two points where
// starting fresh, still-uncommitted work is actually avoidable; an add()
// or remove() already in flight cannot be cancelled mid-network-call, only
// not started in the first place.
// onAddReturned: called synchronously the instant
// memory.add() resolves, BEFORE this function goes on to await remove() for
// any poisoned fact. A caller whose own ceiling can fire in between (the
// memory-admission loop) must know add() already ran even though this
// function has not returned yet: Mem0's add() is not idempotent, so a retry
// decided in that window would duplicate every fact.
export async function admitSession({ memory, sessionId, project, condensed, scan, stateDir = null, health = null, now = Date.now, signal = null, onAddReturned = null }) {
  if (signal?.aborted) throw Object.assign(new Error('aborted before admission started'), { code: 'aborted' });
  const wholeScan = scan(condensed);
  if (isFlagged(wholeScan)) {
    if (stateDir) {
      appendQuarantine(stateDir, {
        ts: now(), sessionId, project, kind: 'blocked-transcript', reason: quarantineReason(wholeScan), matches: quarantineMatches(wholeScan),
        excerpt: String(condensed).slice(0, QUARANTINE_EXCERPT_MAX),
      });
      refreshQuarantineHealth(stateDir, health);
    }
    // addCalled: an authoritative report
    // of whether memory.add() actually ran - a caller that needs to know
    // this (plugin-adapters.js's realAdmit, to count Mem0's one real
    // extraction call) reads this field instead of re-deriving its own
    // copy of these two early-return gates, which could silently drift
    // from this function's own logic.
    return { added: 0, removed: 0, blocked: true, pendingRemovals: [], written: [], addCalled: false };
  }
  const messages = condensedToMessages(condensed);
  if (!messages.length) return { added: 0, removed: 0, blocked: false, pendingRemovals: [], written: [], addCalled: false };
  const r = await memory.add({ sessionId, project, messages });
  if (onAddReturned) onAddReturned();
  let removed = 0;
  const pendingRemovals = [];
  const written = [];
  for (const m of r.results || []) {
    const factScan = m.id ? scan(String(m.memory || '')) : null;
    if (m.id && isFlagged(factScan)) {
      if (stateDir) {
        appendQuarantine(stateDir, {
          ts: now(), sessionId, project, kind: 'removed-fact', reason: quarantineReason(factScan), matches: quarantineMatches(factScan),
          excerpt: String(m.memory || '').slice(0, QUARANTINE_EXCERPT_MAX),
        });
      }
      try {
        if (signal?.aborted) throw Object.assign(new Error('aborted before removal started'), { code: 'aborted' });
        await memory.remove({ id: m.id });
        removed++;
      } catch {
        pendingRemovals.push(m.id);
        written.push({ id: m.id, memory: m.memory });
      }
    } else {
      written.push({ id: m.id, memory: m.memory });
    }
  }
  if (stateDir) refreshQuarantineHealth(stateDir, health);
  return { added: (r.results || []).length, removed, blocked: false, pendingRemovals, written, addCalled: true };
}

// The project slug of a memory dir: the parent directory's basename. This is
// not a re-derivation of Claude Code's naming rule, it is a READ of the
// directory name Claude Code already wrote to disk -- the same value
// memory-distill-sweeper.js's sanitizeRoot()-verified convention produces,
// and the same one server/lib/paths.js's DEFAULT_MEMORY_DIR_NAME uses for
// this server's own project. Never null unless memoryDir itself is empty.
export function projectSlugFor(memoryDir) {
  if (!memoryDir) return null;
  const slug = path.basename(path.dirname(memoryDir));
  return slug || null;
}

// lookup() fuses the curated (file-based) tier with Mem0's tier by
// reciprocal rank (score = sum of 1/(60+rank+1) across the pools it appears
// in), curated winning ties. Mem0's search REQUIRES a project
// (plugins/mem0/adapter.js throws otherwise); when none is resolvable this
// skips the Mem0 half rather than pass null and surface a misleading plugin
// error -- the result says so via mem0Skipped instead of a silent empty
// result or a thrown error the caller cannot distinguish from a real outage.
//
// two changes from the original design.
//   - finding 5 (Mem0-hit half): every Mem0 hit is poison-scanned before it
//     is ever surfaced, dropping flagged ones. `scan` is now required for
//     the same reason it is required by admitSession - the caller (the
//     lookup route) always has one.
//   - finding 6: curated is not a fallback (D24 keeps it) - a Mem0 search
//     failure no longer throws out of lookup(), it is caught and reported
//     via `mem0Error` alongside the still-fully-populated curated hits. The
//     caller (the route) is expected to also call health.fail('mem0',
//     mem0Error) when it is non-null; lookup() itself stays health-agnostic,
//     matching admitSession's own division of labor (the plugin function
//     never owns health, its caller does).
export async function lookup({ memory, memoryDir, query, k = 5, project = null, curatedLookup = lookupFacts, scan }) {
  const curated = curatedLookup(memoryDir, query, { k, tier: 'curated' });
  if (!project) {
    return { hits: curated.slice(0, k), mem0Skipped: true, mem0Error: null };
  }
  let mem = [];
  let mem0Error = null;
  try {
    const searchResult = await memory.search({ query, project, k });
    mem = (searchResult.results || [])
      .filter((m) => !isFlagged(scan(String(m.memory || ''))))
      .map((m) => ({
        target: `mem0:${m.id}`, title: String(m.memory || '').slice(0, 80), excerpt: String(m.memory || ''), tier: 'distilled',
      }));
  } catch (e) {
    mem0Error = e && e.message ? e.message : String(e);
  }
  const scored = new Map();
  const add = (list) => list.forEach((item, i) => {
    const p = scored.get(item.target);
    scored.set(item.target, { ...item, score: (p?.score || 0) + 1 / (60 + i + 1) });
  });
  add(curated); add(mem);
  const hits = [...scored.values()]
    .sort((a, b) => b.score - a.score || (a.tier === 'curated' ? -1 : 1))
    .slice(0, k);
  return { hits, mem0Skipped: false, mem0Error };
}


// Reads <memoryDir>/distilled/*.md (the pre-D23 L3 pool), strips
// frontmatter, and tags every fact with the ONE project this memoryDir
// belongs to (the whole distilled pool under one memoryDir is one project's
// data). Never throws: a missing/absent distilled dir just yields [].
export function readDistilledFacts(memoryDir) {
  const dir = path.join(memoryDir, DISTILLED_SUBDIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const project = projectSlugFor(memoryDir);
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const body = raw.replace(/^---[\s\S]*?\n---\s*/, '').trim();
    out.push({ project, body, file: name });
  }
  return out;
}

// the original migration reader only ever looked at
// ONE memoryDir (this server's own), so only this server's own project's
// distilled pool was ever migrated - every other project under the same
// claudeDir was silently skipped. This iterates every
// `<claudeDir>/projects/*/memory/distilled/*.md`, tagging each fact with
// ITS OWN project's slug (readDistilledFacts already does this correctly
// per-memoryDir; this just calls it once per project directory found).
export function readAllDistilledFacts(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    out.push(...readDistilledFacts(path.join(projectsDir, ent.name, 'memory')));
  }
  return out;
}

// infer:false add is NOT idempotent on Mem0's own
// side (confirmed by probe: two add() calls of identical text produce two
// distinct ids and a search then finds both) - the original doc comment's
// "Mem0 dedups identical text" claim was false, and re-running migration
// after a partial failure would have duplicated every already-imported
// fact. This keeps its own ledger, a flat file of
// sha256(project + '\n' + body) keys, one per successfully imported fact.
// A key already in the ledger is reported as `alreadyImported` and never
// re-sent to memory.add(). `ledgerFile` is optional (an in-memory-only Set
// when omitted) so the simpler poison/failure-counting unit tests do not
// need to manage a real file.
function ledgerKey(project, body) {
  return crypto.createHash('sha256').update(`${project}\n${body}`).digest('hex');
}

function readLedger(ledgerFile) {
  try {
    return new Set(fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function appendLedger(ledgerFile, key) {
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${key}\n`);
}

// Imports the pre-D23 distilled pool into Mem0 verbatim (infer: false --
// this is a migration of already-extracted facts, not a re-extraction).
// Safe to re-run: the ledger (above) makes re-sending an already-imported
// fact a no-op, and a poisoned fact is skipped every time rather than ever
// reaching memory.add. `firstError` (finding 8) records the first add()
// failure's message so a `failed > 0` result is diagnosable without
// re-running with extra logging.
export async function migrateDistilled({ memory, scan, readFacts, ledgerFile }) {
  const facts = readFacts();
  const ledger = ledgerFile ? readLedger(ledgerFile) : new Set();
  const r = {
    total: facts.length, imported: 0, alreadyImported: 0, skippedPoisoned: 0, failed: 0, firstError: null,
  };
  for (const f of facts) {
    if (isFlagged(scan(f.body))) { r.skippedPoisoned++; continue; }
    const key = ledgerKey(f.project, f.body);
    if (ledger.has(key)) { r.alreadyImported++; continue; }
    try {
      await memory.add({ project: f.project, messages: [{ role: 'user', content: f.body }], infer: false });
      r.imported++;
      if (ledgerFile) appendLedger(ledgerFile, key);
      ledger.add(key);
    } catch (e) {
      r.failed++;
      if (!r.firstError) r.firstError = e && e.message ? e.message : String(e);
    }
  }
  return r;
}


// runRetryTick and its dead-letter
// helpers (appendDeadLetter, countDeadLetterByKind) are deleted - the
// plugin-retry loop (server/lib/loops/plugin-loops.js) is the live retry
// drain now, with its own dead-letter write, named per-job reasons, and
// double-judge guard; this function certified behaviour the live path no
// longer has. Its still-valid assertions moved to plugin-loops.test.js
// (memory.remove handling, give-up + dead-letter, never-more-than-5) and
// plugin-adapters.test.js (a null judgePlugin fails clearly).
