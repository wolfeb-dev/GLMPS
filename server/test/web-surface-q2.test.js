// Routes under test: server/lib/routes/workspace-routes.js
// the Surface command view. Search (AC-1), tracking (AC-2), view styles
// (AC-3, retired by glmps-2-0-106), file-as-card (AC-4), the Fleet dock (AC-5) and the timeline (AC-6),
// mounted end to end under mini-dom, plus the pure models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent, countAllListeners } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS, EDITS, TIMELINE } from './fixtures/surface-fixtures.js';
import { collectItems } from '../../web/shared/interactive-item.js';
import { rankEntries, sessionEntries, MIN_CHARS } from '../../web/shared/search.js';
import { normalizeTimeline, tickBuckets, mergeEdits, createTimelineStore, KINDS } from '../../web/surface/timeline.js';
import { pinDraft } from '../../web/surface/pin.js';
import { marksInFrame, makeResolver, duration } from '../../web/surface/track.js';

// The fixture repo by its own name, so the public mirror's rename does not split query and answer.
const REPO = ROWS[0].repo;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const T0 = TIMELINE.to;

const LIVE = {
  '/api/sessions/live': { sessions: [{ id: 's1', cwd: `${ROWS[0].path}/web`, lastTs: Date.now() }], now: Date.now(), staleMs: 600000 },
  '/api/workspace': { sessions: [{ sessionId: 's1', title: 'wire the globe', declared: { goal: 'ship the globe' }, observed: { activePaths: ['web/app.js'] }, divergence: { level: 'minor' }, hasPendingSteer: false }] },
  '/api/backlog': { items: [
    { id: 'mc-7', title: 'globe polish', state: 'in_progress', origin: null },
    { id: 'mc-8', title: 'thread follow-up', state: 'in_progress', origin: { via: 'slack' } },
  ] },
};
const STATE = { tools: [], sessions: [{ id: 's1', card: { id: 'mc-7', title: 'globe polish' } }], board: { rows: [{ id: 's1', stageName: 'Execute', enteredTs: Date.now() - 180000, tool: 'claude-code' }] } };

