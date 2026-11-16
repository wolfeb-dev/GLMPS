// Card glmps-2-0-176: the live check as a registered loop. The ancestry answer
// is remembered until the running build changes, a merge the checkout cannot
// find gets one fetch, and the first run marks silently and writes its marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { loopAlerts } from '../lib/loops/loop-health.js';
import { createLiveNoticeLoop, LIVE_NOTICE_LOOP } from '../lib/orchestration/live-notice-loop.js';

const T = Date.parse('2026-11-11T03:00:00.000Z');
const KERNEL = 'wolfeb-dev/glmps-2.0';
const CFG = { [`${KERNEL}@main`]: 'deploy-glmps2', 'wolfeb-dev/widgets@main': 'deploy-glmps2' };
const merged = (id, sha, { repo = KERNEL } = {}) => ({
  id, mergeRequest: { repo, base: 'main', number: 1, stage: 'merged', mergeSha: sha, history: [{ ts: new Date(T - 3600_000).toISOString(), to: 'merged' }] },
});

// ancestors: merge sha -> 'yes' | 'no' | 'missing' | 'error'; afterFetch overrides once fetched.
function world({ items, ancestors = {}, afterFetch = {}, marker = true, fetchStatus = 0 } = {}) {
  const state = { items: structuredClone(items), marker, calls: [], fetched: false, devlog: [], liveSha: 'live1' };
  const look = (sha) => (state.fetched && afterFetch[sha]) || ancestors[sha] || 'no';
  const deps = {
    loadItems: () => structuredClone(state.items),
    liveSha: () => state.liveSha,
    kernelRepo: async () => KERNEL,
    autoDeploy: () => CFG,
    entries: () => [],
    mainSuite: () => ({}),
    markerExists: () => state.marker,
    writeMarker: () => { state.marker = true; },
    save: (n) => {
      state.items = state.items.map((i) => (i.id === n.id ? { ...i, mergeRequest: n.mr } : i));
      if (n.text) state.devlog.push({ id: n.id, text: n.text });
    },
    git: async (args) => {
      state.calls.push(args.join(' '));
      if (args[0] === 'fetch') { if (fetchStatus === 0) state.fetched = true; return { status: fetchStatus, stdout: '', stderr: fetchStatus ? 'network down' : '' }; }
      const sha = args[0] === 'cat-file' ? args[2].replace('^{commit}', '') : args[2];
      const v = look(sha);
      if (args[0] === 'cat-file') return { status: v === 'missing' ? 128 : 0, stdout: '', stderr: '' };
      return { status: v === 'yes' ? 0 : v === 'no' ? 1 : 128, stdout: '', stderr: v === 'missing' ? 'fatal: Not a valid commit name' : 'fatal: timeout' };
    },
    now: () => T,
  };
  return { state, deps };
}

test('the spec is a 60 s loop with a distinct maker and checker', () => {
  const loop = createLiveNoticeLoop(world({ items: [] }).deps);
  assert.notEqual(loop.maker, loop.checker);
  assert.deepEqual(LIVE_NOTICE_LOOP.trigger, { everyMs: 60_000 });
  assert.equal(LIVE_NOTICE_LOOP.name, 'merge-queue-live-notice');
  assert.equal(LIVE_NOTICE_LOOP.ceiling.maxModelCalls, 0);
});

test('a merge not in the build is checked once per running build, not once per run', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')] });
  const loop = createLiveNoticeLoop(deps);
  for (let i = 0; i < 5; i += 1) assert.equal((await loop.maker({})).outcome, 'nothing-to-do');
  assert.deepEqual(state.calls, ['merge-base --is-ancestor sha-a live1'], 'one git call across 5 runs');
  state.liveSha = 'live2';
  await loop.maker({});
  assert.equal(state.calls.length, 2, 'a new running build checks again');
});

test('a merge in the build is marked live with one post, and the checker reads it back', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'yes' } });
  const loop = createLiveNoticeLoop(deps);
  const made = await loop.maker({});
  assert.equal(made.outcome, 'done');
  assert.deepEqual(state.items[0].mergeRequest.live, { sha: 'live1', ts: T });
  assert.match(state.devlog[0].text, /^Live: /);
  assert.equal((await loop.checker(made.result)).ok, true);
  assert.equal((await loop.maker({})).outcome, 'nothing-to-do');
  assert.equal(state.calls.length, 1, 'a live merge is never checked again');
});

test('the first run marks a live merge silently and writes the marker', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'yes' }, marker: false });
  const loop = createLiveNoticeLoop(deps);
  const made = await loop.maker({});
  assert.ok(state.items[0].mergeRequest.live);
  assert.equal(state.devlog.length, 0, 'quiet on the first run');
  assert.equal(state.marker, true);
  assert.equal((await loop.checker(made.result)).ok, true);
});

