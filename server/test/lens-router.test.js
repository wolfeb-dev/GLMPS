// server/test/lens-router.test.js
// Task 16: the shell's navigation (web/shared/lens-router.js).
// the shared #lens-root starts every lens with no classes left over.
// a newer navigation supersedes a mount still waiting on the
//        network; a hung mount is bounded by a timeout with a named notice.
// clicking the active lens's own nav link keeps the current URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function lensModule(name, log, { mountGate = null, classOnRoot = null } = {}) {
  return {
    async mount(root, route) {
      if (classOnRoot) root.classList.add(classOnRoot);
      const p = document.createElement('p'); p.className = `lens-${name}`; root.appendChild(p);
      if (mountGate) await mountGate;
      log.push(['mount', name]);
      return {
        update: (r) => { log.push(['update', name, r]); },
        onState() {}, onEvent() {},
        unmount: () => { log.push(['unmount', name]); },
      };
    },
  };
}

async function setup(modules, opts = {}) {
  const { createLensRouter } = await import('../../web/shared/lens-router.js');
  const root = document.createElement('div'); root.id = 'lens-root'; document.body.appendChild(root);
  const toasts = [];
  const router = createLensRouter({
    getRoot: () => root,
    loadView: async (lens) => modules[lens],
    ctx: { getState: () => null },
    markNav() {},
    toast: (t) => toasts.push(t),
    ...opts,
  });
  return { router, root, toasts };
}

test('W-I1: entering a lens starts from a root with no classes left by the previous lens', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const log = [];
    const { router, root } = await setup({ surface: lensModule('surface', log, { classOnRoot: 'surface-root' }), learning: lensModule('learning', log) });
    await router.enter(parseLink('/surface', ''));
    assert.ok(root.classList.contains('surface-root'));
    // Even if a lens's own unmount forgets to take its class off:
    await router.enter(parseLink('/learning', ''), { push: true });
    assert.equal(root.className, '', `root classes: "${root.className}"`);
    assert.equal(root.dataset.lens, 'learning');
  } finally { dom.restore(); }
});

test('W-M4: a newer navigation is not stuck behind a mount still waiting on the network', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  try {
    const log = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const { router, root } = await setup({ learning: lensModule('learning', log, { mountGate: gate }), work: lensModule('work', log) });
    router.enter(parseLink('/learning', ''));
    await tick();
    const second = router.enter(parseLink('/work', ''), { push: true });
    const winner = await Promise.race([second.then(() => 'entered'), tick(200).then(() => 'stuck')]);
    assert.equal(winner, 'entered', 'Work mounted without waiting for the hung Learning mount');
    assert.equal(router.current.lens, 'work');
    assert.ok(router.current.handle, 'Work is the mounted handle');
    assert.equal(root.dataset.lens, 'work');
    // The superseded mount finally resolves: it is unmounted, never adopted.
    release();
    await tick(10);
    assert.equal(router.current.lens, 'work');
    assert.deepEqual(log.filter((e) => e[1] === 'learning').map((e) => e[0]), ['mount', 'unmount']);
  } finally { dom.restore(); }
});

test('W-M4: a mount that never answers is bounded: a named notice, and navigation still works', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const origError = console.error; console.error = () => {};
  try {
    const log = [];
    const { router, root } = await setup({ learning: lensModule('learning', log, { mountGate: new Promise(() => {}) }), work: lensModule('work', log) }, { mountTimeoutMs: 30 });
    const first = router.enter(parseLink('/learning', ''));
    const winner = await Promise.race([first.then(() => 'returned'), tick(300).then(() => 'stuck')]);
    assert.equal(winner, 'returned', 'enter() returns once the mount timeout passes');
    const note = root.querySelector('.lens-error');
    assert.ok(note, 'a notice names the slow page');
    assert.match(note.textContent, /learning page is taking too long to load/i);
    await router.enter(parseLink('/work', ''), { push: true });
    assert.equal(router.current.lens, 'work');
  } finally { console.error = origError; dom.restore(); }
});

