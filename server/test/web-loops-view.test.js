// server/test/web-loops-view.test.js
// The Loops lens (card glmps-2-0-129, T5): the pure model, the mounted view over
// a stubbed catalog, and static-source rules for the lens and its stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import {
  cadence, fmtDuration, groupLoops, loopMatches, mergeSteers, nextRunText, slaFraction, statusOf, summarize,
} from '../../web/loops/model.js';
import { linkFor, parseLink, resolveTarget } from '../../web/shared/deep-link.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const js = read('web/loops/lens.js');
const model = read('web/loops/model.js');
const css = read('web/loops/loops.css');

const HOUR = 3_600_000;
const loop = (name, over = {}) => ({
  name, lastOutcome: 'done', lastRunTs: 1000, ageS: 60, consecutiveFailures: 0, lastReason: null, nextRunTs: null,
  trigger: { everyMs: 30 * 60_000 }, sla: { maxAgeMs: HOUR }, lastOkTs: 1000, streakStartTs: 1000,
  about: { group: 'ship', why: `why ${name}`, produces: `produces ${name}`, steers: [] }, ...over,
});
const CATALOG = {
  generatedAt: Date.now(),
  loops: [
    loop('launch-queue', { about: { group: 'ship', why: 'Starts queued cards', produces: 'sessions', steers: [{ card: 'prompt', mode: 'reads' }, { card: 'prompt', mode: 'writes' }, { card: 'rules', mode: 'indirect' }] } }),
    loop('merge-queue-main-suite', { lastOutcome: 'failed: shell', consecutiveFailures: 11, lastReason: 'git rev-list is not allowed', about: { group: 'ship', why: 'Runs the suite', produces: 'a verdict', steers: [] } }),
    loop('session-judge', { lastOutcome: 'nothing-to-do', trigger: { onEvent: 'outcome.finalized' }, about: { group: 'learn', why: 'Judges', produces: 'scores', steers: [{ card: 'judge', mode: 'reads' }] } }),
    loop('pages-refresh', { lastRunTs: null, lastOutcome: null, ageS: null, trigger: { external: 'cli' }, about: { group: 'feeds', why: 'Refreshes', produces: 'pages', steers: [] } }),
    loop('mystery', { about: null }),
  ],
  graphs: [{ name: 'goal-graph', builtBy: 'goal-sweeper', why: 'Shows goals', steers: [{ card: 'rules', mode: 'reads' }] }],
};
const PERSONALITY = { groups: [{ id: 'runtime', cards: [{ id: 'prompt', name: 'Card prompt template' }, { id: 'rules', name: 'Follow-up rules' }, { id: 'judge', name: 'Judge prompt' }] }] };

async function withLens(fn, { personality = PERSONALITY, catalog = CATALOG, search = '' } = {}) {
  const dom = installMiniDom({ pathname: '/loops', search });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/loops/catalog')) return { ok: true, status: 200, json: async () => catalog };
    if (String(url).includes('/api/personality')) {
      if (!personality) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => personality };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; dom.restore(); }
}

async function mountLens(route = { lens: 'loops' }, ctx = {}) {
  const { mount } = await import('../../web/loops/lens.js');
  const rootEl = document.createElement('div');
  document.body.appendChild(rootEl);
  const handle = await mount(rootEl, route, ctx);
  return { rootEl, handle };
}

const rowFor = (rootEl, name) => rootEl.querySelectorAll('.lp-row').find((r) => r.dataset.loop === name);

test('statusOf: ok, idle, failing, never ran and stale', () => {
  assert.equal(statusOf(loop('a')), 'ok');
  assert.equal(statusOf(loop('a', { lastOutcome: 'nothing-to-do' })), 'idle');
  assert.equal(statusOf(loop('a', { consecutiveFailures: 2 })), 'failing');
  assert.equal(statusOf(loop('a', { lastOutcome: 'failed: x' })), 'failing');
  assert.equal(statusOf(loop('a', { lastRunTs: null, ageS: null, lastOutcome: null })), 'never');
  assert.equal(statusOf(loop('a', { ageS: 4000 })), 'stale');
});

test('statusOf: age is the fetched age plus the time since, so a quiet loop goes stale without a refetch', () => {
  const l = loop('a', { ageS: 3500 });
  assert.equal(statusOf(l, 0), 'ok');
  assert.equal(statusOf(l, 200_000), 'stale');
});

test('cadence reads the trigger', () => {
  assert.equal(cadence({ everyMs: 30 * 60_000 }), 'every 30 min');
  assert.equal(cadence({ everyMs: 2 * HOUR }), 'every 2 h');
  assert.equal(cadence({ onEvent: 'session.condensed' }), 'on session.condensed');
  assert.equal(cadence({ external: 'cli' }), 'external');
  assert.equal(fmtDuration(36 * HOUR), '1.5 d');
});