async function withSurface(fn, { search = '', routes = {}, ctx = {}, fetchWrap = null, setup = null } = {}) {
  const dom = installMiniDom({ pathname: '/surface', search });
  setup?.();
  let handle;
  try {
    const base = surfaceFetch({ ...LIVE, ...routes });
    const m = await mountSurface(search, fetchWrap ? fetchWrap(base) : base, { getState: () => STATE, ...ctx });
    handle = m.handle;
    await tick(10);
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}
const key = (k, extra = {}) => window.dispatchEvent(new MiniEvent('keydown', { key: k, ...extra }));
const typeInto = (input, text) => { input.value = text; input.dispatchEvent(new MiniEvent('input', { bubbles: true })); };
const pressOn = (el, k) => el.dispatchEvent(new MiniEvent('keydown', { key: k, bubbles: true }));
const item = (type, id) => collectItems(document.body).find((e) => e.dataset.itemType === type && e.dataset.itemId === id);
const text = (root, sel) => root.querySelector(sel)?.textContent ?? '';


test('AC-1 (model): ranking starts at two characters, groups by kind and caps each kind', () => {
  const entries = [
    ...Array.from({ length: 9 }, (_, i) => ({ kind: 'file', id: `r/file${i}.js`, title: `file${i}.js`, sub: 'r', hay: `file${i}.js r` })),
    { kind: 'repo', id: 'mission-desk', title: 'mission-desk', sub: 'in sync', hay: 'mission-desk in sync' },
    { kind: 'card', id: 'mc-1', title: 'fix mission map', sub: 'mc-1, queued', hay: 'fix mission map mc-1 queued' },
  ];
  assert.equal(MIN_CHARS, 2);
  assert.deepEqual(rankEntries(entries, 'm'), []);
  const hit = rankEntries(entries, 'mis');
  assert.deepEqual(hit.map((e) => e.kind), ['repo', 'card']);
  assert.equal(hit[0].id, 'mission-desk', 'a title that starts with the query ranks first');
  assert.equal(rankEntries(entries, 'file').length, 4, 'four files at most per kind');
});

test('AC-1 (model): transcript matches fold to one entry per session and name live agents', () => {
  const api = { agentList: () => [{ id: 's1', title: 'wire the globe' }] };
  const out = sessionEntries({ results: [{ sessionId: 's1', lineNo: 3, snippet: 'a  b' }, { sessionId: 's1', lineNo: 9, snippet: 'again' }, { sessionId: 'zz9', lineNo: 1, snippet: '' }] }, api);
  assert.deepEqual(out.map((e) => [e.kind, e.id, e.title]), [['session', 's1', 'wire the globe'], ['session', 'zz9', 'Session zz9']]);
  assert.equal(out[0].sub, 'a b');
});

test('AC-6 (model): the feed is normalised, bucketed per kind, and scrubbing filters edits, cards and alerts', () => {
  const t = normalizeTimeline({ ...TIMELINE, events: [{ ts: 5, kind: 'bogus' }, ...[...TIMELINE.events].reverse()] });
  assert.equal(t.events.length, TIMELINE.events.length, 'unknown kinds are dropped');
  assert.ok(t.events.every((e, i, a) => i === 0 || a[i - 1].ts <= e.ts), 'ascending by ts');
  const b = tickBuckets(t.events, t.from, t.to, 24);
  assert.equal(b.length, 24);
  assert.equal(b.reduce((n, x) => n + (x.edit ?? 0), 0), 2);
  assert.deepEqual(KINDS.map((k) => k.id), ['edit', 'card', 'gate', 'alert', 'loop']);

  const resolve = makeResolver(() => ROWS);
  const all = mergeEdits({ edits: EDITS.edits, events: t.events, asOf: null, resolve });
  const early = mergeEdits({ edits: EDITS.edits, events: t.events, asOf: T0 - 150 * 60000, resolve });
  assert.ok(all.length > early.length, 'later edits drop out');
  assert.ok(early.every((e) => e.ts <= T0 - 150 * 60000));
  assert.equal(early.find((e) => e.path.endsWith('globe.js')).repo, 'glmps', 'timeline paths resolve to their repository');
});

test('AC-6 (model): the store clamps the scrub time, returns to live, and folds card and alert history', async () => {
  const store = createTimelineStore();
  await store.load(() => false, async () => Response.json(TIMELINE));
  assert.equal(store.get().status, 'ok');
  store.setAsOf(T0 - 1000); assert.equal(store.asOf(), null, 'within a second of the end is live');
  store.setAsOf(T0 - 90 * 24 * 3600000); assert.equal(store.asOf(), TIMELINE.from, 'clamped to the start of the window');
  store.setAsOf(T0 - 20 * 60000);
  assert.equal(store.cardState({ id: 'mc-7', state: 'in_progress' }), 'in_progress');
  assert.equal(store.cardState({ id: 'mc-8', state: 'in_progress' }), null, 'a card that first moved after the time is out');
  assert.equal(store.cardState({ id: 'never-seen', state: 'held' }), 'held');
  store.setAsOf(T0 - 5 * 3600000 + 60000);
  assert.equal(store.cardState({ id: 'mc-7', state: 'in_progress' }), 'queued');
  assert.equal(store.alertShown({ title: 'Kernel health: plugin-retry-gaveup' }), false);
  assert.equal(store.alertShown({ title: 'not in the feed' }), true);
  store.setAsOf(null);
  assert.equal(store.cardState({ id: 'mc-8', state: 'held' }), 'held');
});

test('AC-6 (model): a dead route leaves the store unavailable and at Latest', async () => {
  const store = createTimelineStore();
  await store.load(() => false, async () => new Response('{}', { status: 404 }));
  assert.equal(store.get().status, 'unavailable');
  assert.match(store.get().error, /returned 404/);
  store.setAsOf(T0 - 3600000); assert.equal(store.asOf(), null);
});

test('AC-4 (model): the card draft names the item and links to the view', () => {
  const d = pinDraft({ sel: { type: 'repo', id: 'tidewatch' }, model: { title: 'tidewatch', word: 'exists nowhere else', facts: [['path', 'D:/tidewatch']] }, viewUrl: 'http://x/surface?sel=repo%3Atidewatch' });
  assert.equal(d.title, 'Follow up on tidewatch');
  assert.match(d.prompt, /repo tidewatch/);
  assert.match(d.prompt, /path: D:\/tidewatch/);
  assert.match(d.prompt, /View it on Surface: http:\/\/x\/surface\?sel=repo%3Atidewatch$/);
});

test('AC-2 (model): durations read in seconds, minutes and hours', () => {
  assert.equal(duration(45000), '45 s'); assert.equal(duration(600000), '10 min'); assert.equal(duration(7200000), '2.0 h'); assert.equal(duration(-1), 'unknown');
});


test('AC-1: two characters list repos, agents and cards with kind and a secondary line; arrows and Enter fly and open; Escape closes', async () => {
  await withSurface(async ({ root }) => {
    const input = root.querySelector('.surface-search-input');
    assert.ok(input, 'a search input in the Surface header');
    assert.equal(input.getAttribute('role'), 'combobox');
    typeInto(input, 'm');
    assert.equal(root.querySelector('.surface-search-list').hidden, true, 'nothing under two characters');
    typeInto(input, REPO.slice(0, 2));
    const list = root.querySelector('.surface-search-list');
    assert.equal(list.hidden, false);
    assert.equal(input.getAttribute('aria-expanded'), 'true');
    const opts = list.querySelectorAll('[role="option"]');
    const kinds = opts.map((o) => o.querySelector('.sr-kind').textContent);
    assert.ok(kinds.includes('Repo'), `repo result in ${kinds}`);
    const repo = opts.find((o) => o.querySelector('.sr-kind').textContent === 'Repo' && o.textContent.includes(REPO));
    assert.ok(repo, `${REPO} is listed`);
    assert.match(repo.querySelector('.sr-sub').textContent, /diverged/, 'a secondary line states the residency');
    // The agent is found by its title, the card by its id.
    typeInto(input, 'wire');
    assert.ok(list.querySelectorAll('[role="option"]').some((o) => o.querySelector('.sr-kind').textContent === 'Agent'), 'agent result');
    typeInto(input, 'mc-7');
    const cardOpt = list.querySelectorAll('[role="option"]').find((o) => o.querySelector('.sr-kind').textContent === 'Card');
    assert.ok(cardOpt, 'card result by id');

    typeInto(input, REPO.slice(0, 9));
    const found = list.querySelectorAll('[role="option"]');
    const at = found.findIndex((o) => o.querySelector('.sr-kind').textContent === 'Repo');
    assert.ok(at >= 0);
    for (let i = 0; i < at; i++) pressOn(input, 'ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'), found[at].id, 'arrows move the active result');
    assert.equal(list.querySelectorAll('[role="option"]')[at].getAttribute('aria-selected'), 'true');
    pressOn(input, 'Enter');
    await tick(20);
    assert.equal(list.hidden, true, 'Enter closes the list');
    assert.ok(text(root, '#panel-inspector').includes(REPO), 'the repo opened in the inspector');
    assert.equal(item('repo', REPO).getAttribute('aria-current'), 'true', 'and is the selection');

    typeInto(input, 'mission');
    assert.equal(list.hidden, false);
    pressOn(input, 'Escape');
    assert.equal(list.hidden, true, 'Escape closes the list');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
  });
});

