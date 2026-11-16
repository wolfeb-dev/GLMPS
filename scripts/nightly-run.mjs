#!/usr/bin/env node
// scripts/nightly-run.mjs
//
// The nightly autonomous run (handoff Part A).
//
// An external standalone script (Windows Task Scheduler / cron), not a
// setInterval inside the server, with a stale-tolerant file lock, a dedup
// window, and defer-not-fail when the machine is busy.
//
// A3 is explicit that there is no autonomous merge in this phase, so the
// driver's dependency surface contains no merge and no push capability at
// all. That is the structural version of the rule: it cannot merge even if
// its logic were wrong, because nothing it can reach knows how to.
//
//   node scripts/nightly-run.mjs             normal run
//   node scripts/nightly-run.mjs --force     ignore the "already ran recently" guard
//   node scripts/nightly-run.mjs --dry-run   plan and gate, but file no PR
//
// Exit 0 on success OR a safe defer/skip/stop; non-zero only on a real error.
//
// runNightly() takes every side effect as an injected dependency so the whole
// decision flow is testable without spawning an agent, touching git, or
// calling GitHub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPaths, configFileFor } from '../server/lib/paths.js';
import { nightlyConfig, killSwitchEngaged } from '../server/lib/orchestration/nightly-config.js';
import {
  checkGuardrails,
  planRun,
  recordGateResult,
  summarizeRun,
  runCompletedPayload,
  proposeNextBacklog,
} from '../server/lib/orchestration/nightly-run.js';
import { emitSpineEvent, readSpineEvents, SPINE_KINDS } from '../server/lib/observability/spine.js';
import { filePr as filePrReal, prBody } from '../server/lib/orchestration/pr-file.js';
import { makeHttpExecItem } from '../server/lib/orchestration/nightly-exec.js';

const ACTOR = 'nightly-runner';
const DEFAULT_DEDUP_MS = 20 * 60 * 60 * 1000; // a second run the same night is a mistake, not a feature
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Run one night.
 *
 * @returns { status, ... } where status is one of:
 *   'deferred'  another run holds the lock (exit 0, try again tomorrow)
 *   'skipped'   a successful run happened inside the dedup window
 *   'stopped'   a guardrail refused before any work started
 *   'idle'      nothing eligible to do
 *   'completed' the run finished and reported
 *   'failed'    a hard stop mid-run (currently only the budget cap)
 */
