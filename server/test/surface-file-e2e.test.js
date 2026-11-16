// Routes under test: server/lib/routes/surface-routes.js
// Routes under test: server/lib/routes/workspace-routes.js
// server/test/surface-file-e2e.test.js
// Acceptance (program plan section 4): one end-to-end check opens a file from
// the globe's file-tree layer into the diff popup, the editor and the IDE,
// against the real server routes (tree, file diff, file read, open-in-editor).
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.js';
import { installMiniDom, loadVendorD3, countAllListeners } from './fixtures/mini-dom.js';
import { makeFixture } from './fixtures/git-repo-fixture.js';
import { surfaceFetch } from './fixtures/surface-fixtures.js';
import { parseLink } from '../../web/shared/deep-link.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
// A fixed tick() after a click that fires a real fetch (tree/diff/file read)
// is racy under real load - confirmed flaky in a combined run alongside
// other git-heavy suite files under --test-concurrency=4 (one run took the
// diff-popup step past 200ms; two others did not). waitFor polls the actual
// condition instead of guessing a duration, so it is fast when the fetch is
// fast and still passes when the machine is busy, without weakening what is
// asserted afterward.
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return fn();
    await tick(intervalMs);
  }
}

test('globe file tree -> file -> diff popup -> editor -> IDE', async () => {
  const { base, work } = makeFixture();
  const stateDir = path.join(base, 'state'); fs.mkdirSync(path.join(stateDir, 'residency'), { recursive: true });
  const claudeDir = path.join(base, 'claude'); fs.mkdirSync(claudeDir);
  // impl-rules.md (production home off limits): POST /api/open-in-editor
  // spawns a real child process with no explicit env, so it inherits
  // process.env as-is - redirect HOME/USERPROFILE to a fresh temp dir for
  // the duration so that spawn (antigravityCommand 'node', a harmless
  // no-op) can never see the real machine's home, defence in depth even
  // though this command does not read it.
  const homeDir = path.join(base, 'home'); fs.mkdirSync(homeDir, { recursive: true });
  const savedHome = process.env.HOME, savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir; process.env.USERPROFILE = homeDir;
  const rows = [{ repo: 'work', path: work, remote: 'https://github.com/x/work', defaultBranch: 'main', ahead: 1, behind: 1, unpushedBranches: [], noUpstreamBranches: [], dirty: 2, lastFetchTs: Date.now(), residency: 'diverged', ts: Date.now() }];
  fs.writeFileSync(path.join(stateDir, 'residency', 'current.json'), JSON.stringify({ ts: Date.now(), rows }));
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ editableRoots: [work], antigravityCommand: 'node', openInEditorArgs: ['-e', '0', '{path}'] }));
  // Phase S (trunk): the server refuses a real editor spawn in a test
  // process, so the IDE step injects a recording fake and asserts what it
  // was asked to open (stronger than the old real 'node -e 0' run).
  const ideCalls = [];
  const editorSpawnFn = (file, args, options) => { ideCalls.push({ file, args, options }); const child = new EventEmitter(); child.pid = 4242; child.unref = () => {}; return child; };
  const h = await startServer({ port: 0, env: { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_UNMERGED_SCAN: 'off' }, configFile, editorSpawnFn });
  const dom = installMiniDom({ pathname: '/surface' });
  const serverBase = `http://127.0.0.1:${h.port}`;
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    // K5's route may not exist on this branch: serve the same rows the file holds.
    if (u === '/api/residency') return Response.json({ ts: Date.now(), rows });
    const headers = new Headers(opts?.headers); headers.set('x-glmps-local-session', h.localSession);
    const res = await realFetch(new URL(u, serverBase), { ...opts, headers });
    calls.push([u, opts?.method ?? 'GET', res.status]);
    return res;
  };
  let handle;
  try {
    window.d3 = loadVendorD3();
    const pane = document.createElement('div'); pane.id = 'editor-pane'; pane.className = 'hidden'; document.body.appendChild(pane);
    const lens = await import('../../web/surface/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/surface', '?sel=repo%3Awork&layers=residency,files,players'), { getState: () => ({ tools: [] }), toast: () => {}, go: () => {}, handlers: {} });
    const { collectItems } = await import('../../web/shared/interactive-item.js');

    // 1. The repository's inspector offers its file tree.
    const treeBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree');
    assert.ok(treeBtn, 'the repository inspector has a Show file tree action');
    treeBtn.click();
    const folder = await waitFor(() => collectItems(root).find((e) => e.dataset.itemType === 'folder' && e.dataset.itemId === 'work/dir'));
    assert.ok(folder, 'the dir folder is drawn on the globe');
    // 2. The folder opens its drifted files; the file opens its actions.
    folder.click();
    const file = await waitFor(() => collectItems(root).find((e) => e.dataset.itemType === 'file' && e.dataset.itemId === 'work/dir/b.txt'));
    assert.ok(file, 'dir/b.txt is listed');
    assert.equal(file.dataset.link, '/surface?layers=residency%2Cfiles%2Cplayers&sel=file%3Awork%2Fdir%2Fb.txt');
    file.click();
    // mini-dom's querySelector does not support a descendant combinator
    // (space-separated compound selector) - chained single-part queries
    // find the same element a real browser's '#panel-inspector .file-actions'
    // would.
    const actions = await waitFor(() => root.querySelector('#panel-inspector')?.querySelector('.file-actions'));
    assert.ok(actions, 'the file inspector shows its diff/edit/IDE actions');
    const [diffBtn, editBtn, ideBtn] = actions.querySelectorAll('button');
    // 3. Diff popup: the 1.x popup with both sides.
    diffBtn.click();
    const popup = await waitFor(() => document.body.querySelector('.diff-popup'));
    assert.ok(popup, 'the diff popup opened');
    assert.match(popup.querySelector('.diff-old').textContent, /- bee/);
    assert.match(popup.querySelector('.diff-new').textContent, /\+ bee two/);
    // 4. Editor: the 1.x pop-out editor over GET /api/file. editor.js's
    // openEditor() is synchronous up through unhiding the pane
    // (pane.classList.remove('hidden')) and loads the file content
    // asynchronously afterward (an awaited readFile() inside) - polling
    // visibility alone resolves on its very first,
    // pre-fetch check and races the content. Poll the content itself, the
    // thing this step actually asserts; visibility is a precondition of the
    // content ever appearing, so it is implied once this resolves.
    editBtn.click();
    await waitFor(() => /bee two/.test(pane.textContent));
    assert.equal(pane.classList.contains('hidden'), false);
    assert.match(pane.textContent, /bee two/);
    // 5. IDE: POST /api/open-in-editor answers 200.
    ideBtn.click();
    await waitFor(() => calls.some(([u, m, s]) => u === '/api/open-in-editor' && m === 'POST' && s === 200));
    assert.ok(calls.some(([u, m, s]) => u === '/api/open-in-editor' && m === 'POST' && s === 200));
    assert.ok(ideCalls.some((c) => JSON.stringify(c.args).includes('b.txt')), 'the IDE launch names the opened file: ' + JSON.stringify(ideCalls.map((c) => c.args)));
  } finally {
    // Task 11 fix-in-place (uncommitted, this file stays Task 12's): call
    // unmount even when an assertion throws early, or lens.js's HUD
    // setInterval (a real Node timer, not mocked by mini-dom) outlives the
    // test and hangs the runner - reproduced directly while landing Task 11.
    handle?.unmount();
    globalThis.fetch = realFetch; delete window.d3; dom.restore();
    await h.close?.();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Task 12 safety requirement: the files/agents/cards layers add new async
// work (showTree's fetch) and new marks (an agent's vector line, a card
// stack's chips) beyond what Task 11's lifecycle test covers - 20 mount/
// unmount cycles, each opening an agent and a card-stack (and firing
// showTree against a route that 404s, exercising the api.destroyed guard's
// error path too), must leave no growing listener (fix round 1, M2: counted
// across every node in the tree, not just window - countAllListeners) or
// leftover node.
test('20 mount/unmount cycles of the files/agents/cards layers leave no growing listener (every node, not just window) or node count', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const container = document.createElement('div'); document.body.appendChild(container);
  const realFetch = globalThis.fetch;
  try {
    const fetchImpl = surfaceFetch({
      '/api/sessions/live': { sessions: [{ id: 's1', cwd: 'D:/glmps', lastTs: Date.now() }], now: Date.now(), staleMs: 60000 },
      '/api/workspace': { sessions: [{ sessionId: 's1', title: 'Working on it', declared: { goal: 'ship' }, observed: {}, divergence: 'none' }] },
      '/api/backlog': { items: [{ id: 'c1', state: 'in_progress', title: 'A card', origin: { via: 'local' } }] },
    });
    const lens = await import('../../web/surface/lens.js');
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    let baseline = null;
    for (let i = 0; i < 20; i++) {
      globalThis.fetch = fetchImpl;
      window.d3 = loadVendorD3();
      const root = document.createElement('div'); container.appendChild(root);
      const handle = await lens.mount(root, parseLink('/surface', '?sel=repo%3Aglmps'), { getState: () => ({ tools: [] }), toast: () => {}, go: () => {}, handlers: {} });
      const agent = collectItems(root).find((e) => e.dataset.itemType === 'agent');
      agent?.click();
      const stack = collectItems(root).find((e) => e.dataset.itemType === 'card-stack');
      stack?.click();
      // showTree against /api/surface/tree, which surfaceFetch does not
      // stub (404) - fires the fetch-and-fail path without a real server,
      // then unmounts immediately, before it resolves: exactly the race
      // the api.destroyed guard exists for.
      const treeBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Show file tree');
      treeBtn?.click();
      handle.unmount();
      root.remove();
      delete globalThis.fetch; delete window.d3;
      if (i === 0) baseline = countAllListeners();
      else assert.equal(countAllListeners(), baseline, `cycle ${i}: listener count changed (${baseline} -> ${countAllListeners()})`);
    }
    assert.equal(container.childNodes.length, 0, 'every mounted root was removed on unmount + detach, nothing left behind');
  } finally { globalThis.fetch = realFetch; delete window.d3; dom.restore(); }
});
