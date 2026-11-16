// server/test/deep-link.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, linkFor, resolveTarget, parseSel, parseCam, formatCam, LENSES, LEGACY_VIEWS, DEFAULT_LENS } from '../../web/shared/deep-link.js';

const at = (url) => { const u = new URL(url, 'http://x'); return parseLink(u.pathname, u.search); };

test('the four pillars, in topbar order (card glmps-2-0-137 revisits D1/D3)', () => {
  assert.deepEqual(LENSES, ['surface', 'work', 'learning', 'knowledge']);
});

test('root and unknown paths open Surface; unknown is reported; a link that names now opens Surface', () => {
  assert.equal(DEFAULT_LENS, 'surface');
  assert.equal(at('/').lens, 'surface');
  const r = at('/nonsense');
  assert.equal(r.lens, 'surface');
  assert.equal(r.unknown, 'nonsense');
  assert.equal(at('/now').lens, 'surface');
  assert.equal(at('/now').unknown, null, 'the retired lens is an alias, not an unknown page');
  assert.equal(at('/alerts').lens, 'surface', 'a 1.x alerts bookmark lands on Surface');
});

test('/now links map onto the Surface equivalent, keeping the selection (RN-2)', () => {
  assert.equal(linkFor(at('/now')), '/surface');
  assert.equal(linkFor(at('/now?band=fleet')), '/surface?panel=fleet');
  assert.equal(linkFor(at('/now?band=state')), '/surface?panel=attention');
  assert.equal(linkFor(at('/now?band=state&sel=alert%3Aa2')), '/surface?panel=attention&sel=alert%3Aa2');
  assert.equal(linkFor(at('/now?band=state&sel=loop%3Awiki')), '/surface?panel=loops&sel=loop%3Awiki');
  assert.equal(linkFor(at('/now?panel=cost')), '/surface');
  assert.equal(linkFor(at('/now?band=record')), '/work?band=record');
  assert.equal(linkFor(at('/now?tool=claude-code')), '/work?band=record&tool=claude-code');
  assert.deepEqual(at('/now?sel=alert%3Aa2').sel, { type: 'alert', id: 'a2' });
});

test('round trip: every field survives linkFor -> parseLink', () => {
  const route = { lens: 'surface', layers: ['residency', 'files'], cam: { lon: -117.2, lat: 32.7, k: 4 },
    sel: { type: 'file', id: 'glmps/web/a:b.js' }, panel: 'inspector', preset: 'files' };
  const back = at(linkFor(route));
  assert.equal(back.lens, 'surface');
  assert.deepEqual(back.layers, ['residency', 'files']);
  assert.deepEqual(back.cam, { lon: -117.2, lat: 32.7, k: 4 });
  assert.deepEqual(back.sel, { type: 'file', id: 'glmps/web/a:b.js' });
  assert.equal(back.panel, 'inspector');
  assert.equal(back.preset, 'files');
});

test('the session page', () => {
  assert.equal(linkFor({ lens: 'session', sessionId: 'a b' }), '/session/a%20b');
  assert.equal(at('/session/a%20b').sessionId, 'a b');
  assert.equal(at('/sessions/abc').lens, 'session');
  assert.equal(at('/detail/abc').sessionId, 'abc');
});

test('malformed sel and cam parse to null, never throw', () => {
  for (const s of [null, '', 'nocolon', ':id', 'type:']) assert.equal(parseSel(s), null);
  for (const c of [null, '', '1,2', 'a,b,c', '0,95,1', '0,0,0', '0,0,-1']) assert.equal(parseCam(c), null);
  assert.deepEqual(parseCam('190,10,2'), { lon: -170, lat: 10, k: 2 });
  assert.equal(formatCam({ lon: -117.2, lat: 32.7, k: 4 }), '-117.20,32.70,4.00');
  assert.equal(at('/now?sel=%E0%A4%A').lens, 'surface');
});

test('every 1.x view name resolves to a lens (legacy bookmarks)', () => {
  const expect = {
    dashboard: '/surface', stageboard: '/surface?panel=fleet', 'stage-board': '/surface?panel=fleet', sessions: '/surface?panel=fleet',
    history: '/work?tab=history', analytics: '/work?tab=cost', alerts: '/surface?panel=attention', loops: '/learning?tab=loops', now: '/surface', map: '/knowledge?tab=architecture', decisions: '/knowledge?tab=decisions',
    policy: '/surface?panel=declared', engagement: '/surface?panel=declared', governance: '/surface?panel=declared',
    'substrate-loop': '/learning?tab=ledger', improvements: '/learning?tab=experiments', experiments: '/learning?tab=experiments',
    registry: '/learning?tab=capabilities', guardrails: '/learning?tab=capabilities', memory: '/learning?tab=capabilities&seg=memory',
    kanban: '/work?band=board', 'qa-trends': '/work?tab=qa',
  };
  for (const [view, link] of Object.entries(expect)) assert.equal(linkFor(at('/' + view)), link, view);
  assert.equal(at('/wiki').lens, 'knowledge');
  assert.equal(linkFor(at('/wiki')), '/knowledge?tab=wiki');
  assert.equal(linkFor(at('/kanban/glmps-12')), '/work?band=board&sel=card%3Aglmps-12');
  assert.equal(linkFor(at('/backlog/glmps-12')), '/work?band=board&sel=card%3Aglmps-12');
});