export async function runNightly({
  stateDir,
  repoRoot,
  config,
  now = Date.now(),
  backlog = [],
  lock,
  lastRunTs = null,
  dedupMs = DEFAULT_DEDUP_MS,
  force = false,
  dryRun = false,
  execItem,
  filePr = filePrReal,
  log = () => {},
} = {}) {
  const cfg = config ?? nightlyConfig({});
  const emit = (kind, payload) => emitSpineEvent(stateDir, { kind, actor: ACTOR, payload, ts: new Date(now).toISOString() });

  // 1. Lock. A second concurrent run is not an error, it is a machine that
  //    woke up twice; defer quietly. Never release a lock this process did not
  //    take, or the run that DOES hold it loses its protection.
  if (lock && !lock.acquire()) {
    log('another nightly run holds the lock; deferring');
    return { status: 'deferred', reason: 'locked' };
  }

  try {
    // 2. Dedup.
    if (!force && lastRunTs != null && now - lastRunTs < dedupMs) {
      log(`a run completed ${Math.round((now - lastRunTs) / 3600000)}h ago; skipping`);
      return { status: 'skipped', reason: 'recent-run' };
    }

    // 3. Kill switch, BEFORE any event is emitted. A killed run must not even
    //    announce itself: run.started implies a run happened, and the operator
    //    asked for none.
    if (killSwitchEngaged(stateDir, cfg)) {
      log('kill switch engaged; not running');
      return { status: 'stopped', stop: 'kill-switch', reason: 'nightly disabled or kill file present' };
    }

    // 4. Plan. planRun applies the repo allowlist itself and reports why each
    //    candidate was skipped.
    const priorRuns = readSpineEvents(stateDir, { kind: SPINE_KINDS.RUN_COMPLETED });
    const plan = planRun({ backlog, config: cfg, now, priorRuns });
    if (plan.items.length === 0) {
      log(`nothing eligible tonight (${plan.skipped.length} candidate(s) skipped)`);
      return { status: 'idle', runId: plan.runId, skipped: plan.skipped };
    }

    emit(SPINE_KINDS.RUN_STARTED, { runId: plan.runId, trigger: force ? 'manual' : 'cron', backlogSnapshot: backlog.map((b) => b.id) });
    emit(SPINE_KINDS.RUN_PLANNED, { runId: plan.runId, taskGraph: plan.items.map((i) => i.id), estCost: plan.estCost, skipped: plan.skipped });

    const itemsDone = [];
    const itemsBlocked = [];
    const gateResults = [];
    const branches = [];
    const prs = [];
    const spend = { usd: 0, tokens: 0 };

    for (const item of plan.items) {
      let res;
      try {
        res = await execItem(item, { runId: plan.runId, stateDir, repoRoot });
      } catch (e) {
        // An item that dies is a blocked item, not a dead run. The other
        // items, and the report, still matter.
        log(`item ${item.id} failed: ${e?.message ?? e}`);
        itemsBlocked.push(item.id);
        continue;
      }

      if (res?.branch) branches.push(res.branch);
      spend.usd += Number(res?.spend?.usd) || 0;
      spend.tokens += Number(res?.spend?.tokens) || 0;

      // Every gate the item ran, including the ones it could not run. A gate
      // recorded as 'skipped' is the whole point of A1 step 4.
      for (const g of res?.gateResults ?? []) {
        recordGateResult(stateDir, { runId: plan.runId, gateName: g.gateName, status: g.status, details: g.details ?? null, lessonIds: g.lessonIds ?? [] });
        gateResults.push(g);
      }

      // 5. Budget, checked after each item so an overrun stops the NEXT item
      //    rather than being discovered at the end of the night.
      const guard = checkGuardrails({ config: cfg, stateDir, project: item.project, spendUsd: spend.usd, tokens: spend.tokens });
      if (!guard.ok && guard.stop === 'budget') {
        // Hard stop: no PR is filed. The work is not lost, it is named as a
        // partial artifact so a human can pick it up or clean it up.
        emit(SPINE_KINDS.RUN_FAILED, { runId: plan.runId, stage: 'budget', error: guard.reason, partialArtifacts: branches });
        log(`budget stop: ${guard.reason}`);
        return { status: 'failed', stage: 'budget', runId: plan.runId, reason: guard.reason, partialArtifacts: branches };
      }

      if (!res?.ok) { itemsBlocked.push(item.id); continue; }

      if (dryRun) { itemsDone.push(item.id); continue; }

      const pr = filePr({
        repo: repoRoot,
        branch: res.branch,
        title: `nightly ${plan.runId}: ${item.title ?? item.id}`,
        body: prBody({ runId: plan.runId, items: [item], gateResults: res.gateResults ?? [], spend }),
      });
      if (pr?.filed && pr.url) {
        prs.push({ url: pr.url });
        itemsDone.push(item.id);
      } else {
        // Work that exists but has no PR is not delivered. Calling it done
        // would make the autonomy metrics count an invisible change as a win.
        log(`PR filing failed for ${item.id}: ${pr?.reason ?? 'unknown'}`);
        itemsBlocked.push(item.id);
      }
    }

    const nextBacklogProposal = proposeNextBacklog({ skipped: plan.skipped });
    emit(SPINE_KINDS.RUN_COMPLETED, runCompletedPayload({
      runId: plan.runId, prs, itemsDone, itemsBlocked, gateResults, spend, nextBacklogProposal,
    }));
    emit(SPINE_KINDS.REVIEW_COMPLETED, summarizeRun({
      runId: plan.runId, items: plan.items, prs, gateResults, spend, blockers: itemsBlocked, skipped: plan.skipped,
    }));

    log(`nightly ${plan.runId}: ${itemsDone.length} done, ${itemsBlocked.length} blocked, ${prs.length} PR(s)`);
    return { status: 'completed', runId: plan.runId, itemsDone, itemsBlocked, prs, gateResults, spend };
  } finally {
    lock?.release?.();
  }
}

