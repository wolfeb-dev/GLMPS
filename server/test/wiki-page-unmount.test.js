// server/test/wiki-page-unmount.test.js
// D-W integration note: renderWiki() (web/observability/wiki.js) returns a
// cleanup() that bumps its load token and drops its message listener, which
// is the ONLY thing that stops an in-flight rebuild() poll once the wiki
// page is left - wiki.js's own interim guard (viewIsHidden) checks a 1.x
// view's `.hidden` class, and this four-lens router never sets one on
// #lens-root, so that guard never fires here. Before this fix, app.js's
// wiki branch in doEnter() discarded renderWiki's return value
// (`current = { lens: 'wiki', handle: null, route }`), so navigating away
// from /wiki/ never called cleanup() and a poll kept running and re-fetching
// in the background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Task 16 moved doEnter into web/shared/lens-router.js; card glmps-2-0-137
// moved the wiki into the Knowledge lens's Wiki tab. The contract is the
// same: renderWiki's cleanup() is captured and run by the lens's unmount, and
// a cleanup that lands after the lens was left runs at once.
test("the Knowledge lens captures renderWiki's cleanup() and runs it on unmount", () => {
  const js = read('web/knowledge/lens.js');
  assert.match(js, /const cleanup = await mod\.renderWiki\(/, "renderWiki's return value must be captured, not discarded");
  assert.match(js, /if \(left\) cleanup\(\); else cleanups\.push\(cleanup\)/, 'a cleanup that lands after leaving runs at once');
  assert.match(js, /unmount\(\) \{[\s\S]*?for \(const c of cleanups\)/, 'unmount runs every captured cleanup');
  assert.match(js, /onState\(s\) \{ if \(mapMod && owns\(\)\)/, 'onState only reaches the code map, and only while this mount owns the root');
  assert.match(js, /onEvent\(\) \{\}/, 'onEvent is a safe no-op');
});

function wikiData() {
  return {
    project: 'glmps', root: '/repo', base: '/wiki-src',
    manifest: { tierLlm: true, generatedAt: 't1' },
    sections: [{ slug: 'a', title: 'A', fileCount: 1 }],
  };
}

// Fix round 1, I1 (reviewer): rebuild() awaits fetch('/api/wiki/rebuild')
// THEN res.json() on a real Response (its body stream read is not a plain
// microtask) before it ever reaches the poll loop's
// `await new Promise(r => setTimeout(r, 10000))` - three bare
// `await Promise.resolve()` flushes land before that setTimeout is even
// registered, so the original version of this test passed whether or not
// cleanup() was called (tick(10000) fired no pending timer either way).
// setImmediate is a real macrotask, not mocked by t.mock.timers, so five
// round trips through it reliably drain every pending microtask (fetch's
// resolution, res.json()'s stream read, the loop's first stale() check)
// before the setTimeout call happens.
// Security hardening C1: the lens also GETs /api/wiki/ticket for its iframe;
// only the wiki STATE read (GET /api/wiki[?...]) is what these counts mean.
const isWikiStateGet = (c) => c === 'GET /api/wiki' || c.startsWith('GET /api/wiki?');

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test('cleanup() aborts an in-flight rebuild poll before it re-fetches', async (t) => {
  const dom = installMiniDom({ pathname: '/wiki/' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Count scheduling calls through the mock itself (not a replacement of
  // it), so t.mock.timers.tick() still drives the real registered timer -
  // this is how the test proves rebuild() actually reached its 10s wait
  // instead of assuming three microtask flushes were enough.
  const mockSetTimeout = globalThis.setTimeout;
  let timersScheduled = 0;
  globalThis.setTimeout = (fn, ms, ...args) => { timersScheduled++; return mockSetTimeout(fn, ms, ...args); };
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method ?? 'GET'} ${u}`);
    if (u.startsWith('/api/wiki/rebuild')) return new Response('{}', { status: 202 });
    if (u.startsWith('/api/wiki')) return Response.json(wikiData());
    if (u.startsWith('/api/projects')) return Response.json({ projects: [] });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const { renderWiki } = await import('../../web/observability/wiki.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const cleanup = await renderWiki(container, { project: null });
    assert.equal(typeof cleanup, 'function', 'renderWiki must return a cleanup function');

    const before = calls.filter(isWikiStateGet).length;
    assert.equal(before, 1, 'the initial load fetched the wiki once');

    const refreshBtn = container.querySelector('.wiki-rebuild');
    assert.ok(refreshBtn, 'the Refresh button rendered');
    refreshBtn.click(); // starts rebuild(): POST rebuild -> 202 -> enters the poll loop
    await flushMicrotasks();
    assert.ok(calls.some((c) => c === 'POST /api/wiki/rebuild'), 'rebuild was requested');
    // This is the assertion that keeps the test from passing vacuously: if
    // the poll never actually registered its 10s wait, tick(10000) below
    // fires nothing and the test would pass whether or not cleanup() works.
    assert.equal(timersScheduled, 1, "the poll's 10s setTimeout must be registered before cleanup() runs");

    // Simulate app.js's unmount path: the operator navigates away from /wiki/
    // while the poll is mid-wait, before its 10s tick fires.
    cleanup();

    t.mock.timers.tick(10000);
    await flushMicrotasks();

    const after = calls.filter(isWikiStateGet).length;
    assert.equal(after, before, 'cleanup() must stop the poll: no further /api/wiki fetch after unmount');
  } finally {
    globalThis.setTimeout = mockSetTimeout;
    delete globalThis.fetch;
    dom.restore();
  }
});
