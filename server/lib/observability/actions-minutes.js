// server/lib/observability/actions-minutes.js
// GitHub Actions billed minutes for the current month, per repo and OS, from
// job start/end times (card glmps-2-0-73, docs/specs/2026-10-20-actions-minutes.md).
// The run timing API reports 0 billable on this plan and the account billing
// endpoint needs a gh scope the token lacks, so jobs are summed directly: each
// rounded up to the minute, Windows x2, macOS x10. A job with no steps never
// ran (the account refused it) and bills nothing.
//
// The same run listing carries each run's trigger and result, so a red nightly
// run surfaces here as an alert and one operator post. CI moved to nightly plus
// on demand in card glmps-2-0-134, so PRs have no checks and this is the only
// place a red run is seen (card glmps-2-0-runtime-132).
import fs from 'node:fs';
import path from 'node:path';
import { stateFile, readPathFor } from '../state-dir.js';

export const MULTIPLIER = { ubuntu: 1, windows: 2, macos: 10, other: 1 };
export const DEFAULT_ALLOWANCE = 2000;
export const DEFAULT_THRESHOLDS = [75, 90];

const OSES = ['ubuntu', 'windows', 'macos'];
const RED = new Set(['failure', 'timed_out', 'startup_failure']);

// Written under cache/; the old root file is still read for one release.
const MINUTES_NAME = 'actions-minutes.json';
export function actionsMinutesFile(stateDir) { return stateFile(stateDir, 'cache', MINUTES_NAME).path; }

// The GitHub billing cycle for this account is the UTC calendar month.
export function monthOf(ms) { return new Date(ms).toISOString().slice(0, 7); }

export function osOf(labels) {
  const s = (Array.isArray(labels) ? labels : []).join(' ').toLowerCase();
  return OSES.find((k) => s.includes(k)) ?? 'other';
}

export function jobMinutes(job) {
  const os = osOf(job?.labels);
  const ran = Number(job?.steps) > 0;
  const start = Date.parse(job?.started_at ?? '');
  const end = Date.parse(job?.completed_at ?? '');
  const minutes = ran && Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.ceil((end - start) / 60000) : 0;
  return { os, ran, minutes };
}

function normThresholds(t) {
  const list = (Array.isArray(t) ? t : DEFAULT_THRESHOLDS).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(list)].sort((a, b) => a - b);
}

export function summarize(doc, { allowance = DEFAULT_ALLOWANCE, now = Date.now() } = {}) {
  const month = doc?.month ?? monthOf(now);
  const allow = Number.isFinite(allowance) && allowance > 0 ? allowance : DEFAULT_ALLOWANCE;
  const repos = new Map();
  const byOs = {};
  let billed = 0;
  let lastRanAt = null;
  const refused = [];
  const nightlyLatest = new Map();
  for (const n of Array.isArray(doc?.nightlyCarry) ? doc.nightlyCarry : []) nightlyLatest.set(`${n.repo}
${n.workflow}`, n);
  for (const [key, run] of Object.entries(doc?.runs ?? {})) {
    if (run.event === 'schedule' && run.status === 'completed' && run.workflow) {
      const k = `${run.repo}\n${run.workflow}`;
      const cur = nightlyLatest.get(k);
      if (!cur || run.createdAt > cur.createdAt) {
        nightlyLatest.set(k, { repo: run.repo, workflow: run.workflow, runId: key.slice(key.lastIndexOf('#') + 1),
          createdAt: run.createdAt, conclusion: run.conclusion ?? null, branch: run.branch ?? null });
      }
    }
    for (const j of run.jobs ?? []) {
      if (!j.ran) { refused.push(run.createdAt); continue; }
      if (!lastRanAt || run.createdAt > lastRanAt) lastRanAt = run.createdAt;
      const b = j.minutes * (MULTIPLIER[j.os] ?? 1);
      billed += b;
      let r = repos.get(run.repo);
      if (!r) { r = { repo: run.repo, billed: 0, os: {} }; repos.set(run.repo, r); }
      r.billed += b;
      const o = (r.os[j.os] ??= { minutes: 0, billed: 0 });
      o.minutes += j.minutes; o.billed += b;
      const t = (byOs[j.os] ??= { minutes: 0, billed: 0, multiplier: MULTIPLIER[j.os] ?? 1 });
      t.minutes += j.minutes; t.billed += b;
    }
  }
  // Refusing now: a refused job created after the last job that ran. Once the
  // limit is raised and jobs run again, that episode is over.
  const refusedSince = refused.filter((at) => !lastRanAt || at > lastRanAt).sort()[0] ?? null;
  return {
    month, allowance: allow, billed, remaining: Math.max(0, allow - billed),
    usedPercent: Math.round((billed / allow) * 1000) / 10,
    byOs, byRepo: [...repos.values()].sort((a, b) => b.billed - a.billed),
    runs: Object.keys(doc?.runs ?? {}).length, lastRanAt, refusedSince,
    nightly: [...nightlyLatest.values()].sort((a, b) => `${a.repo} ${a.workflow}`.localeCompare(`${b.repo} ${b.workflow}`)),
    nightlyBlind: Array.isArray(doc?.nightlyBlind) ? doc.nightlyBlind : [],
    updatedTs: doc?.updatedTs ?? null, errors: doc?.errors ?? [],
  };
}