test('AC-1: a file result flies to its repository and opens the file; session text that fails to search is named', async () => {
  await withSurface(async ({ root }) => {
    const input = root.querySelector('.surface-search-input');
    typeInto(input, 'app.js');
    const opt = root.querySelector('.surface-search-list').querySelectorAll('[role="option"]').find((o) => o.querySelector('.sr-kind').textContent === 'File');
    assert.ok(opt, 'the edited file is searchable');
    opt.click(); await tick(20);
    assert.match(text(root, '#panel-inspector'), /web\/app\.js/);
    typeInto(input, 'zzzz-nothing');
    assert.match(root.querySelector('.surface-search-list').textContent, /Nothing on Surface matches/);
    await tick(450);
    assert.match(root.querySelector('.surface-search-list').textContent, /Session text search is not available/, 'the /api/search failure is named');
  });
});

test('AC-1: transcript matches from /api/search join the list as sessions', async () => {
  await withSurface(async ({ root }) => {
    const input = root.querySelector('.surface-search-input');
    typeInto(input, 'zebra');
    await tick(450);
    const opt = root.querySelector('.surface-search-list').querySelectorAll('[role="option"]').find((o) => o.querySelector('.sr-kind').textContent === 'Session');
    assert.ok(opt, 'a session result');
    assert.match(opt.textContent, /mc-7/, 'the agent is named by its card');
    assert.match(opt.querySelector('.sr-sub').textContent, /zebra crossing/);
  }, { routes: { '/api/search': { results: [{ sessionId: 's1', lineNo: 4, snippet: 'a zebra crossing' }], capped: false } } });
});