test('W-M5: clicking the active lens\'s own nav link keeps the current URL and state', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const log = [];
    const { router } = await setup({ surface: lensModule('surface', log) });
    await router.enter(parseLink('/surface', '?layers=files,labels&cam=1,2,3'));
    const before = window.location.pathname + window.location.search;
    const entries = window.history.entries.length;
    await router.goLens('surface');
    assert.equal(window.location.pathname + window.location.search, before, 'the URL still carries layers and camera');
    assert.equal(window.history.entries.length, entries, 'no history entry pushed');
    assert.equal(log.filter((e) => e[0] === 'update').length, 0, 'the lens is not reset to a bare route');
  } finally { dom.restore(); }
});

test('goLens to a different lens navigates and pushes its bare route', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const log = [];
    const { router } = await setup({ surface: lensModule('surface', log), work: lensModule('work', log) });
    await router.enter(parseLink('/surface', ''));
    await router.goLens('work');
    assert.equal(router.current.lens, 'work');
    assert.equal(window.location.pathname, '/work');
    assert.equal(window.history.entries.at(-1)[0], 'push');
  } finally { dom.restore(); }
});

test('W-M5: the topbar lens links route through goLens', async () => {
  const fs = await import('node:fs');
  const js = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const nav = js.match(/^for \(const a of document\.querySelectorAll\('#topbar nav a\[data-lens\]'\)\) \{[\s\S]*?\r?\n\}/m);
  assert.ok(nav, 'the topbar link loop');
  assert.match(nav[0], /router\.goLens\(a\.dataset\.lens\)/);
});


function captureErrors() {
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  return { seen, restore: () => { console.error = orig; } };
}

// the same-lens update() path mapped a rejection to 'done': no log, no
// toast (app.js used to say "Navigation failed").
test('R1: a rejected same-lens update is logged and toasted', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  const errs = captureErrors();
  try {
    const mod = { async mount() { return { update: async () => { throw new Error('boom in update'); }, onState() {}, onEvent() {}, unmount() {} }; } };
    const { router, toasts } = await setup({ work: mod });
    await router.enter(parseLink('/work', ''));
    await router.enter(parseLink('/work', '?sel=card%3Ax'));
    await tick(10);
    assert.ok(toasts.some((t) => /Navigation failed: boom in update/.test(t)), JSON.stringify(toasts));
    assert.ok(errs.seen.some((m) => /boom in update/.test(m)), JSON.stringify(errs.seen));
  } finally { errs.restore(); dom.restore(); }
});

// the wiki page's renderWiki was awaited outside the supersede/timeout
// race, so a hung /api/wiki queued every later click. The wiki is now the
// Knowledge lens's Wiki tab (card glmps-2-0-137), so the same guarantee is a
// hung Knowledge mount.
function hungLens(onUnmount) {
  let release;
  const mod = { mount: () => new Promise((r) => { release = () => r({ update() {}, onState() {}, onEvent() {}, unmount: onUnmount }); }) };
  return { mod, release: () => release() };
}

test('R2: a hung Knowledge (wiki) mount does not block a later navigation, and its late unmount runs', async () => {
  const dom = installMiniDom({ pathname: '/knowledge' });
  const errs = captureErrors();
  try {
    let cleaned = 0;
    const hung = hungLens(() => { cleaned++; });
    const log = [];
    const { router } = await setup({ work: lensModule('work', log), knowledge: hung.mod }, { mountTimeoutMs: 1000 });
    router.enter(parseLink('/wiki/', ''));
    await tick();
    const w = await Promise.race([router.enter(parseLink('/work', ''), { push: true }).then(() => 'entered'), tick(300).then(() => 'stuck')]);
    assert.equal(w, 'entered');
    assert.equal(router.current.lens, 'work');
    hung.release();
    await tick(10);
    assert.equal(cleaned, 1, 'the superseded Knowledge mount is unmounted when it finally lands');
    assert.equal(router.current.lens, 'work', 'and never adopted');
  } finally { errs.restore(); dom.restore(); }
});

