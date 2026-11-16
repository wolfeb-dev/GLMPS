// server/test/lens-learning-items.test.js
// Acceptance (program plan section 4): the Learning lens lists its interactive
// item types, and every rendered item of every type has a click handler and a
// deep link that parses back to a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink, LENSES } from '../../web/shared/deep-link.js';
import { waitFor } from './helpers/wait-for.js';

const METRICS = {
  ts: 1, windowDays: 30,
  metrics: [
    { id: 'first-pass-ci', label: 'First-pass CI success of agent-written changes', unit: 'ratio', value: { value: 0.5, evidence: 'measured', n: 2 }, basis: 'b', refs: [{ kind: 'ci-run', id: 3, value: 'success' }] },
    { id: 'merged-first-pass', label: 'Merged from the first implementation pass', unit: 'ratio', value: { value: null, evidence: 'absent', n: 0, reason: 'no gated-done card' }, basis: 'b', refs: [] },
    { id: 'time-to-first-review', label: 'Time to first review', unit: 'minutes', value: { value: 25, evidence: 'measured', n: 2 }, basis: 'b', refs: [{ kind: 'card', id: 'mc-1', value: 20 }] },
    { id: 'breach-to-card', label: 'Time from breach to filed card', unit: 'minutes', value: { value: 10, evidence: 'constant', n: 12, reason: 'zero variance' }, basis: 'b', refs: [{ kind: 'session', id: 's9', value: 10 }] },
  ],
};

test('formatMetric never prints a bare number', async () => {
  const { formatMetric } = await import('../../web/learning/outcome-metrics.js');
  assert.deepEqual(formatMetric(METRICS.metrics[0]), { valueText: '50%', evidenceText: 'measured', nText: 'n = 2', basis: 'b' });
  assert.equal(formatMetric(METRICS.metrics[1]).valueText, 'not yet measurable');
  assert.equal(formatMetric(METRICS.metrics[1]).evidenceText, 'not yet measurable: no gated-done card');
  assert.equal(formatMetric(METRICS.metrics[2]).valueText, '25 min');
  assert.equal(formatMetric(METRICS.metrics[3]).evidenceText, 'no variance (zero variance)');
  assert.equal(formatMetric({ unit: 'minutes', value: { value: 180, evidence: 'measured', n: 3 } }).valueText, '3.0 h');
});

