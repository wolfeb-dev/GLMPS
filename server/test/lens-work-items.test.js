// server/test/lens-work-items.test.js
// Work lens: the board with gates beside it,
// every card/CI run clickable and linkable (D2, D17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { parseLink, LENSES } from '../../web/shared/deep-link.js';
import { waitFor } from './helpers/wait-for.js';

const now = Date.now();
const ROUTES = {
  '/api/backlog': {
    items: [
      { id: 'mc-7', project: 'glmps', title: 'Wire the globe', state: 'queued', source: 'manual', order: 1, devLog: [], activity: [], gate: null, createdAt: now, updatedAt: now },
      // the Slack track's idle state and its release chip
      // (merged from origin/glmps2/main's C3/D27 carry into this branch's
      // bindItem-based card binding, Task 14's Job 1) - an idle card with a
      // recorded reason gets a .board-release-chip AND the same reason
      // folded into the card's accessible name.
      { id: 'mc-9', project: 'glmps', title: 'Paused ticket', state: 'idle', source: 'manual', order: 2, devLog: [], activity: [], gate: null, createdAt: now, updatedAt: now, release: { kind: 'manual', why: 'waiting on operator input', ts: now } },
    ],
    gatelessDone: [],
  },
  '/api/qa-trends': { points: [{ ts: now, runId: 42, sha: 'abc1234', testCount: 10, pass: 10, fail: 0, conclusion: 'success', openIssues: 0, source: 'ci' }] },
};

