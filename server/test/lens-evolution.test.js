// server/test/lens-evolution.test.js
// Card glmps-2-0-runtime-137 phase 3 (AC-4): Evolution has Capabilities (the
// six-kind registry with the file view), Impact ledger, Experiments and Loops.
// Memory and Signals are gone, Alerts live on Surface, the North-Star trend
// shows only with data, and the loop-liveness grid is not drawn here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { LEARNING_ROUTES } from './fixtures/learning-routes.js';
import { waitFor } from './helpers/wait-for.js';

const METRICS = { ts: 1, windowDays: 30, metrics: [] };
const PERSONALITY = {
  groups: [
    { id: 'machine', name: 'Machine', sub: 's', order: 'o', cards: [{ id: 'user-claude-md', name: 'User CLAUDE.md', controls: 'Reads first', usedBy: [], usedByGraphs: [], path: '/u/CLAUDE.md', mtime: 1000 }] },
    { id: 'runtime', name: 'Runtime', sub: 's', order: 'o', cards: [{ id: 'prompt', name: 'Card prompt template', controls: 'Starts a card', usedBy: [], usedByGraphs: [], path: '/x', mtime: 2000 }] },
  ],
};
const LOOPS = { generatedAt: 1, loops: [], graphs: [] };

function routes({ liveness, northStar = null } = {}) {
  const base = structuredClone(LEARNING_ROUTES);
  base['/api/changes'] = {
    ...base['/api/changes'],
    scoreboard: { tracked: 3, netPositive: 1, revertedNoHelp: 0, unmeasured: 1, northStar },
    liveness: liveness ?? { guard: { ageDays: 2, stale: false } },
  };
  return { ...base, '/api/personality': PERSONALITY, '/api/loops/catalog': LOOPS };
}

async function mountEvolution(search = '', r = routes(), calls = []) {
  const dom = installMiniDom({ pathname: '/learning', search });
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u.split('?')[0]);
    if (u.startsWith('/api/learning/outcome-metrics')) return Response.json(METRICS);
    const hit = Object.entries(r).find(([k]) => u.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  };
  const lens = await import('../../web/learning/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const ctx = { getState: () => null, toast: () => {}, go: () => {}, handlers: {} };
  const handle = await lens.mount(root, parseLink('/learning', search), ctx);
  return { root, handle, calls, done: () => { handle?.unmount(); delete globalThis.fetch; dom.restore(); } };
}
const tabs = (root) => root.querySelectorAll('[role="tab"]');
const selected = (root) => tabs(root).find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

