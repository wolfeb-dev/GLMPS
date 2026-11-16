// Routes under test: server/lib/routes/lessons-routes.js
// server/test/web-learning-q3.test.js
// Phase 2, Q3 (AC-3, AC-4, AC-5): Learning as outcome tiles plus one tab
// strip, a paged ledger, and honest metric wording. Card glmps-2-0-137 phase 1
// renames the page Evolution, Registry to Capabilities, and adds the Loops tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { LEARNING_ROUTES } from './fixtures/learning-routes.js';
import { tabFor, TABS } from '../../web/learning/lens.js';
import { regressionWording, LEDGER_PAGE_SIZE } from '../../web/evaluation/substrate-loop.js';
import { formatMetric } from '../../web/learning/outcome-metrics.js';
import { waitFor } from './helpers/wait-for.js';

const METRICS = {
  ts: 1, windowDays: 30,
  metrics: [
    { id: 'first-pass-ci', label: 'First-pass CI success', unit: 'ratio', value: { value: 0.5, evidence: 'measured', n: 2 }, basis: 'b', refs: [{ kind: 'ci-run', id: 3, value: 'success' }] },
    { id: 'merged-first-pass', label: 'Merged first pass', unit: 'ratio', value: { value: null, evidence: 'absent', n: 0, reason: 'no gated-done card with a first-try outcome in the window' }, basis: 'b', refs: [] },
  ],
};

test('AC-3: tabFor maps tab ids, old Loop/Registry bands, outcomes and selections to a tab', () => {
  assert.equal(tabFor({ seg: 'memory' }), 'capabilities');
  assert.equal(tabFor({ band: 'research' }), null);
  assert.equal(tabFor({ band: 'loop' }), 'ledger');
  assert.equal(tabFor({ band: 'registry' }), 'capabilities');
  assert.equal(tabFor({ tab: 'loops' }), 'loops');
  assert.equal(tabFor({ sel: { type: 'loop', id: 'x' } }), 'loops');
  assert.equal(tabFor({ band: 'loop', seg: 'outcomes' }), 'experiments');
  assert.equal(tabFor({ sel: { type: 'guard', id: 'x' } }), 'ledger');
  assert.equal(tabFor({ sel: { type: 'capability', id: 'x' } }), 'capabilities');
  assert.equal(tabFor({ sel: { type: 'metric', id: 'x' } }), null);
  assert.equal(tabFor({}), null);
  assert.deepEqual(TABS.map((t) => t.label), ['Capabilities', 'Impact ledger', 'Experiments', 'Loops']);
});

test('AC-4: the regression tile states counts and never a percentage', () => {
  assert.equal(regressionWording({ reverted: 8, adopted: 2, rate: 4, band: 'high' }), '8 regressions against 2 adoptions');
  assert.equal(regressionWording({ reverted: 1, adopted: 1 }), '1 regression against 1 adoption');
  assert.doesNotMatch(regressionWording({ reverted: 8, adopted: 2, rate: 4 }), /%/);
});

test('AC-3: an unmeasurable metric says "not yet measurable" and why', () => {
  const f = formatMetric(METRICS.metrics[1]);
  assert.equal(f.valueText, 'not yet measurable');
  assert.match(f.evidenceText, /^not yet measurable: no gated-done card/);
});

function bigRoutes() {
  const changes = [];
  for (let i = 0; i < 489; i++) changes.push({ id: `guard-${i}`, type: 'guard', title: `rule-${i % 40}`, status: i % 3 ? 'proposed' : 'measuring', ts: 1e12 + i, evidence: { sessionId: `s${i}` }, measuredEffect: null });
  for (let i = 0; i < 50; i++) changes.push({ id: `promo-${i}`, type: 'promotion', title: `promo ${i}`, status: 'kept', ts: 1e12 + 1000 + i, measuredEffect: null });
  for (let i = 0; i < 416; i++) changes.push({ id: `rc-${i}`, type: 'research-candidate', title: `candidate ${i}`, status: 'proposed', ts: 1e12 + 2000 + i, measuredEffect: null });
  const items = [];
  for (let i = 0; i < 489; i++) items.push({ id: `g${i}`, code: `c${i}`, status: 'pending', title: `Guard ${i}`, body: 'b', project: 'p', sessionId: 's', updatedTs: 1e12, createdTs: 1e12, proposedGuard: null });
  return {
    ...LEARNING_ROUTES,
    '/api/changes': {
      changes,
      scoreboard: { tracked: 1, northStar: null },
      loopMetrics: {
        acceptance: { accepted: 3, proposed: 405, rate: 0.0074 },
        regression: { reverted: 8, adopted: 3, rate: 2.67, band: 'high' },
        guardHits: { count: 0 }, lifecycle: { adopted: 3, deprecated: 6, retired: 8 },
      },
      liveness: {},
    },
    '/api/learning': { items, config: {} },
  };
}

