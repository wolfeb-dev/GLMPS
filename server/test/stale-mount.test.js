// server/test/stale-mount.test.js
// a mount overtaken by a newer navigation keeps
// running to completion. Before this fix its late writes landed in shared
// state: the session page appended after its await;
// a stale apply() cleared the new lens's selection mark document-wide; a
// stale unmount removed surface-root from a newer Surface and closed the
// card drawer / diff popup a newer mount owned, or tore down a module-level
// singleton (the board, the registry, the wiki's load token and message
// listener) a newer mount of the same lens had taken over.
//
// The design (web/shared/lens-router.js): every mount gets ctx.isCurrent();
// stale mounts skip root and document-wide writes, and each lens's module
// singletons are released only by the mount that last started them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, loadVendorD3 } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { waitFor } from './helpers/wait-for.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// A ctx whose ownership the test controls: isCurrent() reads the flag.
function ctxWith(flag) {
  return { getState: () => null, toast() {}, go() {}, handlers: {}, isCurrent: () => flag.current };
}

// A bound item outside the lens, marked as the selection: a stale mount
// must not clear it.
async function externalMark() {
  const { bindItem, markSelected } = await import('../../web/shared/interactive-item.js');
  const other = document.createElement('button'); document.body.appendChild(other);
  bindItem(other, { type: 'card', id: 'newer-lens-item', link: '/work?sel=card%3Anewer-lens-item', open() {} });
  markSelected(other);
  return other;
}

function silenceErrors() { const o = console.error; console.error = () => {}; return () => { console.error = o; }; }

