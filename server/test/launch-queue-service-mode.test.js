// server/test/launch-queue-service-mode.test.js
// Task 12b: a kernel running as the GLMPS Windows service runs in session 0
// and has no desktop, so launchNative cannot open a terminal itself there -
// it queues the launch (the broker, launch-broker.test.js) instead, and the
// desktop shell (running in the operator's session) drains the queue through
// this HTTP surface. GLMPS_SERVICE=1 is the one fake the whole suite stands
// on; nothing here ever spawns a real terminal or installs anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from '../server.js';
import { claudeTmp } from './fixtures/claude-dir.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';
import { readEvents } from '../lib/observability/event-log.js';
import { adapterHealth, resetAdapterHealth } from '../lib/adapters/health.js';
import { readOrCreateLaunchToken } from '../lib/governance/launch-token.js';
import { computeProof, sha256Hex, randomNonce, proofsMatch } from '../lib/governance/launch-auth.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const SID = '3f2a9b1c-1111-4222-8333-444455556666';

async function withServer(extraEnv, fn, { claudeDirSetup, serverOpts, config } = {}) {
  const stateDir = tmp('mc-launchq-state-');
  const claudeDir = claudeTmp();
  // lets a caller (the real-worktree test below) write
  // settings.json's additionalDirectories into THIS claudeDir before the
  // server boots - the same timing withRepoServer (runner-worktree.test.js)
  // uses - without duplicating the rest of this helper's auth-aware
  // get/post wiring.
  if (claudeDirSetup) claudeDirSetup(claudeDir);
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_SERVICE: '1', ...extraEnv };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()], ...config }));
  const h = await startServer({ port: 0, env, configFile, ...serverOpts });
  // GET /api/launches, claim and result all now require a
  // per-request proof of knowledge of the per-install launch token the
  // kernel just created at boot - the raw token itself never goes on the
  // wire. Read back here (idempotent - the SAME file, not a fresh mint) so
  // every test using this helper can compute its own proof automatically;
  // a test proving the missing/wrong-proof refusal computes one directly
  // instead.
  const launchToken = readOrCreateLaunchToken(stateDir);
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => {
    const rawBody = opt?.body ?? '';
    const nonce = randomNonce();
    // the proof binds direction, method and path+query too.
    const method = opt?.method || 'GET';
    const proof = computeProof(launchToken, { direction: 'req', method, path: p, nonce, bodyHash: sha256Hex(rawBody) });
    const r = await fetch(base + p, { ...opt, headers: { ...(opt?.headers), 'x-launch-nonce': nonce, 'x-launch-proof': proof, 'x-glmps-local-session': h.localSession } });
    const body = r.status === 204 ? null : await r.json();
    // the shell must never trust a response's content
    // without verifying the kernel's own outbound proof first - every
    // helper call checks it here too, so any route that forgets to sign a
    // 200/204 response fails every ordinary test in this file, not only a
    // dedicated one.
    const responseProof = r.headers.get('x-launch-response-proof');
    const responseVerified = typeof responseProof === 'string' && proofsMatch(responseProof, computeProof(launchToken, { direction: 'res', method, path: p, nonce, bodyHash: sha256Hex(r.status === 204 ? '' : JSON.stringify(body)) }));
    return { status: r.status, body, responseProof, responseVerified };
  };
  const get = (p) => j(p);
  const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
  try { await fn({ get, post, h, stateDir, base, launchToken, claudeDir }); }
  finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Fix round 1, m7: the service's own working directory (WinSW's default,
// typically C:\Windows\System32) is meaningless as a terminal's cwd. With
// no usable cwd to fall back to, service mode must land on a real,
// sensible directory (the repo root) instead - and the queued record is
// what actually matters here, not just the HTTP response, since it is
// what the shell will actually open the terminal in.
test('service mode: a missing/invalid cwd falls back to the repo root, never the service\'s own meaningless cwd', async (t) => {
  t.mock.method(process, 'cwd', () => 'C:\\Windows\\System32');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  try {
    await withServer({}, async ({ post, h }) => {
      const r = await post('/api/resume', { sessionId: SID, cwd: null });
      assert.equal(r.status, 200);
      assert.equal(path.resolve(r.body.cwd), repoRoot, 'the response names the repo root, not the mocked System32 cwd');
      const rec = h.launchBroker.pending()[0];
      assert.equal(path.resolve(rec.cwd), repoRoot, 'the QUEUED cwd - what the shell will actually open the terminal in - is the repo root too');
    });
  } finally { t.mock.restoreAll(); }
});

