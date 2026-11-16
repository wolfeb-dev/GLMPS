// Routes under test: server/lib/routes/surface-routes.js
// Surface v2 U5: the recent-edits window with its diff, editor and IDE actions,
// against a faked GET /api/surface/edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { surfaceFetch, mountSurface, EDITS } from './fixtures/surface-fixtures.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const GIT_CHANGE = { old: { text: 'before', truncated: false }, new: { text: 'after git', truncated: false } };

async function withLens(fn, { overrides = {}, fetchImpl = null } = {}) {
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  const calls = []; const opened = []; const ide = [];
  try {
    const inner = surfaceFetch({ '/api/surface/file-diff': { change: GIT_CHANGE }, ...overrides });
    const m = await mountSurface('', fetchImpl ?? (async (url, opts) => { calls.push(String(url)); return inner(url, opts); }), {
      fileActions: { openFileEditor: async (p, o) => { opened.push([p, o]); }, openFileInIde: async (p) => { ide.push(p); return { ok: true }; } },
    });
    handle = m.handle;
    await tick();
    await fn({ ...m, calls, opened, ide });
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
}
const win = (root) => root.querySelector('#dock-edits');
const rows = (root) => win(root).querySelectorAll('.erow');
const main = (row) => row.querySelector('.erow-main');
const diffCalls = (calls) => calls.filter((u) => u.startsWith('/api/surface/file-diff'));

test('the window opens by default with a working session and lists edits newest first', async () => {
  await withLens(async ({ root }) => {
    assert.ok(!win(root).hidden, 'open by default: a session is working');
    assert.equal(win(root).querySelector('.surface-panel-title').textContent, 'Recent edits');
    const rs = rows(root);
    assert.deepEqual(rs.map((r) => r.querySelector('.name').textContent), ['app.js', 'CLAUDE.md', 'gone.md']);
    assert.match(rs[0].textContent, /glmps/); assert.match(rs[0].textContent, /agent s1/); assert.doesNotMatch(rs[0].textContent, /wire the globe/, 'the session summary is not shown'); assert.match(rs[0].textContent, /\+4/); assert.match(rs[0].textContent, /-1/);
    assert.match(rs[1].textContent, /outside a repository/); assert.match(rs[1].textContent, /agent s2/);
    assert.match(rs[2].textContent, /deleted/); assert.match(rs[2].textContent, /s3/, 'a session without a title shows its id');
    assert.ok(rs[0].querySelector('.dot').classList.contains('working')); assert.ok(rs[1].querySelector('.dot').classList.contains('idle'));
    assert.match(rs[0].querySelector('.age').textContent, /s ago|just now/);
    assert.equal(main(rs[0]).dataset.itemType, 'edit');
    assert.ok(main(rs[0]).dataset.link.startsWith('/surface'));
  });
});

test('selecting a row shows its diff: git for a repository file, the event change for any other, a note when there is none', async () => {
  await withLens(async ({ root, calls }) => {
    const pane = () => win(root).querySelector('.epane');
    main(rows(root)[0]).click(); await tick();
    assert.equal(diffCalls(calls).length, 1);
    assert.match(diffCalls(calls)[0], /repo=glmps/); assert.match(diffCalls(calls)[0], /path=web%2Fapp\.js/);
    assert.match(pane().querySelector('.diff-new').textContent, /after git/);
    main(rows(root)[1]).click(); await tick();
    assert.equal(diffCalls(calls).length, 1, 'a file outside every repository needs no git call');
    assert.match(pane().querySelector('.diff-new').textContent, /new line/);
    main(rows(root)[0]).click(); await tick();
    assert.equal(diffCalls(calls).length, 1, 'reselecting is served from the cache');
  });
  await withLens(async ({ root }) => {
    main(rows(root)[2]).click(); await tick();
    assert.match(win(root).querySelector('.epane').textContent, /No diff captured for this file/);
  }, { overrides: { '/api/surface/file-diff': { change: null } } });
});

test('each row has Edit (with its diff) and Open in IDE', async () => {
  await withLens(async ({ root, opened, ide }) => {
    const btn = (row, t) => row.querySelectorAll('button').find((b) => b.textContent === t);
    btn(rows(root)[0], 'Edit').click(); await tick();
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], 'D:/glmps/web/app.js');
    assert.deepEqual(opened[0][1].diff, GIT_CHANGE);
    btn(rows(root)[1], 'Edit').click(); await tick();
    assert.equal(opened[1][0], 'C:/Users/me/.claude/CLAUDE.md');
    assert.equal(opened[1][1].diff.new.text, 'new line', 'a file outside a repository opens with the event diff');
    btn(rows(root)[2], 'Open in IDE').click();
    assert.deepEqual(ide, ['D:/glmps-2.0/gone.md']);
    btn(rows(root)[2], 'Edit').click(); await tick();
    assert.equal(opened.length, 3, 'a deleted file still opens in the editor');
  });
});

