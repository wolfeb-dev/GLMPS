// Routes under test: server/lib/routes/workspace-routes.js
// R2 (glmps-2-0-63) AC-5: tracking follows the SurfaceTrack board: breadcrumb
// header with Stop tracking, a telemetry card, an In view list, and a pin box.
// No agent summaries anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS, TIMELINE } from './fixtures/surface-fixtures.js';
import { collectItems } from '../../web/shared/interactive-item.js';
import { agentName } from '../../web/surface/agent-name.js';
import { crumbsFor, nextGateWord, pinLine } from '../../web/surface/track.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.now();
const LIVE = {
  '/api/sessions/live': { sessions: [{ id: 's1', cwd: `${ROWS[0].path}/web`, lastTs: NOW }, { id: 's9', cwd: 'C:/elsewhere', lastTs: NOW }], now: NOW, staleMs: 600000 },
  '/api/workspace': { sessions: [{ sessionId: 's1', title: 'wire the globe', declared: { goal: 'ship the globe' }, observed: { activePaths: ['web/app.js', 'web/lens.js'] }, divergence: { level: 'minor' }, hasPendingSteer: false }] },
  '/api/backlog': { items: [{ id: 'mc-7', title: 'globe polish', state: 'in_review', origin: null }] },
};
const STATE = {
  tools: [],
  sessions: [{ id: 's1', tool: 'claude-code', card: { id: 'mc-7', title: 'globe polish' }, status: { model: { displayName: 'Opus' }, cost: { totalUsd: 1.234 } } }, { id: 's9', tool: 'antigravity' }],
  board: { rows: [{ id: 's1', stageName: 'Execute', enteredTs: NOW - 180000, tool: 'claude-code' }] },
};


test('AC-5 (model): an agent is named by its card, else its tool and a short id, never by a summary', () => {
  assert.equal(agentName(STATE, 's1'), 'mc-7');
  assert.equal(agentName(STATE, 's9aaaaaaaaaaaa'), 'agent s9aaaaaa');
  assert.equal(agentName({ sessions: [{ id: 'abcdef123456', tool: 'antigravity' }] }, 'abcdef123456'), 'antigravity abcdef12');
  assert.equal(agentName(null, 'zz'), 'agent zz');
});

test('AC-5 (model): the breadcrumb is Surface, place, repository, tracking card; a missing repository drops out', () => {
  assert.deepEqual(crumbsFor({ place: 'Local store', repo: 'glmps', name: 'mc-7' }), ['Surface', 'Local store', 'glmps', 'tracking mc-7']);
  assert.deepEqual(crumbsFor({ place: 'Local store', repo: null, name: 'claude-code s9' }), ['Surface', 'Local store', 'tracking claude-code s9']);
});

test('AC-5 (model): next gate is the card\'s latest gate event, or says why there is none', () => {
  const ev = [{ kind: 'gate', cardId: 'mc-7', state: 'in_review', ts: NOW - 90 * 60000 }, { kind: 'gate', cardId: 'mc-7', state: 'done', ts: NOW - 5 * 60000 }, { kind: 'gate', cardId: 'other', state: 'x', ts: NOW }];
  assert.equal(nextGateWord({ card: { id: 'mc-7' }, events: ev, now: NOW }), 'done, 5 min ago');
  assert.equal(nextGateWord({ card: { id: 'mc-9' }, events: ev, now: NOW, cardState: 'in_progress' }), 'not reached, card is in progress');
  assert.equal(nextGateWord({ card: null, events: ev, now: NOW }), 'no card, so no gate');
});

test('AC-5 (model): the pin line names the repository and what differs from its remote', () => {
  assert.equal(pinLine({ repo: 'glmps', row: { dirty: 27, ahead: 0, behind: 0 } }), 'Pin on glmps: 27 files differ from remote');
  assert.equal(pinLine({ repo: 'glmps', row: { dirty: 1, ahead: 0, behind: 0 } }), 'Pin on glmps: 1 file differs from remote');
  assert.equal(pinLine({ repo: 'x', row: { dirty: 0, ahead: 2, behind: 1 } }), 'Pin on x: ahead 2, behind 1');
  assert.equal(pinLine({ repo: 'x', row: { dirty: 0, ahead: 0, behind: 0 } }), 'Pin on x: in sync with its remote');
  assert.equal(pinLine({ repo: null, row: null }), 'Pin on this agent');
});


