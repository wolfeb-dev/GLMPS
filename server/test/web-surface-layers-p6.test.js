// the grouped Layers panel, the Loops layer and the Alert pulses layer, mounted end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, LOOPS, ALERTS } from './fixtures/surface-fixtures.js';
import { collectItems } from '../../web/shared/interactive-item.js';
import { waitFor } from './helpers/wait-for.js';

const run = async (search, fetchImpl, fn) => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface(search, fetchImpl);
    handle = m.handle;
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
};
const item = (root, type, id) => collectItems(root).find((e) => e.dataset.itemType === type && e.dataset.itemId === id);

test('AC-1: the Layers panel groups its rows under Data, Places, Work, Events, Links between places and Map headings', async () => {
  await run('', undefined, ({ root }) => {
    // Fly to leads the panel; the data groups follow it.
    const groups = [...root.querySelector('#dock-layers').querySelectorAll('[role="group"]')].slice(1);
    const heads = groups.map((g) => g.querySelector('h3').textContent);
    assert.deepEqual(heads, ['Data', 'Places', 'Work', 'Events', 'Links between places', 'Map']);
    for (const g of groups) assert.equal(g.getAttribute('aria-labelledby'), g.querySelector('h3').id, 'the group is named by its heading');
    const idsIn = (name) => groups[heads.indexOf(name)].querySelectorAll('input').map((i) => i.id);
    assert.equal(idsIn('Data').length, 8);
    assert.deepEqual(idsIn('Places'), ['layer-players', 'layer-residency', 'layer-nowhere']);
    assert.deepEqual(idsIn('Work'), ['layer-files', 'layer-agents', 'layer-cards', 'layer-queue', 'layer-prs']);
    assert.deepEqual(idsIn('Events'), ['layer-alerts', 'layer-gates', 'layer-refusals']);
    assert.deepEqual(idsIn('Links between places'), ['layer-remote-links', 'layer-loops', 'layer-usage', 'layer-trails']);
    assert.deepEqual(idsIn('Map'), ['layer-graticule', 'layer-labels']);
    const loops = root.querySelector('#layer-loops').parentNode;
    assert.equal(loops.querySelector('kbd').textContent, 'O');
    assert.equal(loops.querySelector('.n').textContent, String(Object.keys(LOOPS).length));
    assert.equal(root.querySelector('#layer-alerts').parentNode.querySelector('kbd').textContent, 'E');
  });
});

test('AC-1: alt-click on a layer checkbox shows it alone; alt-click again restores the set', async () => {
  await run('', undefined, ({ root }) => {
    const on = () => root.querySelector('#dock-layers').querySelectorAll('input').filter((i) => !i.id.startsWith('layer-type-') && i.checked).map((i) => i.id);
    const before = on();
    assert.ok(before.length > 1);
    const box = root.querySelector('#layer-cards');
    box.dispatchEvent(new MiniEvent('click', { altKey: true }));
    assert.deepEqual(on(), ['layer-cards']);
    box.dispatchEvent(new MiniEvent('click', { altKey: true }));
    assert.deepEqual(on(), before);
  });
});

test('AC-1: O toggles Loops, E toggles Alert pulses, and both land in the URL', async () => {
  await run('', undefined, ({ root }) => {
    const key = (k) => window.dispatchEvent(new MiniEvent('keydown', { key: k, target: document.body }));
    assert.equal(root.querySelector('#layer-loops').checked, false, 'Loops start off: lines between places are quiet by default (glmps-2-0-63 round 3)');
    assert.equal(root.querySelector('#layer-alerts').checked, true);
    key('o'); assert.equal(root.querySelector('#layer-loops').checked, true);
    key('e'); assert.equal(root.querySelector('#layer-alerts').checked, false);
    const last = window.history.entries.at(-1)?.[1] ?? '';
    const layers = new URL(last, 'http://x').searchParams.get('layers').split(',');
    assert.ok(layers.includes('loops') && !layers.includes('alerts'), last);
  });
});

