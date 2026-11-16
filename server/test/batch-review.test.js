// Card glmps-2-0-runtime-126: an independent review every BATCH_MERGES merges,
// deferred past a live session and a running full suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBatchReviewLoop, acceptFindings, abandonRun, loadState, saveState, stateFile,
  reviewDirName, pickReviewerModel, buildBatchSeed, hashNonce,
} from '../lib/orchestration/batch-review.js';
import { BATCH_MERGES } from '../lib/orchestration/main-suite.js';

const NOW = Date.parse('2026-11-01T20:00:00.000Z');
const KEY = 'acme/w@main';

function tmpState() { return fs.mkdtempSync(path.join(os.tmpdir(), 'batch-review-')); }

function harness({ stateDir = tmpState(), tip = 'm5', merges = ['m1', 'm2', 'm3', 'm4', 'm5'], live = new Set(), suite = false, launchOk = true, now = NOW } = {}) {
  const notes = []; const launches = []; const calls = [];
  let clock = now;
  const git = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${tip}\n`, stderr: '' };
    // The desktop shell refuses rev-list, so the loop must read merges with log.
    if (args[0] === 'rev-list') throw new Error('git rev-list is not allowed');
    if (args[0] === 'log') return { status: 0, stdout: [...merges].reverse().join('\n'), stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: 'diff --git a/x b/x\n+changed\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const cards = merges.map((sha, i) => ({ id: `card-${i + 1}`, title: `Card ${i + 1}`, mergeSha: sha, number: 10 + i, acceptanceCriteria: [{ text: `criterion of card ${i + 1}` }] }));
  const loop = createBatchReviewLoop({
    targets: async () => [{ key: KEY, repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git,
    readState: () => loadState(stateDir),
    writeState: (d) => saveState(stateDir, d),
    cardsForShas: (shas) => cards.filter((c) => shas.includes(c.mergeSha)),
    sessionLive: (id) => live.has(id),
    suiteActive: () => suite,
    postNote: (id, text) => notes.push({ id, text }),
    launch: async (l) => { launches.push(l); return launchOk ? { ok: true } : { ok: false, reason: 'no shell' }; },
    reviewerModel: () => 'sonnet',
    port: 8123,
    nowMs: () => clock,
    newNonce: () => 'nonce-1',
  });
  return { loop, notes, launches, calls, stateDir, live, setSuite: (v) => { suite = v; }, tick: (ms) => { clock += ms; } };
}

function seedBaseline(stateDir, sha = 'm0') { saveState(stateDir, { [KEY]: { lastReviewedSha: sha } }); }

test('the first sight of a branch records its tip as the baseline and reviews nothing', async () => {
  const h = harness();
  const r = await h.loop.maker();
  assert.equal(r.outcome, 'done');
  assert.equal(loadState(h.stateDir)[KEY].lastReviewedSha, 'm5');
  assert.equal(h.launches.length, 0);
});

test('under the batch size nothing runs', async () => {
  const h = harness({ merges: ['m1', 'm2', 'm3', 'm4'], tip: 'm4' });
  seedBaseline(h.stateDir);
  const r = await h.loop.maker();
  assert.equal(r.outcome, 'nothing-to-do');
  assert.equal(h.launches.length, 0);
});

test('AC-1: after 5 merges one reviewer runs over last-reviewed..tip and its findings file one card', async () => {
  const h = harness();
  seedBaseline(h.stateDir);
  const r = await h.loop.maker();
  assert.equal(r.outcome, 'done');
  assert.equal(h.launches.length, 1);
  const l = h.launches[0];
  assert.equal(l.toSha, 'm5');
  assert.equal(l.model, 'sonnet');
  assert.match(l.dir, /-review-r1$/);
  assert.ok(h.calls.includes('diff m0..m5'), h.calls.join('|'));
  assert.match(l.seed, /criterion of card 1/);
  assert.match(l.seed, /criterion of card 5/);
  assert.match(l.seed, /\+changed/);
  assert.match(l.seed, /"nonce":"nonce-1"/);
  const ck = await h.loop.checker(r.result);
  assert.equal(ck.ok, true, ck.reason);

  // A second tick while it runs launches nothing more.
  assert.equal((await h.loop.maker()).outcome, 'nothing-to-do');
  assert.equal(h.launches.length, 1);

  const state = loadState(h.stateDir);
  assert.equal(acceptFindings({ state, body: { key: KEY, nonce: 'wrong', findings: ['x'] }, nowMs: NOW }).status, 403);
  const ok = acceptFindings({ state, body: { key: KEY, nonce: 'nonce-1', findings: ['AC-2 of card 3 is untested', 'card 5 leaks a handle'], summary: 'two issues' }, nowMs: NOW });
  assert.equal(ok.status, 200);
  assert.match(ok.card.title, /2 findings/);
  assert.match(ok.card.prompt, /AC-2 of card 3 is untested/);
  assert.match(ok.card.prompt, /card-1.*card-5|card-5.*card-1/s);
  assert.equal(ok.card.project, 'p');
  saveState(h.stateDir, ok.state);
  const after = loadState(h.stateDir)[KEY];
  assert.equal(after.lastReviewedSha, 'm5');
  assert.equal(after.running, null);
  // The nonce is spent.
  assert.equal(acceptFindings({ state: ok.state, body: { key: KEY, nonce: 'nonce-1', findings: [] }, nowMs: NOW }).status, 403);
});

test('a clean review files no card and still advances the reviewed sha', async () => {
  const h = harness();
  seedBaseline(h.stateDir);
  await h.loop.maker();
  const ok = acceptFindings({ state: loadState(h.stateDir), body: { key: KEY, nonce: 'nonce-1', findings: [], summary: 'clean' }, nowMs: NOW });
  assert.equal(ok.status, 200);
  assert.equal(ok.card, null);
  assert.equal(ok.state[KEY].lastReviewedSha, 'm5');
  assert.equal(ok.state[KEY].lastResult, 'clean');
});

test('acceptFindings validates the findings list', () => {
  const state = { [KEY]: { running: { nonceHash: hashNonce('n'), from: 'a', to: 'b', cards: [], project: 'p' } } };
  assert.equal(acceptFindings({ state, body: { key: KEY, nonce: 'n', findings: 'x' } }).status, 400);
  assert.equal(acceptFindings({ state, body: { key: KEY, nonce: 'n', findings: [''] } }).status, 400);
  assert.equal(acceptFindings({ state, body: { key: 'other@main', nonce: 'n', findings: [] } }).status, 403);
});

test('AC-2: a live session on the triggering card holds the review and gets one note, then it runs after the session ends', async () => {
  const h = harness({ live: new Set(['card-5']) });
  seedBaseline(h.stateDir);
  let r = await h.loop.maker();
  assert.equal(h.launches.length, 0);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].id, 'card-5');
  assert.match(h.notes[0].text, /batched review of merges m0\.\.m5 will run after this session ends/);
  assert.equal(r.outcome, 'done'); // the pending range and the note are new state

  r = await h.loop.maker();
  assert.equal(r.outcome, 'nothing-to-do');
  assert.equal(h.notes.length, 1, 'the note is posted once');
  assert.equal(h.launches.length, 0);

  h.live.delete('card-5');
  r = await h.loop.maker();
  assert.equal(r.outcome, 'done');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].toSha, 'm5');
});

test('AC-2: the range is fixed when it falls due; merges after it wait for the next batch', async () => {
  const stateDir = tmpState();
  seedBaseline(stateDir);
  const h1 = harness({ stateDir, live: new Set(['card-5']) });
  await h1.loop.maker();
  const h2 = harness({ stateDir, tip: 'm7', merges: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'] });
  await h2.loop.maker();
  assert.equal(h2.launches[0].toSha, 'm5');
  assert.ok(h2.calls.includes('diff m0..m5'));
});

test('AC-3: the review never starts while the full suite runs', async () => {
  const h = harness({ suite: true });
  seedBaseline(h.stateDir);
  const r = await h.loop.maker();
  assert.equal(h.launches.length, 0);
  assert.notEqual(r.outcome, 'failed');
  assert.ok(loadState(h.stateDir)[KEY].pending, 'the due range is kept');
  h.setSuite(false);
  await h.loop.maker();
  assert.equal(h.launches.length, 1);
});

test('AC-4: the last reviewed sha, a pending range and a running review survive a restart', async () => {
  const stateDir = tmpState();
  seedBaseline(stateDir);
  const h1 = harness({ stateDir });
  await h1.loop.maker();
  // A new loop instance over the same state file (a server restart).
  const h2 = harness({ stateDir });
  assert.equal((await h2.loop.maker()).outcome, 'nothing-to-do', 'the running review is remembered');
  assert.equal(h2.launches.length, 0);
  const ok = acceptFindings({ state: loadState(stateDir), body: { key: KEY, nonce: 'nonce-1', findings: [] }, nowMs: NOW });
  saveState(stateDir, ok.state);
  const raw = JSON.parse(fs.readFileSync(stateFile(stateDir), 'utf8'));
  assert.equal(raw[KEY].lastReviewedSha, 'm5');
  assert.ok(!JSON.stringify(raw).includes('nonce-1'), 'only the nonce hash is stored');
  const h3 = harness({ stateDir, tip: 'm5' });
  assert.equal((await h3.loop.maker()).outcome, 'nothing-to-do');
});

test('a reviewer that exits without findings or times out is retried and the tick fails', async () => {
  const h = harness();
  seedBaseline(h.stateDir);
  await h.loop.maker();
  const jobId = h.launches[0].jobId;
  saveState(h.stateDir, abandonRun(loadState(h.stateDir), KEY, jobId, 'reviewer exited (code 1)'));
  await assert.rejects(h.loop.maker(), /reviewer exited/);
  assert.equal(h.launches.length, 2, 'relaunched on the same tick');
  assert.equal(h.launches[1].toSha, 'm5');
  assert.match(h.launches[1].dir, /-review-r2$/);

  h.tick(2 * 60 * 60 * 1000);
  await assert.rejects(h.loop.maker(), /no findings within/);
  assert.equal(h.launches.length, 3);
});

test('a launch that cannot start keeps the range and fails the tick', async () => {
  const h = harness({ launchOk: false });
  seedBaseline(h.stateDir);
  await assert.rejects(h.loop.maker(), /no shell/);
  assert.ok(loadState(h.stateDir)[KEY].pending);
  assert.equal(loadState(h.stateDir)[KEY].running ?? null, null);
});

test('helpers: review dir matches the shell review recipe, model differs from the default, seed marks data untrusted', () => {
  assert.match(reviewDirName('Acme/W@glmps2/main', 3), /^batch-acme_w_glmps2_main-review-r3$/);
  assert.match(reviewDirName(KEY, 1000), /-review-r\d{1,3}$/);
  assert.equal(pickReviewerModel({ defaultModel: 'claude-opus-5-5' }), 'sonnet');
  assert.equal(pickReviewerModel({ defaultModel: 'claude-sonnet-5-5' }), 'opus');
  assert.equal(pickReviewerModel({}), 'opus');
  const seed = buildBatchSeed({ key: KEY, repo: 'acme/w', base: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40), cards: [], diff: { text: 'd', truncated: true, total: 9 }, port: 1, nonce: 'n' });
  assert.match(seed, /untrusted data/);
  assert.match(seed, /truncated/);
  assert.equal(BATCH_MERGES, 5);
});

// Card glmps-2-0-175: a failed fetch or log used to be a quiet skip, so the
// run read nothing-to-do while the loop's other errors already failed it.
for (const failing of ['fetch', 'log']) {
  test(`a failed git ${failing} fails the run, rather than reading nothing-to-do`, async () => {
    const stateDir = tmpState();
    seedBaseline(stateDir);
    const launches = [];
    const loop = createBatchReviewLoop({
      targets: async () => [{ key: KEY, repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
      git: async (args) => {
        if (args[0] === failing) return { status: 128, stdout: '', stderr: 'fatal: unable to access origin' };
        if (args[0] === 'rev-parse') return { status: 0, stdout: 'm5', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      readState: () => loadState(stateDir),
      writeState: (d) => saveState(stateDir, d),
      cardsForShas: () => [],
      sessionLive: () => false,
      suiteActive: () => false,
      postNote: () => {},
      launch: async (l) => { launches.push(l); return { ok: true }; },
      reviewerModel: () => 'sonnet',
      port: 8123,
      nowMs: () => NOW,
      newNonce: () => 'nonce-1',
    });
    await assert.rejects(() => loop.maker(), new RegExp(`acme.w@main: git ${failing} failed: fatal: unable to access origin`));
    assert.equal(launches.length, 0);
  });
}

// Card glmps-2-0-215: the full-suite loop fetches the same checkout at the same moment.
test('a ref-lock collision on fetch is retried, not failed (glmps-2-0-215)', async () => {
  const stateDir = tmpState();
  let fetches = 0;
  const slept = [];
  const loop = createBatchReviewLoop({
    targets: async () => [{ key: KEY, repo: 'acme/w', base: 'main', project: 'p', repoPath: '/repo' }],
    git: async (args) => {
      if (args[0] === 'fetch') return ++fetches === 1 ? { status: 1, stdout: '', stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at b but expected a" } : { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'm5', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    readState: () => loadState(stateDir),
    writeState: (d) => saveState(stateDir, d),
    cardsForShas: () => [],
    sessionLive: () => false,
    suiteActive: () => false,
    postNote: () => {},
    launch: async () => ({ ok: true }),
    reviewerModel: () => 'sonnet',
    port: 8123,
    nowMs: () => NOW,
    newNonce: () => 'nonce-1',
    sleep: async (ms) => { slept.push(ms); },
  });
  const r = await loop.maker();
  assert.equal(r.outcome, 'done');
  assert.equal(fetches, 2);
  assert.equal(slept.length, 1);
  assert.equal(loadState(stateDir)[KEY].lastReviewedSha, 'm5');
});
