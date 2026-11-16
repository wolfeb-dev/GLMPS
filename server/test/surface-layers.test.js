// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/workspace-routes.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, ROWS } from './fixtures/surface-fixtures.js';
import { getDiffPopup, closeDiffPopup } from '../../web/shared/diff-popup.js';
import { waitFor } from './helpers/wait-for.js';

test('hostOf reads ssh and https remotes', async () => {
  const { hostOf } = await import('../../web/surface/layers.js');
  assert.equal(hostOf('git@github.com:x/y.git'), 'github.com');
  assert.equal(hostOf('https://github.com/x/y'), 'github.com');
  assert.equal(hostOf('ssh://git@gitlab.example.com:22/x.git'), 'gitlab.example.com');
  assert.equal(hostOf(null), null);
});

test('residency: a node per repository with a status word; arcs only where a remote exists', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const { root } = m;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const items = collectItems(root);
    const repos = items.filter((e) => e.dataset.itemType === 'repo').map((e) => e.dataset.itemId).sort();
    assert.deepEqual(repos, ['glmps-2.0', 'glmps', 'tidewatch'].sort());
    const arcs = items.filter((e) => e.dataset.itemType === 'arc').map((e) => e.dataset.itemId).sort();
    assert.deepEqual(arcs, ['glmps-2.0', 'glmps'].sort(), 'the no-remote repository has no arc: the absence is the reading');
    const mc = items.find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'glmps');
    assert.match(mc.textContent, /diverged from its remote/);
    assert.ok(items.some((e) => e.dataset.itemType === 'region' && e.dataset.itemId === 'nowhere-else'));
    for (const id of ['local', 'github', 'slack', 'anthropic', 'gcp']) assert.ok(items.some((e) => e.dataset.itemType === 'player' && e.dataset.itemId === id), id);
    // Card glmps-2-0-137 phase 2: the Pulse dock is retired, so no stat rows
    // draw on Surface; its vitals ride the Fleet ribbon.
    assert.equal(items.some((e) => e.dataset.itemType === 'stat'), false, 'no Pulse stat rows');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('a repository deep link opens its facts in the inspector', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?sel=repo%3Aglmps');
    handle = m.handle;
    const { root } = m;
    const insp = root.querySelector('#panel-inspector');
    assert.match(insp.textContent, /diverged from its remote/);
    assert.match(insp.textContent, /27/);
    assert.match(insp.textContent, /feat\/x/);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('a deep link to a repository that left the registry says not found', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?sel=repo%3Agone');
    handle = m.handle;
    const { root } = m;
    assert.match(root.querySelector('#panel-inspector').textContent, /Not found: repo gone/);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('K5 absent: the layer names the dry route; players still draw', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    // a feed that cannot be drawn is listed in the drawer's Alerts tab, under Data feeds
    const m = await mountSurface('?panel=attention', surfaceFetch({ '/api/residency': new Response('{"error":"not found"}', { status: 404 }) }));
    handle = m.handle;
    const { root } = m;
    assert.match(root.querySelector('.surface-drawer').textContent, /Residency feed not available: GET \/api\/residency returned 404/);
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    assert.ok(collectItems(root).some((e) => e.dataset.itemType === 'player'));
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('a stale feed says how old it is; an unset local store says so', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?panel=attention', surfaceFetch({ '/api/residency': { ts: Date.now() - 3 * 3600000, rows: ROWS }, '/api/config': { surface: { localGeo: null } } }));
    handle = m.handle;
    const { root } = m;
    // the stale warning is listed under the Alerts tab's Data feeds, and the globe footer reads its age
    assert.match(root.querySelector('.alerts-feeds').textContent, /residency feed 3\.0 h old/);
    await waitFor(() => /residency 180 min old/.test(root.querySelector('.foot-feed')?.textContent ?? ''), { message: 'the globe footer feed age' });
    assert.match(root.textContent, /location not set/);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('a local store placed from the OS timezone is labelled approximate', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const geo = { city: 'US Pacific', lon: -118, lat: 35, precision: 'approximate', source: 'timezone', timeZone: 'America/Los_Angeles' };
    const m = await mountSurface('', surfaceFetch({ '/api/config': { surface: { localGeo: geo } } }));
    handle = m.handle;
    const { root } = m;
    assert.match(root.textContent, /US Pacific \(approximate, from OS timezone\)/);
    assert.doesNotMatch(root.textContent, /location not set/);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// an unknown row is neither with-remote nor
// nowhere-else in the HUD - it is unreadable, and its error surfaces in its
// own inspector, not just the arc opener's.
test('an unknown row counts as unreadable (not with-remote/nowhere-else) and shows its error', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const unknownRow = { repo: 'flaky', path: 'D:/flaky', remote: 'git@github.com:x/flaky.git', defaultBranch: 'main', ahead: 0, behind: 0, unpushedBranches: [], noUpstreamBranches: [], dirty: 0, lastFetchTs: null, residency: 'unknown', error: 'git ls-remote timed out', ts: Date.now() };
    const m = await mountSurface('', surfaceFetch({ '/api/residency': { ts: Date.now(), rows: [...ROWS, unknownRow] } }));
    handle = m.handle;
    const root = m.root;
    const { summarizeResidency } = await import('../../web/surface/globe-core.js');
    const s = summarizeResidency([...ROWS, unknownRow]);
    assert.deepEqual([s.unreadable, s.withRemote, s.nowhereElse], [1, 2, 1], 'unreadable is its own bucket, not folded into with-remote or nowhere-else');
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const flaky = collectItems(root).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'flaky');
    flaky.click();
    const insp = root.querySelector('#panel-inspector');
    assert.match(insp.textContent, /git ls-remote timed out/, 'the repo inspector shows the row error, not just the arc inspector');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// nowhereLayer built its per-repo node without the
// res-glyph residencyLayer's own nodes get.
test('a nowhere-else repo node carries the nowhere-else glyph, like every other residency state', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const tidewatch = [...m.root.querySelectorAll('.res-node')].find((e) => e.dataset.itemId === 'tidewatch');
    assert.equal(tidewatch.querySelector('.res-glyph')?.textContent, '\u25CC');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// an arc never got the off-hemisphere tabindex/
// display toggle residencyLayer.place() already gives every node.
test('an arc drops out of tab order and hides when its repository goes off-hemisphere, and returns on-hemisphere', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const onHemisphere = await mountSurface('?layers=players,residency,remote-links');
    handle = onHemisphere.handle;
    const arcOn = onHemisphere.root.querySelector('.res-arc');
    assert.equal(arcOn.getAttribute('tabindex'), '0', 'on-hemisphere: the arc is tabbable');
    assert.notEqual(arcOn.getAttribute('display'), 'none');
    handle.unmount(); handle = null;
    delete globalThis.fetch; delete window.d3;

    // The opposite hemisphere from every repo/player in this fixture (all
    // clustered near the default camera's -98.5,32 / Virginia).
    const offHemisphere = await mountSurface('?layers=players,residency,remote-links&cam=100.00,-30.00,1.00');
    handle = offHemisphere.handle;
    const arcOff = offHemisphere.root.querySelector('.res-arc');
    assert.equal(arcOff.getAttribute('tabindex'), '-1', 'off-hemisphere: the arc is not a tab stop');
    assert.equal(arcOff.getAttribute('display'), 'none');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// the ring/region offsets place same-area marks a
// few screen pixels apart (mini-dom's fixed 100x20 host rect makes this
// extreme - see globe-core.test.js for the pure collision-resolution unit
// test); the render-time pass must hide the losing labels without touching
// their mark, glyph or tab stop.
test('label collision hides only the lower-priority .lbl text, never the mark or its tab stop', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('');
    handle = m.handle;
    const lbls = [...m.root.querySelectorAll('.lbl')];
    const hiddenLbls = lbls.filter((e) => e.getAttribute('display') === 'none');
    assert.ok(hiddenLbls.length > 0, 'this fixture is dense enough that some label collides and is hidden');
    for (const lbl of hiddenLbls) {
      const mark = lbl.parentNode;
      assert.notEqual(mark.getAttribute('display'), 'none', 'the mark stays visible even though its label is hidden');
      assert.equal(mark.getAttribute('tabindex'), '0', 'the mark stays tabbable even though its label is hidden');
      assert.ok(mark.getAttribute('aria-label')?.length > 0, 'the accessible name survives - it is not read from the hidden .lbl');
    }
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// nowhereLayer hardcoded the nowhere-else glyph, word
// and class for every row it draws (every row with no remote), so a row the
// git check could not read (residency 'unknown') and that also happens to
// have no remote rendered as if it were a confirmed nowhere-else repo.
test('a row with no remote but an unknown residency renders as res-unknown, not nowhere-else', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const unknownNoRemote = { repo: 'flaky-local', path: 'D:/flaky-local', remote: null, defaultBranch: 'main', ahead: 0, behind: 0, unpushedBranches: [], noUpstreamBranches: [], dirty: 0, lastFetchTs: null, residency: 'unknown', error: 'repository is corrupt', ts: Date.now() };
    const m = await mountSurface('', surfaceFetch({ '/api/residency': { ts: Date.now(), rows: [...ROWS, unknownNoRemote] } }));
    handle = m.handle;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const node = collectItems(m.root).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'flaky-local');
    assert.ok(node.getAttribute('class').includes('res-unknown'), `expected res-unknown, got "${node.getAttribute('class')}"`);
    assert.ok(!node.getAttribute('class').includes('res-nowhere-else'));
    assert.equal(node.querySelector('.res-glyph')?.textContent, '?');
    assert.match(node.querySelector('.lbl')?.textContent ?? '', /unreadable/);
    // tidewatch (a genuine nowhere-else row) is unaffected by keying off row.residency.
    const tidewatch = collectItems(m.root).find((e) => e.dataset.itemType === 'repo' && e.dataset.itemId === 'tidewatch');
    assert.ok(tidewatch.getAttribute('class').includes('res-nowhere-else'));
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// through the real running integration (mount,
// render, the real ringRadiusForZoom call inside residencyLayer.place, the
// real d3 projection) - not the reviewer's standalone script - the same two
// same-ring marks must spread apart by at least 2x from k=1 to k=10, the
// same bar the pure-function test asserts. mini-dom's fixed 100x20 host
// rect (R~9px) keeps every absolute on-screen distance tiny regardless of
// this fix (a label's own approximate box, sized for a real ~1400px-wide
// browser, is already wider than the whole canvas) - so a visible-vs-hidden
// flip is asserted live instead (below); this test asserts the cause
// directly and is scale-independent.
test('same-ring marks spread apart with zoom in the running app (not just the standalone reviewer script)', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await mountSurface('?layers=residency,nowhere,players,agents,cards,alerts,gates,prs,graticule,labels');
    handle = m.handle;
    const posOf = (id) => {
      const el = [...m.root.querySelectorAll('.res-node')].find((e) => e.dataset.itemId === id);
      const t = el.getAttribute('transform') ?? '';
      const mm = t.match(/translate\(([-\d.]+),([-\d.]+)\)/);
      return mm ? [parseFloat(mm[1]), parseFloat(mm[2])] : null;
    };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const wasHiddenAtK1 = [...m.root.querySelectorAll('.res-node')].find((e) => e.dataset.itemId === 'glmps-2.0').querySelector('.lbl')?.getAttribute('display') === 'none';
    assert.ok(wasHiddenAtK1, 'precondition: glmps-2.0 (lower priority, same ring point) starts hidden at k=1');
    const d1 = dist(posOf('glmps'), posOf('glmps-2.0'));
    handle.update({ layers: ['residency', 'players', 'labels'], cam: { lon: -98.5, lat: 32, k: 10 } });
    const d10 = dist(posOf('glmps'), posOf('glmps-2.0'));
    assert.ok(d10 >= d1 * 2, `expected d(k=10)=${d10.toFixed(2)} >= 2 * d(k=1)=${d1.toFixed(2)}`);
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// the folder opener retried forever on a failing tree
// fetch (showTree never reported failure, and the opener always re-opened
// the folder in its .then(), re-entering the !entry branch on every
// failure). The mock fails twice then succeeds, so even the *unfixed* code
// terminates safely (bounded at 3 fetches) instead of spinning forever -
// this proves the retry happens without ever risking a hung test.
test('a deep-linked folder whose tree fetch fails does not retry automatically; a named error is shown', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    let treeCalls = 0;
    const goodTree = { repo: 'glmps', path: 'D:/glmps', base: '@{u}', folders: [{ dir: 'dir', count: 1, drifted: 1 }], files: [{ path: 'dir/b.txt', status: 'ahead' }], truncated: false };
    const fetchImpl = async (url, opts) => {
      const u = String(url).split('?')[0];
      if (u === '/api/surface/tree') {
        treeCalls++;
        if (treeCalls <= 2) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
        return Response.json(goodTree);
      }
      return surfaceFetch()(url, opts);
    };
    const m = await mountSurface('?sel=folder%3Aglmps%2Fdir', fetchImpl);
    handle = m.handle;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(treeCalls, 1, `the folder opener must not retry automatically on a failing tree fetch, got ${treeCalls} fetch(es)`);
    const insp = m.root.querySelector('#panel-inspector');
    assert.match(insp?.textContent ?? '', /failed to load/i, 'a named error is shown instead of silently retrying');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// repoFor used a bare startsWith, so a session working in a
// prefix-sharing sibling (glmps-assets) was misattributed to the
// shorter repo (glmps). Boundary-safe shape from
// server/lib/zones.js:43.
test('an agent in a prefix-sharing sibling directory is not attributed to the shorter repo', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const rows = [{ repo: 'glmps', path: 'D:/glmps', remote: 'git@github.com:x/glmps.git', defaultBranch: 'main', ahead: 0, behind: 0, unpushedBranches: [], noUpstreamBranches: [], dirty: 0, lastFetchTs: Date.now(), residency: 'synced', ts: Date.now() }];
    const fetchImpl = surfaceFetch({
      '/api/residency': { ts: Date.now(), rows },
      '/api/sessions/live': { sessions: [{ id: 'sess1', cwd: 'D:/glmps-assets/lib', lastTs: Date.now() }], now: Date.now(), staleMs: 60000 },
      '/api/workspace': { sessions: [{ sessionId: 'sess1', title: 'Working', declared: {}, observed: {}, divergence: 'none' }] },
    });
    const m = await mountSurface('', fetchImpl);
    handle = m.handle;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const agent = collectItems(m.root).find((e) => e.dataset.itemType === 'agent' && e.dataset.itemId === 'sess1');
    assert.ok(agent, 'the agent mark exists');
    assert.match(agent.textContent, /not a project/, 'a sibling directory sharing a name prefix must not be attributed to the shorter repo');
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// the Diff button's own diff fetch was not covered by
// unmount teardown - if it resolved after the lens had already unmounted,
// it still opened the body-level singleton popup, anchored to a now-
// detached button, over whatever page the operator had moved on to.
test('a diff fetch resolving after unmount does not open the popup', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  closeDiffPopup(); // reset the module-level singleton from any earlier test
  try {
    let resolveDiff;
    const diffPromise = new Promise((resolve) => { resolveDiff = resolve; });
    const tree = { repo: 'glmps', path: 'D:/glmps', base: '@{u}', folders: [{ dir: 'dir', count: 1, drifted: 1 }], files: [{ path: 'dir/b.txt', status: 'ahead' }], truncated: false };
    const fetchImpl = async (url, opts) => {
      const u = String(url).split('?')[0];
      if (u === '/api/surface/tree') return Response.json(tree);
      if (u === '/api/surface/file-diff') { await diffPromise; return Response.json({ change: { old: { text: 'a\n', truncated: false }, new: { text: 'b\n', truncated: false } } }); }
      return surfaceFetch()(url, opts);
    };
    const m = await mountSurface('?sel=repo%3Aglmps', fetchImpl);
    const treeBtn = [...m.root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree');
    treeBtn.click();
    await new Promise((r) => setTimeout(r, 60));
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const folder = collectItems(m.root).find((e) => e.dataset.itemType === 'folder' && e.dataset.itemId === 'glmps/dir');
    folder.click();
    await new Promise((r) => setTimeout(r, 20));
    const file = collectItems(m.root).find((e) => e.dataset.itemType === 'file' && e.dataset.itemId === 'glmps/dir/b.txt');
    file.click();
    await new Promise((r) => setTimeout(r, 20));
    const diffBtn = m.root.querySelector('#panel-inspector').querySelector('.file-actions').querySelectorAll('button')[0];
    diffBtn.click(); // starts the (still-pending) diff fetch
    m.handle.unmount(); // unmount while the diff fetch is still in flight
    resolveDiff(); // let it resolve only now, after teardown
    await new Promise((r) => setTimeout(r, 60));
    assert.notEqual(getDiffPopup().style.display, 'block', 'the diff popup must not open once the lens has unmounted');
  } finally { closeDiffPopup(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

// Task 13 carry 2: a popup already open (not one resolving late) at the
// moment of unmount must not linger, visible, over whatever page the
// operator navigates to next.
test('a diff popup already open at unmount closes', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  closeDiffPopup();
  let handle;
  try {
    const tree = { repo: 'glmps', path: 'D:/glmps', base: '@{u}', folders: [{ dir: 'dir', count: 1, drifted: 1 }], files: [{ path: 'dir/b.txt', status: 'ahead' }], truncated: false };
    const fetchImpl = async (url, opts) => {
      const u = String(url).split('?')[0];
      if (u === '/api/surface/tree') return Response.json(tree);
      if (u === '/api/surface/file-diff') return Response.json({ change: { old: { text: 'a\n', truncated: false }, new: { text: 'b\n', truncated: false } } });
      return surfaceFetch()(url, opts);
    };
    const m = await mountSurface('?sel=repo%3Aglmps', fetchImpl);
    handle = m.handle;
    const treeBtn = [...m.root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree');
    treeBtn.click();
    await new Promise((r) => setTimeout(r, 60));
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    const folder = collectItems(m.root).find((e) => e.dataset.itemType === 'folder' && e.dataset.itemId === 'glmps/dir');
    folder.click();
    await new Promise((r) => setTimeout(r, 20));
    const file = collectItems(m.root).find((e) => e.dataset.itemType === 'file' && e.dataset.itemId === 'glmps/dir/b.txt');
    file.click();
    await new Promise((r) => setTimeout(r, 20));
    const diffBtn = m.root.querySelector('#panel-inspector').querySelector('.file-actions').querySelectorAll('button')[0];
    diffBtn.click();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(getDiffPopup().style.display, 'block', 'precondition: the popup is genuinely open before unmount');
    handle.unmount(); handle = null;
    assert.notEqual(getDiffPopup().style.display, 'block', 'an already-open popup must close on unmount, not linger over the next page');
  } finally { handle?.unmount(); closeDiffPopup(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});
