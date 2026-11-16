import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import * as backlogStore from '../lib/orchestration/backlog-store.js';
import { saveLedger } from '../lib/orchestration/runner-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function git(repo, ...args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }); }

// A real, committed git repo (runner-worktree.test.js's own fixture pattern),
// so `git worktree add`/`list` are exercised against real git, never faked -
// deletion safety here rests on git's own ground truth, not on a stub.
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

// Every startServer() call isolates GLMPS_CLAUDE_DIR too (fixtures/claude-dir.js
// - no-ambient-claude-dir.test.js's own guard), so this suite never reads the
// operator's real ~/.claude. Returns the claudeDir alongside the boot handle
// so the caller's finally can sweep it.
async function bootPurgeServer(stateDir, extraEnv = {}) {
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off', ...extraEnv };
  // pollMs: 25 (not the 1000ms default) so a fake session-registry entry
  // planted mid-test (C1's live-session fixture) is discovered inside a
  // short bounded wait, matching runner-worktree.test.js's own pattern.
  const h = await startServer({ port: 0, pollMs: 25, env, configFile: path.join(stateDir, 'no-config.json') });
  const post = async (p) => { const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method: 'POST' }); return { status: r.status, body: await r.json() }; };
  const get = async (p) => { const r = await fetch(`http://127.0.0.1:${h.port}${p}`); return { status: r.status, body: await r.json() }; };
  return { h, post, get, claudeDir };
}

// Plants a fake claude-code session-registry entry (runner-worktree.test.js's
// own pattern) and polls /api/state (bounded, not a fixed sleep) until the
// discovery poll loop has actually picked it up.
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

// Minor (fold): teardown failures are logged, not silently swallowed - the
// brief's own Step 1 test already does this for stateDir; shared here so
// every added test does the same for every temp dir it made.
function rmAll(dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (e) { console.warn(`teardown: could not remove ${d}: ${e.message}`); }
  }
}

function gitWorktreeRemoveQuiet(repo, dir) {
  try { git(repo, 'worktree', 'remove', '--force', dir); }
  catch (e) { console.warn(`teardown: git worktree remove ${dir} failed: ${e.message}`); }
}

function plantLiveSession(claudeDir, { sessionId, cwd }) {
  const projDir = path.join(claudeDir, 'projects', 'purge-live-test');
  fs.mkdirSync(projDir, { recursive: true });
  const transcript = path.join(projDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), JSON.stringify([
    { sessionId, ppid: process.pid, cwd, transcriptPath: transcript, ts: Date.now() },
  ]));
}

test('purge-worktree: 404 without a worktree, 409 while running, 409 when git refuses', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-'));
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-wt-'));
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'purge me' }).item.id;
    let r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.deepEqual([r.status, r.body.error], [404, 'no worktree recorded for this card']);
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir: notARepo, branch: 'x', repo: notARepo } });
    saveLedger(stateDir, { [id]: { pid: null, startedAt: Date.now(), retries: 0 } });
    r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.deepEqual([r.status, r.body.error], [409, 'the job is running']);
    saveLedger(stateDir, {});
    r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /^git refused/);
    assert.equal(backlogStore.load(stateDir).items.find((i) => i.id === id).runSession.purgedTs, undefined);
  } finally {
    await h.close?.();
    try { fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.warn(`teardown: ${e.message}`); }
    try { fs.rmSync(claudeDir, { recursive: true, force: true }); } catch (e) { console.warn(`teardown: could not remove ${claudeDir}: ${e.message}`); }
  }
});