function stubFetch(routes, calls) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls?.push(u.split('?')[0]);
    if (u.startsWith('/api/learning/outcome-metrics')) return Response.json(METRICS);
    const hit = Object.entries(routes).find(([k]) => u.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  };
}

const ctx = { getState: () => null, toast: () => {}, go: () => {}, handlers: {} };
// A lazy tab is loaded once no panel still says it is loading.
const loaded = (root) => waitFor(() => !root.textContent.includes('Loading '), { message: 'the tab to finish loading' });
function countNodes(n) { let c = 1; for (const k of n.childNodes ?? []) c += countNodes(k); return c; }

async function mountLearning(search = '', routes = bigRoutes(), calls) {
  stubFetch(routes, calls);
  const lens = await import('../../web/learning/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const handle = await lens.mount(root, parseLink('/learning', search), ctx);
  return { root, handle };
}

test('AC-3: one tablist replaces the stacked bands; no Loop or Outcomes heading', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning(); handle = m.handle;
    const tabs = m.root.querySelectorAll('[role="tab"]');
    assert.deepEqual(tabs.map((t) => t.textContent), ['Capabilities', 'Impact ledger', 'Experiments', 'Loops']);
    assert.equal(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length, 1);
    assert.equal(m.root.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Evolution sections');
    const headings = m.root.querySelectorAll('h2').map((h) => h.textContent);
    for (const gone of ['Loop', 'Outcomes', 'Registry', 'Signals']) assert.ok(!headings.includes(gone), `no "${gone}" band heading`);
    assert.equal(headings[0], 'Evolution');
    for (const t of tabs) assert.ok(m.root.querySelector(`#${t.getAttribute('aria-controls')}`), 'every tab controls a tabpanel');
    // the outcome tiles lead the page
    assert.ok(m.root.querySelector('.om-row'));
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: outcome tiles lead with an honest empty state', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning(); handle = m.handle;
    const absent = m.root.querySelector('[data-item-id="merged-first-pass"]');
    assert.equal(absent.querySelector('.om-value').textContent, 'not yet measurable');
    assert.match(absent.querySelector('.om-tag').textContent, /^no gated-done card with a first-try outcome in the window, n = 0/);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: tabs are keyboard operable (arrows wrap, Home and End) and the selected tab goes in the URL', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const links = [];
  const onLink = (e) => links.push(e.detail.link);
  window.addEventListener('mc-link', onLink);
  let handle;
  try {
    const m = await mountLearning(); handle = m.handle;
    const strip = m.root.querySelector('[role="tablist"]');
    const key = async (k) => { strip.dispatchEvent(new KeyboardEvent('keydown', { key: k })); await loaded(m.root); };
    const selected = () => m.root.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true').textContent;
    assert.equal(selected(), 'Capabilities');
    await key('ArrowRight');
    assert.equal(selected(), 'Impact ledger');
    await key('End');
    assert.equal(selected(), 'Loops');
    await key('ArrowRight');
    assert.equal(selected(), 'Capabilities', 'arrow right wraps');
    await key('ArrowLeft');
    assert.equal(selected(), 'Loops', 'arrow left wraps');
    await key('Home');
    assert.equal(selected(), 'Capabilities');
    assert.ok(links.includes('/learning?tab=ledger'), `the tab is recorded as a deep link, saw ${links}`);
    const tabs = m.root.querySelectorAll('[role="tab"]');
    assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1, -1], 'roving tabindex: only the selected tab is in the tab order');
    assert.equal(m.root.querySelectorAll('[role="tabpanel"]').filter((p) => !p.hidden).length, 1);
  } finally { window.removeEventListener('mc-link', onLink); handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: a tab loads on first use only (experiments are not fetched until their tab opens)', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const calls = [];
  let handle;
  try {
    const m = await mountLearning('', bigRoutes(), calls); handle = m.handle;
    assert.ok(calls.includes('/api/lessons'), 'Capabilities, the opening tab, loads the registry');
    assert.ok(!calls.includes('/api/alerts'), 'alerts are not part of Evolution');
    assert.ok(!calls.includes('/api/outcomes'), 'experiments untouched on the Capabilities tab');
    m.root.querySelector('#lt-tab-experiments').click();
    await waitFor(() => calls.includes('/api/outcomes') && !m.root.textContent.includes('Loading'), { message: 'the experiments tab' });
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: old links land on the right tab (band=loop, band=registry, seg=outcomes)', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning('?band=registry'); handle = m.handle;
    const sel = () => m.root.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true').textContent;
    assert.equal(sel(), 'Capabilities');
    await handle.update(parseLink('/learning', '?band=loop'));
    assert.equal(sel(), 'Impact ledger');
    await handle.update(parseLink('/learning', '?band=loop&seg=outcomes'));
    assert.equal(sel(), 'Experiments');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: the ledger pages at 50 rows and kind chips filter the whole set with their counts', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning('?tab=ledger'); handle = m.handle;
    assert.equal(LEDGER_PAGE_SIZE, 50);
    const rows = () => m.root.querySelectorAll('.sl-row');
    assert.equal(rows().length, 50);
    const chips = m.root.querySelectorAll('.sl-chip-toggle');
    const kindRow = Object.fromEntries(m.root.querySelectorAll('.sl-kind-row').map((r) => [r.dataset.loop, r]));
    assert.equal(kindRow.promotion.querySelector('.sl-kind-count').textContent, '50');
    assert.equal(kindRow['research-candidate'].querySelector('.sl-kind-count').textContent, '416');
    assert.match(kindRow.guard.querySelector('.sl-kind-rules').textContent, /in 40 rules/, 'guard changes collapse to one row per rule');
    m.root.querySelectorAll('.sl-pager-btn')[1].click();
    assert.match(m.root.querySelector('.sl-pager-info').textContent, /^Showing 51-100 of /);
    assert.equal(rows().length, 50);
    chips.find((c) => c.textContent.startsWith('Promotion')).click();
    assert.equal(chips.find((c) => c.textContent.startsWith('Promotion')).getAttribute('aria-pressed'), 'true');
    assert.equal(rows().length, 50, 'promotion has exactly 50, one page');
    assert.match(m.root.querySelector('.sl-pager-info').textContent, /^Showing 1-50 of 50$/);
    assert.ok(m.root.querySelectorAll('.sl-pager-btn').every((b) => b.hidden), 'one page needs no pager buttons');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-4: the loop regression tile reads in counts with the target stated, no rate', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning('?tab=ledger'); handle = m.handle;
    const tile = m.root.querySelector('.sl-kpi--regression');
    assert.match(tile.textContent, /8 regressions against 3 adoptions/);
    assert.match(tile.textContent, /target: at most 1 revert per 5 adoptions/);
    assert.doesNotMatch(tile.textContent, /\d%/);
    assert.doesNotMatch(tile.textContent, /267|2\.67/);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: the header offers "Review N proposals" with the live pending count and opens the filtered registry', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning(); handle = m.handle;
    const btn = m.root.querySelector('.learn-review');
    assert.equal(btn.textContent, 'Review 489 proposals');
    btn.click();
    await waitFor(() => m.root.querySelector('.rg-filter-chip'), { message: 'the filtered registry' });
    const sel = m.root.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true').textContent;
    assert.equal(sel, 'Capabilities');
    const pressed = m.root.querySelectorAll('.rg-filter-chip').filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.textContent);
    assert.ok(pressed.includes('Guard') || pressed.some((t) => /guard/i.test(t)), `a guard kind chip is active, saw ${pressed}`);
    assert.ok(!pressed.includes('Skill'), 'other kinds are filtered out');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-3: no review action when nothing is pending', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning('', { ...bigRoutes(), '/api/learning': { items: [], config: {} } }); handle = m.handle;
    assert.equal(m.root.querySelector('.learn-review'), null);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-5: Learning stays under 4,000 DOM nodes on live-size data, registry and ledger tabs both open', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    const m = await mountLearning(); handle = m.handle;
    await waitFor(() => m.root.querySelector('.rg-row'), { message: 'the registry rows' });
    const registryOnly = countNodes(m.root);
    assert.ok(registryOnly < 4000, `the registry tab renders ${registryOnly} nodes`);
    m.root.querySelector('#lt-tab-ledger').click();
    await waitFor(() => m.root.querySelector('.sl-row'), { message: 'the ledger rows' });
    const withLedger = countNodes(m.root);
    assert.ok(withLedger < 4000, `registry + ledger tabs render ${withLedger} nodes`);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('a guard deep link reaches an instance inside a rule group on a later ledger page', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  try {
    // guard-0 sits in rule-0 (oldest, so on the last page, inside a collapsed group)
    const m = await mountLearning('?tab=ledger&sel=guard%3Aguard-0'); handle = m.handle;
    assert.equal(m.root.querySelector('.band-empty'), null, 'no not-found notice');
    const inst = m.root.querySelector('[data-item-id="guard-0"]');
    assert.ok(inst, 'the instance row was built');
    assert.equal(inst.parentNode.parentNode.hidden, false, 'its rule group was opened');
    assert.match(m.root.querySelector('.sl-pager-info').textContent, /of \d+$/);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});
