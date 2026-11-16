// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/workspace-routes.js
// Surface v2 U3: the study's panels on live feeds (Repository inspector,
// Location drill-down, File tree, Agents). Since card glmps-2-0-137 phase 2
// they show in the one context drawer: Repo inspector is a drawer tab, the
// rest open as its detail view; the Kanban panel left Surface for Work
// (web-surface-phase2.test.js pins the rail link and the old ?panel=kanban).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS } from './fixtures/surface-fixtures.js';
import { collectItems } from '../../web/shared/interactive-item.js';
import { parseLink } from '../../web/shared/deep-link.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const TREE = { repo: 'glmps', path: ROWS[0].path, base: '@{u}', folders: [{ dir: 'web', count: 10, drifted: 1 }, { dir: '.', count: 3, drifted: 0 }], files: [{ path: 'web/app.js', status: 'uncommitted', size: 2048, mtimeMs: 1 }], truncated: false };
const FEEDS = {
  '/api/sessions/live': { sessions: [{ id: 's1', cwd: `${ROWS[0].path}/web`, lastTs: Date.now() - 30000 }, { id: 'sx', cwd: 'C:/elsewhere', lastTs: Date.now() }], now: Date.now(), staleMs: 600000 },
  '/api/workspace': { sessions: [{ sessionId: 's1', title: 'wire the globe', declared: { goal: 'globe' }, observed: {}, divergence: 'none' }] },
  '/api/backlog': { items: [{ id: 'mc-1', title: 'one', state: 'in_progress', origin: null }, { id: 'mc-2', title: 'two', state: 'held', origin: { via: 'slack' } }, { id: 'mc-3', title: 'three', state: 'queued', origin: null }, { id: 'mc-4', title: 'done', state: 'done', origin: null }] },
  '/api/surface/tree': TREE,
};

async function withLens(fn, overrides = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('', surfaceFetch({ ...FEEDS, ...overrides }));
    handle = m.handle;
    await tick();
    // the drawer's views open from their links (the presets and the globe's
    // marks use the same openers); the rail only toggles docks and the drawer.
    const launch = (panel) => { m.handle.update(parseLink('/surface', `?panel=${panel}`)); };
    await fn({ ...m, launch });
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}

const allBound = (panel) => {
  const items = collectItems(panel);
  assert.ok(items.length > 0, 'the panel has rows');
  for (const it of items) { assert.ok(it.dataset.link?.startsWith('/'), `${it.dataset.itemType} has a link`); assert.ok(it.listenerCount('click') >= 1, `${it.dataset.itemType} is clickable`); }
};

test('Repository inspector: a row per residency row with a coloured pin and its counts', async () => {
  await withLens(async ({ root, launch }) => {
    root.querySelector('.surface-iconrail').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Context drawer').click();
    root.querySelector('.surface-drawer').querySelectorAll('[role="tab"]').find((t) => t.textContent === 'Repo inspector').click();
    await tick();
    const panel = root.querySelector('#panel-repos');
    assert.ok(panel, 'the Repo inspector tab opens it');
    assert.equal(panel.querySelector('[aria-selected="true"]').textContent, 'Repo inspector');
    const rows = panel.querySelectorAll('.rrow');
    assert.equal(rows.length, ROWS.length);
    const row = (id) => rows.find((r) => r.dataset.itemId === id);
    assert.ok(row('glmps').classList.contains('drift'));
    assert.ok(row('glmps-2.0').classList.contains('sync'));
    assert.ok(row('tidewatch').classList.contains('nowhere'));
    assert.ok(row('glmps').querySelector('.pin'), 'a pin');
    assert.match(row('glmps').textContent, /1 ahead\s+3 behind\s+27 dirty/);
    allBound(panel);
    row('glmps').click(); await tick();
    assert.match(root.querySelector('#panel-inspector').textContent, /feat\/x/, 'a row opens the repository facts');
  });
});

test('clicking a player opens the Location drill-down with what it holds by data type', async () => {
  await withLens(async ({ root }) => {
    const mark = (id) => collectItems(root).find((e) => e.dataset.itemType === 'player' && e.dataset.itemId === id);
    mark('github').click(); await tick();
    const panel = root.querySelector('#panel-location');
    assert.ok(panel, 'Location panel');
    assert.equal(panel.querySelector('.surface-panel-title').textContent, 'Location');
    const names = panel.querySelectorAll('.lrow').map((r) => r.querySelector('.nm').textContent);
    assert.deepEqual(names, ['Markdown documents', 'Config files', 'Code files', 'Projects']);
    assert.match(panel.textContent, /362/);
    allBound(panel);
    mark('local').click(); await tick();
    assert.equal(root.querySelector('#panel-location').querySelectorAll('.lrow').length, 8);
  });
});

test('File tree: a repository picker, folders first, then the files that differ', async () => {
  await withLens(async ({ root, launch }) => {
    launch('files'); await tick(80);
    const panel = root.querySelector('#panel-files');
    assert.ok(panel);
    const pick = panel.querySelector('.tree-pick');
    assert.equal(pick.querySelectorAll('option').length, ROWS.length);
    const kinds = panel.querySelectorAll('.frow').map((r) => r.dataset.itemType);
    assert.deepEqual(kinds, ['folder', 'folder', 'file']);
    assert.match(panel.textContent, /web\/app\.js/);
    allBound(panel);
    collectItems(panel).find((e) => e.dataset.itemType === 'file').click(); await tick();
    assert.match(root.querySelector('#panel-inspector').textContent, /web\/app\.js/);
  });
});

test('File tree: a failing tree feed is named in the panel', async () => {
  await withLens(async ({ root, launch }) => {
    launch('files'); await tick(80);
    assert.match(root.querySelector('#panel-files').textContent, /The file tree failed to load: boom/);
  }, { '/api/surface/tree': new Response('{"error":"boom"}', { status: 500 }) });
});

test('Agents: live sessions with title, repository, last activity and the files they edited', async () => {
  await withLens(async ({ root, launch }) => {
    launch('agents'); await tick(80);
    const panel = root.querySelector('#panel-agents');
    const rows = panel.querySelectorAll('.arow');
    assert.equal(rows.length, 2);
    const s1 = rows.find((r) => r.dataset.itemId === 's1');
    assert.match(s1.textContent, /agent s1/);
    assert.doesNotMatch(s1.textContent, /wire the globe/, 'the summary is not shown');
    assert.match(s1.textContent, /glmps/);
    assert.match(s1.textContent, /\d+ s ago/);
    assert.match(s1.textContent, /app\.js \+4 -1/, 'the file this session edited, from the edits feed');
    assert.match(rows.find((r) => r.dataset.itemId === 'sx').textContent, /outside every registered repository/);
    allBound(panel);
  });
});

test('the drawer shows one of the study views at a time', async () => {
  await withLens(async ({ root, launch }) => {
    for (const n of ['repos', 'files', 'agents']) { launch(n); await tick(60); }
    const drawers = root.querySelectorAll('.surface-drawer');
    assert.equal(drawers.length, 1);
    assert.equal(drawers[0].id, 'panel-agents', 'the last view opened is the one shown');
    assert.equal(root.querySelector('#panel-files'), null, 'the views it replaced are gone, not stacked');
    assert.equal(drawers[0].querySelector('.surface-drawer-title').textContent, 'Agents');
  });
});
