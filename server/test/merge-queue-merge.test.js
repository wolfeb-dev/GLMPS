import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { setMergeRequestIn, setRunSessionIn, load } from '../lib/orchestration/backlog-store.js';
import { saveConfig } from '../lib/orchestration/runner-store.js';
import { createMergeRequest, transition } from '../lib/orchestration/merge-queue.js';

const AUTHOR_SID = '11111111-2222-4333-8444-555555555555';
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);

function mkEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mqmerge-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'ag', 'brain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'state', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'state', 'index.json'), JSON.stringify([{ id: AUTHOR_SID, model: 'claude-opus-4-5', skillsUsed: [], agentsUsed: [], eventCount: 0 }]));
  const checkout = path.join(tmp, 'checkout');
  fs.mkdirSync(checkout);
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ runnerTickMs: 1000000000, mergeQueue: { repos: { 'acme/widgets': { path: checkout, test: 'npm test' } } } }));
  return {
    tmp, configFile,
    env: {
      ...process.env,
      GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: path.join(tmp, 'state'),
      GLMPS_WORKTREES_DIR: path.join(tmp, 'wts'), GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'),
      GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'), GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy-cli'),
      GLMPS_CODEX_DIR: path.join(tmp, 'codex'), GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
      GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
      GLMPS_UNMERGED_SCAN: 'off', GLMPS_RUNNER_DRYRUN: '1',
    },
  };
}

// A scripted GitHub. `pr` is the live PR; merging flips it to MERGED.
function fakeGh(pr = {}) {
  const st = { state: 'OPEN', head: H1, mergeable: 'MERGEABLE', base: 'main', mergeCommit: null, mergeFails: null, viewFails: null, gate: null, ...pr };
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    const sub = args[1];
    if (sub === 'view') {
      const fields = args[args.indexOf('--json') + 1];
      if (st.viewFails && !fields.startsWith('baseRefName')) return { status: 1, stdout: '', stderr: st.viewFails };
      if (fields.startsWith('baseRefName')) {
        return { status: 0, stdout: JSON.stringify({ baseRefName: st.base, headRefName: 'feat/glmps-1-x', headRefOid: st.head, state: 'OPEN', isCrossRepository: false }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify({ state: st.state, headRefOid: st.head, mergeable: st.mergeable, baseRefName: st.base, mergeCommit: st.mergeCommit ? { oid: st.mergeCommit } : null }), stderr: '' };
    }
    if (sub === 'merge') {
      if (st.gate) await st.gate;
      if (st.mergeFails) return { status: 1, stdout: '', stderr: st.mergeFails };
      st.state = 'MERGED'; st.mergeCommit = MERGE_SHA;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  return { st, calls, run, merges: () => calls.filter((c) => c.args[1] === 'merge') };
}

async function withMerge(fn, { pr, headOut = H1, baseOut = 'b'.repeat(40), testOutcome = null } = {}) {
  const e = mkEnv();
  const gh = fakeGh(pr);
  // The testing stage seam: passes against whatever head the PR has now unless a test scripts the outcome.
  const testRuns = [];
  const mergeTestsRun = async (job) => {
    testRuns.push(job);
    if (testOutcome) return typeof testOutcome === 'function' ? testOutcome(job) : testOutcome;
    return { kind: 'pass', tests: { status: 'pass', headSha: gh.st.head, mergedBaseSha: typeof baseOut === 'function' ? baseOut() : baseOut, tail: 'green' } };
  };
  const reviewGit = async (args) => {
    if (args[0] === 'rev-parse' && String(args[1]).startsWith('origin/')) return { status: 0, stdout: typeof baseOut === 'function' ? baseOut() : baseOut, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: typeof headOut === 'function' ? headOut() : headOut, stderr: '' };
    return { status: 0, stdout: args[0] === 'diff' ? 'diff --git a/f b/f\n+x\n' : '', stderr: '' };
  };
  const srv = await startServer({ port: 0, env: e.env, configFile: e.configFile, pollMs: 100000, restartFn: () => {}, ghRun: gh.run, reviewGit, mergeTestsRun });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (p, obj) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) }); return { status: r.status, body: await r.json() }; };
  const stateDir = e.env.GLMPS_STATE_DIR;
  saveConfig(stateDir, { enabled: true, maxConcurrent: 3 });
  const card = (id) => load(stateDir).items.find((i) => i.id === id);
  const addCard = async (extra = {}) => {
    const r = await post('/api/backlog', { title: 'Add widget', prompt: 'build widget', acceptanceCriteria: ['widgets render', 'no regressions'], ...extra });
    setRunSession(r.body.id);
    return r.body.id;
  };
  const setRunSession = (id) => setRunSessionIn(stateDir, id, { sessionId: AUTHOR_SID, launcher: 'native-terminal', worktree: null, recordedTs: Date.now(), purgedTs: null });
  // A request in merging stage, tested at `testHead` (requested -> testing -> merging).
  const merging = (id, { number = 7, head = H1, filedAt = '2026-10-17T10:00:00.000Z', tested = true, testHead = head, testBase = 'b'.repeat(40) } = {}) => {
    let m = createMergeRequest({ prUrl: `https://github.com/acme/widgets/pull/${number}`, repo: 'acme/widgets', number, base: 'main', head: 'feat/x', headSha: head, filedBy: 'w' }, { now: filedAt });
    m = transition(m, 'testing', { now: filedAt, queue: [], id }).mergeRequest;
    m = transition(m, 'merging', { now: filedAt, queue: [], id }).mergeRequest;
    if (tested) m = { ...m, tests: { status: 'pass', headSha: testHead, mergedBaseSha: testBase, tail: 'green' } };
    setMergeRequestIn(stateDir, id, m);
    return m;
  };
  const until = async (pred, what) => {
    for (let i = 0; i < 100 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(pred(), what);
  };
  try {
    await fn({ srv, post, card, stateDir, addCard, merging, gh, until, setRunSession, testRuns });
  } finally {
    await srv.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
}

test('AC-1: an approved request is merged by the server, the SHA recorded and the card closed done with the merge record', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();

    const merge = gh.merges();
    assert.equal(merge.length, 1);
    assert.deepEqual(merge[0].args, ['pr', 'merge', '7', '-R', 'acme/widgets', '--merge', '--match-head-commit', H1]);
    assert.equal(srv.lastDryRunLaunch(), null, 'no Claude session ran the merge');

    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.mergeRequest.mergeSha, MERGE_SHA);
    assert.ok(c.mergeRequest.mergedAt);
    assert.equal(c.state, 'done');
    assert.equal(c.gate.status, 'PASS', 'the close gate cites every AC');
    assert.equal(c.gate.by, 'merge-queue');
    assert.deepEqual(c.gate.missingAC ?? [], []);
    assert.equal(c.gate.evidence.length, 2);
    const rec = c.devLog.find((d) => d.by === 'merge-queue' && /merge record/.test(d.text));
    assert.ok(rec, 'merge record on the devlog');
    for (const part of ['https://github.com/acme/widgets/pull/7', H1, MERGE_SHA, 'tests: pass']) assert.ok(rec.text.includes(part), part);
    assert.ok(!/review/i.test(rec.text), 'no reviewer line when no review is on record');

    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 1, 'a merged request is never merged again');
  });
});