async function mountWork(search) {
  globalThis.fetch = async (url) => {
    const u = String(url).split('?')[0];
    return ROUTES[u] ? Response.json(ROUTES[u]) : Response.json({});
  };
  // The Gates band lazy-loads vega via a <script> tag (web/observability/qa-trends.js
  // loadVegaEmbed); the mini DOM (server/test/fixtures/mini-dom.js) never fires a
  // script's onload, so that would hang forever. Pre-seed window.vegaEmbed (not
  // globalThis.vegaEmbed - installMiniDom's window is its own object, distinct
  // from globalThis) so loadVegaEmbed's own guard short-circuits before it ever
  // appends a script tag.
  window.vegaEmbed = async () => {};
  const lens = await import('../../web/work/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const handle = await lens.mount(root, parseLink('/work', search), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });
  return { lens, root, handle };
}

test('every Work item type renders with a click handler and a deep link', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork('');
    handle = m.handle;
    const { lens, root } = m;
    const { collectItems } = await import('../../web/shared/interactive-item.js');
    // Phase 2 (Q3): the CI runs live behind the header's CI chip, drawn on
    // first open, so the sweep opens it first.
    root.querySelector('.work-chip--ci').click();
    await waitFor(() => root.querySelector('[data-item-type="ci-run"]'), { message: 'the CI run rows' });
    const items = collectItems(root);
    const seen = new Set(items.map((el) => el.dataset.itemType));
    for (const type of Object.keys(lens.ITEM_TYPES)) assert.ok(seen.has(type), `no rendered item of type ${type}`);
    for (const el of items) {
      assert.ok(el.listenerCount('click') >= 1, `${el.dataset.itemType} has no click handler`);
      const u = new URL(el.dataset.link, 'http://x');
      assert.ok(LENSES.includes(parseLink(u.pathname, u.search).lens));
    }
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('an idle card renders its release chip and folds the reason into its accessible name (M9)', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork('');
    handle = m.handle;
    const card = m.root.querySelector('[data-item-id="mc-9"]');
    assert.ok(card, 'the idle card rendered');
    const chip = card.querySelector('.board-release-chip');
    assert.ok(chip, 'the idle card has a release chip');
    assert.equal(chip.textContent, 'paused: waiting on operator input');
    assert.match(card.getAttribute('aria-label') ?? '', /waiting on operator input/,
      'the accessible name must carry the release reason too (aria-label overrides all descendant text, including the chip)');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

// the Rapidfire bar's addBacklogItem call used to resolve
// "successfully" on a server 400 (empty title, etc.) because api.js didn't
// check res.ok, so the try/catch here never fired. Real shape (server.js
// POST /api/backlog, empty-title branch): 400 { error: 'empty title' }.
test('a failed Rapidfire add toasts which line failed and why (R2-2)', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).split('?')[0];
    if (u === '/api/backlog' && (opts.method ?? 'GET') === 'POST') {
      return new Response(JSON.stringify({ error: 'empty title' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return ROUTES[u] ? Response.json(ROUTES[u]) : Response.json({});
  };
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  try {
    window.vegaEmbed = async () => {};
    const lens = await import('../../web/work/lens.js');
    const root = document.createElement('div'); document.body.appendChild(root);
    handle = await lens.mount(root, parseLink('/work', ''), { getState: () => null, toast: () => {}, go: () => {}, handlers: {} });

    const input = root.querySelector('.backlog-input');
    assert.ok(input, 'the Rapidfire input rendered');
    input.value = 'a doomed ticket';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(
      toasts.some((t) => t.includes('a doomed ticket') && t.includes('empty title')),
      `expected a named failure toast, got: ${JSON.stringify(toasts)}`,
    );
  } finally {
    window.removeEventListener('mc-toast', onToast);
    handle?.unmount(); delete globalThis.fetch; dom.restore();
  }
});

// a selected card (its drawer open) carried no aria-current, so
// a screen reader could not tell which card's detail was open. Selecting a
// different card must move the mark, not duplicate it.
test('the open card carries aria-current, and selecting another one moves it (B2)', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork('');
    handle = m.handle;
    const cardA = m.root.querySelector('[data-item-id="mc-7"]');
    const cardB = m.root.querySelector('[data-item-id="mc-9"]');
    assert.ok(cardA && cardB, 'both cards rendered');
    assert.equal(cardA.getAttribute('aria-current'), null, 'nothing is selected before any click');

    cardA.click();
    assert.equal(cardA.getAttribute('aria-current'), 'true', 'the opened card is marked current');
    assert.equal(cardB.getAttribute('aria-current'), null);

    cardB.click();
    assert.equal(cardB.getAttribute('aria-current'), 'true', 'the newly opened card is marked current');
    assert.equal(cardA.getAttribute('aria-current'), null, 'the previously selected card is unmarked');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('a card deep link opens its drawer; a missing card says so', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  try {
    const { root } = await mountWork('?band=board&sel=card%3Amc-7');
    assert.ok(document.body.querySelector('.backlog-drawer'), 'drawer open for mc-7');
    const again = await mountWork('?band=board&sel=card%3Amc-404');
    assert.match(again.root.textContent, /Not found: card mc-404/);
  } finally { delete globalThis.fetch; dom.restore(); }
});

// not-found notices piled up on each update; clearing the
// selection left the mark (and the card drawer) behind; the drawer lives on
// document.body, so it survived Back and lens changes.
test('W-M2: one not-found notice at a time, however many missing selections arrive', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork('?sel=card%3Anope-1');
    handle = m.handle;
    await handle.update(parseLink('/work', '?sel=card%3Anope-2'));
    await handle.update(parseLink('/work', '?sel=card%3Anope-3'));
    const notices = m.root.querySelectorAll('.band-empty').filter((p) => /^Not found:/.test(p.textContent));
    assert.equal(notices.length, 1, notices.map((p) => p.textContent).join(' | '));
    assert.match(notices[0].textContent, /nope-3/);
    await handle.update(parseLink('/work', ''));
    assert.equal(m.root.querySelectorAll('.band-empty').filter((p) => /^Not found:/.test(p.textContent)).length, 0, 'a cleared selection clears its notice');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});

test('W-M2: clearing the selection unmarks the card and closes its drawer; unmount closes it too; reopening never stacks two', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  let handle;
  try {
    const m = await mountWork('?sel=card%3Amc-7');
    handle = m.handle;
    await new Promise((r) => setTimeout(r, 20));
    const scrims = () => document.querySelectorAll('.backlog-drawer-scrim');
    const card = () => m.root.querySelector('[data-item-id="mc-7"]');
    assert.equal(scrims().length, 1, 'the deep-linked card opened its drawer');
    assert.equal(card().getAttribute('aria-current'), 'true');
    const keys = document.listenerCount('keydown');
    await handle.update(parseLink('/work', '?sel=card%3Amc-7'));
    assert.equal(scrims().length, 1, 'Forward to the same card does not stack a second drawer');
    assert.equal(document.listenerCount('keydown'), keys, 'the replaced drawer Escape listener is removed with it');
    await handle.update(parseLink('/work', ''));
    assert.equal(card().getAttribute('aria-current'), null, 'Back to no selection clears the mark');
    assert.equal(scrims().length, 0, 'and closes the drawer');
    await handle.update(parseLink('/work', '?sel=card%3Amc-7'));
    assert.equal(scrims().length, 1);
    handle.unmount(); handle = null;
    assert.equal(scrims().length, 0, 'leaving the Work lens closes the drawer');
    assert.equal(document.listenerCount('keydown'), keys - 1, 'and drops its Escape listener');
  } finally { handle?.unmount(); delete globalThis.fetch; dom.restore(); }
});