test('AC-2: one ring and one bound dot per loop, coloured and worded by state, opening the loop record in the inspector', async () => {
  const record = surfaceFetch({ '/api/loops/wiki-build': { name: 'wiki-build', lastOutcome: 'failed:checker', lastReason: 'checker: stub', consecutiveFailures: 3, streakStartTs: 1, nextRunTs: 2, recentFailures: [{ ts: 1, reason: 'checker: stub' }], trigger: { everyMs: 1000 } } });
  await run('?layers=loops,players', record, async ({ root }) => {
    assert.equal(root.querySelectorAll('.orbit-dot').length, 3);
    assert.equal(root.querySelectorAll('.orbit-ring').length, 3);
    const wiki = item(root, 'loop', 'wiki-build');
    assert.equal(wiki.getAttribute('aria-label'), 'Loop wiki-build: failing 3 in a row');
    assert.match(wiki.getAttribute('class'), /orbit-critical/);
    assert.match(item(root, 'loop', 'nightly-run').getAttribute('class'), /orbit-stale/);
    assert.equal(item(root, 'loop', 'nightly-run').getAttribute('aria-label'), 'Loop nightly-run: stale');
    assert.match(item(root, 'loop', 'git-remote-feed').getAttribute('class'), /orbit-ok/);
    assert.equal(new URL(wiki.dataset.link, 'http://x').searchParams.get('sel'), 'loop:wiki-build');
    assert.ok(wiki.dataset.link.startsWith('/surface?'), wiki.dataset.link);
    wiki.click();
    await waitFor(() => root.querySelector('#panel-inspector')?.textContent.includes('last outcome'), { message: 'the loop record in the inspector' });
    assert.equal(root.querySelector('#layer-loops').checked, true, 'opening a loop shows the Loops layer');
    const radii = [...root.querySelectorAll('.orbit-ring')].map((r) => Number(r.getAttribute('r')));
    assert.deepEqual([...radii].sort((a, b) => a - b), radii, 'rings step outward by index');
  });
});

test('AC-2: with the layer off its group is hidden', async () => {
  await run('?layers=players', undefined, ({ root }) => {
    assert.equal(root.querySelector('[data-layer="loops"]').getAttribute('display'), 'none');
  });
});

test('AC-3: pulses sit on the platform by worst severity, count only active alerts, and open the Alerts dock', async () => {
  await run('', undefined, ({ root }) => {
    const local = item(root, 'alert-pulse', 'local');
    const slack = item(root, 'alert-pulse', 'slack');
    assert.match(local.getAttribute('class'), /pulse-critical/);
    assert.match(slack.getAttribute('class'), /pulse-warn/);
    assert.equal(local.getAttribute('aria-label'), '2 active alerts at the local store, worst critical: Kernel health: plugin-retry-gaveup');
    assert.equal(local.querySelector('.pulse-badge').textContent, '2');
    assert.ok(local.querySelector('.pulse-wave') && local.querySelector('.pulse-core'), 'a static ring plus an animated wave');
    assert.equal(local.dataset.link, '/surface?panel=attention');
    local.click();
    assert.equal(root.querySelector('#dock-alerts').hidden, false, 'the Alerts dock opens');
    assert.equal(root.querySelector('#layer-alerts').parentNode.querySelector('.n').textContent, '3');
  });
});

test('AC-3: no active alert draws no pulse', async () => {
  const quiet = surfaceFetch({ '/api/alerts': { alerts: ALERTS.alerts.map((a) => ({ ...a, acknowledged: true })) } });
  await run('', quiet, ({ root }) => {
    assert.equal(root.querySelectorAll('.pulse').length, 0);
    assert.equal(root.querySelector('#layer-alerts').parentNode.querySelector('.n').textContent, '0');
  });
});

test('AC-4: a dry loops or alerts route is named in a notice, never silent', async () => {
  const dry = surfaceFetch({ '/api/loops': new Response('{"error":"x"}', { status: 503 }), '/api/alerts': new Response('{"error":"x"}', { status: 500 }) });
  // The notices are listed in the context drawer's Alerts tab, under Data feeds.
  await run('?panel=attention', dry, ({ root }) => {
    assert.match(root.textContent, /Loops not available: GET \/api\/loops returned 503/);
    assert.match(root.textContent, /Alert pulses not available: GET \/api\/alerts returned 500/);
    assert.equal(root.querySelector('#layer-loops').parentNode.querySelector('.n').textContent, '0');
  });
});

test('AC-4: the layer legend states source, count and freshness', async () => {
  await run('?sel=layer%3Aloops', undefined, ({ root }) => {
    const text = root.querySelector('#panel-inspector').textContent;
    assert.match(text, /Source: GET \/api\/loops/);
    assert.match(text, /freshness/);
    assert.match(text, /snapshot \d+ s old/);
    assert.match(text, /failing/);
  });
  await run('?sel=layer%3Aalerts', undefined, ({ root }) => {
    const text = root.querySelector('#panel-inspector').textContent;
    assert.match(text, /Source: GET \/api\/alerts/);
    assert.match(text, /fetched \d+ s ago/);
  });
});
