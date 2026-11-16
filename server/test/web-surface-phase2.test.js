// Card glmps-2-0-137 phase 2 (stories 9 to 17): Surface shows each vital
// once. No Pulse dock, a Fleet ribbon without the Active and 5h budget tiles
// and without the ended strip, and one tabbed drawer on the right (Alerts,
// Repo inspector, Policy bounds) that shows one view at a time. The Kanban,
// Code graph, Cost and Decisions panels are gone; their links land on Work
// and Knowledge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink, linkFor } from '../../web/shared/deep-link.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';
import { SURFACE_PANEL_ROUTES } from './fixtures/surface-panel-routes.js';
import { waitFor } from './helpers/wait-for.js';

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function withSurface(search, fn) {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface(search, surfaceFetch({ ...SURFACE_PANEL_ROUTES }));
    handle = m.handle;
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}

test('no Pulse dock: the globe gets the left column back', async () => {
  await withSurface('', async ({ root }) => {
    assert.equal(root.querySelector('.pulse-panel'), null);
    assert.equal(root.querySelectorAll('section').some((s) => s.getAttribute('aria-label') === 'Pulse'), false);
    assert.equal(fs.existsSync(new URL('../../web/surface/pulse.js', import.meta.url)), false, 'the Pulse module and its poller are retired');
  });
});

test('the Fleet ribbon has no Active or 5h budget tile and no ended strip', async () => {
  const sb = read('web/overview/stage-board.js');
  assert.doesNotMatch(sb, /key: 'active'/, 'no Active tile');
  assert.doesNotMatch(sb, /'5h budget'/, 'no 5h budget tile');
  assert.doesNotMatch(sb, /fetchJson\('\/api\/budget'\)/, 'the ribbon no longer polls the budget');
  assert.doesNotMatch(sb, /Recently ended/, 'no ended strip');
  // with Pulse gone the ribbon is the vitals' one home on Surface, so the dock must not hide it
  assert.doesNotMatch(read('web/surface/surface.css'), /\.surface-fleet #view-stageboard \.sb-vitals \{[^}]*display:\s*none/, 'the ribbon shows on the Fleet dock');
});

test('the right side is one drawer with Alerts, Repo inspector and Policy bounds tabs', async () => {
  await withSurface('?panel=attention', async ({ root }) => {
    const drawer = root.querySelector('.surface-drawer');
    assert.ok(drawer, 'one drawer');
    const tabs = drawer.querySelectorAll('[role="tab"]');
    assert.deepEqual(tabs.map((t) => t.textContent), ['Alerts', 'Repo inspector', 'Policy bounds']);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.ok(drawer.querySelectorAll('input').some((i) => i.type === 'checkbox' && i.closest?.('label')?.textContent.includes('Show dismissed')), 'alert history sits behind Show dismissed');
  });
});

test('opening a drawer tab replaces the drawer content; it never stacks', async () => {
  await withSurface('', async ({ root, handle }) => {
    handle.update(parseLink('/surface', '?panel=repos'));
    await tick(60);
    handle.update(parseLink('/surface', '?panel=declared'));
    await tick(60);
    const drawer = root.querySelector('.surface-drawer');
    assert.equal(drawer.querySelectorAll('[role="tabpanel"]').filter((p) => !p.hidden).length, 1, 'one view at a time');
    assert.equal(drawer.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true').textContent, 'Policy bounds');
    assert.equal(root.querySelector('.surface-panels'), null, 'no panel stack');
    assert.equal(root.querySelectorAll('.surface-drawer').length, 1);
  });
});

test('the rail toggles docks only; Kanban is a link to Work; Code graph, Cost and Decisions are gone', async () => {
  await withSurface('', async ({ root }) => {
    const rail = root.querySelector('.surface-iconrail');
    const names = rail.querySelectorAll('button').map((b) => b.getAttribute('aria-label') ?? b.title);
    for (const gone of ['Kanban', 'Code graph', 'Cost and usage', 'Decisions', 'Repository inspector', 'Declared and observed']) assert.equal(names.includes(gone), false, `${gone} left the rail`);
    const work = rail.querySelectorAll('a').find((a) => a.getAttribute('href') === '/work?tab=board');
    assert.ok(work, 'the Kanban entry is a link to Work');
  });
});

test('old Surface panel links land on the views that replaced them', () => {
  assert.equal(linkFor(parseLink('/surface', '?panel=cost')), '/work?tab=cost');
  assert.equal(linkFor(parseLink('/surface', '?panel=kanban')), '/work?tab=board');
  assert.equal(linkFor(parseLink('/surface', '?panel=graph')), '/knowledge?tab=architecture');
  assert.equal(linkFor(parseLink('/surface', '?panel=graph&sel=session%3As1')), '/knowledge?tab=architecture&sel=session%3As1');
  assert.equal(linkFor(parseLink('/surface', '?panel=decisions&sel=decision%3Aabc')), '/knowledge?tab=decisions&sel=decision%3Aabc');
  assert.equal(linkFor(parseLink('/surface', '?panel=repos')), '/surface?panel=repos');
});

test('a stat link that named a Pulse row opens the Fleet ribbon tile instead', async () => {
  await withSurface('?sel=stat%3Auncommitted', async ({ root }) => {
    await waitFor(() => root.querySelector('#sb-vtile-uncommitted'), { message: 'the Fleet ribbon' });
    assert.equal(root.querySelector('.surface-fleet').classList.contains('is-open'), true);
    assert.equal(root.querySelectorAll('.insp-word').some((w) => /Not found/.test(w.textContent)), false);
  });
});