test('Evolution has four tabs, in order, and opens on Capabilities', async () => {
  const m = await mountEvolution();
  try {
    assert.deepEqual(tabs(m.root).map((t) => t.textContent), ['Capabilities', 'Impact ledger', 'Experiments', 'Loops']);
    assert.equal(selected(m.root), 'Capabilities');
    assert.equal(m.root.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Evolution sections');
  } finally { m.done(); }
});

test('tabFor sends every old band, seg and tab name to a surviving tab', async () => {
  const { tabFor } = await import('../../web/learning/lens.js');
  assert.equal(tabFor({ tab: 'experiments' }), 'experiments');
  assert.equal(tabFor({ tab: 'memory' }), 'capabilities');
  assert.equal(tabFor({ seg: 'memory' }), 'capabilities');
  assert.equal(tabFor({ tab: 'signals' }), 'ledger');
  assert.equal(tabFor({ seg: 'signals' }), 'ledger');
  assert.equal(tabFor({ band: 'loop' }), 'ledger');
  assert.equal(tabFor({ band: 'loop', seg: 'outcomes' }), 'experiments');
  assert.equal(tabFor({ seg: 'outcomes' }), 'experiments');
  assert.equal(tabFor({ band: 'registry' }), 'capabilities');
  assert.equal(tabFor({ band: 'signals' }), 'ledger');
  assert.equal(tabFor({ band: 'memory' }), 'capabilities');
  assert.equal(tabFor({ tab: 'registry' }), 'capabilities');
  assert.equal(tabFor({ seg: 'files' }), 'capabilities');
  assert.equal(tabFor({ sel: { type: 'guard', id: 'x' } }), 'ledger');
  assert.equal(tabFor({ sel: { type: 'loop', id: 'x' } }), 'loops');
  assert.equal(tabFor({ sel: { type: 'capability', id: 'x' } }), 'capabilities');
  assert.equal(tabFor({}), null);
});

test('Capabilities draws one registry under six kinds, and keeps the Push action', async () => {
  const m = await mountEvolution();
  try {
    await waitFor(() => m.root.querySelector('.rg-row'), { message: 'registry rows' });
    const labels = m.root.querySelector('.rg-summary').querySelectorAll('.an-stat-label').map((n) => n.textContent);
    assert.deepEqual(labels, ['Instructions', 'Guards', 'Skills', 'Agents', 'Memory and lessons', 'Harness code']);
    const chips = m.root.querySelectorAll('.rg-filter-chip').map((c) => c.textContent);
    for (const k of labels) assert.ok(chips.includes(k), `a ${k} filter chip`);
    const rowText = m.root.querySelectorAll('.rg-row').map((r) => r.textContent).join('|');
    assert.match(rowText, /User CLAUDE\.md/, 'instruction files are registry rows');
    assert.match(rowText, /Card prompt template/, 'harness code is a registry row');
    assert.match(m.root.textContent, /Push approved facts to agents/);
  } finally { m.done(); }
});

test('the file view hosts the instruction file cards and the lesson ledger', async () => {
  const m = await mountEvolution('?tab=capabilities&seg=files');
  try {
    await waitFor(() => m.root.querySelector('.pers-card'), { message: 'file preview cards' });
    const files = m.root.querySelectorAll('.learn-capview-body').find((b) => !b.hidden);
    assert.match(files.textContent, /Card prompt template/);
    await waitFor(() => /Lesson ledger/.test(files.textContent), { message: 'the lesson ledger in the file view' });
  } finally { m.done(); }
});

test('Memory and Signals tabs, the Alerts feed and the experiments disclosure are gone', async () => {
  const calls = [];
  const m = await mountEvolution('', routes(), calls);
  try {
    const open = async (name, ready) => { tabs(m.root).find((t) => t.textContent === name).click(); await waitFor(() => ready() && !m.root.textContent.includes('Loading'), { message: name }); };
    await open('Impact ledger', () => m.root.querySelector('.sl-kinds'));
    await open('Experiments', () => m.root.querySelector('#lt-panel-experiments')?.querySelector('.sl-seed-bar'));
    await open('Loops', () => m.root.querySelector('.lp-summary'));
    assert.ok(!tabs(m.root).some((t) => /Memory|Signals|Alerts|^Ledger$/.test(t.textContent)));
    assert.ok(!calls.includes('/api/alerts'), 'alerts are fetched by Surface only');
    assert.equal(m.root.querySelector('details.learn-experiments'), null);
    assert.equal(m.root.querySelector('.learn-signals-alerts'), null);
  } finally { m.done(); }
});

test('Experiments is a full tab that loads on first use', async () => {
  const m = await mountEvolution();
  try {
    assert.equal(m.root.querySelector('.sl-seed-bar'), null, 'not loaded before the tab opens');
    tabs(m.root).find((t) => t.textContent === 'Experiments').click();
    await waitFor(() => m.root.querySelector('#lt-panel-experiments')?.querySelector('.sl-seed-bar') && !m.root.textContent.includes('Loading'), { message: 'experiments content' });
    assert.equal(m.root.querySelector('#lt-panel-experiments').hidden, false);
  } finally { m.done(); }
});

test('Impact ledger: no loop-liveness grid, and no North-Star placeholder without buckets', async () => {
  const m = await mountEvolution('?tab=ledger');
  try {
    await waitFor(() => m.root.querySelector('.sl-kinds'), { message: 'the ledger' });
    assert.equal(m.root.querySelector('.sl-liveness-row'), null);
    assert.equal(m.root.querySelector('.sl-liveness-tile'), null);
    assert.doesNotMatch(m.root.textContent, /North-Star/);
    assert.ok(m.root.querySelector('.sl-kpi--regression'), 'the loop metrics stay');
  } finally { m.done(); }
});

test('Impact ledger: the North-Star trend renders when it has buckets', async () => {
  const northStar = { buckets: [{ label: 'week 1', value: 0.4 }, { label: 'week 2', value: 0.5 }] };
  const m = await mountEvolution('?tab=ledger', routes({ northStar }));
  try {
    await waitFor(() => m.root.querySelector('.sl-kinds'), { message: 'the ledger' });
    assert.match(m.root.textContent, /North-Star trend/);
    assert.match(m.root.textContent, /week 2/);
  } finally { m.done(); }
});

test('old links land on the matching tab', async () => {
  const cases = [
    ['?band=loop&seg=outcomes', 'Experiments'],
    ['?tab=signals', 'Impact ledger'],
    ['?tab=memory', 'Capabilities'],
    ['?band=registry', 'Capabilities'],
    // Card glmps-2-0-runtime-139 finding 1: the pre-redesign tab strip wrote
    // its tabs as band=<id>.
    ['?band=signals', 'Impact ledger'],
    ['?band=memory', 'Capabilities'],
    ['?band=ledger', 'Impact ledger'],
    ['?tab=loops', 'Loops'],
  ];
  for (const [search, want] of cases) {
    const m = await mountEvolution(search);
    try { assert.equal(selected(m.root), want, search); } finally { m.done(); }
  }
});

test('choosing a tab records it as a deep link', async () => {
  const links = [];
  const onLink = (e) => links.push(e.detail.link);
  const m = await mountEvolution();
  window.addEventListener('mc-link', onLink);
  try {
    tabs(m.root).find((t) => t.textContent === 'Experiments').click();
    assert.ok(links.includes('/learning?tab=experiments'), `saw ${links}`);
    await waitFor(() => m.root.querySelector('#lt-panel-experiments')?.querySelector('.sl-seed-bar') && !m.root.textContent.includes('Loading'), { message: 'experiments to settle' });
  } finally { window.removeEventListener('mc-link', onLink); m.done(); }
});
