// Unattended reliability T5: the card drawer shows the card's lineage and how
// it last ran, and its launch mode select PATCHes `mode` (null for auto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { waitFor } from './helpers/wait-for.js';

const now = '2026-10-23T10:00:00.000Z';
const CARD = (over = {}) => ({ id: 'mc-7', project: 'glmps', title: 'Follow-up', state: 'queued', source: 'deferred', order: 1, devLog: [], activity: [], gate: null, createdAt: now, updatedAt: now, ...over });

const textOf = (el) => (el.textContent ?? '');
// The mini DOM does not derive a select's value from its options, so read the selected option.
const selectedValue = (sel) => sel.children.find((o) => o.selected)?.value ?? '';
const fieldControl = (label) => {
  const field = document.querySelectorAll('.drawer-field').find((f) => textOf(f.querySelector('.drawer-label')) === label);
  return field?.querySelector('select');
};
const metaVal = (key) => document.querySelectorAll('.drawer-meta-row').find((r) => textOf(r.querySelector('.drawer-meta-key')) === key)?.querySelector('.drawer-meta-val');

async function withDrawer(item, fn) {
  const dom = installMiniDom({ pathname: '/work' });
  const patches = [];
  globalThis.fetch = async (url, opt = {}) => {
    if (opt.method === 'PATCH') patches.push({ url, body: JSON.parse(opt.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { openCardDrawer, closeCardDrawer } = await import('../../web/orchestration/board-drawer.js');
  try {
    openCardDrawer(item);
    await fn({ patches });
    if (patches.length) await waitFor(() => !document.querySelectorAll('.backlog-drawer-scrim').length, { message: 'the drawer to close after the save' });
  } finally { closeCardDrawer(); delete globalThis.fetch; dom.restore(); }
}

test('the drawer shows the parent and the last run mode, and the launch mode select reflects the card', async () => {
  await withDrawer(CARD({ parentId: 'mc-1', mode: 'headless', runSession: { launcher: 'headless' } }), async () => {
    assert.equal(selectedValue(fieldControl('Launch mode')), 'headless');
    assert.equal(textOf(metaVal('Parent')), 'mc-1');
    assert.equal(textOf(metaVal('Last run')), 'headless');
  });
  await withDrawer(CARD({ runSession: { launcher: 'native-terminal' } }), async () => {
    assert.equal(selectedValue(fieldControl('Launch mode')), '', 'no override is Auto');
    assert.equal(textOf(metaVal('Last run')), 'interactive (native-terminal)');
  });
});

test('saving a changed launch mode PATCHes mode, and Auto clears it to null', async () => {
  await withDrawer(CARD(), async ({ patches }) => {
    const sel = fieldControl('Launch mode');
    sel.value = 'interactive';
    document.querySelector('.drawer-btn-primary').dispatchEvent(new Event('click'));
    await waitFor(() => patches.length, { message: 'the PATCH' });
    assert.equal(patches[0].body.mode, 'interactive');
  });
  await withDrawer(CARD({ mode: 'headless' }), async ({ patches }) => {
    fieldControl('Launch mode').value = '';
    document.querySelector('.drawer-btn-primary').dispatchEvent(new Event('click'));
    await waitFor(() => patches.length, { message: 'the PATCH' });
    assert.ok('mode' in patches[0].body);
    assert.equal(patches[0].body.mode, null);
  });
});
