// R2 (glmps-2-0-63) AC-3, amended by card glmps-2-0-137: the search is
// shell-owned. With the shell's topbar search Surface lends it its own source
// (results fly the globe) and draws no box of its own; unmounting gives the
// shell its own source back. Without a shell the search stays in the canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function withShellSearch(fn) {
  const dom = installMiniDom({ pathname: '/surface' });
  let m; let shell;
  try {
    const { createShellSearch } = await import('../../web/shared/search.js');
    const host = document.createElement('div'); host.id = 'topbar-search'; document.body.appendChild(host);
    shell = createShellSearch(host, { getState: () => ({ sessions: [] }), go: () => {}, fetchBacklog: async () => ({ items: [] }) });
    m = await mountSurface('', surfaceFetch(), { search: shell });
    await fn({ host, shell, m });
  } finally { m?.handle?.unmount(); shell?.destroy(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}

test('AC-3: with the shell search Surface lends its source and draws no box of its own; unmount gives it back', async () => {
  await withShellSearch(async ({ host, m }) => {
    await tick(10);
    const input = host.querySelector('.surface-search-input');
    assert.equal(input.getAttribute('placeholder'), 'Fly to a card, repo, file, agent or place');
    assert.equal(m.root.querySelector('.surface-search-input'), null, 'not also in the canvas');
    m.handle.unmount(); m.handle = null;
    assert.equal(host.querySelectorAll('.surface-search-input').length, 1, 'the shell box stays for the next pillar');
    assert.equal(input.getAttribute('placeholder'), 'Search cards and sessions (Ctrl+K)');
  });
});

test('AC-3: without a shell the search stays in the canvas header', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let m;
  try {
    m = await mountSurface('', surfaceFetch());
    await tick(10);
    const input = m.root.querySelector('.surface-search-input');
    assert.ok(input);
    assert.equal(input.getAttribute('placeholder'), 'Fly to a card, repo, file, agent or place');
  } finally { m?.handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('AC-3: the slash key still reaches the shell search', async () => {
  await withShellSearch(async ({ host }) => {
    window.dispatchEvent(new MiniEvent('keydown', { key: '/', target: document.body }));
    assert.equal(document.activeElement, host.querySelector('.surface-search-input'));
  });
});
