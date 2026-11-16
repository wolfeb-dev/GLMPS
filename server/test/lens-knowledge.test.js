// Routes under test: server/lib/routes/workspace-routes.js
// Card glmps-2-0-137 phase 1: Knowledge is a lens. It opens on the Wiki tab
// (the wiki view that used to be the separate /wiki/ page), its tab strip is a
// proper tab list, and leaving it stops the wiki's own polling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { parseLink } from '../../web/shared/deep-link.js';
import { waitFor } from './helpers/wait-for.js';

const WIKI = { project: 'glmps', root: '/repo', base: '/wiki-src', manifest: { tierLlm: true, generatedAt: 't1' }, sections: [{ slug: 'a', title: 'A', file: 'a.html' }] };

const CATALOG = { generatedAt: 1, loops: [], graphs: [{ name: 'goal-graph', builtBy: 'goal-sweeper', why: 'Shows goals', steers: [{ card: 'rules', mode: 'reads' }] }] };
const PERSONALITY = { groups: [{ id: 'g', name: 'G', cards: [{ id: 'rules', name: 'Follow-up rules' }] }] };
const DECISIONS = { entries: [{ repo: 'glmps', commit: 'abcdef1234567890', what: 'Four pillars', why: 'One home per view', ts: 1 }] };

async function mountKnowledge(path = '/knowledge', search = '') {
  const dom = installMiniDom({ pathname: path, search });
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(`${opts.method ?? 'GET'} ${u}`);
    if (u.startsWith('/api/projects')) return Response.json({ projects: [] });
    if (u.startsWith('/api/wiki/ticket')) return Response.json({ ticket: 't' });
    if (u.startsWith('/api/wiki')) return Response.json(WIKI);
    if (u.startsWith('/api/loops/catalog')) return Response.json(CATALOG);
    if (u.startsWith('/api/personality')) return Response.json(PERSONALITY);
    if (u.startsWith('/api/decisions')) return Response.json(DECISIONS);
    if (u.startsWith('/api/graph')) return Response.json({ nodes: [], links: [] });
    if (u.startsWith('/api/state')) return Response.json({ sessions: [] });
    if (u.startsWith('/api/config')) return Response.json({});
    if (u.startsWith('/api/workspace')) return Response.json({ sessions: [] });
    return new Response('{}', { status: 404 });
  };
  const lens = await import('../../web/knowledge/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const ctx = { getState: () => ({ sessions: [] }), toast: () => {}, go: () => {}, handlers: {}, isCurrent: () => true };
  const handle = await lens.mount(root, parseLink(path, search), ctx);
  return { lens, root, handle, calls, done: () => { try { handle.unmount(); } catch {} delete globalThis.fetch; dom.restore(); } };
}

test('Knowledge opens on the Wiki tab with the wiki view inside it', async () => {
  const m = await mountKnowledge();
  try {
    const tabs = m.root.querySelectorAll('[role="tab"]');
    assert.deepEqual(tabs.map((t) => t.textContent), m.lens.TABS.map((t) => t.label));
    assert.equal(tabs[0].textContent, 'Wiki');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(m.root.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Knowledge sections');
    assert.equal(m.root.querySelector('h2')?.textContent, 'Knowledge', 'the pillar has a page heading');
    await waitFor(() => m.root.querySelector('.wiki-root'), { message: 'the wiki view' });
  } finally { m.done(); }
});

test('an old /wiki/ link mounts the same wiki view on Knowledge', async () => {
  const m = await mountKnowledge('/wiki/');
  try {
    await waitFor(() => m.root.querySelector('.wiki-root'), { message: 'the wiki view' });
    assert.ok(m.calls.some((c) => c.startsWith('GET /api/wiki')));
  } finally { m.done(); }
});

test('leaving Knowledge runs the wiki cleanup: no wiki fetch after unmount', async () => {
  const m = await mountKnowledge();
  try {
    await waitFor(() => m.root.querySelector('.wiki-root'), { message: 'the wiki view' });
    m.handle.unmount();
    const before = m.calls.length;
    window.dispatchEvent(new MiniEvent('message', { data: { type: 'wiki-nav', slug: 'a' } }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(m.calls.length, before);
  } finally { m.done(); }
});

test('the tab strip moves focus with the arrow keys and Home/End', async () => {
  const { createTabs } = await import('../../web/shared/tabs.js');
  const dom = installMiniDom({ pathname: '/knowledge' });
  try {
    const host = document.createElement('div'); document.body.appendChild(host);
    const picked = [];
    const t = createTabs(host, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], { label: 'Test', idPrefix: 'tt', onSelect: (id) => picked.push(id) });
    t.select('a');
    const strip = host.querySelector('[role="tablist"]');
    const key = (k) => strip.dispatchEvent(new MiniEvent('keydown', { key: k }));
    key('ArrowRight'); key('ArrowRight'); key('ArrowRight'); key('End'); key('Home'); key('ArrowLeft');
    assert.deepEqual(picked, ['a', 'b', 'c', 'a', 'c', 'a', 'c']);
    assert.equal(document.activeElement, host.querySelector('#tt-tab-c'));
    const panel = t.panel('c');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), 'tt-tab-c');
    assert.equal(panel.hidden, false);
    assert.equal(t.panel('a').hidden, true);
    assert.equal(host.querySelector('#tt-tab-c').tabIndex, 0);
    assert.equal(host.querySelector('#tt-tab-a').tabIndex, -1);
  } finally { dom.restore(); }
});