test('R2: a Knowledge (wiki) mount that never answers is bounded with a notice', async () => {
  const dom = installMiniDom({ pathname: '/knowledge' });
  const errs = captureErrors();
  try {
    const { router, root } = await setup({ knowledge: { mount: () => new Promise(() => {}) } }, { mountTimeoutMs: 30 });
    const w = await Promise.race([router.enter(parseLink('/wiki/', '')).then(() => 'returned'), tick(300).then(() => 'stuck')]);
    assert.equal(w, 'returned');
    assert.match(root.querySelector('.lens-error')?.textContent ?? '', /knowledge page is taking too long to load/);
  } finally { errs.restore(); dom.restore(); }
});

// every mount gets a generation-scoped ctx. isCurrent() is true while
// that mount owns #lens-root (including during its own unmount when the
// operator leaves normally) and false once a newer navigation has taken it.
test('R3: the mount ctx\'s isCurrent() follows ownership of the root', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  try {
    const seen = {};
    const mk = (name) => ({
      async mount(root, route, ctx) {
        seen[name] = ctx;
        return { update() {}, onState() {}, onEvent() {}, unmount() { seen[`${name}AtUnmount`] = ctx.isCurrent(); } };
      },
    });
    const { router } = await setup({ learning: mk('learning'), work: mk('work') });
    await router.enter(parseLink('/learning', ''));
    assert.equal(seen.learning.isCurrent(), true);
    assert.equal(typeof seen.learning.getState, 'function', 'the shell ctx is still there');
    await router.enter(parseLink('/work', ''), { push: true });
    assert.equal(seen.learningAtUnmount, true, 'a normal unmount still owns the root while it tears down');
    assert.equal(seen.learning.isCurrent(), false, 'after the swap the old mount is stale');
    assert.equal(seen.work.isCurrent(), true);
  } finally { dom.restore(); }
});

test('R3: a superseded mount is stale while it still runs, and its unmount runs stale', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  try {
    let release; const gate = new Promise((r) => { release = r; });
    let nowCtx = null; let atUnmount = null;
    const now = { async mount(root, route, ctx) { nowCtx = ctx; await gate; return { update() {}, onState() {}, onEvent() {}, unmount() { atUnmount = ctx.isCurrent(); } }; } };
    const log = [];
    const { router } = await setup({ learning: now, work: lensModule('work', log) });
    router.enter(parseLink('/learning', ''));
    await tick();
    assert.equal(nowCtx.isCurrent(), true);
    await router.enter(parseLink('/work', ''), { push: true });
    assert.equal(nowCtx.isCurrent(), false, 'stale before it lands');
    release(); await tick(10);
    assert.equal(atUnmount, false, 'the late unmount knows it no longer owns the root');
  } finally { dom.restore(); }
});

test('R3: a lens swap clears the remembered selection', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const { bindItem, markSelected } = await import('../../web/shared/interactive-item.js');
    const b = document.createElement('button'); document.body.appendChild(b);
    markSelected(bindItem(b, { type: 'card', id: 'mc-1', link: '/work?sel=card%3Amc-1', open() {} }));
    const log = [];
    const { router } = await setup({ work: lensModule('work', log), learning: lensModule('learning', log) });
    await router.enter(parseLink('/work', ''));
    await router.enter(parseLink('/learning', ''), { push: true });
    const again = document.createElement('button'); document.body.appendChild(again);
    bindItem(again, { type: 'card', id: 'mc-1', link: '/work?sel=card%3Amc-1', open() {} });
    assert.equal(again.getAttribute('aria-current'), null);
  } finally { dom.restore(); }
});

