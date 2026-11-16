// glmps-2-0-106: Surface's one alert place. The top-bar bell, the critical pill
// and the Needs attention box are gone; the Alerts view lists every critical
// with Fly to and Acknowledge, the warnings folded by source, and the data
// feeds that could not be drawn. Since card glmps-2-0-137 phase 2 it is the
// first tab of the right-side context drawer (the Pulse dock that also opened
// it is retired); the rail, the globe pulses and ?panel=attention open it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS, ALERTS } from './fixtures/surface-fixtures.js';
import { attentionModel, warningsWord } from '../../web/surface/summary.js';
import { ageWord, alertsSubLine } from '../../web/surface/alerts-dock.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();
const LIVE = { '/api/sessions/live': { sessions: [{ id: 's1', cwd: `${ROWS[0].path}/web`, lastTs: NOW }, { id: 's2', cwd: ROWS[1].path, lastTs: NOW }], now: NOW, staleMs: 600000 } };
const BACKLOG = { '/api/backlog': { items: [{ id: 'a', state: 'in_progress' }, { id: 'b', state: 'queued' }, { id: 'c', state: 'done' }] } };

test('model: every critical newest first, the warnings folded by source, acknowledged ones out', () => {
  const a = attentionModel(ALERTS);
  assert.equal(a.top.title, 'Kernel health: plugin-retry-gaveup');
  assert.deepEqual(a.critical.map((x) => x.id), ['a2'], 'a4 is acknowledged on the server');
  assert.equal(a.warningGroups, 2);
  assert.equal(a.warningTotal, 2);
  assert.equal(warningsWord(a), '2 warnings');
  assert.equal(warningsWord({ warningGroups: 8, warningTotal: 30 }), '8 warnings, grouped from 30');
  assert.equal(warningsWord({ warningGroups: 0, warningTotal: 0 }), 'No warnings');
  assert.equal(attentionModel(ALERTS, new Set(['a2'])).criticalCount, 0, 'one acknowledged here is out before the refetch lands');
  assert.equal(attentionModel({ alerts: ALERTS.alerts }).criticalCount, 0, 'no server grouping, no rows: the browser does not group');
});

test('model: the sub line and the age read in words', () => {
  assert.equal(alertsSubLine({ criticalCount: 4, warningGroups: 10, warningTotal: 119 }, 1), '4 critical, 10 warnings, grouped from 119, 1 feed not drawn');
  assert.equal(alertsSubLine({ criticalCount: 0, warningGroups: 0, warningTotal: 0 }, 0), '0 critical, no warnings');
  assert.equal(ageWord(NOW - 2 * 60000, NOW), '2 min ago');
  assert.equal(ageWord(NOW - 5 * 3600000, NOW), '5 h ago');
  assert.equal(ageWord(NOW - 3 * 86400000, NOW), '3 d ago');
  assert.equal(ageWord(undefined, NOW), '');
});

async function withSurface(fn, routes = {}, wrap = null, search = '?panel=attention') {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const base = surfaceFetch({ ...LIVE, ...BACKLOG, ...routes });
    const m = await mountSurface(search, wrap ? wrap(base) : base);
    handle = m.handle;
    await tick(20);
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}
const dockOf = (root) => root.querySelector('#dock-alerts');
const ackBtn = (dock) => dock.querySelectorAll('button').find((b) => b.textContent === 'Acknowledge');

test("Alerts is the drawer's first tab, closed until asked for, and nothing else on the page lists alerts", async () => {
  await withSurface(async ({ root }) => {
    const drawer = root.querySelector('.surface-drawer');
    assert.equal(drawer.hidden, true, 'closed until asked for');
    assert.equal(drawer.getAttribute('aria-label'), 'Context drawer');
    assert.ok(drawer.querySelector('.panel-close'), 'it closes like the docks');
    assert.equal(root.querySelector('.surface-attention'), null);
    assert.equal(root.querySelector('.surface-notices'), null);
    root.querySelector('.surface-iconrail').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Context drawer').click();
    await tick(10);
    assert.equal(drawer.hidden, false, 'the rail opens it');
    const tab = drawer.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true');
    assert.equal(tab.textContent, 'Alerts');
    assert.ok(drawer.querySelector('#dock-alerts'), 'the Alerts view is in the open tab');
  }, {}, null, '');
});

