// server/test/web-learning-r3.test.js
// Card glmps-2-0-63 R3, AC-7 (Learning): the LearningSurface layout. One header
// line with the 30-day sentence, four outcome tiles, then one panel holding the
// tab strip and the ledger as a kind table with a paged detail list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { LEARNING_ROUTES } from './fixtures/learning-routes.js';
import { summaryLine } from '../../web/learning/lens.js';
import { waitFor } from './helpers/wait-for.js';

const METRICS = {
  ts: 1, windowDays: 30,
  metrics: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: `Metric ${id}`, unit: 'ratio', value: { value: 0.5, evidence: 'measured', n: 2 }, basis: 'b', refs: [] })),
};

function routes() {
  const changes = [];
  for (let i = 0; i < 489; i++) changes.push({ id: `guard-${i}`, type: 'guard', title: `rule-${i % 40}`, status: i % 3 ? 'proposed' : 'measuring', ts: 1e12 + i, evidence: { sessionId: `s${i}` }, measuredEffect: null });
  for (let i = 0; i < 50; i++) changes.push({ id: `promo-${i}`, type: 'promotion', title: `promo ${i}`, status: i < 7 ? 'kept' : 'proposed', ts: 1e12 + 1000 + i, measuredEffect: null });
  for (let i = 0; i < 416; i++) changes.push({ id: `rc-${i}`, type: 'research-candidate', title: `candidate ${i}`, status: 'proposed', ts: 1e12 + 2000 + i, measuredEffect: null });
  changes.push({ id: 'skill-1', type: 'skill', title: 'a skill', status: 'reverted', ts: 1e12 + 3000, measuredEffect: null });
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
    '/api/learning': { items: [{ id: 'g1', code: 'c', status: 'pending', title: 'G', body: 'b', project: 'p', sessionId: 's', updatedTs: 1, createdTs: 1, proposedGuard: null }], config: {} },
  };
}

async function withLearning(fn) {
  const dom = installMiniDom({ pathname: '/learning' });
  let handle;
  const r = routes();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/learning/outcome-metrics')) return Response.json(METRICS);
    const hit = Object.entries(r).find(([k]) => u.startsWith(k));
    return hit ? Response.json(hit[1]) : new Response('{}', { status: 404 });
  };
  try {
    const lens = await import('../../web/learning/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/learning', '?tab=ledger'), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
    await fn(root);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
}

test('summaryLine: the 30-day sentence in counts, singular where it is one, null without data', () => {
  assert.equal(summaryLine({ acceptance: { accepted: 2, proposed: 392 }, regression: { reverted: 8 } }),
    'Last 30 days: 2 of 392 proposals adopted, 8 regressions against them.');
  assert.equal(summaryLine({ acceptance: { accepted: 1, proposed: 1 }, regression: { reverted: 1 } }),
    'Last 30 days: 1 of 1 proposal adopted, 1 regression against them.');
  assert.equal(summaryLine(null), null);
  assert.equal(summaryLine({}), null);
});

test('AC-7: the header is one line, title, 30-day sentence and Review N proposals', async () => {
  await withLearning(async (root) => {
    const head = root.querySelector('.learn-head');
    assert.equal(head.querySelector('.learn-title').textContent, 'Evolution');
    await waitFor(() => head.querySelector('.learn-summary').textContent !== '', { message: 'the summary sentence' });
    assert.equal(head.querySelector('.learn-summary').textContent, 'Last 30 days: 3 of 405 proposals adopted, 8 regressions against them.');
    assert.equal(head.querySelector('.learn-review').textContent, 'Review 1 proposal');
  });
});

test('AC-7: four outcome tiles lead, then one panel holds the tab strip and the tab content', async () => {
  await withLearning(async (root) => {
    assert.equal(root.querySelectorAll('.om-tile').length, 4);
    const card = root.querySelector('.learn-card');
    assert.ok(card, 'one Surface panel');
    assert.ok(card.contains(root.querySelector('[role="tablist"]')), 'the tab strip is the panel header');
    assert.ok(card.contains(root.querySelector('#lt-panel-ledger')));
  });
});

