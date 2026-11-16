// server/test/web-work-q3.test.js
// Phase 2, Q3 (AC-1, AC-2, AC-5): the Work board in the Surface style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import * as bm from '../../web/orchestration/board-model.js';
import { ciSummary, agentRunsStat } from '../../web/observability/qa-trends.js';
import { waitFor } from './helpers/wait-for.js';

// The mounted board ages cards against the real clock, so the fixtures must
// too; a fixed date here made AC-1 fail from the next day on (glmps-2-0-60).
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600000;
const D = 24 * H;

test('fmtAge: minutes, hours, then days, and null without a timestamp', () => {
  assert.equal(bm.fmtAge(NOW - 5 * 60000, NOW), '5m');
  assert.equal(bm.fmtAge(NOW - 3 * H, NOW), '3h');
  assert.equal(bm.fmtAge(NOW - 3 * D, NOW), '3d');
  assert.equal(bm.fmtAge(null, NOW), null);
});

test('stateSinceMs prefers stateEnteredAt, then doneAt for done, then updatedAt', () => {
  assert.equal(bm.stateSinceMs({ state: 'idle', stateEnteredAt: iso(H), updatedAt: iso(D) }), NOW - H);
  assert.equal(bm.stateSinceMs({ state: 'done', doneAt: iso(2 * H), updatedAt: iso(D) }), NOW - 2 * H);
  assert.equal(bm.stateSinceMs({ state: 'queued', updatedAt: iso(D) }), NOW - D);
  assert.equal(bm.stateSinceMs({ state: 'queued' }), null);
});

test('splitDone keeps the last 7 days and counts the rest instead of hiding them silently', () => {
  const { recent, older } = bm.splitDone([
    { id: 'a', state: 'done', doneAt: iso(D) },
    { id: 'b', state: 'done', doneAt: iso(8 * D) },
    { id: 'c', state: 'done', updatedAt: iso(30 * D) },
  ], NOW);
  assert.deepEqual(recent.map((i) => i.id), ['a']);
  assert.equal(older, 2);
});

// glmps-2-0-195: Done lists the most recently finished card first, whatever the
// manual order says; a card with no usable timestamp sinks to the bottom.
test('columnItems orders Done newest-finished first and leaves other columns in manual order', () => {
  const byCol = bm.groupByColumn([
    { id: 'old', state: 'done', order: 1, doneAt: iso(3 * D) },
    { id: 'none', state: 'done', order: 2 },
    { id: 'new', state: 'done', order: 3, doneAt: iso(H) },
    { id: 'mid', state: 'done', order: 4, stateEnteredAt: iso(D), doneAt: iso(5 * D) },
    { id: 'upd', state: 'done', order: 5, updatedAt: iso(2 * D) },
    { id: 'q2', state: 'queued', order: 2, updatedAt: iso(H) },
    { id: 'q1', state: 'queued', order: 1, updatedAt: iso(D) },
  ]);
  assert.deepEqual(bm.columnItems(byCol, 'done').map((i) => i.id), ['new', 'mid', 'upd', 'old', 'none']);
  assert.deepEqual(bm.columnItems(byCol, 'queued').map((i) => i.id), ['q1', 'q2']);
  const { recent } = bm.splitDone(bm.columnItems(byCol, 'done'), NOW);
  assert.deepEqual(recent.map((i) => i.id), ['new', 'mid', 'upd', 'old', 'none']);
});

// glmps-2-0-148: In review is not a column, but a card in that state still shows.
test('columnItems folds an in_review card into In progress, in order', () => {
  const byCol = bm.groupByColumn([
    { id: 'p', state: 'in_progress', order: 2 },
    { id: 'r', state: 'in_review', order: 1 },
    { id: 'q', state: 'queued', order: 1 },
  ]);
  assert.deepEqual(bm.columnItems(byCol, 'in_progress').map((i) => i.id), ['r', 'p']);
  assert.deepEqual(bm.columnItems(byCol, 'queued').map((i) => i.id), ['q']);
  assert.deepEqual(bm.columnItems(byCol, 'done'), []);
});

test('boardColumns names the real work states; Paused and In review are not columns', () => {
  assert.deepEqual(bm.boardColumns(false), ['held', 'queued', 'in_progress', 'done']);
  assert.deepEqual(bm.boardColumns(true), ['held', 'queued', 'in_progress', 'done', 'archived', 'cancelled']);
  assert.equal(bm.COLUMN_LABELS.held, 'Backlog');
  assert.equal(bm.COLUMN_LABELS.in_progress, 'In progress');
  assert.equal(bm.COLUMN_LABELS.done, 'Done (last 7 days)');
});

