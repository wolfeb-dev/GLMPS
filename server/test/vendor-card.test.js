// Card glmps-2-0-162: a card that asks for a non-Claude model runs as a
// 'vendor-card' record the desktop app runs with that vendor's CLI. The fake
// desktop app below plays the run and answers with the result document the
// real one (apps/shell/src/lib/vendor-card.js) returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../server.js';
import { load } from '../lib/orchestration/backlog-store.js';
import { waitFor } from './helpers/wait-for.js';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

function makeRepo() {
  const repo = tmp('mc-vendor-repo-');
  execFileSync('git', ['init', '-q', repo]);
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'seed');
  return repo;
}

function vendorShell(launchBroker, { onVendor, answersPrView = false }) {
  const seen = [];
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    for (const r of launchBroker.pending()) {
      if (r.origin !== 'gitops') continue;
      if (!launchBroker.claim(r.id, 'desktop-shell')) continue;
      seen.push(r.op);
      if (r.op.kind === 'vendor-card') {
        const res = await onVendor(r.op);
        if (res?.error) launchBroker.complete(r.id, { error: res.error });
        else launchBroker.complete(r.id, { result: { status: 0, stdout: JSON.stringify(res.doc), stderr: '', timedOut: false } });
      } else if (r.op.kind === 'gh' && r.op.args[0] === 'pr' && r.op.args[1] === 'view' && answersPrView) {
        const prHead = seen.filter((o) => o.kind === 'vendor-card').at(-1)?.branch;
        launchBroker.complete(r.id, { result: { status: 0, stdout: JSON.stringify({ baseRefName: 'main', headRefName: prHead, headRefOid: 'a'.repeat(40), state: 'OPEN', isCrossRepository: false, title: 'Fix it' }), stderr: '', timedOut: false } });
      } else {
        launchBroker.complete(r.id, { result: { status: 1, stdout: '', stderr: 'no upstream', timedOut: false } });
      }
    }
    setTimeout(loop, 5);
  };
  setTimeout(loop, 5);
  return { seen, vendors: () => seen.filter((o) => o.kind === 'vendor-card'), stop() { stopped = true; } };
}

async function withService(fn, { service = true, runnerConfig = {}, antigravity = false } = {}) {
  const repo = makeRepo();
  const project = path.basename(repo);
  const stateDir = tmp('mc-vendor-state-');
  const claudeDir = tmp('mc-vendor-claude-');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [repo] } }));
  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000 }));
  const env = {
    ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_RUNNER_DRYRUN: '1',
    GLMPS_UNMERGED_SCAN: 'off', GLMPS_SCUT: 'off', GLMPS_WORKTREES_DIR: path.join(stateDir, 'wts'),
    ...(service ? { GLMPS_SERVICE: '1' } : { GLMPS_SERVICE: '' }),
  };
  const requests = path.join(stateDir, 'companion', 'resume.jsonl');
  const h = await startServer({ port: 0, pollMs: 100000, env, configFile, restartFn: () => {}, ...(antigravity ? { companionRequestsFile: requests, agAliveProbe: () => true } : {}) });
  const tabs = () => (fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const base = `http://127.0.0.1:${h.port}`;
  const call = async (method, p, o) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-glmps-local-session': h.localSession }, ...(o ? { body: JSON.stringify(o) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const post = (p, o) => call('POST', p, o);
  const get = (p) => call('GET', p);
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  await post('/api/runner/config', { maxConcurrent: 2, maxRuntimeMs: 3600000, ...runnerConfig });
  try { await fn({ h, post, get, card, project, wts: env.GLMPS_WORKTREES_DIR, tabs, stateDir }); }
  finally {
    await h.close?.();
    for (const d of [repo, stateDir, claudeDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* handle held */ } }
  }
}

const geminiCard = (project, over = {}) => ({ acceptanceCriteria: ['AC-1: the parser handles empty input'], title: 'Fix the broken parser', prompt: 'The parser crashes on empty input. Use Gemini.', project, parentId: 'glmps-1', ...over });
const okDoc = (prUrl, over = {}) => ({
  agent: { status: 0, sessionId: 'conv-1', text: 'Fixed the empty-input crash. AC-1: new test passes.', usage: { input: 900, output: 100, total: 1000 }, costUsd: null, durationMs: 60000, authFailed: false },
  changed: ['server/lib/parser.js', 'server/test/parser.test.js'], fence: { ok: true, violations: [] },
  graph: { ran: true, status: 0 }, tests: { ran: true, exitCode: 0, selection: 'ran', tail: 'pass 3 fail 0' }, commit: 'b'.repeat(40), prUrl, error: null, ...over,
});

