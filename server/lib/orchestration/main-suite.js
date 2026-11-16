// server/lib/orchestration/main-suite.js
//
// F6, second half (card glmps-2-0-runtime-98; spec:
// docs/specs/2026-10-29-merge-queue-affected-tests.md). The merge queue tests
// each PR with only the tests it affects, so the full suite runs here instead:
// once on each integration branch the queue merged into, after a batch of
// merges or nightly, while no request is testing. A red run is bisected over
// the first-parent merges since the last green tip, and the merge that broke
// it is filed as one card.
//
// Git and the test command are injected seams (the merge-tests shapes), so the
// planning is testable without a process.

import { affectedCommand } from './affected-tests.js';
import { short, resolveTestCommand } from './merge-util.js';
import { mainSuiteRecord } from './tested-trees.js';

// The batched reviewer's batch (batch-review.js reads it).
export const BATCH_MERGES = 5;
// Card glmps-2-0-173: one merge makes the full run due, so promotion has a
// green commit soon after a fix lands.
export const SUITE_BATCH_MERGES = 1;
export const NIGHTLY_MS = 20 * 60 * 60 * 1000;
export const MAX_BISECT_STEPS = 5;
// Card glmps-2-0-198: one loop cycle. A merged card that stays open holds the
// full run, and so the deploy, at most this long after its newest merge.
export const HOLD_WINDOW_MS = 30 * 60_000;

// Card glmps-2-0-215: a queue merge kicks this loop and the batch reviewer at
// the same moment, and both fetch the same checkout. The second ref update
// fails git's lock or compare-and-swap check, so a short retry is enough; any
// other failure (network, auth) is returned at once.
export const FETCH_ATTEMPTS = 3;
const REF_LOCK_RE = /cannot lock ref|\.lock'?: File exists|some local refs could not be updated/i;
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function fetchOrigin(git, cwd, { sleep = realSleep, attempts = FETCH_ATTEMPTS } = {}) {
  let r;
  for (let i = 1; i <= attempts; i++) {
    r = await git(['fetch', '-q', 'origin'], { cwd });
    if (r.status === 0 || i === attempts || !REF_LOCK_RE.test(String(r.stderr ?? ''))) return r;
    await sleep(500 * i + Math.floor(Math.random() * 250));
  }
  return r;
}

function releasedText(released) {
  const cap = released.filter((r) => r.why === 'cap').map((r) => r.id);
  const dep = released.filter((r) => r.why === 'deploy').map((r) => r.id);
  return [
    cap.length ? `${cap.join(', ')} released by the 30-minute cap` : '',
    dep.length ? `${dep.join(', ')} waiting only for its own deploy` : '',
  ].filter(Boolean).join('; ');
}

/**
 * { due, reason, heldBy? } for one integration branch. `openCards` are the ids
 * of still-open cards with a merge in the batch: the batch count waits for them
 * so the suite tests whole features (glmps-2-0-186), but the nightly backstop,
 * a red branch and a retry do not. `released` ({ id, why }) are open cards
 * with a merge in the batch that no longer hold (glmps-2-0-198), named in the
 * reason so the operator can see why the run went ahead.
 */
export function isDue({ rec, tip, mergesSince, nowMs, openCards = [], released = [] }) {
  if (!tip) return { due: false, reason: 'no tip' };
  if (!rec?.lastTestedSha) return { due: true, reason: 'no full run on record' };
  if (rec.retry) return { due: true, reason: `the last run ${rec.lastResult === 'timeout' ? 'timed out' : 'could not finish'}` };
  if (rec.lastTestedSha === tip) return { due: false, reason: 'tip already tested' };
  // The queue pauses merging into a red branch, so the merge that should fix it is checked at once.
  if (rec.red) return { due: true, reason: 'the branch is red and its tip moved' };
  const batchFull = Number.isFinite(mergesSince) && mergesSince >= SUITE_BATCH_MERGES;
  const freed = releasedText(released);
  const also = freed ? `; open card(s) ${freed}` : '';
  if (batchFull && !openCards.length) return { due: true, reason: `${mergesSince} merges since the last full run${also}` };
  const last = Date.parse(rec.lastRunTs ?? '');
  if (!Number.isFinite(last) || nowMs - last >= NIGHTLY_MS) return { due: true, reason: 'nightly' };
  if (batchFull) return { due: false, heldBy: [...openCards], reason: `${mergesSince} merge(s) since the last full run, held until open card(s) ${openCards.join(', ')} close${freed ? ` (${freed})` : ''}` };
  return { due: false, reason: `${mergesSince ?? 0} merge(s) since the last full run, under the batch of ${SUITE_BATCH_MERGES}` };
}

