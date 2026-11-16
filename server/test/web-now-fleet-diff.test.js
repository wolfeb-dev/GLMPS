// P5/P4 AC-4: the Fleet bubble's file button, its survival across ticks, and
// card titles on Fleet rows. The Recently ended strip is retired (card
// glmps-2-0-137 phase 2): ended sessions are on Work > History only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

const row = (extra = {}) => ({ id: 's1', project: 'proj', tool: 'claude-code', stage: 2, elapsedMs: 1000, phase: { phase: 'coding', label: 'Coding', doing: 'editing gate.json' }, ...extra });
const state = (rows, extra = {}) => ({ sessions: [{ id: 's1', card: { id: 'glmps-2-0-9', title: 'Fix the gate' } }], board: { stages: [], rows }, history: [], ...extra });

test('the bubble file is a labelled button that survives a tick; the row title is the card title', async () => {
  const dom = installMiniDom();
  try {
    const sb = await import('../../web/overview/stage-board.js');
    const host = document.createElement('div'); document.body.appendChild(host);
    const handlers = { onOpenSession() {} };
    sb.renderStageBoard(host, handlers);
    sb.updateStageBoard(state([row()]), handlers);
    const btn = host.querySelectorAll('.sb-filebtn')[0];
    assert.ok(btn, 'file button rendered');
    assert.equal(btn.tagName, 'BUTTON');
    assert.equal(btn.getAttribute('aria-label'), 'Show the diff of gate.json');
    assert.equal(host.querySelectorAll('.sb-proj')[0].textContent, 'Fix the gate');
    assert.ok(host.querySelectorAll('.sb-card-id').some((n) => n.textContent === 'glmps-2-0-9'));
    sb.updateStageBoard(state([row()]), handlers);
    assert.equal(host.querySelectorAll('.sb-filebtn').length, 1, 're-bound after the tick');
    sb.unmountStageBoard();
  } finally { (await import("../../web/overview/stage-board.js")).unmountStageBoard(); dom.restore(); }
});

test('a bubble that is not a file gets no button; ended sessions are not listed on Fleet', async () => {
  const dom = installMiniDom();
  try {
    const sb = await import('../../web/overview/stage-board.js');
    const host = document.createElement('div'); document.body.appendChild(host);
    sb.renderStageBoard(host, {});
    sb.updateStageBoard(state([row({ phase: { phase: 'verify', label: 'Verify', doing: 'running tests' } })], {
      history: [{ id: 'h1', title: 'raw prompt', card: { id: 'glmps-2-0-3', title: 'Card title' } }, { id: 'h2', title: 'plain' }],
    }), {});
    assert.equal(host.querySelectorAll('.sb-filebtn').length, 0);
    assert.equal(host.querySelectorAll('.sb-ended-strip').length, 0, 'no ended strip');
    assert.doesNotMatch(host.textContent, /Card title|plain/, 'history rows do not render on Fleet');
    sb.unmountStageBoard();
  } finally { (await import("../../web/overview/stage-board.js")).unmountStageBoard(); dom.restore(); }
});

test('activating the button opens the shared popup; no matching write shows an empty note; outside click closes', async () => {
  const dom = installMiniDom();
  const realFetch = globalThis.fetch;
  try {
    const sb = await import('../../web/overview/stage-board.js');
    const events = [{ op: 'write', path: 'D:/p/gate.json', change: { old: null, new: { text: 'v2' } } }];
    globalThis.fetch = async (u) => ({ ok: true, json: async () => (String(u).startsWith('/api/state') ? { events } : {}) });
    const host = document.createElement('div'); document.body.appendChild(host);
    sb.renderStageBoard(host, {});
    sb.updateStageBoard(state([row()]), {});
    host.querySelectorAll('.sb-filebtn')[0].click();
    await new Promise((r) => setTimeout(r, 10));
    const popup = document.body.querySelectorAll('.diff-popup')[0];
    assert.ok(popup, 'popup opened');
    assert.equal(popup.querySelectorAll('.diff-new').length, 1);
    sb.updateStageBoard(state([row()]), {});
    assert.ok(document.body.querySelectorAll('.diff-popup')[0], 'a tick on the same row keeps it open');
    document.body.click();
    assert.equal(document.body.querySelectorAll('.diff-popup').length, 0, 'outside click closes');

    events.length = 0;
    host.querySelectorAll('.sb-filebtn')[0].click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(document.body.querySelectorAll('.diff-empty').length, 1, 'empty note, no toast path');
    sb.updateStageBoard(state([row({ phase: { doing: 'editing other.js' } })]), {});
    assert.equal(document.body.querySelectorAll('.diff-popup').length, 0, 'closes when the row no longer shows that file');
  } finally { globalThis.fetch = realFetch; (await import('../../web/overview/stage-board.js')).unmountStageBoard(); dom.restore(); }
});
