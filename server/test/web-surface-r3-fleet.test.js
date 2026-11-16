// UI round 3 (glmps-2-0-63) R3-4: the Fleet board on Surface has a horizontal
// separator on top: drag or arrow keys (24 px a step) between 120 px and 70% of
// the lens height, double-click resets to 222 px, remembered per viewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const KEY = 'mc.surface.fleet-height';
const MAX = Math.round(900 * 0.7);

async function withSurface(fn, { before = () => {}, storage = null } = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let m;
  try {
    if (storage) Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    before();
    m = await mountSurface('', surfaceFetch(), { getState: () => ({ tools: [], board: { rows: [] } }) });
    await tick(20);
    await fn(m);
  } finally {
    m?.handle?.unmount(); delete globalThis.fetch; delete window.d3;
    if (storage) { if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage; }
    dom.restore();
  }
}
const sepOf = (root) => root.querySelector('.fleet-sep');
const press = (sep, k) => { const e = new MiniEvent('keydown', { key: k }); sep.dispatchEvent(e); return e; };
const now = (sep) => Number(sep.getAttribute('aria-valuenow'));

test('R3-4: the separator is a focusable horizontal slider-style separator with its range', async () => {
  await withSurface(({ root }) => {
    const sep = sepOf(root);
    assert.equal(sep.getAttribute('role'), 'separator');
    assert.equal(sep.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(sep.getAttribute('tabindex'), '0');
    assert.ok(sep.getAttribute('aria-label'));
    assert.equal(sep.getAttribute('aria-valuemin'), '120');
    assert.equal(sep.getAttribute('aria-valuemax'), String(MAX));
    assert.equal(now(sep), 222);
    assert.equal(root.querySelector('.surface-fleet').childNodes.filter((n) => n.nodeType === 1)[0], sep, 'it sits on top of the board');
  });
});

test('R3-4: ArrowUp grows and ArrowDown shrinks by 24 px, Home and End go to the limits', async () => {
  await withSurface(({ root }) => {
    const sep = sepOf(root); const dock = root.querySelector('.surface-fleet');
    assert.equal(press(sep, 'ArrowUp').defaultPrevented, true);
    assert.equal(now(sep), 246);
    assert.equal(dock.style.getPropertyValue?.('--fleet-h') ?? dock.style['--fleet-h'], '246px');
    press(sep, 'ArrowDown'); press(sep, 'ArrowDown');
    assert.equal(now(sep), 198);
    press(sep, 'Home'); assert.equal(now(sep), 120);
    press(sep, 'ArrowDown'); assert.equal(now(sep), 120, 'never below the floor');
    press(sep, 'End'); assert.equal(now(sep), MAX);
    press(sep, 'ArrowUp'); assert.equal(now(sep), MAX, 'never above 70% of the lens');
    assert.equal(press(sep, 'a').defaultPrevented, false, 'other keys are left alone');
  });
});

test('R3-4: double-click resets to 222 px', async () => {
  await withSurface(({ root }) => {
    const sep = sepOf(root);
    press(sep, 'End');
    sep.dispatchEvent(new MiniEvent('dblclick'));
    assert.equal(now(sep), 222);
  });
});

test('R3-4: a pointer drag moves the edge with pointer capture, upward grows', async () => {
  await withSurface(({ root }) => {
    const sep = sepOf(root);
    const captured = [];
    sep.setPointerCapture = (id) => captured.push(id);
    sep.releasePointerCapture = () => captured.push('released');
    sep.dispatchEvent(new MiniEvent('pointerdown', { pointerId: 7, clientY: 600, button: 0 }));
    sep.dispatchEvent(new MiniEvent('pointermove', { pointerId: 7, clientY: 540 }));
    assert.equal(now(sep), 282);
    sep.dispatchEvent(new MiniEvent('pointermove', { pointerId: 7, clientY: 900 }));
    assert.equal(now(sep), 120, 'dragging down past the floor stops at it');
    sep.dispatchEvent(new MiniEvent('pointerup', { pointerId: 7, clientY: 900 }));
    assert.deepEqual(captured, [7, 'released']);
    sep.dispatchEvent(new MiniEvent('pointermove', { pointerId: 7, clientY: 100 }));
    assert.equal(now(sep), 120, 'a move after release does nothing');
  });
});

test('R3-4: the height is remembered per viewer and a stored value is read back', async () => {
  await withSurface(({ root }) => {
    press(sepOf(root), 'ArrowUp');
    assert.equal(localStorage.getItem(KEY), '246');
    sepOf(root).dispatchEvent(new MiniEvent('dblclick'));
    assert.equal(localStorage.getItem(KEY), null, 'reset forgets the choice');
  });
  await withSurface(({ root }) => {
    assert.equal(now(sepOf(root)), 300);
  }, { before: () => localStorage.setItem(KEY, '300') });
  await withSurface(({ root }) => {
    assert.equal(now(sepOf(root)), MAX, 'a stored value past the limit is clamped');
  }, { before: () => localStorage.setItem(KEY, '5000') });
  await withSurface(({ root }) => {
    assert.equal(now(sepOf(root)), 222, 'nonsense is ignored');
  }, { before: () => localStorage.setItem(KEY, 'wide') });
});

test('R3-4: it still works when storage throws', async () => {
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  await withSurface(({ root }) => {
    const sep = sepOf(root);
    assert.equal(now(sep), 222);
    press(sep, 'ArrowUp');
    assert.equal(now(sep), 246);
    sep.dispatchEvent(new MiniEvent('dblclick'));
    assert.equal(now(sep), 222);
  }, { storage: boom });
});

test('R3-4: a closed Fleet board hides the separator', async () => {
  await withSurface(({ root }) => {
    assert.equal(sepOf(root).hidden, true);
  }, { before: () => localStorage.setItem('surface.fleet', 'closed') });
});