// A criterion counts as a deploy check only when it is phrased as one: a check
// made after or once the change is deployed, or on the live service. The bare
// word is not enough (card glmps-2-0-199): "a paused board starts no deploy" or
// "the live dashboard shows X" is code still to write. A miss costs at most the
// hold window; a false match frees a mid-feature card, so the list leans strict.
const DEPLOY_CHECKS = [
  /\b(?:after|once|post-?)\s*(?:the\s+|a\s+|its\s+|it\s+is\s+|it's\s+)?(?:first\s+|next\s+)?(?:real\s+)?(?:deploy|deployment|redeploy|deployed)\b/i,
  /\bonce\s+(?:it\s+is\s+|it's\s+)?live\b/i,
  /\b(?:is|are|was|were|been)\s+deployed\b/i,
  /\b(?:verified|confirmed|checked|smoke[- ]check(?:ed)?)\s+(?:on\s+the\s+)?live\b/i,
  /\blive\s+on\s+(?:8123|the\s+(?:live\s+)?(?:server|service|runtime))\b/i,
  /\b(?:on|against)\s+the\s+live\s+(?:server|service|runtime|instance|checkout)\b/i,
];
// "a test covers what happens after a deploy fails" is code, whatever it says.
const NAMES_A_TEST = /\b(?:a|new|unit|regression|integration|server-level)\s+tests?\b|\btests?\s+(?:covers?|pins?|proves?)\b/i;
export function isDeployCheck(text) {
  const t = String(text ?? '');
  return !NAMES_A_TEST.test(t) && DEPLOY_CHECKS.some((re) => re.test(t));
}

// glmps-2-0-198: merged, not yet live, and every criterion still open is a
// deploy or live check. Holding the run for it is a deadlock: promotion deploys
// only up to the last green full run.
function waitsOnlyForDeploy(c) {
  const m = c.mergeRequest;
  if (m.stage !== 'merged' || m.live) return false;
  const acs = c.acceptanceCriteria ?? [];
  const covered = new Set([...Object.keys(c.coverage ?? {}), ...(m.covers ?? [])].map(String));
  const open = acs.map((a, i) => ({ text: String(a?.text ?? ''), n: String(i + 1), done: a?.done === true }))
    .filter((a) => !a.done && !covered.has(a.n));
  return open.length > 0 && open.length < acs.length && open.every((a) => isDeployCheck(a.text));
}

function lastMergeMs(c) {
  const m = c.mergeRequest;
  const ts = [
    ...(m.history ?? []).filter((h) => h?.to === 'merged').map((h) => h.ts),
    m.mergedAt,
    ...Object.values(c.coverage ?? {}).map((v) => v?.at),
  ].map((t) => (typeof t === 'number' ? t : Date.parse(t ?? ''))).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : null;
}

/**
 * { holding, released } for still-open cards on integration branch `key` with
 * a merge in the batch (glmps-2-0-186). A card that re-filed after an interim
 * merge no longer carries that merge's sha and history entries carry none, so
 * its merged transition counts only when it is later than `sinceTs`, the last
 * full run's start: an older one was already tested and must not hold every
 * later batch until the nightly backstop (glmps-2-0-190). Of those, a card
 * holds only within HOLD_WINDOW_MS of its newest merge, and never while it
 * waits only for its own deploy (glmps-2-0-198); `released` names the rest.
 */
export function openCardsInBatch({ items, key, shas, sinceTs, keyOf, closedStates, nowMs = Date.now(), windowMs = HOLD_WINDOW_MS }) {
  const want = new Set(shas);
  const since = Date.parse(sinceTs ?? '');
  const inBatch = (items ?? []).filter((c) => {
    const m = c.mergeRequest;
    if (!m || closedStates.has(c.state) || keyOf(m) !== key) return false;
    if (m.mergeSha && want.has(m.mergeSha)) return true;
    if (Object.values(c.coverage ?? {}).some((v) => v?.mergeSha && want.has(v.mergeSha))) return true;
    if (m.stage === 'merged' || !Number.isFinite(since)) return false;
    return (m.history ?? []).some((h) => h?.to === 'merged' && Date.parse(h.ts ?? '') > since);
  });
  const holding = []; const released = [];
  for (const c of inBatch) {
    const at = lastMergeMs(c);
    if (waitsOnlyForDeploy(c)) released.push({ id: c.id, why: 'deploy' });
    else if (at == null || nowMs - at >= windowMs) released.push({ id: c.id, why: 'cap' });
    else holding.push(c.id);
  }
  return { holding, released };
}

/** The test files named as failing in node's spec or tap output. */
export function failingFiles(tail) {
  const out = new Set();
  for (const m of String(tail ?? '').matchAll(/test at (\S+?\.test\.[cm]?js):\d+:\d+/g)) out.add(m[1].replace(/\\/g, '/'));
  return [...out].sort();
}

/**
 * Binary search for the first red commit. `commits` are first-parent merges,
 * oldest first, after the last green tip; the last one is known red.
 * `probe(sha)` resolves 'pass', 'fail' or anything else (stop). Resolves
 * { culprit, good, bad, steps }; culprit is null when the steps ran out or a
 * probe could not decide.
 */
export async function bisect({ commits, good = null, probe, maxSteps = MAX_BISECT_STEPS }) {
  let lo = -1; let hi = commits.length - 1; let steps = 0;
  while (hi - lo > 1 && steps < maxSteps) {
    const mid = Math.floor((lo + hi) / 2);
    steps += 1;
    const r = await probe(commits[mid]);
    if (r === 'fail') hi = mid;
    else if (r === 'pass') lo = mid;
    else break;
  }
  const decided = hi - lo === 1 && (lo >= 0 || good);
  return { culprit: decided ? commits[hi] : null, good: lo >= 0 ? commits[lo] : good, bad: commits[hi], steps };
}

/**
 * The loop body. Seams: targets() -> [{ key, repo, base, project, repoPath }],
 * git(args, { cwd }), runTest({ command, cwd, timeoutMs }), readPkg(dir),
 * readState() / writeState(doc), queueBusy() (a request is testing),
 * fileCard({ project, title, prompt }), workDirFor(key), nowMs(), and
 * recordTree(record) for the tested-tree record (dev/prod T3), optional, and
 * openCardsFor({ target, shas }, { sinceTs }) -> ids of still-open cards with a
 * merge among those first-parent shas or after sinceTs (openCardsInBatch),
 * optional (no seam, no hold).
 */
/**
 * The loop's openCardsFor seam over a backlog: it forwards the loop's own
 * clock, so the hold window and the loop agree on now (card glmps-2-0-199).
 */
export function openCardsForBacklog({ loadItems, keyOf, closedStates }) {
  return ({ target, shas }, { sinceTs, nowMs } = {}) => openCardsInBatch({
    items: loadItems(), key: target.key, shas, sinceTs, keyOf, closedStates,
    ...(Number.isFinite(nowMs) ? { nowMs } : {}),
  });
}

export function createMainSuiteLoop({ targets, git, runTest, readPkg, readState, writeState, queueBusy, fileCard, workDirFor, nowMs = Date.now, timeoutMs, recordTree = null, openCardsFor = null, sleep = realSleep }) {
  const lines = (s) => String(s ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  async function runAt({ repoPath, workDir, sha, files = null }) {
    await git(['worktree', 'remove', '--force', workDir], { cwd: repoPath });
    await git(['worktree', 'prune'], { cwd: repoPath });
    const add = await git(['worktree', 'add', '--detach', workDir, sha], { cwd: repoPath });
    if (add.status !== 0) return { result: 'error', reason: `git worktree add failed: ${String(add.stderr).trim().slice(0, 200)}` };
    try {
      const pkg = readPkg(workDir);
      const { command: full, timeoutMs: ceiling } = resolveTestCommand({ pkg, override: timeoutMs ? { timeoutMs } : null });
      if (!full) return { result: 'skipped', reason: 'no test command' };
      const command = (files?.length && affectedCommand(pkg?.scripts?.test, files)) || full;
      const run = await runTest({ command, cwd: workDir, timeoutMs: ceiling });
      const result = run.timedOut ? 'timeout' : run.exitCode === 0 ? 'pass' : 'fail';
      return { result, tail: String(run.tail ?? ''), durationMs: run.durationMs ?? null, command };
    } catch (e) {
      return { result: 'error', reason: String(e?.message ?? e) };
    } finally {
      await git(['worktree', 'remove', '--force', workDir], { cwd: repoPath });
    }
  }

  // First-parent commits in range, oldest first, or null. Read with log, newest
  // first, then reversed: the desktop shell's allowlist has no rev-list and log
  // takes no --reverse there, and an installed shell is reinstalled on its own
  // cadence, so only argv every shell build allows (glmps-2-0-runtime-128, -130).
  async function firstParentSince(range, cwd) {
    const r = await git(['log', '--first-parent', '--format=%H', range], { cwd });
    return r.status === 0 ? lines(r.stdout).reverse() : null;
  }

  async function one(t, state) {
    const rec = state[t.key] ?? {};
    // Taken before the fetch, so a merge that lands mid-run is later than it.
    const startTs = new Date(nowMs()).toISOString();
    const fetched = await fetchOrigin(git, t.repoPath, { sleep });
    if (fetched.status !== 0) return { key: t.key, skipped: 'git fetch failed', failure: `${t.key}: git fetch failed: ${String(fetched.stderr).trim().slice(0, 200)}` };
    const tipR = await git(['rev-parse', `origin/${t.base}`], { cwd: t.repoPath });
    const tip = tipR.stdout.trim();
    let mergesSince = null;
    let openCards = [];
    let released = [];
    if (rec.lastTestedSha && rec.lastTestedSha !== tip) {
      const batch = await firstParentSince(`${rec.lastTestedSha}..${tip}`, t.repoPath);
      mergesSince = batch?.length ?? null;
      if (batch && mergesSince >= SUITE_BATCH_MERGES && openCardsFor) {
        const r = await openCardsFor({ target: t, shas: batch }, { sinceTs: rec.lastRunStartTs ?? rec.lastRunTs ?? null, nowMs: nowMs() });
        // A plain id list (the glmps-2-0-186 seam shape) is all holders.
        openCards = Array.isArray(r) ? r : (r?.holding ?? []);
        released = Array.isArray(r) ? [] : (r?.released ?? []);
      }
    }
    const due = isDue({ rec, tip, mergesSince, nowMs: nowMs(), openCards, released });
    if (!due.due) {
      const { held: _was, ...rest } = rec;
      state[t.key] = due.heldBy ? { ...rest, held: { by: due.heldBy, reason: due.reason, ts: new Date(nowMs()).toISOString() } } : rest;
      return { key: t.key, skipped: due.reason };
    }
    delete rec.held;

    const workDir = workDirFor(t.key);
    const run = await runAt({ repoPath: t.repoPath, workDir, sha: tip });
    const ts = new Date(nowMs()).toISOString();
    const next = { ...rec, lastDueReason: due.reason, lastRunStartTs: startTs, lastRunTs: ts, lastDurationMs: run.durationMs ?? null, lastResult: run.result, lastReason: run.reason ?? null };
    if (run.result === 'timeout' || run.result === 'error') {
      state[t.key] = { ...next, retry: true };
      return { key: t.key, ran: run.result, reason: due.reason };
    }
    next.retry = false;
    next.lastTestedSha = tip;
    if (run.result === 'skipped') {
      state[t.key] = { ...next, red: null };
      return { key: t.key, ran: 'skipped', reason: due.reason };
    }
    if (recordTree) {
      // A lost record only makes promotion rerun the suite, so it never fails the run.
      try {
        const tr = await git(['rev-parse', `${tip}^{tree}`], { cwd: t.repoPath });
        recordTree(mainSuiteRecord({ target: t, sha: tip, treeSha: tr.status === 0 ? tr.stdout.trim() : null, run, ts }));
      } catch { /* see above */ }
    }
    if (run.result === 'pass') {
      state[t.key] = { ...next, lastGreenSha: tip, red: null };
      return { key: t.key, ran: 'pass', reason: due.reason };
    }

    const files = failingFiles(run.tail);
    let commits = [];
    if (rec.lastGreenSha) {
      commits = (await firstParentSince(`${rec.lastGreenSha}..${tip}`, t.repoPath)) ?? [];
    }
    const found = commits.length
      ? await bisect({ commits, good: rec.lastGreenSha, probe: async (sha) => (await runAt({ repoPath: t.repoPath, workDir, sha, files })).result })
      : { culprit: null, good: rec.lastGreenSha ?? null, bad: tip, steps: 0 };
    let subject = '';
    if (found.culprit) {
      const s = await git(['log', '-n1', '--format=%s', found.culprit], { cwd: t.repoPath });
      subject = s.stdout.trim();
    }
    const red = { sha: tip, ts, files, culprit: found.culprit, subject, good: found.good, bad: found.bad, steps: found.steps };
    const where = found.culprit ? `${short(found.culprit)} (${subject})` : `${found.good ? short(found.good) : 'an unknown green'}..${short(found.bad)}`;
    const filed = fileCard({
      project: t.project,
      title: found.culprit ? `Full suite red on ${t.base}: ${subject || short(found.culprit)}` : `Full suite red on ${t.base} at ${short(tip)}`,
      prompt: `The merge queue's batched full-suite run on ${t.repo} ${t.base} failed at ${short(tip)} (${ts}). `
        + (found.culprit ? `Bisect over first-parent merges names ${where} as the first red merge.` : `Bisect could not name one merge; the break is in ${where}.`)
        + (files.length ? `\n\nFailing test files: ${files.join(', ')}` : '')
        + `\n\nOutput (tail):\n${run.tail.slice(-1500)}`,
    });
    // The card filed for this red may land its fix while the queue is paused.
    state[t.key] = { ...next, red: { ...red, cardId: filed?.item?.id ?? null } };
    return { key: t.key, ran: 'fail', culprit: found.culprit, reason: due.reason };
  }

  return {
    maker: async () => {
      if (queueBusy()) return { outcome: 'nothing-to-do' };
      const all = await targets();
      if (!all.length) return { outcome: 'nothing-to-do' };
      const state = readState() ?? {};
      const results = [];
      for (const t of all) {
        if (queueBusy()) break;
        results.push(await one(t, state));
      }
      writeState(state);
      // Thrown after the state write so another branch's run is still recorded; a quiet
      // skip would read nothing-to-do, and the registry never checks that.
      const failures = results.filter((r) => r.failure).map((r) => r.failure);
      if (failures.length) throw new Error(failures.join('; '));
      if (!results.some((r) => r.ran)) return { outcome: 'nothing-to-do' };
      return { outcome: 'done', result: { results, keys: results.filter((r) => r.ran).map((r) => r.key) } };
    },
    checker: async ({ results, keys }) => {
      const state = readState() ?? {};
      const missing = keys.filter((k) => !state[k]?.lastRunTs);
      if (missing.length) return { ok: false, reason: `no run recorded for ${missing.join(', ')}` };
      return { ok: true, verifierRef: `main-suite@${results.map((r) => `${r.key}:${r.ran ?? 'skip'}`).join(',')}` };
    },
  };
}

/** One alert per integration branch whose last full run is red. */
export function mainSuiteAlerts(state) {
  return Object.entries(state ?? {}).filter(([, r]) => r?.red).map(([key, r]) => ({
    source: 'main-suite', severity: 'error',
    title: `Full suite red on ${key}${r.red.culprit ? ` since ${short(r.red.culprit)}` : ''}`,
    detail: r.red.culprit ? `First red merge: ${r.red.subject || short(r.red.culprit)}.` : `Bisect could not name one merge (${r.red.good ? short(r.red.good) : '?'}..${short(r.red.bad)}).`,
    target: null, ts: r.red.ts,
  }));
}
