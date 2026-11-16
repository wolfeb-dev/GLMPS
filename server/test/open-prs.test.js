// Routes under test: server/lib/routes/surface-routes.js
// Card glmps-2-0-113: the Surface Open PRs layer's feed. gh is a fake seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOpenPrs, annotateWithQueue, sortOpenPrs, createOpenPrsSource, openPrsGhArgs } from '../lib/observability/open-prs.js';
import { openPrRows } from '../../web/surface/event-layers.js';

const pr = (n, repo, updatedAt, extra = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/${repo}/pull/${n}`, repository: { name: repo, nameWithOwner: `o/${repo}` },
  author: { login: 'o' }, isDraft: false, createdAt: updatedAt, updatedAt, ...extra,
});

test('parseOpenPrs: keeps the fields the layer shows, drops rows without a PR url, null on junk', () => {
  const out = parseOpenPrs(JSON.stringify([pr(4, 'a', '2026-10-27T01:00:00Z', { isDraft: true }), { number: 5, url: 'https://example.com/x' }]));
  assert.deepEqual(out, [{ repo: 'o/a', number: 4, title: 'PR 4', url: 'https://github.com/o/a/pull/4', author: 'o', draft: true, createdAt: '2026-10-27T01:00:00Z', updatedAt: '2026-10-27T01:00:00Z' }]);
  assert.equal(parseOpenPrs('not json'), null);
  assert.equal(parseOpenPrs('{}'), null);
});

test('annotateWithQueue marks a PR a card filed, by url, case-insensitive; sort puts the most recently updated first', () => {
  const prs = parseOpenPrs(JSON.stringify([pr(1, 'b', '2026-10-26T05:00:00Z'), pr(2, 'a', '2026-10-27T05:00:00Z')]));
  const items = [{ id: 'card-9', mergeRequest: { prUrl: 'https://github.com/O/A/pull/2', stage: 'reviewing' } }, { id: 'card-1' }];
  const out = sortOpenPrs(annotateWithQueue(prs, items));
  assert.deepEqual(out.map((p) => p.number), [2, 1]);
  assert.deepEqual(out[0].queue, { cardId: 'card-9', stage: 'reviewing' });
  assert.equal(out[1].queue, null);
});

test('createOpenPrsSource: one login lookup, cached within the TTL, a failure is returned and retried', async () => {
  let t = 0; const calls = [];
  let fail = true;
  const gh = async (file, args) => {
    calls.push(args.slice(0, 2).join(' '));
    if (args[0] === 'api') return { status: 0, stdout: 'o\n' };
    if (fail) return { status: 1, stderr: 'rate limited' };
    assert.deepEqual(args, openPrsGhArgs.search('o'));
    return { status: 0, stdout: JSON.stringify([pr(1, 'a', '2026-10-27T00:00:00Z')]) };
  };
  const src = createOpenPrsSource({ gh, now: () => t, ttlMs: 1000 });
  const bad = await src.get();
  assert.equal(bad.ok, false); assert.match(bad.error, /rate limited/);
  fail = false;
  const [a, b] = await Promise.all([src.get(), src.get()]);
  assert.equal(a.ok, true); assert.equal(a, b, 'concurrent callers share one gh call');
  t = 500; await src.get();
  assert.deepEqual(calls, ['api user', 'search prs', 'search prs'], 'the cached result serves within the TTL');
  t = 2000; await src.get();
  assert.equal(calls.length, 4);
});

test('openPrRows: a row per PR, linking out to GitHub, saying draft and queue stage', () => {
  const rows = openPrRows([
    { repo: 'o/a', number: 2, title: 'Fix it', url: 'https://github.com/o/a/pull/2', draft: true, updatedAt: '2026-10-27T00:00:00Z', queue: null },
    { repo: 'o/b', number: 3, title: 'Ship it', url: 'https://github.com/o/b/pull/3', draft: false, updatedAt: '2026-10-27T00:00:00Z', queue: { cardId: 'c-1', stage: 'testing' } },
  ], Date.parse('2026-10-27T03:00:00Z'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].href, 'https://github.com/o/a/pull/2');
  assert.match(rows[0].text, /^o\/a#2 {2}Fix it {2}draft {2}3 h$/);
  assert.match(rows[1].text, /queue: testing \(c-1\)/);
});

test('server: GET /api/surface/open-prs serves the gh search through the seam, and 503s when gh fails', async () => {
  const { startServer } = await import('../server.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-openprs-'));
  const stateDir = path.join(base, 'state'); fs.mkdirSync(stateDir);
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ actionsMinutes: { enabled: false } }));
  let ok = false;
  const gh = async (file, args) => {
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: 'o\n' };
    if (args[0] === 'search') return ok ? { status: 0, stdout: JSON.stringify([pr(7, 'a', '2026-10-27T00:00:00Z')]) } : { status: 1, stderr: 'not signed in' };
    return { status: 1, stderr: 'unexpected' };
  };
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' };
  const h = await startServer({ port: 0, env, configFile, ghRun: gh });
  try {
    const bad = await fetch(`http://127.0.0.1:${h.port}/api/surface/open-prs`);
    assert.equal(bad.status, 503);
    assert.match((await bad.json()).error, /not signed in/);
    ok = true;
    const j = await (await fetch(`http://127.0.0.1:${h.port}/api/surface/open-prs`)).json();
    assert.equal(j.owner, 'o');
    assert.deepEqual(j.prs.map((p) => [p.repo, p.number, p.url, p.queue]), [['o/a', 7, 'https://github.com/o/a/pull/7', null]]);
  } finally {
    await h.close?.();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// glmps-2-0-191: the open-PR set as a prUrl -> state map for the closed-card check.
test('openPrStates maps each open PR url to OPEN and fails open on a failed lookup', async () => {
  const { openPrStates } = await import('../lib/observability/open-prs.js');
  const m = openPrStates({ ok: true, prs: [{ url: 'https://github.com/o/r/pull/1' }, { url: 'https://github.com/o/r/pull/2' }] });
  assert.equal(m.get('https://github.com/o/r/pull/1'), 'OPEN');
  assert.equal(m.size, 2);
  assert.equal(openPrStates({ ok: false, error: 'gh down' }).size, 0);
  assert.equal(openPrStates(null).size, 0);
  assert.equal(openPrStates(undefined).size, 0);
});
