// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/workspace-routes.js
// Surface v2 U4: the hover card on every item, with no network on show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS } from './fixtures/surface-fixtures.js';
import { SURFACE_PANEL_ROUTES } from './fixtures/surface-panel-routes.js';
import { collectItems } from '../../web/shared/interactive-item.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const TREE = { repo: 'glmps', path: ROWS[0].path, base: '@{u}', folders: [{ dir: 'web', count: 10, drifted: 1 }], files: [{ path: 'web/app.js', status: 'uncommitted', size: 2048, mtimeMs: Date.now() - 60000 }], truncated: false };
const FEEDS = {
  ...SURFACE_PANEL_ROUTES,
  '/api/sessions/live': { sessions: [{ id: 's1', cwd: ROWS[0].path + '/web', lastTs: Date.now() }], now: Date.now(), staleMs: 600000 },
  '/api/workspace': { sessions: [{ sessionId: 's1', title: 'wire the globe', declared: { goal: 'globe' }, observed: { activePaths: ['web/surface/globe.js'] }, divergence: { level: 'minor' }, hasPendingSteer: false }] },
  '/api/backlog': { items: [{ id: 'mc-7', title: 'globe', state: 'queued', origin: null }, { id: 'mc-8', title: 'thread', state: 'in_progress', origin: { via: 'slack' } }] },
  '/api/surface/tree': TREE,
};

const over = (el, init = {}) => el.dispatchEvent(new MiniEvent('pointerover', { bubbles: true, clientX: 40, clientY: 40, ...init }));
const cardOf = (root) => root.querySelector('.surface-hovercard');
const shown = (root) => !cardOf(root).hidden;
const dd = (root, key) => { const c = cardOf(root); const dts = c.querySelectorAll('dt'); const i = dts.findIndex((t) => t.textContent === key); return i < 0 ? null : c.querySelectorAll('dd')[i].textContent; };

async function withLens(fn, ctxExtra = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const calls = [];
    const inner = surfaceFetch(FEEDS);
    const m = await mountSurface('', async (url, opts) => { calls.push(String(url)); return inner(url, opts); }, ctxExtra);
    handle = m.handle;
    await tick();
    await fn({ ...m, calls });
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}

test('every item type has a hover model: the card shows synchronously with a title and makes no request', async () => {
  const { ITEM_TYPES } = await import('../../web/surface/lens.js');
  await withLens(async ({ root, calls }) => {
    const checked = new Set();
    const sweep = () => {
      for (const el of collectItems(document.body)) {
        const t = el.dataset.itemType;
        if (checked.has(t) || !root.contains(el)) continue;
        const n = calls.length;
        over(el);
        assert.equal(calls.length, n, `${t}: showing the card made a request`);
        assert.ok(shown(root), `${t}: the card shows on pointerover, with no await`);
        assert.ok(cardOf(root).querySelector('.hc-title').textContent.length > 0, `${t}: non-empty title`);
        assert.equal(el.getAttribute('aria-describedby'), 'surface-hovercard', `${t}: described by the card`);
        el.dispatchEvent(new MiniEvent('pointerout', { bubbles: true, relatedTarget: null }));
        assert.ok(!shown(root), `${t}: leaving hides it`);
        checked.add(t);
      }
    };
    const click = async (type, id, ms = 40) => {
      const el = collectItems(document.body).find((e) => e.dataset.itemType === type && (id == null || e.dataset.itemId === id));
      assert.ok(el, `no ${type} ${id ?? ''}`);
      el.click(); await tick(ms);
      sweep();
    };
    sweep();
    await click('region', 'nowhere-else');
    await click('card-stack', 'local');
    await click('repo', 'glmps');
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree').click(); await tick(100); sweep();
    await click('folder', 'glmps/web');
    await click('panel', 'attention', 100);
    [...root.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Policy bounds').click(); await tick(100); sweep();
    const missing = Object.keys(ITEM_TYPES).filter((t) => !checked.has(t));
    assert.deepEqual(missing, [], `types with no rendered item to hover: ${missing}`);
  });
});

test('a pointerover alone makes no network request', async () => {
  await withLens(async ({ root, calls }) => {
    const n = calls.length;
    for (const el of collectItems(root)) { over(el); el.dispatchEvent(new MiniEvent('pointerout', { bubbles: true, relatedTarget: null })); }
    assert.equal(calls.length, n);
  });
});

test('a file card shows path, repository, status, size, modified and who last edited it', async () => {
  await withLens(async ({ root }) => {
    collectItems(root).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'glmps').click(); await tick();
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree').click(); await tick(100);
    collectItems(root).find((e) => e.dataset.itemType === 'folder').click(); await tick();
    const file = collectItems(root).find((e) => e.dataset.itemType === 'file');
    assert.ok(file, 'a file row');
    over(file);
    assert.equal(dd(root, 'path'), `${ROWS[0].path}/web/app.js`);
    assert.equal(dd(root, 'repository'), 'glmps');
    assert.equal(dd(root, 'status'), 'uncommitted');
    assert.equal(dd(root, 'size'), '2.0 KB');
    assert.match(dd(root, 'modified'), / [AP]M [A-Z+0-9:]+, /, 'in the operator zone, the zone named');
    assert.match(dd(root, 'last edited by'), /agent s1/, 'the agent by tool and short id, not its summary');
    assert.match(root.querySelector('.hc-hint').textContent, /E edits/);
  });
});