test('the window refreshes on a 5 second interval that unmount clears', async () => {
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const live = new Map();
  globalThis.setInterval = (fn, ms, ...a) => { const h = realSet(fn, ms, ...a); live.set(h, ms); return h; };
  globalThis.clearInterval = (h) => { live.delete(h); return realClear(h); };
  const dom = installMiniDom({ pathname: '/surface' });
  try {
    const m = await mountSurface('');
    await tick();
    assert.ok([...live.values()].includes(5000), 'a 5000 ms refresh is running');
    m.handle.unmount();
    assert.ok(![...live.values()].includes(5000), 'unmount cleared it');
  } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('a failed feed is named, and a slow one does not hold Surface back', async () => {
  await withLens(async ({ root }) => {
    root.querySelector('.surface-iconrail').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Recent edits').click();
    assert.match(win(root).textContent, /Recent edits not available: GET \/api\/surface\/edits returned 500/);
    assert.ok(root.querySelector('.player-local'), 'the globe still mounted');
  }, { overrides: { '/api/surface/edits': new Response('{"error":"boom"}', { status: 500 }) } });
  const base = surfaceFetch();
  const dom = installMiniDom({ pathname: '/surface' });
  let handle;
  try {
    const m = await Promise.race([mountSurface('', (url, o) => (String(url).startsWith('/api/surface/edits') ? new Promise(() => {}) : base(url, o))), tick(2000).then(() => 'timeout')]);
    assert.notEqual(m, 'timeout'); handle = m.handle;
  } finally { handle?.unmount(); delete globalThis.fetch; delete window.d3; dom.restore(); }
});

test('with nobody working the window starts closed; the rail button and the D key toggle it', async () => {
  const idle = { ...EDITS, edits: EDITS.edits.map((e) => ({ ...e, state: 'idle' })) };
  await withLens(async ({ root }) => {
    assert.ok(win(root).hidden, 'closed: nothing is working');
    const key = (k, target = document.body) => window.dispatchEvent(new MiniEvent('keydown', { key: k, target }));
    key('d', document.createElement('input')); assert.ok(win(root).hidden, 'typing in a field never toggles it');
    key('d'); assert.ok(!win(root).hidden, 'D opens it');
    key('d'); assert.ok(win(root).hidden, 'D closes it');
    const railBtn = root.querySelector('.surface-iconrail').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Recent edits');
    railBtn.click(); assert.ok(!win(root).hidden);
  }, { overrides: { '/api/surface/edits': idle } });
});

test('an empty feed says so', async () => {
  await withLens(async ({ root }) => {
    root.querySelector('.surface-iconrail').querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Recent edits').click();
    assert.match(win(root).textContent, /No running or idle session has written a file recently/);
  }, { overrides: { '/api/surface/edits': { ts: Date.now(), windowMs: 3600000, edits: [] } } });
});
