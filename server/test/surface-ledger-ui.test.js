// Routes under test: server/lib/routes/surface-routes.js
// Surface v2 U2: the data-type layers, the Data ledger panel and the stacked
// bars on the platforms, against a faked GET /api/surface/ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const TYPE_IDS = ['markdown', 'config', 'code', 'projects', 'cards', 'sessions', 'learning', 'alerts'];

async function withLens(fn, fetchImpl) {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('', fetchImpl);
    handle = m.handle;
    await tick();
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}

// The default view starts with every data type off (card glmps-2-0-208); the bar tests turn them on first.
function typesOn(root) {
  for (const id of TYPE_IDS) { const box = root.querySelector(`#layer-type-${id}`); box.checked = true; box.dispatchEvent(new MiniEvent('change')); }
}

test('the default view has the Layers panel closed and no data-type columns on the platforms', async () => {
  await withLens(async ({ root }) => {
    assert.equal(root.querySelector('#dock-layers').hidden, true, 'Layers starts closed');
    assert.equal(root.querySelector('#dock-ledger').hidden, true, 'the Data ledger starts closed');
    for (const id of TYPE_IDS) assert.equal(root.querySelector(`#layer-type-${id}`).checked, false, `${id} starts off`);
    assert.equal(root.querySelector('.player-local').querySelectorAll('.seg').length, 0);
    typesOn(root);
    assert.equal(root.querySelector('.player-local').querySelectorAll('.seg').length, 8, 'checking the types brings the columns back');
  });
});

test('the Layers panel lists the eight data types first, each a datatype item with swatch, count and key', async () => {
  await withLens(async ({ root }) => {
    for (const [i, id] of TYPE_IDS.entries()) {
      const box = root.querySelector(`#layer-type-${id}`);
      assert.ok(box, `checkbox for ${id}`);
      const row = box.parentNode;
      assert.ok(row.querySelector('.sw'), 'swatch');
      assert.equal(row.querySelector('kbd').textContent, String(i + 1));
      const name = row.querySelector('.layer-name');
      assert.equal(name.dataset.itemType, 'datatype');
      assert.equal(name.dataset.itemId, id);
      assert.ok(name.dataset.link.includes('sel=datatype'));
    }
    const md = root.querySelector('#layer-type-markdown').parentNode;
    assert.equal(md.querySelector('.n').textContent, '2,519');
    const rows = [...root.querySelector('#dock-layers').querySelectorAll('.layer-row')];
    assert.equal(rows.findIndex((r) => r.querySelector('#layer-type-alerts')), 7, 'types come before the other layers');
    assert.ok(rows.findIndex((r) => r.querySelector('#layer-players')) > 7);
  });
});

test('the ledger panel is named Data ledger and lists the types with a chip per holder', async () => {
  await withLens(async ({ root }) => {
    const dock = root.querySelector('#dock-ledger');
    assert.equal(dock.querySelector('.surface-panel-title').textContent, 'Data ledger');
    const rows = dock.querySelectorAll('.lrow');
    assert.equal(rows.length, 8);
    const byName = (n) => rows.find((r) => r.querySelector('.nm').textContent === n);
    const md = byName('Markdown documents');
    assert.match(md.textContent, /GitHub 362/); assert.match(md.textContent, /only here 2,157/);
    assert.match(byName('Learning loops').textContent, /nowhere else/);
    assert.match(byName('Sessions').textContent, /Anthropic 600/);
    assert.match(byName('Sessions').textContent, /Gemini \?/, 'a copy with no captured count says so');
    assert.equal(md.dataset.itemType, 'datatype');
    md.click(); await tick();
    assert.match(root.querySelector('#panel-inspector').textContent, /2,519 on this disk/);
  });
});

test('each platform draws its data types as side-by-side columns on one baseline', async () => {
  await withLens(async ({ root }) => {
    typesOn(root);
    const cols = () => root.querySelector('.player-local').querySelectorAll('.seg');
    const num = (el, a) => Number(el.getAttribute(a));
    const xs = cols().map((c) => num(c, 'x'));
    assert.equal(new Set(xs).size, 8, 'every column has its own x');
    assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'columns run left to right in type order');
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1] + num(cols()[i - 1], 'width'), 'columns do not overlap');
    assert.equal(new Set(cols().map((c) => (num(c, 'y') + num(c, 'height')).toFixed(1))).size, 1, 'one baseline');
    assert.ok(Math.abs(xs[0] + (xs[7] + num(cols()[7], 'width'))) < 0.01, 'centred on the platform');
    const box = root.querySelector('#layer-type-markdown');
    box.checked = false; box.dispatchEvent(new MiniEvent('change'));
    assert.equal(cols().length, 7);
    assert.ok(Math.abs(num(cols()[0], 'x') + (num(cols()[6], 'x') + num(cols()[6], 'width'))) < 0.01, 'the rest close up and re-centre');
    assert.match(cols()[0].querySelector('title').textContent, /Config files: 164/);
  });
});

test('each platform carries a bar per data type; unchecking a type removes it', async () => {
  await withLens(async ({ root }) => {
    typesOn(root);
    const segs = (pid, t) => root.querySelector(`.player-${pid}`).querySelectorAll(t ? `[data-type="${t}"]` : '.seg');
    assert.deepEqual(segs('github').map((s) => s.getAttribute('data-type')), ['markdown', 'config', 'code', 'projects']);
    assert.equal(segs('local').length, 8, 'the local store holds every type');
    assert.equal(segs('slack').length, 1);
    assert.equal(segs('github', 'markdown').length, 1);
    const box = root.querySelector('#layer-type-markdown');
    box.checked = false; box.dispatchEvent(new MiniEvent('change'));
    assert.equal(segs('github', 'markdown').length, 0);
    assert.equal(segs('local', 'markdown').length, 0);
    assert.equal(segs('github').length, 3);
    assert.ok(root.querySelector('#dock-ledger').querySelectorAll('.lrow').find((r) => r.querySelector('.nm').textContent === 'Markdown documents').classList.contains('off'));
    window.dispatchEvent(new MiniEvent('keydown', { key: '1', target: document.body }));
    assert.equal(segs('github', 'markdown').length, 1, 'key 1 brings the type back');
  });
});

test('a failed ledger feed is named in the panel and the rest of Surface still mounts', async () => {
  await withLens(async ({ root }) => {
    assert.match(root.querySelector('#dock-ledger').textContent, /Data ledger not available: GET \/api\/surface\/ledger returned 500/);
    assert.ok(root.querySelector('.player-github'), 'players still drew');
    assert.equal(root.querySelector('.player-github').querySelectorAll('.seg').length, 0);
    assert.ok(root.querySelector('#layer-type-code'), 'the type rows remain');
  }, surfaceFetch({ '/api/surface/ledger': new Response('{"error":"boom"}', { status: 500 }) }));
});

test('a ledger that never answers does not hold the globe back', async () => {
  const base = surfaceFetch();
  const slow = (url, opts) => (String(url).startsWith('/api/surface/ledger') ? new Promise(() => {}) : base(url, opts));
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await Promise.race([mountSurface('', slow), tick(2000).then(() => 'timeout')]);
    assert.notEqual(m, 'timeout', 'mount resolved while the ledger is pending');
    handle = m.handle;
    assert.ok(m.root.querySelector('.player-local'));
    assert.match(m.root.querySelector('#dock-ledger').textContent, /measuring/i);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});