// Deletion safety's positive case: the checks above must not ALSO block the
// worktree they exist to let through. A real `git worktree add`, registered
// under the default worktreesDir (stateDir/runner/worktrees), with no ledger
// entry - purge actually removes it.
test('purge-worktree: a real, registered runner worktree with no ledger entry is removed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-ok-'));
  const repo = makeRepo();
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    // the registration gate now requires the branch's OWN
    // embedded job id to equal this card's id, so the worktree is created
    // AFTER the card, on a branch naming the card's real id (matching
    // worktreePlan's own glmps-runner/<project>/<jobId> convention).
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'purge real' }).item.id;
    const dir = path.join(stateDir, 'runner', 'worktrees', 'p', id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${id}`, dir);
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir, branch: `glmps-runner/p/${id}`, repo } });
    const r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.deepEqual(r, { status: 200, body: { ok: true, removed: true } });
    assert.equal(fs.existsSync(dir), false, 'the worktree directory is gone from disk');
    const item = backlogStore.load(stateDir).items.find((i) => i.id === id);
    assert.equal(typeof item.runSession.purgedTs, 'number');
    assert.ok(item.devLog.some((d) => /worktree purged/.test(d.text)), 'the purge is recorded on the card');
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, claudeDir]);
  }
});

// Ground truth over the card's own record: the repo root itself is a REAL,
// existing directory that `git worktree list` genuinely reports (as the main
// worktree) - but never on a glmps-runner/* branch, so it must never be
// treated as a purgeable runner worktree, even though it "resolves" (it IS
// the repo).
test('purge-worktree: 404 when the recorded worktree is not registered as a runner worktree of that repo', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-notreg-'));
  const repo = makeRepo();
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'not a runner worktree' }).item.id;
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir: repo, branch: 'main', repo } });
    const r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not registered as a runner worktree/);
    assert.ok(fs.existsSync(repo), 'the repo itself was never touched');
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, claudeDir]);
  }
});

// A worktree can be perfectly real and genuinely registered on a
// glmps-runner/* branch, and still be OUTSIDE the configured runner
// worktrees directory (e.g. a hand-made worktree elsewhere) - that still
// gets a 404, never a delete.
test('purge-worktree: 404 when the recorded worktree resolves outside the configured runner worktrees directory', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-outside-'));
  const repo = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-outside-wt-'));
  fs.rmdirSync(outside); // `git worktree add` requires a non-existent target
  // The configured worktrees directory exists (an ordinary runner has used
  // it before) but this particular worktree was never made inside it - the
  // resolution-failure path (a worktreesDir that does not exist AT ALL,
  // itself a named 404) is a separate case, not this one.
  fs.mkdirSync(path.join(stateDir, 'runner', 'worktrees'), { recursive: true });
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    // branch job id must equal the card's real id.
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'outside worktreesDir' }).item.id;
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${id}`, outside);
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir: outside, branch: `glmps-runner/p/${id}`, repo } });
    const r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /outside the runner worktrees directory/);
    assert.ok(fs.existsSync(outside), 'the out-of-scope worktree was never touched');
  } finally {
    await h.close?.();
    gitWorktreeRemoveQuiet(repo, outside);
    rmAll([stateDir, repo, outside, claudeDir]);
  }
});

// Minor (fold): a named 404 (and a reportMiss, for observability) when the
// configured runner worktrees directory cannot be resolved at all - not the
// silent "fall back to the raw, unresolved path" the bare catch used to do.
// A worktree the card names as real and registered cannot be proven
// contained in a base that does not even exist, so this is refused exactly
// like "outside", not treated as a pass-through.
test('purge-worktree: 404 (named reason) when the configured runner worktrees directory cannot be resolved at all', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-nobase-'));
  const repo = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-nobase-wt-'));
  fs.rmdirSync(outside);
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'no worktreesDir at all' }).item.id;
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${id}`, outside);
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir: outside, branch: `glmps-runner/p/${id}`, repo } });
    // stateDir/runner/worktrees was never created - nothing has ever isolated
    // a worktree under THIS state dir.
    assert.equal(fs.existsSync(path.join(stateDir, 'runner', 'worktrees')), false, 'precondition: worktreesDir does not exist');
    const r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /could not be resolved/);
    assert.ok(fs.existsSync(outside), 'the worktree was never touched');
  } finally {
    await h.close?.();
    gitWorktreeRemoveQuiet(repo, outside);
    rmAll([stateDir, repo, outside, claudeDir]);
  }
});

// the route used to check ONLY the runner ledger.
// A card reaches done/idle (leaving the ledger) while its agent is still
// alive in the checkout - reconcileNow itself never reclaims on the ledger
// signal alone either, for exactly this reason. A live, non-ended session
// whose cwd sits inside the worktree must refuse the purge, the same
// occupancy signal reconcileNow's own departed-loop check already uses.
test('purge-worktree: 409 (named reason) when a live session is working inside the worktree; nothing removed', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-live-'));
  const repo = makeRepo();
  const { h, post, get, claudeDir } = await bootPurgeServer(stateDir);
  try {
    // the worktree is made AFTER the card, on a branch
    // naming the card's real id - a hardcoded, unrelated job id (job-live)
    // would make reverting C1 alone answer I2's 404 instead of a 200,
    // hiding the very regression this test exists to catch.
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'live agent' }).item.id;
    const dir = path.join(stateDir, 'runner', 'worktrees', 'p', id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${id}`, dir);
    backlogStore.updateItemIn(stateDir, id, { state: 'done' });
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir, branch: `glmps-runner/p/${id}`, repo } });

    plantLiveSession(claudeDir, { sessionId: 'live-agent-purge', cwd: dir });
    const seen = await waitForLiveSessionCwd(get, 'live-agent-purge');
    assert.ok(seen, 'harness precondition: the fake session must be discovered before the purge runs');

    const r = await post(`/api/backlog/${id}/purge-worktree`);
    // Re-check the precondition on the OTHER side of the request before
    // judging the fix (runner-worktree.test.js's own pattern for this exact
    // class of flake): the occupancy signal is discovered by a background
    // poll, so a loaded box can drop it between the assert above and the
    // request.
    const stillSeen = (await get('/api/state')).body.sessions?.find((x) => x.id === 'live-agent-purge');
    assert.ok(stillSeen && stillSeen.state !== 'ended', 'harness precondition: the fake session must still read as live at purge time');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /live session/);
    assert.ok(fs.existsSync(dir), 'a live agent keeps its checkout; the purge must refuse rather than delete it');
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, claudeDir]);
  }
});

