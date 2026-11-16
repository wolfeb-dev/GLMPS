// Routes under test: server/lib/routes/merge-queue-routes.js
// Routes under test: server/lib/routes/guards-routes.js
// R2 (glmps-2-0-63) AC-3 and AC-8 (client): the Layers panel groups, the event
// and flow layers with counts and keys, and the usage-to-providers arcs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, TIMELINE } from './fixtures/surface-fixtures.js';
import { providerArcs, gateVerdicts, refusalSummary, mergeQueueSummary, trailsBySession, ARC_MIN_PX, ARC_MAX_PX } from '../../web/surface/event-layers.js';
import { collectItems } from '../../web/shared/interactive-item.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const PLAYERS = [{ id: 'local' }, { id: 'anthropic' }, { id: 'gcp' }, { id: 'slack' }];
const USAGE = { from: 1, to: 2, providers: [
  { id: 'anthropic', label: 'Anthropic', spendUsd: 6, tokens: 9000, sessions: 4 },
  { id: 'google', label: 'Google', spendUsd: 2, tokens: 1000, sessions: 1 },
  { id: 'openai', label: 'OpenAI', spendUsd: 0, tokens: 0, sessions: 0 },
  { id: 'other', label: 'Other', spendUsd: 1, tokens: 10, sessions: 1 },
] };


test('AC-8 (model): one arc per placed provider with spend, width by share; none for zero spend or an unplaced provider', () => {
  const m = providerArcs(USAGE, PLAYERS);
  assert.equal(m.weightedBy, 'spend');
  assert.deepEqual(m.arcs.map((a) => [a.id, a.playerId]), [['anthropic', 'anthropic'], ['google', 'gcp']]);
  assert.ok(m.arcs[0].widthPx > m.arcs[1].widthPx, 'the bigger share is wider');
  for (const a of m.arcs) assert.ok(a.widthPx >= ARC_MIN_PX && a.widthPx <= ARC_MAX_PX);
  assert.deepEqual(m.unplaced.map((p) => p.id), ['other'], 'a provider with spend and no place is listed, not drawn');
  assert.equal(m.totalLabel, '$9.00');
  assert.ok(Math.abs(m.arcs[0].share - 6 / 9) < 1e-9, 'shares are of the whole including the unplaced');
});

test('AC-8 (model): when any provider has no cost the weights are tokens', () => {
  const m = providerArcs({ providers: [{ id: 'anthropic', label: 'Anthropic', spendUsd: null, tokens: 3000, sessions: 2 }, { id: 'google', label: 'Google', spendUsd: 5, tokens: 1000, sessions: 1 }] }, PLAYERS);
  assert.equal(m.weightedBy, 'tokens');
  assert.ok(m.arcs[0].widthPx > m.arcs[1].widthPx);
  assert.match(m.totalLabel, /4,000 tokens|4k tokens/);
});

test('AC-8 (model): a feed with no providers, or a malformed one, draws nothing', () => {
  for (const body of [{ providers: [] }, {}, null, { providers: 'x' }]) assert.deepEqual(providerArcs(body, PLAYERS).arcs, []);
});

test('AC-3 (model): gate verdicts are the timeline gate events at or before the as-of time, newest first', () => {
  const g = gateVerdicts(TIMELINE.events, null);
  assert.equal(g.length, 1);
  assert.equal(gateVerdicts(TIMELINE.events, TIMELINE.to - 3 * 3600000).length, 0);
});

test('AC-3 (model): refusals and the merge queue are read as counts', () => {
  const r = refusalSummary({ byHook: { 'plan-gate': { checks: 10, refusals: 3 }, 'test-file-guard': { checks: 4, refusals: 1 } }, recent: [{ ts: 1, hook: 'plan-gate', reason: 'no plan' }] });
  assert.equal(r.total, 4);
  assert.equal(r.recent.length, 1);
  assert.equal(refusalSummary({}).total, 0);
  const q = mergeQueueSummary({ branches: [{ branch: 'main', repo: 'r', requests: [{ id: 'a' }, { id: 'b' }] }, { branch: 'dev', repo: 'r', requests: [{ id: 'c' }] }] });
  assert.deepEqual([q.requests, q.branches], [3, 2]);
  assert.deepEqual(mergeQueueSummary(null), { requests: 0, branches: 0, rows: [] });
});

test('AC-3 (model): edit trails group the edits by session, oldest first, and need two points', () => {
  const t = trailsBySession([
    { sessionId: 's1', repo: 'a', ts: 3 }, { sessionId: 's1', repo: 'b', ts: 1 }, { sessionId: 's1', repo: 'a', ts: 2 },
    { sessionId: 's2', repo: 'a', ts: 5 }, { sessionId: 's3', repo: null, ts: 4 }, { sessionId: 's3', repo: null, ts: 6 },
  ]);
  assert.deepEqual(t.map((x) => [x.sessionId, x.repos]), [['s1', ['b', 'a']]], 'consecutive repeats fold, one-point sessions and loose files draw no trail');
});


async function withSurface(fn, { search = '', routes = {} } = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface(search, surfaceFetch(routes));
    handle = m.handle;
    await tick(30);
    await fn(m);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}
