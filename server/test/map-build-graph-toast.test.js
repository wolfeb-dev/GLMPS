// Routes under test: server/lib/routes/workspace-routes.js
// server/test/map-build-graph-toast.test.js
// the Surface map's empty-state "build graph" button
// fired rebuildGraph and forgot it (.catch(() => {})), then toasted
// "Building..." unconditionally and left the button stuck disabled forever
// on any outcome other than a clean rebuild. Drives the button through a
// busy-skip and a real failure, using the real POST /api/graph/rebuild
// response shapes (server/server.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

function routes(overrides = {}) {
  return {
    '/api/state': { sessions: [] },
    '/api/workspace': { sessions: [] },
    '/api/projects': { projects: [] },
    '/api/config': { terminals: [] },
    '/api/graph': { project: 'D:/proj1', graph: null, graphRoot: 'D:/proj1' },
    ...overrides,
  };
}

function mockFetch(byPath, { onRebuild } = {}) {
  return async (url, opts = {}) => {
    const u = String(url).split('?')[0];
    if (u === '/api/graph/rebuild' && (opts.method ?? 'GET') === 'POST') return onRebuild();
    return byPath[u] ? Response.json(byPath[u]) : Response.json({});
  };
}

function captureToasts() {
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  return { toasts, stop: () => window.removeEventListener('mc-toast', onToast) };
}

test('a busy (skipped) build-graph click toasts a named status and re-enables the button', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  globalThis.fetch = mockFetch(routes(), {
    onRebuild: () => Response.json({ graphs: [], skipped: [{ root: 'D:/proj1', reason: 'graphify-busy' }] }),
  });
  const cap = captureToasts();
  try {
    const { renderMap } = await import(`../../web/observability/map.js?t=${Date.now()}-1`);
    const root = document.createElement('div');
    document.body.appendChild(root);
    await renderMap(root, {}, undefined, 'D:/proj1');

    const btn = root.querySelector('.map-empty-build-btn');
    assert.ok(btn, 'the empty-state build-graph button rendered');
    const idleLabel = btn.textContent;
    btn.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(
      cap.toasts.some((t) => t === 'The graph for proj1 is already rebuilding.'),
      `expected a busy-skip toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.some((t) => t.startsWith('Building graph')), false, 'a skipped root must not be reported as newly building');
    assert.equal(btn.disabled, false, 'the button re-enables so the operator can retry');
    assert.equal(btn.textContent, idleLabel, 'the label reverts, not stuck on "Building\u2026"');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a failed build-graph click toasts the real reason and re-enables the button', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  globalThis.fetch = mockFetch(routes(), {
    onRebuild: () => new Response(JSON.stringify({ error: 'root not in graph allowlist' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  const cap = captureToasts();
  try {
    const { renderMap } = await import(`../../web/observability/map.js?t=${Date.now()}-2`);
    const root = document.createElement('div');
    document.body.appendChild(root);
    await renderMap(root, {}, undefined, 'D:/proj1');

    const btn = root.querySelector('.map-empty-build-btn');
    assert.ok(btn, 'the empty-state build-graph button rendered');
    const idleLabel = btn.textContent;
    btn.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(
      cap.toasts.some((t) => t.includes('Could not build the graph for proj1') && t.includes('root not in graph allowlist')),
      `expected a failure toast naming the reason, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.some((t) => t.startsWith('Building graph')), false, 'must not also claim success');
    assert.equal(btn.disabled, false, 'the button re-enables after a failure so the operator can retry');
    assert.equal(btn.textContent, idleLabel, 'the label reverts, not stuck on "Building\u2026"');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});
