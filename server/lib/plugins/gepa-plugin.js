// server/lib/plugins/gepa-plugin.js
//
// Guard proposer cutover: the GEPA plugin proposes Learned-guard
// rules into the existing learning queue (learning-store.js's upsertProposal),
// with provenance back to the recurring gap items it reflected on. It never
// writes a guard itself - guards land ONLY through landGuard
// (guard-lesson.js) after the operator's approval, exactly like every other
// source in the queue (ADR-0001). The pre-D23 template auto-proposer
// (learning-templates.js's TEMPLATES/guardForGap) and the headless-composer
// free-form proposer (learning-apply.js's buildIdeaApplyCommand) are deleted
// by this same task; this module is their replacement.
//
// The actual reflection happens out-of-process: `python
// plugins/gepa/propose_guards.py --in <input.json> --out <output.json>`,
// PYTHONPATH pointed at the vendored gepa package, talking to the in-process
// model plugin over modelUrl (must be http://127.0.0.1:<port>/... - the CLI
// refuses non-localhost). spawnImpl is injectable so this stays a pure unit
// test with no real subprocess (plugins/gepa/ ships in a separate worktree).
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { upsertProposal } from '../evaluation/learning-store.js';
import { scanText } from '../governance/poison-scan.js';

// a GEPA-proposed rule is model output,
// not operator-authored text - it goes through the SAME poison scan memory
// admission uses before ever reaching the learning queue, and is capped in
// length, exactly like any other untrusted text this repo ingests.
const RULE_MAX_CHARS = 300;

function gepaQuarantineFile(stateDir) {
  return path.join(stateDir, 'plugins', 'gepa-quarantine.ndjson');
}

