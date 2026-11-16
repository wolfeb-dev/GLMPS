// apps/shell/test/gitops-e2e.test.js
// The service kernel and the shell's gitops runner, joined for real over the
// authenticated launch protocol: the kernel's merge queue runs in service mode
// (so every gh, git and test call is a queued record), the runner claims and
// checks each against the allowlist, and only a fake spawn stands in for the
// operating system. Proves the server's ops are ones the shell accepts, and
// that a hostile record queued directly is refused before any process starts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startServer } from '../../../server/server.js';
import { setMergeRequestIn, setRunSessionIn, load } from '../../../server/lib/orchestration/backlog-store.js';
import { saveConfig } from '../../../server/lib/orchestration/runner-store.js';
import { createMergeRequest, transition } from '../../../server/lib/orchestration/merge-queue.js';
import { createGitopsRunner } from '../src/lib/gitops-runner.js';

const AUTHOR_SID = '11111111-2222-4333-8444-555555555555';
const H1 = 'a'.repeat(40);
const MERGE_SHA = 'd'.repeat(40);
const CLAUDE = 'C:\\fake\\claude.exe';

async function withStack(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gitopse2e-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'state', 'index.json'), JSON.stringify([{ id: AUTHOR_SID, model: 'claude-opus-4-5', skillsUsed: [], agentsUsed: [], eventCount: 0 }]));
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    runnerTickMs: 1000000000,
    // batchReview off: this env is not GLMPS_TEST, so a merge would start the
    // independent batch review, which is still running when the stack closes.
    mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test' } }, shellClaimWaitMs: 5000, batchReview: false },
  }));
  const stateDir = path.join(tmp, 'state');
  const env = {
    ...process.env, GLMPS_SERVICE: '1', GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_WORKTREES_DIR: path.join(tmp, 'wts'), GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'), GLMPS_UNMERGED_SCAN: 'off', GLMPS_RUNNER_DRYRUN: '1',
  };
  const srv = await startServer({ port: 0, env, configFile, pollMs: 100000, restartFn: () => {} });
  saveConfig(stateDir, { enabled: true, maxConcurrent: 3 });

  // A fake operating system: records every process the runner would start.
  const spawned = [];
  let merged = false;
  const spawnImpl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 1;
    spawned.push({ file, args, opts });
    let out = '';
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') out = `${H1}\n`;
    else if (file === 'git' && args[0] === 'rev-parse') out = `${'b'.repeat(40)}\n`;
    else if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') out = 'https://github.com/acme/widgets.git\n';
    else if (file === 'git' && args[0] === 'ls-remote' && args[1] === '--symref') out = 'ref: refs/heads/main\tHEAD\n';
    else if (file === 'gh' && args[1] === 'merge') merged = true;
    else if (file === 'gh') out = JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', headRefOid: H1, mergeable: 'MERGEABLE', baseRefName: 'main', mergeCommit: merged ? { oid: MERGE_SHA } : null });
    setImmediate(() => { if (out) child.stdout.emit('data', Buffer.from(out)); child.emit('close', 0, null); });
    return child;
  };
  const runner = createGitopsRunner({ kernelUrl: `http://127.0.0.1:${srv.port}`, stateDir, worktreesDir: env.GLMPS_WORKTREES_DIR, spawnImpl, intervalMs: 10, log: () => {}, resolveClaude: () => CLAUDE, killTree: () => {} });
  runner.start();

  const post = async (p, obj) => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glmps-local-session': srv.localSession }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const addCard = async () => {
    const r = await post('/api/backlog', { title: 'Add widget', prompt: 'build widget', acceptanceCriteria: ['widgets render'] });
    setRunSessionIn(stateDir, r.body.id, { sessionId: AUTHOR_SID, launcher: 'native-terminal', worktree: null, recordedTs: Date.now(), purgedTs: null });
    return r.body.id;
  };
  const filed = (id, stages, extra = {}) => {
    let m = createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/7', repo: 'acme/widgets', number: 7, base: 'main', head: 'feat/x', headSha: H1, filedBy: 'w' }, { now: '2026-10-17T10:00:00.000Z' });
    for (const to of stages) m = transition(m, to, { now: '2026-10-17T10:00:00.000Z', queue: [], id }).mergeRequest;
    setMergeRequestIn(stateDir, id, { ...m, ...extra });
  };
  try { await fn({ srv, runner, spawned, card, addCard, filed, checkout, stateDir, wts: env.GLMPS_WORKTREES_DIR }); }
  finally {
    runner.stop();
    await runner.idle();
    await srv.close?.();
    await releaseTmp(srv, tmp);
  }
}