test('one merge per integration branch: a second request waits while the first merges', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withMerge(async ({ srv, post, card, addCard, merging, gh, stateDir, until }) => {
    const a = await addCard();
    const b = await addCard({ title: 'two' });
    merging(a, { number: 7, filedAt: '2026-10-17T10:00:00.000Z' });
    setMergeRequestIn(stateDir, b, createMergeRequest({ prUrl: 'https://github.com/acme/widgets/pull/8', repo: 'acme/widgets', number: 8, base: 'main', head: 'feat/y', headSha: H2, filedBy: 'w' }, { now: '2026-10-17T10:01:00.000Z' }));
    const first = srv.mergeQueueTick();
    await until(() => gh.merges().length === 1, 'merge started');
    await srv.mergeQueueTick(); // overlapping tick while the first merge is in flight
    assert.equal(gh.merges().length, 1, 'still one merge in flight');
    assert.equal(card(b).mergeRequest.stage, 'requested', 'the second request has not started');
    release();
    await first;
    assert.equal(card(a).mergeRequest.stage, 'merged');
    void post;
  }, { pr: { gate } });
});

test('a PR head that moved since it was tested goes back to testing and merges only the new tested head', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh, testRuns }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 0, 'the old tested head is not merged');
    assert.equal(testRuns.length, 1, 'the server started the new test run right away');
    let c = card(id);
    assert.ok(c.mergeRequest.history.some((h) => h.from === 'merging' && h.to === 'testing' && /head moved/.test(h.reason)));
    assert.equal(c.mergeRequest.stage, 'merging', 'the retest passed on the new head');
    assert.equal(c.mergeRequest.tests.headSha, H2);

    await srv.mergeQueueTick();
    assert.deepEqual(gh.merges().map((m) => m.args.at(-1)), [H2]);
    assert.equal(card(id).mergeRequest.stage, 'merged');
  }, { pr: { head: H2 } });
});

test('a CONFLICTING PR goes back to testing and a conflict there bounces it to the author with the files', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh, testRuns }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 0);
    assert.equal(testRuns.length, 1);
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'bounced');
    const h = c.mergeRequest.history;
    assert.ok(h.some((x) => x.from === 'merging' && x.to === 'testing' && /conflict/i.test(x.reason)));
    assert.ok(h.some((x) => x.from === 'testing' && x.to === 'bounced' && /merge conflict with main in src\/a\.js, src\/b\.js/.test(x.reason)));
  }, {
    pr: { mergeable: 'CONFLICTING' },
    testOutcome: { kind: 'conflict', conflict: { files: ['src/a.js', 'src/b.js'] } },
  });
});