// Real-world wiring (only when run as a script)

// Maps runNightly()'s own status to the process exit code main() reports
// through both channels: the OS exit code, and (below) the kernel's
// nightly-run external loop. 'failed' (currently only the budget hard stop)
// is the one status that is a real error per this file's own module
// docstring; every other status -- including the safe defers and skips -- is
// a normal night and exits 0.
export function nightlyExitCode(out) {
  return out?.status === 'failed' ? 1 : 0;
}

// Reports the run's outcome to the kernel's external nightly-run loop (K Task
// 5) so its SLA (currently 36h) has something to check against. Fail-soft:
// the kernel being unreachable must never change the exit code the caller
// already decided, only be logged. Returns what happened so the run log can
// say whether the kernel actually heard about the night.
export async function reportNightlyOutcome(exitCode, { port = process.env.GLMPS_PORT || 8123, fetchImpl = fetch, timeoutMs = 5000, reason = null, error = console.error } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/loops/nightly-run/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exitCode === 0 ? { outcome: 'done' } : { outcome: 'failed', reason: reason || `exit ${exitCode}` }),
      // Same bound as the backlog fetch: same-host does not mean
      // same-liveness -- a wedged kernel process can accept the connection
      // and never answer it. Without this, a stuck report call would hang
      // past the already-decided exit code forever.
      signal: AbortSignal.timeout(timeoutMs),
    });
    // glmps-194: a rejected report (404 after a route change, 401, 500) used
    // to look exactly like a delivered one.
    if (!res?.ok) error(`nightly-run: the kernel rejected the outcome report: HTTP ${res?.status}`);
    return { ok: Boolean(res?.ok), status: res?.status ?? null };
  } catch (e) {
    error(`nightly-run: could not report to the kernel: ${e?.message || e}`);
    return { ok: false, error: String(e?.message || e) };
  }
}

