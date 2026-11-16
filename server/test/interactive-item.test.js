// server/test/interactive-item.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';

test('bindItem wires click, keyboard, deep link and mc-link', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem, collectItems } = await import('../../web/shared/interactive-item.js');
    const root = document.createElement('div');
    const row = document.createElement('div');
    root.appendChild(row);
    const opened = [];
    const links = [];
    window.addEventListener('mc-link', (e) => links.push(e.detail.link));
    bindItem(row, { type: 'card', id: 'mc-1', link: '/work?sel=card%3Amc-1', open: () => opened.push('mc-1'), label: 'Open card mc-1' });
    assert.equal(row.dataset.itemType, 'card');
    assert.equal(row.dataset.itemId, 'mc-1');
    assert.equal(row.dataset.link, '/work?sel=card%3Amc-1');
    assert.equal(row.getAttribute('role'), 'button');
    assert.equal(row.getAttribute('tabindex'), '0');
    assert.ok(row.listenerCount('click') >= 1);
    row.click();
    row.dispatchEvent(new MiniEvent('keydown', { key: 'Enter' }));
    assert.deepEqual(opened, ['mc-1', 'mc-1']);
    assert.deepEqual(links, ['/work?sel=card%3Amc-1', '/work?sel=card%3Amc-1']);
    row.dispatchEvent(new MiniEvent('click', { ctrlKey: true }));
    assert.equal(opened.length, 2, 'ctrl-click opens a new tab instead');
    assert.deepEqual(window.opened.at(-1), ['/work?sel=card%3Amc-1', '_blank']);
    assert.deepEqual(collectItems(root), [row]);
  } finally { dom.restore(); }
});

test('bindItem refuses an item with no deep link or no handler', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem } = await import('../../web/shared/interactive-item.js');
    const el = document.createElement('div');
    assert.throws(() => bindItem(el, { type: 'card', id: 'x', open: () => {} }), /link/);
    assert.throws(() => bindItem(el, { type: 'card', id: 'x', link: '/work' }), /open/);
    assert.throws(() => bindItem(el, { id: 'x', link: '/work', open: () => {} }), /type/);
  } finally { dom.restore(); }
});

test('openSelection activates the matching item or reports it missing', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem, openSelection } = await import('../../web/shared/interactive-item.js');
    const root = document.createElement('div');
    const a = document.createElement('div'); root.appendChild(a);
    let opened = 0;
    bindItem(a, { type: 'loop', id: 'wiki', link: '/now?sel=loop%3Awiki', open: () => { opened++; } });
    assert.equal(openSelection(root, { type: 'loop', id: 'wiki' }), true);
    assert.equal(opened, 1);
    const missing = [];
    assert.equal(openSelection(root, { type: 'loop', id: 'gone' }, { onMissing: (s) => missing.push(s.id) }), false);
    assert.deepEqual(missing, ['gone']);
    assert.equal(openSelection(root, null), false);
  } finally { dom.restore(); }
});

test('a button keeps its own semantics', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem } = await import('../../web/shared/interactive-item.js');
    const b = document.createElement('button');
    bindItem(b, { type: 'layer', id: 'residency', link: '/surface', open: () => {} });
    assert.equal(b.getAttribute('role'), null);
    assert.equal(b.listenerCount('click'), 1);
  } finally { dom.restore(); }
});

// role=button on an <li> inside a <ul> breaks the list
// structure (a list may only own listitems). A bound <li> stays a listitem;
// its content moves into an inner <button> that carries the name and the
// keyboard focus, and the click still reaches the item.
test('W-M6: a bound <li> keeps listitem semantics with an inner button', async () => {
  const dom = installMiniDom();
  try {
    const { bindItem, collectItems } = await import('../../web/shared/interactive-item.js');
    const ul = document.createElement('ul');
    const li = document.createElement('li'); li.className = 'loop-row';
    const code = document.createElement('code'); code.textContent = 'wiki'; li.appendChild(code);
    li.appendChild(document.createTextNode(' failing 3 in a row'));
    ul.appendChild(li);
    const opened = [];
    bindItem(li, { type: 'loop', id: 'wiki', link: '/now?sel=loop%3Awiki', open: () => opened.push('wiki'), label: 'Loop wiki: failing' });
    assert.equal(li.getAttribute('role'), null, 'the li keeps its implicit listitem role');
    assert.equal(li.getAttribute('tabindex'), null);
    assert.equal(li.children.length, 1);
    const btn = li.children[0];
    assert.equal(btn.tagName, 'BUTTON');
    assert.equal(btn.type, 'button');
    assert.equal(btn.className, 'item-btn');
    assert.equal(btn.getAttribute('aria-label'), 'Loop wiki: failing');
    assert.equal(btn.textContent, 'wiki failing 3 in a row', 'the row content moved into the button');
    btn.click();
    assert.deepEqual(opened, ['wiki'], 'a click on the button activates the item');
    assert.deepEqual(collectItems(ul), [li], 'the li is still the item (deep link, selection mark)');
    li.click();
    assert.deepEqual(opened, ['wiki', 'wiki'], 'openSelection clicking the li still opens it');
  } finally { dom.restore(); }
});
