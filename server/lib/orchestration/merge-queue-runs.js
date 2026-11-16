// server/lib/orchestration/merge-queue-runs.js
//
// F5 (card glmps-2-0-runtime-98): every merge-queue test run is recorded with
// its duration and how many `node --test` processes were running when it
// started, and a warning fires when the queue's headroom is going. The slide
// from 5 to 23 minutes on 2026-10-28 was visible only in devlogs.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { stateFile, readPathFor } from '../state-dir.js';

export const KEEP_RUNS = 50;
export const HEADROOM_WINDOW = 5;
export const HEADROOM_FRACTION = 0.5;

// Written under queue/; the old root file is still read for one release.
const RUNS_NAME = 'merge-queue-runs.json';
const fileOf = (stateDir) => stateFile(stateDir, 'queue', RUNS_NAME).path;

export function loadRuns(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(readPathFor(stateDir, 'queue', RUNS_NAME), 'utf8'));
    return Array.isArray(j?.runs) ? j.runs : [];
  } catch { return []; }
}

export function recordRun(stateDir, run) {
  const runs = [...loadRuns(stateDir), run].slice(-KEEP_RUNS);
  const f = fileOf(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ runs }, null, 2));
  fs.renameSync(tmp, f);
  return runs;
}

/** The record for one finished test job, or null when no tests ran. */
export function runRecord({ id, outcome, concurrentTests, ts }) {
  const t = outcome?.tests;
  if (!t || t.status === 'skipped' || !Number.isFinite(t.durationMs)) return null;
  return {
    ts, id, kind: outcome.kind, headSha: t.headSha ?? null,
    durationMs: t.durationMs, timeoutMs: Number.isFinite(t.timeoutMs) ? t.timeoutMs : null,
    concurrentTests: Number.isInteger(concurrentTests) ? concurrentTests : null,
    selection: t.selection?.mode ?? null,
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** A warning when the median of the last 5 runs passes half the ceiling. */
export function headroomAlerts(runs) {
  const recent = (Array.isArray(runs) ? runs : []).filter((r) => Number.isFinite(r?.durationMs) && Number.isFinite(r?.timeoutMs)).slice(-HEADROOM_WINDOW);
  if (recent.length < HEADROOM_WINDOW) return [];
  const med = median(recent.map((r) => r.durationMs));
  const ceiling = Math.min(...recent.map((r) => r.timeoutMs));
  if (med <= ceiling * HEADROOM_FRACTION) return [];
  const procs = recent.map((r) => r.concurrentTests).filter(Number.isInteger);
  const last = recent.at(-1);
  return [{
    source: 'merge-queue-headroom', severity: 'warn',
    title: `Merge queue test runs take a median ${Math.round(med / 60000)} min of the ${Math.round(ceiling / 60000)} min ceiling`,
    detail: `Median of the last ${recent.length} runs is ${Math.round(med / 1000)} s, past ${Math.round(HEADROOM_FRACTION * 100)}% of the ceiling.`
      + (procs.length ? ` node --test processes running when they started: ${procs.join(', ')}.` : '')
      + ' Look for full-suite runs outside the queue before more requests time out.',
    target: null, ts: last.ts,
  }];
}

const TEST_PROC_RE = /\bnode(?:\.exe)?["']?\s(?:.*\s)?--test(?:\s|$)/i;

/** How many command lines are a `node --test` run. */
export function countTestProcs(commandLines) {
  return String(commandLines ?? '').split(/\r?\n/).filter((l) => TEST_PROC_RE.test(l)).length;
}

/** Resolves the live count, or null when the process list cannot be read. */
export function defaultCountTestProcs({ timeoutMs = 15_000 } = {}) {
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"]]
    : ['ps', ['-eo', 'args']];
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : countTestProcs(stdout));
    });
  });
}
