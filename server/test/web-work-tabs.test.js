// Card glmps-2-0-137 phase 4 (stories 29 to 35): Work has Board, History, QA
// trends and Cost tabs. History is ended sessions only with the last eight
// marked, the CI chip opens QA trends, the budget pill and old analytics links
// open Cost, and Auto-run and Pause queue are one labelled runner control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink, linkFor, LEGACY_VIEWS, resolveTarget } from '../../web/shared/deep-link.js';
import { waitFor } from './helpers/wait-for.js';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const NOW = Date.now();
const HISTORY = [
  { id: 's-live', tool: 'claude-code', lastTs: NOW, title: 'still running', cwd: '/r/alpha' },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `s-end-${i}`, tool: 'claude-code', lastTs: NOW - (i + 1) * 3600_000, title: `Ended ${i}`, cwd: '/r/alpha' })),
];
const STATE = {
  sessions: [{ id: 's-live', live: true, tool: 'claude-code', lastTs: NOW }],
  history: HISTORY,
  tools: [{ id: 'claude-code', displayName: 'Claude Code' }],
};

async function mountWork(search = '') {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    calls.push(u);
    if (u === '/api/backlog') return Response.json({ items: [] });
    if (u === '/api/runner') return Response.json({ config: { enabled: false }, targets: [] });
    if (u === '/api/qa-trends') return Response.json({ points: [{ ts: NOW, runId: 1, sha: 'abc', testCount: 20, pass: 20, fail: 0, conclusion: 'success', source: 'ci' }] });
    if (u.startsWith('/api/state')) return Response.json(STATE);
    if (u === '/api/usage') return Response.json({ totals: {}, daily: [], byProject: [], byModel: [] });
    return Response.json({});
  };
  window.vegaEmbed = async () => {};
  const lens = await import('../../web/work/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const handle = await lens.mount(root, parseLink('/work', search), { getState: () => STATE, toast: () => {}, go: () => {}, handlers: { onOpenSession: () => {} } });
  return { lens, root, handle, calls };
}
const withWork = (fn, search) => async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try { const m = await mountWork(search); handle = m.handle; await fn(m); }
  finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
};
const tabBtn = (root, label) => root.querySelectorAll('[role="tab"]').find((t) => t.textContent === label);

test('Work has Board, History, QA trends and Cost tabs and opens on Board', withWork(({ root }) => {
  const tabs = root.querySelectorAll('[role="tab"]');
  assert.deepEqual(tabs.map((t) => t.textContent), ['Board', 'History', 'QA trends', 'Cost']);
  assert.equal(tabBtn(root, 'Board').getAttribute('aria-selected'), 'true');
  assert.equal(root.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Work sections');
  assert.ok(root.querySelector('#wk-panel-board').querySelector('#backlog-columns'), 'the board is in the Board tab');
  assert.equal(root.querySelector('#band-record'), null, 'the recently ended band under the board is retired');
}));

test('History lists ended sessions only, marks the last eight, and keeps search and filters', withWork(async ({ root }) => {
  const panel = root.querySelector('#wk-panel-history');
  assert.equal(panel.hidden, false);
  await waitFor(() => panel.querySelector('.hist-table'), { message: 'the history table' });
  const rows = panel.querySelectorAll('.hist-row').filter((r) => !r.classList.contains('hist-header'));
  assert.equal(rows.length, 10);
  assert.equal(rows.some((r) => r.textContent.includes('still running')), false, 'a live session is not repeated in History');
  assert.equal(panel.querySelector('.hist-group-live'), null);
  assert.equal(panel.querySelectorAll('.hist-row-recent').length, 8, 'the last eight ended are marked');
  assert.ok(panel.querySelector('.hist-search'), 'transcript search');
  const labels = [...panel.querySelector('.hist-filters').children].map((c) => c.getAttribute('aria-label'));
  assert.deepEqual(labels, ['Filter by project', 'Filter by tool', 'Filter by date', 'Filter by skill', 'Search session transcripts']);
}, '?tab=history'));

test('old history links (band=record, /history, ?tool=) land on the History tab', async () => {
  assert.equal(linkFor(parseLink('/history')), '/work?tab=history');
  assert.equal(linkFor(parseLink('/now', '?band=record')), '/work?band=record');
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork('?band=record'); handle = m.handle;
    assert.equal(tabBtn(m.root, 'History').getAttribute('aria-selected'), 'true');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

// Card glmps-2-0-runtime-139 finding 2: the History tab loads once per mount,
// so a later route naming another tool must still apply that filter.
test('a route naming another tool re-renders History with that filter', withWork(async ({ root, handle }) => {
  const panel = root.querySelector('#wk-panel-history');
  const rows = () => panel.querySelectorAll('.hist-row').filter((r) => !r.classList.contains('hist-header'));
  await waitFor(() => rows().length === 10, { message: 'the claude-code history rows' });
  await handle.update(parseLink('/work', '?tab=history&tool=codex'));
  await waitFor(() => panel.querySelector('.hist-table') && rows().length === 0, { message: 'History filtered to codex' });
  assert.equal(panel.querySelectorAll('.hist-filters').length, 1, 'one filter bar, not a second render beside the first');
}, '?tab=history&tool=claude-code'));

test('the CI chip opens the QA trends tab', withWork(async ({ root }) => {
  const ci = root.querySelector('.work-chip--ci');
  assert.match(ci.textContent, /CI 20 \/ 20/);
  assert.equal(root.querySelector('.qat-root'), null, 'the chart is not drawn before it is asked for');
  ci.click();
  assert.equal(tabBtn(root, 'QA trends').getAttribute('aria-selected'), 'true');
  await waitFor(() => root.querySelector('#wk-panel-qa').querySelector('.qat-root'), { message: 'the QA chart' });
  assert.equal(linkFor(parseLink('/qa-trends')), '/work?tab=qa');
  assert.equal(linkFor(parseLink('/work', '?band=gates')), '/work?band=gates');
}));

test('Cost is a full-width Work tab; the budget pill and old analytics links open it', withWork(async ({ root, calls }) => {
  tabBtn(root, 'Cost').click();
  const panel = root.querySelector('#wk-panel-cost');
  assert.equal(panel.hidden, false);
  await waitFor(() => calls.includes('/api/usage') || panel.querySelector('.an-empty'), { message: 'the analytics view' });
  assert.deepEqual(LEGACY_VIEWS.analytics, { lens: 'work', tab: 'cost' });
  assert.equal(resolveTarget({ view: 'analytics' }), '/work?tab=cost');
  assert.match(read('web/app.js'), /stat-usage', linkFor\(\{ lens: 'work', tab: 'cost' \}\)/);
}));

test('Auto-run and Pause queue are one labelled runner control with two switches', withWork(({ root }) => {
  const group = root.querySelector('.board-runner');
  assert.ok(group, 'one runner control');
  assert.equal(group.getAttribute('role'), 'group');
  const label = root.querySelector(`#${group.getAttribute('aria-labelledby')}`);
  assert.equal(label.textContent, 'Runner');
  const switches = group.querySelectorAll('[role="switch"]');
  assert.equal(switches.length, 2);
  assert.match(switches[0].textContent, /^Auto-run/);
  assert.match(switches[1].textContent, /queue/i);
  for (const s of switches) { assert.equal(s.getAttribute('aria-checked'), 'false'); assert.ok(s.title, 'each switch says what it does'); }
  assert.equal(root.querySelector('.board-more').querySelector('.backlog-pause'), null, 'Pause queue left the View menu');
}));
