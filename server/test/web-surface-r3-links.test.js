// UI round 3 (glmps-2-0-63) R3-1: a quiet globe. Every layer that draws a line
// or arc between two places is off by default and listed under "Links between
// places"; a remote place shows a count chip; selecting a place draws only that
// place's own links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';
import { collectItems } from '../../web/shared/interactive-item.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const LINK_LAYERS = ['loops', 'usage', 'trails', 'remote-links'];
const USAGE = { providers: [{ id: 'anthropic', label: 'Anthropic', spendUsd: 3, tokens: 1000, sessions: 4 }, { id: 'google', label: 'Google', spendUsd: 1, tokens: 300, sessions: 2 }] };
const SLACK_CARDS = { items: [{ id: 'c1', state: 'queued', title: 'a', origin: { via: 'slack' } }, { id: 'c2', state: 'queued', title: 'b', origin: { via: 'slack' } }, { id: 'c3', state: 'done', title: 'c' }] };

const run = async (search, routes, fn) => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface(search, surfaceFetch({ '/api/usage/providers': USAGE, '/api/backlog': SLACK_CARDS, ...routes }));
    handle = m.handle;
    await tick();
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
};
const group = (root, id) => root.querySelector(`[data-layer="${id}"]`);
const shown = (root, id) => group(root, id).getAttribute('display') !== 'none';

test('R3-1: every link layer starts off and sits under "Links between places"', async () => {
  await run('', {}, ({ root }) => {
    for (const id of LINK_LAYERS) {
      const box = root.querySelector(`#layer-${id}`);
      assert.ok(box, `${id} has a row`);
      assert.equal(box.checked, false, `${id} starts off`);
      assert.equal(shown(root, id), false, `${id} draws nothing`);
    }
    const groups = [...root.querySelector('#dock-layers').querySelectorAll('[role="group"]')];
    const links = groups.find((g) => g.querySelector('h3').textContent === 'Links between places');
    assert.deepEqual(links.querySelectorAll('input').map((i) => i.id).sort(), LINK_LAYERS.map((id) => `layer-${id}`).sort());
  });
});

test('R3-1: turning a link layer on draws it, and the URL carries the choice', async () => {
  await run('', {}, ({ root }) => {
    const box = root.querySelector('#layer-remote-links');
    box.checked = true; box.dispatchEvent(new MiniEvent('change'));
    assert.equal(shown(root, 'remote-links'), true);
    const last = window.history.entries.at(-1)?.[1] ?? '';
    assert.ok(new URL(last, 'http://x').searchParams.get('layers').split(',').includes('remote-links'), last);
  });
});

test('R3-1: a remote place shows a count chip of what it holds', async () => {
  await run('', {}, ({ root }) => {
    const items = collectItems(root);
    const chip = (id) => items.find((e) => e.dataset.itemType === 'player' && e.dataset.itemId === id).querySelector('.pl-count');
    assert.equal(chip('github').querySelector('text').textContent, '2', 'two repositories have a remote');
    assert.equal(chip('slack').querySelector('text').textContent, '2', 'two cards were born in Slack');
    assert.equal(chip('local'), null, 'the local store is not a remote place');
    assert.match(items.find((e) => e.dataset.itemType === 'player' && e.dataset.itemId === 'github').getAttribute('aria-label'), /2 linked items/);
  });
});

test('R3-1: selecting a place draws that place\'s links even with the layers off', async () => {
  await run('?sel=player%3Agithub', {}, ({ root }) => {
    assert.equal(root.querySelector('#layer-remote-links').checked, false, 'the toggle itself is untouched');
    assert.equal(shown(root, 'remote-links'), true, 'GitHub\'s repository links show');
    assert.equal(shown(root, 'loops'), false, 'the loops orbit the local store, not GitHub');
    assert.equal(shown(root, 'usage'), false, 'GitHub has no spend link');
  });
  await run('?sel=player%3Aanthropic', {}, ({ root }) => {
    assert.equal(shown(root, 'usage'), true, 'the spend arc to Anthropic shows');
    assert.equal(shown(root, 'remote-links'), false);
    const arc = (id) => collectItems(root).find((e) => e.dataset.itemType === 'provider-arc' && e.dataset.itemId === id);
    assert.notEqual(arc('anthropic').getAttribute('display'), 'none', 'the Anthropic arc is drawn');
    assert.equal(arc('google').getAttribute('display'), 'none', 'the Google arc is not');
  });
  await run('?sel=player%3Alocal', {}, ({ root }) => {
    for (const id of ['loops', 'remote-links']) assert.equal(shown(root, id), true, `${id} touches the local store`);
  });
});

test('R3-1: with no place selected the links stay off', async () => {
  await run('?sel=repo%3Aglmps', {}, ({ root }) => {
    for (const id of LINK_LAYERS) assert.equal(shown(root, id), false, id);
  });
});
