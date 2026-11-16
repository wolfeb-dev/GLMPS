// server/test/web-work-r3.test.js
// Card glmps-2-0-63 R3, AC-7 (Work): the board in the WorkSurface layout. One
// header line holds the title, the CI chip, quick-add, search and Auto-run; the
// separate bar and toolbar rows are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import * as bm from '../../web/orchestration/board-model.js';
import { waitFor } from './helpers/wait-for.js';

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600000;
const D = 24 * H;

function items() {
  const out = [];
  for (let i = 1; i <= 7; i++) out.push({ id: `h-${i}`, project: 'alpha', title: `Held ${i}`, state: 'held', order: i, devLog: [], activity: [], gate: null, updatedAt: iso(i * H) });
  out.push({ id: 'p-1', project: 'beta', title: 'Running one', state: 'in_progress', order: 1, devLog: [], activity: [], gate: { status: 'CONCERNS' }, priority: 1, updatedAt: iso(3 * H) });
  out.push({ id: 'p-2', project: 'beta', title: 'Urgent one', state: 'in_progress', order: 2, devLog: [], activity: [], gate: null, priority: 3, updatedAt: iso(H) });
  out.push({ id: 'd-1', project: 'beta', title: 'Done recent', state: 'done', order: 1, devLog: [], activity: [], gate: { status: 'PASS' }, doneAt: iso(D), updatedAt: iso(D) });
  return out;
}

async function mountWork(list = items(), runner = { config: { enabled: false }, targets: [] }) {
  const routes = {
    '/api/backlog': { items: list },
    '/api/runner': runner,
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

async function withWork(fn, list, runner) {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try { const m = await mountWork(list, runner); handle = m.handle; await fn(m.root); }
  finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
}

const colOf = (root, col) => root.querySelectorAll('.backlog-col').find((c) => c.dataset.col === col);

test('emptyText: each column says what is missing and what to do, honestly', () => {
  assert.equal(bm.emptyText('queued', false), 'Nothing queued. Add a card above, or release one from Backlog.');
  assert.equal(bm.emptyText('held', false), 'Nothing in the backlog.');
  assert.equal(bm.emptyText('in_progress', false), 'No card running.');
  assert.equal(bm.emptyText('done', false), 'Nothing finished in the last 7 days.');
  assert.equal(bm.emptyText('queued', true), 'No card here matches the search or scope.');
  assert.match(bm.emptyText('archived', false), /^Nothing archived/);
});

// Card glmps-2-0-137 phase 4: the pillar header carries the title and the CI
// chip; the board's own bar (quick-add, search, runner, View) leads the Board tab.
test('AC-7: the header carries title and CI chip; the board bar carries quick-add, search and Auto-run', async () => {
  await withWork(async (root) => {
    const head = root.querySelector('.work-head');
    assert.equal(head.querySelector('.work-title').textContent, 'Work');
    assert.equal(head.querySelector('.work-chip--goals'), null, 'the goal graph was retired');
    assert.match(head.querySelector('.work-chip--ci').children[0].textContent, /^CI 19 \/ 20$/);
    const bar = root.querySelector('.work-board-bar');
    assert.equal(bar.querySelector('.backlog-input').placeholder, 'Add a card, Enter to queue');
    assert.ok(bar.querySelector('.board-toolbar-search'), 'search stays reachable in the board bar');
    const run = bar.querySelector('.backlog-runner');
    assert.equal(run.textContent, 'Auto-run off');
    assert.equal(run.getAttribute('aria-checked'), 'false');
    assert.equal(root.querySelector('.backlog-bar'), null, 'no separate quick-add band');
    assert.equal(root.querySelector('.board-toolbar'), null, 'no second toolbar row');
  });
});

test('AC-7: Auto-run reflects the runner config as a checked switch', async () => {
  await withWork(async (root) => {
    const run = root.querySelector('.backlog-runner');
    await waitFor(() => run.getAttribute('aria-checked') === 'true', { message: 'the runner config to paint' });
    assert.equal(run.textContent, 'Auto-run on');
  }, items(), { config: { enabled: true }, targets: ['vscode'] });
});

test('AC-7: grouping, archived and launch target fold into a View menu in the board bar; pause joins the runner control', async () => {
  await withWork(async (root) => {
    const more = root.querySelector('.work-board-bar').querySelector('.board-more');
    assert.ok(more, 'the View menu is in the board bar');
    assert.ok(more.querySelector('select[aria-label="Group by"]'));
    assert.ok(more.querySelector('.board-toolbar-checkbox'));
    assert.equal(more.querySelector('.backlog-pause'), null);
    assert.ok(root.querySelector('.board-runner').querySelector('.backlog-pause'));
    assert.ok(more.querySelector('select[aria-label="Launch sessions in"]'));
  });
});

// Card glmps-2-0-runtime-87: with no saved target the picker used to show its
// first IDE while sessions and Open went elsewhere.
test('launch target: unset shows Automatic, a saved target shows that target', async () => {
  await withWork(async (root) => {
    const sel = root.querySelector('select[aria-label="Launch sessions in"]');
    await waitFor(() => sel.children.length === 3, { message: 'the targets to load' });
    assert.equal(sel.children[0].textContent, 'Automatic');
    assert.equal(sel.children[0].value, '');
    assert.equal(sel.value, '');
  }, items(), { config: { enabled: false, lastTarget: null }, targets: ['vscode', 'antigravity'] });
  await withWork(async (root) => {
    const sel = root.querySelector('select[aria-label="Launch sessions in"]');
    await waitFor(() => sel.children.length === 3, { message: 'the targets to load' });
    assert.equal(sel.value, 'antigravity');
  }, items(), { config: { enabled: false, lastTarget: 'antigravity' }, targets: ['vscode', 'antigravity'] });
});

test('launch target: choosing Automatic saves no target', async () => {
  const posts = [];
  await withWork(async (root) => {
    const sel = root.querySelector('select[aria-label="Launch sessions in"]');
    await waitFor(() => sel.children.length === 3, { message: 'the targets to load' });
    const prior = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('/api/runner/config')) { posts.push(JSON.parse(init.body)); return Response.json({}); }
      return prior(url, init);
    };
    sel.value = '';
    sel.dispatchEvent(new Event('change'));
    await waitFor(() => posts.length === 1, { message: 'the config post' });
    assert.deepEqual(posts[0], { lastTarget: null });
  }, items(), { config: { enabled: false, lastTarget: 'antigravity' }, targets: ['vscode', 'antigravity'] });
});

