import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from '../server.js';
import * as runnerStore from '../lib/orchestration/runner-store.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { readEvents } from '../lib/observability/event-log.js';

// A pid that is guaranteed dead: run a trivial child to completion and reuse
// its pid. Picking an arbitrary number risks colliding with a live process and
// making the test flaky in the direction that hides a bug.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  return r.pid;
}

function tmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }

// A real, committed git repo whose basename is the backlog card's `project`.
function makeRepo({ withOrigin = false } = {}) {
  const repo = tmp('mc-wtrepo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  if (withOrigin) {
    // A merged branch is judged against origin/*, so a checkout that is reclaimed
    // on the strength of being merged needs a remote whose main holds its head.
    const origin = tmp('mc-wtorigin-');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    git(repo, 'branch', '-M', 'main');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  }
  return repo;
}

async function withRepoServer(fn, repoOpts = {}) {
  const repo = makeRepo(repoOpts);
  const project = path.basename(repo);
  const stateDir = tmp('mc-wt-state-');
  const claudeDir = tmp('mc-wt-claude-');
  // repoForProject discovers roots from settings.additionalDirectories.
  fs.writeFileSync(path.join(claudeDir, 'settings.json'),
    JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  // DRYRUN skips the real terminal/editor launch but the worktree git ops still run.
  // pollMs is fast (not the 1000ms default) so a test that plants a fake
  // session-registry entry mid-test does not need a long real-time wait for the
  // discovery poll loop to pick it up (same pattern as server.integration.test.js).
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1', GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, pollMs: 25, env, configFile: path.join(stateDir, 'no-config.json') });
  const base = `http://127.0.0.1:${h.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const api = {
    get: (p) => j(p),
    post: (p, o) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }),
    patch: (p, o) => j(p, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }),
  };
  try { await fn({ ...api, h, repo, project, stateDir, claudeDir }); }
  finally {
    await h.close?.();
    // Best-effort teardown: on Windows the runner's `git worktree` ops can leave a
    // git.exe handle on `repo` that outlives close() past the retry window, so temp
    // removal must never fail an already-passed test. GLMPS_UNMERGED_SCAN=off (above)
    // removes the boot-scan handle source; this swallows any residual worktree-op one.
    for (const d of [repo, stateDir, claudeDir]) {
      try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  }
}

test('a launched job runs in its own git worktree, not the shared repo (useWorktrees)', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();

    const entry = (await get('/api/runner')).body.ledger[card.id];
    assert.ok(entry, 'card was claimed');
    assert.ok(entry.worktree, 'ledger records the worktree');
    const wt = entry.worktree.dir;
    assert.notEqual(path.resolve(wt), path.resolve(repo), 'worktree is isolated from the repo root');
    assert.ok(fs.existsSync(wt), 'worktree dir exists on disk');
    assert.ok(fs.existsSync(path.join(wt, '.git')), 'worktree is a real git worktree');
    // The seeded README from the repo is present in the isolated checkout.
    assert.ok(fs.existsSync(path.join(wt, 'README.md')));
    // The job's branch is checked out there.
    const branches = git(repo, 'branch', '--list', 'glmps-runner/*');
    assert.match(branches, /glmps-runner\//);
  });
});

test('a launched job branches from the freshly fetched upstream, not the stale local HEAD (glmps-2-0-41)', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    // The runner's repo tracks an upstream that has moved on since the last pull.
    const upstream = makeRepo();
    try {
      git(repo, 'remote', 'add', 'origin', upstream);
      git(repo, 'fetch', '-q', 'origin');
      const upBranch = git(upstream, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
      git(repo, 'branch', '-q', '-u', `origin/${upBranch}`);
      fs.writeFileSync(path.join(upstream, 'merged-later.txt'), 'x\n');
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-q', '-m', 'merged after the local checkout last pulled');
      const fresh = git(upstream, 'rev-parse', 'HEAD').trim();

      await post('/api/runner/config', { enabled: true, useWorktrees: true });
      const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-fresh', prompt: 'do it', project });
      await h.runnerTick();

      const entry = (await get('/api/runner')).body.ledger[card.id];
      assert.ok(entry?.worktree, 'card was claimed into a worktree');
      assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), fresh, 'worktree starts at the upstream tip');
      assert.ok(fs.existsSync(path.join(entry.worktree.dir, 'merged-later.txt')));
    } finally {
      try { fs.rmSync(upstream, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  });
});

// The live clone sits on a detached HEAD because its main is checked out by
// the service's own worktree, so it has no @{upstream} (card glmps-2-0-159).
test('a detached clone branches from the remote default branch, not its stale HEAD', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    const upstream = makeRepo();
    try {
      git(repo, 'remote', 'add', 'origin', upstream);
      git(repo, 'fetch', '-q', 'origin');
      git(repo, 'remote', 'set-head', 'origin', '-a');
      git(repo, 'checkout', '-q', '--detach');
      fs.writeFileSync(path.join(upstream, 'merged-later.txt'), 'x\n');
      git(upstream, 'add', '.');
      git(upstream, 'commit', '-q', '-m', 'merged after the clone last moved');
      const fresh = git(upstream, 'rev-parse', 'HEAD').trim();

      await post('/api/runner/config', { enabled: true, useWorktrees: true });
      const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-detached', prompt: 'do it', project });
      await h.runnerTick();

      const entry = (await get('/api/runner')).body.ledger[card.id];
      assert.ok(entry?.worktree, 'card was claimed into a worktree');
      assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), fresh, 'worktree starts at the remote default tip');
    } finally {
      try { fs.rmSync(upstream, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    }
  });
});

test('a repo with no upstream still launches from its local HEAD (glmps-2-0-41 fallback)', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-local', prompt: 'do it', project });
    await h.runnerTick();
    const entry = (await get('/api/runner')).body.ledger[card.id];
    assert.ok(entry?.worktree, 'launch is not blocked by the missing upstream');
    assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), head);
  });
});

test('a live agent keeps its worktree checkout even after its card leaves the ledger', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;
    assert.ok(fs.existsSync(wt));

    // The agent self-reports done, which it does BEFORE it exits, so its
    // process is still live and still holding that checkout. Under DRYRUN the
    // recorded pid is this test process, which models exactly that. Reclaiming
    // here used to run `git worktree remove --force` under a working agent and
    // destroy uncommitted work.
    await patch(`/api/backlog/${card.id}`, { labels: ['agent:done'] });
    await h.runnerTick();

    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'ledger entry cleared');
    assert.ok(fs.existsSync(wt), 'a live agent keeps its checkout');
    assert.match(git(repo, 'branch', '--list', 'glmps-runner/*'), /glmps-runner\//);
  });
});

test('the worktree checkout is reclaimed once its agent is gone, and the branch survives', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project, stateDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;
    assert.ok(fs.existsSync(wt));

    // Stamp a provably-dead pid so reconcile sees the agent as gone. DRYRUN
    // otherwise records this test's own (very much alive) pid.
    const ledger = runnerStore.loadLedger(stateDir);
    ledger[card.id] = { ...ledger[card.id], pid: deadPid() };
    runnerStore.saveLedger(stateDir, ledger);

    await patch(`/api/backlog/${card.id}`, { labels: ['agent:done'] });
    await h.runnerTick();

    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'ledger entry cleared');
    assert.ok(!fs.existsSync(wt), 'worktree checkout reclaimed once the agent is gone');
    // Branch survives so any committed work is recoverable.
    assert.match(git(repo, 'branch', '--list', 'glmps-runner/*'), /glmps-runner\//);
  }, { withOrigin: true });
});

// D27 C2: an idle card is reopenable, so its worktree is leased by
// the retention rule EVEN with the agent provably gone - the exact shape the
// test above proves gets reclaimed for a non-idle card. `idle` is a FINISHED
// state (queue-runner.js), so the ledger entry departs on the very next
// reconcile regardless of pid liveness; only the retention check should be
// standing between that departure and a reclaimed checkout.
test('an idle card keeps its worktree checkout across a reconcile, even with the agent provably gone (D27 C2 retention)', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project, stateDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;
    assert.ok(fs.existsSync(wt));

    const ledger = runnerStore.loadLedger(stateDir);
    ledger[card.id] = { ...ledger[card.id], pid: deadPid() };
    runnerStore.saveLedger(stateDir, ledger);

    await patch(`/api/backlog/${card.id}`, { state: 'idle' });
    await h.runnerTick();

    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'ledger entry cleared');
    assert.ok(fs.existsSync(wt), 'an idle card keeps its worktree checkout, so a reply can resume in it');
    const events = readEvents(stateDir).filter((e) => e.kind === 'worktree.reclaim' && e.label === String(card.id));
    assert.equal(events.length, 1, 'exactly one reclaim decision was recorded for this job');
    assert.equal(events[0].op, 'retained');
  });
});

// Plants a fake claude-code session-registry entry (same shape and pattern as
// server.integration.test.js's mkEnv) so discoverClaudeSessions finds a LIVE
// session whose cwd is the worktree dir under test, then polls /api/state
// (bounded, not a fixed sleep) until the poll loop (pollMs: 25 in
// withRepoServer) has actually picked it up. Returns the discovered summary
// row, or null if the harness never surfaced it inside the budget.
async function waitForLiveSessionCwd(get, sessionId, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await get('/api/state');
    const s = (body.sessions ?? []).find((x) => x.id === sessionId);
    if (s && s.cwd) return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

test('a live agent keeps its checkout even when the runner HOLDS its job (glmps-53)', async () => {
  await withRepoServer(async ({ get, post, h, repo, project, stateDir, claudeDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;
    assert.ok(fs.existsSync(wt));

    // ledger: pid null (an editor launch, per launchSession), startedAt far
    // enough back that maxRuntimeMs is blown and retries already at the
    // ceiling, so the very next reconcile produces `hold` (not `requeue`) and
    // drops the entry from the ledger. This is the exact shape from the
    // glmps-59 card activity: requeued twice, then held, then
    // (before this fix) reclaimed out from under the live agent.
    const ledger = runnerStore.loadLedger(stateDir);
    ledger[card.id] = { ...ledger[card.id], pid: null, retries: 999, startedAt: Date.now() - 24 * 60 * 60 * 1000 };
    runnerStore.saveLedger(stateDir, ledger);

    // sessions: one non-ended session whose cwd IS the job's worktree dir,
    // the occupancy signal the sweeper already used and the reclaim path
    // never consulted before this fix.
    const projDir = path.join(claudeDir, 'projects', 'reclaim-test');
    fs.mkdirSync(projDir, { recursive: true });
    const transcript = path.join(projDir, 'live-agent-1.jsonl');
    fs.writeFileSync(transcript, '');
    fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
      { sessionId: 'live-agent-1', ppid: process.pid, cwd: wt, transcriptPath: transcript, ts: Date.now() },
    ]));
    const seen = await waitForLiveSessionCwd(get, 'live-agent-1');
    assert.ok(seen, 'harness precondition: the fake session must be discovered before the reclaim tick runs');
    assert.equal(seen.state, 'working', 'precondition: the session reads as non-ended, matching a live agent');

    await h.runnerTick();

    // EXPECT: after runnerTick(), the worktree directory still exists on disk,
    // and a worktree.reclaim event with op 'occupied' was recorded.
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'the job WAS held and left the ledger');
    // Re-check the precondition on the OTHER side of the tick before judging the
    // fix. The occupancy signal is discovered by a background poll, so a loaded
    // box can drop it between the assert above and the tick; without this the
    // test would report "the fix does not work" when what actually happened is
    // "the harness stopped presenting a live session". A flaky guard test is how
    // a real regression in this protection would go unnoticed.
    const stillSeen = (await get('/api/state')).body.sessions?.find((x) => x.id === 'live-agent-1');
    assert.ok(stillSeen && stillSeen.state !== 'ended',
      'harness precondition: the fake session must still read as live at reclaim time');
    assert.ok(fs.existsSync(wt), 'a live agent keeps its checkout even though its job left the ledger');
    const events = readEvents(stateDir).filter((e) => e.kind === 'worktree.reclaim' && e.label === String(card.id));
    assert.equal(events.length, 1, 'exactly one reclaim decision was recorded for this job');
    assert.equal(events[0].op, 'occupied');
    assert.equal(events[0].path, wt);
  });
});

test('single-lane default (no useWorktrees, maxConcurrent 1) launches in the repo itself', async () => {
  await withRepoServer(async ({ get, post, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const entry = (await get('/api/runner')).body.ledger[card.id];
    assert.ok(entry, 'card was claimed');
    assert.equal(entry.worktree ?? null, null, 'no worktree at single-lane default');
    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1, 'repo has no extra worktrees');
  });
});

// M1 + M3: a resume with no kept worktree (here: no
// runSession recorded at all) must not silently isolate a BRAND NEW checkout
// for it - useWorktrees:true means the ordinary isolate branch would
// otherwise create one before launchJob ever reaches the resume check. The
// fix removes that orphan checkout before failing, so a failed resume leaves
// no trace in `git worktree list`.
test('relaunchJobNow with resume and no kept worktree removes any freshly created checkout before failing (M1, M3)', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await patch(`/api/backlog/${card.id}`, { state: 'idle' });

    const r = await h.relaunchJobNow(card.id, { resume: { sessionId: '44444444-5555-4333-8444-555555555555' }, note: 'x', reason: null });
    assert.equal(r.ok, false);
    assert.match(r.reason, /launch failed/);

    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1, 'no orphan worktree left behind by the failed resume');
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'nothing launched');
  });
});

// a branch-c (non-resume) relaunch can ALSO create a fresh
// worktree (the `kept` reuse block does not apply - there is no runSession
// to reuse), and a throw further down launchJob (writePrompt or
// launchSession are the realistic candidates) must not leave THAT checkout
// orphaned either - the round-1 cleanup only covered the resume-specific
// throw. fs.writeFileSync is mocked to throw for exactly this card's prompt
// file, matching the write's own destination path rather than a call count
// (same technique as the carry-in dispatch test in runner-endpoints.test.js).
test('relaunchJobNow branch-c relaunch removes a freshly created worktree when writePrompt throws afterward (M3, fix round 2)', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await patch(`/api/backlog/${card.id}`, { state: 'idle' });

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, ...rest) => {
      if (typeof file === 'string' && file.endsWith(`${card.id}.prompt.md`)) throw new Error('ENOSPC: simulated');
      return origWrite.call(fs, file, data, ...rest);
    };
    let r;
    try {
      r = await h.relaunchJobNow(card.id, { resume: null, note: 'x', reason: 'its worktree is gone' });
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.equal(r.ok, false);
    assert.match(r.reason, /launch failed/);
    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1, 'the freshly created worktree was removed on rollback');
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'nothing launched');
  });
});

// M-b: writeDeclared runs between writePrompt and launchSession
// and was the one remaining unguarded write in launchJob that can plausibly
// throw (a full disk, a permissions error) - guarded like writePrompt so it
// too cleans up a freshly-created worktree on rollback, not just the two
// round-2 call sites.
test('relaunchJobNow branch-c relaunch removes a freshly created worktree when writeDeclared throws afterward (M-b, fix round 3)', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await patch(`/api/backlog/${card.id}`, { state: 'idle' });

    const origWrite = fs.writeFileSync;
    fs.writeFileSync = (file, data, ...rest) => {
      if (typeof file === 'string' && file.endsWith(path.join('workspace', `${card.id}.json.tmp`))) throw new Error('ENOSPC: simulated');
      return origWrite.call(fs, file, data, ...rest);
    };
    let r;
    try {
      r = await h.relaunchJobNow(card.id, { resume: null, note: 'x', reason: 'its worktree is gone' });
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.equal(r.ok, false);
    assert.match(r.reason, /launch failed/);
    assert.equal(git(repo, 'worktree', 'list').trim().split('\n').length, 1, 'the freshly created worktree was removed on rollback');
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'nothing launched');
  });
});

// Phase C final review, M7 (first half): the old rollback spliced the WHOLE
// pre-launch card snapshot back in on any launchJob throw, which discards any
// OTHER field that changed on the card WHILE launchJob was running (a devlog
// line, say) - not just the state/stamps this call itself touched. Here the
// prompt-file write throws (same PRE-spawn failure as the M3 test above), but
// the mocked write ALSO lands one genuine devlog line on the card first,
// simulating something else touching the card mid-launch. Only a
// field-scoped rollback (state + stamps) survives that line; a whole-snapshot
// splice back to the pre-launch `job` object would silently erase it.
test('relaunchJobNow restores only state and its stamps on rollback, never a stale whole-card snapshot (M7)', async () => {
  await withRepoServer(async ({ get, post, patch, h, repo, project, stateDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await patch(`/api/backlog/${card.id}`, { state: 'idle' });

    const origWrite = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = (file, data, ...rest) => {
      if (typeof file === 'string' && file.endsWith(`${card.id}.prompt.md`)) {
        if (!injected) {
          injected = true;
          backlogStore.appendDevLogIn(stateDir, card.id, { by: 'test', text: 'a concurrent devlog line landed mid-launch' });
        }
        throw new Error('ENOSPC: simulated');
      }
      return origWrite.call(fs, file, data, ...rest);
    };
    let r;
    try {
      r = await h.relaunchJobNow(card.id, { resume: null, note: 'x', reason: 'its worktree is gone' });
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.equal(r.ok, false);
    assert.match(r.reason, /launch failed/);
    const after = (await get('/api/backlog')).body.items.find((i) => i.id === card.id);
    assert.equal(after.state, 'idle', 'state rolled back correctly');
    assert.ok(after.devLog.some((d) => d.text === 'a concurrent devlog line landed mid-launch'), 'a field this rollback did not touch must survive it');
    void repo;
  });
});

// Phase C final review, M7 (second half): a POST-spawn bookkeeping write
// (applyLabelDeltaIn, right after launchSession) failing must not roll the
// card back to idle - the session is ALREADY running by then, and a rollback
// here would leave a real, unrecorded session next to a card that claims
// nothing is happening, inviting a second launch into the same worktree.
// Only the SECOND write to the backlog store within this call is made to
// throw (the first is the state->in_progress transition, which must
// succeed), so the mocked failure lands exactly on the first post-spawn
// write, after the dry-run "spawn" above it has already returned a pid.
test('relaunchJobNow records the launch even when its own post-spawn bookkeeping write fails (M7)', async () => {
  await withRepoServer(async ({ get, post, patch, h, project }) => {
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await patch(`/api/backlog/${card.id}`, { state: 'idle' });

    const origWrite = fs.writeFileSync;
    let storeWrites = 0;
    fs.writeFileSync = (file, data, ...rest) => {
      if (typeof file === 'string' && file.endsWith(path.join('backlog', `store.json.${process.pid}.tmp`))) {
        storeWrites += 1;
        if (storeWrites === 2) throw new Error('EIO: simulated post-spawn bookkeeping failure');
      }
      return origWrite.call(fs, file, data, ...rest);
    };
    let r;
    try {
      r = await h.relaunchJobNow(card.id, { resume: null, note: 'x', reason: null });
    } finally {
      fs.writeFileSync = origWrite;
    }
    assert.equal(r.ok, true, 'the session really launched - this must not read as a failure');
    const runner = (await get('/api/runner')).body;
    assert.ok(runner.ledger[card.id], 'the ledger entry is recorded despite the bookkeeping failure');
    const after = (await get('/api/backlog')).body.items.find((i) => i.id === card.id);
    assert.equal(after.state, 'in_progress', 'never rolled back to idle with a session actually running');
  });
});

test('a leftover job branch holding unmerged commits is reused, not reset, and the card devlog says so', async () => {
  await withRepoServer(async ({ get, post, h, repo, project, stateDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-reuse', prompt: 'do it', project });
    const branch = `glmps-runner/${project.replace(/[^A-Za-z0-9._-]/g, '-')}/${card.id}`;
    // A crashed earlier run left the branch with a commit the start point does not have.
    git(repo, 'checkout', '-q', '-b', branch);
    fs.writeFileSync(path.join(repo, 'agent.txt'), 'agent work\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'agent work from the crashed run');
    const work = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', '-q', 'main');

    await h.runnerTick();

    const entry = (await get('/api/runner')).body.ledger[card.id];
    assert.ok(entry?.worktree, 'the card was claimed into a worktree');
    assert.equal(git(entry.worktree.dir, 'rev-parse', 'HEAD').trim(), work, 'the agent commit was not reset away');
    const log = backlogStore.load(stateDir).items.find((i) => i.id === card.id).devLog.map((d) => d.text).join('\n');
    assert.match(log, /already held commits that its start point lacks; reused as it is/);
  }, { withOrigin: true });
});

const devLogOf = (stateDir, id) => backlogStore.load(stateDir).items.find((i) => i.id === id).devLog.map((d) => d.text).join('\n');

test('a worktree that cannot be created holds the card instead of launching into the shared repo', async () => {
  await withRepoServer(async ({ get, post, h, project, stateDir }) => {
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-wt-fail', prompt: 'do it', project });
    // A non-empty directory where the worktree belongs makes `git worktree add` fail.
    const blocked = path.join(stateDir, 'runner', 'worktrees', project, card.id);
    fs.mkdirSync(blocked, { recursive: true });
    fs.writeFileSync(path.join(blocked, 'squatter.txt'), 'x\n');
    await post('/api/runner/config', { enabled: true, useWorktrees: true });

    await h.runnerTick();

    const now = backlogStore.load(stateDir).items.find((i) => i.id === card.id);
    assert.equal(now.state, 'held', 'the card is held, not launched');
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'no ledger slot is left behind');
    assert.match(devLogOf(stateDir, card.id), /no worktree could be created.*git worktree add exited/);
    assert.match(devLogOf(stateDir, card.id), /not launched into the shared repo/);

    const before = now.devLog.length;
    await h.runnerTick();
    assert.equal(backlogStore.load(stateDir).items.find((i) => i.id === card.id).devLog.length, before, 'a held card is not retried every tick');
  });
});

test('a branch already checked out in another worktree names that worktree and holds the card', async () => {
  await withRepoServer(async ({ get, post, h, repo, project, stateDir }) => {
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-wt-owned', prompt: 'do it', project });
    const owner = path.join(tmp('mc-wtowner-'), 'owner');
    git(repo, 'worktree', 'add', '-q', '-B', `glmps-runner/${project}/${card.id}`, owner);
    await post('/api/runner/config', { enabled: true, useWorktrees: true });

    await h.runnerTick();

    const log = devLogOf(stateDir, card.id);
    assert.equal(backlogStore.load(stateDir).items.find((i) => i.id === card.id).state, 'held');
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined);
    assert.ok(log.includes(path.basename(owner)), `devlog names the owning worktree: ${log}`);
    assert.match(log, /another session likely owns this card/);
    try { fs.rmSync(path.dirname(owner), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  });
});

test('a card filed as in_progress is never launched by the runner', async () => {
  await withRepoServer(async ({ get, post, h, project, stateDir }) => {
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['x'], title: 'job-self-owned', prompt: 'mine', project, state: 'in_progress' });
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    await h.runnerTick();
    assert.equal((await get('/api/runner')).body.ledger[card.id], undefined);
    assert.equal(backlogStore.load(stateDir).items.find((i) => i.id === card.id).state, 'in_progress');
  });
});

// glmps-87: the 2026-08-29 shape. The session is open but idle, so
// session discovery shows nobody in the checkout; the job times out and is
// held; the branch carries committed work and the worktree is still listed. On
// Windows the reclaim's non-forced `git worktree remove` emptied the checkout
// and dropped it from the list under the live session. The OS still knows a
// process is sitting in it, and that is the answer the reclaim must take.
test('a held job whose idle session still sits in the checkout is never reclaimed (glmps-87)', { skip: !['win32', 'linux'].includes(process.platform) && 'no occupancy probe on this platform' }, async () => {
  const { spawn } = await import('node:child_process');
  const { reclaimMarkerPath } = await import('../lib/orchestration/worktree-occupancy.js');
  await withRepoServer(async ({ get, post, h, repo, project, stateDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;
    fs.mkdirSync(path.join(wt, 'server', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'server', 'lib', 'work.js'), 'committed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'agent work');
    // Everything pushed, as glmps-84's was: the outcome gate has no
    // unpushed work to refuse on, so only occupancy stands in the way.
    git(wt, 'push', '-q', '-u', 'origin', `glmps-runner/${project}/${card.id}`);

    const ledger = runnerStore.loadLedger(stateDir);
    ledger[card.id] = { ...ledger[card.id], pid: null, retries: 999, startedAt: Date.now() - 24 * 60 * 60 * 1000 };
    runnerStore.saveLedger(stateDir, ledger);

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: wt, stdio: 'ignore', windowsHide: true });
    await new Promise((r) => child.once('spawn', r));
    try {
      const live = (await get('/api/state')).body.sessions?.filter((s) => s.state !== 'ended' && s.cwd) ?? [];
      assert.equal(live.length, 0, 'precondition: session discovery sees nobody in the checkout');
      await h.runnerTick();
      await h.runnerTick();

      assert.equal((await get('/api/runner')).body.ledger[card.id], undefined, 'the job WAS held and left the ledger');
      assert.ok(fs.existsSync(path.join(wt, 'server', 'lib', 'work.js')), 'the checkout keeps its files');
      assert.ok(git(repo, 'worktree', 'list', '--porcelain').includes(`glmps-runner/${project}/${card.id}`), 'the worktree is still listed');
      const events = readEvents(stateDir).filter((e) => e.kind === 'worktree.reclaim' && e.label === String(card.id));
      assert.deepEqual(events.map((e) => e.op), ['in-use']);
      assert.equal(fs.existsSync(reclaimMarkerPath(wt)), false, 'nothing was reclaimed, so no marker');
    } finally {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
  }, { withOrigin: true });
});

test('a reclaim that proceeds leaves a marker beside the checkout naming what took it (glmps-87)', async () => {
  const { reclaimMarkerPath } = await import('../lib/orchestration/worktree-occupancy.js');
  await withRepoServer(async ({ get, post, patch, h, project, stateDir }) => {
    await post('/api/runner/config', { enabled: true, useWorktrees: true });
    const { body: card } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'job-a', prompt: 'do a', project });
    await h.runnerTick();
    const wt = (await get('/api/runner')).body.ledger[card.id].worktree.dir;

    const ledger = runnerStore.loadLedger(stateDir);
    ledger[card.id] = { ...ledger[card.id], pid: deadPid() };
    runnerStore.saveLedger(stateDir, ledger);
    await patch(`/api/backlog/${card.id}`, { labels: ['agent:done'] });
    await h.runnerTick();

    assert.ok(!fs.existsSync(wt), 'checkout reclaimed once the agent is gone');
    const marker = JSON.parse(fs.readFileSync(reclaimMarkerPath(wt), 'utf8'));
    assert.equal(marker.by, 'runner-reclaim');
    assert.equal(marker.outcome, 'removed');
    assert.equal(marker.dir, wt);
  }, { withOrigin: true });
});