// the occupancy check used to compare a session's cwd
// against realDir only, while reconcileNow's own reclaimVerdict compares
// against the UNRESOLVED wt.dir. With a junction (or symlink) on the
// worktrees directory itself, a live agent launched with the cwd it was
// actually given - the RAW, unresolved path - never matches realDir, so
// the purge proceeded. The fix checks BOTH wt.dir and realDir, and
// realpaths the session's own cwd too, so a mismatch in either direction
// is caught.
test('purge-worktree: 409 when a live session\'s cwd reaches the worktree only through a junction on the worktrees directory', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-junc-'));
  const repo = makeRepo();
  // The REAL, physical location worktrees actually live under.
  const realBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-junc-real-'));
  // GLMPS_WORKTREES_DIR itself is a junction pointing at that real location -
  // every worktree's RECORDED (raw) path is under the junction, never under
  // realBaseDir directly.
  const worktreesDir = path.join(stateDir, 'runner', 'worktrees');
  fs.mkdirSync(path.dirname(worktreesDir), { recursive: true });
  try {
    fs.symlinkSync(realBaseDir, worktreesDir, 'junction');
  } catch (e) {
    t.skip(`cannot create a directory junction on this host: ${e.message}`);
    rmAll([stateDir, repo, realBaseDir]);
    return;
  }
  const { h, post, get, claudeDir } = await bootPurgeServer(stateDir, { GLMPS_WORKTREES_DIR: worktreesDir });
  try {
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'junction live agent' }).item.id;
    const dir = path.join(worktreesDir, 'p', id); // the RAW, junction-relative path
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${id}`, dir);
    assert.notEqual(fs.realpathSync(dir), dir, 'precondition: the junction genuinely changes the resolved path');
    backlogStore.updateItemIn(stateDir, id, { state: 'done' });
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir, branch: `glmps-runner/p/${id}`, repo } });

    // The agent was launched with the RAW (junction) path as its cwd - what
    // worktreePlan actually hands the spawn call, never a realpath.
    plantLiveSession(claudeDir, { sessionId: 'junction-agent-1', cwd: dir });
    const seen = await waitForLiveSessionCwd(get, 'junction-agent-1');
    assert.ok(seen, 'harness precondition: the fake session must be discovered before the purge runs');

    const r = await post(`/api/backlog/${id}/purge-worktree`);
    const stillSeen = (await get('/api/state')).body.sessions?.find((x) => x.id === 'junction-agent-1');
    assert.ok(stillSeen && stillSeen.state !== 'ended', 'harness precondition: the fake session must still read as live at purge time');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /live session/);
    assert.ok(fs.existsSync(dir), 'a live agent reached through the junction keeps its checkout');
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, realBaseDir, claudeDir]);
  }
});

// Fix round 2, I2 (no test existed for this branch before): C1's path (b) -
// the card's OWN recorded runSession.sessionId being live - refuses even
// when that session's cwd is nowhere near the worktree, so it is NOT the
// occupancy check (path a) catching this by coincidence.
test('purge-worktree: 409 (named reason) when the card\'s own recorded session is live, even though its cwd is elsewhere', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-sid-'));
  const repo = makeRepo();
  let elsewhere;
  const { h, post, get, claudeDir } = await bootPurgeServer(stateDir);
  try {
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'live session elsewhere' }).item.id;
    const dir = path.join(stateDir, 'runner', 'worktrees', 'p', id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${id}`, dir);
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-sid-elsewhere-'));
    backlogStore.updateItemIn(stateDir, id, { state: 'done' });
    backlogStore.setRunSessionIn(stateDir, id, { sessionId: 'agent-elsewhere-1', worktree: { dir, branch: `glmps-runner/p/${id}`, repo } });

    plantLiveSession(claudeDir, { sessionId: 'agent-elsewhere-1', cwd: elsewhere });
    const seen = await waitForLiveSessionCwd(get, 'agent-elsewhere-1');
    assert.ok(seen, 'harness precondition: the fake session must be discovered before the purge runs');
    assert.notEqual(path.resolve(seen.cwd ?? ''), path.resolve(dir), 'precondition: the live session\'s cwd is NOT the worktree - only the sessionId match should trigger this');

    const r = await post(`/api/backlog/${id}/purge-worktree`);
    const stillSeen = (await get('/api/state')).body.sessions?.find((x) => x.id === 'agent-elsewhere-1');
    assert.ok(stillSeen && stillSeen.state !== 'ended', 'harness precondition: the fake session must still read as live at purge time');
    assert.equal(r.status, 409);
    assert.match(r.body.error, /recorded session is still live/);
    assert.ok(fs.existsSync(dir), 'the worktree must survive');
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, elsewhere, claudeDir]);
  }
});

