// The per-session feed is paged server-side by `limit` and `before` (card
// glmps-2-0-runtime-58, session-detail spec section 8 item 5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { pageFeed, MAX_FEED_LIMIT } from '../lib/observability/feed-page.js';

const ev = (ts) => ({ kind: 'tool', lane: 'feed', label: `e${ts}`, ts });

test('no limit and no before returns the feed whole, with page totals', () => {
  const log = [ev(1), ev(2), ev(3)];
  const out = pageFeed(log, {});
  assert.equal(out.events, log);
  assert.deepEqual(out.page, { total: 3, returned: 3, limit: null, before: null, hasMore: false, nextBefore: null });
});

test('limit keeps the newest N and points nextBefore at the oldest returned', () => {
  const out = pageFeed([ev(1), ev(2), ev(3), ev(4), ev(5)], { limit: '2' });
  assert.deepEqual(out.events.map(e => e.ts), [4, 5]);
  assert.equal(out.page.hasMore, true);
  assert.equal(out.page.nextBefore, 4);
  assert.equal(out.page.total, 5);
});

test('walking back with before=nextBefore visits every event exactly once', () => {
  const log = [ev(1), ev(2), ev(3), ev(4), ev(5)];
  const seen = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const { events, page } = pageFeed(log, { limit: 2, before });
    seen.unshift(...events.map(e => e.ts));
    if (!page.hasMore) break;
    before = page.nextBefore;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('a run of equal timestamps is never split across pages', () => {
  const log = [ev(1), ev(2), ev(3), ev(3), ev(3), ev(4)];
  const first = pageFeed(log, { limit: 2 });
  assert.deepEqual(first.events.map(e => e.ts), [3, 3, 3, 4]);
  assert.equal(first.page.nextBefore, 3);
  const second = pageFeed(log, { limit: 2, before: first.page.nextBefore });
  assert.deepEqual(second.events.map(e => e.ts), [1, 2]);
  assert.equal(second.page.hasMore, false);
  assert.equal(second.page.nextBefore, null);
});

test('before alone filters strictly older; ISO dates parse; bad values are ignored', () => {
  const log = [ev(1000), ev(2000), ev(3000)];
  assert.deepEqual(pageFeed(log, { before: 2000 }).events.map(e => e.ts), [1000]);
  assert.deepEqual(pageFeed(log, { before: new Date(2500).toISOString() }).events.map(e => e.ts), [1000, 2000]);
  assert.equal(pageFeed(log, { limit: 'x', before: 'nope' }).page.limit, null);
  assert.equal(pageFeed(log, { limit: '0' }).events.length, 3);
  assert.equal(pageFeed(log, { limit: '999999' }).page.limit, MAX_FEED_LIMIT);
});

const iso = (ms) => new Date(ms).toISOString();

test('ISO-string ts (Claude transcript events) pages and walks back, with nextBefore in epoch ms', () => {
  const log = [1000, 2000, 3000, 4000, 5000].map(ms => ({ kind: 'tool', ts: iso(ms) }));
  const first = pageFeed(log, { limit: 2 });
  assert.deepEqual(first.events.map(e => e.ts), [iso(4000), iso(5000)]);
  assert.equal(first.page.nextBefore, 4000);
  const second = pageFeed(log, { limit: 2, before: String(first.page.nextBefore) });
  assert.deepEqual(second.events.map(e => e.ts), [iso(2000), iso(3000)]);
  assert.equal(pageFeed(log, { before: Date.now() }).events.length, 5);
});

test('a mixed feed of ISO and numeric ts walks back across every event once', () => {
  const log = [ev(1000), { ts: iso(2000) }, ev(3000), { ts: iso(3000) }, { ts: iso(4000) }, ev(5000)];
  const seen = [];
  let before;
  for (let i = 0; i < 10; i++) {
    const { events, page } = pageFeed(log, { limit: 2, before });
    seen.unshift(...events);
    if (!page.hasMore) break;
    assert.equal(typeof page.nextBefore, 'number');
    before = page.nextBefore;
  }
  assert.deepEqual(seen, log);
});

test('GET /api/state?session= pages events by limit and before', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-feed-page-'));
  const claudeDir = path.join(tmp, 'claude');
  fs.mkdirSync(path.join(claudeDir, '.claude-manager'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '.claude-manager', 'active-sessions.json'), '[]');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'done-gate'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'done-gate', 's-1.jsonl'),
    [1, 2, 3, 4, 5].map(ts => JSON.stringify({ result: 'pass', ts })).join('\n') + '\n');
  // Written out of order and in both ts shapes: the route must sort them before paging.
  fs.writeFileSync(path.join(stateDir, 'done-gate', 's-iso.jsonl'),
    [[iso(4000)], [3000], [iso(1000)], [5000], [iso(2000)]].map(([ts]) => JSON.stringify({ result: 'pass', ts })).join('\n') + '\n');
  const env = {
    GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ANTIGRAVITY_DIR: path.join(tmp, 'ag'), GLMPS_STATE_DIR: stateDir,
    GLMPS_GEMINI_TMP_DIR: path.join(tmp, 'gemini-tmp'), GLMPS_VSCODE_STORAGE_DIR: path.join(tmp, 'vscode-storage'),
    GLMPS_AGY_CLI_DIR: path.join(tmp, 'agy'), GLMPS_CODEX_DIR: path.join(tmp, 'codex'),
    GLMPS_COPILOT_CLI_DIR: path.join(tmp, 'copilot-cli'),
    GLMPS_HERMES_DIR: path.join(tmp, 'hermes'), GLMPS_OPENCODE_DIR: path.join(tmp, 'opencode'),
    GLMPS_UNMERGED_SCAN: 'off',
  };
  const srv = await startServer({ port: 0, pollMs: 1000, env });
  try {
    const base = `http://127.0.0.1:${srv.port}/api/state?session=s-1`;
    const whole = await (await fetch(base)).json();
    assert.deepEqual(whole.events.map(e => e.ts), [1, 2, 3, 4, 5]);
    assert.equal(whole.page.total, 5);
    assert.equal(whole.page.hasMore, false);
    const newest = await (await fetch(base + '&limit=2')).json();
    assert.deepEqual(newest.events.map(e => e.ts), [4, 5]);
    assert.deepEqual(newest.page, { total: 5, returned: 2, limit: 2, before: null, hasMore: true, nextBefore: 4 });
    const older = await (await fetch(base + `&limit=2&before=${newest.page.nextBefore}`)).json();
    assert.deepEqual(older.events.map(e => e.ts), [2, 3]);
    assert.equal(older.page.nextBefore, 2);
    // contextNow and the other rollups still read the whole log, not the page.
    assert.deepEqual(newest.contextNow, whole.contextNow);

    const isoBase = `http://127.0.0.1:${srv.port}/api/state?session=s-iso`;
    const isoFirst = await (await fetch(isoBase + '&limit=2')).json();
    assert.deepEqual(isoFirst.events.map(e => e.ts), [iso(4000), 5000]);
    assert.equal(isoFirst.page.nextBefore, 4000);
    const isoNext = await (await fetch(isoBase + `&limit=2&before=${isoFirst.page.nextBefore}`)).json();
    assert.deepEqual(isoNext.events.map(e => e.ts), [iso(2000), 3000]);
    const isoLast = await (await fetch(isoBase + `&limit=2&before=${isoNext.page.nextBefore}`)).json();
    assert.deepEqual(isoLast.events.map(e => e.ts), [iso(1000)]);
    assert.equal(isoLast.page.hasMore, false);
  } finally {
    await srv.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});