test('Knowledge has Wiki, Architecture graph and Decisions tabs, in that order (phase 5)', async () => {
  const m = await mountKnowledge();
  try {
    assert.deepEqual(m.root.querySelectorAll('[role="tab"]').map((t) => t.textContent), ['Wiki', 'Architecture graph', 'Decisions']);
  } finally { m.done(); }
});

test('the Architecture graph tab shows the code map full width with the Graphs table beneath it', async () => {
  const m = await mountKnowledge('/knowledge', '?tab=architecture');
  try {
    const panel = m.root.querySelector('#kn-panel-architecture');
    assert.equal(panel.hidden, false);
    await waitFor(() => panel.querySelector('.lp-graphs')?.querySelector('td'), { message: 'the Graphs table' });
    const tds = panel.querySelector('.lp-graphs').querySelectorAll('td').map((t) => t.textContent);
    assert.deepEqual(tds, ['goal-graph', 'goal-sweeper', 'Shows goals', 'Follow-up rules']);
    await waitFor(() => panel.querySelector('.map-main'), { message: 'the code map' });
    assert.ok(m.calls.some((c) => c.startsWith('GET /api/graph')), 'the map asked for the graph');
  } finally { m.done(); }
});

test('the Decisions tab shows the decision log', async () => {
  const m = await mountKnowledge('/knowledge', '?tab=decisions');
  try {
    const panel = m.root.querySelector('#kn-panel-decisions');
    assert.equal(panel.hidden, false);
    await waitFor(() => panel.querySelector('.dl-toolbar'), { message: 'the decision log' });
    assert.ok(m.calls.some((c) => c.startsWith('GET /api/decisions')));
  } finally { m.done(); }
});

test('old map and decisions links, and the links the modules build, land on Knowledge tabs', async () => {
  const { resolveTarget, linkFor } = await import('../../web/shared/deep-link.js');
  const map = parseLink('/map');
  assert.equal(map.lens, 'knowledge'); assert.equal(map.tab, 'architecture');
  const mapSession = parseLink('/map/s-1');
  assert.deepEqual(mapSession.sel, { type: 'session', id: 's-1' });
  const dec = parseLink('/decisions');
  assert.equal(dec.lens, 'knowledge'); assert.equal(dec.tab, 'decisions');
  assert.equal(resolveTarget({ view: 'decisions' }), '/knowledge?tab=decisions');
  assert.equal(resolveTarget({ view: 'map', id: 's-2' }), '/knowledge?tab=architecture&sel=session%3As-2');
  assert.equal(linkFor({ lens: 'knowledge', tab: 'architecture' }), '/knowledge?tab=architecture');
});

// Card glmps-2-0-runtime-139 finding 2: the Architecture tab loads once per
// mount, so a later route naming another session must still re-focus the map.
test('a route naming another session re-focuses the already loaded map', async () => {
  const sessions = [
    { id: 's-1', live: true, tool: 'claude-code', cwd: '/r/one', lastTs: Date.now() },
    { id: 's-2', live: true, tool: 'claude-code', cwd: '/r/two', lastTs: Date.now() },
  ];
  const m = await mountKnowledge('/knowledge', '?tab=architecture&sel=session%3As-1');
  const base = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).startsWith('/api/state') ? Response.json({ sessions }) : base(url, opts));
  const graphCalls = () => m.calls.filter((c) => c.startsWith('GET /api/graph?'));
  try {
    await m.handle.update(parseLink('/knowledge', '?tab=architecture&sel=session%3As-1'));
    await m.handle.update(parseLink('/knowledge', '?tab=architecture&sel=session%3As-2'));
    await waitFor(() => graphCalls().some((c) => c.includes(encodeURIComponent('/r/two'))), { message: 'the map re-drawn around s-2' });
    const before = graphCalls().length;
    await m.handle.update(parseLink('/knowledge', '?tab=architecture&sel=session%3As-2'));
    assert.equal(graphCalls().length, before, 'the same session does not re-draw the map');
  } finally { m.done(); }
});