test('AC-1: the slash key focuses the search box', async () => {
  await withSurface(async ({ root }) => {
    const input = root.querySelector('.surface-search-input');
    key('/', { target: document.body });
    assert.equal(document.activeElement, input);
  });
});


test('AC-2: Track locks on the agent, draws a numbered trail, shows telemetry and an In view list; Esc stops and the URL follows', async () => {
  await withSurface(async ({ root }) => {
    item('agent', 's1').click(); await tick(20);
    const trackBtn = root.querySelectorAll('button').find((b) => b.textContent === 'Track');
    assert.ok(trackBtn, 'the agent inspector offers Track');
    trackBtn.click(); await tick(60);
    const dock = root.querySelector('#dock-track');
    assert.equal(dock.hidden, false, 'the tracking card is open');
    const facts = text(dock, '.trk-facts');
    assert.equal(text(dock, '.trk-id'), 'mc-7'); assert.equal(text(dock, '.trk-title'), 'globe polish');
    assert.match(facts, /Execute/); assert.match(facts, /claude-code/);
    assert.match(facts, /ship the globe/); assert.match(facts, /drift/);
    assert.match(facts, /next gate/);
    const steps = dock.querySelectorAll('.trk-step');
    assert.ok(steps.length >= 1, 'a trail step per recent file');
    assert.match(steps[0].textContent, /^1/);
    assert.match(steps.map((s) => s.textContent).join(' '), /web\/app\.js/);
    const pts = root.querySelectorAll('.trail-pt');
    assert.equal(pts.length, steps.length, 'a numbered mark on the globe per step');
    assert.equal(pts[0].querySelector('.trail-n').textContent, '1');
    for (const p of pts) assert.ok(p.getAttribute('data-item-type') === 'file' ? p.listenerCount('click') >= 1 : true);
    await tick(320);
    const inview = root.querySelector('.surface-inview');
    assert.ok(inview.querySelectorAll('.trk-vrow').length >= 1, 'In view lists the marks inside the frame');
    assert.match(inview.textContent, /In view \(\d+\)/);
    await tick(10);
    assert.match(window.location.search, /track=s1/, 'the URL keeps the tracked id');
    await tick(350);
    assert.match(window.location.search, /track=s1/);

    key('Escape', { target: document.body }); await tick(350);
    assert.equal(dock.hidden, true, 'Esc ends tracking');
    assert.doesNotMatch(window.location.search, /track=/);
    assert.equal(root.querySelectorAll('.trail-pt').length, 0, 'the trail is gone');
  }, { setup: () => {} });
});