test('AC-1, AC-2, AC-5: a "use gemini" card runs on agy through the desktop app; the runner posts, gates, files the PR and records the run', async () => {
  await withService(async ({ h, post, get, card, project, wts }) => {
    let prompt = null;
    const shell2 = vendorShell(h.launchBroker, {
      answersPrView: true,
      onVendor: (op) => {
        prompt = fs.readFileSync(op.promptFile, 'utf8');
        const d = okDoc('https://github.com/wolfeb-dev/glmps-2.0/pull/77');
        return { doc: { ...d, agent: { ...d.agent, model: 'Gemini 4 Argon (High)' } } };
      },
    });
    const { body: c } = await post('/api/backlog', geminiCard(project));
    const id = c.id;
    assert.equal(c.model, 'gemini');
    const run = await post(`/api/runner/run/${id}`, {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await waitFor(() => shell2.vendors().length, { message: 'the vendor-card record' });
    await h.headlessCardsIdle();
    shell2.stop();
    const [op] = shell2.vendors();
    assert.equal(op.vendor, 'gemini');
    assert.equal(op.model, null, 'no model named: the desktop app picks the newest agy lists');
    assert.equal(path.dirname(path.dirname(op.cwd)), wts, 'own worktree');
    assert.equal(op.cardId, id);
    assert.ok(op.branch.endsWith(id));
    assert.equal(h.lastDryRunLaunch(), null, 'no Claude window was opened');
    assert.match(prompt, /You are Gemini/);
    assert.match(prompt, /read GEMINI\.md/);
    const after = card(id);
    assert.equal(after.gate.status, 'PASS', JSON.stringify(after.gate));
    assert.ok(after.gate.evidence.some((e) => /AC-1/.test(e)));
    assert.equal(after.mergeRequest?.prUrl, 'https://github.com/wolfeb-dev/glmps-2.0/pull/77', JSON.stringify(after.devLog.slice(-4)));
    assert.ok(after.devLog.some((d) => /Started this card on Gemini/.test(d.text)));
    assert.ok(after.devLog.some((d) => /Gemini \(Gemini 4 Argon \(High\)\) finished in/.test(d.text)), 'the model the desktop app picked is the one reported');
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0].vendor, 'gemini');
    assert.equal(after.runs[0].model, 'Gemini 4 Argon (High)');
    assert.equal(after.runs[0].tokens.total, 1000);
    const rows = (await get('/api/model-runs')).body.rows;
    assert.equal(rows[0].cardId, id);
    assert.equal(rows[0].gate, 'PASS');
  });
});

test('AC-3: a fence breach fails the gate and files nothing', async () => {
  await withService(async ({ h, post, card, project }) => {
    const shell = vendorShell(h.launchBroker, { onVendor: () => ({ doc: okDoc(null, { fence: { ok: false, violations: ['CLAUDE.md'] }, tests: { ran: false }, commit: null, error: 'fence breach: CLAUDE.md' }) }) });
    const { body: c } = await post('/api/backlog', geminiCard(project));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.vendors().length, { message: 'the vendor-card record' });
    await h.headlessCardsIdle();
    shell.stop();
    const after = card(c.id);
    assert.equal(after.gate.status, 'FAIL');
    assert.match(after.gate.evidence.join(' '), /CLAUDE\.md/);
    assert.equal(after.mergeRequest ?? null, null);
  });
});

test('AC-2: a vendor that is not signed in holds the card with the sign-in step', async () => {
  await withService(async ({ h, post, card, project }) => {
    const shell = vendorShell(h.launchBroker, { onVendor: () => ({ doc: { agent: { status: 1, authFailed: true, text: '' }, changed: [], fence: { ok: true, violations: [] }, tests: { ran: false }, prUrl: null, error: 'sign-in failed' } }) });
    const { body: c } = await post('/api/backlog', geminiCard(project));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.vendors().length, { message: 'the vendor-card record' });
    await h.headlessCardsIdle();
    shell.stop();
    const after = card(c.id);
    assert.equal(after.gate.status, 'CONCERNS');
    assert.ok(after.devLog.some((d) => /not signed in/.test(d.text) && /Antigravity/.test(d.text)));
  });
});

test('AC-3: an ops card asking for Gemini is refused before anything runs', async () => {
  await withService(async ({ h, post, project }) => {
    const shell = vendorShell(h.launchBroker, { onVendor: () => { throw new Error('must not run'); } });
    const { body: c } = await post('/api/backlog', geminiCard(project, { title: 'Install the hook', prompt: 'Change the ci pipeline config and env. use gemini' }));
    const run = await post(`/api/runner/run/${c.id}`, {});
    shell.stop();
    assert.equal(run.status, 403);
    assert.match(run.body.reason, /ops card/);
    assert.equal(shell.vendors().length, 0);
  });
});

