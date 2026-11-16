// R2 (glmps-2-0-63) AC-4: the Fleet dock is open by default above 560 px, shows
// the stage board in the mockup's 222 px band, and a saved choice still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'surface', 'surface.css'), 'utf8').replace(/\r\n/g, '\n');
const STATE = { tools: [], sessions: [{ id: 's1', card: { id: 'mc-7', title: 'globe polish' } }], board: { rows: [{ id: 's1', stageName: 'Execute', enteredTs: Date.now() - 180000, tool: 'claude-code' }] } };

async function withSurface(fn, { before = () => {} } = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  let m;
  try {
    before();
    m = await mountSurface('', surfaceFetch(), { getState: () => STATE });
    await tick(20);
    await fn(m);
  } finally { m?.handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}

test('AC-4: on a desktop width with no saved choice the dock is open and the stage board is mounted in it', async () => {
  await withSurface(async ({ root }) => {
    assert.equal(root.querySelector('.fleet-toggle').getAttribute('aria-expanded'), 'true');
    assert.ok(root.querySelector('.surface-fleet').classList.contains('is-open'));
    assert.ok(root.querySelector('#view-stageboard').querySelector('.sb-grid'), 'the unchanged stage board is in the dock');
    assert.equal(root.querySelector('.fleet-title').textContent, 'Fleet board');
  });
});

test('AC-4: a saved "closed" wins over the open default, and an open board is gone when closed', async () => {
  await withSurface(async ({ root }) => {
    assert.equal(root.querySelector('.fleet-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(root.querySelector('#view-stageboard').childNodes.length, 0);
    assert.equal(root.querySelector('.surface-fleet').classList.contains('is-open'), false);
  }, { before: () => localStorage.setItem('surface.fleet', 'closed') });
});

test('AC-4: the open band is 222 px, scrolls inside, and the phone width lets it size to its content', () => {
  const rule = (sel) => CSS.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'g')) ?? [];
  assert.ok(rule('.surface-fleet.is-open').some((r) => /height: var\(--fleet-h, 222px\)/.test(r)), 'open band is 222 px unless the operator slid it (R3-4)');
  assert.ok(rule('.fleet-body').some((r) => /overflow: auto/.test(r) && /flex: 1/.test(r)), 'the board scrolls inside the band');
  assert.match(CSS, /\.surface-fleet\.is-open \{ height: auto; max-height: 40vh; \}/);
});