test('mergeSteers folds reads and writes of one card into one chip and marks indirect-only', () => {
  const m = mergeSteers(CATALOG.loops[0].about.steers);
  assert.deepEqual(m.map((c) => [c.card, c.direct, c.writes]), [['prompt', true, true], ['rules', false, false]]);
  assert.deepEqual(mergeSteers(null), []);
});

test('groupLoops orders the four groups and puts undescribed loops last', () => {
  const g = groupLoops(CATALOG.loops);
  assert.deepEqual(g.map((x) => x.title), ['Ship work', 'Learn', 'Feeds and housekeeping', 'Not described']);
});

test('summarize counts statuses and mechanical loops', () => {
  const s = summarize(CATALOG.loops);
  assert.deepEqual([s.total, s.ok, s.idle, s.failing, s.never], [5, 2, 1, 1, 1]);
  assert.equal(s.steered, 2);
  assert.equal(s.mechanical, 2);
});

test('loopMatches: scope and search by loop or card name', () => {
  const nameOf = (id) => ({ prompt: 'Card prompt template' }[id] ?? id);
  const [launch, bad] = CATALOG.loops;
  assert.ok(loopMatches(launch, { q: 'prompt template' }, nameOf));
  assert.ok(!loopMatches(bad, { q: 'prompt template' }, nameOf));
  assert.ok(loopMatches(bad, { scope: 'attn' }, nameOf));
  assert.ok(!loopMatches(launch, { scope: 'attn' }, nameOf));
  assert.ok(loopMatches(launch, { scope: 'llm' }, nameOf));
  assert.ok(!loopMatches(bad, { scope: 'llm' }, nameOf));
});

test('slaFraction and nextRunText', () => {
  assert.equal(slaFraction(1800, HOUR), 0.5);
  assert.equal(slaFraction(99999, HOUR), 1);
  assert.equal(slaFraction(null, HOUR), null);
  assert.equal(nextRunText({ trigger: { onEvent: 'x' } }, 0).text, 'When x fires');
  assert.equal(nextRunText({ trigger: { everyMs: 1 }, nextRunTs: 5 * 60_000 }, 0).text, 'In 5 min');
});

test('deep link (card glmps-2-0-137): /loops is the Evolution Loops tab, a loop selection round trips, alert targets land on it', () => {
  assert.equal(parseLink('/loops', '').lens, 'learning');
  assert.equal(parseLink('/loops', '').tab, 'loops');
  const link = linkFor({ lens: 'loops', sel: { type: 'loop', id: 'session-judge' } });
  assert.equal(link, '/learning?tab=loops&sel=loop%3Asession-judge');
  assert.deepEqual(parseLink('/loops', '?sel=loop%3Asession-judge').sel, { type: 'loop', id: 'session-judge' });
  assert.equal(resolveTarget({ view: 'loops', loop: 'session-judge' }), link);
  assert.equal(resolveTarget({ view: 'loops' }), '/learning?tab=loops');
});

test('mounted: groups, status labels, failing banner, mechanical label, summary', async () => {
  await withLens(async () => {
    const { rootEl, handle } = await mountLens();
    const groups = rootEl.querySelectorAll('.lp-grp').map((g) => g.textContent);
    assert.deepEqual(groups, ['Ship work2', 'Learn1', 'Feeds and housekeeping1', 'Not described1']);
    const statuses = Object.fromEntries(rootEl.querySelectorAll('.lp-row').map((r) => [r.dataset.loop, r.querySelector('.lp-st').textContent]));
    assert.deepEqual(statuses, { 'launch-queue': 'ok', 'merge-queue-main-suite': 'failing', 'session-judge': 'idle', 'pages-refresh': 'never ran', mystery: 'ok' });
    const banner = rootEl.querySelector('.lp-banner');
    assert.match(banner.textContent, /merge-queue-main-suite failing 11 runs in a row\. git rev-list is not allowed/);
    assert.equal(rootEl.querySelectorAll('.lp-banner').length, 1);
    assert.equal(rowFor(rootEl, 'pages-refresh').querySelector('.c-runs').textContent, 'external');
    assert.equal(rowFor(rootEl, 'merge-queue-main-suite').querySelectorAll('.lp-muted').pop().textContent, 'mechanical');
    assert.equal(rowFor(rootEl, 'mystery').querySelectorAll('.lp-muted').pop().textContent, 'not described');
    assert.equal(rowFor(rootEl, 'pages-refresh').querySelector('.lp-age'), null);
    assert.match(rootEl.querySelector('.lp-summary').textContent, /5loops2ok1idle, nothing to do1failing1never ran/);
    handle.unmount();
  });
});