test('AC-2: GPT stays off until the runner config switches it on, then it runs on Codex', async () => {
  await withService(async ({ h, post, project }) => {
    const { body: c } = await post('/api/backlog', geminiCard(project, { prompt: 'The parser crashes. use gpt' }));
    const refused = await post(`/api/runner/run/${c.id}`, {});
    assert.equal(refused.status, 403);
    assert.match(refused.body.reason, /codex login/);
    await post('/api/runner/config', { vendors: { gpt: { enabled: true } } });
    const shell = vendorShell(h.launchBroker, { onVendor: () => ({ doc: okDoc(null, { changed: [], tests: { ran: false } }) }) });
    const run = await post(`/api/runner/run/${c.id}`, {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    await waitFor(() => shell.vendors().length, { message: 'the vendor-card record' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(shell.vendors()[0].vendor, 'gpt');
  });
});

test('AC-3: without the desktop app a vendor card is refused rather than run on Claude', async () => {
  await withService(async ({ h, post, project }) => {
    const { body: c } = await post('/api/backlog', geminiCard(project));
    const run = await post(`/api/runner/run/${c.id}`, {});
    assert.equal(run.status, 403);
    assert.match(run.body.reason, /desktop app/);
    assert.equal(h.lastDryRunLaunch(), null);
  }, { service: false });
});

// AC-6: an operator card on Gemini opens in its own named Antigravity tab, the
// way a Claude card does; the tab's finish signal starts the desktop app's
// verification, and the runner posts, gates and files as for a headless run.
const tabCard = (project, over = {}) => geminiCard(project, { parentId: null, mode: 'interactive', ...over });

test('AC-6: an interactive Gemini card opens a named Antigravity tab running agy, then finishes on the done signal', async () => {
  await withService(async ({ h, post, card, project, tabs, stateDir }) => {
    // The first finish ships the change; the exit after it finds nothing new.
    let finishes = 0;
    const shell = vendorShell(h.launchBroker, { answersPrView: true, onVendor: () => ({ doc: (finishes += 1) === 1
      ? okDoc('https://github.com/wolfeb-dev/glmps-2.0/pull/78', { agent: { status: 0, sessionId: null, text: 'Fixed it. AC-1 met.', usage: null, costUsd: null, durationMs: 0, authFailed: false } })
      : okDoc(null, { changed: [], tests: { ran: false }, commit: null, agent: { status: 0, text: '' } }) }) });
    const { body: c } = await post('/api/backlog', tabCard(project));
    const run = await post(`/api/runner/run/${c.id}`, {});
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const [rec] = tabs();
    assert.ok(rec, 'a companion tab request');
    assert.equal(rec.type, 'terminal');
    assert.equal(rec.name, `gemini ${c.id}`);
    assert.match(rec.command, /^node ".*vendor-session\.mjs" ".*\.vendor-session\.json" ".*\.prompt\.md"$/);
    assert.equal(shell.vendors().length, 0, 'nothing headless was queued');
    assert.equal(h.lastDryRunLaunch(), null, 'no Claude window');
    const session = JSON.parse(fs.readFileSync(path.join(stateDir, 'runner', `${c.id}.vendor-session.json`), 'utf8'));
    assert.equal(session.vendor, 'gemini');
    assert.equal(path.resolve(session.cwd), path.resolve(rec.cwd));
    assert.equal(path.dirname(session.doneFile), session.cwd, 'the done file is inside the worktree');
    const prompt = fs.readFileSync(session.promptFile, 'utf8');
    assert.ok(prompt.includes(session.doneFile), 'the prompt names the done file');
    assert.ok(card(c.id).devLog.some((d) => /in its own Antigravity tab/.test(d.text)));

    assert.equal((await post(`/api/backlog/${c.id}/vendor-session`, { nonce: 'f'.repeat(32), event: 'done' })).status, 403);
    fs.writeFileSync(session.doneFile, 'Fixed it. AC-1 met.');
    const sig = await post(`/api/backlog/${c.id}/vendor-session`, { nonce: session.nonce, event: 'done' });
    assert.equal(sig.status, 202);
    // F4 (card glmps-2-0-172): the exit is a later round, queued if the first finish is still running.
    const again = await post(`/api/backlog/${c.id}/vendor-session`, { nonce: session.nonce, event: 'exit', exitCode: 0 });
    assert.equal(again.status, 202);
    assert.ok(again.body.queued || again.body.laterRound, JSON.stringify(again.body));
    await waitFor(() => shell.vendors().length >= 2, { message: 'the second finish-only vendor-card record' });
    await h.headlessCardsIdle();
    shell.stop();
    const [op, second] = shell.vendors();
    assert.equal(op.finishOnly, true);
    assert.equal(op.agentText, 'Fixed it. AC-1 met.');
    assert.equal(second.finishOnly, true);
    assert.equal(shell.vendors().length, 2, 'one finish per round');
    assert.equal(fs.existsSync(session.doneFile), false, 'the done file is consumed');
    const after = card(c.id);
    assert.equal(after.gate.status, 'PASS', JSON.stringify(after.gate));
    assert.ok(after.devLog.some((d) => /nothing new since the last hand-off/.test(d.text)), 'the empty later round says so and records no gate');
    assert.equal(after.mergeRequest?.prUrl, 'https://github.com/wolfeb-dev/glmps-2.0/pull/78');
    assert.equal(after.runs.length, 1);
    assert.equal(after.runs[0].tokens, null);
    const exclude = git(session.cwd, 'rev-parse', '--git-path', 'info/exclude').trim();
    assert.match(fs.readFileSync(path.isAbsolute(exclude) ? exclude : path.join(session.cwd, exclude), 'utf8'), /^\.glmps-vendor-done\.md$/m);
  }, { antigravity: true });
});

test('AC-6: a child card under a host stays headless even with Antigravity open', async () => {
  await withService(async ({ h, post, project, tabs }) => {
    const shell = vendorShell(h.launchBroker, { onVendor: () => ({ doc: okDoc(null, { changed: [], tests: { ran: false } }) }) });
    // glmps-2-0-163: headless only under a host that is still open.
    const { body: host } = await post('/api/backlog', { title: 'Host card', prompt: 'Manages its spawned cards.', project });
    const { body: c } = await post('/api/backlog', geminiCard(project, { parentId: host.id }));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.vendors().length, { message: 'the headless vendor-card record' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(tabs().length, 0);
    assert.notEqual(shell.vendors()[0].finishOnly, true);
  }, { antigravity: true });
});

test('AC-6: with no Antigravity to host the tab, an interactive Gemini card runs headless and says why', async () => {
  await withService(async ({ h, post, card, project }) => {
    const shell = vendorShell(h.launchBroker, { onVendor: () => ({ doc: okDoc(null, { changed: [], tests: { ran: false } }) }) });
    const { body: c } = await post('/api/backlog', tabCard(project));
    await post(`/api/runner/run/${c.id}`, {});
    await waitFor(() => shell.vendors().length, { message: 'the headless vendor-card record' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.ok(card(c.id).devLog.some((d) => /runs headless instead of in a tab: no Antigravity window/.test(d.text)));
  });
});

test('AC-6: a finish signal with no open tab session is refused', async () => {
  await withService(async ({ post, project }) => {
    const { body: c } = await post('/api/backlog', tabCard(project));
    const r = await post(`/api/backlog/${c.id}/vendor-session`, { nonce: 'a'.repeat(32), event: 'done' });
    assert.equal(r.status, 404);
  });
});

test('AC-6: edits made in the tab after the first hand-off get their own finish and gate', async () => {
  await withService(async ({ h, post, card, project, stateDir }) => {
    let finishes = 0;
    const shell = vendorShell(h.launchBroker, { answersPrView: true, onVendor: () => {
      finishes += 1;
      return { doc: finishes === 1
        ? okDoc('https://github.com/wolfeb-dev/glmps-2.0/pull/79')
        : okDoc('https://github.com/wolfeb-dev/glmps-2.0/pull/79', { changed: ['server/lib/parser.js'], tests: { ran: true, exitCode: 1, tail: 'not ok 1' }, prUrl: null, error: 'the affected tests failed; nothing was pushed' }) };
    } });
    const { body: c } = await post('/api/backlog', tabCard(project));
    await post(`/api/runner/run/${c.id}`, {});
    const sessionFile = path.join(stateDir, 'runner', `${c.id}.vendor-session.json`);
    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    fs.writeFileSync(session.doneFile, 'First pass.');
    assert.equal((await post(`/api/backlog/${c.id}/vendor-session`, { nonce: session.nonce, event: 'done' })).status, 202);
    await waitFor(() => shell.vendors().length === 1, { message: 'the first finish' });
    await h.headlessCardsIdle();
    assert.equal(card(c.id).gate.status, 'PASS');
    fs.writeFileSync(session.doneFile, 'Second pass after the operator asked for more.');
    const later = await post(`/api/backlog/${c.id}/vendor-session`, { nonce: session.nonce, event: 'done' });
    assert.equal(later.status, 202);
    assert.equal(later.body.laterRound, true);
    await waitFor(() => shell.vendors().length === 2, { message: 'the later finish' });
    await h.headlessCardsIdle();
    shell.stop();
    assert.equal(shell.vendors()[1].agentText, 'Second pass after the operator asked for more.');
    assert.equal(card(c.id).gate.status, 'FAIL', 'the later round is judged on its own tests');
    assert.equal(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).rounds, 2);
  }, { antigravity: true });
});