test('pointerdown and Escape hide the card; a drag keeps it away until release; focus shows it', async () => {
  await withLens(async ({ root }) => {
    const mark = collectItems(root).find((e) => e.dataset.itemType === 'player' && e.dataset.itemId === 'github');
    over(mark); assert.ok(shown(root));
    mark.dispatchEvent(new MiniEvent('pointerdown', { bubbles: true })); assert.ok(!shown(root), 'pointerdown hides');
    over(mark); assert.ok(!shown(root), 'no card flickers up while a drag is in progress');
    window.dispatchEvent(new MiniEvent('pointerup', {}));
    over(mark); assert.ok(shown(root), 'after the release it shows again');
    window.dispatchEvent(new MiniEvent('keydown', { key: 'Escape', target: document.body })); assert.ok(!shown(root), 'Escape hides');
    mark.dispatchEvent(new MiniEvent('focusin', { bubbles: true })); assert.ok(shown(root), 'focus shows it');
    mark.dispatchEvent(new MiniEvent('focusout', { bubbles: true })); assert.ok(!shown(root), 'blur hides it');
  });
});

test('E and I act on the file the card is showing, and on nothing else', async () => {
  const opened = []; const ide = [];
  await withLens(async ({ root }) => {
    const key = (k, target = document.body) => window.dispatchEvent(new MiniEvent('keydown', { key: k, target }));
    collectItems(root).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'glmps').click(); await tick();
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree').click(); await tick(100);
    collectItems(root).find((e) => e.dataset.itemType === 'folder').click(); await tick();
    key('e'); key('i');
    assert.deepEqual([opened.length, ide.length], [0, 0], 'no card, no action');
    const file = collectItems(root).find((e) => e.dataset.itemType === 'file');
    over(file);
    const abs = `${ROWS[0].path}/web/app.js`;
    key('e', document.createElement('input')); assert.equal(opened.length, 0, 'typing in a field never triggers it');
    window.dispatchEvent(new MiniEvent('keydown', { key: 'e', ctrlKey: true, target: document.body })); assert.equal(opened.length, 0, 'a chord never triggers it');
    key('e'); key('i');
    assert.deepEqual(opened, [abs]); assert.deepEqual(ide, [abs]);
    const player = collectItems(root).find((e) => e.dataset.itemType === 'player');
    over(player); key('e'); assert.equal(opened.length, 1, 'a card that is not about a file does nothing');
  }, { fileActions: { openFileEditor: (p) => opened.push(p), openFileInIde: (p) => ide.push(p) } });
});
