// Routes under test: server/lib/routes/surface-routes.js
// R2 (glmps-2-0-63) AC-3: the Data ledger shows the last measured counts at
// once. A row that has a previous measurement never says "measuring".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, LEDGER } from './fixtures/surface-fixtures.js';
import { createLedgerStore, LEDGER_CACHE_KEY } from '../../web/surface/ledger.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('AC-3 (store): a stored measurement seeds the store as ok, and a fresh resolve replaces and re-stores it', () => {
  const storage = memStorage({ [LEDGER_CACHE_KEY]: JSON.stringify({ ts: 1000, types: LEDGER.types }) });
  const store = createLedgerStore({ storage });
  assert.equal(store.get().status, 'ok');
  assert.equal(store.get().types.length, 8);
  assert.equal(store.get().ts, 1000);
  store.resolve({ ts: 2000, types: [LEDGER.types[0]] });
  assert.equal(store.get().types.length, 1);
  assert.equal(JSON.parse(storage.m.get(LEDGER_CACHE_KEY)).ts, 2000);
});

test('AC-3 (store): a failed refresh keeps the last measurement and names the failure; with nothing stored it is an error', () => {
  const seeded = createLedgerStore({ storage: memStorage({ [LEDGER_CACHE_KEY]: JSON.stringify({ ts: 1000, types: LEDGER.types }) }) });
  seeded.fail('GET /api/surface/ledger returned 500');
  assert.equal(seeded.get().status, 'ok');
  assert.equal(seeded.get().types.length, 8);
  assert.match(seeded.get().refreshError, /returned 500/);
  const empty = createLedgerStore({ storage: memStorage() });
  assert.equal(empty.get().status, 'loading');
  empty.fail('x');
  assert.equal(empty.get().status, 'error');
});

test('AC-3 (store): a corrupt or empty stored value is ignored', () => {
  for (const bad of ['{', '{"types":[]}', 'null', '{"types":"x"}']) {
    assert.equal(createLedgerStore({ storage: memStorage({ [LEDGER_CACHE_KEY]: bad }) }).get().status, 'loading', bad);
  }
});

test('AC-3: the second visit paints the stored counts while the ledger feed is still pending', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    let m = await mountSurface('', surfaceFetch());
    await tick(60);
    assert.ok(localStorage.getItem(LEDGER_CACHE_KEY), 'the first visit stored its measurement');
    m.handle.unmount(); m.root.remove(); delete globalThis.fetch; delete window.d3;

    const base = surfaceFetch();
    m = await mountSurface('', (url, opts) => (String(url).startsWith('/api/surface/ledger') ? new Promise(() => {}) : base(url, opts)));
    handle = m.handle;
    const dock = m.root.querySelector('#dock-ledger');
    assert.doesNotMatch(dock.textContent, /measuring/i, 'no row says measuring');
    assert.match(dock.textContent, /2,519/);
    assert.equal(m.root.querySelector('#layer-type-markdown').parentNode.querySelector('.n').textContent, '2,519', 'the Layers panel has the count too');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});