test('every Learning item type renders with a click handler and a deep link', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/learning/outcome-metrics')) return Response.json(METRICS);
    // substrate-loop and registry fixtures: reuse the fixture maps from
    // web-loop-view-smoke.test.js and registry-view-smoke.test.js (copy their
    // `ROUTES` objects into server/test/fixtures/learning-routes.js and import).
    const { LEARNING_ROUTES } = await import('./fixtures/learning-routes.js');
    const hit = Object.entries(LEARNING_ROUTES).find(([k]) => u.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  };
  let handle;
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const ctx = { getState: () => null, toast: () => {}, go: () => {}, handlers: {} };
    handle = await lens.mount(root, parseLink('/learning', '?sel=metric%3Atime-to-first-review'), ctx);
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    // the deep link reopened the metric's detail
    assert.match(root.querySelector('.om-detail')?.textContent ?? '', /Time to first review/);
    const seen = new Set();
    const sweep = () => {
      for (const el of collectItems(root)) {
        seen.add(el.dataset.itemType);
        assert.ok(el.listenerCount('click') >= 1, `${el.dataset.itemType}:${el.dataset.itemId} has no click handler`);
        const u = new URL(el.dataset.link, 'http://x');
        const r = parseLink(u.pathname, u.search);
        assert.ok(LENSES.includes(r.lens) || r.lens === 'session', `${el.dataset.link} is not a page link`);
      }
    };
    sweep();
    // Phase 2 (Q3): tabs load on first use, so the registry's rows exist only
    // once its tab has been opened.
    root.querySelector('#lt-tab-capabilities').click();
    await waitFor(() => root.querySelector('[data-item-type="capability"]'), { message: 'the registry rows' });
    sweep();
    root.querySelector('#lt-tab-ledger').click();
    await waitFor(() => root.querySelector('[data-item-type="guard"]'), { message: 'the ledger guard rows' });
    sweep();
    // each metric's evidence rows are drawn when its tile is opened
    for (const tile of collectItems(root).filter((e) => e.dataset.itemType === 'metric')) { tile.click(); sweep(); }
    for (const type of Object.keys(lens.ITEM_TYPES)) assert.ok(seen.has(type), `no rendered item of type ${type}`);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

// a selected metric tile (its evidence rows open below it)
// carried no aria-current, so a screen reader could not tell which metric's
// detail was open. Selecting a different tile must move the mark, not
// duplicate it.
test('the open metric tile carries aria-current, and selecting another one moves it (B2)', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/learning/outcome-metrics')) return Response.json(METRICS);
    const { LEARNING_ROUTES } = await import('./fixtures/learning-routes.js');
    const hit = Object.entries(LEARNING_ROUTES).find(([k]) => u.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  };
  let handle;
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    const ctx = { getState: () => null, toast: () => {}, go: () => {}, handlers: {} };
    handle = await lens.mount(root, parseLink('/learning', ''), ctx);
    const tileA = root.querySelector('[data-item-id="first-pass-ci"]');
    const tileB = root.querySelector('[data-item-id="time-to-first-review"]');
    assert.ok(tileA && tileB, 'both metric tiles rendered');
    assert.equal(tileA.getAttribute('aria-current'), null, 'nothing is selected before any click');

    tileA.click();
    assert.equal(tileA.getAttribute('aria-current'), 'true', 'the opened tile is marked current');
    assert.equal(tileB.getAttribute('aria-current'), null);

    tileB.click();
    assert.equal(tileB.getAttribute('aria-current'), 'true', 'the newly opened tile is marked current');
    assert.equal(tileA.getAttribute('aria-current'), null, 'the previously selected tile is unmarked');

    // A route update with no sel clears the detail pane unconditionally
    // (apply()'s own pre-existing fix round 1 comment) - the selection mark
    // must follow, not linger on a tile whose detail is no longer shown.
    handle.update(parseLink('/learning', ''));
    assert.equal(tileB.getAttribute('aria-current'), null, 'deselecting clears the mark too');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('a missing metric selection shows a not-found notice', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  globalThis.fetch = async (url) => (String(url).startsWith('/api/learning/outcome-metrics') ? Response.json(METRICS) : new Response('{}', { status: 404 }));
  let handle;
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/learning', '?sel=metric%3Agone'), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
    assert.match(root.textContent, /Not found: metric gone/);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('apply() clears the detail pane on every call: no stale block survives a re-selection, no residue with no selection', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  globalThis.fetch = async (url) => (String(url).startsWith('/api/learning/outcome-metrics') ? Response.json(METRICS) : new Response('{}', { status: 404 }));
  let handle;
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/learning', '?sel=metric%3Atime-to-first-review'), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
    assert.match(root.querySelector('.om-detail')?.textContent ?? '', /Time to first review/);

    handle.update(parseLink('/learning', '?sel=metric%3Agone'));
    assert.equal(root.querySelectorAll('.om-detail').length, 0, 'the stale metric detail must not survive the update');
    assert.match(root.textContent, /Not found: metric gone/);

    handle.update(parseLink('/learning', ''));
    assert.equal(root.querySelector('.om-detail'), null, 'no metric detail once the URL carries no selection');
    assert.equal(root.querySelector('.band-empty'), null, 'no leftover not-found notice once the URL carries no selection');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

// Task 16 (carried Task 6 minor): when the outcome metrics fail to load, a
// deep-linked metric selection wrote its "not found" into a detail pane that
// was never attached (visible to nobody), and "not found" was the wrong
// claim anyway: the metric may exist, its feed just did not answer.
test('a metric selection while the metrics failed to load says so, visibly, instead of not-found', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  globalThis.fetch = async (url) => (String(url).startsWith('/api/learning/outcome-metrics') ? new Response('{"error":"x"}', { status: 503 }) : new Response('{}', { status: 404 }));
  const origError = console.error; console.error = () => {};
  let handle;
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/learning', '?sel=metric%3Atime-to-first-review'), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
    assert.doesNotMatch(root.textContent, /Not found: metric/);
    assert.match(root.textContent, /The metric time-to-first-review cannot be shown: the outcome metrics failed to load \(GET \/api\/learning\/outcome-metrics returned 503\)/);
  } finally { console.error = origError; handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

// a deep-linked metric is marked on restore.
test('R8: a deep-linked metric tile carries aria-current on restore', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  globalThis.fetch = async (url) => (String(url).startsWith('/api/learning/outcome-metrics') ? Response.json(METRICS) : new Response('{}', { status: 404 }));
  const origError = console.error; console.error = () => {};
  let handle;
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/learning', '?sel=metric%3Atime-to-first-review'), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
    const tile = root.querySelector('[data-item-id="time-to-first-review"]');
    assert.ok(tile, 'the tile rendered');
    assert.equal(tile.getAttribute('aria-current'), 'true');
  } finally { console.error = origError; handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

// Card glmps-2-0-137 phase 1: Loops and Personality are no longer lenses; their
// old links land on the Evolution tab that hosts them now.
const FOLDED_ROUTES = {
  '/api/loops/catalog': { generatedAt: 1, loops: [{ name: 'launch-queue', lastOutcome: 'done', lastRunTs: 1000, ageS: 60, consecutiveFailures: 0, trigger: { everyMs: 60000 }, sla: { maxAgeMs: 3600000 }, about: { group: 'ship', why: 'Starts queued cards', produces: 'sessions', steers: [] } }], graphs: [] },
  '/api/personality': { groups: [{ id: 'runtime', name: 'Runtime', sub: '', order: '', cards: [{ id: 'prompt', name: 'Card prompt template', controls: 'x', usedBy: [], usedByGraphs: [], path: '/x' }] }] },
};
async function mountFolded(path, search) {
  const dom = installMiniDom({ pathname: path, search });
  globalThis.fetch = async (url) => {
    const u = String(url);
    const folded = Object.entries(FOLDED_ROUTES).find(([k]) => u.startsWith(k));
    if (folded) return Response.json(folded[1]);
    if (u.startsWith('/api/learning/outcome-metrics')) return Response.json(METRICS);
    const { LEARNING_ROUTES } = await import('./fixtures/learning-routes.js');
    const hit = Object.entries(LEARNING_ROUTES).find(([k]) => u.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  };
  const lens = await import('../../web/learning/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const ctx = { getState: () => null, toast: () => {}, go: () => {}, handlers: {} };
  const handle = await lens.mount(root, parseLink(path, search), ctx);
  return { dom, root, handle, done: () => { handle?.unmount(); delete globalThis.fetch; dom.restore(); } };
}
const selectedTab = (root) => root.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true');

test('an old /loops link opens the Loops tab with the loop rows', async () => {
  const m = await mountFolded('/loops', '?sel=loop%3Alaunch-queue');
  try {
    assert.equal(selectedTab(m.root)?.textContent, 'Loops');
    await waitFor(() => m.root.querySelector('.lp-summary'), { message: 'the loops summary' });
    assert.match(m.root.textContent, /launch-queue/);
  } finally { m.done(); }
});

test('an old /personality link opens Capabilities on its instruction file view', async () => {
  const m = await mountFolded('/personality', '?sel=card%3Aprompt');
  try {
    assert.equal(selectedTab(m.root)?.textContent, 'Capabilities');
    await waitFor(() => m.root.querySelector('.pers-card'), { message: 'the file preview cards' });
    assert.match(m.root.textContent, /Card prompt template/);
  } finally { m.done(); }
});
