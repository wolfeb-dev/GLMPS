// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/workspace-routes.js
// server/test/lens-surface-items.test.js
// Acceptance (program plan section 4) for Surface: every interactive item type
// the lens declares is rendered somewhere reachable (on the globe, in the HUD,
// in a panel, or in an inspector list), and every rendered item has a click
// handler and a deep link that parses back to a page. The code graph links to
// the wiki page (D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, loadVendorD3 } from './fixtures/mini-dom.js';
import { parseLink, LENSES } from '../../web/shared/deep-link.js';
import { surfaceFetch, mountSurface, ROWS } from './fixtures/surface-fixtures.js';
import { SURFACE_PANEL_ROUTES } from './fixtures/surface-panel-routes.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('every Surface item type renders with a click handler and a deep link', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('', surfaceFetch({
      ...SURFACE_PANEL_ROUTES,
      '/api/sessions/live': { sessions: [{ id: 's1', cwd: ROWS[0].path + '/web', lastTs: Date.now() }], now: Date.now(), staleMs: 600000 },
      '/api/workspace': { sessions: [{ sessionId: 's1', title: 'wire the globe', declared: { goal: 'globe' }, observed: { activePaths: ['web/surface/globe.js'] }, divergence: { level: 'minor' }, hasPendingSteer: false }] },
      '/api/backlog': { items: [{ id: 'mc-7', title: 'globe', state: 'queued', origin: null }, { id: 'mc-8', title: 'thread', state: 'in_progress', origin: { via: 'slack' } }] },
      '/api/surface/tree': { repo: 'glmps', path: ROWS[0].path, base: '@{u}', folders: [{ dir: 'web', count: 10, drifted: 1 }], files: [{ path: 'web/app.js', status: 'uncommitted' }], truncated: false },
    }));
    handle = m.handle;
    const root = m.root;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const seen = new Set();
    // Inspector lists are replaced as you drill, so check every item on screen
    // after each step, not only at the end.
    const sweep = () => {
      for (const el of collectItems(document.body)) {
        seen.add(el.dataset.itemType);
        assert.ok(el.listenerCount('click') >= 1, `${el.dataset.itemType}:${el.dataset.itemId} has no click handler`);
        const u = new URL(el.dataset.link, 'http://x');
        const r = parseLink(u.pathname, u.search);
        assert.ok(LENSES.includes(r.lens) || r.lens === 'session', `${el.dataset.link}`);
      }
    };
    const click = async (type, id, ms = 30) => {
      const el = collectItems(document.body).find((e) => e.dataset.itemType === type && (id == null || e.dataset.itemId === id));
      assert.ok(el, `no ${type} ${id ?? ''}`);
      el.click(); await tick(ms); sweep();
    };
    sweep();
    await click('region', 'nowhere-else');
    await click('card-stack', 'local');
    await click('repo', 'glmps');
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree').click(); await tick(100); sweep();
    await click('folder', 'glmps/web');
    // The rail's drawer launcher opens Alerts; the drawer's tabs reach the
    // rest. Decisions and the code graph are Knowledge tabs now (card
    // glmps-2-0-137), so their item types are no longer Surface's.
    await click('panel', 'attention', 100);
    [...root.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Policy bounds').click(); await tick(100); sweep();
    const lens = await import('../../web/surface/lens.js');
    for (const type of Object.keys(lens.ITEM_TYPES)) assert.ok(seen.has(type), `no rendered item of type ${type}`);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// a selected repo mark (its inspector panel open) carried no
// aria-current, so a screen reader could not tell which repo's detail was
// open. Selecting a different repo must move the mark, not duplicate it.
test('the open repo mark carries aria-current, and selecting another one moves it (B2)', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const find = (id) => collectItems(document.body).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === id);
    const repoA = find('glmps');
    const repoB = find('glmps-2.0');
    assert.ok(repoA && repoB, 'both repo marks rendered');
    assert.equal(repoA.getAttribute('aria-current'), null, 'nothing is selected before any click');

    repoA.click();
    await tick();
    assert.equal(find('glmps').getAttribute('aria-current'), 'true', 'the opened repo mark is marked current');
    assert.equal(find('glmps-2.0').getAttribute('aria-current'), null);

    find('glmps-2.0').click();
    await tick();
    assert.equal(find('glmps-2.0').getAttribute('aria-current'), 'true', 'the newly opened repo mark is marked current');
    assert.equal(find('glmps').getAttribute('aria-current'), null, 'the previously selected mark is unmarked');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// Surface restores a deep-linked selection through its own
// openSel/registerOpener (layers.js calls api.inspect()/api.flyTo()
// directly), not interactive-item.js's openSelection (which clicks the
// bound element) the way Now/Learning/Work do - so bindItem's own
// markSelected never ran for this path. A page load at a selection URL must
// mark the mark too, not just a direct click.
test('a deep-linked repo selection marks the mark current on mount, same as a click (B2)', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?sel=repo%3Aglmps');
    handle = m.handle;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const repo = collectItems(document.body).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'glmps');
    assert.ok(repo, 'the deep-linked repo mark rendered');
    assert.equal(repo.getAttribute('aria-current'), 'true', 'a deep-linked selection marks the mark current, not only a click');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// closing the inspector panel (its own Close button, or a
// fourth panel evicting it per the R2 test below) left whatever mark it was
// showing still carrying aria-current - a screen reader kept announcing a
// mark as selected after its own detail panel was gone.
test('closing the inspector panel clears the selected mark\'s aria-current (Task 15 round 2)', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const find = (id) => collectItems(document.body).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === id);

    find('glmps').click();
    await tick();
    assert.equal(find('glmps').getAttribute('aria-current'), 'true', 'the opened repo mark is marked current');

    // mini-dom's querySelector only matches a single simple clause (tag/#id/
    // .class/[attr]), not a descendant combinator - scope in two steps.
    const panel = document.querySelector('#panel-inspector');
    assert.ok(panel, 'the inspector panel renders');
    const closeBtn = panel.querySelector('.panel-close');
    assert.ok(closeBtn, 'the inspector panel\'s own Close button renders');
    closeBtn.click();
    await tick();
    assert.equal(find('glmps').getAttribute('aria-current'), null, 'closing the inspector panel clears the stale selection mark');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// Card glmps-2-0-137 phase 2 (story 13): the panel stack that closed its
// oldest panel when a fourth opened is now one drawer showing one view.
test('R2: the drawer shows one view at a time and tells the caller what it replaced', async () => {
  const dom = installMiniDom();
  try {
    const { createDrawer } = await import('../../web/surface/drawer.js');
    const box = document.createElement('div');
    const closed = [];
    const s = createDrawer(box, { tabs: [{ id: 'attention', label: 'Alerts' }, { id: 'repos', label: 'Repo inspector' }], onClose: (id) => closed.push(id) });
    for (const id of ['inspector', 'attention', 'repos']) s.open(id, id, (b) => { b.textContent = id; });
    assert.deepEqual(s.ids(), ['repos']);
    assert.deepEqual(closed, ['inspector', 'attention']);
    assert.equal(s.el.id, 'panel-repos');
    s.close();
    assert.deepEqual(s.ids(), []);
    assert.equal(s.el.hidden, true);
  } finally { dom.restore(); }
});

// Coordinator carry 1: Task 10's review found that a legacy deep link
// resolving to {lens:'surface', panel:...} opened a bare globe with no panel
// and no error - api.panelOpeners was not assigned yet. One test per legacy
// view (web/shared/deep-link.js LEGACY_VIEWS) that maps to a Surface panel.
// /map and /decisions land on Knowledge tabs now (card glmps-2-0-137 phase 5,
// lens-knowledge.test.js).
for (const [view, panelId] of [['policy', 'declared'], ['engagement', 'declared'], ['governance', 'declared']]) {
  test(`legacy deep link /${view} opens the ${panelId} Surface panel`, async () => {
    const dom = installMiniDom({ pathname: `/${view}` });
    let handle;
    try {
      globalThis.fetch = surfaceFetch(SURFACE_PANEL_ROUTES);
      window.d3 = loadVendorD3();
      const lens = await import('../../web/surface/lens.js');
      const root = document.createElement('div'); document.body.appendChild(root);
      // The legacy route resolver (web/shared/deep-link.js parseLink) is what
      // a real page load or app.js router hit produces for this bare path -
      // {lens:'surface', panel:panelId, sel:null, legacy:view}.
      handle = await lens.mount(root, parseLink(`/${view}`), { getState: () => ({ tools: [] }), toast: () => {}, go: () => {}, handlers: {} });
      await tick(150);
      const panel = root.querySelector(`#panel-${panelId}`);
      assert.ok(panel, `/${view} must open the ${panelId} panel, not a bare globe`);
    } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
  });
}

// Surface adds 'surface-root' to the shared #lens-root (its
// padding 0 / gap 0 / height 100% override); unmount must take it off, or
// every later lens renders with Surface's layout.
test('W-I1: unmount removes surface-root from the shared root', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    assert.ok(m.root.classList.contains('surface-root'));
    handle.unmount(); handle = null;
    assert.equal(m.root.classList.contains('surface-root'), false);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// Back/Forward hands update() a route whose layers differ;
// the globe and the rail checkboxes must follow, and the next URL written
// must describe what is on screen.
test('W-I3: update() with new layers drives the rail checkboxes, the globe and the URL', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?layers=residency,labels');
    handle = m.handle;
    const box = (id) => m.root.querySelector(`#layer-${id}`);
    assert.equal(box('files').checked, false);
    assert.equal(box('residency').checked, true);
    await handle.update({ lens: 'surface', layers: ['files', 'labels'] });
    assert.equal(box('files').checked, true, 'files turned on');
    assert.equal(box('residency').checked, false, 'residency turned off');
    const g = m.root.querySelector('.layer-residency') ?? null;
    if (g) assert.equal(g.getAttribute('display') ?? g.style.display, 'none');
    const last = window.history.entries.at(-1)?.[1] ?? '';
    const layers = new URL(last, 'http://x').searchParams.get('layers') ?? '';
    assert.deepEqual(layers.split(',').sort(), ['files', 'labels'], `URL matches the screen: ${last}`);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('the repository ring is off by default and repositories can still be located', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const { MiniEvent } = await import('./fixtures/mini-dom.js');
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const m = await mountSurface('', surfaceFetch({
      '/api/sessions/live': { sessions: [{ id: 's1', cwd: 'D:/glmps/web', lastTs: Date.now() }] },
      '/api/surface/tree': { repo: 'glmps', path: ROWS[0].path, base: '@{u}', folders: [{ dir: 'web', count: 10, drifted: 1 }], files: [{ path: 'web/app.js', status: 'uncommitted' }], truncated: false },
    }));
    handle = m.handle;
    const box = (id) => m.root.querySelector(`#layer-${id}`);
    assert.equal(box('residency').checked, false);
    assert.equal(box('nowhere').checked, false);
    assert.equal(box('agents').checked, true, 'the agent dots stay');
    assert.equal(box('alerts').checked, true, 'the alert ring stays');
    assert.equal(box('loops').checked, false, 'Loops stays off');
    await tick();
    const vec = m.root.querySelector('.agent-vec');
    assert.equal(vec.getAttribute('d'), '', 'no line to a marker that is not drawn');
    box('residency').checked = true; box('residency').dispatchEvent(new MiniEvent('change'));
    assert.match(vec.getAttribute('d'), /^M.+L/, 'the line returns with the ring');
    box('residency').checked = false; box('residency').dispatchEvent(new MiniEvent('change'));
    assert.equal(vec.getAttribute('d'), '');
    collectItems(document.body).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'glmps').click(); await tick();
    [...m.root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree').click();
    let folder = null;
    for (let i = 0; i < 100 && !folder?.getAttribute('transform'); i++) { await tick(20); folder = m.root.querySelector('.folder'); }
    assert.match(folder?.getAttribute('transform') ?? '', /^translate\(/, 'the file tree is placed around a repository whose marker is hidden');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// single-key shortcuts must not hijack Ctrl/Meta/Alt chords,
// typing in an editable field, or focus outside the Surface lens; camera
// reset gets a key that no layer uses.
test('W-I5: layer shortcuts ignore modifier chords, editable targets and focus outside the lens', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const { MiniEvent } = await import('./fixtures/mini-dom.js');
    const files = () => m.root.querySelector('#layer-files').checked;
    // mini-dom does not bubble from document to window: dispatch on window
    // with the focused element as the target, the way a real keydown arrives.
    const key = (init, target = document.body) => { const e = new MiniEvent('keydown', { ...init, target }); window.dispatchEvent(e); return e; };
    key({ key: 'f', ctrlKey: true }); assert.equal(files(), false, 'Ctrl+F is the browser find, not the files layer');
    key({ key: 'f', metaKey: true }); assert.equal(files(), false);
    key({ key: 'f', altKey: true }); assert.equal(files(), false);
    const editable = document.createElement('div'); editable.setAttribute('contenteditable', 'true'); m.root.appendChild(editable);
    key({ key: 'f' }, editable); assert.equal(files(), false, 'typing in a contenteditable');
    const outside = document.createElement('button'); document.body.appendChild(outside);
    key({ key: 'f' }, outside); assert.equal(files(), false, 'focus outside the Surface lens');
    key({ key: 'f' }); assert.equal(files(), true, 'a bare F with no focus target toggles the layer');
    key({ key: 'f' }, m.root.querySelector('.surface-stage')); assert.equal(files(), false, 'and from inside the lens');
    const residency = m.root.querySelector('#layer-residency').checked;
    key({ key: '0' });
    assert.equal(m.root.querySelector('#layer-residency').checked, residency, 'the reset key toggles no layer');
    assert.ok([...m.root.querySelectorAll('kbd')].some((k) => k.textContent === '0'), 'the reset key is shown in the rail');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// a panel's render was neither awaited nor caught, so a
// rejected render (renderGraphPanel's dynamic import failing, say) left a
// blank panel and an unhandled rejection. Either failure shape lands in the
// panel's own error state.
test('W-M3: a panel render that rejects or throws shows the panel error state', async () => {
  const dom = installMiniDom();
  const origError = console.error; console.error = () => {};
  try {
    const { createDrawer } = await import('../../web/surface/drawer.js');
    const box = document.createElement('div');
    const s = createDrawer(box, { tabs: [{ id: 'repos', label: 'Repo inspector' }] });
    const body = s.open('repos', 'Repo inspector', async () => { throw new Error('import failed: study-panels.js'); });
    await tick(10);
    const err = body.querySelector('.band-error');
    assert.ok(err, 'a rejected render shows an error');
    assert.match(err.textContent, /import failed: study-panels\.js/);
    const body2 = s.open('inspector', 'Inspector', () => { throw new Error('sync boom'); });
    assert.match(body2.querySelector('.band-error')?.textContent ?? '', /sync boom/);
  } finally { console.error = origError; dom.restore(); }
});

// a remote that is neither SCP-style nor a URL made hostOf
// return null, and the arc's accessible name read "repo to null".
test('SF-M1: an unparseable remote is named as unreadable, never "null"', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const rows = [{ ...ROWS[0], repo: 'odd', remote: 'not a remote at all' }];
    const m = await mountSurface('', surfaceFetch({ '/api/residency': { ts: Date.now(), rows } }));
    handle = m.handle;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const arc = collectItems(document.body).find((e) => e.dataset.itemType === 'arc' && e.dataset.itemId === 'odd');
    assert.ok(arc, 'the arc rendered');
    const name = arc.getAttribute('aria-label') ?? '';
    assert.doesNotMatch(name, /null/);
    assert.equal(name, 'odd to remote unreadable');
    arc.click(); await tick();
    const title = document.querySelector('#panel-inspector')?.querySelector('.surface-panel-title')?.textContent ?? '';
    assert.equal(title, 'odd to remote unreadable');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// Surface v2 U1: the study's frame (icon rail, HUD panel, presets, footer
// bar), with no title plate and no trace of the retired ledger name.
test('U1: the study frame renders with a rail, HUD, presets and footer, and no title or retired name', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const { root } = m;
    const rail = root.querySelector('.surface-iconrail');
    assert.ok(rail, 'icon rail');
    const railBtns = rail.querySelectorAll('button');
    const names = railBtns.map((b) => b.getAttribute('aria-label'));
    for (const want of ['Layers', 'Data ledger', 'Recent edits', 'Context drawer', 'Reset view']) assert.ok(names.includes(want), `rail launcher ${want}`);
    assert.ok(railBtns.every((b) => b.getAttribute('title')), 'every launcher has a tooltip');
    assert.equal(root.querySelector('.surface-pulse'), null, 'the Pulse dock is retired (card glmps-2-0-137 phase 2)');
    const presets = root.querySelector('.surface-presets');
    assert.ok(presets, 'camera presets');
    assert.deepEqual(presets.querySelectorAll('button').map((b) => b.textContent), ['Players', 'Local store', 'File tree', 'Agents', 'Kanban', 'Loops', 'Alerts', 'GitHub', 'Global']);
    const foot = root.querySelector('.surface-footbar');
    assert.ok(foot, 'footer bar');
    assert.match(foot.textContent, /centre/); assert.match(foot.textContent, /zoom/); assert.match(foot.textContent, /frame/);
    assert.equal(root.querySelectorAll('h1').length, 0, 'no title in the lens');
    const attrs = [];
    const walk = (n) => { if (n.nodeType === 1) { for (const k of ['aria-label', 'title']) if (n.getAttribute(k)) attrs.push(n.getAttribute(k)); } for (const c of n.childNodes ?? []) walk(c); };
    walk(root);
    // Built from pieces so this file does not itself carry the retired name.
    const retired = new RegExp([['where', 'our', 'data', 'lives'].join(' '), ['design', 'study'].join(' ')].join('|'), 'i');
    assert.doesNotMatch(`${root.textContent}\n${attrs.join('\n')}`, retired);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('U1: a preset flies the camera and its button reads as pressed until the camera is moved', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?cam=10.00,10.00,2.00');
    handle = m.handle;
    const btn = (t) => m.root.querySelector('.surface-presets').querySelectorAll('button').find((b) => b.textContent === t);
    btn('Global').click();
    await tick(1600);
    assert.equal(btn('Global').getAttribute('aria-pressed'), 'true');
    const cam = new URL(window.history.entries.at(-1)[1], 'http://x').searchParams.get('cam');
    assert.match(cam, /,0\.90$/, `zoom landed on 0.9: ${cam}`);
    btn('Local store').click();
    await tick(1600);
    assert.equal(btn('Global').getAttribute('aria-pressed'), 'false');
    assert.equal(btn('Local store').getAttribute('aria-pressed'), 'true');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});
