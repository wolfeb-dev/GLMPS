// Routes under test: server/lib/routes/workspace-routes.js
// server/test/roster-failure-toasts.test.js
// Fix round 1, M8 / round 2, R2-1: web/shared/roster.js's fillProjectNav used
// to toast a success message (or silently clear the quick-add input) before
// its POST had even resolved, so a failed addBacklogItem/postTerminal/
// rebuildGraph call reported success anyway. Round 1's fix checked a
// result?.error field that the real POST /api/graph/rebuild route never
// sends on success (it answers 200 { graphs, skipped }, skipped carrying no
// error field at all for a busy-but-not-failed root) - these tests now use
// the real route's response shapes (server/server.js), copied verbatim, for
// both the genuine-failure and the busy-skipped cases.
//
// Each test imports roster.js with a unique cache-busting query string (the
// house pattern - see detail.js/registry.js tests): fillProjectNav's
// _navCache/_navCollapsed are module-level state with a 15s TTL, and several
// tests in one process sharing one module instance would silently reuse an
// earlier test's cached projects/terminals instead of this test's own mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

function project(overrides = {}) {
  return {
    key: 'proj1', name: 'proj1', path: 'D:/proj1',
    sessionCount: 1, liveCount: 0, lastTs: Date.now(), branch: 'main',
    backlogOpen: 0, graph: { needsUpdate: true, nodes: 5 },
    ...overrides,
  };
}

function captureToasts() {
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  return { toasts, stop: () => window.removeEventListener('mc-toast', onToast) };
}