test('AC-7: the board bar leads the board main column beside the sidebar; QA trends is its own tab', async () => {
  await withWork(async (root) => {
    const main = root.querySelector('.kanban-main');
    assert.equal(main.children[0], root.querySelector('.work-board-bar'), 'the bar is the first row of the main column');
    assert.ok(!main.contains(root.querySelector('#wk-panel-qa')));
    assert.equal(root.querySelector('.kanban-rail'), null, 'no side rail: project scope lives in the bar');
    assert.equal(root.querySelector('.work-board-bar').children[0], root.querySelector('.board-scope'), 'the scope chips lead the board bar');
  });
});

test('AC-7: the project scope chips have colour squares and counts, and links to Surface', async () => {
  await withWork(async (root) => {
    const rows = root.querySelectorAll('.board-scope-row');
    assert.deepEqual(rows.map((r) => r.dataset.projKey), ['all', 'alpha', 'beta']);
    assert.ok(rows[1].querySelector('.board-scope-sq'));
    assert.equal(rows[1].querySelector('.board-scope-count').textContent, '7');
    const link = root.querySelector('.board-scope-surface');
    assert.equal(link.textContent, 'On Surface');
    assert.equal(link.title, 'Show these cards on Surface');
    // glmps-2-0-runtime-142: panel=kanban now redirects to the board itself, so
    // the link names the cards layer and must stay on Surface when parsed.
    const href = link.getAttribute('href');
    const [path, search] = href.split('?');
    const r = parseLink(path, search ? `?${search}` : '');
    assert.equal(r.lens, 'surface', `${href} stays on Surface`);
    assert.ok(r.layers?.includes('cards'), `${href} turns the cards layer on`);
  });
});

test('AC-7: a card is a row with title, id chip, age chip and gate chip, and nothing else by default', async () => {
  await withWork(async (root) => {
    const c = root.querySelector('[data-item-id="p-1"]');
    assert.equal(c.querySelector('.backlog-card-title').textContent, 'Running one');
    assert.equal(c.querySelector('.board-id-chip').textContent, 'p-1');
    assert.equal(c.querySelector('.board-age-pill').textContent, '3h');
    assert.equal(c.querySelector('.board-gate-pill').textContent, 'CONCERNS');
    assert.equal(c.querySelector('.backlog-card-meta'), null, 'the project / agent line is gone');
    assert.equal(c.querySelector('.board-priority-pill'), null, 'a normal priority is not a chip');
    assert.ok(root.querySelector('[data-item-id="p-2"]').querySelector('.board-priority-pill'), 'urgent still shows');
  });
});

test('AC-7: four columns (no In review), honest empty text, and Show N more at five cards', async () => {
  await withWork(async (root) => {
    assert.deepEqual(root.querySelectorAll('.col-head-label').map((h) => h.textContent), ['Backlog', 'Queued', 'In progress', 'Done (last 7 days)']);
    assert.equal(colOf(root, 'queued').querySelector('.backlog-col-empty').textContent, 'Nothing queued. Add a card above, or release one from Backlog.');
    assert.equal(colOf(root, 'in_review'), undefined, 'no In review column');
    const held = colOf(root, 'held');
    assert.equal(bm.COLUMN_PAGE, 5);
    assert.equal(held.querySelectorAll('.backlog-card').filter((c) => !c.hidden).length, 5);
    assert.equal(held.querySelector('.backlog-col-more').textContent, 'Show 2 more');
  });
});

test('AC-7: the header search filters the board', async () => {
  await withWork(async (root) => {
    const search = root.querySelector('.work-board-bar').querySelector('.board-toolbar-search');
    search.value = 'Urgent';
    search.dispatchEvent(new Event('input'));
    await waitFor(() => root.querySelectorAll('.backlog-card').length === 1, { message: 'the board to filter' });
    assert.equal(root.querySelector('.backlog-card').dataset.id, 'p-2');
    assert.equal(colOf(root, 'held').querySelector('.backlog-col-empty').textContent, 'No card here matches the search or scope.');
  });
});

test('AC-7: quick-add in the header still queues a card', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const posts = [];
  let handle;
  try {
    const base = await mountWork();
    handle = base.handle;
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).split('?')[0] === '/api/backlog' && opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return Response.json({ id: 'new-1' }); }
      return real(url, opts);
    };
    const input = base.root.querySelector('.work-board-bar').querySelector('.backlog-input');
    input.value = 'one more idea';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await waitFor(() => posts.length === 1, { message: 'the POST' });
    assert.equal(posts[0].title, 'one more idea');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});