// close() can resolve while a slow loop run still holds the kernel's sqlite
// files open; on Windows deleting the dir then fails EPERM. Wait for the stores
// to close, bounded, so a store that never closes is reported as such rather
// than masked by retries.
const STORES_CLOSED_WAIT_MS = 60000;
async function releaseTmp(srv, tmp) {
  let timer;
  const closed = await Promise.race([
    srv.storesClosed.then(() => true),
    new Promise((r) => { timer = setTimeout(() => r(false), STORES_CLOSED_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  if (!closed) {
    const reg = srv.loopRegistry;
    const running = Object.keys(reg.snapshot()).filter((n) => reg.isRunning(n));
    throw new Error(`kernel stores still open ${STORES_CLOSED_WAIT_MS} ms after close() (loops still running: ${running.join(', ') || 'none'}); leaving ${tmp} in place`);
  }
  // Async rm so its backoff does not block the event loop; covers a git or
  // antivirus handle that lingers a moment after the stores close.
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// glmps-2-0-runtime-125: the testing stage is back, so a filed request runs
// its git and test operations through the shell before the pinned merge.
test('AC-1: a freshly filed request is tested through the real runner, then merged pinned to the tested head', async () => {
  await withStack(async ({ srv, spawned, card, addCard, filed }) => {
    const id = await addCard();
    filed(id, []);
    for (let i = 0; i < 4 && card(id).mergeRequest.stage !== 'merged'; i += 1) await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged', JSON.stringify(c.mergeRequest.history.at(-1)));
    assert.deepEqual(c.mergeRequest.history.map((h) => h.to), ['requested', 'testing', 'merging', 'merged']);
    const git = spawned.filter((s) => s.file === 'git').map((s) => s.args.join(' '));
    assert.ok(git.some((g) => /^worktree add --detach /.test(g)), git.join(', '));
    assert.ok(git.some((g) => / merge --no-ff -m /.test(g)), 'the base is merged into the PR head locally');
    assert.ok(spawned.some((s) => s.file !== 'git' && s.file !== 'gh'), 'the test command ran');
    assert.deepEqual(spawned.find((s) => s.args[1] === 'merge' && s.file === 'gh').args, ['pr', 'merge', '7', '-R', 'acme/widgets', '--merge', '--match-head-commit', H1]);
    assert.ok(!spawned.some((s) => s.file === CLAUDE), 'no per-PR reviewer starts');
  });
});

test('AC-1: the merging stage runs gh through the real runner, pinned to the tested head, with no --admin or --auto', async () => {
  await withStack(async ({ srv, spawned, card, addCard, filed }) => {
    const id = await addCard();
    filed(id, ['testing', 'merging'], { tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } });
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'merged');
    const merge = spawned.find((s) => s.file === 'gh' && s.args[1] === 'merge');
    assert.deepEqual(merge.args, ['pr', 'merge', '7', '-R', 'acme/widgets', '--merge', '--match-head-commit', H1]);
    // The only git before the merge is the read-only check that the base has not moved since the tests.
    const beforeMerge = spawned.slice(0, spawned.indexOf(merge));
    assert.deepEqual(beforeMerge.filter((s) => s.file === 'git').map((s) => s.args.join(' ')), ['fetch -q origin', 'rev-parse origin/main']);
    assert.ok(spawned.every((s) => (s.file === 'gh' || s.file === 'git') && !s.args.includes('--admin') && !s.args.includes('--auto')));
  });
});

// Card glmps-2-0-216: card 209's release was refused at every step on the
// service. The release action now passes the real allowlist and the shell runs
// its fixed sequence in the checkout, with its worktree under merge-queue/.
test('after the merge, the release action runs through the real runner instead of being refused', async () => {
  await withStack(async ({ srv, spawned, card, addCard, filed, checkout, wts }) => {
    const id = await addCard();
    filed(id, ['testing', 'merging'], { tests: { status: 'pass', headSha: H1, mergedBaseSha: 'b'.repeat(40), tail: 'green' } });
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'merged');
    const after = spawned.slice(spawned.findIndex((s) => s.file === 'gh' && s.args[1] === 'merge') + 1).filter((s) => s.file === 'git');
    const fetchTags = after.find((s) => s.args.join(' ') === 'fetch -q --tags origin');
    assert.ok(fetchTags, after.map((s) => s.args.join(' ')).join(', '));
    assert.equal(fetchTags.opts.cwd, checkout);
    const add = after.find((s) => s.args[0] === 'worktree' && s.args[1] === 'add');
    assert.ok(add.args[3].startsWith(path.join(wts, 'merge-queue', 'release-')), add.args[3]);
    // The fake git checks nothing out, so the release finds no package.json and skips: no push, no devlog line.
    assert.ok(!after.some((s) => s.args[0] === 'push'));
    assert.ok(!card(id).devLog.some((d) => /release failed|refused by shell/.test(d.text)));
  });
});

test('a hostile gitops record queued on the kernel is refused by the shell before any process starts', async () => {
  await withStack(async ({ srv, spawned, checkout, stateDir, wts }) => {
    const roots = { repos: [checkout], worktrees: wts };
    const queue = (op) => srv.launchBroker.enqueue({ origin: 'gitops', command: `gitops ${op.kind}`, cwd: op.cwd ?? 'gitops', op: { ...op, roots, timeoutMs: 5000 } }).id;
    const ids = [
      queue({ kind: 'git', cwd: checkout, args: ['push', '--force', 'origin', 'glmps2/main'] }),
      queue({ kind: 'gh', args: ['pr', 'merge', '7', '-R', 'acme/widgets', '--admin', '--merge', '--match-head-commit', H1] }),
      queue({ kind: 'git', cwd: 'C:\\Windows', args: ['status'] }),
      queue({ kind: 'test', cwd: checkout, command: 'npm test' }),
      queue({ kind: 'gh', args: ['pr', 'view', '1', '-R', 'wolfeb-dev/glmps', '--json', 'state'] }),
      queue({ kind: 'review', cwd: checkout, model: 'sonnet', settings: path.join(stateDir, 'launch-token'), promptFile: path.join(stateDir, 'launch-token') }),
    ];
    for (let i = 0; i < 200 && ids.some((id) => srv.launchBroker.get(id).state !== 'failed'); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(ids.map((id) => srv.launchBroker.get(id).state), ids.map(() => 'failed'));
    for (const id of ids) assert.match(srv.launchBroker.get(id).error, /^refused by shell: /);
    assert.deepEqual(spawned, [], 'no process was started for any of them');
  });
});
