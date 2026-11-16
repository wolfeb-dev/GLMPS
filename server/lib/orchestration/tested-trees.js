// server/lib/orchestration/tested-trees.js
//
// The tested-tree record (dev/prod channels T3, card glmps-2-0-runtime-50,
// runtime spec docs/specs/2026-10-28-glmps-2-0-runtime-50-tested-tree-record.md).
// The merge queue tests a local merge of the PR head with its base; GitHub
// later writes its own merge commit. Recording the TREE sha of what was tested
// (not a commit sha, which differs between the two merges) lets the promotion
// script check that the tree it is about to deploy is one a suite passed on.
//
// Merge queue B-Lean (dd50673a) removed per-PR testing, so the writer is now
// the batched full run on each integration branch tip (main-suite.js; spec
// docs/specs/2026-10-31-glmps-2-0-runtime-50-tested-tree-from-main-suite.md).
// Promotion asks whether a commit is at or behind the last green tip.
//
// Append-only JSON lines in <stateDir>/ledgers/tested-trees.jsonl (the old
// root file is still read for one release), read by the server and by
// scripts/service/promote.mjs (T4), so a plain file rather than kernel.db.

import { stateFile, appendLedger, readLedgerText } from '../state-dir.js';

export const TESTED_TREES_FILE = 'tested-trees.jsonl';

export function testedTreesFile(stateDir) {
  return stateFile(stateDir, 'ledgers', TESTED_TREES_FILE).path;
}

const RECORDED = new Set(['pass', 'fail', 'skipped']);

/**
 * The record for one finished test run, or null when there is nothing a
 * promotion could rely on: no tree sha, or an outcome that ran no suite to a
 * verdict (held, conflict, executor or git error).
 */
export function testedTreeRecord({ id, mr, outcome, ts }) {
  const t = outcome?.tests;
  if (!t || !RECORDED.has(t.status)) return null;
  if (outcome.kind !== 'pass' && outcome.kind !== 'fail') return null;
  if (typeof t.treeSha !== 'string' || !t.treeSha) return null;
  return {
    ts,
    treeSha: t.treeSha,
    status: t.status,
    headSha: t.headSha ?? null,
    mergedBaseSha: t.mergedBaseSha ?? null,
    command: t.command ?? outcome.command ?? null,
    ...(t.durationMs != null ? { durationMs: t.durationMs } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
    repo: mr?.repo ?? null,
    number: mr?.number ?? null,
    base: mr?.base ?? null,
    cardId: id ?? null,
    flaky: !!t.flaky,
  };
}

/** Append one record. Returns false when given none. */
export function recordTestedTree(stateDir, record) {
  if (!record) return false;
  appendLedger(stateDir, TESTED_TREES_FILE, `${JSON.stringify(record)}\n`);
  return true;
}

/** Every record in file order. A torn last line (a crash mid-append) is skipped. */
export function readTestedTrees(stateDir) {
  const text = readLedgerText(stateDir, TESTED_TREES_FILE);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && (typeof r.treeSha === 'string' || typeof r.sha === 'string')) out.push(r);
    } catch { /* torn line */ }
  }
  return out;
}

/** The latest record for `treeSha`, or null. Latest wins so a later fail outranks an earlier pass. */
export function findTestedTree(stateDir, treeSha) {
  if (typeof treeSha !== 'string' || !treeSha) return null;
  const all = readTestedTrees(stateDir);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].treeSha === treeSha) return all[i];
  return null;
}

const VERDICTS = new Set(['pass', 'fail']);

/**
 * The record for one full run of an integration branch tip, or null when the
 * run reached no verdict (a timeout or error is retried, not recorded).
 * `status` mirrors `verdict` so the per-PR readers keep working.
 */
export function mainSuiteRecord({ target, sha, treeSha = null, run, ts }) {
  if (!VERDICTS.has(run?.result) || typeof sha !== 'string' || !sha) return null;
  return {
    ts,
    source: 'main-suite',
    sha,
    treeSha: typeof treeSha === 'string' && treeSha ? treeSha : null,
    verdict: run.result,
    status: run.result,
    repo: target?.repo ?? null,
    base: target?.base ?? null,
    key: target?.key ?? null,
    command: run.command ?? null,
    durationMs: run.durationMs ?? null,
  };
}

/** The latest green full run, for one integration key when given. */
export function lastGreenRecord(stateDir, { key } = {}) {
  const all = readTestedTrees(stateDir);
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i];
    if (r.source === 'main-suite' && r.verdict === 'pass' && r.sha && (!key || r.key === key)) return r;
  }
  return null;
}

/**
 * Is `sha` at or behind the last green full-run sha? `git(args, { cwd })`
 * resolves { status, stderr }. Resolves { ok, green, reason, error? }; any
 * answer git could not give is an error and never ok.
 */
export async function isAtOrBehindLastGreen({ stateDir, sha, key, git, cwd }) {
  if (typeof sha !== 'string' || !sha) return { ok: false, green: null, reason: 'no sha given' };
  if (sha.startsWith('-')) return { ok: false, green: null, error: true, reason: 'a sha cannot start with a dash' };
  const rec = lastGreenRecord(stateDir, { key });
  if (!rec) return { ok: false, green: null, reason: `no green full run on record${key ? ` for ${key}` : ''}` };
  let r;
  try { r = await git(['merge-base', '--is-ancestor', sha, rec.sha], { cwd }); }
  catch (e) { return { ok: false, green: rec.sha, error: true, reason: `git merge-base failed: ${String(e?.message ?? e)}` }; }
  if (r?.status === 0) return { ok: true, green: rec.sha, reason: `${sha} is at or behind the last green full run ${rec.sha} (${rec.ts})` };
  if (r?.status === 1) return { ok: false, green: rec.sha, reason: `${sha} is not at or behind the last green full run ${rec.sha}` };
  return { ok: false, green: rec.sha, error: true, reason: `git merge-base exited ${r?.status}: ${String(r?.stderr ?? '').trim().slice(0, 200)}` };
}
