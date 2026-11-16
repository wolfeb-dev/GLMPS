// R2 (glmps-2-0-63) AC-3: labels on the globe do not overlap. In a browser the
// pass measures the real label boxes; without a layout engine it estimates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';
import { declutterLabels } from '../../web/surface/globe.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeLabel({ layer, id, type = 'repo', at = [0, 0], text = 'label', rect = null, display = null }) {
  const attrs = new Map(display ? [['display', display]] : []);
  const mark = {
    dataset: { itemType: type, itemId: id },
    classList: { contains: () => false },
    getAttribute: (k) => (k === 'transform' ? `translate(${at[0]},${at[1]})` : null),
    closest: () => ({ getAttribute: (k) => (k === 'data-layer' ? layer : null) }),
  };
  const lbl = {
    parentNode: mark, textContent: text,
    getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k),
    getAttributeNames: () => [...attrs.keys()],
  };
  if (rect) { lbl.getBBox = () => ({ x: 0, y: 0, width: rect.width, height: rect.height }); lbl.getBoundingClientRect = () => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height, right: rect.x + rect.width, bottom: rect.y + rect.height }); }
  return lbl;
}
const svgOf = (labels) => ({ querySelectorAll: (s) => (s === '.lbl' ? labels : []) });
const hidden = (l) => l.getAttribute('display') === 'none';

test('AC-3 (labels): measured boxes decide: the lower-priority label of two that really overlap is hidden', () => {
  // Far apart by the 6.5 px per character estimate, but their real boxes collide.
  const players = fakeLabel({ layer: 'players', id: 'local', type: 'player', at: [100, 100], rect: { x: 130, y: 90, width: 120, height: 40 } });
  const dirty = fakeLabel({ layer: 'residency', id: 'repo-a', at: [400, 400], rect: { x: 200, y: 100, width: 150, height: 14 } });
  const clear = fakeLabel({ layer: 'residency', id: 'repo-b', at: [100, 300], rect: { x: 20, y: 300, width: 100, height: 14 } });
  declutterLabels(svgOf([dirty, clear, players]));
  assert.equal(hidden(players), false, 'the platform name keeps its label');
  assert.equal(hidden(dirty), true, 'the repository label that sits on it goes');
  assert.equal(hidden(clear), false, 'a label that overlaps nothing stays');
});

test('AC-3 (labels): agents, cards and loops rank below the platforms and repositories', () => {
  const repo = fakeLabel({ layer: 'residency', id: 'r', rect: { x: 0, y: 0, width: 80, height: 14 } });
  const agent = fakeLabel({ layer: 'agents', id: 'a', type: 'agent', rect: { x: 10, y: 4, width: 80, height: 14 } });
  declutterLabels(svgOf([agent, repo]));
  assert.equal(hidden(repo), false);
  assert.equal(hidden(agent), true);
});

test('AC-3 (labels): a label hidden earlier comes back once nothing overlaps it', () => {
  const a = fakeLabel({ layer: 'players', id: 'p', type: 'player', rect: { x: 0, y: 0, width: 80, height: 14 } });
  const b = fakeLabel({ layer: 'residency', id: 'r', rect: { x: 10, y: 4, width: 80, height: 14 } });
  declutterLabels(svgOf([a, b]));
  assert.equal(hidden(b), true);
  b.getBoundingClientRect = () => ({ left: 500, top: 500, width: 80, height: 14, right: 580, bottom: 514 });
  declutterLabels(svgOf([a, b]));
  assert.equal(hidden(b), false);
});

test('AC-3 (labels): with no layout engine the estimate still hides a label that sits on another', () => {
  const a = fakeLabel({ layer: 'players', id: 'p', type: 'player', at: [100, 100], text: 'Local store' });
  const b = fakeLabel({ layer: 'agents', id: 'a', type: 'agent', at: [100, 100], text: 'an agent label' });
  declutterLabels(svgOf([b, a]));
  assert.equal(hidden(b), true);
});

test('AC-3: the presets bar offers Loops and Alerts between Kanban and GitHub', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let m;
  try {
    m = await mountSurface('', surfaceFetch());
    await tick(10);
    const names = m.root.querySelector('.surface-presets').querySelectorAll('button').map((b) => b.textContent);
    assert.deepEqual(names, ['Players', 'Local store', 'File tree', 'Agents', 'Kanban', 'Loops', 'Alerts', 'GitHub', 'Global']);
    const btn = (t) => m.root.querySelector('.surface-presets').querySelectorAll('button').find((b) => b.textContent === t);
    btn('Loops').click(); await tick(10);
    assert.equal(m.root.querySelector('#layer-loops').checked, true, 'the preset shows what it flies to');
    assert.equal(btn('Loops').getAttribute('aria-pressed'), 'true');
    btn('Alerts').click(); await tick(10);
    assert.equal(m.root.querySelector('#layer-alerts').checked, true);
  } finally { m?.handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});
