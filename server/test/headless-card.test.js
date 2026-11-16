// Unattended reliability T5/T6: a primary card (operator-started, no parent)
// opens interactively as before; every other card runs headless as a 'card'
// gitops record the desktop app runs with `claude -p`. These tests stand in
// for the desktop app with a fake that claims each record and plays the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { load, save, setRunSessionIn } from '../lib/orchestration/backlog-store.js';
import { loadLedger } from '../lib/orchestration/runner-store.js';
import { waitFor } from './helpers/wait-for.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

function makeRepo() {
  const repo = tmp('mc-headless-repo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

// The stand-in desktop app. onCard(op, rec) plays the claude -p process and
// returns its exit result, or { error } for a refusal; with no onCard the
// card record is never claimed (no desktop app for cards). Git reads answer empty.
function cardShell(launchBroker, onCard) {
  const seen = [];
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    for (const r of launchBroker.pending()) {
      if (r.origin !== 'gitops') continue;
      if (r.op.kind === 'card' && !onCard) continue;
      if (!launchBroker.claim(r.id, 'desktop-shell')) continue;
      seen.push(r.op);
      if (r.op.kind === 'card') {
        const res = await onCard(r.op, r);
        if (res?.error) launchBroker.complete(r.id, { error: res.error });
        else launchBroker.complete(r.id, { result: { status: 0, stdout: '', stderr: '', timedOut: false, ...res } });
      } else {
        launchBroker.complete(r.id, { result: { status: 1, stdout: '', stderr: 'no upstream', timedOut: false } });
      }
    }
    setTimeout(loop, 5);
  };
  setTimeout(loop, 5);
  return { seen, cards: () => seen.filter((o) => o.kind === 'card'), stop() { stopped = true; } };
}

// glmps-2-0-163: a spawned card runs headless only under an open host, so the
// host the secondary cards name exists and is still being worked.
async function seedHost(post, stateDir, project) {
  const { body: host } = await post('/api/backlog', { acceptanceCriteria: ['hosts'], title: 'Host card', prompt: 'manages its follow-ups', project });
  const st = load(stateDir);
  save(stateDir, { ...st, items: st.items.map((i) => (i.id === host.id ? { ...i, id: 'glmps-1', state: 'in_progress' } : i)) });
}

// A short claim wait is only for the test where no desktop app claims the card.
// Where the stand-in app is running, its 5 ms poll can slip past 150 ms under a
// loaded test run and turn a present app into NO_SHELL, so those keep the
// production wait, which a passing run never reaches.
async function withService(fn, { shellClaimWaitMs, legacyStateDir } = {}) {
  const repo = makeRepo();
  const project = path.basename(repo);
  const stateDir = tmp('mc-headless-state-');
  const claudeDir = tmp('mc-headless-claude-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, ...(shellClaimWaitMs ? { mergeQueue: { shellClaimWaitMs } } : {}) }));
  const env = {
    ...process.env, GLMPS_SERVICE: '1', GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1',
    GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off', GLMPS_WORKTREES_DIR: path.join(stateDir, 'wts'),
  };
  if (legacyStateDir) env.GLMPS_LEGACY_STATE_DIR = legacyStateDir(stateDir);
  const h = await startServer({ port: 0, pollMs: 100000, env, configFile, restartFn: () => {} });
  const base = `http://127.0.0.1:${h.port}`;
  const call = async (method, p, o) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, ...(o ? { body: JSON.stringify(o) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const post = (p, o) => call('POST', p, o);
  const patch = (p, o) => call('PATCH', p, o);
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const ledger = () => loadLedger(stateDir);
  await post('/api/runner/config', { maxConcurrent: 2, maxRuntimeMs: 3600000 });
  await seedHost(post, stateDir, project);
  try { await fn({ h, post, patch, card, ledger, project, stateDir, wts: env.GLMPS_WORKTREES_DIR, legacy: env.GLMPS_LEGACY_STATE_DIR }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* handle held */ } }
  }
}

const secondary = (project, over = {}) => ({ acceptanceCriteria: ['launches'], title: 'Follow-up from another card', prompt: 'do the follow-up', project, parentId: 'glmps-1', ...over });

test('a secondary card runs headless: one card record in its own worktree under worker settings and a recorded session id, no window', async () => {
  await withService(async ({ h, post, card, ledger, project, stateDir, wts }) => {
    let during = null;
    let prompt = null;
    const shell = cardShell(h.launchBroker, (op) => {
      during = ledger();
      prompt = fs.readFileSync(op.promptFile, 'utf8');
      return { status: 0, stdout: 'done' };
    });
    const { body: c } = await post('/api/backlog', secondary(project, { origin: { via: 'slack', channel: 'C1', thread_ts: '1.1' } }));
    assert.equal(c.parentId, 'glmps-1');
    const run = await post(`/api/runner/run/${c.id}`, {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await waitFor(() => shell.cards().length, { message: 'the card record' });
    await h.headlessCardsIdle();
    shell.stop();
    const [op] = shell.cards();
    assert.equal(h.lastDryRunLaunch(), null, 'no interactive window was opened');
    assert.equal(path.dirname(path.dirname(op.cwd)), wts, 'the card runs in its own worktree');
    assert.equal(path.basename(op.cwd), c.id);
    assert.equal(path.basename(op.settings), `worker-${c.id}.json`);
    assert.equal(path.basename(path.dirname(op.promptFile)), 'runner');
    assert.match(op.sessionId, UUID);
    assert.equal(op.resume, false);
    assert.equal(op.timeoutMs, 3600000, 'the timeout is the runner runtime cap');
    assert.ok(during?.[c.id]?.headless, 'the run held a ledger slot while it lived');
    assert.match(prompt, /HEADLESS RUN/);
    assert.doesNotMatch(prompt, /THREAD CONTINUITY/);
    const after = card(c.id);
    assert.equal(after.runSession.sessionId, op.sessionId, 'the session id is recorded for a later resume');
    assert.equal(after.runSession.launcher, 'headless');
    assert.ok(after.devLog.some((d) => /launched headless in the desktop app/.test(d.text)));
    assert.ok(fs.existsSync(path.join(stateDir, 'role-settings', `worker-${c.id}.json`)));
  });
});

test('on exit with a gate recorded during the run the card is released to idle and the slot is free', async () => {
  await withService(async ({ h, post, card, ledger, project }) => {
    let id;
    const shell = cardShell(h.launchBroker, async () => {
      await post(`/api/backlog/${id}/gate`, { status: 'CONCERNS', evidence: ['waiting on the operator'] });
      return { status: 0 };
    });
    const { body: c } = await post('/api/backlog', secondary(project));
    id = c.id;
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.cards().length, { message: 'the card record' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(card(c.id).state, 'idle');
    assert.deepEqual(ledger(), {}, 'the slot is released when the process ends');
    assert.ok(card(c.id).devLog.some((d) => /headless run exited \(code 0\)/.test(d.text)));
  });
});

test('on exit without a gate the card is held with the exit reason on its devlog', async () => {
  await withService(async ({ h, post, card, ledger, project }) => {
    const shell = cardShell(h.launchBroker, () => ({ status: 3, stderr: 'Error: not logged in' }));
    const { body: c } = await post('/api/backlog', secondary(project));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.cards().length, { message: 'the card record' });
    await h.headlessCardsIdle();
    shell.stop();
    const after = card(c.id);
    assert.equal(after.state, 'held');
    assert.ok(after.devLog.some((d) => /headless run exited \(code 3\).*not logged in/.test(d.text)), JSON.stringify(after.devLog.map((d) => d.text)));
    assert.ok(after.devLog.some((d) => /held: headless run exited without a gate/.test(d.text)));
    assert.deepEqual(ledger(), {});
  });
});

test('a timed-out headless run is held saying so', async () => {
  await withService(async ({ h, post, card, project }) => {
    const shell = cardShell(h.launchBroker, () => ({ status: -1, timedOut: true }));
    const { body: c } = await post('/api/backlog', secondary(project));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.cards().length, { message: 'the card record' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(card(c.id).state, 'held');
    assert.ok(card(c.id).devLog.some((d) => /timed out after 60 min and was stopped/.test(d.text)));
  });
});

test('with the desktop app closed a headless card is held naming the desktop app, not left waiting for the runtime cap', async () => {
  await withService(async ({ h, post, card, ledger, project }) => {
    const shell = cardShell(h.launchBroker, null);
    // The wait that gave up is read off the broker's own failure message, not
    // timed: total elapsed also counts worktree git, which under a 4-way test
    // run took 11-12 s on its own (card glmps-2-0-runtime-120).
    const failures = [];
    const fail = h.launchBroker.fail;
    h.launchBroker.fail = (id, msg) => { failures.push({ kind: h.launchBroker.get(id)?.op?.kind, msg }); return fail.call(h.launchBroker, id, msg); };
    const { body: c } = await post('/api/backlog', secondary(project));
    await post(`/api/runner/run/${c.id}`, {});
    // Hang backstop only: a regression waits for the 3,600,000 ms runtime cap,
    // and without this the test would hang instead of failing.
    let backstop;
    await Promise.race([
      h.headlessCardsIdle(),
      new Promise((_, reject) => { backstop = setTimeout(() => reject(new Error('the card was still waiting after 60 s: it is waiting for the runtime cap, not one claim wait')), 60000); }),
    ]).finally(() => clearTimeout(backstop));
    shell.stop();
    assert.ok(failures.some((f) => f.kind === 'card' && /did not pick this up within 150 ms/.test(f.msg)), `held after one claim wait: ${JSON.stringify(failures)}`);
    assert.equal(card(c.id).state, 'held');
    assert.ok(card(c.id).devLog.some((d) => /desktop app did not pick it up/.test(d.text)));
    assert.deepEqual(ledger(), {});
    assert.equal(h.launchBroker.pending().length, 0, 'no stale record is left for a late desktop app');
  }, { shellClaimWaitMs: 150 });
});

test('a desktop app built before headless cards refuses the kind: the card opens interactively and says the app needs a rebuild', async () => {
  await withService(async ({ h, post, card, ledger, project }) => {
    const shell = cardShell(h.launchBroker, () => ({ error: 'refused by shell: unknown gitops kind: card' }));
    const { body: c } = await post('/api/backlog', secondary(project));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.cards().length, { message: 'the card record' });
    await h.headlessCardsIdle();
    const entry = ledger()[c.id];
    assert.ok(entry, 'the card still holds its slot, now interactively');
    assert.equal(entry.headless, undefined);
    assert.ok(h.lastDryRunLaunch(), 'an interactive launch happened');
    assert.equal(card(c.id).state, 'in_progress');
    assert.ok(card(c.id).devLog.some((d) => /rebuild the desktop app for headless launches/.test(d.text)));
    assert.equal(card(c.id).runSession.sessionId, entry.sessionId);

    const { body: c2 } = await post('/api/backlog', secondary(project, { title: 'Second follow-up' }));
    const before = shell.cards().length;
    await post(`/api/runner/run/${c2.id}`, {});
    shell.stop();
    assert.equal(shell.cards().length, before, 'later cards go straight to interactive');
    assert.ok(ledger()[c2.id] && !ledger()[c2.id].headless);
  });
});

test('a primary card opens interactively, and an explicit mode overrides lineage both ways', async () => {
  await withService(async ({ h, post, patch, card, ledger, project }) => {
    const shell = cardShell(h.launchBroker, () => ({ status: 0 }));
    const { body: primary } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'Operator ask', prompt: 'do it', project });
    assert.equal(primary.parentId, null);
    await post(`/api/runner/run/${primary.id}`, {});
    assert.ok(h.lastDryRunLaunch(), 'the primary card opened a window');
    assert.ok(ledger()[primary.id] && !ledger()[primary.id].headless);

    const { body: watched } = await post('/api/backlog', secondary(project, { title: 'Watch this one', mode: 'interactive' }));
    assert.equal(watched.mode, 'interactive');
    await post(`/api/runner/run/${watched.id}`, {});
    assert.ok(ledger()[watched.id] && !ledger()[watched.id].headless, 'the override makes a secondary card interactive');

    const { body: quiet } = await post('/api/backlog', { acceptanceCriteria: ['launches'], title: 'Operator ask, quietly', prompt: 'do it', project });
    assert.equal((await patch(`/api/backlog/${quiet.id}`, { mode: 'sideways' })).status, 400);
    assert.equal((await patch(`/api/backlog/${quiet.id}`, { mode: 'headless' })).body.mode, 'headless');
    await post('/api/runner/config', { maxConcurrent: 3 });
    await post(`/api/runner/run/${quiet.id}`, {});
    await waitFor(() => shell.cards().length, { message: 'the card record' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(shell.cards().length, 1, 'only the overridden primary card ran headless');
    assert.equal(path.basename(shell.cards()[0].cwd), quiet.id);
    assert.equal((await patch(`/api/backlog/${quiet.id}`, { mode: null })).body.mode, null);
    assert.equal(card(quiet.id).parentId, null);
  });
});

test('a reply to a finished headless card resumes the same session headless with the reply as the prompt', async () => {
  await withService(async ({ h, post, card, project }) => {
    let id;
    const prompts = [];
    const shell = cardShell(h.launchBroker, async (op) => {
      prompts.push(fs.readFileSync(op.promptFile, 'utf8'));
      await post(`/api/backlog/${id}/gate`, { status: 'CONCERNS', evidence: ['question posted'] });
      return { status: 0 };
    });
    const { body: c } = await post('/api/backlog', secondary(project));
    id = c.id;
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.cards().length, { message: 'the first run' });
    await h.headlessCardsIdle();
    assert.equal(card(c.id).state, 'idle');
    const sid = card(c.id).runSession.sessionId;

    const r = await h.relaunchJobNow(c.id, { resume: { sessionId: sid }, note: 'yes, go with option b', reason: 'the session ended' });
    assert.equal(r.ok, true, r.reason);
    await waitFor(() => shell.cards().length === 2, { message: 'the resumed run' });
    await h.headlessCardsIdle();
    shell.stop();
    const resumed = shell.cards()[1];
    assert.equal(resumed.resume, true);
    assert.equal(resumed.sessionId, sid, 'the same session is resumed');
    assert.equal(resumed.cwd, shell.cards()[0].cwd);
    assert.match(prompts[1], /> yes, go with option b/);
    assert.match(prompts[1], /resumed headless/);
    assert.doesNotMatch(prompts[1], /park again/);
    assert.equal(h.lastDryRunLaunch(), null);
    assert.equal(card(c.id).state, 'idle');
  });
});

test('a reply queued while the headless run was working resumes the session once the run ends', async () => {
  await withService(async ({ h, post, card, ledger, project, stateDir }) => {
    let id;
    const prompts = [];
    const shell = cardShell(h.launchBroker, async (op) => {
      prompts.push(fs.readFileSync(op.promptFile, 'utf8'));
      if (prompts.length === 1) {
        // What the Slack router does with a reply to a card that is still running.
        const l = ledger();
        l[id] = { ...l[id], parkNote: 'also update the docs' };
        fs.writeFileSync(path.join(stateDir, 'runner', 'launched.json'), JSON.stringify(l));
      }
      await post(`/api/backlog/${id}/gate`, { status: 'PASS', evidence: ['done'] });
      return { status: 0 };
    });
    const { body: c } = await post('/api/backlog', secondary(project));
    id = c.id;
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.cards().length === 2, { message: 'the resumed run' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(shell.cards()[1].resume, true);
    assert.equal(shell.cards()[1].sessionId, shell.cards()[0].sessionId);
    assert.match(prompts[1], /> also update the docs/);
    assert.equal(card(c.id).state, 'idle');
  });
});

// 2026-10-24: one refusal from the old desktop app pinned every later card to
// interactive until a kernel restart, so the rebuilt app was never tried.
test('after the re-probe window a later card tries headless again and runs headless on a rebuilt desktop app', async () => {
  const repo = makeRepo();
  const project = path.basename(repo);
  const stateDir = tmp('mc-headless-state-');
  const claudeDir = tmp('mc-headless-claude-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, headlessReprobeMs: 0 }));
  const env = {
    ...process.env, GLMPS_SERVICE: '1', GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1',
    GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off', GLMPS_WORKTREES_DIR: path.join(stateDir, 'wts'),
  };
  const h = await startServer({ port: 0, pollMs: 100000, env, configFile, restartFn: () => {} });
  const post = async (p, o) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, body: JSON.stringify(o) });
    return { status: r.status, body: await r.json() };
  };
  let rebuilt = false;
  const shell = cardShell(h.launchBroker, () => (rebuilt ? { status: 0 } : { error: 'refused by shell: unknown gitops kind: card' }));
  try {
    await post('/api/runner/config', { maxConcurrent: 2, maxRuntimeMs: 3600000 });
    await seedHost(post, stateDir, project);
    const { body: c1 } = await post('/api/backlog', secondary(project));
    await post(`/api/runner/run/${c1.id}`, {});
    await waitFor(() => shell.cards().length === 1, { message: 'the first card record' });
    await h.headlessCardsIdle();
    assert.ok(!loadLedger(stateDir)[c1.id]?.headless, 'the old app sent the first card interactive');

    rebuilt = true;
    const { body: c2 } = await post('/api/backlog', secondary(project, { title: 'After the rebuild' }));
    await post(`/api/runner/run/${c2.id}`, {});
    await waitFor(() => shell.cards().length === 2, { message: 'the second card tried headless again' });
    await h.headlessCardsIdle();
    const c2card = load(stateDir).items.find((i) => i.id === c2.id);
    assert.equal(c2card.runSession.launcher, 'headless');
    assert.ok(!c2card.devLog.some((d) => /rebuild the desktop app/.test(d.text)), 'no rebuild line once the app accepts the kind');
  } finally {
    shell.stop();
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* handle held */ } }
  }
});

// glmps-2-0-147: cards that ran before the cutover recorded their worktree under
// ~/.glmps, now a junction to ~/.glmps2. The desktop app refuses a
// card cwd outside its worktrees root by path text, so those cards never ran.
test('a card whose recorded worktree sits under the legacy state folder resumes in the same worktree under the current state folder', async () => {
  const links = [];
  const legacyStateDir = (stateDir) => {
    const link = `${stateDir}-legacy`;
    fs.symlinkSync(stateDir, link, 'junction');
    links.push(link);
    return link;
  };
  try {
    await withService(async ({ h, post, card, stateDir, wts, legacy, project }) => {
      let id;
      const shell = cardShell(h.launchBroker, async () => {
        await post(`/api/backlog/${id}/gate`, { status: 'CONCERNS', evidence: ['question posted'] });
        return { status: 0 };
      });
      try {
        const { body: c } = await post('/api/backlog', secondary(project));
        id = c.id;
        await post(`/api/runner/run/${c.id}`, {});
        await waitFor(() => shell.cards().length, { message: 'the first run' });
        await h.headlessCardsIdle();
        const first = shell.cards()[0].cwd;
        assert.equal(path.dirname(path.dirname(first)), wts);

        const old = path.join(legacy, path.relative(stateDir, first));
        assert.ok(fs.existsSync(old), 'the legacy path reaches the worktree through the junction');
        setRunSessionIn(stateDir, c.id, { worktree: { ...card(c.id).runSession.worktree, dir: old } });

        const r = await h.relaunchJobNow(c.id, { resume: { sessionId: card(c.id).runSession.sessionId }, note: 'carry on', reason: 'the session ended' });
        assert.equal(r.ok, true, r.reason);
        await waitFor(() => shell.cards().length === 2, { message: 'the resumed run' });
        await h.headlessCardsIdle();
        shell.stop();
        const resumed = shell.cards()[1];
        assert.equal(resumed.resume, true);
        assert.equal(resumed.cwd, first, 'the launch uses the current state folder spelling');
        assert.equal(card(c.id).runSession.worktree.dir, first, 'the card record is rewritten');
        assert.ok(card(c.id).devLog.some((d) => /recorded worktree moved from the legacy state folder/.test(d.text)));
      } finally { shell.stop(); }
    }, { legacyStateDir });
  } finally {
    for (const l of links) { try { fs.rmdirSync(l); } catch { try { fs.unlinkSync(l); } catch { /* gone */ } } }
  }
});
