#!/usr/bin/env node
// One-time cleanup of the runner worktrees that piled up before outcomes were
// recorded. Applies the same rule as the runner reclaim and the sweeper: record
// what the worktree held on its card first, remove it only when the tree is
// clean and the head is pushed or merged, flag the rest.
//
// Dry run by default. Usage: node scripts/worktree-backfill.mjs [--apply]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getPaths } from '../server/lib/paths.js';
import { loadProfile } from '../server/lib/chassis/profile.js';
import * as backlogStore from '../server/lib/orchestration/backlog-store.js';
import * as runnerStore from '../server/lib/orchestration/runner-store.js';
import { FINISHED } from '../server/lib/orchestration/queue-runner.js';
import { safeSeg, worktreePruneRecipe } from '../server/lib/orchestration/worktrees.js';
import { worktreeRemoveSafeRecipe } from '../server/lib/orchestration/worktree-sweeper.js';
import { RECORDED_RETAIN_MS } from '../server/lib/scut/ticket-retention.js';
import {
  removalVerdict, outcomeRecord,
  gatherWorktreeFacts, integrationRefsFor,
} from '../server/lib/orchestration/worktree-outcome.js';

// A one-shot CLI, not the server: blocking here stalls no request, so the
// synchronous runner stays local to it instead of living in the server module.
function execGit(args, cwd) {
  try {
    const stdout = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 });
    return { status: 0, stdout };
  } catch (e) { return { status: typeof e?.status === 'number' ? e.status : 1, stdout: String(e?.stdout ?? '') }; }
}

const ACTIVE_SESSION_MS = 30 * 60_000;