test('the first run writes the marker even with nothing to check', async () => {
  const { state, deps } = world({ items: [], marker: false });
  assert.equal((await createLiveNoticeLoop(deps).maker({})).outcome, 'nothing-to-do');
  assert.equal(state.marker, true);
});

test('a missing merge commit gets one fetch: found after it, it is checked as usual', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'missing' }, afterFetch: { 'sha-a': 'yes' } });
  await createLiveNoticeLoop(deps).maker({});
  assert.deepEqual(state.calls, ['merge-base --is-ancestor sha-a live1', 'cat-file -e sha-a^{commit}', 'fetch -q origin', 'merge-base --is-ancestor sha-a live1']);
  assert.ok(state.items[0].mergeRequest.live);
});

test('a merge commit still missing after the fetch is marked unverifiable once and never checked again', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'missing' } });
  const loop = createLiveNoticeLoop(deps);
  const made = await loop.maker({});
  assert.equal(made.outcome, 'done');
  assert.ok(state.items[0].mergeRequest.liveUnknown);
  assert.match(state.devlog[0].text, /^Cannot check live: /);
  assert.equal((await loop.checker(made.result)).ok, true);
  const n = state.calls.length;
  state.liveSha = 'live2';
  await loop.maker({});
  assert.equal(state.calls.length, n, 'no git for an unverifiable merge, even after a deploy');
});

test('a failed fetch fails the run instead of marking the merge unverifiable', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'missing' }, fetchStatus: 1 });
  await assert.rejects(createLiveNoticeLoop(deps).maker({}), /git fetch failed: network down/);
  assert.equal(state.items[0].mergeRequest.liveUnknown, undefined);
});

test('a git error on a commit that exists fails the run instead of marking it unverifiable', async () => {
  const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'error' } });
  await assert.rejects(createLiveNoticeLoop(deps).maker({}), /merge-base failed for sha-a/);
  assert.equal(state.items[0].mergeRequest.liveUnknown, undefined);
});

test('a merge into another repo runs no git: a finished deploy after it marks it live', async () => {
  const other = merged('w', 'sha-w', { repo: 'wolfeb-dev/widgets' });
  const { state, deps } = world({ items: [other] });
  const at = T - 1800_000;
  deps.entries = () => [
    { type: 'request', id: 'r1', action: 'deploy-glmps2', ts: at },
    { type: 'run-started', id: 'r1', action: 'deploy-glmps2', ts: at },
    { type: 'run-finished', id: 'r1', action: 'deploy-glmps2', ts: at + 1000, result: { ok: true } },
  ];
  await createLiveNoticeLoop(deps).maker({});
  assert.deepEqual(state.calls, []);
  assert.equal(state.items[0].mergeRequest.live.via, 'deploy');
});

test('the loop is off without deploy config, without a running commit, or while the queue may not run', async () => {
  for (const patch of [{ autoDeploy: () => ({}) }, { liveSha: () => null }, { enabled: () => false }]) {
    const { state, deps } = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'yes' } });
    assert.equal((await createLiveNoticeLoop({ ...deps, ...patch }).maker({})).outcome, 'nothing-to-do');
    assert.equal(state.calls.length, 0);
  }
});

test('proof it closes: a failing maker alerts, a lost write fails the checker, a good run clears', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-live-notice-loop-'));
  const reg = createLoopRegistry({ stateDir, now: () => T, setTimer: () => 0, clearTimer: () => {} });
  try {
    const broken = world({ items: [merged('a', 'sha-a')] });
    broken.deps.loadItems = () => { throw new Error('backlog unreadable'); };
    let current = createLiveNoticeLoop(broken.deps);
    const handle = reg.registerLoop({ ...LIVE_NOTICE_LOOP, maker: (ctx) => current.maker(ctx), checker: (r, ctx) => current.checker(r, ctx) });
    await handle.runNow();
    assert.match(reg.snapshot()['merge-queue-live-notice'].lastOutcome, /^failed:/);
    assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: merge-queue-live-notice').length, 1);

    const lost = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'yes' } });
    lost.deps.save = () => {};
    current = createLiveNoticeLoop(lost.deps);
    await handle.runNow();
    assert.match(reg.snapshot()['merge-queue-live-notice'].lastReason, /a: live not recorded for sha-a/);

    const good = world({ items: [merged('a', 'sha-a')], ancestors: { 'sha-a': 'yes' } });
    current = createLiveNoticeLoop(good.deps);
    await handle.runNow();
    const snap = reg.snapshot()['merge-queue-live-notice'];
    assert.equal(snap.lastOutcome, 'done');
    assert.equal(snap.consecutiveFailures, 0);
    assert.equal(loopAlerts(reg.snapshot()).filter((a) => a.title === 'Loop failing: merge-queue-live-notice').length, 0);
  } finally {
    reg.stop?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