// glmps-2-0-112: one 5 s miss used to skip the whole night as a silent exit 0
// with no report, which surfaced only as a freshness expiry 36h later. A busy
// kernel gets a few minutes to answer; a non-2xx counts as a miss too, since
// planning against an empty backlog would look like an idle night.
export async function fetchQueuedBacklog({ port = process.env.GLMPS_PORT || 8123, fetchImpl = fetch, attempts = 3, delayMs = 90_000, timeoutMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let reason = 'dashboard unreachable';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/backlog?status=queued`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, items: (await res.json()).items ?? [] };
      reason = `dashboard unreachable: HTTP ${res.status}`;
    } catch (e) {
      reason = `dashboard unreachable: ${e?.name === 'TimeoutError' ? 'timeout' : (e?.message || e)}`;
    }
  }
  return { ok: false, reason: `${reason} (${attempts} attempts)` };
}

// Task Scheduler keeps no stdout, so this line is the only after-the-fact
// record of why a night ended the way it did.
export function appendNightlyLog(stateDir, entry, { now = Date.now(), error = console.error, file = 'runs.ndjson' } = {}) {
  try {
    const dir = path.join(stateDir, 'nightly');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, file), JSON.stringify({ ts: new Date(now).toISOString(), ...entry }) + '\n');
  } catch (e) {
    error(`nightly-run: could not write the run log: ${e?.message || e}`);
  }
}

function fileLock(lockPath) {
  return {
    acquire() {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
      } catch { /* no lock present */ }
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, String(process.pid));
        return true;
      } catch { return false; }
    },
    release() { try { fs.unlinkSync(lockPath); } catch {} },
  };
}

// Every exit path goes through finish(): report first, so the log line can
// record whether the kernel heard about the night, then log, then return the
// exit code. Injected fetch/sleep/console keep it testable end to end.
export async function nightlyMain({
  stateDir,
  configFile = configFileFor({ env: process.env }),
  port = process.env.GLMPS_PORT || '8123',
  argv = process.argv,
  fetchImpl = fetch,
  sleep,
  console: con = console,
  now = Date.now(),
  runNightlyImpl = runNightly,
} = {}) {
  // Which config file was read goes on every log line: an unreadable file
  // resolves to the off-by-default config, and that once hid a wrong path as
  // "nightly disabled" for months (glmps-2-0-126).
  const configRead = { file: configFile };
  const finish = async (entry, exitCode, reason = null) => {
    const report = await reportNightlyOutcome(exitCode, { port, fetchImpl, reason, error: con.error });
    appendNightlyLog(stateDir, { ...entry, exitCode, report, config: configRead }, { now, error: con.error, file: 'run.log' });
    return exitCode;
  };

  try {
    const force = argv.includes('--force');
    const dryRun = argv.includes('--dry-run');

    let cfg;
    try {
      cfg = nightlyConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
    } catch (e) {
      configRead.error = String(e?.message ?? e);
      con.error(`nightly config not read from ${configFile}: ${configRead.error}; using defaults (disabled)`);
      cfg = nightlyConfig({});
    }

    // The dashboard is the source of truth for the backlog. Without it there
    // is nothing to plan against, and inventing a backlog would be worse than
    // skipping a night, so the night is skipped but reported as a failure.
    const fetched = await fetchQueuedBacklog({ port, fetchImpl, ...(sleep ? { sleep } : {}) });
    if (!fetched.ok) {
      con.log(`${fetched.reason}; no backlog to plan against`);
      return await finish({ status: 'failed', stage: 'backlog', reason: fetched.reason }, 1, fetched.reason);
    }
    const backlog = fetched.items;

    const priorCompleted = readSpineEvents(stateDir, { kind: SPINE_KINDS.RUN_COMPLETED });
    const lastRunTs = priorCompleted.length ? Date.parse(priorCompleted[priorCompleted.length - 1].ts) : null;

    const out = await runNightlyImpl({
      stateDir,
      repoRoot: process.cwd(),
      config: cfg,
      now,
      backlog,
      lock: fileLock(path.join(stateDir, 'nightly', 'run.lock')),
      lastRunTs: Number.isFinite(lastRunTs) ? lastRunTs : null,
      force,
      dryRun,
      // Executing an item means launching an agent session against it, which
      // this deliberately does NOT re-implement: the queue runner already owns
      // launching, worktree isolation, liveness and retry. makeHttpExecItem
      // drives that existing path over the runner's own endpoint, so there is
      // one launcher rather than two that drift apart.
      execItem: makeHttpExecItem({
        port,
        stateDir,
        timeoutMs: Number(process.env.GLMPS_NIGHTLY_ITEM_TIMEOUT_MS) || 60 * 60 * 1000,
      }),
      log: (m) => con.log(m),
    });

    con.log(JSON.stringify(out, null, 2));
    const exitCode = nightlyExitCode(out);
    return await finish({ status: out?.status, stage: out?.stage ?? null, reason: out?.reason ?? null, runId: out?.runId ?? null }, exitCode, out?.reason ?? null);
  } catch (e) {
    const msg = String(e?.message ?? e);
    con.error(msg);
    return await finish({ status: 'crashed', reason: msg }, 1, `crashed: ${msg}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  nightlyMain({ stateDir: getPaths(process.env).stateDir }).then((code) => process.exit(code));
}