test('AC-7: the ledger is a kind table with mono counts and state chips', async () => {
  await withLearning(async (root) => {
    await waitFor(() => root.querySelector('.sl-kinds'), { message: 'the kind table' });
    assert.deepEqual(root.querySelector('.sl-kinds').querySelectorAll('th').map((h) => h.textContent), ['Kind', 'Changes', 'Where it stands']);
    const rows = root.querySelectorAll('.sl-kind-row');
    const by = Object.fromEntries(rows.map((r) => [r.dataset.loop, r]));
    assert.deepEqual(Object.keys(by).sort(), ['guard', 'measurable', 'memory', 'promotion', 'research-candidate', 'skill']);
    assert.equal(by.promotion.querySelector('.sl-kind-count').textContent, '50');
    assert.equal(by['research-candidate'].querySelector('.sl-kind-count').textContent, '416');
    assert.equal(by.guard.querySelector('.sl-kind-count').textContent, '489');
    assert.match(by.guard.querySelector('.sl-kind-rules').textContent, /^in 40 rules$/);
    const chips = (r) => r.querySelectorAll('.sl-stand-chip').map((c) => c.textContent);
    assert.deepEqual(chips(by.promotion), ['kept 7', 'proposed 43']);
    assert.deepEqual(chips(by.guard), ['measuring 163', 'proposed 326']);
    assert.deepEqual(chips(by.skill), ['reverted 1']);
    assert.deepEqual(chips(by.memory), [], 'a kind with nothing says nothing');
    assert.equal(by.memory.querySelector('.sl-kind-count').textContent, '0');
  });
});

test('AC-7: the ledger detail pages at 50 rows with Previous and Next, and says what is shown', async () => {
  await withLearning(async (root) => {
    await waitFor(() => root.querySelector('.sl-row'), { message: 'ledger rows' });
    const rows = () => root.querySelectorAll('.sl-row');
    const info = () => root.querySelector('.sl-pager-info').textContent;
    const [prev, next] = root.querySelectorAll('.sl-pager-btn');
    assert.deepEqual([prev.textContent, next.textContent], ['Previous', 'Next']);
    assert.equal(rows().length, 50);
    assert.equal(info(), 'Showing 1-50 of 507');
    assert.doesNotMatch(root.textContent, /\d+ of \d+ shown/, 'no "487 of 487 shown" wording');
    assert.equal(prev.disabled, true);
    next.click();
    assert.equal(info(), 'Showing 51-100 of 507');
    assert.equal(rows().length, 50);
    assert.equal(prev.disabled, false);
    prev.click();
    assert.equal(info(), 'Showing 1-50 of 507');
  });
});

test('AC-7: choosing a kind row filters the whole set and the pager follows', async () => {
  await withLearning(async (root) => {
    await waitFor(() => root.querySelector('.sl-kinds'), { message: 'the kind table' });
    const btn = root.querySelectorAll('.sl-chip-toggle').find((b) => b.textContent.startsWith('Research'));
    btn.click();
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(root.querySelector('.sl-pager-info').textContent, 'Showing 1-50 of 416');
    root.querySelectorAll('.sl-pager-btn')[1].click();
    assert.equal(root.querySelector('.sl-pager-info').textContent, 'Showing 51-100 of 416');
    btn.click();
    const promo = root.querySelectorAll('.sl-chip-toggle').find((b) => b.textContent.startsWith('Promotion'));
    promo.click();
    assert.equal(root.querySelector('.sl-pager-info').textContent, 'Showing 1-50 of 50');
    assert.equal(root.querySelectorAll('.sl-pager-btn').every((b) => b.hidden), true, 'one page needs no buttons');
  });
});

test('AC-7: the loop metric cards collapse behind one disclosure instead of stacking above the ledger', async () => {
  await withLearning(async (root) => {
    await waitFor(() => root.querySelector('.sl-kinds'), { message: 'the ledger tab' });
    const d = root.querySelector('.learn-loop-metrics');
    assert.equal(d.tagName.toLowerCase(), 'details');
    assert.ok(!d.open, 'closed by default');
    assert.ok(d.contains(root.querySelector('.sl-kpi--regression')));
  });
});
