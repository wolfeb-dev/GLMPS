// WCAG 2.2 audit (glmps-2-0-runtime-76): the card drawer is a modal dialog. It
// is named, takes focus when it opens and hands focus back to the card that
// opened it, so a keyboard user never tabs into the board hidden behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

const now = '2026-10-23T10:00:00.000Z';
const CARD = { id: 'mc-7', project: 'glmps', title: 'Follow-up', state: 'queued', source: 'deferred', order: 1, devLog: [], activity: [], gate: null, createdAt: now, updatedAt: now };

test('the card drawer is a named modal dialog that takes focus and returns it on close', async () => {
  const dom = installMiniDom({ pathname: '/work' });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const { openCardDrawer, closeCardDrawer } = await import('../../web/orchestration/board-drawer.js');
  try {
    const opener = document.createElement('div');
    opener.tabIndex = 0;
    document.body.appendChild(opener);
    opener.focus();

    const { dismiss } = openCardDrawer(CARD);
    const panel = document.querySelector('.backlog-drawer');
    assert.equal(panel.getAttribute('role'), 'dialog');
    assert.equal(panel.getAttribute('aria-modal'), 'true');
    assert.match(panel.getAttribute('aria-label') ?? '', /mc-7/);
    assert.ok(panel.contains(document.activeElement), 'focus moves into the drawer');

    dismiss();
    assert.equal(document.activeElement, opener, 'focus returns to the card that opened it');
  } finally { closeCardDrawer(); delete globalThis.fetch; dom.restore(); }
});