test('a request in merging with no test record is sent back to testing, not merged', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh, testRuns }) => {
    const id = await addCard();
    merging(id, { tested: false });
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 0);
    assert.equal(testRuns.length, 1);
    const c = card(id);
    assert.ok(c.mergeRequest.history.some((h) => h.from === 'merging' && h.to === 'testing' && /not tested by the queue yet/.test(h.reason)));
    assert.equal(c.mergeRequest.stage, 'merging', 'tested now, ready to merge');
    assert.ok(c.mergeRequest.tests);
  });
});

test('a base that moved since the tests ran sends the request back to testing', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh, testRuns }) => {
    const id = await addCard();
    merging(id, { testBase: 'a'.repeat(40) });
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 0);
    assert.equal(testRuns.length, 1);
    assert.ok(card(id).mergeRequest.history.some((h) => h.from === 'merging' && h.to === 'testing' && /base moved/.test(h.reason)));
  });
});

test('a failed gh merge holds with the error on the devlog and is not retried on later ticks', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'held');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /Head branch was modified/.test(d.text)));
    assert.notEqual(c.state, 'done');
    await srv.mergeQueueTick();
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 1, 'no retry loop');
  }, { pr: { mergeFails: 'Head branch was modified. Review and try the merge again.' } });
});

test('an unreadable PR holds without merging', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    assert.equal(card(id).mergeRequest.stage, 'held');
    assert.equal(gh.merges().length, 0);
  }, { pr: { viewFails: 'HTTP 502' } });
});

test('a PR already merged on GitHub is recorded and finished without merging again', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 0);
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.mergeRequest.mergeSha, MERGE_SHA);
    assert.equal(c.state, 'done');
  }, { pr: { state: 'MERGED', mergeCommit: MERGE_SHA } });
});

test('a closed PR bounces the request with the reason and merges nothing', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh }) => {
    const id = await addCard();
    merging(id);
    await srv.mergeQueueTick();
    assert.equal(gh.merges().length, 0);
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'bounced');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /closed/i.test(d.text)));
  }, { pr: { state: 'CLOSED' } });
});

test('a paused board or disabled runner merges nothing', async () => {
  await withMerge(async ({ srv, card, addCard, merging, gh, stateDir }) => {
    const id = await addCard();
    merging(id);
    saveConfig(stateDir, { enabled: false });
    await srv.mergeQueueTick();
    assert.equal(gh.calls.length, 0);
    assert.equal(card(id).mergeRequest.stage, 'merging');
  });
});

test('end-to-end: POST /api/backlog/:id/merge-request -> mergeQueueTick walks requested -> testing -> merging -> merged', async () => {
  await withMerge(async ({ srv, post, card, addCard, gh, testRuns }) => {
    const id = await addCard();
    const filed = await post(`/api/backlog/${id}/merge-request`, { prUrl: 'https://github.com/acme/widgets/pull/7', by: 'worker' });
    assert.equal(filed.status, 200);
    assert.equal(card(id).mergeRequest.stage, 'requested');

    await srv.mergeQueueTick();
    assert.equal(testRuns.length, 1);
    assert.equal(card(id).mergeRequest.stage, 'merging', 'the tests passed; the merge is the next tick');
    assert.equal(gh.merges().length, 0);

    await srv.mergeQueueTick();
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.mergeRequest.mergeSha, MERGE_SHA);
    assert.equal(c.mergeRequest.tests.status, 'pass');
    assert.equal(c.mergeRequest.tests.headSha, H1);
    assert.equal(c.mergeRequest.review ?? null, null, 'no reviewer in the restored flow');
    assert.equal(gh.merges().length, 1);
    assert.equal(gh.merges()[0].args.at(-1), H1);
    assert.deepEqual(c.mergeRequest.history.filter((h) => h.from !== h.to).map((h) => h.to), ['requested', 'testing', 'merging', 'merged']);
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /tests passed.*on to merging/.test(d.text)));
    assert.equal(c.state, 'done');
  });
});

test('glmps-2-0-75: an interim request merges but leaves the card open, ungated and in the ledger', async () => {
  await withMerge(async ({ srv, card, stateDir, addCard, merging, gh }) => {
    const id = await addCard();
    setMergeRequestIn(stateDir, id, { ...merging(id), interim: true });
    const before = card(id);
    await srv.mergeQueueTick();

    assert.equal(gh.merges().length, 1);
    const c = card(id);
    assert.equal(c.mergeRequest.stage, 'merged');
    assert.equal(c.state, before.state, 'the card state is untouched');
    assert.equal(c.gate ?? null, before.gate ?? null, 'no close gate is written');
    assert.ok(c.devLog.some((d) => d.by === 'merge-queue' && /merge record/.test(d.text)), 'merge record still written');
    assert.ok(c.devLog.some((d) => /merged as interim; the card stays open/.test(d.text)));
  });
});