async function withSurface(fn, { search = '', routes = {}, wrap = null, state = STATE } = {}) {
  const dom = installMiniDom({ pathname: '/surface', search });
  let handle;
  try {
    const base = surfaceFetch({ ...LIVE, ...routes });
    const m = await mountSurface(search, wrap ? wrap(base) : base, { getState: () => state });
    handle = m.handle;
    await tick(40);
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}
const item = (type, id) => collectItems(document.body).find((e) => e.dataset.itemType === type && e.dataset.itemId === id);
const btn = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

test('AC-5: tracking shows the breadcrumb header with Stop tracking', async () => {
  await withSurface(async ({ root }) => {
    assert.ok(root.classList.contains('is-tracking'));
    const bar = root.querySelector('.surface-trackbar');
    assert.equal(bar.hidden, false);
    assert.deepEqual(bar.querySelectorAll('.crumb').map((c) => c.textContent), ['Surface', 'Local store', 'glmps', 'tracking mc-7']);
    assert.equal(bar.querySelector('nav').getAttribute('aria-label'), 'Tracking breadcrumb');
    const stop = btn(bar, 'Stop tracking');
    assert.ok(stop);
    stop.click(); await tick(20);
    assert.equal(root.classList.contains('is-tracking'), false);
    assert.equal(bar.hidden, true);
  }, { search: '?track=s1' });
});

test('AC-5: the telemetry card lists card, title, stage and time, tool, declared, observed, drift, spend, next gate, then the numbered trail', async () => {
  await withSurface(async ({ root }) => {
    const dock = root.querySelector('#dock-track');
    assert.equal(dock.hidden, false);
    assert.equal(dock.querySelector('.trk-id').textContent, 'mc-7');
    assert.equal(dock.querySelector('.trk-title').textContent, 'globe polish');
    const keys = dock.querySelector('.trk-facts').querySelectorAll('dt').map((d) => d.textContent);
    assert.deepEqual(keys, ['stage', 'tool', 'declared', 'observed', 'drift', 'spend', 'next gate']);
    const val = (k) => dock.querySelector('.trk-facts').querySelectorAll('dd')[keys.indexOf(k)].textContent;
    assert.match(val('stage'), /^Execute, \d+ min here$/);
    assert.equal(val('tool'), 'claude-code, Opus');
    assert.equal(val('declared'), 'ship the globe');
    assert.equal(val('observed'), 'web/app.js, web/lens.js');
    assert.equal(val('drift'), 'minor');
    assert.equal(val('spend'), '$1.23');
    assert.match(val('next gate'), /in review, \d+ (min|h) ago/);
    assert.match(dock.querySelector('.trk-trail').textContent, /web\/app\.js/);
    assert.doesNotMatch(dock.textContent, /wire the globe/, 'the agent summary is not shown');
  }, { search: '?track=s1' });
});

test('AC-5: what is not known reads as not recorded, never a made-up value', async () => {
  const bare = { tools: [], sessions: [{ id: 's9' }], board: { rows: [] } };
  await withSurface(async ({ root }) => {
    const dock = root.querySelector('#dock-track');
    const keys = dock.querySelector('.trk-facts').querySelectorAll('dt').map((d) => d.textContent);
    const val = (k) => dock.querySelector('.trk-facts').querySelectorAll('dd')[keys.indexOf(k)].textContent;
    assert.equal(val('spend'), 'not recorded');
    assert.equal(val('stage'), 'not on the board');
    assert.equal(val('tool'), 'not captured');
    assert.equal(val('declared'), 'none declared');
    assert.equal(val('next gate'), 'no card, so no gate');
    assert.equal(dock.querySelector('.trk-id').textContent, 'agent s9');
    assert.equal(dock.querySelector('.trk-title').textContent, 'No card on this session');
  }, { search: '?track=s9', state: bare });
});

test('AC-5: the In view list sits top left while tracking and hides when tracking stops', async () => {
  await withSurface(async ({ root }) => {
    await tick(320);
    const iv = root.querySelector('.surface-inview');
    assert.equal(iv.hidden, false);
    assert.match(iv.querySelector('h2').textContent, /^In view \(\d+\)$/);
    assert.ok(iv.querySelectorAll('.trk-vrow').length >= 1);
    btn(root.querySelector('.surface-trackbar'), 'Stop tracking').click(); await tick(20);
    assert.equal(iv.hidden, true);
  }, { search: '?track=s1' });
});

test('AC-5: the pin box names the repository and opens the filing form; nothing posts until File card', async () => {
  const posts = [];
  await withSurface(async ({ root }) => {
    const box = root.querySelector('.surface-pinbox');
    assert.equal(box.hidden, false);
    assert.match(box.textContent, /Pin on glmps: 27 files differ from remote/);
    assert.match(box.textContent, /A pin becomes a card on Work with this view linked\./);
    btn(box, 'File as card').click(); await tick(10);
    assert.ok(root.querySelector('#pin-title'), 'the filing form opened');
    assert.equal(posts.length, 0);
    assert.match(root.querySelector('#pin-prompt').value, /View it on Surface: .*track=s1/, 'the card links this tracking view');
  }, { search: '?track=s1', wrap: (base) => async (url, init) => { if (init?.method === 'POST') { posts.push(url); return Response.json({}); } return base(url, init); } });
});

test('AC-5: an agent mark and its search entry carry the card, not the summary, but the summary still finds it', async () => {
  await withSurface(async ({ root }) => {
    assert.match(item('agent', 's1').getAttribute('aria-label'), /mc-7/);
    assert.doesNotMatch(item('agent', 's1').getAttribute('aria-label'), /wire the globe/);
    const input = root.querySelector('.surface-search-input');
    input.value = 'wire the'; input.dispatchEvent(new MiniEvent('input', { bubbles: true }));
    const opt = root.querySelector('.surface-search-list').querySelectorAll('[role="option"]').find((o) => o.querySelector('.sr-kind').textContent === 'Agent');
    assert.ok(opt, 'found through the hidden summary');
    assert.equal(opt.querySelector('.sr-title').textContent, 'mc-7');
  });
});

test('AC-5: a session with no card is named by tool and short id', async () => {
  await withSurface(async () => {
    assert.match(item('agent', 's9').getAttribute('aria-label'), /antigravity s9/);
  });
});