test('the dock lists every critical with Fly to and Acknowledge, and the warnings grouped by source', async () => {
  await withSurface(async ({ root }) => {
    const dock = dockOf(root);
    assert.equal(root.querySelector('.surface-drawer').hidden, false, '?panel=attention opens it');
    assert.ok(dock.classList.contains('is-critical'));
    assert.equal(dock.querySelector('.dock-sub').textContent, '1 critical, 2 warnings');
    const rows = dock.querySelectorAll('.adock-row');
    assert.equal(rows.length, 1);
    assert.match(rows[0].querySelector('.adock-title').textContent, /plugin-retry-gaveup/);
    const acts = rows[0].querySelector('.adock-acts').querySelectorAll('button');
    assert.deepEqual(acts.map((b) => b.textContent), ['Fly to', 'Acknowledge']);
    assert.equal(acts[0].disabled, false, 'a kernel alert is felt at the local store, so it can be flown to');
    const groups = dock.querySelectorAll('.adock-group');
    assert.deepEqual(groups.map((g) => g.querySelector('.name').textContent).sort(), ['Capture health', 'Kernel health']);
    groups[0].click(); await tick(10);
    assert.ok(root.querySelector('#panel-inspector'), 'a warning group opens its alerts in the inspector');
  });
});

test('Acknowledge posts the id, then the dock drops that critical', async () => {
  const posts = [];
  await withSurface(async ({ root }) => {
    const dock = dockOf(root);
    ackBtn(dock).click();
    await tick(40);
    assert.deepEqual(posts, [{ id: 'a2' }]);
    assert.equal(dock.classList.contains('is-critical'), false);
    assert.doesNotMatch(dock.querySelector('.alerts-critical').textContent, /plugin-retry-gaveup/);
    assert.match(dock.querySelector('.alerts-critical').textContent, /Nothing critical/);
  }, {}, (base) => async (url, init) => {
    if (String(url) === '/api/alerts/ack' && init?.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    return base(url, init);
  });
});

test('a failed acknowledge keeps the alert, says why, and can be tried again', async () => {
  await withSurface(async ({ root }) => {
    const dock = dockOf(root);
    ackBtn(dock).click(); await tick(40);
    assert.match(dock.querySelector('.alerts-critical').textContent, /plugin-retry-gaveup/);
    assert.match(dock.querySelector('.band-error').textContent, /Could not acknowledge Kernel health: plugin-retry-gaveup: nope/);
    assert.equal(ackBtn(dock).disabled, false);
  }, {}, (base) => async (url, init) => (String(url) === '/api/alerts/ack' ? Response.json({ error: 'nope' }, { status: 500 }) : base(url, init)));
});

test('with nothing critical the dock is calm and says so', async () => {
  await withSurface(async ({ root }) => {
    const dock = dockOf(root);
    assert.equal(dock.classList.contains('is-critical'), false);
    assert.match(dock.textContent, /Nothing critical/);
    assert.equal(ackBtn(dock), undefined);
  }, { '/api/alerts': { alerts: [] } });
});

test('a missing alerts feed hides nothing silently, the dock names it', async () => {
  await withSurface(async ({ root }) => {
    assert.match(dockOf(root).textContent, /Alerts not available/);
  }, { '/api/alerts': new Response('{}', { status: 500 }) });
});

test('a feed that cannot be drawn is listed under Data feeds instead of floating over the globe', async () => {
  await withSurface(async ({ root }) => {
    const feeds = dockOf(root).querySelector('.alerts-feeds');
    assert.match(feeds.textContent, /residency feed has no timestamp/);
    assert.match(dockOf(root).querySelector('.dock-sub').textContent, /1 feed not drawn$/);
  }, { '/api/residency': { ts: null, rows: ROWS } });
});