test('service mode: /api/resume queues the launch instead of opening a terminal', async () => {
  const cwd = tmp('mc-launchq-cwd-');
  await withServer({}, async ({ post, get }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    assert.equal(r.status, 200);
    assert.equal(r.body.launched, 'queued');
    assert.equal(r.body.pid, null);
    assert.ok(r.body.launchId, 'a launchId is returned');

    const { pending, allowedCommands } = (await get('/api/launches?state=pending')).body;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, r.body.launchId);
    assert.equal(pending[0].origin, 'resume');
    assert.equal(pending[0].command, `claude --resume ${SID}`);
    // the terminal-command allowlist is now folded into
    // this SAME authenticated response, so an impostor cannot serve it
    // separately (the old, unauthenticated /api/config fetch is gone from
    // the shell's launch poll).
    assert.ok(Array.isArray(allowedCommands));
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('service mode: /api/terminal queues the launch under origin "terminal"', async () => {
  const cwd = tmp('mc-launchq-cwd2-');
  await withServer({}, async ({ post, get }) => {
    const r = await post('/api/terminal', { terminal: 'Claude', cwd });
    assert.equal(r.status, 200);
    assert.equal(r.body.launched, 'queued');
    assert.ok(r.body.launchId);

    const { pending } = (await get('/api/launches?state=pending')).body;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].origin, 'terminal');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('GET /api/launches, POST .../claim and POST .../result walk one record through the whole queue', async () => {
  const cwd = tmp('mc-launchq-cwd3-');
  await withServer({}, async ({ post, get }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    const id = r.body.launchId;

    // A second claim loses the race.
    const claim1 = await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' });
    assert.equal(claim1.status, 200);
    assert.equal(claim1.body.state, 'claimed');
    const claim2 = await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' });
    assert.equal(claim2.status, 409);

    // An unclaimed/unknown record cannot be completed.
    const resultUnknown = await post('/api/launches/not-a-real-id/result', { pid: 1 });
    assert.equal(resultUnknown.status, 400);

    const result = await post(`/api/launches/${id}/result`, { pid: 4242 });
    assert.equal(result.status, 204);

    // Drained: no longer pending.
    assert.equal((await get('/api/launches?state=pending')).body.pending.length, 0);
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a reported spawn error is recorded, not silently dropped', async () => {
  const cwd = tmp('mc-launchq-cwd4-');
  await withServer({}, async ({ post, h, stateDir }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    const id = r.body.launchId;
    await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' });
    const result = await post(`/api/launches/${id}/result`, { error: 'ENOENT' });
    assert.equal(result.status, 204);
    // m3: the record itself is 'failed' carrying the error, not only a 204.
    const rec = h.launchBroker.get(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.error, 'ENOENT');
    assert.equal(rec.pid, null);
    // a durable launch.failed event too, same shape Task 12's own
    // spawn-failure path already produces - a button that silently did
    // nothing must still be visible as a real event, not only in this
    // response.
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].lane, 'resume');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// The maker's own "has this waited too long" threshold calls straight into
// launchBroker.oldestPendingAgeMs(), already unit-tested with an injected
// clock in launch-broker.test.js; this integration test covers the two
// outcomes reachable without a real two-minute wait.
test('the launch-queue loop: nothing-to-do while empty, done once a launch is queued', async () => {
  const cwd = tmp('mc-launchq-cwd5-');
  await withServer({}, async ({ post, h }) => {
    const empty = h.loopRegistry.get('launch-queue');
    assert.equal(empty.lastOutcome, null, 'not yet run (bootDelayMs)');

    const run1 = await h.loopRegistry.runNow('launch-queue');
    assert.equal(run1.outcome, 'nothing-to-do');

    await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    const run2 = await h.loopRegistry.runNow('launch-queue');
    assert.equal(run2.outcome, 'done');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// a claimed record with no result (the shell quit
// mid-tick, or its result POST was lost) must not keep this loop red
// forever by itself - the maker actively resolves it (failStaleClaims)
// rather than merely alerting, and does NOT run I6's runner hold-and-
// delete (the terminal may actually be open; only the POST was lost).
// Date.now is mocked here (a property on the global Date constructor, not
// an ES module import - the same safe category as the process.cwd and
// fs.writeFileSync mocks elsewhere in this suite) to fast-forward the
// real launchBroker's own clock without a real 60s wait.
test('the launch-queue loop moves a claimed-with-no-result launch to failed, without holding the runner card', async (t) => {
  const cwd = tmp('mc-launchq-cwd7-');
  await withServer({}, async ({ post, get, h, stateDir }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const before = (await get('/api/runner')).body.ledger;
    const launchId = before['glmps-1'].launchId;
    const claim = await post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' });
    assert.equal(claim.status, 200);

    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 61_000);
    try {
      const run = await h.loopRegistry.runNow('launch-queue');
      assert.notEqual(run.outcome, 'failed', 'actively resolved, not left to alert forever');
    } finally { t.mock.restoreAll(); }

    const rec = h.launchBroker.get(launchId);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.error, 'no result from shell');

    // Unlike I6's result-route failure path, this must NOT hold the card
    // or drop the ledger entry - the terminal may genuinely be open, with
    // only the result POST lost, so the job keeps running as far as the
    // runner is concerned.
    const item = (await get('/api/backlog/glmps-1')).body;
    assert.notEqual(item.state, 'held');
    const ledgerAfter = (await get('/api/runner')).body.ledger;
    assert.ok(ledgerAfter['glmps-1'], 'the ledger entry is left alone');

    // M-8: exactly one launch.failed event for this one record - neither
    // silently missing (I6's whole reason for existing) nor double-fired
    // (the loop's own sweep moving it once, nothing re-triggering on a
    // second tick).
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1, 'R2-3: exactly one launch.failed event for the claimed-with-no-result timeout');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// Task 12b's Interfaces line: "the runner records pid and launchId on the
// ledger entry". A real (non-dry-run) runner tick in service mode queues the
// job's launch under origin 'runner' instead of spawning it, and the
// ledger entry it writes carries that launchId (pid null until claimed and
// completed) - then completing it with a pid patches the SAME ledger entry,
// the bridge the launch-queue loop and the dashboard both rely on.
test('a runner job launch queues under origin "runner"; completing it patches the ledger entry by launchId', async () => {
  await withServer({}, async ({ post, get, h }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();

    let ledger = (await get('/api/runner')).body.ledger;
    assert.ok(ledger['glmps-1'], 'the ledger has the claimed job');
    assert.equal(ledger['glmps-1'].pid, null, 'no real pid yet - the launch is only queued');
    const launchId = ledger['glmps-1'].launchId;
    assert.ok(launchId, 'the ledger entry carries the launchId the broker issued');

    const { pending } = (await get('/api/launches?state=pending')).body;
    const rec = pending.find((p) => p.id === launchId);
    assert.ok(rec, 'the broker holds a matching pending record');
    assert.equal(rec.origin, 'runner');

    await post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' });
    const result = await post(`/api/launches/${launchId}/result`, { pid: 9191 });
    assert.equal(result.status, 204);

    ledger = (await get('/api/runner')).body.ledger;
    // Fix round 1, I4(A) ruling: the transient launcher's pid (cmd /c
    // start, which exits immediately once the real window is open) must
    // NEVER land on the card-governed ledger pid - reconcileLedger's own
    // isAlive(entry.pid) probe would see it dead on the very next tick and
    // requeue a SECOND terminal into the same worktree. It is recorded
    // under its own field instead, for diagnostics only.
    assert.equal(ledger['glmps-1'].pid, null, 'the card-governed pid is never overwritten by the transient launcher pid');
    assert.equal(ledger['glmps-1'].launcherPid, 9191, 'the reported pid is recorded under its own diagnostic field');

    // m-c: a reconcile pass (another runnerTick) after the result must not
    // requeue the job - this is the actual mechanism I4(A) protects
    // against: reconcileLedger's own isAlive(entry.pid) probe only runs
    // when entry.pid is non-null, so had the transient launcher's pid
    // landed there, THIS tick is exactly where it would have seen it
    // already dead and requeued a second terminal into the same worktree.
    await h.runnerTick();
    const item = (await get('/api/backlog/glmps-1')).body;
    assert.equal(item.state, 'in_progress', 'not requeued by the reconcile pass');
    const ledgerAfter = (await get('/api/runner')).body.ledger;
    assert.ok(ledgerAfter['glmps-1'], 'the ledger entry survives the reconcile pass');
    assert.equal(ledgerAfter['glmps-1'].retries, 0, 'never requeued, so retries never incremented');
  });
});

// Fix round 1, I4(B): pending records never expire on their own. A runner
// job relaunched under a NEW launchId while the shell was closed orphans
// the OLD one - the shell must not be allowed to drain it and open a
// second terminal into whatever the job's worktree holds now.
//
// a stale-refused record used to stay pending forever
// (the shell retries it every poll, and after 120s the loop falsely
// reports "the desktop shell is not running"). It must be moved to failed
// instead, so the next staleness check is clean.
test('claiming a runner launch refuses as stale once its job was relaunched under a different launchId, and the record is moved to failed (not left pending)', async () => {
  await withServer({}, async ({ post, get, h, stateDir }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const before = (await get('/api/runner')).body.ledger;
    const staleLaunchId = before['glmps-1'].launchId;
    assert.ok(staleLaunchId);

    // Simulate a relaunch (a new attempt minted its own launchId) without
    // ever completing the old one - the ledger entry now points at a
    // DIFFERENT launchId than the one still sitting pending in the broker.
    const ledger = runnerStore.loadLedger(stateDir);
    ledger['glmps-1'] = { ...ledger['glmps-1'], launchId: 'ln_00000000-0000-0000-0000-000000000000' };
    runnerStore.saveLedger(stateDir, ledger);

    const claim = await post(`/api/launches/${staleLaunchId}/claim`, { by: 'desktop-shell' });
    assert.equal(claim.status, 409);
    assert.equal(claim.body.error, 'stale');

    // Not left pending (R2-2): moved straight to failed, with the stale
    // reason as its error.
    const { pending } = (await get('/api/launches?state=pending')).body;
    assert.ok(!pending.some((p) => p.id === staleLaunchId), 'no longer pending');
    const rec = h.launchBroker.get(staleLaunchId);
    assert.equal(rec.state, 'failed');
    assert.match(rec.error, /stale/);

    // The next staleness check is clean - nothing left pending or claimed
    // for this record to ever trip the loop's own alert.
    const run = await h.loopRegistry.runNow('launch-queue');
    assert.notEqual(run.outcome, 'failed');

    // A second claim attempt now hits the ordinary "already ... failed"
    // 409, not a repeated 'stale' - it is a ended record now, not a
    // perpetually-retried one.
    const claim2 = await post(`/api/launches/${staleLaunchId}/claim`, { by: 'desktop-shell' });
    assert.equal(claim2.status, 409);
    assert.notEqual(claim2.body.error, 'stale');

    // M-8: exactly one launch.failed event - the stale-claim refusal
    // fires it once; the repeat claim attempt (falling through to the
    // ordinary "already failed" 409) must not fire a second one.
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1, 'R2-2: exactly one launch.failed event for the stale claim, none from the repeat attempt');
  });
});

// A non-runner origin (resume/terminal/learning) has no ledger entry at
// all, so the staleness check must not apply to it - a plain unknown id
// is still the ordinary 409.
test('a non-runner launch is unaffected by the staleness check', async () => {
  const cwd = tmp('mc-launchq-cwd6-');
  await withServer({}, async ({ post }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    const id = r.body.launchId;
    const claim = await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.state, 'claimed');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// a shell-reported failure for a RUNNER launch must be
// durable and immediately visible, not just a pid that silently stays
// null until the ordinary runtime timeout (up to maxRuntimeMs minutes
// later) eventually notices. The ledger entry is dropped (never silently
// requeued into the same worktree without review) and the card goes to
// 'held' with a devlog line naming the reported error.
test('a shell-reported failure for a runner launch holds the card with a named reason, visibly and at once', async () => {
  await withServer({}, async ({ post, get, h }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const ledgerBefore = (await get('/api/runner')).body.ledger;
    const launchId = ledgerBefore['glmps-1'].launchId;

    await post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' });
    const result = await post(`/api/launches/${launchId}/result`, { error: 'ENOENT' });
    assert.equal(result.status, 204);

    const item = (await get('/api/backlog/glmps-1')).body;
    assert.equal(item.state, 'held');
    assert.ok(item.devLog.some((l) => l.text.includes('ENOENT')), 'the devlog names the reported error');

    const ledgerAfter = (await get('/api/runner')).body.ledger;
    assert.equal('glmps-1' in ledgerAfter, false, 'the stale ledger entry is removed, not left pointing at a dead launch');
  });
});

// Fix round 2, m-d: the hold path used to delete the ledger entry outside
// reconcileNow entirely, so neither of its two departed-job signals
// (worktree reclaim, the Slack notifier) ever ran for it. The hold path
// now runs the SAME two checks reconcileNow's own departed-job loop runs
// (retainedWorktreeJobs, reclaimVerdict) for this job too - proven here by
// the absence of any reportMiss from that new code (the no-worktree case
// is the one this fixture can reach without standing up a real git repo
// registered as the card's project; reclaimVerdict's own 'no-worktree'
// branch is exercised either way, since a fresh runner launch with no
// project set never creates one).
test('a shell-reported runner failure runs the same reclaim/notifier checks reconcileNow would, without throwing', async () => {
  await withServer({}, async ({ post, get, h }) => {
    resetAdapterHealth();
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const launchId = (await get('/api/runner')).body.ledger['glmps-1'].launchId;
    await post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' });
    await post(`/api/launches/${launchId}/result`, { error: 'ENOENT' });
    assert.equal(adapterHealth()['launch-result-runner-failed'], undefined, 'the reclaim/notifier pass ran cleanly, no miss reported');
  });
});

// the test above is vacuous - there is no project set on
// the card, so it can never reach anything but reclaimVerdict's own
// 'no-worktree' branch (a reportMiss absence proves nothing there was ever
// at risk of throwing). This end-to-end variant reuses the real-repo
// fixture pattern server/test/runner-worktree.test.js's own reclaim tests
// use (makeRepo/git/deadPid) so the hold path actually exercises a REAL
// worktree: a card with a project, a service-mode runner tick that queues
// the launch under a real git worktree, a claim, then a shell-reported
// result {error} - and asserts the worktree was actually reclaimed
// (op 'removed'), not merely that nothing threw.
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }
function makeRepo() {
  const repo = tmp('mc-launchq-wtrepo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  // "Merged" is judged against origin/* only, so the seed commit goes to a remote main.
  const origin = tmp('mc-launchq-origin-');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  return repo;
}
// A pid that is guaranteed dead: run a trivial child to completion and
// reuse its pid (same technique as runner-worktree.test.js's own
// deadPid() - an arbitrary number risks colliding with a live process and
// making the test flaky in the direction that hides a bug).
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  return r.pid;
}

test('I-2: a shell-reported runner failure reclaims a REAL worktree once the agent is gone (not the vacuous no-worktree case above)', async () => {
  const repo = makeRepo();
  const project = path.basename(repo);
  try {
    await withServer({}, async ({ post, get, h, stateDir }) => {
      resetAdapterHealth();
      await post('/api/runner/config', { enabled: true, useWorktrees: true });
      const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
      // Service mode: the first tick asks the (absent) desktop shell for the
      // upstream fetch and launches on the tick after its short claim wait.
      await h.runnerTick();
      await new Promise((r) => setTimeout(r, 300));
      await h.runnerTick();

      const entry = (await get('/api/runner')).body.ledger[card.id];
      assert.ok(entry?.worktree, 'the ledger recorded a real worktree for this job (not the no-worktree case)');
      const wt = entry.worktree.dir;
      assert.ok(fs.existsSync(wt), 'the worktree checkout exists on disk before the failure');
      const launchId = entry.launchId;
      assert.ok(launchId, 'service mode queued the launch instead of spawning it');

      // Stamp a provably-dead pid so reclaimVerdict sees the agent as gone
      // (service mode otherwise records this TEST's own live pid) - same
      // technique as runner-worktree.test.js's own reclaim tests.
      const ledger = runnerStore.loadLedger(stateDir);
      ledger[card.id] = { ...ledger[card.id], pid: deadPid() };
      runnerStore.saveLedger(stateDir, ledger);

      const claim = await post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' });
      assert.equal(claim.status, 200);
      const result = await post(`/api/launches/${launchId}/result`, { error: 'ENOENT' });
      assert.equal(result.status, 204);

      assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'ledger entry removed (I6\'s hold-and-drop)');
      const item = (await get(`/api/backlog/${card.id}`)).body;
      assert.equal(item.state, 'held');

      // The actual point of I-2: this is no longer the no-worktree branch
      // - the checkout is really gone from disk, and the event names the
      // real outcome ('removed'), not 'no-worktree' or a silent nothing.
      // Service mode reads the outcome facts through the shell seam, so the
      // reclaim completes a moment after the result route answers.
      // The prune that follows the removal is async too, so wait for the decision record itself.
      await (await import('./helpers/wait-for.js')).waitFor(() => !fs.existsSync(wt) && readEvents(stateDir).some((e) => e.kind === 'worktree.reclaim' && e.label === String(card.id)), { message: 'the reclaim to finish' });
      assert.equal(fs.existsSync(wt), false, 'the worktree checkout was actually reclaimed once the agent was gone');
      const events = readEvents(stateDir).filter((e) => e.kind === 'worktree.reclaim' && e.label === String(card.id));
      assert.equal(events.length, 1, 'exactly one reclaim decision was recorded for this job');
      assert.equal(events[0].op, 'removed');
      assert.equal(adapterHealth()['launch-result-runner-failed'], undefined, 'the reclaim/notifier pass ran cleanly, no miss reported');
      // scut.jobFinished is not injectable through startServer's public
      // options (it is constructed internally by startScut(), gated on
      // real SCUT credentials this test env never sets) - there is no
      // seam to assert the call through, so this is recorded here rather
      // than silently skipped: see the FINDINGS note in the round 3 report.
    }, { config: { mergeQueue: { shellClaimWaitMs: 50 } }, claudeDirSetup: (claudeDir) => { fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } })); } });
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
});

// the raw token never
// goes on the wire any more. GET /api/launches, claim and result all now
// require a per-request HMAC proof of knowledge of the per-install launch
// token instead - a missing nonce, a missing proof, or a proof computed
// over the wrong token/nonce/body all refuse exactly like a missing token
// used to, and the GENUINE kernel's own response carries a verifiable
// outbound proof over what it actually sent.
test('I-1: GET /api/launches, claim and result all refuse a missing or wrong proof, and sign a correct response', async () => {
  const cwd = tmp('mc-launchq-cwd8-');
  await withServer({}, async ({ post, base, launchToken }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    const id = r.body.launchId;

    const noProof = await fetch(`${base}/api/launches?state=pending`);
    assert.equal(noProof.status, 401);

    const nonce = randomNonce();
    const wrongProof = await fetch(`${base}/api/launches?state=pending`, { headers: { 'x-launch-nonce': nonce, 'x-launch-proof': computeProof('b'.repeat(64), { direction: 'req', method: 'GET', path: '/api/launches?state=pending', nonce, bodyHash: sha256Hex('') }) } });
    assert.equal(wrongProof.status, 401);

    const rightProof = await fetch(`${base}/api/launches?state=pending`, { headers: { 'x-launch-nonce': nonce, 'x-launch-proof': computeProof(launchToken, { direction: 'req', method: 'GET', path: '/api/launches?state=pending', nonce, bodyHash: sha256Hex('') }) } });
    assert.equal(rightProof.status, 200);
    const rightBody = await rightProof.json();
    const outboundProof = rightProof.headers.get('x-launch-response-proof');
    assert.ok(outboundProof, 'a correctly-authenticated request gets back a signed response');
    assert.ok(proofsMatch(outboundProof, computeProof(launchToken, { direction: 'res', method: 'GET', path: '/api/launches?state=pending', nonce, bodyHash: sha256Hex(JSON.stringify(rightBody)) })), 'the outbound proof verifies against what the kernel actually sent');

    const claimBody = JSON.stringify({ by: 'shell' });
    const claimNoProof = await fetch(`${base}/api/launches/${id}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: claimBody });
    assert.equal(claimNoProof.status, 401);

    const resultBody = JSON.stringify({ pid: 1 });
    const resultNonce = randomNonce();
    const resultWrongProof = await fetch(`${base}/api/launches/${id}/result`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-launch-nonce': resultNonce, 'x-launch-proof': computeProof('b'.repeat(64), { direction: 'req', method: 'POST', path: `/api/launches/${id}/result`, nonce: resultNonce, bodyHash: sha256Hex(resultBody) }) }, body: resultBody });
    assert.equal(resultWrongProof.status, 401);
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// the round 3 MAC covered only `${nonce}\n${bodyHash}`.
// An impostor holding the port while the service was down could capture one
// shell poll (nonce, proof over '') and replay it to the real kernel: GET
// 200, claim with an empty body 200, result with an empty body 204 (the
// record silently done). A claim proof (constant body) also verified for
// every id, and a response proof verified as a request proof. Each of those
// is now refused.
test('F2: a captured proof cannot be replayed - not to the same route, not to another route, not for another id, not as the other direction', async () => {
  const cwdA = tmp('mc-launchq-f2a-');
  const cwdB = tmp('mc-launchq-f2b-');
  await withServer({}, async ({ post, base, launchToken, h }) => {
    const a = (await post('/api/resume', { sessionId: SID, cwd: cwdA, location: 'editor' })).body.launchId;
    const b = (await post('/api/resume', { sessionId: '3f2a9b1c-1111-4222-8333-444455556667', cwd: cwdB, location: 'editor' })).body.launchId;
    const send = (method, p, rawBody, nonce, proof) => fetch(base + p, {
      method,
      headers: { 'x-launch-nonce': nonce, 'x-launch-proof': proof, ...(rawBody ? { 'content-type': 'application/json' } : {}) },
      ...(rawBody !== undefined && method !== 'GET' ? { body: rawBody } : {}),
    });
    const sign = (direction, method, p, nonce, rawBody) => computeProof(launchToken, { direction, method, path: p, nonce, bodyHash: sha256Hex(rawBody) });

    // The reviewer's exact capture: one GET poll, proof over ''.
    const pollPath = '/api/launches?state=pending';
    const n1 = randomNonce();
    const pollProof = sign('req', 'GET', pollPath, n1, '');
    const poll = await send('GET', pollPath, undefined, n1, pollProof);
    assert.equal(poll.status, 200, 'the genuine poll itself is accepted');
    const pollResponseProof = poll.headers.get('x-launch-response-proof');
    const pollBody = await poll.text();

    // 1. The same GET replayed verbatim: the nonce has been seen.
    assert.equal((await send('GET', pollPath, undefined, n1, pollProof)).status, 401, 'a reused nonce is refused');

    // 2. The captured GET proof (a FRESH, never-seen nonce, as an impostor
    // that never forwarded the poll would hold) replayed to claim and to
    // result with an empty body: bound to GET + its own path, so refused.
    const n2 = randomNonce();
    const unseenPollProof = sign('req', 'GET', pollPath, n2, '');
    assert.equal((await send('POST', `/api/launches/${a}/claim`, '', n2, unseenPollProof)).status, 401, 'a GET proof is refused on claim');
    assert.equal((await send('POST', `/api/launches/${a}/result`, '', n2, unseenPollProof)).status, 401, 'a GET proof is refused on result');
    assert.equal(h.launchBroker.get(a).state, 'pending', 'nothing was claimed or completed');

    // 3. A response proof fed back as a request proof: the direction differs.
    const n3 = randomNonce();
    const claimBody = JSON.stringify({ by: 'desktop-shell' });
    const responseAsRequest = computeProof(launchToken, { direction: 'res', method: 'POST', path: `/api/launches/${a}/claim`, nonce: n3, bodyHash: sha256Hex(claimBody) });
    assert.equal((await send('POST', `/api/launches/${a}/claim`, claimBody, n3, responseAsRequest)).status, 401, 'a response-direction proof is refused as a request');
    // ...including the real kernel's own signed GET response, replayed as a GET request.
    assert.ok(pollResponseProof && pollBody, 'the genuine poll was signed');
    assert.equal((await send('GET', pollPath, undefined, n1, pollResponseProof)).status, 401);

    // 4. A claim proof for launch a, captured unseen, is refused for launch b.
    const n4 = randomNonce();
    const claimProofForA = sign('req', 'POST', `/api/launches/${a}/claim`, n4, claimBody);
    assert.equal((await send('POST', `/api/launches/${b}/claim`, claimBody, n4, claimProofForA)).status, 401, 'a proof for one id is refused for another');
    assert.equal(h.launchBroker.get(b).state, 'pending');

    // The genuine claim for a, with that same (still unseen) nonce, works -
    // and then its replay does not.
    const okClaim = await send('POST', `/api/launches/${a}/claim`, claimBody, n4, claimProofForA);
    assert.equal(okClaim.status, 200);
    assert.equal((await send('POST', `/api/launches/${a}/claim`, claimBody, n4, claimProofForA)).status, 401, 'the claim replayed is refused before the broker is reached');
  });
  fs.rmSync(cwdA, { recursive: true, force: true });
  fs.rmSync(cwdB, { recursive: true, force: true });
});

// freshness - a nonce minted outside the kernel's window is refused
// even when its proof is otherwise correct, so the seen-nonce cache never
// has to remember anything older than that window.
test('F2: a correctly-signed request whose nonce was minted outside the freshness window is refused', async () => {
  await withServer({}, async ({ base, launchToken }) => {
    const p = '/api/launches?state=pending';
    const nonce = randomNonce(Date.now() - 60 * 60_000);
    const proof = computeProof(launchToken, { direction: 'req', method: 'GET', path: p, nonce, bodyHash: sha256Hex('') });
    const r = await fetch(base + p, { headers: { 'x-launch-nonce': nonce, 'x-launch-proof': proof } });
    assert.equal(r.status, 401);
  });
});

// Fix round 2, R2-5 (shell side, kernel-visible half): the kernel itself
// must create the token file at boot, at the SAME resolved state dir the
// shell's own resolveStateDir (apps/shell/src/lib/endpoints.js) would land
// on when GLMPS_STATE_DIR is shared between the two. Started directly here
// (not through the withServer helper above, whose own readOrCreateLaunchToken
// call for every OTHER test in this file would otherwise create the file
// itself and make this a false positive) - the shell's own refuse-when-
// missing/wrong-token behavior is covered directly in
// apps/shell/test/launch-runner.test.js.
test('R2-5: the kernel itself creates the launch token file at boot, before any test helper reads it', async () => {
  const stateDir = tmp('mc-launchq-tokenboot-');
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_SERVICE: '1' };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()] }));
  const h = await startServer({ port: 0, env, configFile });
  try {
    assert.equal(fs.existsSync(path.join(stateDir, 'launch-token')), true, 'the kernel created it at boot, with no request or test helper involved');
    const token = fs.readFileSync(path.join(stateDir, 'launch-token'), 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// readOrCreateLaunchToken can throw (an unreadable
// EXISTING file - here, a directory sitting where the token file should
// be, which is not ENOENT) - this used to propagate straight out of
// startServer and crash the whole kernel at boot over a feature most
// installs never touch. It is now guarded the same way the obligation
// store above it is: launches are disabled (every launch route answers
// 401, same as a bad proof) and the miss is named, but the kernel boots.
test('M-2: a boot-time launch-token read failure disables launches (named), but the kernel still boots', async () => {
  resetAdapterHealth();
  const stateDir = tmp('mc-launchq-tokenerr-');
  fs.mkdirSync(path.join(stateDir, 'launch-token')); // a directory, not a file - readFileSync throws EISDIR, not ENOENT
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_SERVICE: '1' };
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ launchRoots: [os.tmpdir()] }));
  const h = await startServer({ port: 0, env, configFile });
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const r = await fetch(`${base}/api/launches?state=pending`);
    assert.equal(r.status, 401, 'launches are disabled, not a crash, and the route still answers');
    assert.ok(adapterHealth()['launch-token-boot'], 'the miss is named, not silent');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Fix round 2, m-e: a pending record (never even claimed) never expired on
// its own - resume/terminal/learning are bounded by a fixed 10-minute
// idle-too-long time. Date.now is mocked (the same safe property-access
// category as the process.cwd/fs.writeFileSync mocks elsewhere in this
// suite) to fast-forward past it without a real 10-minute wait.
test('m-e: a resume launch pending past 10 minutes expires to failed, and stops tripping the loop\'s own alert', async (t) => {
  const cwd = tmp('mc-launchq-cwd10-');
  await withServer({}, async ({ post, get, h, stateDir }) => {
    const r = await post('/api/resume', { sessionId: SID, cwd, location: 'editor' });
    const id = r.body.launchId;
    const real = Date.now();
    t.mock.method(Date, 'now', () => real + 601_000);
    try {
      const run = await h.loopRegistry.runNow('launch-queue');
      assert.equal(run.outcome, 'nothing-to-do', 'expired and resolved, not left pending to alert on');
    } finally { t.mock.restoreAll(); }
    const rec = h.launchBroker.get(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.error, 'expired before the shell opened it');
    const { pending } = (await get('/api/launches?state=pending')).body;
    assert.equal(pending.length, 0);

    // M-8: exactly one launch.failed event for this one expired record.
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1, 'm-e (resume): exactly one launch.failed event for the 10-minute expiry');
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// m-e: a runner-origin pending record is bounded by the JOB's own
// remaining runtime budget (maxRuntimeMs, default 30 min) instead of the
// fixed 10-minute bound - it expires once the job itself would already be
// considered overrun, not on some unrelated fixed clock.
test('m-e: a runner launch pending past the job\'s own maxRuntimeMs expires to failed', async (t) => {
  await withServer({}, async ({ post, get, h, stateDir }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const launchId = (await get('/api/runner')).body.ledger['glmps-1'].launchId;

    const real = Date.now();
    // Default maxRuntimeMs is 30 minutes; past it, not past the fixed
    // 10-minute bound that would apply to a non-runner origin.
    t.mock.method(Date, 'now', () => real + 31 * 60_000);
    try {
      await h.loopRegistry.runNow('launch-queue');
    } finally { t.mock.restoreAll(); }

    const rec = h.launchBroker.get(launchId);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.error, 'expired before the shell opened it');

    // M-8: exactly one launch.failed event for this one expired record.
    const events = readEvents(stateDir).filter((e) => e.kind === 'launch.failed');
    assert.equal(events.length, 1, 'm-e (runner): exactly one launch.failed event for the maxRuntimeMs expiry');
  });
});

// m-e's own runner-origin predicate looked up the
// ledger entry whose launchId matches this pending record, to compare
// against ITS startedAt - but an ORPHANED record (the job was relaunched
// under a different launchId, same scenario R2-2 covers at CLAIM time;
// this is the never-claimed, PENDING side R2-2 never sees) has no ledger
// entry pointing at it at all, so jobId is never found and the old
// predicate returned false UNCONDITIONALLY - the record sat pending
// forever, never expiring, no matter how long. An orphan has no
// legitimate owner left to ever claim it: stale is immediate, not a
// runtime budget it will eventually cross.
test('M-1: an orphaned pending runner record (no ledger entry points at its launchId) expires immediately, not never', async () => {
  await withServer({}, async ({ post, get, h, stateDir }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const launchId = (await get('/api/runner')).body.ledger['glmps-1'].launchId;

    // Orphan it: the ledger entry now points at a DIFFERENT launchId (a
    // relaunch under a new attempt) - same technique as the R2-2 test -
    // but this record is left PENDING (never claimed), the one case R2-2's
    // own claim-time check never reaches at all.
    const ledger = runnerStore.loadLedger(stateDir);
    ledger['glmps-1'] = { ...ledger['glmps-1'], launchId: 'ln_00000000-0000-0000-0000-000000000000' };
    runnerStore.saveLedger(stateDir, ledger);

    // No clock skip at all: an orphan must expire on the very next sweep,
    // not wait out a runtime budget that no longer applies to it.
    const run = await h.loopRegistry.runNow('launch-queue');
    assert.notEqual(run.outcome, 'failed', 'actively resolved, not left to alert forever');

    const rec = h.launchBroker.get(launchId);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.error, 'expired before the shell opened it');
  });
});

// loadLedger answers {} on any read error, so a single
// transient read failure made EVERY pending runner launch look orphaned
// (M-1's "no ledger entry points at it") and expired them all at once.
// When the ledger cannot be read, runner-origin expiry is skipped for that
// sweep (named, not silent); the record expires on a later sweep that can
// actually read the ledger.
test('F4: an unreadable runner ledger skips runner-origin expiry (named), instead of expiring every pending runner launch as an orphan', async () => {
  resetAdapterHealth();
  await withServer({}, async ({ post, get, h, stateDir }) => {
    await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
    await post('/api/runner/config', { enabled: true });
    await h.runnerTick();
    const launchId = (await get('/api/runner')).body.ledger['glmps-1'].launchId;
    const ledgerFile = path.join(stateDir, 'runner', 'launched.json');
    const good = fs.readFileSync(ledgerFile, 'utf8');

    fs.writeFileSync(ledgerFile, good.slice(0, Math.floor(good.length / 2))); // a torn read
    await h.loopRegistry.runNow('launch-queue');
    assert.equal(h.launchBroker.get(launchId).state, 'pending', 'not expired on an unreadable ledger');
    assert.ok(adapterHealth()['launch-queue-ledger'], 'the skipped sweep is named, not silent');

    // Orphan it for real, readable this time: the next sweep expires it.
    const ledger = JSON.parse(good);
    ledger['glmps-1'] = { ...ledger['glmps-1'], launchId: 'ln_00000000-0000-0000-0000-000000000000' };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    await h.loopRegistry.runNow('launch-queue');
    assert.equal(h.launchBroker.get(launchId).state, 'failed', 'a readable ledger still expires a real orphan');
  });
});

// Post-breaker residual N1: the claim-time staleness check and the
// result-time hold/patch still read the ledger through loadLedger, which
// answers {} on any read error - so a LIVE runner launch was falsely
// failed as "stale" at claim, and a reported failure or pid silently
// skipped its hold/patch. A read error is now named and the ordinary path
// continues (the claim succeeds; the result is still recorded).
async function runnerLaunchWithTornLedger({ post, get, h, stateDir }) {
  await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a' });
  await post('/api/runner/config', { enabled: true });
  await h.runnerTick();
  const launchId = (await get('/api/runner')).body.ledger['glmps-1'].launchId;
  const ledgerFile = path.join(stateDir, 'runner', 'launched.json');
  const good = fs.readFileSync(ledgerFile, 'utf8');
  const tear = () => fs.writeFileSync(ledgerFile, good.slice(0, Math.floor(good.length / 2)));
  return { launchId, ledgerFile, tear };
}

test('N1: an unreadable ledger at claim time is named and the claim proceeds, not a false "stale" failure', async () => {
  resetAdapterHealth();
  await withServer({}, async (ctx) => {
    const { launchId, tear } = await runnerLaunchWithTornLedger(ctx);
    tear();
    const claim = await ctx.post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' });
    assert.equal(claim.status, 200, 'claimed, not 409 stale');
    assert.equal(ctx.h.launchBroker.get(launchId).state, 'claimed');
    assert.match(adapterHealth()['launch-claim-stale-check']?.lastReason ?? '', /ledger/i, 'the skipped check is named');
  });
});

test('N1: an unreadable ledger when a runner failure is reported is named, the record still fails, and the ledger is not rewritten', async () => {
  resetAdapterHealth();
  await withServer({}, async (ctx) => {
    const { launchId, ledgerFile, tear } = await runnerLaunchWithTornLedger(ctx);
    assert.equal((await ctx.post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' })).status, 200);
    tear();
    const torn = fs.readFileSync(ledgerFile, 'utf8');
    const r = await ctx.post(`/api/launches/${launchId}/result`, { error: 'spawn failed' });
    assert.equal(r.status, 204);
    assert.equal(ctx.h.launchBroker.get(launchId).state, 'failed');
    assert.match(adapterHealth()['launch-result-runner-failed']?.lastReason ?? '', /ledger/i, 'the skipped hold is named, not silent');
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), torn, 'the unreadable ledger is left for inspection, not overwritten');
  });
});

test('N1: an unreadable ledger when a runner pid is reported is named, not silently skipped', async () => {
  resetAdapterHealth();
  await withServer({}, async (ctx) => {
    const { launchId, tear } = await runnerLaunchWithTornLedger(ctx);
    assert.equal((await ctx.post(`/api/launches/${launchId}/claim`, { by: 'desktop-shell' })).status, 200);
    tear();
    const r = await ctx.post(`/api/launches/${launchId}/result`, { pid: 4242 });
    assert.equal(r.status, 204);
    assert.equal(ctx.h.launchBroker.get(launchId).state, 'done');
    assert.match(adapterHealth()['launch-result-ledger-patch']?.lastReason ?? '', /ledger/i);
  });
});

// Post-breaker residual N2: a request whose proof verified but whose nonce
// the guard refused (replayed, stale, cache full) still gets 401, and the
// reason is now named - a replay against the real kernel is exactly the
// kind of event the operator should see. A request whose proof did NOT
// verify is not reported (anyone can send those; reporting them would let
// an unauthenticated caller flood the alert).
test('N2: a verified proof with a refused nonce is a named launch-nonce miss; an unverified proof is not', async () => {
  resetAdapterHealth();
  await withServer({}, async ({ base, launchToken }) => {
    const p = '/api/launches?state=pending';
    const send = (nonce, token = launchToken) => fetch(base + p, { headers: { 'x-launch-nonce': nonce, 'x-launch-proof': computeProof(token, { direction: 'req', method: 'GET', path: p, nonce, bodyHash: sha256Hex('') }) } });

    const bad = randomNonce();
    assert.equal((await send(bad, 'b'.repeat(64))).status, 401);
    assert.equal(adapterHealth()['launch-nonce'], undefined, 'an unverified proof is not reported');

    const n = randomNonce();
    assert.equal((await send(n)).status, 200);
    assert.equal((await send(n)).status, 401);
    assert.match(adapterHealth()['launch-nonce']?.lastReason ?? '', /replay/);

    assert.equal((await send(randomNonce(Date.now() - 60 * 60_000))).status, 401);
    assert.match(adapterHealth()['launch-nonce']?.lastReason ?? '', /stale/);
  });
});

// The Gemini fix: in service mode the huddle's agy seats do not spawn agy (the
// service cannot load the operator's sign-in); the call is queued as an 'agy'
// launch record and the desktop shell, in the operator's session, runs it.
const AGY_MODEL = 'Gemini 3.8 Flash (Medium)';

test('agy launch: a queued agy record rides GET /api/launches; a result with text is stored; text over 4000 chars is a 400', async () => {
  await withServer({}, async ({ post, get, h }) => {
    const { id } = h.launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model: AGY_MODEL, prompt: 'hello' });
    const listed = (await get('/api/launches?state=pending')).body.pending.find((r) => r.id === id);
    assert.deepEqual([listed.origin, listed.model, listed.prompt], ['agy', AGY_MODEL, 'hello']);
    assert.equal((await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' })).status, 200);
    const tooBig = await post(`/api/launches/${id}/result`, { text: 'x'.repeat(4001) });
    assert.equal(tooBig.status, 400);
    assert.equal(h.launchBroker.get(id).state, 'claimed', 'a refused result leaves the record claimed');
    const ok = await post(`/api/launches/${id}/result`, { text: 'x'.repeat(4000) });
    assert.equal(ok.status, 204);
    assert.equal(h.launchBroker.get(id).text.length, 4000);
    assert.equal(h.launchBroker.get(id).state, 'done');
  });
});

test('agy launch: a shell-reported error fails the record without a launch.failed terminal event', async () => {
  await withServer({}, async ({ post, h, stateDir }) => {
    const { id } = h.launchBroker.enqueue({ origin: 'agy', command: 'agy', cwd: 'agy', model: AGY_MODEL, prompt: 'hello' });
    await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' });
    assert.equal((await post(`/api/launches/${id}/result`, { error: 'agy is not signed in for this Windows account' })).status, 204);
    assert.equal(h.launchBroker.get(id).state, 'failed');
    assert.equal(readEvents(stateDir).some((e) => e.kind === 'launch.failed'), false);
  });
});

test('service mode: a huddle second view goes through the launch queue to the shell, and the shell\'s text becomes the seat line', async () => {
  const stream = async ({ body, onText }) => {
    if (String(body.system).includes('hold the floor')) return { text: '{"speakers":["bill"],"reason":"r","ask":""}' };
    if (String(body.system).startsWith('Summarise')) return { text: 'Summary.' };
    onText?.('Short answer. ', 'Short answer. ');
    return { text: 'Short answer. Done.', ttftMs: 1, totalMs: 2 };
  };
  await withServer({}, async ({ post, get, h }) => {
    const start = await fetch(`http://127.0.0.1:${h.port}/api/huddle`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: '{}' }).then((r) => r.json());
    assert.deepEqual(start.personas.filter((p) => p.seat).map((p) => p.id), ['homer', 'guppy', 'medeiros'], 'no local agy dir is needed in service mode');
    await fetch(`http://127.0.0.1:${h.port}/api/huddle/${start.id}/say`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify({ text: 'Builder, how long would the dock take to build?' }) });
    let rec = null;
    for (let i = 0; i < 100 && !rec; i++) { rec = (await get('/api/launches?state=pending')).body.pending.find((r) => r.origin === 'agy'); if (!rec) await new Promise((r) => setTimeout(r, 20)); }
    assert.ok(rec, 'the second view was queued for the shell');
    assert.equal(rec.model, 'Gemini 3.8 Flash (Medium)');
    assert.match(rec.prompt, /Do NOT use any tools|Builder: Short answer\. Done\./);
    await post(`/api/launches/${rec.id}/claim`, { by: 'desktop-shell' });
    await post(`/api/launches/${rec.id}/result`, { text: 'It misses the permits.' });
    let snap = null;
    for (let i = 0; i < 100; i++) {
      snap = await fetch(`http://127.0.0.1:${h.port}/api/huddle/${start.id}`, { headers: { 'x-glmps-local-session': h.localSession } }).then((r) => r.json());
      if (snap.transcript.some((u) => u.speaker === 'homer')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const line = snap.transcript.find((u) => u.speaker === 'homer');
    assert.deepEqual([line.text, line.model], ['It misses the permits.', 'Gemini 3.8 Flash (Medium)']);
    await fetch(`http://127.0.0.1:${h.port}/api/huddle/${start.id}/end`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: '{}' });
  }, { serverOpts: { huddleStream: stream, huddleCliCheck: () => true } });
});

test('service mode: with no shell running the second view is an error line naming the desktop app, in about a claim wait, not a 30 s timeout', { timeout: 20000 }, async () => {
  const stream = async ({ body, onText }) => {
    if (String(body.system).includes('hold the floor')) return { text: '{"speakers":["bill"],"reason":"r","ask":""}' };
    if (String(body.system).startsWith('Summarise')) return { text: 'Summary.' };
    onText?.('Short answer. ', 'Short answer. ');
    return { text: 'Short answer. Done.', ttftMs: 1, totalMs: 2 };
  };
  await withServer({}, async ({ h }) => {
    const hdr = { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession };
    const start = await fetch(`http://127.0.0.1:${h.port}/api/huddle`, { method: 'POST', headers: hdr, body: '{}' }).then((r) => r.json());
    const t0 = Date.now();
    await fetch(`http://127.0.0.1:${h.port}/api/huddle/${start.id}/say`, { method: 'POST', headers: hdr, body: JSON.stringify({ text: 'Builder, how long would the dock take to build?' }) });
    let line = null;
    for (let i = 0; i < 300 && !line; i++) {
      const snap = await fetch(`http://127.0.0.1:${h.port}/api/huddle/${start.id}`, { headers: hdr }).then((r) => r.json());
      line = snap.transcript.find((u) => u.speaker === 'homer');
      if (!line) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(line?.error, 'an error line');
    assert.match(line.text, /no desktop shell picked this up within \d+ ms \(is the GLMPS 2\.0 desktop app running\?\)/);
    assert.ok(Date.now() - t0 < 12000, `took ${Date.now() - t0} ms`);
    await fetch(`http://127.0.0.1:${h.port}/api/huddle/${start.id}/end`, { method: 'POST', headers: hdr, body: '{}' });
  }, { serverOpts: { huddleStream: stream, huddleCliCheck: () => true } });
});

// The merge queue's git, gh and test runs: the service has no GitHub sign-in,
// so each is a 'gitops' record the desktop shell claims, runs and answers.
test('gitops launch: the record rides GET /api/launches with its op; a result object is stored; a malformed or oversize one is refused', async () => {
  await withServer({}, async ({ post, get, h }) => {
    const op = { kind: 'git', cwd: os.tmpdir(), args: ['status'], timeoutMs: 1000, roots: { repos: [], worktrees: os.tmpdir() }, maxOutput: 1000 };
    const { id } = h.launchBroker.enqueue({ origin: 'gitops', command: 'gitops git', cwd: os.tmpdir(), op });
    const listed = (await get('/api/launches?state=pending')).body.pending.find((r) => r.id === id);
    assert.deepEqual([listed.origin, listed.op], ['gitops', op]);
    assert.equal((await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' })).status, 200);
    assert.equal((await post(`/api/launches/${id}/result`, { result: 'nope' })).status, 400);
    assert.equal((await post(`/api/launches/${id}/result`, { result: { status: 'zero', stdout: '', stderr: '' } })).status, 400);
    assert.equal(h.launchBroker.get(id).state, 'claimed', 'a refused result leaves the record claimed');
    const ok = await post(`/api/launches/${id}/result`, { result: { status: 0, stdout: 'x'.repeat(100000), stderr: '', timedOut: false } });
    assert.equal(ok.status, 204);
    assert.equal(h.launchBroker.get(id).result.stdout.length, 100000);
    assert.equal(h.launchBroker.get(id).state, 'done');
  });
});

test('gitops launch: a shell-reported error fails the record without a launch.failed terminal event', async () => {
  await withServer({}, async ({ post, h, stateDir }) => {
    const { id } = h.launchBroker.enqueue({ origin: 'gitops', command: 'gitops git', cwd: os.tmpdir(), op: { kind: 'git', cwd: os.tmpdir(), args: ['push'] } });
    await post(`/api/launches/${id}/claim`, { by: 'desktop-shell' });
    assert.equal((await post(`/api/launches/${id}/result`, { error: 'refused by shell: git push is not allowed' })).status, 204);
    assert.equal(h.launchBroker.get(id).state, 'failed');
    assert.equal(readEvents(stateDir).some((e) => e.kind === 'launch.failed'), false);
  });
});

// card 87: the poll's editor field follows the board picker when no
// antigravityCommand is set by hand, and is re-read on every poll.
const pollBin = (rel) => path.win32.join('C:/Users/op', 'AppData/Local/Programs', rel);
const POLL_BIN = { antigravity: pollBin('Antigravity IDE/bin/antigravity-ide.cmd'), cursor: pollBin('cursor/resources/app/bin/cursor.cmd') };
const pollDetect = (...ids) => ({ home: 'C:/Users/op', programFiles: [], exists: (p) => ids.some((i) => POLL_BIN[i] === p) });

test('launch poll: editor is the IDE the picker names, and a picker change shows on the next poll', async () => {
  await withServer({}, async ({ get, stateDir }) => {
    runnerStore.saveConfig(stateDir, { openTarget: 'cursor' });
    assert.equal((await get('/api/launches?state=pending')).body.editor.command, POLL_BIN.cursor);
    runnerStore.saveConfig(stateDir, { openTarget: 'antigravity' });
    assert.equal((await get('/api/launches?state=pending')).body.editor.command, POLL_BIN.antigravity);
  }, { serverOpts: { editorDetect: pollDetect('antigravity', 'cursor') } });
});

test('launch poll: a hand-set antigravityCommand wins, and no installed IDE advertises editor null', async () => {
  await withServer({}, async ({ get }) => {
    assert.equal((await get('/api/launches?state=pending')).body.editor.command, 'my-editor');
  }, { config: { antigravityCommand: 'my-editor' }, serverOpts: { editorDetect: pollDetect('cursor') } });
  await withServer({}, async ({ get }) => {
    assert.equal((await get('/api/launches?state=pending')).body.editor, null);
  }, { serverOpts: { editorDetect: pollDetect() } });
});
