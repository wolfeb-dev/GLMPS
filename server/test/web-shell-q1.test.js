// Q1 AC-2/4/5: per-lens stylesheets, topbar critical link removed, Wiki default project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { loadStyles, resetStyles, registerView, getView, clearViews } from '../../web/shared/view-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeDoc() {
  const links = [];
  return {
    links,
    createElement: () => {
      const l = { listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
      return l;
    },
    head: { appendChild: (l) => links.push(l) },
  };
}

test('loadStyles appends each sheet once and settles when it loads', async () => {
  resetStyles();
  const doc = fakeDoc();
  let done = false;
  const p = loadStyles(['/a.css', '/b.css'], doc).then(() => { done = true; });
  await tick();
  assert.equal(done, false, 'waits for the sheets');
  assert.equal(doc.links.length, 2);
  assert.equal(doc.links[0].rel, 'stylesheet');
  doc.links[0].listeners.load();
  doc.links[1].listeners.load();
  await p;
  await loadStyles(['/a.css'], doc);
  assert.equal(doc.links.length, 2, 'loaded once, never re-added');
});

test('a sheet that fails to load does not block the lens', async () => {
  resetStyles();
  const doc = fakeDoc();
  const p = loadStyles(['/gone.css'], doc);
  const err = console.error; console.error = () => {};
  try { doc.links[0].listeners.error(); await p; } finally { console.error = err; }
});

test('registerView carries a styles list, defaulting to none', () => {
  clearViews();
  registerView('x', { load: () => {}, styles: ['/x.css'] });
  registerView('y', { load: () => {} });
  assert.deepEqual(getView('x').styles, ['/x.css']);
  assert.deepEqual(getView('y').styles, []);
});

test('the router awaits the lens sheets before mounting it, and not for a lens already shown', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const { createLensRouter } = await import('../../web/shared/lens-router.js');
    const root = document.createElement('div'); root.id = 'lens-root'; document.body.appendChild(root);
    const log = [];
    let release;
    const sheets = new Promise((r) => { release = r; });
    const router = createLensRouter({
      getRoot: () => root,
      loadView: async () => ({ async mount() { log.push('mount'); return { update() {}, onState() {}, onEvent() {}, unmount() {} }; } }),
      loadStyles: (lens) => { log.push(`styles:${lens}`); return sheets; },
      ctx: { getState: () => null }, markNav() {}, toast() {},
    });
    const entered = router.enter(parseLink('/surface', ''));
    await tick(20);
    assert.deepEqual(log, ['styles:surface'], 'not mounted while the sheets are pending');
    release();
    await entered;
    assert.deepEqual(log, ['styles:surface', 'mount']);
    const w = router.enter(parseLink('/wiki/', ''), { push: true });
    await w;
    assert.deepEqual(log.slice(2), ['styles:knowledge', 'mount'], 'an old /wiki/ link mounts Knowledge with its sheets');
  } finally { dom.restore(); }
});

test('index.html keeps only the shell sheets; app.js registers the rest per lens', () => {
  const html = read('web/index.html');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets, ['/styles.css', '/observability/alerts.css']);
  const js = read('web/app.js');
  for (const css of ['surface/surface.css', 'learning/learning.css', 'work/work.css', 'observability/wiki.css', 'shared/roster.css',
    'overview/stage-board.css', 'observability/map.css', 'observability/qa-trends.css', 'observability/decisions.css',
    'orchestration/board.css', 'evaluation/substrate-loop.css', 'evaluation/registry.css']) {
    assert.ok(js.includes(`/${css}`), `${css} is registered with a lens`);
  }
});

test('AC-4 (amended by glmps-2-0-106): the one status cluster holds live and usage; the critical count lives in the Surface Alerts dock', () => {
  const js = read('web/app.js');
  assert.doesNotMatch(js, /stat-crit/);
  assert.match(js, /stat-live/);
  assert.match(js, /stat-usage/);
});

test('AC-1: the shell refreshes with the slim state', () => {
  const js = read('web/app.js');
  assert.match(js, /getStateSlim/);
  assert.doesNotMatch(js, /\bgetState\(/);
  assert.match(read('web/observability/history.js'), /getStateFields\(\['sessions', 'history', 'tools'\]\)/);
});

test('AC-5: Wiki opens on the project of the most recent live session', async () => {
  const { pickWikiProject } = await import('../../web/observability/wiki.js');
  const projects = [
    { name: 'glmps', path: 'D:\\glmps' },
    { name: 'glmps-2.0', path: 'D:\\glmps-2.0' },
    { name: 'nested', path: 'D:\\glmps-2.0\\sub' },
  ];
  const sessions = [
    { id: 'old', live: true, lastTs: 100, cwd: 'D:\\glmps' },
    { id: 'new', live: true, lastTs: 900, cwd: 'd:/glmps-2.0/web' },
    { id: 'ended', live: false, lastTs: 999, cwd: 'D:\\glmps' },
    { id: 'internal', live: true, internal: true, lastTs: 999, cwd: 'D:\\glmps' },
  ];
  assert.equal(pickWikiProject(projects, sessions), 'D:\\glmps-2.0');
  assert.equal(pickWikiProject(projects, [{ live: true, lastTs: 1, cwd: 'D:\\glmps-2.0\\sub\\x' }]), 'D:\\glmps-2.0\\sub');
  assert.equal(pickWikiProject(projects, [{ live: true, lastTs: 1, cwd: 'D:\\glmps-2.0-other' }]), null, 'a sibling prefix is not a match');
  assert.equal(pickWikiProject(projects, []), null);
  assert.equal(pickWikiProject(projects, undefined), null);
});