// Best-effort, matching memory-plugin.js's admitSession quarantine (B3): the
// health alert below is the primary signal, a failure to also persist the
// record must not throw out of an already-terminal rejection.
function appendGepaQuarantine(stateDir, entry) {
  try {
    const file = gepaQuarantineFile(stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch { /* best-effort */ }
}

// Recomputed from the file's own line count on every run that has a
// stateDir + health, mirroring B2/B3's dead-letter/quarantine design:
// a DIFFERENT health key from the ordinary 'gepa' one, so a caller's own
// health.ok('gepa') on a successful run can never silently clear it -
// it clears only once the file itself is emptied (an operator action).
//
// exported so server.js can also
// call this once at boot (a scheduled GEPA run is opt-in and off by
// default, so a leftover non-empty file from a crash or a prior session
// could otherwise sit unreported indefinitely until an operator happened to
// trigger a run), in addition to runGepa calling it on every run below -
// like mem0-quarantine's own refresh, this must not depend on something
// having been freshly quarantined THIS run.
export function refreshGepaQuarantineHealth(stateDir, health) {
  if (!stateDir || !health) return;
  let n = 0;
  try { n = fs.readFileSync(gepaQuarantineFile(stateDir), 'utf8').split('\n').filter(Boolean).length; } catch { /* no file yet */ }
  // recomputed from the file every
  // run, not a genuinely repeated distinct failure - set() pins this at a
  // deterministic warn level instead of fail()'s consecutive-increment,
  // which would otherwise escalate to critical purely from repeated runs
  // over an unchanged quarantine file.
  if (n > 0) health.set('gepa-quarantine', { level: 'warn', reason: `${n} GEPA-proposed rule(s) rejected (poison-flagged or over length); review ${gepaQuarantineFile(stateDir)}` });
  else health.ok('gepa-quarantine');
}

// buildGepaInput({ state, seedGuards, modelUrl, models, maxMetricCalls,
//                   maxWallSeconds, maxFailures }) -> the CLI's --in payload
//
// Pending 'gap' items only (source: 'gap', status: 'pending') - GEPA
// reflects on recurring capability misses the operator has not yet decided,
// same input the template proposer used to consume. Highest `count` first
// (the most-recurring failures are the most worth a judge call), capped at
// maxFailures so the input never grows unbounded.

export function buildGepaInput({
  state, seedGuards, modelUrl, models, maxMetricCalls = 40, maxWallSeconds = 2400, maxFailures = 20,
}) {
  const failures = (state.items || [])
    .filter((i) => i.source === 'gap' && i.status === 'pending')
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, maxFailures)
    .map((i) => ({ itemId: i.id, code: i.code, title: i.title, body: i.body || '', count: i.count || 1 }));
  return { modelUrl, models, maxMetricCalls, maxWallSeconds, seedGuards: seedGuards || '', failures };
}

// A bounded tail of the child's stderr, kept for diagnosis when the process
// exits without a parseable --out file (a crash, a traceback, a
// killed-on-timeout process) or never starts at all (spawn error). Draining
// via 'data' as it arrives is what actually prevents the OS pipe from
// backing up - the 4 KB cap below only bounds how much of it we choose to
// keep in the reported health message, not how much we read.
const STDERR_TAIL_BYTES = 4096;

function tailNote(tail) {
  const trimmed = (tail || '').trim();
  return trimmed ? `: ${trimmed}` : '';
}

// The CLI strips a rule's leading "- " (propose_guards.py's bullets()
// captures only the text after the dash), so `newRules` entries arrive as
// bare text. Land them as a real bullet line - an un-normalized rule would
// commit a non-bullet line into '## Learned guards' the moment an operator
// approves it. Idempotent on an already-bulleted string.
//
// strips only ONE leading "- " (a single
// dash + whitespace) - not `-+` (one or more dashes), which silently ate
// extra leading dashes that were part of the rule's actual content (e.g. an
// em-dash-alternative "-- " emphasis). A rule that is empty or
// whitespace-only after stripping returns '' (never a bare "- " bullet with
// no content) - the caller skips it entirely.
export function normalizeRule(raw) {
  const stripped = String(raw ?? '').trim().replace(/^-\s+/, '').trim();
  return stripped ? `- ${stripped}` : '';
}

// Review Focus 5: a GEPA proposal with
// no traceable provenance must never land. The CLI's own `sourceItemIds` is
// `[f["itemId"] for f in failures]` (every failure it was actually handed) -
// so a trustworthy output's sourceItemIds is always non-empty and always a
// subset of the itemIds runGepa itself sent. Anything else (empty, or naming
// an id that was never sent) means the CLI's provenance cannot be trusted,
// and nothing gets ingested.
function validSourceItemIds(sourceItemIds, sentItemIds) {
  if (!Array.isArray(sourceItemIds) || sourceItemIds.length === 0) return false;
  const sent = new Set(sentItemIds);
  return sourceItemIds.every((id) => sent.has(id));
}

// runGepa({ repoRoot, stateDir, modelUrl, models, maxMetricCalls,
//           maxWallSeconds, readGuards, loadStore, saveStore, spawnImpl,
//           python, scriptPath, timeoutMs, now }) -> { ok, error, proposed }
//
// timeoutMs (default 45 min) is the OUTER Node-side bound regardless of the
// CLI's own internal maxWallSeconds budget (up to 3600s/60min) - a deliberate
// asymmetry (task instruction), not a bug: the outer bound exists to
// guarantee this process is never wedged open past 45 minutes even if the
// CLI's own budget accounting misbehaves. maxWallSeconds is clamped to at
// most `timeoutMs/1000 - 60` (floor 1s) so the CLI's own deadline always
// expires with a safety margin before the outer kill, giving it a real
// chance to write --out and exit cleanly instead of being killed mid-write.
//
// Cleanup: the in-<ts>.json/out-<ts>.json pair is swept at the START of the
// NEXT run (not right after writing), so at most one pair ever sits on disk -
// whichever run produced it. A successful run deletes its own pair once
// ingested (nothing left to diagnose). A failed run's pair is left in place,
// so "the last failed pair" is always exactly what a human finds when they
// go look, never a dogpile of every historical failure.

export async function runGepa({
  repoRoot, stateDir, modelUrl, models, maxMetricCalls, maxWallSeconds = 2400,
  readGuards, loadStore, saveStore, spawnImpl = nodeSpawn, python = 'python', scriptPath,
  timeoutMs = 45 * 60 * 1000, now = Date.now, scan = scanText, health = null,
}) {
  // recomputed unconditionally
  // before anything else in this run, so a leftover non-empty quarantine
  // file (from a prior crash, or from before an operator action cleared it)
  // is reflected regardless of how THIS run turns out - every early-return
  // failure path below (no-failures, timeout, spawn-error, bad output) still
  // passes through this first.
  refreshGepaQuarantineHealth(stateDir, health);
  const wallCap = Math.max(1, Math.floor(timeoutMs / 1000) - 60);
  const clampedWallSeconds = Math.min(maxWallSeconds, wallCap);
  const input = buildGepaInput({
    state: loadStore(), seedGuards: readGuards(), modelUrl, models, maxMetricCalls, maxWallSeconds: clampedWallSeconds,
  });
  if (!input.failures.length) return { ok: false, error: 'no-failures', proposed: 0 };
  const sentItemIds = input.failures.map((f) => f.itemId);

  const dir = path.join(stateDir, 'plugins', 'gepa');
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^(in|out)-\d+\.json$/.test(f)) fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* best-effort: a locked or already-gone file must not block this run */ }

  const ts = now();
  const inFile = path.join(dir, `in-${ts}.json`);
  const outFile = path.join(dir, `out-${ts}.json`);
  fs.writeFileSync(inFile, JSON.stringify(input));

  const pluginDir = path.join(repoRoot, 'plugins', 'gepa');
  const resolvedScript = scriptPath || path.join(pluginDir, 'propose_guards.py');

  let stderrTail = '';
  let spawnErrMessage = null;
  const { kind: exitKind, code: exitCode } = await new Promise((resolve) => {
    // -S disables Python's `site` module,
    // so no site-packages directory (whatever happens to be installed on the
    // box running the server) ever reaches sys.path - only PYTHONPATH's
    // vendored gepa copy below is importable. Without it, the vendored
    // gepa/core/engine.py's bare `try: from tqdm import tqdm` would silently
    // pick up a real site-packages tqdm if one happens to be installed, a
    // D24 breach (zero runtime dependencies) that is machine-dependent.
    const child = spawnImpl(python, ['-S', resolvedScript, '--in', inFile, '--out', outFile], {
      cwd: repoRoot, windowsHide: true,
      // stdout: gepa's engine loop prints a lot of progress output via its
      // StdOutLogger; an unread pipe backs up at the OS buffer size and
      // blocks the child until the outer timeout kills it. 'ignore' removes the pipe entirely, so there is no
      // buffer to fill. stderr stays piped - drained into a bounded tail
      // below, never left to accumulate unread either.
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PYTHONPATH: path.join(pluginDir, 'vendor', 'gepa') },
    });
    let settled = false;
    const finish = (kind, code) => { if (settled) return; settled = true; clearTimeout(t); resolve({ kind, code }); };
    child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES); });
    const t = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish('timeout', null); }, timeoutMs);
    t.unref?.(); // never keep the process alive on this timer alone
    child.on('close', (c) => finish('exit', c));
    child.on('error', (e) => { spawnErrMessage = e && e.message ? e.message : String(e); finish('spawn-error', null); });
  });

  if (exitKind === 'timeout') return { ok: false, error: `gepa-timeout${tailNote(stderrTail)}`, proposed: 0 };
  if (exitKind === 'spawn-error') return { ok: false, error: `spawn-error: ${spawnErrMessage}${tailNote(stderrTail)}`, proposed: 0 };

  let out;
  try { out = JSON.parse(fs.readFileSync(outFile, 'utf8')); }
  catch { return { ok: false, error: `gepa-exit-${exitCode}${tailNote(stderrTail)}`, proposed: 0 }; }
  if (!out.ok) return { ok: false, error: out.error || 'gepa-failed', proposed: 0 };

  if (!validSourceItemIds(out.sourceItemIds, sentItemIds)) {
    return {
      ok: false,
      error: `gepa output has untrustworthy provenance: sourceItemIds ${JSON.stringify(out.sourceItemIds)} is empty or not a subset of the failures sent`,
      proposed: 0,
    };
  }

  let state = loadStore();
  let proposed = 0;
  for (const raw of out.newRules || []) {
    const rule = normalizeRule(raw);
    if (!rule) continue; // empty after normalization - not a real rule, nothing to flag
    // a rule over the length cap, or one
    // the same poison scan memory admission uses flags, is never ingested -
    // it is quarantined instead (recorded, never silently dropped), so an
    // operator cannot approve a proposal they never had a chance to see was
    // flagged.
    if (rule.length > RULE_MAX_CHARS) {
      appendGepaQuarantine(stateDir, {
        ts: now(), kind: 'rejected-rule', reason: `rule exceeds ${RULE_MAX_CHARS} char cap`,
        excerpt: rule.slice(0, RULE_MAX_CHARS), sourceItemIds: out.sourceItemIds,
      });
      continue;
    }
    const scanResult = scan(rule);
    if (scanResult && scanResult.clean === false) {
      appendGepaQuarantine(stateDir, {
        ts: now(), kind: 'rejected-rule',
        reason: (scanResult.flags && scanResult.flags.length ? scanResult.flags.join(', ') : scanResult.severity) || 'flagged',
        excerpt: rule.slice(0, RULE_MAX_CHARS), sourceItemIds: out.sourceItemIds,
      });
      continue;
    }
    const r = upsertProposal(state, {
      source: 'gepa',
      title: `Proposed guard: ${rule.slice(0, 80)}`,
      body: `GEPA proposal from ${out.sourceItemIds.length} recurring failures (${out.metricCalls} judge calls).`,
      rule,
      sourceItemIds: out.sourceItemIds,
      now: now(),
    });
    state = r.state;
    if (r.created) proposed++;
  }
  saveStore(state);
  // Unconditional (not gated on quarantinedAny from THIS run alone): a run
  // that quarantined nothing new must still reflect the file's current
  // total, e.g. if a concurrent process or an earlier run in the same
  // process already added entries this run's own loop never touched.
  refreshGepaQuarantineHealth(stateDir, health);

  // Success: nothing left to diagnose, so the pair is cleaned up immediately
  // rather than waiting for the next run to sweep it.
  try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch { /* best-effort */ }

  return { ok: true, error: null, proposed };
}
