// Routes under test: server/lib/routes/merge-queue-routes.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn } from '../lib/orchestration/backlog-store.js';

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqroute-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  return {
    ...process.env,
    GLMPS_CLAUDE_DIR: claudeDir,
    GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'),
    GLMPS_STATE_DIR: path.join(tmp, 'state'),
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
    GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'),
    GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
}

const PR = { baseRefName: 'main', headRefName: 'feat/glmps-1-x', title: 'Work for glmps-2', headRefOid: 'abc123', state: 'OPEN', isCrossRepository: false };

async function withServer(fn, { pr = PR, status = 0, actors = null } = {}) {
  const env = mkEnv();
  const calls = [];
  const ghRun = (file, args) => {
    calls.push({ file, args });
    return { status, stdout: JSON.stringify(pr), stderr: status ? 'boom' : '' };
  };
  let configFile;
  if (actors) {
    fs.mkdirSync(env.GLMPS_STATE_DIR, { recursive: true });
    configFile = path.join(env.GLMPS_STATE_DIR, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ actors: actors.map(({ token, ...a }) => a) }));
    fs.writeFileSync(path.join(env.GLMPS_STATE_DIR, 'actor-tokens.json'), JSON.stringify(Object.fromEntries(actors.map((a) => [a.id, a.token]))));
  }
  const srv = await startServer({ port: 0, env, pollMs: 100000, restartFn: () => {}, ghRun, configFile });
  const base = `http://127.0.0.1:${srv.port}`;
  const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
  const post = (p, obj, headers) => j(p, { method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: JSON.stringify(obj) });
  try {
    await fn({ post, get: (p) => j(p), calls, stateDir: env.GLMPS_STATE_DIR });
  } finally {
    await srv.close?.();
    fs.rmSync(path.dirname(env.GLMPS_STATE_DIR), { recursive: true, force: true });
  }
}

const URL1 = 'https://github.com/acme/widgets/pull/7';

test('POST merge-request stores a requested mergeRequest on the card via gh', async () => {
  await withServer(async ({ post, get, calls }) => {
    await post('/api/backlog', { title: 'card one' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.mergeRequest.stage, 'requested');
    assert.equal(r.body.mergeRequest.repo, 'acme/widgets');
    assert.equal(r.body.mergeRequest.number, 7);
    assert.equal(r.body.mergeRequest.base, 'main');
    assert.equal(r.body.mergeRequest.head, 'feat/glmps-1-x');
    assert.equal(r.body.mergeRequest.headSha, 'abc123');
    assert.equal(r.body.mergeRequest.round, 1);
    assert.equal(r.body.mergeRequest.filedBy, 'operator');
    assert.deepEqual(calls, [{ file: 'gh', args: ['pr', 'view', '7', '-R', 'acme/widgets', '--json', 'baseRefName,headRefName,headRefOid,state,isCrossRepository,title'] }]);
    const card = (await get('/api/backlog/glmps-1')).body;
    assert.equal(card.mergeRequest.stage, 'requested');
    assert.equal(card.devLog.length, 1);
    assert.match(card.devLog[0].text, /merge request filed/);
    assert.match(card.devLog[0].text, /acme\/widgets#7/);
  });
});

test('glmps-2-0-runtime-78: POST merge-request records the filer from the caller identity, never the body', async () => {
  await withServer(async ({ post, get }) => {
    await post('/api/backlog', { title: 'card one' });
    await post('/api/backlog', { title: 'card two' });
    const spoof = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1, by: 'alice' });
    assert.equal(spoof.status, 200);
    assert.equal(spoof.body.mergeRequest.filedBy, 'operator', 'an unauthenticated loopback caller is the local identity, whatever it claims');
    assert.match(spoof.body.mergeRequest.history.at(-1).reason, /filed by operator/);
    const authed = await post('/api/backlog/glmps-2/merge-request', { prUrl: 'https://github.com/acme/widgets/pull/8', by: 'alice' }, { authorization: 'Bearer bob-secret' });
    assert.equal(authed.status, 200);
    assert.equal(authed.body.mergeRequest.filedBy, 'bob', 'a token caller is recorded as its actor, not the claimed one');
    assert.equal((await get('/api/backlog/glmps-2')).body.mergeRequest.filedBy, 'bob');
  }, { actors: [{ id: 'alice', token: 'alice-secret' }, { id: 'bob', token: 'bob-secret' }] });
});

