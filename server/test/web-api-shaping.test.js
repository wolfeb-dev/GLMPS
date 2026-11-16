// server/test/web-api-shaping.test.js
// glmps-49: request-shaping logic in web/shared/api.js - query-string building,
// body construction, and URL helpers. No DOM and no server: globalThis.fetch is
// stubbed to capture (url, init). The module's window-fetch wrapper is guarded
// by `typeof window !== 'undefined'`, so importing it in Node is side-effect free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getState, search, learningAction, baselineReportUrl, addBacklogItem, rebuildGraph, resume } from '../../web/shared/api.js';

/** Run fn with fetch stubbed; returns the captured calls [{url, init}]. */
async function captureFetch(fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try { await fn(); } finally { globalThis.fetch = orig; }
  return calls;
}

test('getState encodes the session id into the query', async () => {
  const calls = await captureFetch(() => getState('gemini:a b/c'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/state?session=${encodeURIComponent('gemini:a b/c')}`);
  const bare = await captureFetch(() => getState());
  assert.equal(bare[0].url, '/api/state');
  const paged = await captureFetch(() => getState('s 1', { limit: 50, before: 1793062085629 }));
  assert.equal(paged[0].url, '/api/state?session=s%201&limit=50&before=1793062085629');
});

test('search builds the filter query string only from set filters', async () => {
  const calls = await captureFetch(() => search('rate limit', {
    messageType: 'assistant', hasErrors: true, project: 'D:\\proj',
    dateRange: { from: '2026-01-01', to: '2026-02-01' },
  }));
  const u = new URL(calls[0].url, 'http://x');
  assert.equal(u.pathname, '/api/search');
  assert.equal(u.searchParams.get('q'), 'rate limit');
  assert.equal(u.searchParams.get('messageType'), 'assistant');
  assert.equal(u.searchParams.get('hasErrors'), '1');
  assert.equal(u.searchParams.get('project'), 'D:\\proj');
  assert.equal(u.searchParams.get('from'), '2026-01-01');
  assert.equal(u.searchParams.get('to'), '2026-02-01');
  // unset filters are absent, not empty
  const bare = await captureFetch(() => search('x'));
  const bu = new URL(bare[0].url, 'http://x');
  assert.deepEqual([...bu.searchParams.keys()], ['q']);
});

test('learningAction shapes the body per action: promote -> {target}, alternative -> {rule}', async () => {
  const promote = await captureFetch(() => learningAction('item/1', 'promote', 'global'));
  assert.equal(promote[0].url, `/api/learning/item/${encodeURIComponent('item/1')}/promote`);
  assert.deepEqual(JSON.parse(promote[0].init.body), { target: 'global' });

  const alt = await captureFetch(() => learningAction('id2', 'alternative', 'my rule'));
  assert.deepEqual(JSON.parse(alt[0].init.body), { rule: 'my rule' });

  const dismiss = await captureFetch(() => learningAction('id3', 'dismiss'));
  assert.deepEqual(JSON.parse(dismiss[0].init.body), {});
});

// Guard proposer cutover: a non-2xx response (e.g.
// approving an item with no proposedGuard.rule now 400s) must reject the
// promise, or every caller's wireAction/run() sees a resolved promise and
// renders as if the action landed.
test('learningAction throws on a non-2xx response, with the server\'s own error text', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'no guard rule to apply' }) });
  try {
    await assert.rejects(() => learningAction('id4', 'approve'), /no guard rule to apply/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('learningAction still resolves normally on a 2xx response', async () => {
  const calls = await captureFetch(() => learningAction('id5', 'approve'));
  assert.equal(calls.length, 1);
});

// addBacklogItem used to resolve on a 4xx with the
// server's error body instead of rejecting - a 400 (e.g. empty title) was
// indistinguishable from success to every caller. Real shapes from
// server/server.js's POST /api/backlog handler: 201 <item> on success,
// 400 { error: 'empty title' } / { error: 'invalid json' } on failure.
test('addBacklogItem throws on a non-2xx response, with the server\'s own error text', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'empty title' }) });
  try {
    await assert.rejects(() => addBacklogItem({ project: 'p', title: '' }), /empty title/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('addBacklogItem resolves with the created item on 201', async () => {
  const orig = globalThis.fetch;
  const item = { id: 'mc-9', project: 'p', title: 'x', state: 'queued' };
  globalThis.fetch = async () => ({ ok: true, status: 201, json: async () => item });
  try {
    assert.deepEqual(await addBacklogItem({ project: 'p', title: 'x' }), item);
  } finally {
    globalThis.fetch = orig;
  }
});

// rebuildGraph used to resolve on a 4xx/5xx with the
// server's error body instead of rejecting. Real shapes from
// server/server.js's POST /api/graph/rebuild handler: 200 { graphs,
// skipped: [{ root, reason: 'graphify-busy' }] } on success (skipped may be
// empty, or carry an entry per root that was busy, never an error field);
// 400 { error: 'root not in graph allowlist' }; 500 { error: <message> }.
test('rebuildGraph throws on a non-2xx response, with the server\'s own error text', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'root not in graph allowlist' }) });
  try {
    await assert.rejects(() => rebuildGraph('D:/not-allowed'), /root not in graph allowlist/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('rebuildGraph resolves with the real { graphs, skipped } shape, skipped included on success', async () => {
  const orig = globalThis.fetch;
  const shape = { graphs: [{ root: 'D:/proj', nodes: 5 }], skipped: [{ root: 'D:/proj', reason: 'graphify-busy' }] };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => shape });
  try {
    assert.deepEqual(await rebuildGraph('D:/proj'), { ...shape, pending: false });
  } finally {
    globalThis.fetch = orig;
  }
});

test('rebuildGraph marks a 202 reply pending: the rebuild continues in the background', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 202, json: async () => ({ graphs: [], skipped: [], running: ['D:/proj'] }) });
  try {
    assert.equal((await rebuildGraph('D:/proj')).pending, true);
  } finally {
    globalThis.fetch = orig;
  }
});

test('baselineReportUrl toggles the download query', () => {
  assert.equal(baselineReportUrl(), '/api/report/baseline');
  assert.equal(baselineReportUrl(true), '/api/report/baseline?download=1');
});

// resume() used to resolve on every response (never
// checked r.ok), so its callers' success toast fired even on a 400/500 -
// mirrors learningAction's own non-2xx-throws contract above.
test('resume resolves with the body on a 2xx response', async () => {
  const calls = await captureFetch(() => resume('s-1', '/repo', 'terminal'));
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { sessionId: 's-1', cwd: '/repo', location: 'terminal' });
});

test('resume throws on a non-2xx response, with the server\'s own error text', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'sessionId must be a session UUID' }) });
  try {
    await assert.rejects(() => resume('bad-id', '/repo', 'terminal'), /sessionId must be a session UUID/);
  } finally {
    globalThis.fetch = orig;
  }
});