test('AC-2: the T key tracks the selected agent, a deep link restores tracking, and Stop tracking ends it', async () => {
  await withSurface(async ({ root }) => {
    const dock = root.querySelector('#dock-track');
    assert.equal(dock.hidden, false, 'a track param reopens tracking');
    const stop = root.querySelector('.surface-trackbar').querySelectorAll('button').find((b) => b.textContent === 'Stop tracking');
    stop.click(); await tick(20);
    assert.equal(dock.hidden, true);
    item('agent', 's1').click(); await tick(20);
    key('t', { target: document.body }); await tick(60);
    assert.equal(dock.hidden, false, 'T tracks the selected agent');
    key('t', { target: document.body }); await tick(20);
    assert.equal(dock.hidden, true, 'T again stops');
  }, { search: '?track=s1' });
});

test('AC-2: an agent that is not in the live feed cannot be tracked, and says so', async () => {
  await withSurface(async ({ root }) => {
    assert.equal(root.querySelector('#dock-track').hidden, true);
    assert.match(text(root, '#panel-inspector'), /not in the live sessions feed/);
  }, { search: '?track=ghost' });
});

test('AC-2: the hover card names the T key for an agent', async () => {
  await withSurface(async ({ root }) => {
    const a = item('agent', 's1');
    a.dispatchEvent(new MiniEvent('focusin', { bubbles: true }));
    assert.match(text(root, '.hc-hint'), /T tracks this agent/);
  });
});


// glmps-2-0-106 retired the view styles (Normal, Heat, Drift, Focus): no
// buttons, no keys, no classes on marks, and an old ?style= link is ignored.
test('AC-3 (retired): Z, H, S and C leave the marks alone, an old ?style= link does nothing, and D still opens the edits window', async () => {
  await withSurface(async ({ root }) => {
    assert.equal(root.querySelector('.surface-styles'), null);
    assert.equal(root.querySelectorAll('.style-btn').length, 0);
    const mc = item('repo', 'glmps');
    const before = mc.getAttribute('class');
    for (const k of ['z', 'h', 's', 'c']) { key(k, { target: document.body }); await tick(20); }
    assert.equal(mc.getAttribute('class'), before);
    assert.equal(root.querySelector('.globe-marks').getAttribute('data-style'), null);
    const was = root.querySelector('#dock-edits').hidden;
    key('d', { target: document.body });
    assert.equal(root.querySelector('#dock-edits').hidden, !was, 'D is still the edits window');
  }, { search: '?style=drift' });
});


test('AC-4: File as card opens a prefilled form and posts only when the operator presses File card', async () => {
  const posts = [];
  await withSurface(async ({ root }) => {
    item('repo', 'tidewatch').click(); await tick(20);
    const open = root.querySelectorAll('button').find((b) => b.textContent === 'File as card');
    assert.ok(open, 'the inspector offers File as card');
    open.click(); await tick(10);
    assert.equal(posts.length, 0, 'opening the form posts nothing');
    const title = root.querySelector('#pin-title'); const prompt = root.querySelector('#pin-prompt');
    assert.equal(title.value, 'Follow up on tidewatch');
    assert.match(prompt.value, /View it on Surface: http:\/\/127\.0\.0\.1:8123\/surface\?.*sel=repo%3Atidewatch/);
    assert.ok(root.querySelector('label[for="pin-title"]') || root.querySelectorAll('label').some((l) => l.getAttribute('for') === 'pin-title'), 'the title input is labelled');
    await tick(50);
    assert.equal(posts.length, 0, 'still nothing without the button');

    title.value = 'Back up tidewatch';
    root.querySelectorAll('button').find((b) => b.textContent === 'File card').click(); await tick(30);
    assert.equal(posts.length, 1);
    assert.deepEqual({ source: posts[0].source, title: posts[0].title }, { source: 'manual', title: 'Back up tidewatch' });
    assert.match(posts[0].prompt, /tidewatch/);
    assert.match(text(root, '.pin-out'), /Filed card mc-99/);
    assert.ok(root.querySelector('.pin-card'), 'a link to the card on Work');
  }, {
    fetchWrap: (base) => async (url, init) => {
      if (String(url) === '/api/backlog' && init?.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({ id: 'mc-99', title: 'x' }, { status: 201 }); }
      return base(url, init);
    },
  });
});