// isMounting() went false while a timed-out mount still ran; when it
// landed, its deep-link restore pushed history instead of replacing.
test('R4: isMounting() stays true until a timed-out but still-current mount settles', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const errs = captureErrors();
  try {
    let release; const gate = new Promise((r) => { release = r; });
    const log = [];
    const { router } = await setup({ learning: lensModule('learning', log, { mountGate: gate }) }, { mountTimeoutMs: 20 });
    await router.enter(parseLink('/learning', ''));
    assert.equal(router.isMounting(), true, 'still mounting after the timeout notice');
    release(); await tick(10);
    assert.equal(router.isMounting(), false);
    assert.ok(router.current.handle, 'adopted once it landed');
  } finally { errs.restore(); dom.restore(); }
});

// the first (uncached) import of a lens module is awaited
// before mount(); a navigation overtaken during that import used to mount
// into the newer page's root anyway (three frozen Learning bands inside Work).
test('F1: a navigation overtaken while its lens module loads never mounts', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  try {
    const log = [];
    let release; const gate = new Promise((r) => { release = r; });
    const modules = { learning: lensModule('learning', log), work: lensModule('work', log) };
    const { router, root } = await setup(modules, {
      loadView: async (lens) => { if (lens === 'learning') await gate; return modules[lens]; },
    });
    router.enter(parseLink('/learning', ''));
    await tick();
    await router.enter(parseLink('/work', ''), { push: true });
    release();
    await tick(20);
    assert.equal(root.querySelectorAll('.lens-learning').length, 0, 'nothing from the stale Learning lands in the root');
    assert.equal(root.querySelectorAll('.lens-work').length, 1);
    assert.ok(!log.some(([k, n]) => k === 'mount' && n === 'learning'), 'the stale lens was never mounted');
    assert.equal(router.current.lens, 'work');
  } finally { dom.restore(); }
});

test('AC-2: an unknown path toasts "Showing Surface" and mounts Surface', async () => {
  const dom = installMiniDom({ pathname: '/nonsense' });
  try {
    const log = [];
    const { router, toasts } = await setup({ surface: lensModule('surface', log), learning: lensModule('learning', log) });
    await router.enter(parseLink('/nonsense', ''));
    assert.ok(toasts.some((t) => /Showing Surface/.test(t)), JSON.stringify(toasts));
    assert.deepEqual(log, [['mount', 'surface']]);
  } finally { dom.restore(); }
});

test('AC-1: the top bar slot is emptied when the lens changes, not on an update of the same lens', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const log = [];
    const slot = document.createElement('div'); slot.id = 'topbar-slot'; document.body.appendChild(slot);
    const { router } = await setup({ surface: lensModule('surface', log), learning: lensModule('learning', log) }, { getSlot: () => slot });
    await router.enter(parseLink('/surface', ''));
    slot.appendChild(document.createElement('input'));
    await router.enter(parseLink('/surface?band=x', ''));
    assert.equal(slot.children.length, 1, 'an update of the same lens keeps what the lens put in the slot');
    await router.enter(parseLink('/learning', ''), { push: true });
    assert.equal(slot.children.length, 0, 'the slot is empty once another lens takes the root');
  } finally { dom.restore(); }
});

test('a lens keeps its own query settings (track, asof) through the canonical rewrite (glmps-2-0-63)', async () => {
  const dom = installMiniDom({ pathname: '/surface', search: '?track=s1&asof=123&layers=agents' });
  try {
    const log = [];
    const { router } = await setup({ surface: lensModule('surface', log) });
    await router.enter(parseLink('/surface', '?track=s1&asof=123&layers=agents'));
    const q = new URLSearchParams(location.search);
    assert.equal(q.get('track'), 's1');
    assert.equal(q.get('asof'), '123');
    assert.equal(q.get('layers'), 'agents');
  } finally { dom.restore(); }
});