const key = (k) => window.dispatchEvent(new MiniEvent('keydown', { key: k, target: document.body }));
const rowOf = (root, id) => root.querySelector(`#layer-${id}`)?.parentNode;
const GATE_ROUTES = { '/api/guards/refusals': { byHook: { 'plan-gate': { checks: 9, refusals: 2 } }, recent: [{ ts: Date.now(), hook: 'plan-gate', reason: 'no plan on the card' }] }, '/api/merge-queue': { branches: [{ branch: 'glmps2/main', repo: 'glmps-2.0', requests: [{ id: 'mc-7', title: 'globe', stage: 'testing', round: 1 }] }] }, '/api/usage/providers': USAGE };

test('AC-3: the Layers panel is grouped Data, Places, Work, Events, Links between places, with Map last', async () => {
  await withSurface(async ({ root }) => {
    const dock = root.querySelector('#dock-layers');
    const heads = dock.querySelectorAll('.layer-group-h').map((h) => h.textContent);
    assert.deepEqual(heads, ['Fly to', 'Data', 'Places', 'Work', 'Events', 'Links between places', 'Map']);
    const under = (group) => dock.querySelectorAll('.layer-group').find((g) => g.querySelector('.layer-group-h').textContent === group).querySelectorAll('.layer-name').map((n) => n.textContent);
    assert.deepEqual(under('Events'), ['Alert pulses', 'Gate verdicts', 'Guard refusals']);
    assert.ok(under('Work').includes('Merge queue'));
    assert.deepEqual(under('Links between places'), ['Remote links', 'Loops', 'Usage to providers', 'Edit trails']);
  }, { routes: GATE_ROUTES });
});

test('AC-3: each new layer has a key, a count and a legend; the header says how many are on', async () => {
  await withSurface(async ({ root }) => {
    const keyOf = (id) => rowOf(root, id).querySelector('kbd').textContent;
    assert.deepEqual(['gates', 'refusals', 'queue', 'usage', 'trails'].map(keyOf), ['V', 'U', 'M', 'W', 'T']);
    assert.equal(rowOf(root, 'gates').querySelector('.n').textContent, '1', 'one gate event in the 24 h timeline');
    assert.equal(rowOf(root, 'refusals').querySelector('.n').textContent, '2');
    assert.equal(rowOf(root, 'queue').querySelector('.n').textContent, '1');
    assert.equal(rowOf(root, 'usage').querySelector('.n').textContent, '$9.00');
    const sub = root.querySelector('#dock-layers').querySelector('.dock-sub').textContent;
    assert.match(sub, /^\d+ of \d+ on$/);
    rowOf(root, 'refusals').querySelector('.layer-name').click(); await tick(10);
    assert.match(root.querySelector('#panel-inspector').textContent, /no plan on the card/, 'the legend lists what the layer counts');
  }, { routes: GATE_ROUTES });
});

test('AC-8: the usage layer draws one arc per provider with spend from the local store, widest for the biggest share', async () => {
  await withSurface(async ({ root }) => {
    const arcs = root.querySelectorAll('.usage-arc');
    assert.deepEqual(arcs.map((a) => a.dataset.itemId).sort(), ['anthropic', 'google']);
    const w = (id) => Number(arcs.find((a) => a.dataset.itemId === id).getAttribute('stroke-width'));
    assert.ok(w('anthropic') > w('google'));
    assert.ok(arcs[0].getAttribute('aria-label').match(/Anthropic/), 'each arc is named');
    assert.equal(root.querySelector('[data-layer="usage"]').getAttribute('display'), 'none', 'a link layer starts off');
    key('w'); await tick(5);
    assert.notEqual(root.querySelector('[data-layer="usage"]').getAttribute('display'), 'none', 'W shows the layer');
    key('w'); await tick(5);
    assert.equal(root.querySelector('[data-layer="usage"]').getAttribute('display'), 'none', 'and hides it again');
  }, { routes: GATE_ROUTES });
});

test('AC-8: a usage feed that 404s hides the row and draws nothing, with no error notice', async () => {
  await withSurface(async ({ root }) => {
    assert.equal(rowOf(root, 'usage').hidden, true);
    assert.equal(root.querySelectorAll('.usage-arc').length, 0);
    assert.doesNotMatch(root.querySelector('#dock-alerts').querySelector('.alerts-feeds').textContent, /usage/i);
  }, { search: '?panel=attention' });
});

test('AC-8: a usage feed that throws hides the row too', async () => {
  await withSurface(async ({ root }) => {
    assert.equal(rowOf(root, 'usage').hidden, true);
  }, { routes: { '/api/usage/providers': new Response('boom', { status: 500 }) } });
});

test('AC-3: T toggles the Edit trails layer when no agent is hovered or selected', async () => {
  await withSurface(async ({ root }) => {
    const box = root.querySelector('#layer-trails');
    const was = box.checked;
    key('t'); await tick(5);
    assert.equal(box.checked, !was);
  });
});

test('AC-3: the Gate verdicts badge sits on the globe and opens the layer legend', async () => {
  await withSurface(async ({ root }) => {
    const badge = collectItems(root).find((e) => e.dataset.itemType === 'layer' && e.dataset.itemId === 'gates' && /badge/.test(e.getAttribute('class') ?? ''));
    assert.ok(badge, 'a badge mark for the layer');
    assert.match(badge.getAttribute('aria-label'), /1 gate verdict/);
  }, { routes: GATE_ROUTES });
});