test('mounted: one chip per card, with the Personality name, a writes marker and a dashed indirect chip', async () => {
  await withLens(async () => {
    const { rootEl, handle } = await mountLens();
    const chips = rowFor(rootEl, 'launch-queue').querySelectorAll('.lp-chip');
    assert.equal(chips.length, 2);
    assert.match(chips[0].textContent, /^Card prompt templatewrites$/);
    assert.ok(chips[1].classList.contains('ind'));
    assert.match(chips[1].textContent, /Follow-up rules/);
    handle.unmount();
  });
});

test('mounted: a failed personality fetch shows the card id instead', async () => {
  await withLens(async () => {
    const { rootEl, handle } = await mountLens();
    assert.match(rowFor(rootEl, 'session-judge').querySelector('.lp-chip').textContent, /^judge$/);
    handle.unmount();
  }, { personality: null });
});

test('mounted: scope filter narrows rows and persists; search matches a card name', async () => {
  await withLens(async () => {
    const { rootEl, handle } = await mountLens();
    const btn = (v) => rootEl.querySelectorAll('button').find((b) => b.dataset.v === v);
    btn('attn').click();
    assert.deepEqual(rootEl.querySelectorAll('.lp-row').map((r) => r.dataset.loop), ['merge-queue-main-suite', 'pages-refresh']);
    assert.equal(localStorage.getItem('glmps.loops.scope'), 'attn');
    assert.equal(btn('attn').getAttribute('aria-pressed'), 'true');
    btn('llm').click();
    assert.deepEqual(rootEl.querySelectorAll('.lp-row').map((r) => r.dataset.loop), ['launch-queue', 'session-judge']);
    btn('all').click();
    const input = rootEl.querySelector('.lp-search');
    input.value = 'judge prompt';
    input.dispatchEvent(new MiniEvent('input', { bubbles: true }));
    assert.deepEqual(rootEl.querySelectorAll('.lp-row').map((r) => r.dataset.loop), ['session-judge']);
    input.value = 'zzz';
    input.dispatchEvent(new MiniEvent('input', { bubbles: true }));
    assert.equal(rootEl.querySelectorAll('.lp-row').length, 0);
    assert.match(rootEl.querySelector('.lp-none').textContent, /No loops match these filters\. Clear filters/);
    handle.unmount();
  });
});

