// server/lib/orchestration/merge-exec.js
//
// The merging stage of the GLMPS 2.0 merge queue (spec:
// docs/specs/2026-10-17-glmps2-merge-queue.md). Plain server code, never an
// agent: re-read the PR, check that the head being merged is the head that was
// tested, then `gh pr merge` pinned to that head. gh runs behind
// an injected seam, `gh(file, args)` returning { status, stdout, stderr } (or a
// promise of it). Fails closed: anything unexpected holds the request.

import { transition } from './merge-queue.js';
import { short, errText } from './merge-util.js';

const ghText = (r) => String(r?.stderr || r?.stdout || `exit ${r?.status}`).trim().slice(0, 300);

export function prMergeViewRecipe({ repo, number }) {
  return { file: 'gh', args: ['pr', 'view', String(number), '-R', repo, '--json', 'state,headRefOid,mergeable,baseRefName,mergeCommit'] };
}

// No --admin (it would bypass checks), no --auto, no --delete-branch: the
// operator has not asked for any of them.
export function prMergeRecipe({ repo, number, headSha }) {
  return { file: 'gh', args: ['pr', 'merge', String(number), '-R', repo, '--merge', '--match-head-commit', headSha] };
}

function parseView(stdout) {
  let j;
  try { j = JSON.parse(String(stdout ?? '')); } catch { return null; }
  if (!j || typeof j !== 'object' || typeof j.state !== 'string' || !j.state) return null;
  return {
    state: j.state,
    head: typeof j.headRefOid === 'string' ? j.headRefOid : null,
    mergeable: typeof j.mergeable === 'string' ? j.mergeable : null,
    base: typeof j.baseRefName === 'string' ? j.baseRefName : null,
    mergeSha: typeof j.mergeCommit?.oid === 'string' && j.mergeCommit.oid ? j.mergeCommit.oid : null,
  };
}

/**
 * Before a request takes the test slot (glmps-2-0-76): a PR already merged or
 * closed outside the queue resolves as { kind: 'merged', already } or
 * { kind: 'bounce' } instead of spending a test run and a review. Anything else,
 * including a gh failure, answers { kind: 'open' }: the tests go ahead as
 * before and runMerge checks the PR again before merging. Never throws.
 */
export async function precheckRequest({ mr, gh }) {
  let r;
  const view = prMergeViewRecipe(mr);
  try { r = await gh(view.file, view.args); } catch { return { kind: 'open' }; }
  if (!r || r.status !== 0) return { kind: 'open' };
  const pr = parseView(r.stdout);
  if (pr?.state === 'MERGED') return { kind: 'merged', mergeSha: pr.mergeSha, already: true };
  if (pr?.state === 'CLOSED') return { kind: 'bounce', reason: 'the PR was closed without merging' };
  return { kind: 'open' };
}

/**
 * A held or bounced request, re-read from GitHub (runtime-9-a). Resolves
 * { kind: 'merged', mergeSha, already, reconciled }, { kind: 'closed', reconciled },
 * { kind: 'open' } or { kind: 'unreadable', reason }. An unreadable PR is not
 * evidence of anything, so the caller leaves the request alone. Never throws.
 */
export async function reconcileRequest({ mr, gh }) {
  let r;
  const view = prMergeViewRecipe(mr);
  try { r = await gh(view.file, view.args); } catch (e) { return { kind: 'unreadable', reason: errText(e) }; }
  if (!r || r.status !== 0) return { kind: 'unreadable', reason: `gh pr view failed: ${ghText(r)}` };
  const pr = parseView(r.stdout);
  if (!pr) return { kind: 'unreadable', reason: 'gh pr view returned something unreadable' };
  if (pr.state === 'MERGED') return { kind: 'merged', mergeSha: pr.mergeSha, already: true, reconciled: true };
  if (pr.state === 'CLOSED') return { kind: 'closed', reconciled: true };
  return { kind: 'open' };
}

/**
 * Merge one approved request. Never throws. Resolves one of
 * { kind: 'merged', mergeSha, already?, readbackError? },
 * { kind: 'testing', reason } (new commits or a moved base need a retest),
 * { kind: 'bounce', reason } or { kind: 'hold', reason }.
 */
