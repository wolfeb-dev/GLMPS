// server/test/web-surface-now-routes.test.js
// Card glmps-2-0-63 (retire Now, RN-2): what an old Now link carried now opens
// on Surface: the Fleet dock, the Alerts dock, the loops layer, and
// the selected alert or loop in the inspector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface } from './fixtures/surface-fixtures.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { waitFor } from './helpers/wait-for.js';

const LOOP = { name: 'wiki-build', lastOutcome: 'failed:checker', lastReason: 'checker: stub', consecutiveFailures: 3, streakStartTs: 1, nextRunTs: 2, recentFailures: [{ ts: 1, reason: 'checker: stub' }], trigger: { everyMs: 1000 } };

const run = (search, fn) => async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  // The Fleet board's vitals poll answers after a test body ends; drain every request before the DOM goes.
  const base = surfaceFetch({ '/api/loops/wiki-build': LOOP });
  const inFlight = new Set();
  const tracked = (...a) => { const p = base(...a); inFlight.add(p); p.finally(() => inFlight.delete(p)).catch(() => {}); return p; };
  try {
    const m = await mountSurface(search, tracked);
    handle = m.handle;
    await fn(m);
    for (let quiet = 0; quiet < 3;) {
      if (inFlight.size) { quiet = 0; await Promise.allSettled([...inFlight]); } else quiet++;
      await new Promise((r) => setImmediate(r));
    }
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
};

test('panel=fleet opens a folded Fleet dock', run('', async ({ root, handle }) => {
  const dock = root.querySelector('.surface-fleet');
  root.querySelector('.fleet-toggle').click();
  assert.ok(!dock.classList.contains('is-open'), 'folded first');
  await handle.update(parseLink('/surface', '?panel=fleet'));
  assert.ok(dock.classList.contains('is-open'), 'the link unfolds it');
  // The board mounts asynchronously; let it land before the DOM is torn down.
  await waitFor(() => root.querySelector('#view-stageboard .sb-grid') || root.querySelector('#view-stageboard').childNodes.length > 0, { message: 'the board to mount' });
}));

// glmps-2-0-106: every alert link (Pulse, globe pulses, alert targets) lands on
// this route, which opens the one Alerts dock.
test('panel=attention opens the drawer on its Alerts tab with the critical alert in it', run('?panel=attention', ({ root }) => {
  const drawer = root.querySelector('.surface-drawer');
  assert.equal(drawer.hidden, false, 'the link opens it');
  assert.equal(drawer.querySelectorAll('[role="tab"]').find((t) => t.getAttribute('aria-selected') === 'true').textContent, 'Alerts');
  const dock = root.querySelector('#dock-alerts');
  assert.ok(dock, 'the Alerts view is in the drawer');
  assert.match(dock.querySelector('.adock-row').textContent, /plugin-retry-gaveup/);
}));

test('past alerts load in the same list behind Show dismissed', run('?panel=attention', async ({ root }) => {
  const history = root.querySelector('.adock-history');
  assert.equal(history.hidden, true, 'hidden first');
  const box = root.querySelector('.adock-dismissed').querySelector('input');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  assert.equal(history.hidden, false, 'the toggle shows it');
  // glmps-2-0-runtime-142: the history shows the dismissed alerts the live list
  // leaves out, not a second copy of the live ones with its own toggle.
  await waitFor(() => /Poison: acked/.test(history.textContent), { message: 'the dismissed alert' });
  assert.doesNotMatch(history.textContent, /plugin-retry-gaveup|mem0-quarantine|slack silent/, 'no live alert is listed twice');
  assert.equal(history.querySelectorAll('.alerts-toggle').length, 0, 'no second Show dismissed button');
}));

test('panel=loops turns the loops layer on', run('?panel=loops', ({ root }) => {
  assert.equal(root.querySelector('#layer-loops').checked, true);
}));

test('sel=alert:<id> shows the alert in the inspector with a source link', run('?sel=alert%3Aa2', ({ root }) => {
  const panel = root.querySelector('#panel-inspector');
  assert.ok(panel, 'the inspector opens');
  assert.match(panel.textContent, /Kernel health: plugin-retry-gaveup/);
  assert.match(panel.textContent, /critical/);
  assert.ok([...panel.querySelectorAll('a')].some((a) => a.textContent === 'Go to source'));
}));

test('sel=alert:<unknown> says it was not found rather than showing nothing', run('?sel=alert%3Anope', ({ root }) => {
  assert.match(root.querySelector('#panel-inspector').textContent, /Not found: alert nope/);
}));

test('sel=loop:<name> shows the loop record with Run now and turns the layer on', run('?sel=loop%3Awiki-build', async ({ root }) => {
  await waitFor(() => root.querySelector('#panel-inspector')?.textContent.includes('last outcome'), { message: 'the loop record' });
  const panel = root.querySelector('#panel-inspector');
  assert.match(panel.textContent, /checker: stub/);
  assert.ok([...panel.querySelectorAll('button')].some((b) => b.textContent === 'Run now'));
  assert.equal(root.querySelector('#layer-loops').checked, true);
}));

test('sel=loop:<unknown> names the failed record', run('?sel=loop%3Arenamed', async ({ root }) => {
  await waitFor(() => /renamed loop record failed to load/.test(root.querySelector('#panel-inspector')?.textContent ?? ''), { message: 'the failed loop record notice' });
}));
