// server/test/selection-mark.test.js
// Task 16 fix round 2:
// aria-current sat on a bound <li> while keyboard focus is on its inner
//      .item-btn, so a screen reader on the button never heard "current".
// a deep link naming a selection opened its detail but, in the browser,
//      no element carried aria-current. Cause: the lists re-render (a loop
//      list on every loop SSE tick, Work's board on every backlog
//      event), and the fresh rows were born unmarked. The selection is now
//      remembered by type and id, and an item bound while it is the
//      selection is born marked, whichever list re-renders it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('R7: markSelected mirrors aria-current onto a bound li\'s inner button, and clears both', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem, markSelected } = await import('../../web/shared/interactive-item.js');
    const ul = document.createElement('ul'); document.body.appendChild(ul);
    const li = document.createElement('li'); li.textContent = 'row'; ul.appendChild(li);
    bindItem(li, { type: 'loop', id: 'a', link: '/now?sel=loop%3Aa', open() {}, label: 'Loop a' });
    const btn = li.querySelector('.item-btn');
    markSelected(li);
    assert.equal(li.getAttribute('aria-current'), 'true');
    assert.equal(btn.getAttribute('aria-current'), 'true', 'the focused element announces the selection');
    markSelected(null);
    assert.equal(li.getAttribute('aria-current'), null);
    assert.equal(btn.getAttribute('aria-current'), null);
  } finally { dom.restore(); }
});

test('R8: an item bound while it is the selection is born marked; a different item is not', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem, markSelected } = await import('../../web/shared/interactive-item.js');
    const mk = (id) => { const b = document.createElement('button'); document.body.appendChild(b); return bindItem(b, { type: 'card', id, link: `/work?sel=card%3A${id}`, open() {} }); };
    markSelected(mk('x'));
    const reborn = mk('x');
    assert.equal(reborn.getAttribute('aria-current'), 'true', 'a re-rendered selected item keeps the mark');
    assert.equal(mk('y').getAttribute('aria-current'), null);
    markSelected(null);
    assert.equal(mk('x').getAttribute('aria-current'), null, 'cleared selection: nothing is born marked');
  } finally { dom.restore(); }
});

test('R8 Work: a deep-linked card is marked, and stays marked after the board re-renders on a backlog event', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const now = Date.now();
  const item = { id: 'mc-7', project: 'glmps', title: 'Wire the globe', state: 'queued', source: 'manual', order: 1, devLog: [], activity: [], gate: null, createdAt: now, updatedAt: now };
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    if (u === '/api/backlog') return Response.json({ items: [item], gatelessDone: [] });
    if (u === '/api/qa-trends') return Response.json({ points: [] });
    return Response.json({});
  };
  window.vegaEmbed = async () => {};
  let handle;
  try {
    const lens = await import('../../web/work/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/work', '?sel=card%3Amc-7'), { getState: () => null, toast() {}, go() {}, handlers: {} });
    await tick();
    const card = () => root.querySelector('[data-item-id="mc-7"]');
    assert.equal(card().getAttribute('aria-current'), 'true', 'marked on restore');
    const before = card();
    handle.onEvent({ type: 'backlog' });
    await tick(60);
    assert.notEqual(card(), before, 'the board really re-rendered');
    assert.equal(card().getAttribute('aria-current'), 'true', 'still marked after the re-render');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});