test('a failed graph rebuild toasts the real reason and re-enables the button', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [project()] });
    if (u.startsWith('/api/config')) return Response.json({ terminals: [] });
    // Real shape (server/server.js POST /api/graph/rebuild, the body.root
    // not-allowlisted branch): 400 { error: '...' }.
    if (u.startsWith('/api/graph/rebuild')) return new Response(JSON.stringify({ error: 'root not in graph allowlist' }), { status: 400, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch ${u}`);
  };
  const cap = captureToasts();
  try {
    const { fillProjectNav } = await import(`../../web/shared/roster.js?t=${Date.now()}-1`);
    const rail = document.createElement('div');
    document.body.appendChild(rail);
    await fillProjectNav(rail, {});

    const staleBtn = rail.querySelector('.dash-nav-pill-stale');
    assert.ok(staleBtn, 'the graph-stale rebuild button rendered');
    staleBtn.click();
    await flush();

    assert.ok(
      cap.toasts.some((t) => t.includes('Could not rebuild the graph for proj1') && t.includes('root not in graph allowlist')),
      `expected a failure toast naming the reason, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.some((t) => t.startsWith('Rebuilding graph')), false, 'must not also claim success');
    assert.equal(staleBtn.disabled, false, 'the button re-enables after a failure so the operator can retry');
    assert.equal(staleBtn.textContent, 'graph stale \u27F3', 'the button label reverts, not stuck on "rebuilding\u2026"');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

// a busy root is NOT an error (res.ok stays true, no error field) -
// the real route answers 200 { graphs, skipped: [{ root, reason:
// 'graphify-busy' }] }. Round 1's fix only checked result?.error, so this
// case still toasted "Rebuilding..." and left the button stuck, exactly the
// shape the original bug had just for a different trigger.
test('a busy (skipped) graph rebuild toasts a named status, not success, and re-enables the button', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [project()] });
    if (u.startsWith('/api/config')) return Response.json({ terminals: [] });
    if (u.startsWith('/api/graph/rebuild')) return Response.json({ graphs: [], skipped: [{ root: 'D:/proj1', reason: 'graphify-busy' }] });
    throw new Error(`unexpected fetch ${u}`);
  };
  const cap = captureToasts();
  try {
    const { fillProjectNav } = await import(`../../web/shared/roster.js?t=${Date.now()}-1b`);
    const rail = document.createElement('div');
    document.body.appendChild(rail);
    await fillProjectNav(rail, {});

    const staleBtn = rail.querySelector('.dash-nav-pill-stale');
    assert.ok(staleBtn, 'the graph-stale rebuild button rendered');
    staleBtn.click();
    await flush();

    assert.ok(
      cap.toasts.some((t) => t === 'The graph for proj1 is already rebuilding.'),
      `expected a busy-skip toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.some((t) => t.startsWith('Rebuilding graph')), false, 'a skipped root must not be reported as newly rebuilding');
    assert.equal(cap.toasts.some((t) => t.startsWith('Could not rebuild')), false, 'a skip is not a failure either');
    assert.equal(staleBtn.disabled, false, 'the button re-enables so the operator can retry later');
    assert.equal(staleBtn.textContent, 'graph stale \u27F3', 'the button label reverts, not stuck on "rebuilding\u2026"');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a failed terminal launch toasts the real reason, not "queued"', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [project({ graph: { needsUpdate: false, nodes: 5 } })] });
    if (u.startsWith('/api/config')) return Response.json({ terminals: [{ label: 'Terminal', command: 'bash' }] });
    if (u.startsWith('/api/terminal')) return new Response('{}', { status: 500 });
    throw new Error(`unexpected fetch ${u}`);
  };
  const cap = captureToasts();
  try {
    const { fillProjectNav } = await import(`../../web/shared/roster.js?t=${Date.now()}-2`);
    const rail = document.createElement('div');
    document.body.appendChild(rail);
    await fillProjectNav(rail, {});

    const termBtn = rail.querySelector('.dash-nav-term-btn');
    assert.ok(termBtn, 'the terminal flyout button rendered');
    termBtn.click();
    const item = rail.querySelector('.dash-nav-term-item');
    assert.ok(item, 'the terminal menu item rendered');
    item.click();
    await flush();

    assert.ok(
      cap.toasts.some((t) => t.startsWith('Terminal request failed') && t.includes('terminal failed')),
      `expected a failure toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.includes('Terminal request queued'), false, 'must not also claim success');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a failed ticket file toasts the real reason and keeps the typed text', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [project({ graph: { needsUpdate: false, nodes: 5 } })] });
    if (u.startsWith('/api/config')) return Response.json({ terminals: [] });
    // Real shape (server/server.js POST /api/backlog, empty-title branch):
    // 400 { error: 'empty title' }.
    if (u.startsWith('/api/backlog')) return new Response(JSON.stringify({ error: 'empty title' }), { status: 400, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch ${u}`);
  };
  const cap = captureToasts();
  try {
    const { fillProjectNav } = await import(`../../web/shared/roster.js?t=${Date.now()}-3`);
    const rail = document.createElement('div');
    document.body.appendChild(rail);
    await fillProjectNav(rail, {});

    const qaInput = rail.querySelector('.dash-nav-qa-input');
    assert.ok(qaInput, 'the quick-add input rendered');
    qaInput.value = 'file this ticket';
    qaInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();

    assert.ok(
      cap.toasts.some((t) => t.startsWith('Could not file the ticket') && t.includes('empty title')),
      `expected a failure toast, got: ${JSON.stringify(cap.toasts)}`,
    );
    assert.equal(cap.toasts.includes('Ticket filed'), false, 'must not also claim success');
    assert.equal(qaInput.value, 'file this ticket', 'the typed text must survive a failed POST, not be cleared');
    assert.equal(qaInput.disabled, false, 'the input re-enables after the request settles');
  } finally {
    cap.stop();
    delete globalThis.fetch;
    dom.restore();
  }
});

function captureErrors() {
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  return { seen, restore: () => { console.error = orig; } };
}

// the project and config fetches swallowed their errors;
// a failed /api/config had no ok check, no log and no visible state (the
// terminal buttons just never appeared).
test('SF-I2: a failed /api/projects or /api/config is logged, and a config failure is visible', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const errs = captureErrors();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [project()] });
    if (u.startsWith('/api/config')) return new Response('{"error":"config unreadable"}', { status: 500, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const { fillProjectNav } = await import(`../../web/shared/roster.js?t=${Date.now()}-sfi2a`);
    const rail = document.createElement('div'); document.body.appendChild(rail);
    await fillProjectNav(rail, {});
    assert.ok(errs.seen.some((m) => /\/api\/config/.test(m) && /500/.test(m)), `logged: ${JSON.stringify(errs.seen)}`);
    const note = rail.querySelectorAll('div').find((d) => /Terminal buttons unavailable/.test(d.textContent) && d.children.length === 0);
    assert.ok(note, 'the operator sees why there are no terminal buttons');
    assert.match(note.textContent, /GET \/api\/config returned 500/);
  } finally { errs.restore(); delete globalThis.fetch; dom.restore(); }

  const dom2 = installMiniDom({ pathname: '/work' });
  const errs2 = captureErrors();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return new Response('{}', { status: 503 });
    if (u.startsWith('/api/config')) return Response.json({ terminals: [] });
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const { fillProjectNav } = await import(`../../web/shared/roster.js?t=${Date.now()}-sfi2b`);
    const rail = document.createElement('div'); document.body.appendChild(rail);
    await fillProjectNav(rail, {});
    assert.ok(errs2.seen.some((m) => /projects/.test(m)), `logged: ${JSON.stringify(errs2.seen)}`);
  } finally { errs2.restore(); delete globalThis.fetch; dom2.restore(); }
});

// the drift poll had no ok check, so an error body read as
// "0 drifting" (a healthy-looking zero) and its catch never fired.
test('SF-I3: a failed /api/workspace poll shows drift as unknown and logs, never "0 drifting"', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const errs = captureErrors();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/workspace')) return new Response('{"error":"store down"}', { status: 500, headers: { 'content-type': 'application/json' } });
    return Response.json({});
  };
  try {
    const { fillRoster } = await import(`../../web/shared/roster.js?t=${Date.now()}-sfi3`);
    const rail = document.createElement('div'); document.body.appendChild(rail);
    fillRoster(rail, { sessions: [] }, {}, {});
    await flush();
    const badge = rail.querySelector('.dash-roster-drift');
    assert.equal(badge.textContent, 'drift unknown');
    assert.match(badge.title, /GET \/api\/workspace returned 500/);
    assert.equal(badge.classList.contains('has-drift'), false);
    assert.ok(errs.seen.some((m) => /drift count/.test(m) && /500/.test(m)), `logged: ${JSON.stringify(errs.seen)}`);
    // The next rebuild (every SSE tick) keeps saying unknown, not a stale zero.
    fillRoster(rail, { sessions: [] }, {}, {});
    assert.equal(rail.querySelector('.dash-roster-drift').textContent, 'drift unknown');
  } finally { errs.restore(); delete globalThis.fetch; dom.restore(); }
});