test('mounted: a row opens in place with produces, why, last error, next run and card links; keyboard toggles and arrows move focus', async () => {
  const went = [];
  await withLens(async () => {
    const { rootEl, handle } = await mountLens({ lens: 'loops' }, { go: (l) => went.push(l) });
    const row = rowFor(rootEl, 'merge-queue-main-suite');
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.equal(row.getAttribute('tabindex'), '0');
    row.click();
    const open = rowFor(rootEl, 'merge-queue-main-suite');
    assert.equal(open.getAttribute('aria-expanded'), 'true');
    const detail = rootEl.querySelector('.lp-detail');
    assert.match(detail.textContent, /Producesa verdict/);
    assert.match(detail.textContent, /Last errorgit rev-list is not allowed/);
    assert.match(detail.textContent, /Next run/);
    assert.match(detail.textContent, /Mechanical/);
    assert.equal(open.getAttribute('aria-controls'), detail.id);

    const launch = rowFor(rootEl, 'launch-queue');
    launch.dispatchEvent(new MiniEvent('keydown', { key: 'Enter', bubbles: true }));
    const link = rootEl.querySelector('.lp-card-link');
    assert.equal(link.textContent, 'Card prompt template');
    assert.equal(link.href, '/learning?tab=capabilities&seg=files&sel=card%3Aprompt');
    link.dispatchEvent(new MiniEvent('click', { bubbles: true }));
    assert.deepEqual(went, ['/learning?tab=capabilities&seg=files&sel=card%3Aprompt']);

    rowFor(rootEl, 'launch-queue').dispatchEvent(new MiniEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement.dataset.loop, 'merge-queue-main-suite');
    rowFor(rootEl, 'merge-queue-main-suite').dispatchEvent(new MiniEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    assert.equal(document.activeElement.dataset.loop, 'launch-queue');
    rowFor(rootEl, 'launch-queue').dispatchEvent(new MiniEvent('keydown', { key: ' ', bubbles: true }));
    assert.equal(rootEl.querySelectorAll('.lp-detail').length, 1, 'space closed the launch-queue row');
    handle.unmount();
  });
});

test('mounted: a loop selection in the route opens and focuses that row, clearing a filter that hid it', async () => {
  await withLens(async () => {
    localStorage.setItem('glmps.loops.scope', 'attn');
    const { rootEl, handle } = await mountLens({ lens: 'loops', sel: { type: 'loop', id: 'session-judge' } });
    const row = rowFor(rootEl, 'session-judge');
    assert.ok(row, 'the filter was cleared so the row is visible');
    assert.equal(row.getAttribute('aria-expanded'), 'true');
    assert.equal(row._scrolled, true);
    assert.equal(document.activeElement.dataset.loop, 'session-judge');
    handle.update({ lens: 'loops', sel: { type: 'loop', id: 'launch-queue' } });
    assert.equal(rowFor(rootEl, 'launch-queue').getAttribute('aria-expanded'), 'true');
    handle.update({ lens: 'loops', sel: { type: 'loop', id: 'nope' } });
    assert.match(rootEl.querySelector('.lp-note').textContent, /No loop called "nope"/);
    handle.unmount();
  });
});

// Card glmps-2-0-137 phase 5 (story 28): the Graphs table moved to Knowledge >
// Architecture graph (lens-knowledge.test.js asserts it there).
test('mounted: the Graphs table is no longer on Loops', async () => {
  await withLens(async () => {
    const { rootEl, handle } = await mountLens();
    assert.equal(rootEl.querySelector('.lp-graphs'), null);
    handle.unmount();
  });
});

test('mounted: a catalog failure shows an alert with a retry, not a blank page', async () => {
  const dom = installMiniDom({ pathname: '/loops' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    const { rootEl, handle } = await mountLens();
    const err = rootEl.querySelector('.lp-error');
    assert.equal(err.getAttribute('role'), 'alert');
    assert.match(err.textContent, /Could not load the loops/);
    assert.ok(err.querySelector('button'));
    handle.unmount();
  } finally { globalThis.fetch = realFetch; dom.restore(); }
});

test('the lens never assigns innerHTML with data and builds content with textContent', () => {
  for (const src of [js, model]) {
    assert.equal(/\.innerHTML\s*=/.test(src), false);
    assert.equal(src.includes('insertAdjacentHTML'), false);
    assert.equal(src.includes('outerHTML'), false);
  }
  assert.ok(js.includes('textContent'));
});

test('the stylesheet uses tokens: no hex literal, no raw sub-floor font size, the spacing scale, a focus style', () => {
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
  for (const m of css.match(/font-size:\s*\d+px/g) ?? []) assert.fail(`raw font-size ${m}; use a --fs-* token`);
  assert.ok(css.includes('var(--sp-'));
  assert.ok(css.includes(':focus-visible'));
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.c-runs, \.c-why \{ display: none; \}/);
});

test('sources have no em or en dashes and are ASCII', () => {
  for (const [n, src] of Object.entries({ js, model, css })) {
    assert.equal(/[^\x00-\x7f]/.test(src), false, `${n} has a non-ASCII character`);
  }
});

test('wiring (card glmps-2-0-137): Evolution carries the Loops and Personality sheets, the nav has no Loops link, deep-link folds both in', () => {
  assert.match(read('web/app.js'), /registerView\('learning', \{ label: 'Evolution'[\s\S]*?'\/loops\/loops\.css', '\/personality\/personality\.css'\]/);
  assert.doesNotMatch(read('web/index.html'), /href="\/loops"|href="\/personality"/);
  assert.match(read('web/shared/deep-link.js'), /FOLDED_LENSES = Object\.freeze\(\{\s*loops: \{ lens: 'learning', tab: 'loops' \}/);
});

test('the Personality "Used by" row links each loop to its Loops row', async () => {
  const dom = installMiniDom({ pathname: '/personality' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ groups: [{ id: 'runtime', name: 'Runtime', sub: '', order: '', cards: [{ id: 'prompt', name: 'Card prompt template', controls: 'x', usedBy: ['launch-queue', 'nightly-run'], usedByGraphs: ['goal-graph'], path: '/x' }] }] }) });
  const went = [];
  try {
    const { mount } = await import('../../web/personality/lens.js');
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    const h = await mount(rootEl, { lens: 'personality', sel: { type: 'card', id: 'prompt' } }, { go: (l) => went.push(l) });
    const links = rootEl.querySelectorAll('.pers-loop-link');
    assert.deepEqual(links.map((a) => a.href), ['/learning?tab=loops&sel=loop%3Alaunch-queue', '/learning?tab=loops&sel=loop%3Anightly-run']);
    links[0].dispatchEvent(new MiniEvent('click', { bubbles: true }));
    assert.deepEqual(went, ['/learning?tab=loops&sel=loop%3Alaunch-queue']);
    assert.equal(rootEl.querySelector('.pers-card').getAttribute('open'), '', 'the selected card opens');
    h.unmount();
  } finally { globalThis.fetch = realFetch; dom.restore(); }
});