export async function runMerge({ mr, gh, currentBaseSha = null }) {
  const call = async (recipe) => {
    try { return (await gh(recipe.file, recipe.args)) ?? { status: 1, stderr: 'gh returned nothing' }; }
    catch (e) { return { status: 1, stdout: '', stderr: errText(e) }; }
  };
  const hold = (reason) => ({ kind: 'hold', reason });

  const first = await call(prMergeViewRecipe(mr));
  if (first.status !== 0) return hold(`gh pr view failed: ${ghText(first)}`);
  const pr = parseView(first.stdout);
  if (!pr) return hold('gh pr view returned something unreadable');

  if (pr.state === 'MERGED') return { kind: 'merged', mergeSha: pr.mergeSha, already: true };
  if (pr.state === 'CLOSED') return { kind: 'bounce', reason: 'the PR was closed without merging' };
  if (pr.state !== 'OPEN') return hold(`PR state is ${pr.state}`);
  if (pr.base !== mr.base) return hold(`PR base is ${pr.base ?? 'unknown'}, not ${mr.base}`);

  // glmps-2-0-runtime-125: only a tested head merges. A request with no test
  // run on record (one B-Lean moved straight to merging) is tested first.
  if (!mr.tests) return { kind: 'testing', reason: 'not tested by the queue yet; running its affected tests before merging' };
  const tested = mr.tests.headSha;
  if (!pr.head || !tested) {
    return hold(`cannot verify the head: PR ${short(pr.head) || 'unknown'}, tested ${short(tested) || 'unknown'}`);
  }
  if (pr.head !== tested) {
    return { kind: 'testing', reason: `head moved: PR ${short(pr.head)}, tested ${short(tested)}; new commits need new tests` };
  }
  // A moved base needs new tests (merge-queue.js contract). A record with no
  // mergedBaseSha has nothing to compare; the retest always stamps a fresh one,
  // so this cannot loop.
  // The tip comes from `currentBaseSha` (a fetch plus rev-parse of the remote
  // base in the local checkout): `gh pr view` baseRefOid is a snapshot from the
  // PR's last sync and cannot say the base has since moved.
  const testedBase = mr.tests?.mergedBaseSha;
  if (testedBase && currentBaseSha) {
    let baseSha = '';
    let why = '';
    try { baseSha = String((await currentBaseSha(mr)) ?? '').trim(); } catch (e) { why = `: ${errText(e)}`; }
    if (!/^[0-9a-f]{40}$/i.test(baseSha)) return hold(`cannot read the current base (${mr.base}) sha${why}`);
    if (baseSha !== testedBase) {
      return { kind: 'testing', reason: `base moved: ${mr.base} was ${short(testedBase)} when tested, now ${short(baseSha)}; new commits on the base need new tests` };
    }
  }
  if (pr.mergeable === 'CONFLICTING') {
    return { kind: 'testing', reason: `conflict: ${mr.base} moved and the PR no longer merges cleanly; retesting against the new base` };
  }

  const merged = await call(prMergeRecipe({ repo: mr.repo, number: mr.number, headSha: pr.head }));
  if (merged.status !== 0) return hold(`gh pr merge failed: ${ghText(merged)}`);

  const after = await call(prMergeViewRecipe(mr));
  const seen = after.status === 0 ? parseView(after.stdout) : null;
  if (!seen?.mergeSha) return { kind: 'merged', mergeSha: null, readbackError: after.status === 0 ? 'no merge commit in the response' : ghText(after) };
  return { kind: 'merged', mergeSha: seen.mergeSha };
}

/**
 * Fold a merge outcome into the request. Returns { mergeRequest, text }.
 * A bounce in the last round becomes a hold (the queue rule in transition()).
 */
export function applyMergeOutcome(mr, outcome, { now, queue, id } = {}) {
  const go = (to, reason, extra = {}) => {
    const r = transition({ ...mr, ...extra }, to, { now, reason, queue, id });
    if (r.error) return { mergeRequest: mr, text: `merge queue could not move to ${to}: ${r.error}`, error: r.error };
    return r;
  };
  if (outcome.kind === 'merged') {
    const why = outcome.reconciled ? 'reconciled from GitHub: the PR is merged' : outcome.already ? 'already merged on GitHub' : 'merged by the server';
    const r = go('merged', why, { mergeSha: outcome.mergeSha ?? null, mergedAt: now, ...(outcome.reconciled ? { mergedOutsideQueue: true, reconciled: true } : {}) });
    const sha = outcome.mergeSha ? `merge ${short(outcome.mergeSha)}` : `merge SHA unknown (${outcome.readbackError ?? 'not reported'})`;
    return { ...r, text: `${outcome.reconciled ? 'reconciled: GitHub reports' : ''} ${outcome.already ? 'already merged' : 'merged'} ${mr.repo}#${mr.number} into ${mr.base}: ${sha}`.trim() };
  }
  if (outcome.kind === 'closed') {
    const r = go('closed', 'reconciled from GitHub: the PR was closed without merging');
    return { ...r, text: `reconciled: GitHub reports ${mr.repo}#${mr.number} closed without merging; the request is closed` };
  }
  if (outcome.kind === 'testing') {
    const r = go('testing', outcome.reason, { review: null, reviewKind: null });
    if (r.mergeRequest?.stage === 'held') return { ...r, text: `${outcome.reason}; held, ${r.mergeRequest.history.at(-1).reason.split(':')[0]}` };
    return { ...r, text: `back to testing: ${outcome.reason}` };
  }
  if (outcome.kind === 'bounce') {
    const r = go('bounced', outcome.reason);
    return { ...r, text: `${outcome.reason}; ${r.mergeRequest?.stage === 'held' ? 'held, round cap reached' : 'bounced to the author'}` };
  }
  const r = go('held', outcome.reason);
  return { ...r, text: `merge held for the operator: ${outcome.reason}` };
}

