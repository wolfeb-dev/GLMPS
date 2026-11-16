// glmps-2-0-171 D4: the orphan-sweep loop. Proof it closes: an orphan is posted
// once a day at 16:00 UTC, listed again the next day while it stays orphaned,
// and gone once the operator answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orphanSweepLoop, DUE_HOUR_UTC } from '../lib/orchestration/orphan-sweep.js';
import { createLoopRegistry } from '../lib/loops/registry.js';

const at = (iso) => Date.parse(iso);
function fixture(items) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-orphan-sweep-'));
  const posts = [];
  let clock = at('2026-11-10T16:05:00.000Z');
  const loop = orphanSweepLoop({
    stateDir: dir,
    readItems: () => items,
    live: () => [],
    parked: () => [],
    post: async (t) => { posts.push(t); },
    now: () => clock,
  });
  const run = async () => { const r = await loop.maker(); return { ...r, check: await loop.checker(r.result) }; };
  return { loop, posts, run, set: (iso) => { clock = at(iso); }, items };
}
const orphan = (id) => ({ id, title: `t ${id}`, state: 'held', updatedAt: '2026-11-01T00:00:00.000Z', devLog: [{ text: 'stopped' }] });

test('before 16:00 UTC nothing is posted; after it, one post lists the orphans', async () => {
  assert.equal(DUE_HOUR_UTC, 16);
  const f = fixture([orphan('a-1'), orphan('a-2')]);
  f.set('2026-11-10T15:59:00.000Z');
  assert.equal((await f.run()).outcome, 'nothing-to-do');
  assert.equal(f.posts.length, 0);
  f.set('2026-11-10T16:05:00.000Z');
  const r = await f.run();
  assert.equal(r.outcome, 'done');
  assert.equal(r.result.posted, 2);
  assert.equal(r.check.ok, true);
  assert.equal(f.posts.length, 1);
  assert.match(f.posts[0], /a-1.*run a-1.*drop a-1/s);
  assert.match(f.posts[0], /a-2/);
});

test('a second run the same day is quiet; the next day the unchanged orphan is listed again', async () => {
  const f = fixture([orphan('a-1')]);
  await f.run();
  f.set('2026-11-10T20:00:00.000Z');
  assert.equal((await f.run()).outcome, 'nothing-to-do');
  f.set('2026-11-11T16:30:00.000Z');
  assert.equal((await f.run()).outcome, 'done');
  assert.equal(f.posts.length, 2);
});

test('no orphans is nothing-to-do and posts nothing, and the day is not burned', async () => {
  const f = fixture([]);
  assert.equal((await f.run()).outcome, 'nothing-to-do');
  f.items.push(orphan('a-1'));
  f.set('2026-11-10T18:00:00.000Z');
  assert.equal((await f.run()).outcome, 'done');
  assert.equal(f.posts.length, 1);
});

test('with Slack not connected the loop is nothing-to-do and keeps the day for later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-orphan-sweep-'));
  let connected = false; const posts = [];
  const loop = orphanSweepLoop({ stateDir: dir, readItems: () => [orphan('a-1')], live: () => [], parked: () => [], post: async (t) => { posts.push(t); }, canPost: () => connected, now: () => at('2026-11-10T17:00:00.000Z') });
  assert.equal((await loop.maker()).outcome, 'nothing-to-do');
  connected = true;
  assert.equal((await loop.maker()).outcome, 'done');
  assert.equal(posts.length, 1);
});

test('a refused post fails the run (never a silent defer) and is retried the same day', async () => {
  const f = fixture([orphan('a-1')]);
  let fail = true;
  const loop = orphanSweepLoop({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mc-orphan-sweep-')), readItems: () => f.items, live: () => [], parked: () => [], post: async (t) => { if (fail) throw new Error('slack down'); f.posts.push(t); }, now: () => at('2026-11-10T17:00:00.000Z') });
  const r = await loop.maker();
  assert.equal(r.outcome, 'done', 'a nothing-to-do outcome would skip the checker');
  const verdict = await loop.checker(r.result);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /slack down/);
  fail = false;
  assert.equal((await loop.maker()).outcome, 'done');
});

test('registers in the real registry with a distinct checker, ceiling and SLA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-orphan-sweep-'));
  const reg = createLoopRegistry({ stateDir: dir, log: () => {} });
  const spec = orphanSweepLoop({ stateDir: dir, readItems: () => [], live: () => [], parked: () => [], post: async () => {}, now: Date.now });
  reg.registerLoop({ name: 'orphan-sweep', trigger: { everyMs: 3_600_000 }, ...spec });
  assert.ok(reg.get('orphan-sweep'));
  reg.stop?.();
});

test('the server registers orphan-sweep and a manual run on an empty board is nothing-to-do', async () => {
  const { startServer } = await import('../server.js');
  const { claudeTmp } = await import('./fixtures/claude-dir.js');
  const { waitFor } = await import('./helpers/wait-for.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-orphan-srv-'));
  const claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  const url = `http://127.0.0.1:${h.port}`;
  try {
    assert.equal((await fetch(`${url}/api/loops/orphan-sweep/run`, { method: 'POST' })).status, 202);
    const loop = await waitFor(async () => { const l = await (await fetch(`${url}/api/loops/orphan-sweep`)).json(); return l?.lastOutcome ? l : null; }, { message: 'the loop to finish a run' });
    assert.equal(loop.lastOutcome, 'nothing-to-do');
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