test('R3 session page: a stale mount writes nothing into the root', async () => {
  const dom = installMiniDom({ pathname: '/session/A' });
  globalThis.fetch = async () => Response.json({ events: [], contextNow: [] });
  let handle;
  try {
    const page = await import('../../web/shared/session-page.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const flag = { current: true };
    const mounting = page.mount(root, { lens: 'session', sessionId: 'A' }, { ...ctxWith(flag), handlers: { onOpenFile() {}, onCopy() {}, onOpenMap() {} } });
    flag.current = false;
    handle = await mounting;
    assert.equal(root.childNodes.length, 0, 'nothing appended after the await');
    assert.equal(typeof handle.unmount, 'function', 'still a full handle the router can unmount');
    handle.onEvent({ type: 'events', sessionId: 'A' });
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

const now = Date.now();
const CARD = (id, title) => ({ id, project: 'glmps', title, state: 'queued', source: 'manual', order: 1, devLog: [], activity: [], gate: null, createdAt: now, updatedAt: now });

function workFetch(items) {
  return async (url) => {
    const u = String(url).split('?')[0];
    if (u === '/api/backlog') return Response.json({ items: items.list, gatelessDone: [] });
    if (u === '/api/qa-trends') return Response.json({ points: [] });
    return Response.json({});
  };
}

test('R3 Work: a stale apply leaves the selection mark and opens no drawer; a stale unmount closes no drawer it does not own', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const items = { list: [CARD('mc-7', 'Wire the globe')] };
  globalThis.fetch = workFetch(items);
  window.vegaEmbed = async () => {};
  let handle;
  try {
    const other = await externalMark();
    const lens = await import('../../web/work/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const flag = { current: true };
    const mounting = lens.mount(root, parseLink('/work', '?sel=card%3Amc-7'), ctxWith(flag));
    flag.current = false;
    handle = await mounting;
    await tick();
    assert.equal(other.getAttribute('aria-current'), 'true');
    assert.equal(document.querySelectorAll('.backlog-drawer-scrim').length, 0, 'the stale deep link opened no drawer');
    const { openCardDrawer } = await import('../../web/orchestration/board-drawer.js');
    openCardDrawer(CARD('mc-9', 'owned by the newer lens'));
    handle.unmount(); handle = null;
    assert.equal(document.querySelectorAll('.backlog-drawer-scrim').length, 1, 'the newer mount\'s drawer is still open');
  } finally { handle?.unmount(); const { closeCardDrawer } = await import('../../web/orchestration/board-drawer.js'); closeCardDrawer(); delete globalThis.fetch; dom.restore(); }
});

test('R3 Work: a stale unmount does not tear down the board a newer Work mount took over', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const items = { list: [CARD('mc-7', 'Wire the globe')] };
  globalThis.fetch = workFetch(items);
  window.vegaEmbed = async () => {};
  let a; let b;
  try {
    const lens = await import('../../web/work/lens.js');
    const rootA = document.createElement('div'); document.body.appendChild(rootA);
    const flagA = { current: true };
    a = await lens.mount(rootA, parseLink('/work', ''), ctxWith(flagA));
    flagA.current = false;
    rootA.remove();
    const rootB = document.createElement('div'); document.body.appendChild(rootB);
    b = await lens.mount(rootB, parseLink('/work', ''), ctxWith({ current: true }));
    a.unmount(); a = null; // the overtaken mount lands late
    items.list = [CARD('mc-7', 'Wire the globe'), CARD('mc-8', 'A card that arrived later')];
    b.onEvent({ type: 'backlog' });
    await tick(60);
    assert.ok(rootB.querySelector('[data-item-id="mc-8"]'), 'the newer board still refreshes');
  } finally { a?.unmount(); b?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('R3 Learning: a stale apply leaves the selection mark alone', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const restore = silenceErrors();
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  let handle;
  try {
    const other = await externalMark();
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const flag = { current: true };
    const mounting = lens.mount(root, parseLink('/learning', ''), ctxWith(flag));
    flag.current = false;
    handle = await mounting;
    assert.equal(other.getAttribute('aria-current'), 'true');
  } finally { handle?.unmount(); restore(); delete globalThis.fetch; dom.restore(); }
});

test('R3 Learning: a stale unmount does not drop the registry a newer Learning mount took over', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const restore = silenceErrors();
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  let a; let b;
  try {
    const lens = await import('../../web/learning/lens.js');
    const reg = await import('../../web/evaluation/registry.js');
    const flagA = { current: true };
    const rootA = document.createElement('div'); document.body.appendChild(rootA);
    a = await lens.mount(rootA, parseLink('/learning', ''), ctxWith(flagA));
    // The registry loads with its tab (phase 2, Q3), so each mount opens it.
    rootA.querySelector('#lt-tab-capabilities').click();
    await waitFor(() => reg._registryContainerForTest() === rootA.querySelector('#view-registry'), { message: 'mount A to hold the registry' });
    flagA.current = false;
    const rootB = document.createElement('div'); document.body.appendChild(rootB);
    b = await lens.mount(rootB, parseLink('/learning', ''), ctxWith({ current: true }));
    rootB.querySelector('#lt-tab-capabilities').click();
    await waitFor(() => reg._registryContainerForTest() === rootB.querySelector('#view-registry'), { message: 'mount B to take the registry' });
    const held = reg._registryContainerForTest();
    assert.ok(held, 'the newer mount holds the registry container');
    a.unmount(); a = null;
    assert.ok(reg._registryContainerForTest() === held, 'the stale unmount left it alone');
  } finally { a?.unmount(); b?.unmount(); restore(); delete globalThis.fetch; dom.restore(); }
});

test('R3 Surface: a stale unmount keeps a newer Surface\'s surface-root and leaves the diff popup open', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const { surfaceFetch } = await import('./fixtures/surface-fixtures.js');
  globalThis.fetch = surfaceFetch();
  window.d3 = loadVendorD3();
  let a; let b;
  try {
    const lens = await import('../../web/surface/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const flagA = { current: true };
    a = await lens.mount(root, parseLink('/surface', ''), ctxWith(flagA));
    flagA.current = false;
    root.replaceChildren(); root.className = ''; // the router's swap
    b = await lens.mount(root, parseLink('/surface', ''), ctxWith({ current: true }));
    const { getDiffPopup } = await import('../../web/shared/diff-popup.js');
    const popup = getDiffPopup();
    a.unmount(); a = null;
    assert.ok(root.classList.contains('surface-root'), 'the newer Surface keeps its layout class');
    assert.ok(popup.parentNode, 'the diff popup the newer mount owns is still open');
  } finally { a?.unmount(); b?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('R3 Surface: a stale mount does not mark its deep-linked selection', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const { surfaceFetch } = await import('./fixtures/surface-fixtures.js');
  globalThis.fetch = surfaceFetch();
  window.d3 = loadVendorD3();
  let handle;
  try {
    const other = await externalMark();
    const lens = await import('../../web/surface/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const flag = { current: true };
    const mounting = lens.mount(root, parseLink('/surface', '?sel=repo%3Aglmps'), ctxWith(flag));
    flag.current = false;
    handle = await mounting;
    assert.equal(other.getAttribute('aria-current'), 'true');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

function wikiFetch() {
  return async (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [] });
    if (u.startsWith('/api/wiki')) return Response.json({ project: 'glmps', root: '/repo', base: '/wiki-src', manifest: { tierLlm: true, generatedAt: 't1' }, sections: [{ slug: 'a', title: 'A', fileCount: 1 }] });
    throw new Error(`unexpected fetch ${u}`);
  };
}

test('R3 wiki: a stale wiki page\'s cleanup does not cancel a newer wiki page or drop its message listener', async () => {
  const dom = installMiniDom({ pathname: '/wiki/' });
  globalThis.fetch = wikiFetch();
  let cleanA; let cleanB;
  try {
    const { renderWiki } = await import('../../web/observability/wiki.js');
    const flagA = { current: true };
    const a = document.createElement('div'); document.body.appendChild(a);
    cleanA = await renderWiki(a, { project: null, isCurrent: () => flagA.current });
    flagA.current = false;
    const b = document.createElement('div'); document.body.appendChild(b);
    cleanB = await renderWiki(b, { project: null, isCurrent: () => true });
    const listeners = window.listenerCount('message');
    assert.ok(listeners >= 1, 'the newer page listens for article navigation');
    cleanA(); cleanA = null;
    assert.equal(window.listenerCount('message'), listeners, 'the stale cleanup left the newer listener');
  } finally { cleanA?.(); cleanB?.(); delete globalThis.fetch; dom.restore(); }
});

test('R3 wiki: a stale wiki page never paints or takes the message listener', async () => {
  const dom = installMiniDom({ pathname: '/wiki/' });
  globalThis.fetch = wikiFetch();
  let clean;
  try {
    const { renderWiki } = await import('../../web/observability/wiki.js');
    const flag = { current: true };
    const box = document.createElement('div'); document.body.appendChild(box);
    const before = window.listenerCount('message');
    const p = renderWiki(box, { project: null, isCurrent: () => flag.current });
    flag.current = false;
    clean = await p;
    assert.equal(window.listenerCount('message'), before, 'no listener registered by a stale page');
    assert.ok(!box.querySelector('.wiki-rebuild'), 'no article painted');
  } finally { clean?.(); delete globalThis.fetch; dom.restore(); }
});


// Session page: overtaken during renderDetail's fetch, the page's late
// unmount ran detail.js's cleanup, whose hideDiffPopup()/closeExportMenu()
// closed the newer mount's shared diff popup (reviewer probe e).
test('R3 round 3 session page: overtaken mid-render, its unmount leaves the newer mount\'s diff popup open and drops its own listeners', async () => {
  const dom = installMiniDom({ pathname: '/session/A' });
  const restore = silenceErrors();
  let release; const gate = new Promise((r) => { release = r; }); let gated = false;
  globalThis.fetch = async () => { gated = true; await gate; return Response.json({ events: [], contextNow: [] }); };
  let handle;
  try {
    const page = await import('../../web/shared/session-page.js');
    const { getDiffPopup } = await import('../../web/shared/diff-popup.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const flag = { current: true };
    const baseDoc = document.listenerCount(); const baseWin = window.listenerCount();
    const mounting = page.mount(root, { lens: 'session', sessionId: 'A' }, { ...ctxWith(flag), handlers: { onOpenFile() {}, onCopy() {}, onOpenMap() {} } });
    for (let i = 0; i < 200 && !gated; i++) await tick(5);
    assert.ok(gated, 'renderDetail is waiting on its fetch');
    flag.current = false;
    const popup = getDiffPopup(); popup.textContent = 'the newer page\'s popup';
    release();
    handle = await mounting;
    handle.unmount(); handle = null;
    assert.ok(popup.parentNode, 'the newer popup is still open');
    assert.equal(document.listenerCount(), baseDoc, 'no document listener left behind');
    assert.equal(window.listenerCount(), baseWin, 'no window listener left behind');
  } finally { handle?.unmount(); const { closeDiffPopup } = await import('../../web/shared/diff-popup.js'); closeDiffPopup(); restore(); delete globalThis.fetch; dom.restore(); }
});

// Session page update(): a renderDetail still pending when the page is left
// landed after unmount and set a cleanup nobody called, leaking detail.js's
// document click/keydown and window mc-events listeners.
test('R3 round 3 session page: a render that lands after unmount releases itself at once', async () => {
  const dom = installMiniDom({ pathname: '/session/A' });
  const restore = silenceErrors();
  let gateOn = false; let release = () => {}; let gated = false;
  globalThis.fetch = async () => {
    if (gateOn) { gated = true; await new Promise((r) => { release = r; }); }
    return Response.json({ events: [], contextNow: [] });
  };
  let handle;
  try {
    const page = await import('../../web/shared/session-page.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const baseDoc = document.listenerCount(); const baseWin = window.listenerCount();
    handle = await page.mount(root, { lens: 'session', sessionId: 'A' }, { ...ctxWith({ current: true }), handlers: { onOpenFile() {}, onCopy() {}, onOpenMap() {} } });
    gateOn = true;
    const updating = handle.update({ lens: 'session', sessionId: 'B' });
    for (let i = 0; i < 200 && !gated; i++) await tick(5);
    assert.ok(gated, 'the update\'s render is pending');
    handle.unmount(); handle = null; // the operator leaves
    release();
    await updating;
    await tick();
    assert.equal(document.listenerCount(), baseDoc, 'no document listener leaked');
    assert.equal(window.listenerCount(), baseWin, 'no window listener leaked');
  } finally { handle?.unmount(); restore(); delete globalThis.fetch; dom.restore(); }
});


// session page renders overlap the same way. An older render (B) held
// on its fetch landed after a newer one (C) had painted, and appended its
// banner children and a second .detail-cols block into the current page.
test('F3 session page: an older render landing late adds nothing to the page on screen and releases its listeners', async () => {
  const dom = installMiniDom({ pathname: '/session/A' });
  const restore = silenceErrors();
  let release; const gate = new Promise((r) => { release = r; }); let gated = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('session=B')) { gated = true; await gate; }
    return Response.json({ events: [], contextNow: [], gaps: [{ kind: 'x', detail: 'gap' }] });
  };
  let handle;
  try {
    const page = await import('../../web/shared/session-page.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const baseDoc = document.listenerCount(); const baseWin = window.listenerCount();
    handle = await page.mount(root, { lens: 'session', sessionId: 'A' }, { ...ctxWith({ current: true }), handlers: { onOpenFile() {}, onCopy() {}, onOpenMap() {} } });
    const afterOne = { doc: document.listenerCount(), win: window.listenerCount() };
    const older = handle.update({ lens: 'session', sessionId: 'B' });
    for (let i = 0; i < 200 && !gated; i++) await tick(5);
    assert.ok(gated, 'the B render waits on its fetch');
    await handle.update({ lens: 'session', sessionId: 'C' });
    release();
    await older;
    await tick();
    assert.equal(root.querySelectorAll('.session-bands').length, 1, 'one bands block');
    assert.equal(root.querySelectorAll('.session-header').length, 1, 'one header');
    assert.equal(document.listenerCount(), afterOne.doc, 'the stale render left no document listener');
    assert.equal(window.listenerCount(), afterOne.win, 'the stale render left no window listener');
    handle.unmount(); handle = null;
    assert.equal(document.listenerCount(), baseDoc);
    assert.equal(window.listenerCount(), baseWin);
  } finally { handle?.unmount(); restore(); delete globalThis.fetch; dom.restore(); }
});

// Re-audit: the code graph panel's map.js keeps module-level
// singletons (the roster rail, the map wrap, the blast container). A render
// started earlier but landing later (a superseded Surface's graph panel, or
// two overlapping renders on one panel) wrote its session's roster into the
// rail the newer render owns.
test('round 4 map: an older renderMap landing late does not repaint the newer render\'s roster', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const restore = silenceErrors();
  const sessions = [{ id: 'S1', title: 'one', live: true, lastTs: 2 }, { id: 'S2', title: 'two', live: true, lastTs: 1 }];
  let release; const gate = new Promise((r) => { release = r; }); let held = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/state' && !held) { held = true; await gate; }
    if (u.startsWith('/api/state')) return Response.json({ sessions, events: [] });
    return Response.json({ graph: null, projects: [] });
  };
  try {
    const map = await import('../../web/observability/map.js');
    const a = document.createElement('div'); document.body.appendChild(a);
    const b = document.createElement('div'); document.body.appendChild(b);
    const older = map.renderMap(a, {}, 'S1');
    for (let i = 0; i < 200 && !held; i++) await tick(5);
    assert.ok(held, 'the older render waits on its state fetch');
    await map.renderMap(b, {}, 'S2');
    const focused = () => [...b.querySelectorAll('.dash-roster-row')].filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.textContent);
    assert.ok(focused()[0]?.includes('two'), 'the newer render focuses S2');
    release();
    await older;
    await tick();
    assert.ok(focused()[0]?.includes('two'), `the newer roster still focuses S2, got ${JSON.stringify(focused())}`);
  } finally { restore(); delete globalThis.fetch; dom.restore(); }
});

// Re-audit: updateMap (the SSE tick) awaits the active session's
// events and then re-renders the singleton container for the session it
// resolved before that await, even when a newer render switched the map to
// another session meanwhile.
test('round 4 map: an SSE tick landing after a newer render does not switch the map back', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const restore = silenceErrors();
  const sessions = [{ id: 'S1', title: 'one', live: true, lastTs: 2, cwd: '/repo' }, { id: 'S2', title: 'two', live: true, lastTs: 1, cwd: '/repo' }];
  const graph = { nodes: [{ id: 'n1', source_file: 'a.js' }], links: [] };
  let gateOn = false; let release = () => {}; let held = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/state?session=S1') && gateOn) {
      held = true; await new Promise((r) => { release = r; });
      return Response.json({ sessions, events: [{ kind: 'file-edit', path: '/repo/a.js' }] });
    }
    if (u.startsWith('/api/state')) return Response.json({ sessions, events: [] });
    if (u.startsWith('/api/graph')) return Response.json({ graph, graphRoot: '/repo' });
    return Response.json({ projects: [] });
  };
  try {
    const map = await import('../../web/observability/map.js');
    const box = document.createElement('div'); document.body.appendChild(box);
    await map.renderMap(box, {}, 'S1');
    gateOn = true;
    const tickP = map.updateMap({ sessions });
    for (let i = 0; i < 200 && !held; i++) await tick(5);
    assert.ok(held, 'the tick waits on S1\'s events');
    gateOn = false;
    await map.renderMap(box, {}, 'S2');
    const focused = () => [...box.querySelectorAll('.dash-roster-row')].filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.textContent);
    assert.ok(focused()[0]?.includes('two'), 'the newer render focuses S2');
    release();
    await tickP;
    await tick(30);
    assert.ok(focused()[0]?.includes('two'), `the map still shows S2, got ${JSON.stringify(focused())}`);
  } finally { restore(); delete globalThis.fetch; dom.restore(); }
});

// Re-audit: Surface's code graph panel awaited the map module and then called
// renderMap, which takes map.js's singleton container, even when the mount had
// been left meanwhile: a newer map's SSE updates then went to the detached one.
// Card glmps-2-0-137 moved the graph to Knowledge > Architecture graph (the
// Surface panel is gone), so the guard is pinned where the map now lives.
test('round 4 Knowledge: an Architecture graph tab left while map.js loaded never takes the map', async () => {
  const dom = installMiniDom({ pathname: '/knowledge', search: '?tab=architecture' });
  const restore = silenceErrors();
  globalThis.fetch = async () => Response.json({ sessions: [], events: [], graph: null, projects: [], nodes: [], links: [], loops: [], graphs: [] });
  let current = true;
  try {
    const { parseLink } = await import('../../web/shared/deep-link.js');
    const lens = await import('../../web/knowledge/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const ctx = { getState: () => ({ sessions: [] }), toast: () => {}, go: () => {}, handlers: {}, isCurrent: () => current };
    const p = lens.mount(root, parseLink('/knowledge', '?tab=architecture'), ctx);
    current = false; // the operator left before the import resolved
    const handle = await p;
    await tick();
    const host = root.querySelector('.kn-map');
    assert.ok(host, 'the tab had started');
    assert.equal(host.childNodes.length, 0, 'nothing rendered for a left Knowledge lens');
    handle?.unmount?.();
  } finally { restore(); delete globalThis.fetch; dom.restore(); }
});


// (c) A live-update tick that starts while a click render is still in
// flight (S2 waiting on /api/state) resolved its session (S1) before its
// await and, once the click render landed, re-rendered S1 over it: the
// operator's click was lost. A tick now skips while any render is unsettled.
test('round 5 map: a tick that starts during a click render does not undo the click', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const restore = silenceErrors();
  const sessions = [{ id: 'S1', title: 'one', live: true, lastTs: 2, cwd: '/repo' }, { id: 'S2', title: 'two', live: true, lastTs: 1, cwd: '/repo' }];
  const graph = { nodes: [{ id: 'n1', source_file: 'a.js' }, { id: 'n2', source_file: 'b.js' }], links: [] };
  const st = { hold: false, held: false, release: () => {} };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/state' && st.hold) { st.hold = false; st.held = true; await new Promise((r) => { st.release = r; }); return Response.json({ sessions, events: [] }); }
    if (u.startsWith('/api/state?session=S1')) { st.s1 = (st.s1 ?? 0) + 1; return Response.json({ sessions, events: st.s1 > 1 ? [{ kind: 'file-edit', path: '/repo/a.js' }, { kind: 'file-edit', path: '/repo/b.js' }] : [{ kind: 'file-edit', path: '/repo/a.js' }] }); }
    if (u.startsWith('/api/state?session=S2')) return Response.json({ sessions, events: [{ kind: 'file-edit', path: '/repo/b.js' }] });
    if (u.startsWith('/api/state')) return Response.json({ sessions, events: [] });
    if (u.startsWith('/api/graph')) return Response.json({ graph, graphRoot: '/repo' });
    return Response.json({ projects: [] });
  };
  try {
    const map = await import('../../web/observability/map.js');
    const box = document.createElement('div'); document.body.appendChild(box);
    await map.renderMap(box, {}, 'S1');
    st.hold = true;
    const clicked = map.renderMap(box, {}, 'S2');
    for (let i = 0; i < 200 && !st.held; i++) await tick(5);
    assert.ok(st.held, 'the click render waits on its state fetch');
    const tickP = map.updateMap({ sessions });
    await tick(10);
    st.release();
    await clicked; await tickP; await tick(50);
    const focused = [...box.querySelectorAll('.dash-roster-row')].filter((r) => r.getAttribute('aria-current') === 'true').map((r) => r.textContent);
    assert.ok(focused[0]?.includes('two'), `the clicked session S2 stays on screen, got ${JSON.stringify(focused)}`);
  } finally { restore(); delete globalThis.fetch; dom.restore(); }
});