export function actionsMinutesFindings(summary, { thresholds = DEFAULT_THRESHOLDS } = {}) {
  if (!summary || !Number.isFinite(summary.usedPercent)) return [];
  const out = [];
  const list = normThresholds(thresholds);
  const crossed = list.filter((t) => summary.usedPercent >= t);
  if (crossed.length) {
    const threshold = crossed[crossed.length - 1];
    out.push({ kind: 'threshold', threshold, critical: threshold === list[list.length - 1] || summary.usedPercent >= 100,
      month: summary.month, usedPercent: summary.usedPercent, billed: summary.billed, allowance: summary.allowance });
  }
  if (summary.refusedSince) out.push({ kind: 'refused', month: summary.month, since: summary.refusedSince, billed: summary.billed, allowance: summary.allowance });
  for (const n of Array.isArray(summary.nightly) ? summary.nightly : []) {
    if (RED.has(n.conclusion)) out.push({ kind: 'nightly-red', ...n });
  }
  if (summary.nightlyBlind?.length) out.push({ kind: 'nightly-blind', month: summary.month, repos: summary.nightlyBlind });
  return out;
}

export function readActionsMinutesDoc(stateDir) {
  try { return JSON.parse(fs.readFileSync(readPathFor(stateDir, 'cache', MINUTES_NAME), 'utf-8')); } catch { return null; }
}