function enteredMs(card) {
  for (const v of [card.stateEnteredAt, card.idleSince, card.doneAt]) {
    const t = typeof v === 'number' ? v : (typeof v === 'string' ? Date.parse(v) : NaN);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/**
 * Pure planner. entries: [{ id, dir, repo, branch, card, leased, liveSession, empty, facts }]
 * Existing protections come first (lease, live session, unfinished card, the
 * 3-day window), then the shared removal rule. An empty directory is the husk
 * of a worktree git already removed: nothing in it to record or lose. The record is written before any
 * removal on apply, so the plan assumes it is.
 * @returns { rows: [{ id, dir, action: 'remove'|'keep'|'flag', reason }], counts }
 */
export function planBackfill({ entries = [], now = Date.now() } = {}) {
  const rows = entries.map((e) => {
    const row = (action, reason) => ({ id: e.id, dir: e.dir, action, reason });
    if (e.leased) return row('keep', 'leased');
    if (e.liveSession) return row('keep', 'occupied');
    if (e.empty) return row('remove', 'empty-leftover');
    if (!e.branch) return row('keep', 'detached');
    if (!e.card) return row('flag', 'no-card');
    if (!FINISHED.has(e.card.state)) return row('keep', 'active-card');
    const entered = enteredMs(e.card);
    if (entered != null && now - Math.min(entered, now) < RECORDED_RETAIN_MS) return row('keep', 'within-retention');
    if (!e.repo) return row('flag', 'not-a-worktree');
    const v = removalVerdict({ facts: e.facts, written: true });
    return row(v.remove ? 'remove' : 'flag', v.reason);
  });
  const counts = { remove: 0, keep: 0, flag: 0 };
  for (const r of rows) counts[r.action]++;
  return { rows, counts };
}

export function formatPlan(plan, { apply }) {
  const lines = [apply ? 'APPLY: worktrees below were acted on.' : 'DRY RUN: nothing was changed. Re-run with --apply to act.'];
  for (const action of ['remove', 'flag', 'keep']) {
    const rows = plan.rows.filter((r) => r.action === action);
    if (!rows.length) continue;
    lines.push('', `${action} (${rows.length}):`);
    for (const r of rows) lines.push(`  ${r.id} ${r.reason}  ${r.dir}`);
  }
  const c = plan.counts;
  lines.push('', `Summary: remove ${c.remove}, keep ${c.keep}, flag ${c.flag}`);
  return lines.join('\n');
}

function liveSessionAt(projectsDir, dir, now) {
  const d = path.join(projectsDir, dir.replace(/[^A-Za-z0-9]/g, '-'));
  try {
    return fs.readdirSync(d).some((f) => f.endsWith('.jsonl') && now - fs.statSync(path.join(d, f)).mtimeMs < ACTIVE_SESSION_MS);
  } catch { return false; }
}

function repoOf(dir) {
  const r = execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  if (r.status !== 0) return null;
  const common = r.stdout.trim();
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}

function branchOf(dir) {
  const r = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const b = r.status === 0 ? r.stdout.trim() : '';
  return b && b !== 'HEAD' ? b : null;
}

function collect({ paths, now }) {
  const items = backlogStore.load(paths.stateDir).items;
  const ledger = runnerStore.loadLedger(paths.stateDir);
  const leasedIds = new Set(Object.keys(ledger).map(safeSeg));
  const entries = [];
  let projects = [];
  try { projects = fs.readdirSync(paths.worktreesDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* none */ }
  for (const p of projects) {
    for (const w of fs.readdirSync(path.join(paths.worktreesDir, p.name), { withFileTypes: true })) {
      if (!w.isDirectory()) continue;
      const dir = path.join(paths.worktreesDir, p.name, w.name);
      const empty = fs.readdirSync(dir).length === 0;
      const repo = empty ? null : repoOf(dir);
      const branch = repo ? branchOf(dir) : 'unknown';
      const card = items.find((i) => safeSeg(i.id) === w.name) ?? null;
      const facts = repo && branch && branch !== 'unknown'
        ? gatherWorktreeFacts({ dir, branch, git: execGit, integrationRefs: integrationRefsFor({ git: execGit, repo }) })
        : null;
      entries.push({
        id: card?.id ?? w.name, dir, repo, empty, branch: repo ? branch : 'unknown', card, facts,
        leased: leasedIds.has(w.name), liveSession: liveSessionAt(paths.projectsDir, dir, now),
      });
    }
  }
  return entries;
}

export function makeApi(baseUrl, fetchFn = fetch) {
  return {
    async reachable() {
      try { return (await fetchFn(`${baseUrl}/api/runner`)).ok; } catch { return false; }
    },
    async post(route, body) {
      const r = await fetchFn(baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
      return r.json();
    },
  };
}

async function applyPlan({ plan, entries, api }) {
  const byDir = new Map(entries.map((e) => [e.dir, e]));
  for (const row of plan.rows) {
    if (row.reason === 'empty-leftover') {
      try { fs.rmdirSync(row.dir); } catch { row.action = 'flag'; row.reason = 'rmdir-failed'; }
      continue;
    }
    if (row.action === 'keep' || row.reason === 'no-card' || row.reason === 'not-a-worktree') continue;
    const e = byDir.get(row.dir);
    const url = `/api/backlog/${encodeURIComponent(e.card.id)}/worktree-outcome`;
    const record = outcomeRecord(e.facts, e.card);
    try {
      await api.post(url, { action: 'record', dir: e.dir, repo: e.repo, record });
    } catch { row.action = 'flag'; row.reason = 'no-record'; continue; }
    if (row.action === 'flag') { try { await api.post(url, { action: 'kept', reason: row.reason }); } catch { /* the record is already on the card */ } continue; }
    try {
      const rm = worktreeRemoveSafeRecipe({ repo: e.repo, dir: e.dir });
      execFileSync(rm.file, rm.args, { stdio: 'ignore', windowsHide: true });
    } catch { row.action = 'flag'; row.reason = 'git-refused'; continue; }
    try { await api.post(url, { action: 'removed' }); } catch { /* the directory is gone either way */ }
    const pr = worktreePruneRecipe({ repo: e.repo });
    try { execFileSync(pr.file, pr.args, { stdio: 'ignore', windowsHide: true }); } catch { /* best effort */ }
  }
  plan.counts = { remove: 0, keep: 0, flag: 0 };
  for (const r of plan.rows) plan.counts[r.action]++;
}

export function runBackfill({ paths, apply = false, now = Date.now() }) {
  if (apply) throw new Error('applying goes through the running server: use applyBackfill');
  return planBackfill({ entries: collect({ paths, now }), now });
}

// Records on the cards through the live server's API (never the backlog file,
// which the server owns), so it refuses when the server cannot be reached.
export async function applyBackfill({ paths, api, now = Date.now() }) {
  if (!(await api.reachable())) throw new Error('the GLMPS server is not reachable; --apply records through its API, so start it (or pass --port) and retry');
  const entries = collect({ paths, now });
  const plan = planBackfill({ entries, now });
  await applyPlan({ plan, entries, api });
  return plan;
}

function configuredPort(argv) {
  const i = argv.indexOf('--port');
  if (i >= 0 && /^\d+$/.test(argv[i + 1] ?? '')) return Number(argv[i + 1]);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
    if (Number.isInteger(cfg?.port)) return cfg.port;
  } catch { /* no config.json: the server default */ }
  return 8123;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const apply = process.argv.includes('--apply');
  const profile = loadProfile({ cwd: process.cwd(), env: process.env, home: os.homedir() });
  const paths = getPaths(process.env, profile);
  try {
    const plan = apply
      ? await applyBackfill({ paths, api: makeApi(`http://127.0.0.1:${configuredPort(process.argv.slice(2))}`) })
      : runBackfill({ paths });
    console.log(formatPlan(plan, { apply }));
  } catch (e) { console.error(e.message); process.exit(1); }
}