test('every server alert target lands on a lens (alert deep links)', () => {
  assert.equal(resolveTarget({ view: 'loops', loop: 'wiki' }), '/learning?tab=loops&sel=loop%3Awiki');
  assert.equal(resolveTarget({ view: 'loops' }), '/learning?tab=loops');
  assert.equal(resolveTarget({ view: 'governance' }), '/surface?panel=declared');
  assert.equal(resolveTarget({ view: 'sessions', id: 's1' }), '/session/s1');
  assert.equal(resolveTarget({ view: 'kanban', id: 'mc-3' }), '/work?band=board&sel=card%3Amc-3');
  assert.equal(resolveTarget({ view: 'goals', id: 'g1' }), '/surface?panel=attention', 'a retired goals link falls through to the default');
  assert.equal(resolveTarget({ view: 'stage-board' }), '/surface?panel=fleet');
  assert.equal(resolveTarget({ view: 'code-critic' }), '/surface?panel=attention');
  assert.equal(resolveTarget({}), '/surface?panel=attention');
  assert.equal(resolveTarget({ view: 'wiki' }), '/knowledge?tab=wiki');
  assert.equal(resolveTarget({ view: 'alerts' }), '/surface?panel=attention', 'alerts live on Surface, not Evolution');
  assert.equal(resolveTarget({ view: 'experiments' }), '/learning?tab=experiments');
  assert.equal(resolveTarget({ view: 'registry', id: 'x' }), '/learning?tab=capabilities');
});

test('the legacy table covers every view name the server emits today', () => {
  // grep -rhno "view: *'[a-z-]*'" server/lib server/server.js (2026-09-23)
  for (const v of ['analytics', 'governance', 'kanban', 'map', 'registry', 'sessions', 'skills', 'stage-board', 'substrate-loop']) {
    assert.ok(LEGACY_VIEWS[v] || v === 'sessions', `no lens for alert view '${v}'`);
  }
});

test('/loops lands on the Evolution Loops tab, keeping the loop selection', () => {
  const r = at('/loops?sel=loop%3Asession-judge');
  assert.equal(r.lens, 'learning');
  assert.equal(r.tab, 'loops');
  assert.deepEqual(r.sel, { type: 'loop', id: 'session-judge' });
  assert.equal(r.unknown, null);
  assert.equal(linkFor(r), '/learning?tab=loops&sel=loop%3Asession-judge');
});

test('/personality lands on Evolution Capabilities, file view, keeping the card selection', () => {
  const r = at('/personality?sel=card%3Aprompt');
  assert.equal(r.lens, 'learning');
  assert.equal(r.tab, 'capabilities');
  assert.equal(r.seg, 'files');
  assert.equal(linkFor(r), '/learning?tab=capabilities&seg=files&sel=card%3Aprompt');
});

test('links built for the folded-in lenses name their Evolution tab', () => {
  assert.equal(linkFor({ lens: 'loops', sel: { type: 'loop', id: 'x' } }), '/learning?tab=loops&sel=loop%3Ax');
  assert.equal(linkFor({ lens: 'personality' }), '/learning?tab=capabilities&seg=files');
  assert.equal(linkFor({ page: 'wiki' }), '/knowledge?tab=wiki');
});

test('/wiki/ lands on the Knowledge Wiki tab', () => {
  for (const p of ['/wiki', '/wiki/']) {
    const r = at(p);
    assert.equal(r.lens, 'knowledge', p);
    assert.equal(r.tab, 'wiki', p);
    assert.equal(r.unknown, null, p);
  }
});

test('the tab parameter round trips on every pillar', () => {
  for (const lens of ['surface', 'work', 'learning', 'knowledge']) {
    const r = at(linkFor({ lens, tab: 'some-tab', sel: { type: 'card', id: 'c1' } }));
    assert.equal(r.lens, lens);
    assert.equal(r.tab, 'some-tab');
    assert.deepEqual(r.sel, { type: 'card', id: 'c1' });
  }
});