export function writeActionsMinutesDoc(stateDir, doc) {
  const file = actionsMinutesFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

// The run listing is per month, so at a month change the newest nightly result
// per workflow rides into the new month until a newer scheduled run replaces
// it. Only a result whose run was created in the closing month rides: one that
// was itself carried in had no scheduled run for a whole month (the workflow
// was deleted, renamed or unscheduled) and is dropped rather than alerted forever.
export function carryNightly(prev) {
  if (!prev) return [];
  return summarize(prev).nightly.filter((n) => typeof n.createdAt === 'string' && n.createdAt.slice(0, 7) === prev.month);
}

export function readActionsMinutes(stateDir, { allowance, now = Date.now() } = {}) {
  const doc = readActionsMinutesDoc(stateDir);
  // Last month's file answers an empty current month, not stale numbers. A
  // standing blind alert stays until the next refresh recomputes it.
  const cur = doc && doc.month === monthOf(now) ? doc
    : { month: monthOf(now), runs: {}, nightlyCarry: carryNightly(doc), nightlyBlind: doc?.nightlyBlind ?? [], updatedTs: doc?.updatedTs ?? null };
  return summarize(cur, { allowance, now });
}

// The exact gh calls. In service mode they run in the desktop shell, whose
// allowlist (apps/shell/src/lib/gitops-allow.js) accepts these shapes and no
// others, so change both together. Private repos only: public repos' Actions
// minutes are free.
export const GH_JQ = {
  repos: '.[] | select(.private) | .full_name',
  runs: '.workflow_runs[] | {id, created_at, status, event, conclusion, name, head_branch}',
  // A desktop app built before card glmps-2-0-runtime-132 allows only this one.
  runsLegacy: '.workflow_runs[] | {id, created_at, status}',
  jobs: '.jobs[] | {labels, started_at, completed_at, steps: (.steps | length)}',
};
export const ghArgs = {
  repos: () => ['api', '--paginate', 'user/repos?per_page=100&affiliation=owner', '--jq', GH_JQ.repos],
  runs: (repo, month) => ['api', '--paginate', `repos/${repo}/actions/runs?per_page=100&created=%3E%3D${month}-01`, '--jq', GH_JQ.runs],
  runsLegacy: (repo, month) => ['api', '--paginate', `repos/${repo}/actions/runs?per_page=100&created=%3E%3D${month}-01`, '--jq', GH_JQ.runsLegacy],
  // filter=all: a re-run attempt bills its own minutes too.
  jobs: (repo, id) => ['api', '--paginate', `repos/${repo}/actions/runs/${id}/jobs?per_page=100&filter=all`, '--jq', GH_JQ.jobs],
};

const ndjson = (stdout) => String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

async function ghOk(gh, args) {
  const r = await gh('gh', args);
  if (!r || r.status !== 0) throw new Error(String(r?.stderr || r?.stdout || `gh exit ${r?.status}`).trim().slice(0, 200));
  return r.stdout;
}

/**
 * One refresh. `gh(file, args)` answers { status, stdout, stderr } (or a
 * promise of it). Completed runs are cached by id, so a tick only fetches jobs
 * for runs it has not finished counting. Never throws; per-repo failures land
 * in `errors`.
 */
export async function refreshActionsMinutes({ prev = null, repos = [], gh, now = Date.now() }) {
  const month = monthOf(now);
  const runs = prev && prev.month === month ? { ...prev.runs } : {};
  const errors = [];
  const nightlyBlind = [];
  for (const repo of repos) {
    let list;
    try {
      list = ndjson(await ghOk(gh, ghArgs.runs(repo, month)));
    } catch (e) {
      // An older desktop shell refuses the wider filter: keep counting minutes
      // with the old one. Nightly results go unseen until the app is rebuilt
      // (or a transient failure passes), and that is an alert, not silence.
      try { list = ndjson(await ghOk(gh, ghArgs.runsLegacy(repo, month))); }
      catch { errors.push({ repo, error: e.message }); continue; }
      nightlyBlind.push({ repo, error: e.message });
    }
    for (const run of list) {
      const key = `${repo}#${run.id}`;
      const meta = run.event === undefined ? {}
        : { event: run.event ?? null, conclusion: run.conclusion ?? null, workflow: run.name ?? null, branch: run.head_branch ?? null };
      if (runs[key]?.status === 'completed') {
        // A run cached before its result was recorded gains it without a jobs refetch.
        if (runs[key].event === undefined && meta.event !== undefined) runs[key] = { ...runs[key], ...meta };
        continue;
      }
      try {
        const jobs = ndjson(await ghOk(gh, ghArgs.jobs(repo, run.id)));
        runs[key] = { repo, createdAt: run.created_at, status: run.status, ...meta, jobs: jobs.map(jobMinutes) };
      } catch (e) { errors.push({ repo, run: run.id, error: e.message }); }
    }
  }
  // A carried result keeps its posted key so it is not posted twice.
  const sameMonth = prev && prev.month === month;
  const nightlyCarry = sameMonth ? (prev.nightlyCarry ?? []) : carryNightly(prev);
  const carriedKeys = new Set(nightlyCarry.map((n) => `nightly-red:${n.repo}#${n.runId}`));
  const posted = sameMonth ? (prev.posted ?? []) : (prev?.posted ?? []).filter((k) => carriedKeys.has(k));
  return { month, runs, repos, errors, nightlyBlind, nightlyCarry, posted, updatedTs: now };
}

// Each threshold posts once a month, the refused episode once per start time,
// and a red nightly run once per run.
export function pendingPosts(doc, findings) {
  const done = new Set(doc?.posted ?? []);
  const out = [];
  for (const f of findings) {
    if (f.kind === 'nightly-blind') continue;
    const key = f.kind === 'threshold' ? `threshold:${f.threshold}`
      : f.kind === 'nightly-red' ? `nightly-red:${f.repo}#${f.runId}`
        : `refused:${f.since}`;
    if (done.has(key)) continue;
    const text = f.kind === 'threshold'
      ? `GitHub Actions minutes at ${f.usedPercent}% of the ${f.allowance}-minute monthly allowance (${f.billed} billed, ${f.month}).`
      : f.kind === 'nightly-red'
        ? `Nightly ${f.workflow} run on ${f.repo}${f.branch ? ` (${f.branch})` : ''} ended ${f.conclusion}: https://github.com/${f.repo}/actions/runs/${f.runId}`
        : `GitHub Actions is refusing jobs since ${f.since}: the account's monthly minutes or spending limit is used up (${f.billed} of ${f.allowance} billed, ${f.month}).`;
    out.push({ key, text });
  }
  return out;
}