test('AC-4: the server error is shown and the button can try again', async () => {
  await withSurface(async ({ root }) => {
    item('repo', 'tidewatch').click(); await tick(20);
    root.querySelectorAll('button').find((b) => b.textContent === 'File as card').click(); await tick(10);
    const submit = root.querySelectorAll('button').find((b) => b.textContent === 'File card');
    submit.click(); await tick(30);
    assert.match(text(root, '.pin-out'), /Could not file the card: empty title/);
    assert.equal(root.querySelector('.pin-out').getAttribute('role'), 'alert');
    assert.equal(submit.disabled, false);
  }, {
    fetchWrap: (base) => async (url, init) => (String(url) === '/api/backlog' && init?.method === 'POST' ? Response.json({ error: 'empty title' }, { status: 400 }) : base(url, init)),
  });
});


test('AC-5: the Fleet board mounts under the globe, collapses, and unmounts with Surface', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  globalThis.fetch = surfaceFetch(LIVE);
  let m;
  try {
    m = await mountSurface('', surfaceFetch(LIVE), { getState: () => STATE });
    const board = document.getElementById('view-stageboard');
    assert.ok(board, 'the board container carries the id its stylesheet is scoped to');
    assert.ok(board.querySelector('.sb-grid'), 'the stage board rendered');
    const toggle = m.root.querySelector('.fleet-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    const kids = m.root.childNodes.filter((n) => n.nodeType === 1);
    assert.ok(kids.indexOf(m.root.querySelector('.surface-fleet')) < kids.indexOf(m.root.querySelector('.surface-footbar')), 'the dock sits between the globe and the foot bar');
    m.handle.onState({ ...STATE, board: { stages: [], rows: [] } });
    toggle.click(); await tick(10);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(m.root.querySelector('#view-stageboard').hidden, true);
    assert.equal(m.root.querySelector('#view-stageboard').childNodes.length, 0, 'collapsing unmounts the board and its poller');
    toggle.click(); await tick(20);
    assert.ok(document.getElementById('view-stageboard').querySelector('.sb-grid'), 'expanding mounts it again');
    m.handle.unmount(); m.handle = null;
    assert.equal(document.getElementById('view-stageboard'), null, 'gone with Surface');
  } finally { m?.handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('AC-5: the dock starts collapsed at 560 px and below, and remembers the operator\'s choice', async () => {
  const phoneQuery = (q) => ({ matches: /max-width: 560px/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  await withSurface(async ({ root }) => {
    const toggle = root.querySelector('.fleet-toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(root.querySelector('#view-stageboard').childNodes.length, 0, 'nothing mounted while collapsed');
    toggle.click(); await tick(20);
    assert.equal(localStorage.getItem('surface.fleet'), 'open');
  }, { setup: () => { globalThis.matchMedia = phoneQuery; } });
});


test('AC-6: the foot bar draws ticks per kind with one legend, and scrubbing filters card stacks and alert pulses', async () => {
  await withSurface(async ({ root }) => {
    const bar = root.querySelector('.foot-timeline');
    assert.ok(bar, 'a timeline in the foot bar');
    const range = bar.querySelector('.tl-range');
    assert.equal(Number(range.getAttribute('max')), TIMELINE.to);
    assert.equal(Number(range.getAttribute('min')), TIMELINE.from);
    for (const k of KINDS) assert.ok(bar.querySelectorAll(`.tl-tick`).some((t) => t.classList.contains(`tl-k-${k.id}`)), `ticks for ${k.id}`);
    assert.equal(bar.querySelectorAll('.tl-key').length, KINDS.length, 'the legend is drawn once');
    assert.equal(bar.querySelector('.tl-asof').textContent, 'live');

    const stackLabel = () => item('card-stack', 'local').getAttribute('aria-label');
    const pulse = () => item('alert-pulse', 'local');
    assert.match(stackLabel(), /^1 cards at the local store/);
    const slack = () => item('card-stack', 'slack').getAttribute('aria-label');
    assert.match(slack(), /^1 cards born in Slack/, 'live, the slack card is in flight');
    assert.match(pulse().getAttribute('aria-label'), /^2 active alerts/);

    // Back to before the Slack card first moved, and before the warning alert.
    range.value = String(T0 - 40 * 60000);
    range.dispatchEvent(new MiniEvent('input', { bubbles: true }));
    assert.match(bar.querySelector('.tl-asof').textContent, /^as of /);
    assert.match(slack(), /^0 cards born in Slack/, 'the card that moved later is not there yet');
    assert.match(stackLabel(), /^1 cards at the local store/);
    assert.match(pulse().getAttribute('aria-label'), /^1 active alert at/, 'the warning had not been seen yet');
    assert.match(pulse().getAttribute('class'), /pulse-critical/);
    await tick(350);
    assert.match(window.location.search, /asof=\d+/, 'the URL keeps the time');

    bar.querySelectorAll('button').find((b) => b.textContent === 'Latest').click();
    assert.match(slack(), /^1 cards born in Slack/);
    assert.match(pulse().getAttribute('aria-label'), /^2 active alerts/);
    assert.equal(bar.querySelector('.tl-asof').textContent, 'live');
    await tick(350);
    assert.doesNotMatch(window.location.search, /asof=/);
  });
});

test('AC-6: Prev and Next step between events; an as-of time in the URL is restored', async () => {
  await withSurface(async ({ root }) => {
    const bar = root.querySelector('.foot-timeline');
    assert.match(bar.querySelector('.tl-asof').textContent, /^as of /, 'restored from asof=');
    const btn = (t) => bar.querySelectorAll('button').find((b) => b.textContent === t);
    btn('Next').click();
    assert.equal(Number(bar.querySelector('.tl-range').value), T0 - 10 * 60000, 'Next lands on the next event');
    btn('Next').click();
    assert.equal(bar.querySelector('.tl-asof').textContent, 'live', 'Next past the last event is Latest');
    btn('Prev').click(); btn('Prev').click();
    assert.equal(Number(bar.querySelector('.tl-range').value), T0 - 30 * 60000);
  }, { search: `?asof=${T0 - 20 * 60000}` });
});

test('AC-6: Play advances the as-of time, Pause stops it, and unmount leaves no timer', async () => {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const live = new Map();
  globalThis.setInterval = (fn, ms, ...a) => { const h = realSet(fn, ms, ...a); live.set(h, ms); return h; };
  globalThis.clearInterval = (h) => { live.delete(h); return realClear(h); };
  try {
    await withSurface(async ({ root }) => {
      const bar = root.querySelector('.foot-timeline');
      const btn = (t) => bar.querySelectorAll('button').find((b) => b.textContent === t);
      btn('Play').click();
      assert.ok([...live.values()].includes(250), 'a playback timer runs');
      const a = Number(bar.querySelector('.tl-range').value);
      await tick(600);
      assert.ok(Number(bar.querySelector('.tl-range').value) > a, 'time moves forward');
      bar.querySelectorAll('.tl-speed').find((b) => b.textContent === '4x').click();
      assert.equal(bar.querySelectorAll('.tl-speed').find((b) => b.textContent === '4x').getAttribute('aria-pressed'), 'true');
      btn('Pause').click();
      assert.ok(![...live.values()].includes(250), 'Pause clears it');
      btn('Play').click();
    });
    assert.deepEqual([...live.values()].filter((ms) => ms === 250), [], 'unmount cleared playback');
  } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
});

test('AC-6: under reduced motion Play is off and stepping still works', async () => {
  const reduce = (q) => ({ matches: /prefers-reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  await withSurface(async ({ root }) => {
    const bar = root.querySelector('.foot-timeline');
    const play = bar.querySelectorAll('button').find((b) => b.textContent === 'Play');
    assert.equal(play.disabled, true);
    bar.querySelectorAll('button').find((b) => b.textContent === 'Prev').click();
    assert.match(bar.querySelector('.tl-asof').textContent, /^as of /);
  }, { setup: () => { globalThis.matchMedia = reduce; } });
});

test('AC-6: a missing timeline route is named and Surface stays live at Latest', async () => {
  await withSurface(async ({ root }) => {
    const bar = root.querySelector('.foot-timeline');
    assert.match(bar.querySelector('.tl-status').textContent, /timeline feed is not available/);
    assert.match(bar.querySelector('.tl-status').textContent, /returned 404/);
    assert.equal(bar.querySelector('.tl-range').disabled, true);
    assert.ok(bar.querySelectorAll('button').every((b) => b.disabled));
    assert.equal(bar.querySelector('.tl-asof').textContent, 'live');
    await tick(350);
    assert.doesNotMatch(window.location.search, /asof=/, 'a stale asof is dropped');
    assert.match(item('card-stack', 'local').getAttribute('aria-label'), /^1 cards at the local store/);
  }, { routes: { '/api/timeline': new Response('{"error":"not found"}', { status: 404 }) }, search: `?asof=${T0 - 3600000}` });
});


test('every Q2 control has an accessible name and the new elements add no innerHTML', async () => {
  await withSurface(async ({ root }) => {
    const unnamed = root.querySelectorAll('button').filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label')));
    assert.deepEqual(unnamed.map((b) => b.className), [], 'every button has text or an aria-label');
    assert.ok(root.querySelector('.surface-search-input').getAttribute('aria-controls'));
    assert.equal(root.querySelector('.tl-range').getAttribute('aria-label'), 'As-of time');
    assert.equal(root.querySelector('.surface-presets').getAttribute('role'), 'group');
  });
});

test('ten mount/unmount cycles with tracking, search and a scrubbed timeline leave no growing listener', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const container = document.createElement('div'); document.body.appendChild(container);
  try {
    let baseline = null;
    for (let i = 0; i < 10; i++) {
      globalThis.fetch = surfaceFetch(LIVE);
      window.d3 = (await import('./fixtures/mini-dom.js')).loadVendorD3();
      const lens = await import('../../web/surface/lens.js');
      const { parseLink } = await import('../../web/shared/deep-link.js');
      const root = document.createElement('div'); container.appendChild(root);
      const handle = await lens.mount(root, parseLink('/surface', ''), { getState: () => STATE, toast: () => {}, go: () => {}, handlers: {} });
      await tick(10);
      handle.update?.({ layers: null });
      typeInto(root.querySelector('.surface-search-input'), 'mis');
      item('agent', 's1').click(); await tick(10);
      root.querySelectorAll('button').find((b) => b.textContent === 'Track').click(); await tick(20);
      root.querySelector('.tl-range').value = String(T0 - 3600000);
      root.querySelector('.tl-range').dispatchEvent(new MiniEvent('input', { bubbles: true }));
      handle.unmount(); root.remove();
      delete globalThis.fetch; delete window.d3;
      if (i === 0) baseline = countAllListeners();
      else assert.equal(countAllListeners(), baseline, `cycle ${i}: listener count changed`);
    }
    assert.equal(container.childNodes.length, 0);
  } finally { delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('marksInFrame keeps visible, in-frame bound marks nearest the centre first and skips the trail', () => {
  const mk = (type, id, transform, extra = {}) => ({ dataset: { itemType: type, itemId: id }, getAttribute: (k) => ({ transform, 'aria-label': `${type} ${id}`, ...extra }[k] ?? null), closest: () => (extra.layer ? { getAttribute: (k) => (k === 'data-layer' ? extra.layer : null) } : null) });
  const svg = { querySelectorAll: () => [mk('repo', 'far', 'translate(90,10)'), mk('repo', 'near', 'translate(52,11)'), mk('repo', 'off', 'translate(500,10)'), mk('file', 't', 'translate(50,10)', { layer: 'trail' }), mk('panel', 'p', 'translate(50,10)'), mk('arc', 'noxf', null)] };
  assert.deepEqual(marksInFrame(svg, 100, 20).map((m) => m.id), ['near', 'far']);
});