test('pausedItems gathers idle and paused cards in order', () => {
  const byCol = bm.groupByColumn([
    { id: 'x', state: 'idle', order: 2 }, { id: 'y', state: 'paused', order: 1 }, { id: 'z', state: 'queued', order: 3 },
  ]);
  assert.deepEqual(bm.pausedItems(byCol).map((i) => i.id), ['y', 'x']);
});

test('projectScopes counts open cards, drops archived/cancelled, keeps the selected scope', () => {
  const items = [
    { project: 'a', state: 'queued' }, { project: 'a', state: 'held' }, { project: 'a', state: 'done' },
    { project: 'b', state: 'in_progress' }, { project: 'c', state: 'done' }, { project: 'd', state: 'archived' },
  ];
  assert.deepEqual(bm.projectScopes(items, 'all'), [{ project: 'a', count: 2 }, { project: 'b', count: 1 }]);
  assert.deepEqual(bm.projectScopes(items, 'c').map((s) => s.project), ['a', 'b', 'c']);
});

test('ciSummary reads the latest run: passing over total', () => {
  const s = ciSummary([{ testCount: 1, pass: 1, fail: 0, source: 'ci' }, { testCount: 6854, pass: 6839, fail: 0, conclusion: 'success', source: 'ci' }]);
  assert.equal(s.pass, 6839);
  assert.equal(s.total, 6854);
  assert.equal(s.ok, true);
  assert.match(s.text, /^CI 6,?839 \/ 6,?854$/);
  assert.equal(ciSummary([]), null);
  assert.equal(ciSummary([{ testCount: 5, pass: 3, fail: 2, conclusion: 'failure', source: 'ci' }]).ok, false);
});

function fixtureItems() {
  const items = [];
  for (let i = 1; i <= 11; i++) items.push({ id: `h-${i}`, project: 'alpha', title: `Held ${i}`, state: 'held', order: i, devLog: [], activity: [], gate: null, updatedAt: iso(i * H) });
  items.push({ id: 'q-1', project: 'beta', title: 'Queued one', state: 'queued', order: 1, devLog: [], activity: [], gate: { status: 'PASS', evidence: ['ok'] }, updatedAt: iso(2 * D) });
  items.push({ id: 'p-1', project: 'beta', title: 'Paused one', state: 'idle', order: 1, devLog: [], activity: [], gate: null, updatedAt: iso(H), release: { kind: 'evict', why: 'room', ts: iso(H) } });
  items.push({ id: 'd-1', project: 'beta', title: 'Done recent', state: 'done', order: 1, devLog: [], activity: [], gate: { status: 'CONCERNS' }, doneAt: iso(D), updatedAt: iso(D) });
  items.push({ id: 'd-2', project: 'beta', title: 'Done old', state: 'done', order: 2, devLog: [], activity: [], gate: null, doneAt: iso(20 * D), updatedAt: iso(20 * D) });
  return items;
}

async function mountWork(items = fixtureItems()) {
  const routes = {
    '/api/backlog': { items },
    '/api/qa-trends': { points: [{ ts: NOW, runId: 1, sha: 'abc', testCount: 20, pass: 19, fail: 0, conclusion: 'success', openIssues: 0, source: 'ci' }] },
  };
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    return routes[u] ? Response.json(routes[u]) : Response.json({});
  };
  window.vegaEmbed = async () => {};
  const lens = await import('../../web/work/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const handle = await lens.mount(root, parseLink('/work', ''), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
  return { root, handle };
}

const colOf = (root, col) => root.querySelectorAll('.backlog-col').find((c) => c.dataset.col === col);

