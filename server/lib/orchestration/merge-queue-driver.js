// The merge queue's engine (card glmps-2-0-220), moved line for line from
// startServer: the tick that walks every request, the precheck, test and merge
// jobs, the bounce back to the author, the close after a merge, the slower PR
// re-check of held and bounced requests, and the release hand-off. startServer
// creates one driver and passes in what it shares with the rest of the server;
// git and gh arrive as deps, so a test drives the whole path with fakes.
import * as backlogStore from './backlog-store.js';
import * as runnerStore from './runner-store.js';
import * as mergeQueue from './merge-queue.js';
import * as mergeUtil from './merge-util.js';
import * as mergeTests from './merge-tests.js';
import * as testedTrees from './tested-trees.js';
import * as mergeQueueRuns from './merge-queue-runs.js';
import * as mergeExec from './merge-exec.js';
import * as releaseVersion from './release-version.js';
import { openChildren } from './queue-runner.js';
import { testRealGitWriteRefused } from './test-write-guard.js';
import { classifyTask } from '../evaluation/task-classify.js';
import { reportMiss } from '../adapters/health.js';

export function createMergeQueueDriver(deps) {
  const {
    P, env, cfg, mergeJobs, runGh, runReviewGit, runMergeJobImpl, countQueueTestProcs, releaseRun,
    gitopsViaShell, gitopsBroker, shellSeams, mergeTestsRun, mainSuiteLoop, batchReviewLoop,
    checkoutFor, saveMergeRequest, mergeQueueMayRun, maintenanceHold, redFor, haltMergeQueue,
    broadcastBacklog, autoDeployTick, resumeStrandedTick, getScut,
  } = deps;

  // glmps-2-0-runtime-125: the testing stage, restored after B-Lean without the
  // per-PR reviewer. A pass goes to merging; the tick starts the merge.
  async function runMergeJob(id, mr) {
    const errorOutcome = (reason) => ({ kind: 'error', tests: { status: 'error', reason } });
    let outcome;
    // Counted alongside the job start, not before it: a slow process lister must not delay the run.
    const counting = Promise.resolve().then(countQueueTestProcs).catch(() => null);
    try {
      const { repoPath, override } = await checkoutFor(mr);
      if (!repoPath) outcome = errorOutcome(`no local checkout for ${mr.repo}`);
      else if (testRealGitWriteRefused(repoPath, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) {
        outcome = errorOutcome('refused: test process, checkout is not a temp fixture');
      } else {
        outcome = await runMergeJobImpl({
          id, mr, repoPath, workDir: mergeUtil.workDirFor(P.worktreesDir, id), override, extraTests: redFor(mr)?.files ?? [],
          ...(gitopsViaShell && !mergeTestsRun ? { git: shellSeams.git, runTest: shellSeams.runTest } : {}),
        });
      }
    } catch (e) { outcome = errorOutcome(e?.message ?? String(e)); }
    if (!outcome || typeof outcome.kind !== 'string') outcome = errorOutcome('test job returned no outcome');
    const concurrentTests = await counting;
    // Before the stage checks: what the suite said about this tree holds even if the request was moved meanwhile.
    try { testedTrees.recordTestedTree(P.stateDir, testedTrees.testedTreeRecord({ id, mr, outcome, ts: new Date().toISOString() })); }
    catch (e) { reportMiss('tested-tree-record', e?.message ?? String(e)); }
    try {
      const rec = mergeQueueRuns.runRecord({ id, outcome, concurrentTests, ts: new Date().toISOString() });
      if (rec) mergeQueueRuns.recordRun(P.stateDir, rec);
    } catch (e) { reportMiss('merge-queue-runs', e?.message ?? String(e)); }
    if (outcome.tests && concurrentTests != null) outcome = { ...outcome, tests: { ...outcome.tests, concurrentTests } };

    const items = backlogStore.load(P.stateDir).items;
    const cur = items.find((i) => i.id === id)?.mergeRequest;
    // The operator may have moved the request while the tests ran; do not overwrite that.
    if (!cur || cur.stage !== 'testing') return;
    if (!mergeQueueMayRun()) {
      // Paused mid-run: keep the result but never advance (no merge, no bounce).
      const held = mergeQueue.transition({ ...cur, tests: outcome.tests ?? cur.tests ?? null }, 'held', { now: new Date().toISOString(), reason: 'merge queue paused' });
      if (!held.error) saveMergeRequest(id, held.mergeRequest, `merge queue paused: test run finished (${outcome.tests?.status ?? outcome.kind}), result recorded, held for the operator`);
      return;
    }
    const r = mergeTests.applyOutcome(cur, outcome, { now: new Date().toISOString(), queue: items, id, red: redFor(cur) });
    saveMergeRequest(id, r.mergeRequest, r.text);
    if (!r.error && mergeQueue.isBounceExit(r.mergeRequest)) await returnBouncedCard(id);
  }

  function startMergeTestJob(id, running) {
    const job = runMergeJob(id, running)
      .catch((e) => reportMiss('merge-queue-job', `${id}: ${e?.message ?? String(e)}`))
      .finally(() => mergeJobs.delete(id));
    mergeJobs.set(id, job);
    return job;
  }

  // glmps-2-0-runtime-63: a headless author was released to idle when its run
  // ended, so a bounce reaches it only by putting the card back in the queue.
  // Reviewer findings keep their own path (requeueAuthor resumes the session).
  async function returnBouncedCard(id, { findings = null } = {}) {
    const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    const mr = card?.mergeRequest;
    if (!mr) return;
    const { maxRetries } = runnerStore.loadConfig(P.stateDir);
    const d = mergeQueue.bounceDisposition({ card, mr, maxRetries });
    if (d.action === 'hold') {
      backlogStore.updateItemIn(P.stateDir, id, { state: 'held' });
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text: `card held for the operator: ${d.reason}` });
    } else if (d.action === 'skip') {
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text: `not requeued: ${d.reason}` });
    } else {
      // glmps-2-0-runtime-91: a done card leaves done first, then takes the requeue path below.
      if (d.action === 'reopen') {
        const why = findings ? `reviewer findings: ${findings.join('; ').slice(0, 800)}` : (mr.history?.at(-1)?.reason ?? 'unknown');
        backlogStore.updateItemIn(P.stateDir, id, { state: 'queued' });
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text: `reopened: the card was done but ${mr.repo}#${mr.number} bounced and never landed (${why})` });
      }
      if (d.action === 'requeue' || d.action === 'reopen') {
        const note = mergeQueue.bounceNote(mr);
        backlogStore.setPendingReopenIn(P.stateDir, id, { note, source: 'merge-queue', reason: 'the merge queue bounced the pull request after the session ended' });
        backlogStore.applyLabelDeltaIn(P.stateDir, id, { labels: ['agent:backlog'] });
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text: `requeued for the author (bounce ${d.streak}, held after ${maxRetries} in a row): ${note}` });
      }
    }
    broadcastBacklog();
  }

  // glmps-2-0-45: the merging stage. The server runs the merge itself through
  // gh; no Claude session is involved. Resolves the request when it went back
  // to testing (the caller then starts the tests), else null.
  async function runMergeExec(id) {
    const cur = backlogStore.load(P.stateDir).items.find((i) => i.id === id)?.mergeRequest;
    if (!cur || cur.stage !== 'merging') return null;
    let outcome;
    // The last gate before the merge call: a pause that lands while gh is busy refuses the merge itself.
    const gh = (file, args) => (args[1] === 'merge' && !mergeQueueMayRun()
      ? { status: 1, stdout: '', stderr: 'merge queue paused before the merge was sent' }
      : runGh(file, args));
    // The live tip of the base branch, read from the local checkout. The tests
    // stamped the base they merged against; a different tip needs new tests.
    const currentBaseSha = async (req) => {
      const { repoPath } = await checkoutFor(req);
      if (!repoPath) throw new Error(`no local checkout for ${req.repo}`);
      const fetched = await runReviewGit(['fetch', '-q', 'origin'], { cwd: repoPath });
      if (fetched.status !== 0) throw new Error(`git fetch failed: ${String(fetched.stderr || '').trim().slice(0, 200)}`);
      const rev = await runReviewGit(['rev-parse', `origin/${req.base}`], { cwd: repoPath });
      if (rev.status !== 0) throw new Error(`git rev-parse origin/${req.base} failed: ${String(rev.stderr || '').trim().slice(0, 200)}`);
      return rev.stdout;
    };
    try { outcome = await mergeExec.runMerge({ mr: cur, gh, currentBaseSha }); }
    catch (e) { outcome = { kind: 'hold', reason: e?.message ?? String(e) }; }

    const items = backlogStore.load(P.stateDir).items;
    const now = items.find((i) => i.id === id)?.mergeRequest;
    // The operator may have moved the request while gh ran; do not overwrite that.
    if (!now || now.stage !== 'merging') return null;
    const r = mergeExec.applyMergeOutcome(now, outcome, { now: new Date().toISOString(), queue: items, id });
    saveMergeRequest(id, r.mergeRequest, r.text);
    if (r.error) return null;
    if (r.mergeRequest.stage === 'merged') closeMergedCard(id, r.mergeRequest);
    if (mergeQueue.isBounceExit(r.mergeRequest)) await returnBouncedCard(id);
    return r.mergeRequest.stage === 'testing' ? r.mergeRequest : null;
  }

  // glmps-2-0-209: one version bump, tag and GitHub Release per merged PR, made
  // by the desktop app's fixed release action (glmps-2-0-216): the kernel may
  // not push, and outside service mode there is no app to ask, so it skips.
  // The chain keeps two merges from racing in the one clone. A failure never
  // unmerges anything: it is a named miss plus a devlog line on the card.
  // The pending release sits in mergeJobs under a `release:` key (every other
  // consumer looks up card ids or counts entries), so the queue starts no test
  // or merge on the pre-release base while the version commit is about to move it.
  let releaseChain = Promise.resolve();
  let releaseSeq = 0;
  const runReleaseOp = releaseRun ?? (gitopsViaShell ? (op) => gitopsBroker.run(op) : null);
  const releasePending = () => [...mergeJobs.keys()].some((k) => String(k).startsWith('release:'));
  const settleReleases = () => Promise.allSettled([...mergeJobs].filter(([k]) => String(k).startsWith('release:')).map(([, v]) => v));
  function releaseMerged(id, mr) {
    if (mr.mergedOutsideQueue || mr.reconciled || !runReleaseOp) return;
    const key = `release:${id}:${(releaseSeq += 1)}`;
    releaseChain = releaseChain.then(async () => {
      const note = (text) => {
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text });
        getScut()?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
        broadcastBacklog();
      };
      try {
        const { repoPath } = await checkoutFor(mr);
        if (!repoPath || testRealGitWriteRefused(repoPath, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) return;
        const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
        const r = await releaseVersion.requestRelease({
          run: runReleaseOp, repoPath, mr,
          card: { id, summary: card?.gate?.summary },
          taskClass: classifyTask({ firstPrompt: card?.prompt ?? card?.title ?? '' }).taskClass,
        });
        if (r.skipped) return;
        if (r.ok) note(`released v${r.version}`);
        else { reportMiss('release-version', `${id}: ${r.reason}`); note(`release failed (the merge stands): ${r.reason}`); }
      } catch (e) { reportMiss('release-version', `${id}: ${e?.message ?? String(e)}`); }
    }).finally(() => mergeJobs.delete(key));
    mergeJobs.set(key, releaseChain);
  }

  // The merge record and the done close, both by the queue, never by the author.
  function closeMergedCard(id, mr) {
    releaseMerged(id, mr);
    // After the queue's jobs settle: the merge job that called this is still
    // one of them, and the run skips while any job is open (card glmps-2-0-176).
    if (mainSuiteLoop) void Promise.allSettled([...mergeJobs.values()]).then(() => mainSuiteLoop.runNow()).catch((e) => reportMiss('main-suite-kick', e?.message ?? String(e)));
    if (batchReviewLoop) void Promise.resolve().then(() => batchReviewLoop.runNow()).catch((e) => reportMiss('batch-review-kick', e?.message ?? String(e)));
    try {
      const text = mergeExec.mergeRecordText(mr);
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text });
      getScut()?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
      if (Array.isArray(mr.covers) && mr.covers.length) {
        backlogStore.recordCoverageIn(P.stateDir, id, { covers: mr.covers, prUrl: mr.prUrl, mergeSha: mr.mergeSha ?? null, at: mr.mergedAt ?? new Date().toISOString() });
      }
      const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
      const hosting = openChildren(id, backlogStore.load(P.stateDir).items).map((c) => c.id);
      const decision = mergeExec.closeDecision({ acceptanceCriteria: card?.acceptanceCriteria, coverage: card?.coverage, mr, hosting });
      // glmps-2-0-75: an interim PR is one step of a card that continues (a
      // spec waiting on the operator's answers). Closing it here released the
      // park and left the operator's reply with no session to reach.
      // runtime-9-a: a PR that declares covers keeps the card open until every
      // criterion has been covered by a merged PR, unless it was final.
      if (!decision.close) {
        const keep = decision.hosting
          ? `merge-queue: ${mr.repo}#${mr.number} merged; the card stays open while it hosts ${decision.hosting.join(', ')}`
          : Array.isArray(mr.covers)
          ? `merge-queue: ${mr.repo}#${mr.number} merged covering ${mr.covers.map((n) => `AC-${n}`).join(', ')}; still open: ${decision.open.map((n) => `AC-${n}`).join(', ')}; the card stays open`
          : `merge-queue: ${mr.repo}#${mr.number} merged as interim; the card stays open`;
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text: keep });
        getScut()?.agentSaid({ ticketId: id, kind: 'devlog', text: keep, by: 'agent' });
        broadcastBacklog();
        return;
      }
      // glmps-2-0-104: keep the agent's close summary and risk, which the
      // closing post in the main channel reads from this gate.
      const g = backlogStore.setGateIn(P.stateDir, id, { ...mergeExec.closeGate(card?.acceptanceCriteria, mr), summary: card?.gate?.summary, risk: card?.gate?.risk ?? null, by: 'merge-queue' });
      backlogStore.applyLabelDeltaIn(P.stateDir, id, { labels: ['agent:done'], comment: `merge-queue: ${mr.repo}#${mr.number} merged${mr.mergeSha ? ` (${mr.mergeSha.slice(0, 7)})` : ''}` });
      if (g.item) getScut()?.agentSaid({ ticketId: id, kind: 'gate', text: backlogStore.gateRelayText(g.item.gate), by: 'agent' });
      // After the gate relay, so the closing summary is the channel's last post.
      try { getScut()?.ticketStateChanged?.({ item: { id, state: 'done' } }); } catch { /* the close reconciler retries */ }
      broadcastBacklog();
    } catch (e) { reportMiss('merge-queue-close', `${id}: ${e?.message ?? String(e)}`); }
  }

  function startMergeExecJob(id) {
    const job = runMergeExec(id)
      .catch((e) => { reportMiss('merge-queue-merge', `${id}: ${e?.message ?? String(e)}`); return null; })
      .finally(() => mergeJobs.delete(id));
    mergeJobs.set(id, job);
    // A retest waits for the release this merge started: it must run on the post-release base.
    return job.then(async (retest) => {
      await settleReleases();
      return retest && mergeQueueMayRun() && !maintenanceHold() ? startMergeTestJob(id, retest) : undefined;
    });
  }

  // glmps-2-0-76: a request whose PR was merged or closed outside the queue is
  // settled here, before it takes the test slot, instead of after a full test
  // run and a review. An open PR (or an unreadable one) starts its tests.
  function startPrecheckJob(id) {
    const job = (async () => {
      const cur = backlogStore.load(P.stateDir).items.find((i) => i.id === id)?.mergeRequest;
      if (!cur || cur.stage !== 'requested') return null;
      const outcome = await mergeExec.precheckRequest({ mr: cur, gh: runGh });
      const items = backlogStore.load(P.stateDir).items;
      const mr = items.find((i) => i.id === id)?.mergeRequest;
      // The operator may have moved the request while gh ran.
      if (!mr || mr.stage !== 'requested') return null;
      const now = new Date().toISOString();
      if (outcome.kind !== 'open') {
        const r = mergeExec.applyMergeOutcome(mr, outcome, { now, queue: items, id });
        if (r.error) { saveMergeRequest(id, mr, r.text); return null; }
        const settled = r.mergeRequest.stage === 'merged' ? { ...r.mergeRequest, mergedOutsideQueue: true } : r.mergeRequest;
        saveMergeRequest(id, settled, `${r.text}; it was not tested or reviewed by the queue`);
        if (settled.stage === 'merged') {
          const hosting = openChildren(id, backlogStore.load(P.stateDir).items).map((c) => c.id);
          if (hosting.length) {
            const keep = `merge-queue: ${mr.repo}#${mr.number} merged; the card stays open while it hosts ${hosting.join(', ')}`;
            backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text: keep });
            getScut()?.agentSaid({ ticketId: id, kind: 'devlog', text: keep, by: 'agent' });
            broadcastBacklog();
            return null;
          }
          // The card's own gate stands: the queue did not test this merge, so it records no PASS of its own.
          backlogStore.applyLabelDeltaIn(P.stateDir, id, { labels: ['agent:done'], comment: `merge-queue: ${mr.repo}#${mr.number} was merged outside the queue` });
          try { getScut()?.ticketStateChanged?.({ item: { id, state: 'done' } }); } catch { /* the close reconciler retries */ }
          broadcastBacklog();
        }
        return null;
      }
      if (!mergeQueueMayRun() || maintenanceHold() || releasePending() || mergeQueue.nextAction(mr, items, { id, red: redFor(mr) }).action !== 'start-testing') return null;
      const t = mergeQueue.transition(mr, 'testing', { now, queue: items, id });
      if (t.error) return null;
      saveMergeRequest(id, t.mergeRequest, `tests started for ${mr.repo}#${mr.number} (round ${mr.round})`);
      return t.mergeRequest;
    })()
      .catch((e) => { reportMiss('merge-queue-precheck', `${id}: ${e?.message ?? String(e)}`); return null; })
      .finally(() => mergeJobs.delete(id));
    mergeJobs.set(id, job);
    return job.then((running) => (running && mergeQueueMayRun() && !maintenanceHold() ? startMergeTestJob(id, running) : undefined));
  }

  // runtime-9-a: held and bounced requests are re-read from GitHub on a slower
  // cadence than the tick, so a PR merged or closed by hand settles the record.
  // An unreadable PR leaves the request alone and is reported by name.
  let lastReconcileAt = 0;
  let reconciling = false;
  function reconcileEveryMs() {
    const v = Number(cfg.mergeQueue?.reconcileEveryMs);
    return Number.isFinite(v) && v >= 0 ? v : 10 * 60 * 1000;
  }
  async function reconcileTick() {
    if (reconciling || Date.now() - lastReconcileAt < reconcileEveryMs()) return;
    reconciling = true;
    lastReconcileAt = Date.now();
    try {
      const ids = backlogStore.load(P.stateDir).items
        .filter((i) => i.mergeRequest && (i.mergeRequest.stage === 'held' || i.mergeRequest.stage === 'bounced'))
        .map((i) => i.id);
      for (const id of ids) {
        if (mergeJobs.has(id) || !mergeQueueMayRun()) continue;
        const cur = backlogStore.load(P.stateDir).items.find((i) => i.id === id)?.mergeRequest;
        if (!cur || (cur.stage !== 'held' && cur.stage !== 'bounced')) continue;
        const outcome = await mergeExec.reconcileRequest({ mr: cur, gh: runGh });
        if (outcome.kind === 'unreadable') { reportMiss('merge-queue-reconcile', `${id}: ${outcome.reason}`); continue; }
        if (outcome.kind === 'open') continue;
        const items = backlogStore.load(P.stateDir).items;
        const mr = items.find((i) => i.id === id)?.mergeRequest;
        // The operator may have released or re-filed it while gh ran.
        if (!mr || mr.stage !== cur.stage || mr.prUrl !== cur.prUrl) continue;
        const r = mergeExec.applyMergeOutcome(mr, outcome, { now: new Date().toISOString(), queue: items, id });
        saveMergeRequest(id, r.mergeRequest, r.text);
        if (!r.error && r.mergeRequest.stage === 'merged') closeMergedCard(id, r.mergeRequest);
      }
    } catch (e) { reportMiss('merge-queue-reconcile', e?.message ?? String(e)); }
    finally { reconciling = false; }
  }

  // Resolves when the jobs it started finish (the timer ignores that; tests await it).
  function mergeQueueTick() {
    const started = [];
    try {
      if (!mergeQueueMayRun()) { haltMergeQueue(); return Promise.all(started).then(() => {}); }
      const ids = backlogStore.load(P.stateDir).items.filter((i) => i.mergeRequest).map((i) => i.id);
      const held = maintenanceHold();
      for (const id of ids) {
        if (mergeJobs.has(id) || held) continue;
        // Re-read per card: starting one request changes what the next may do.
        const items = backlogStore.load(P.stateDir).items;
        const mr = items.find((i) => i.id === id)?.mergeRequest;
        if (!mr) continue;
        const red = redFor(mr);
        if (mr.redHold && mr.redHold !== red?.sha) {
          const { redHold, ...rest } = mr;
          saveMergeRequest(id, rest, red ? `the full suite on ${mr.base} is red again at ${red.sha.slice(0, 7)}; testing this request against it` : `resumed: the full suite on ${mr.base} is green again`);
          continue;
        }
        if (mr.stage === 'merging' && red && mr.redFix !== red.sha) {
          const t = mergeQueue.transition(mr, 'requested', { now: new Date().toISOString(), reason: `paused: ${mergeQueue.redPauseReason(mr.base, red)}` });
          if (!t.error) saveMergeRequest(id, { ...t.mergeRequest, queuedAt: t.mergeRequest.history.at(-1).ts }, `paused before merging: ${mergeQueue.redPauseReason(mr.base, red)}; it is tested again against the red base`);
          continue;
        }
        if (mr.stage === 'merging') {
          // One merge per integration branch at a time.
          const key = mergeQueue.integrationKey(mr);
          const other = items.some((c) => c.id !== id && mergeJobs.has(c.id) && c.mergeRequest?.stage === 'merging' && mergeQueue.integrationKey(c.mergeRequest) === key);
          if (!other && !releasePending()) started.push(startMergeExecJob(id));
          continue;
        }
        if (releasePending()) continue;
        if (mr.stage === 'testing') {
          // No job here means a restart orphaned it: run its tests again.
          const running = mergeTests.markRestarted(mr, { now: new Date().toISOString() });
          saveMergeRequest(id, running, 'merge request was testing when the server restarted; restarting the tests');
          started.push(startMergeTestJob(id, running));
          continue;
        }
        if (mergeQueue.nextAction(mr, items, { id, red }).action !== 'start-testing') continue;
        started.push(startPrecheckJob(id));
      }
      started.push(reconcileTick());
      autoDeployTick();
      resumeStrandedTick();
    } catch (e) { reportMiss('merge-queue-tick', e?.message ?? String(e)); }
    return Promise.all(started).then(() => {});
  }

  return { tick: mergeQueueTick };
}