// the registration check must compare against
// wtSafeSeg(id) - the exact sanitization worktreePlan itself applies when
// building glmps-runner/<project>/<jobId> - not the raw id. Real
// auto-generated ids never need sanitizing (TICKET_ID_RE), so this item is
// constructed directly rather than through addItemTo.
test('purge-worktree: the registration check compares against wtSafeSeg(id), matching worktreePlan\'s own convention', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-safeseg-'));
  const repo = makeRepo();
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    const id = 'p 1'; // a space is not branch-legal; worktreePlan sanitizes it
    const safeId = 'p-1';
    const state = backlogStore.load(stateDir);
    state.items.push({
      id, project: 'p', title: 'weird id', prompt: '', state: 'done', source: 'manual',
      devLog: [], gate: null, runSession: null,
    });
    backlogStore.save(stateDir, state);
    const dir = path.join(stateDir, 'runner', 'worktrees', 'p', safeId);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(repo, 'worktree', 'add', '-B', `glmps-runner/p/${safeId}`, dir);
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir, branch: `glmps-runner/p/${safeId}`, repo } });
    const r = await post(`/api/backlog/${encodeURIComponent(id)}/purge-worktree`);
    assert.deepEqual(r, { status: 200, body: { ok: true, removed: true } });
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, claudeDir]);
  }
});

// the registration gate only checked "is this
// realpath SOME runner worktree of this repo", not "is it THIS card's OWN
// job". A card whose runSession.worktree was corrupted, or copied from
// another card's record, must never purge a DIFFERENT job's live worktree
// just because it is real and registered.
test('purge-worktree: 404 when the recorded worktree is registered under a DIFFERENT card\'s job id', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-purge-wrongjob-'));
  const repo = makeRepo();
  const otherDir = path.join(stateDir, 'runner', 'worktrees', 'p', 'job-other');
  fs.mkdirSync(path.dirname(otherDir), { recursive: true });
  git(repo, 'worktree', 'add', '-B', 'glmps-runner/p/job-other', otherDir);
  const { h, post, claudeDir } = await bootPurgeServer(stateDir);
  try {
    const id = backlogStore.addItemTo(stateDir, { project: 'p', title: 'wrong job' }).item.id;
    // This card's own record points at a REAL, registered runner worktree -
    // but one that belongs to a different job id (job-other, not this card).
    backlogStore.setRunSessionIn(stateDir, id, { worktree: { dir: otherDir, branch: 'glmps-runner/p/job-other', repo } });
    const r = await post(`/api/backlog/${id}/purge-worktree`);
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not registered as a runner worktree/);
    assert.ok(fs.existsSync(otherDir), 'the other job\'s worktree was never touched');
  } finally {
    await h.close?.();
    rmAll([stateDir, repo, claudeDir]);
  }
});