test('AC-1: columns are named for the real states, no project dropdown, no state pill in a column', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    const heads = m.root.querySelectorAll('.col-head-label').map((h) => h.textContent);
    assert.deepEqual(heads, ['Backlog', 'Queued', 'In progress', 'Done (last 7 days)']);
    assert.equal(m.root.querySelectorAll('select').filter((s) => s.getAttribute('aria-label') === 'Project').length, 0, 'the duplicate project dropdown is gone');
    assert.equal(m.root.querySelectorAll('.board-state-pill').length, 0, 'no state pill inside its own column');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-1: a card shows title, id, time in state and its gate chip', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    const q = m.root.querySelector('[data-item-id="q-1"]');
    assert.equal(q.querySelector('.backlog-card-title').textContent, 'Queued one');
    assert.equal(q.querySelector('.board-id-chip').textContent, 'q-1');
    assert.equal(q.querySelector('.board-age-pill').textContent, '2d');
    assert.equal(q.querySelector('.board-gate-pill').textContent, 'PASS');
    const none = m.root.querySelector('[data-item-id="h-1"]');
    assert.equal(none.querySelector('.board-gate-pill'), null, 'no gate chip when there is no gate');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-1: a column shows its first cards and "Show N more" expands in place', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    const held = colOf(m.root, 'held');
    const visible = () => held.querySelectorAll('.backlog-card').filter((c) => !c.hidden).length;
    assert.equal(held.querySelectorAll('.backlog-card').length, 11, 'every card stays in the DOM so a drop reads the full order');
    assert.equal(visible(), bm.COLUMN_PAGE);
    const more = held.querySelector('.backlog-col-more');
    assert.equal(more.textContent, 'Show 6 more');
    assert.equal(more.hidden, false);
    assert.equal(more.getAttribute('aria-label'), 'Show 6 more cards in Backlog', 'the control names its column');
    more.click();
    assert.equal(visible(), 11);
    assert.equal(more.textContent, 'Show fewer');
    more.click();
    assert.equal(visible(), bm.COLUMN_PAGE);
    assert.equal(colOf(m.root, 'queued').querySelector('.backlog-col-more').hidden, true, 'a short column has no control');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-1: Done keeps the last 7 days and notes the rest; Paused rides in the Done footer', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    const done = colOf(m.root, 'done');
    const ids = done.querySelectorAll('.backlog-card').map((c) => c.dataset.id);
    assert.ok(ids.includes('d-1') && ids.includes('p-1'));
    assert.ok(!ids.includes('d-2'), 'the 20 day old done card is outside the window');
    assert.match(done.querySelector('.backlog-col-note').textContent, /1 older/);
    const foot = done.querySelector('.backlog-col-foot');
    assert.equal(foot.dataset.col, 'idle', 'the footer is the idle drop target');
    assert.deepEqual(foot.querySelectorAll('.backlog-card').map((c) => c.dataset.id), ['p-1']);
    assert.equal(colOf(m.root, 'idle'), undefined, 'no standalone Paused column');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-1: the project sidebar is the one scope and filters the board', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    const rows = m.root.querySelectorAll('.board-scope-row');
    assert.deepEqual(rows.map((r) => r.dataset.projKey), ['all', 'alpha', 'beta']);
    assert.equal(rows[1].querySelector('.board-scope-count').textContent, '11');
    assert.equal(rows[0].getAttribute('aria-pressed'), 'true');
    rows[2].click();
    await waitFor(() => colOf(m.root, 'held').querySelectorAll('.backlog-card').length === 0, { message: 'alpha cards to be filtered out' });
    assert.equal(m.root.querySelectorAll('.board-scope-row')[2].getAttribute('aria-pressed'), 'true');
    assert.ok(m.root.querySelector('[data-item-id="q-1"]'));
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-2: CI is a chip that opens the QA trends tab, and the goal chip is gone', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    assert.equal(m.root.querySelector('.work-chip--goals'), null, 'the goal graph was retired');
    assert.equal(m.root.querySelector('#band-goals'), null);

    const ci = m.root.querySelector('.work-chip--ci');
    assert.match(ci.textContent, /CI 19 \/ 20/);
    assert.equal(m.root.querySelector('.qat-root'), null, 'the chart is not drawn before the chip is opened');
    ci.click();
    await waitFor(() => m.root.querySelector('.qat-root'), { message: 'the chart panel' });
    assert.equal(m.root.querySelector('#wk-panel-qa').hidden, false);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('AC-2: a retired goals band link mounts the board and opens nothing', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork(); handle = m.handle;
    await handle.update(parseLink('/work', '?band=goals&sel=goal%3Ag1'));
    assert.equal(m.root.querySelector('#band-goals'), null);
    assert.equal(m.root.querySelector('#wk-panel-qa').hidden, true);
    assert.equal(m.root.querySelector('#wk-panel-board').hidden, false);
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('agentRunsStat: the 7-day agent test-run count, flagged when any failed, absent with no runs', () => {
  assert.deepEqual(agentRunsStat({ runs: 12, failedRuns: 3, lastTs: 1, windowDays: 7 }), { label: 'Agent test runs \u00B7 7d \u00B7 3 failed', value: '12', accent: 'bad' });
  assert.deepEqual(agentRunsStat({ runs: 4, failedRuns: 0, lastTs: 1, windowDays: 7 }), { label: 'Agent test runs \u00B7 7d \u00B7 0 failed', value: '4', accent: 'good' });
  assert.equal(agentRunsStat({ runs: 0, failedRuns: 0, lastTs: null, windowDays: 7 }), null);
  assert.equal(agentRunsStat(undefined), null);
});