export function mergeRecordText(mr) {
  const t = mr.tests ?? {};
  const v = mr.review ?? {};
  return [
    `merge record for ${mr.repo}#${mr.number}`,
    `PR: ${mr.prUrl}`,
    `head: ${mr.review?.headSha ?? mr.headSha}`,
    `merge: ${mr.mergeSha ?? 'unknown'}`,
    `tests: ${t.status ?? 'none'}${t.reason ? ` (${t.reason})` : ''}`,
    ...(mr.review ? [`reviewer: ${v.verdict ?? 'none'}${v.model ? ` (model ${v.model})` : ''}`] : []),
    ...afterMergeLines(v.findings),
  ].join('\n');
}

const AFTER_MERGE = /^AFTER MERGE:\s*/i;

function afterMergeLines(findings) {
  const open = (Array.isArray(findings) ? findings : []).filter((f) => AFTER_MERGE.test(String(f)));
  return open.length ? ['open checks after merge:', ...open.map((f) => `- ${String(f).replace(AFTER_MERGE, '')}`)] : [];
}

// A gate PASS must cite every AC by number or the store records it CONCERNS.
export function closeEvidence(acceptanceCriteria, mr) {
  const t = mr.tests ?? {};
  const how = `${mr.reconciled ? 'merged outside the queue and reconciled from GitHub, ' : ''}server tests ${t.status ?? 'none'}${mr.review ? `, reviewer ${mr.review.verdict ?? 'none'} (${mr.review.model ?? 'unknown model'})` : ''}, merge ${short(mr.mergeSha) || 'unknown'}`;
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  if (!acs.length) return [`merged via the merge queue: ${how}`];
  return acs.map((c, i) => `AC-${i + 1}: ${String(c?.text ?? c ?? '').slice(0, 200)} (approved in the merge record: ${how})`);
}

// A hand merge the queue never tested records a WAIVED gate (nothing was
// evaluated), not a PASS; it still closes the card.
export function closeGate(acceptanceCriteria, mr) {
  if (mr.reconciled || mr.mergedOutsideQueue) {
    return { status: 'WAIVED', evidence: ['merged outside the queue; not tested by the queue'] };
  }
  return { status: 'PASS', evidence: closeEvidence(acceptanceCriteria, mr) };
}

function mergedTs(mr) {
  const h = (mr?.history ?? []).filter((x) => x?.to === 'merged').at(-1);
  const t = Date.parse(h?.ts ?? mr?.mergedAt ?? '');
  return Number.isFinite(t) ? t : null;
}

/**
 * glmps-2-0-107: cards a covers merge kept open after their session had
 * already ended (idle since before the merge), so nobody saw the merge and the
 * open criteria never got worked. Requeueing one makes it queued, and its next
 * run ends with a later idleSince, so each merge resumes a card at most once.
 * `deployed(mr, mergeTs)` holds a card until its merge is live.
 */
export function strandedAfterMerge({ items = [], ledger = {}, deployed = () => true }) {
  const out = [];
  for (const card of items) {
    const mr = card?.mergeRequest;
    if (card?.state !== 'idle' || mr?.stage !== 'merged' || mr.interim || mr.final || mr.mergedOutsideQueue || !Array.isArray(mr.covers)) continue;
    if (ledger?.[card.id] || card.gate?.reintent) continue;
    const t = mergedTs(mr);
    const idle = Date.parse(card.idleSince ?? '');
    if (t == null || !Number.isFinite(idle) || idle > t) continue;
    const { close, open } = closeDecision({ acceptanceCriteria: card.acceptanceCriteria, coverage: card.coverage, mr });
    if (close || !open.length || !deployed(mr, t)) continue;
    out.push({ id: card.id, open, mr });
  }
  return out;
}

/**
 * Whether a merge closes its card (runtime-9-a). `coverage` is the card's
 * per-criterion record including this merge. final closes (unless interim, which never closes); otherwise a request
 * that declared covers closes once every criterion is covered; a request with
 * no covers closes. `open` lists the AC
 * numbers still uncovered.
 */
export function closeDecision({ acceptanceCriteria, coverage, mr, hosting = [] }) {
  const d = closeBeforeHosting({ acceptanceCriteria, coverage, mr });
  // glmps-2-0-171: a merge never closes a card that still hosts open cards.
  if (d.close && hosting.length) return { close: false, open: d.open, hosting: [...hosting] };
  return d;
}

function closeBeforeHosting({ acceptanceCriteria, coverage, mr }) {
  const total = Array.isArray(acceptanceCriteria) ? acceptanceCriteria.length : 0;
  const open = [];
  for (let n = 1; n <= total; n += 1) if (!coverage?.[n]) open.push(n);
  // interim always wins: it is one step of a card that continues.
  if (mr.interim) return { close: false, open };
  if (mr.final) return { close: true, open };
  if (Array.isArray(mr.covers)) return { close: open.length === 0, open };
  return { close: true, open };
}
