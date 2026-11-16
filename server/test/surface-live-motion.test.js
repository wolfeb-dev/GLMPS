// Modules under test: web/surface/live-motion.js, wall-mode.js, agent-dial.js, the agents layer and the Sessions dock roster
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS } from './fixtures/surface-fixtures.js';
import { waitFor } from './helpers/wait-for.js';
import { arcSlice } from '../../web/surface/live-motion.js';

const NOW = Date.now();
// Lets pending fetch and json continuations settle before a test asserts that nothing happened.
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// Board timestamps arrive as ISO strings, the way the backlog store writes them.
const iso = (ms) => new Date(ms).toISOString();
const STATE = { tools: [], sessions: [{ id: 's1', tool: 'claude-code' }, { id: 's2', tool: 'codex-cli' }, { id: 's9', tool: 'antigravity' }], board: { rows: [] } };

// A Surface with two live sessions, a card feed and a mutable card table.
async function rig({ cards = {}, backlog = [], live, reduced = false, store = {}, ctx = {} } = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  for (const [k, v] of Object.entries(store)) localStorage.setItem(k, v);
  const savedMq = globalThis.matchMedia;
  if (reduced) globalThis.matchMedia = (q) => ({ matches: /reduced/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
  const liveBody = live ?? { sessions: [{ id: 's1', cwd: `${ROWS[0].path}/web`, lastTs: NOW }, { id: 's2', cwd: 'C:/elsewhere', lastTs: NOW }], now: NOW, staleMs: 600000 };
  const state = { live: liveBody, cards, calls: [] };
  const base = surfaceFetch({ '/api/sessions/live': liveBody, '/api/backlog': { items: backlog }, '/api/workspace': { sessions: [] } });
  const fetchImpl = async (url) => {
    const u = String(url).split('?')[0];
    state.calls.push(u);
    if (u === '/api/sessions/live') return Response.json(state.live);
    const m = u.match(/^\/api\/backlog\/([^/]+)$/);
    if (m) return state.cards[m[1]] ? Response.json(state.cards[m[1]]) : new Response('{"error":"item not found"}', { status: 404 });
    return base(url);
  };
  const m = await mountSurface('', fetchImpl, { getState: () => STATE, ...ctx });
  const q = (sel) => m.root.querySelectorAll(sel);
  const mark = (id) => q('.agent').find((g) => g.dataset.itemId === id);
  const done = () => { m.handle.unmount(); delete globalThis.fetch; delete window.d3; if (reduced) globalThis.matchMedia = savedMq; dom.restore(); };
  return { ...m, state, q, mark, done };
}
const events = (sessionId, evs) => ({ type: 'events', sessionId, events: evs });

test('AC-1: an arriving event lights the newest dial tick blue and sends a ping from that session', async () => {
  const r = await rig();
  try {
    const g = r.mark('s1');
    assert.equal(g.querySelectorAll('.dial-tick').length, 60, 'a 60-tick dial');
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    const ticks = g.querySelectorAll('.dial-tick');
    assert.match(ticks[0].getAttribute('class'), /tk-info/, 'tick 0 is the newest second');
    assert.equal(g.querySelectorAll('.dial-ping').length, 1);
    r.handle.onEvent(events('s1', [{ kind: 'git', gitOp: 'commit', ts: Date.now() }, { kind: 'tool', ts: Date.now() }]));
    assert.equal(g.querySelectorAll('.dial-ping').length, 3, 'one ping per arriving event');
    assert.match(g.querySelectorAll('.dial-tick')[0].getAttribute('class'), /tk-ok/, 'a commit in the second makes it green');
    assert.equal(r.mark('s2').querySelectorAll('.dial-ping').length, 0, 'the other session is untouched');
  } finally { r.done(); }
});

test('AC-2: a session in the stream that is not on the ring joins on one refetch of the live sessions', async () => {
  const r = await rig();
  try {
    assert.equal(r.mark('s9'), undefined);
    r.state.live = { ...r.state.live, sessions: [...r.state.live.sessions, { id: 's9', cwd: 'C:/x', lastTs: Date.now() }] };
    const before = r.state.calls.filter((c) => c === '/api/sessions/live').length;
    r.handle.onEvent(events('s9', [{ kind: 'tool', ts: Date.now() }]));
    r.handle.onEvent(events('s9', [{ kind: 'tool', ts: Date.now() }]));
    await waitFor(() => r.mark('s9'), { message: 's9 on the ring' });
    assert.equal(r.state.calls.filter((c) => c === '/api/sessions/live').length - before, 1, 'one refetch, not one per event');
    assert.match(r.mark('s9').querySelectorAll('.dial-tick')[0].getAttribute('class'), /tk-info/, 'the buffered events fill its dial at once');
  } finally { r.done(); }
});

test('AC-2: a session idle past staleMs fades to the idle colour', async () => {
  const r = await rig({ live: { sessions: [{ id: 's1', cwd: 'C:/x', lastTs: NOW - 3600000 }, { id: 's2', cwd: 'C:/y', lastTs: NOW }], now: NOW, staleMs: 600000 } });
  try {
    r.handle.onEvent(events('s2', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(r.mark('s1').dataset.state, 'idle');
    assert.equal(r.mark('s2').dataset.state, 'active');
    assert.match(r.mark('s1').getAttribute('aria-label'), /idle/);
  } finally { r.done(); }
});

test('AC-3: a push flies a green arc to GitHub; a batch flies one blue out-and-back arc, one in flight per session', async () => {
  const r = await rig();
  try {
    r.handle.onEvent(events('s1', [{ kind: 'git', gitOp: 'push', ts: Date.now() }]));
    assert.equal(r.q('.arc-ok').length, 1, 'push to GitHub');
    assert.equal(r.q('.arc-info').length, 1, 'the batch also made a model turn (claude-code goes to Anthropic)');
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(r.q('.arc-info').length, 1, 'still one provider arc in flight for the session');
    r.handle.onEvent(events('s2', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(r.q('.arc-info').length, 1, 'codex-cli has no provider on the globe, so no arc');
  } finally { r.done(); }
});

test('AC-1/3: a failed gate flashes red at the card\'s session; a pass shows green; old verdicts seen at first read do not', async () => {
  const r = await rig({ cards: { c1: { id: 'c1', state: 'in_review', runSession: { sessionId: 's2' }, gate: { status: 'FAIL', ts: iso(Date.now() - 3600000) } } } });
  try {
    r.handle.onEvent({ type: 'backlog', ids: ['c1'], version: 1 });
    await waitFor(() => r.state.calls.includes('/api/backlog/c1'), { message: 'card read' });
    await flush();
    assert.equal(r.mark('s2').querySelectorAll('.tk-err').length, 0, 'an hour-old verdict is not a flash');
    r.state.cards.c1 = { ...r.state.cards.c1, gate: { status: 'CONCERNS', ts: iso(Date.now()) } };
    r.handle.onEvent({ type: 'backlog', ids: ['c1'], version: 2 });
    await waitFor(() => r.mark('s2').querySelectorAll('.tk-err').length > 0, { message: 'red tick' });
    assert.equal(r.mark('s2').dataset.state, 'fail');
    assert.equal(r.mark('s2').querySelectorAll('.ping-err').length, 1);
    assert.equal(r.mark('s1').querySelectorAll('.tk-err').length, 0);
  } finally { r.done(); }
});

test('AC-4: a held card puts a steady amber ring and a needs-you timer on its session; the roster lists it first with a sparkline', async () => {
  const held = { id: 'c2', state: 'held', runSession: { sessionId: 's2' }, updatedAt: iso(Date.now() - 125000), devLog: [] };
  const r = await rig({ backlog: [{ id: 'c2', state: 'held', origin: null }], cards: { c2: held } });
  try {
    await waitFor(() => r.mark('s2').dataset.state === 'waiting', { message: 'waiting state' });
    const ring = r.mark('s2').querySelector('.dial-ring');
    assert.equal(ring.getAttribute('display'), 'inline');
    assert.match(r.mark('s2').getAttribute('aria-label'), /needs you 2 min|needs you 1[2-3]\d s/);
    assert.equal(r.mark('s2').querySelectorAll('.tk-warn').length + r.mark('s2').querySelectorAll('.tk-warnrest').length, 60, 'the whole dial is amber');
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    await waitFor(() => r.q('.roster-row').length === 2, { message: 'roster rows' });
    const rows = r.q('.roster-row');
    assert.equal(rows[0].dataset.state, 'waiting', 'needs-you sorts first');
    assert.ok(rows[0].querySelector('.roster-spark'), 'a sparkline per session');
    assert.match(r.root.querySelector('[role="status"]').textContent, /needs you|^$/);
    r.state.cards.c2 = { ...held, state: 'in_progress' };
    r.handle.onEvent({ type: 'backlog', ids: ['c2'], version: 3 });
    await waitFor(() => r.mark('s2').dataset.state !== 'waiting', { message: 'amber clears' });
    assert.equal(r.mark('s2').querySelector('.dial-ring').getAttribute('display'), 'none');
  } finally { r.done(); }
});

test('AC-10: a Slack-born card\'s new devlog entry or gate arcs to Slack; entries seen at first read never do', async () => {
  const card = { id: 'c3', state: 'in_progress', origin: { via: 'slack' }, runSession: { sessionId: 's2' }, devLog: [{ ts: iso(Date.now() - 3600000), text: 'old' }], gate: null };
  const r = await rig({ backlog: [{ id: 'c3', state: 'in_progress', origin: { via: 'slack' } }], cards: { c3: card } });
  try {
    await waitFor(() => r.state.calls.includes('/api/backlog/c3'), { message: 'seed read' });
    await flush();
    assert.equal(r.q('.live-arc').length, 0, 'the seeded entry does not arc');
    r.state.cards.c3 = { ...card, devLog: [...card.devLog, { ts: iso(Date.now()), text: 'started' }] };
    r.handle.onEvent({ type: 'backlog', ids: ['c3'], version: 2 });
    await waitFor(() => r.q('.arc-info').length === 1, { message: 'slack arc' });
    r.handle.onEvent({ type: 'backlog', ids: ['c3'], version: 3 });
    await flush();
    assert.equal(r.q('.arc-info').length, 1, 'the same entry read again does not arc twice');
    r.state.cards.c3 = { ...r.state.cards.c3, gate: { status: 'PASS', ts: iso(Date.now() + 5) } };
    r.handle.onEvent({ type: 'backlog', ids: ['c3'], version: 4 });
    await waitFor(() => r.q('.arc-info').length === 2, { message: 'gate arc' });
  } finally { r.done(); }
});

test('AC-10: a card not born in Slack never arcs to Slack', async () => {
  const card = { id: 'c4', state: 'in_progress', origin: null, runSession: { sessionId: 's2' }, devLog: [] };
  const r = await rig({ cards: { c4: card } });
  try {
    r.handle.onEvent({ type: 'backlog', ids: ['c4'], version: 1 });
    await waitFor(() => r.state.calls.includes('/api/backlog/c4'), { message: 'read' });
    r.state.cards.c4 = { ...card, devLog: [{ ts: iso(Date.now()), text: 'x' }] };
    r.handle.onEvent({ type: 'backlog', ids: ['c4'], version: 2 });
    await flush();
    assert.equal(r.q('.live-arc').length, 0);
  } finally { r.done(); }
});

test('AC-6: under reduced motion nothing animates: no pings, no packets, arcs are still lines; the dial still fills', async () => {
  const r = await rig({ reduced: true });
  try {
    r.handle.onEvent(events('s1', [{ kind: 'git', gitOp: 'push', ts: Date.now() }]));
    assert.equal(r.q('.dial-ping').length, 0);
    assert.equal(r.q('.live-dot').length, 0);
    assert.equal(r.q('.live-arc').length, 2);
    for (const a of r.q('.live-arc')) assert.ok(a.getAttribute('d').length > 0, 'the still line is drawn whole');
    assert.match(r.mark('s1').querySelectorAll('.dial-tick')[0].getAttribute('class'), /tk-ok/);
  } finally { r.done(); }
});

test('AC-7: the loop is idle until something moves, stops when it ends and on unmount; no setInterval in the motion modules', async () => {
  const r = await rig();
  const frames = new Map(); let nextId = 1; let fakeNow = 1000;
  const raf = mock.method(globalThis, 'requestAnimationFrame', (fn) => { const id = nextId++; frames.set(id, fn); return id; });
  const caf = mock.method(globalThis, 'cancelAnimationFrame', (id) => { frames.delete(id); });
  const clock = mock.method(performance, 'now', () => fakeNow);
  try {
    assert.equal(frames.size, 0, 'nothing moves at rest, so no frame is requested');
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(frames.size, 1, 'an event wakes the loop, with one frame');
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(frames.size, 1, 'a second event does not add a second loop');
    for (let i = 0; i < 4 && frames.size; i++) { fakeNow += 1500; const [[id, fn]] = frames; frames.delete(id); fn(fakeNow); }
    assert.equal(frames.size, 0, 'when the last ping and arc finish the loop stops by itself');
    assert.equal(r.q('.dial-ping').length, 0, 'finished pings are removed');
    assert.equal(r.q('.live-arc').length, 0, 'finished arcs are removed');
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(frames.size, 1);
    r.handle.unmount();
    assert.equal(frames.size, 0, 'unmount cancels the pending frame');
    assert.equal(r.q('.dial-ping').length, 0);
  } finally { raf.mock.restore(); caf.mock.restore(); clock.mock.restore(); r.done(); }
  for (const f of ['live-motion', 'frame-loop', 'wall-mode', 'heartbeat', 'director', 'agent-dial']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../../web/surface/${f}.js`, import.meta.url), 'utf8'), /setInterval\(/, f);
  }
});

test('AC-7: a hidden tab starts no frame and draws no effects; the dial still takes the event, and showing the tab resumes', async () => {
  const r = await rig();
  const frames = new Map(); let nextId = 1;
  const raf = mock.method(globalThis, 'requestAnimationFrame', (fn) => { const id = nextId++; frames.set(id, fn); return id; });
  const caf = mock.method(globalThis, 'cancelAnimationFrame', (id) => { frames.delete(id); });
  try {
    document.hidden = true;
    r.handle.onEvent(events('s1', [{ kind: 'git', gitOp: 'push', ts: Date.now() }]));
    assert.equal(frames.size, 0, 'no frame while hidden');
    assert.equal(r.q('.dial-ping').length + r.q('.live-arc').length, 0, 'nothing is drawn that nobody can see');
    assert.match(r.mark('s1').querySelectorAll('.dial-tick')[0].getAttribute('class'), /tk-ok/, 'the dial still takes the event');
    document.hidden = false;
    r.handle.onEvent(events('s1', [{ kind: 'tool', ts: Date.now() }]));
    assert.equal(frames.size, 1, 'visible again, the loop runs');
  } finally { document.hidden = false; raf.mock.restore(); caf.mock.restore(); r.done(); }
});

test('glmps-2-0-208: the roster lives in the right-hand Sessions dock with the colour key; a commit turns its row green; Wall mode is out of the Fleet board', async () => {
  const r = await rig();
  try {
    const dock = r.root.querySelector('#dock-sessions');
    assert.ok(dock, 'a Sessions dock');
    const ids = [...r.root.querySelector('.surface-side').children].map((x) => x.id);
    assert.deepEqual(ids.filter(Boolean).slice(0, 3), ['dock-track', 'dock-sessions', 'dock-layers'], 'it leads the right column, under only the tracking card');
    assert.equal(r.root.querySelector('.surface-fleet').querySelectorAll('.roster-row').length, 0, 'the Fleet board keeps only the loop-stage board');
    assert.deepEqual(dock.querySelectorAll('.legend-item').map((x) => x.textContent), ['activity', 'commit, push, pass', 'failure', 'needs you', 'idle']);
    r.handle.onEvent(events('s1', [{ kind: 'tool', label: 'Edit web/app.js', ts: Date.now() }]));
    r.handle.onEvent(events('s2', [{ kind: 'tool', ts: Date.now() }]));
    await waitFor(() => dock.querySelectorAll('.roster-row').length === 2, { message: 'roster rows' });
    const row = () => dock.querySelectorAll('.roster-row').find((x) => !x.getAttribute('aria-label').includes('codex'));
    assert.equal(row().dataset.tone, 'info');
    assert.match(row().querySelector('.roster-word').textContent, /Edit web\/app\.js/, 'the state line is the latest action');
    assert.match(dock.querySelector('.dock-sub').textContent, /2 busy, 0 waiting on you/);
    r.handle.onEvent(events('s1', [{ kind: 'git', gitOp: 'commit', ts: Date.now() }]));
    await waitFor(() => row().dataset.tone === 'ok', { message: 'green row' });
    assert.ok(row().querySelector('.spark-ok'), 'the sparkline turns green too');
    assert.ok(r.root.querySelector('.surface-wall')?.querySelector('.wall-btn'), 'Wall mode keeps its own bar on the stage');
  } finally { r.done(); }
});

test('AC-5: Wall mode is off and not remembered by default; on, the Director locks a session with a reticle and heads-up; off, it flies home and forgets', async () => {
  const r = await rig({ reduced: true });
  try {
    const btn = r.root.querySelector('.wall-btn');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(localStorage.getItem('mc.surface.wall'), null);
    r.handle.onEvent(events('s1', [{ kind: 'tool', label: 'Edit web/app.js', ts: Date.now() }]));
    btn.click();
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(localStorage.getItem('mc.surface.wall'), 'on');
    await waitFor(() => r.q('.dial-reticle').some((x) => x.getAttribute('display') === 'inline'), { message: 'reticle' });
    const heads = r.root.querySelector('.surface-headsup');
    assert.equal(heads.hidden, false);
    assert.match(heads.textContent, /Edit web\/app\.js/);
    assert.match(heads.textContent, /\/min/);
    assert.ok(r.root.classList.contains('is-tracking'), 'Track mode holds the camera');
    // Picking a roster row locks that session.
    r.handle.onEvent(events('s2', [{ kind: 'tool', ts: Date.now() }]));
    await waitFor(() => r.q('.roster-row').length === 2, { message: 'roster' });
    r.q('.roster-row').find((x) => x.getAttribute('aria-label').includes('codex')).click();
    assert.equal(btn.dataset.locked, 'true');
    btn.click();
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(r.q('.dial-reticle').some((x) => x.getAttribute('display') === 'inline'), false);
    assert.equal(localStorage.getItem('mc.surface.wall'), 'off');
    await waitFor(() => !r.root.classList.contains('is-tracking'), { message: 'tracking stopped' });
  } finally { r.done(); }
});

test('AC-5: a remembered Wall mode comes back on at the next visit', async () => {
  const r = await rig({ reduced: true, store: { 'mc.surface.wall': 'on' } });
  try {
    assert.equal(r.root.querySelector('.wall-btn').getAttribute('aria-pressed'), 'true');
  } finally { r.done(); }
});

test('arcSlice draws the covered part of a path and puts the packet on its end', () => {
  const pts = [[0, 0], [10, 0], null, [20, 0], [30, 0]];
  assert.deepEqual(arcSlice(pts, 0), { d: '', head: null });
  const half = arcSlice(pts, 0.5);
  assert.deepEqual(half.head, [10, 0]);
  assert.equal(half.d, 'M0.0,0.0L10.0,0.0');
  const more = arcSlice(pts, 0.75);
  assert.deepEqual(more.head, [25, 0]);
  assert.equal(more.d, 'M0.0,0.0L10.0,0.0M20.0,0.0L25.0,0.0', 'a gap off the globe breaks the line');
  const all = arcSlice(pts, 1);
  assert.deepEqual(all.head, [30, 0]);
  assert.deepEqual(arcSlice([null, null], 1), { d: '', head: null });
});

test('glmps-2-0-210: Wall mode keeps clear of the canvas fallback search, and only that search moves it', async () => {
  const bare = await rig();
  try {
    assert.ok(bare.root.querySelector('.surface-stage').classList.contains('has-canvas-search'), 'a bare mount keeps the search in the canvas header');
  } finally { bare.done(); }
  const shellSearch = { setSource: () => () => {}, isOpen: () => false, close() {}, focus() {} };
  const shelled = await rig({ ctx: { search: shellSearch } });
  try {
    assert.equal(shelled.root.querySelector('.surface-stage').classList.contains('has-canvas-search'), false, 'the shell owns the search, so Wall mode keeps its full width');
  } finally { shelled.done(); }
  const css = fs.readFileSync(new URL('../../web/surface/surface.css', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const guard = '.surface-root:not(.is-tracking) .has-canvas-search';
  assert.ok(css.includes(`${guard} .surface-wall { max-width: 272px; }`), 'desktop: the bar stops at the search left edge');
  assert.match(css, /@media \(max-width: 900px\) \{[^}]*\.has-canvas-search \.surface-wall \{ max-width: 236px; \}/, 'the narrower rail moves the search, so the cap follows');
  assert.match(css, /@media \(max-width: 560px\) \{[^@]*\.has-canvas-search \.surface-wall \{ top: 58px; z-index: 4; max-width: none; \}[^@]*\.has-canvas-search \.surface-left \{ top: 110px; \}/, 'phone: the bar drops under the full-width search, the rail with it, and the dropdown stays on top');
});