test('POST merge-request refuses the public repo before calling gh', async () => {
  await withServer(async ({ post, calls }) => {
    await post('/api/backlog', { title: 'card one' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: 'https://github.com/Wolfeb-Dev/GLMPS/pull/3' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /public/);
    assert.equal(calls.length, 0);
  });
});

test('POST merge-request refuses a bad url, an unknown card, a non-open PR and a cross-repo PR', async () => {
  await withServer(async ({ post }) => {
    await post('/api/backlog', { title: 'card one' });
    assert.equal((await post('/api/backlog/glmps-1/merge-request', { prUrl: 'nope' })).status, 400);
    assert.equal((await post('/api/backlog/glmps-99/merge-request', { prUrl: URL1 })).status, 404);
  });
  await withServer(async ({ post }) => {
    await post('/api/backlog', { title: 'card one' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not open/);
  }, { pr: { ...PR, state: 'MERGED' } });
  await withServer(async ({ post }) => {
    await post('/api/backlog', { title: 'card one' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cross-repository/);
  }, { pr: { ...PR, isCrossRepository: true } });
});

test('POST merge-request 403s with a named reason unless the PR branch or title carries the card id', async () => {
  await withServer(async ({ post, get }) => {
    await post('/api/backlog', { title: 'card one' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(r.status, 403);
    assert.match(r.body.reason, /glmps-1/);
    assert.match(r.body.reason, /feat\/other-work/);
    assert.equal((await get('/api/backlog/glmps-1')).body.mergeRequest, undefined);
  }, { pr: { ...PR, headRefName: 'feat/other-work', title: 'Unrelated change' } });
  // A longer id that merely starts with this one is another card.
  await withServer(async ({ post }) => {
    await post('/api/backlog', { title: 'card one' });
    assert.equal((await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 })).status, 403);
  }, { pr: { ...PR, headRefName: 'feat/glmps-10-x', title: 'Other' } });
  // The title alone is enough, compared case-insensitively.
  await withServer(async ({ post }) => {
    await post('/api/backlog', { title: 'card one' });
    assert.equal((await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 })).status, 200);
  }, { pr: { ...PR, headRefName: 'feat/other-work', title: 'Add the thing (card GLMPS-1)' } });
});

test('POST merge-request fails closed (502) when gh fails', async () => {
  await withServer(async ({ post, get }) => {
    await post('/api/backlog', { title: 'card one' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(r.status, 502);
    assert.equal((await get('/api/backlog/glmps-1')).body.mergeRequest, undefined);
  }, { status: 1 });
});

test('POST merge-request 409s while the card has a live request, allows a re-file after a bounce', async () => {
  await withServer(async ({ post, get, stateDir }) => {
    await post('/api/backlog', { title: 'card one' });
    assert.equal((await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 })).status, 200);
    const again = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(again.status, 409);

    const card = (await get('/api/backlog/glmps-1')).body;
    setMergeRequestIn(stateDir, 'glmps-1', { ...card.mergeRequest, stage: 'bounced' });

    const refiled = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(refiled.status, 200);
    assert.equal(refiled.body.mergeRequest.round, 2);
    assert.equal(refiled.body.mergeRequest.stage, 'requested');
  });
});

test('GET /api/merge-queue groups requests per integration branch', async () => {
  await withServer(async ({ post, get }) => {
    await post('/api/backlog', { title: 'card one' });
    await post('/api/backlog', { title: 'card two' });
    await post('/api/backlog', { title: 'card three, no request' });
    await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    await post('/api/backlog/glmps-2/merge-request', { prUrl: 'https://github.com/acme/widgets/pull/8' });
    const q = await get('/api/merge-queue');
    assert.equal(q.status, 200);
    assert.equal(q.body.branches.length, 1);
    assert.equal(q.body.branches[0].branch, 'acme/widgets@main');
    assert.deepEqual(q.body.branches[0].requests.map((r) => [r.id, r.title, r.stage, r.round]),
      [['glmps-1', 'card one', 'requested', 1], ['glmps-2', 'card two', 'requested', 1]]);
  });
});

test('POST merge-request records interim only for a literal true and says so on the devlog', async () => {
  await withServer(async ({ post, get }) => {
    await post('/api/backlog', { title: 'card one' });
    await post('/api/backlog', { title: 'card two' });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1, interim: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.mergeRequest.interim, true);
    assert.match((await get('/api/backlog/glmps-1')).body.devLog.at(-1).text, /interim: the card stays open/);
    const plain = await post('/api/backlog/glmps-2/merge-request', { prUrl: 'https://github.com/acme/widgets/pull/8', interim: 'true' });
    assert.equal(plain.body.mergeRequest.interim, false);
  });
});

test('runtime-9-a: POST merge-request validates covers against the card criteria and records covers and final', async () => {
  await withServer(async ({ post, get }) => {
    await post('/api/backlog', { title: 'card one', acceptanceCriteria: ['a', 'b', 'c'] });
    await post('/api/backlog', { title: 'card two' });
    const bad = [[0], [4], ['1'], [], 'all', [1.5]];
    for (const covers of bad) {
      const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1, covers });
      assert.equal(r.status, 400, JSON.stringify(covers));
    }
    assert.equal((await post('/api/backlog/glmps-2/merge-request', { prUrl: URL1, covers: [1] })).status, 400, 'a card with no criteria has nothing to cover');
    assert.equal((await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1, final: 'yes' })).status, 400);
    assert.equal((await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1, final: true, interim: true })).status, 400);
    assert.equal((await get('/api/backlog/glmps-1')).body.mergeRequest ?? null, null, 'nothing was filed');

    const ok = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1, covers: [3, 1], final: false });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.mergeRequest.covers, [1, 3]);
    assert.equal(ok.body.mergeRequest.final, false);
    assert.match((await get('/api/backlog/glmps-1')).body.devLog.at(-1).text, /covers AC-1, AC-3/);
  });
});

test('runtime-9-a: POST merge-request with neither covers nor final files exactly as before', async () => {
  await withServer(async ({ post }) => {
    await post('/api/backlog', { title: 'card one', acceptanceCriteria: ['a'] });
    const r = await post('/api/backlog/glmps-1/merge-request', { prUrl: URL1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.mergeRequest.covers, null);
    assert.equal(r.body.mergeRequest.final, false);
  });
});
