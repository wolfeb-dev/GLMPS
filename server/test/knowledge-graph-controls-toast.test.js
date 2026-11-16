// server/test/knowledge-graph-controls-toast.test.js
// The knowledge-graph controls (Settings until card glmps-2-0-140, now
// Knowledge > Architecture graph) toasted
// "Graphs rebuilt" / "<proj>: rebuilt" unconditionally, even when the real
// POST /api/graph/rebuild response (server/server.js) carried a non-empty
// skipped[] for a root that was already rebuilding elsewhere - that root was
// never actually rebuilt by the click that claimed it was. Drives both the
// "Rebuild all stale" button and a per-row rebuild through the real busy-skip
// and failure response shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { waitFor } from './helpers/wait-for.js';

const GRAPH_STATUS = { graphs: [{ project: 'proj1', root: 'D:/proj1', needsUpdate: true, nodes: 5, rebuiltMs: Date.now() }] };

function mockFetch({ onRebuild }) {
  return async (url, opts = {}) => {
    const u = String(url).split('?')[0];
    if (u === '/api/graph/rebuild' && (opts.method ?? 'GET') === 'POST') return onRebuild();
    if (u === '/api/graph/status') return Response.json(GRAPH_STATUS);
    return Response.json({});
  };
}

function captureToasts() {
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  return { toasts, stop: () => window.removeEventListener('mc-toast', onToast) };
}

// Mounts the controls the way the Knowledge lens does and waits for the list.
async function mountControls(host) {
  const { mountGraphControls } = await import(`../../web/knowledge/graph-controls.js?t=${Date.now()}-${Math.random()}`);
  const { ready } = mountGraphControls(host);
  await ready;
  return document.body;
}

test('"Rebuild all stale" names a skipped count instead of claiming full success', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => Response.json({ graphs: GRAPH_STATUS.graphs, skipped: [{ root: 'D:/proj1', reason: 'graphify-busy' }] }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);

    const rebuildAllBtn = document.querySelector('.set-graph-footer').querySelector('button');
    assert.ok(rebuildAllBtn, 'the Rebuild all stale button rendered');
    rebuildAllBtn.click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });

    assert.ok(
      cap.toasts.some((t) => t === 'Graphs rebuilt (1 already rebuilding, skipped)'),
      `expected a skipped-count toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.includes('Graphs rebuilt'), false, 'must not also claim unqualified success');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

// Card glmps-2-0-runtime-148: past the reply budget the server answers 202 with
// the roots still running, which is not "rebuilt".
test('"Rebuild all stale" says the rebuild continues when the server answers 202 with running roots', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => Response.json({ graphs: GRAPH_STATUS.graphs, skipped: [], running: ['D:/proj1'] }, { status: 202 }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);
    document.querySelector('.set-graph-footer').querySelector('button').click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });
    assert.ok(cap.toasts.includes('Rebuild continues in the background (1 running)'), JSON.stringify(cap.toasts));
    assert.equal(cap.toasts.includes('Graphs rebuilt'), false, 'must not claim it finished');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

// Card glmps-2-0-161 F4: running lists every root in flight server-wide, so a
// 200 reply with another root still running means this request finished.
test('"Rebuild all stale" says rebuilt on a 200 even when another root is still running', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => Response.json({ graphs: GRAPH_STATUS.graphs, skipped: [], running: ['D:/other'] }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);
    document.querySelector('.set-graph-footer').querySelector('button').click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });
    assert.ok(cap.toasts.includes('Graphs rebuilt'), JSON.stringify(cap.toasts));
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a per-row rebuild says rebuilt on a 200 even when another root is still running', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => Response.json({ graphs: GRAPH_STATUS.graphs, skipped: [], running: ['D:/other'] }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);
    document.querySelector('.set-graph-row').click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });
    assert.ok(cap.toasts.includes('proj1: rebuilt'), JSON.stringify(cap.toasts));
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a per-row rebuild says it continues when the server answers 202', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => Response.json({ graphs: GRAPH_STATUS.graphs, skipped: [], running: ['D:/proj1'] }, { status: 202 }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);
    document.querySelector('.set-graph-row').click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });
    assert.ok(cap.toasts.includes('proj1: rebuild continues in the background'), JSON.stringify(cap.toasts));
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('"Rebuild all stale" toasts the real failure reason and re-enables the button', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => new Response(JSON.stringify({ error: 'something broke' }), { status: 500, headers: { 'content-type': 'application/json' } }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);

    const rebuildAllBtn = document.querySelector('.set-graph-footer').querySelector('button');
    rebuildAllBtn.click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });

    assert.ok(
      cap.toasts.some((t) => t === 'Rebuild failed: something broke'),
      `expected a named failure toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(rebuildAllBtn.disabled, false, 'the button re-enables after a failure');
    assert.equal(rebuildAllBtn.textContent, 'Rebuild all stale', 'the label reverts, not stuck on "Rebuilding\u2026"');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a per-row rebuild on a busy root toasts a named status and clears the busy state', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => Response.json({ graphs: GRAPH_STATUS.graphs, skipped: [{ root: 'D:/proj1', reason: 'graphify-busy' }] }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);

    const row = document.querySelector('.set-graph-row');
    assert.ok(row, 'the graph row rendered');
    row.click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });

    assert.ok(
      cap.toasts.some((t) => t === 'proj1 is already rebuilding'),
      `expected a busy-skip toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.includes('proj1: rebuilt'), false, 'must not also claim success');
    assert.equal(row.classList.contains('busy'), false, 'the row clears its busy state so it can be retried');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a per-row rebuild failure toasts the real reason and clears the busy state', async () => {
  const dom = installMiniDom({ pathname: '/now' });
  globalThis.fetch = mockFetch({
    onRebuild: () => new Response(JSON.stringify({ error: 'root not in graph allowlist' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  const cap = captureToasts();
  try {
    const topbar = document.createElement('div');
    document.body.appendChild(topbar);
    await mountControls(topbar);

    const row = document.querySelector('.set-graph-row');
    row.click();
    await waitFor(() => cap.toasts.length >= 2, { message: 'the rebuild outcome toast' });

    assert.ok(
      cap.toasts.some((t) => t === 'proj1: rebuild failed: root not in graph allowlist'),
      `expected a named failure toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(row.classList.contains('busy'), false, 'the row clears its busy state after a failure too');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});
