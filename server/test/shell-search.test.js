// Card glmps-2-0-137 phase 1 (AC-1): search is shell-owned. It sits in the
// topbar on every pillar, Ctrl+K focuses it, off Surface it finds cards and
// live sessions and lands on their page, and a lens (Surface) may lend it a
// richer source while it is mounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { waitFor } from './helpers/wait-for.js';

const BACKLOG = { items: [{ id: 'mc-7', title: 'Fix the zebra crossing', state: 'queued' }] };
const STATE = { sessions: [{ id: 'sess-zebra-1', tool: 'claude-code', live: true, lastTs: Date.now(), card: null }] };

async function setup({ state = STATE } = {}) {
  const dom = installMiniDom({ pathname: '/work' });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('/api/backlog')) return Response.json(BACKLOG);
    if (u.startsWith('/api/search')) return Response.json({ results: [] });
    return new Response('{}', { status: 404 });
  };
  const { createShellSearch } = await import('../../web/shared/search.js');
  const host = document.createElement('div'); host.id = 'topbar-search'; document.body.appendChild(host);
  const went = [];
  const s = createShellSearch(host, { getState: () => state, go: (l) => went.push(l) });
  const done = () => { s.destroy(); delete globalThis.fetch; dom.restore(); };
  return { host, s, went, done };
}
const type = (input, v) => { input.value = v; input.dispatchEvent(new MiniEvent('input')); };
const options = (host) => host.querySelectorAll('[role="option"]');

test('Ctrl+K focuses the topbar search from anywhere and keeps the browser from taking the key', async () => {
  const { host, done } = await setup();
  try {
    const input = host.querySelector('input[type="search"]');
    assert.ok(input, 'one search input in the topbar slot');
    const ev = new MiniEvent('keydown', { key: 'k', ctrlKey: true, target: document.body });
    window.dispatchEvent(ev);
    assert.equal(document.activeElement, input);
    assert.equal(ev.defaultPrevented, true);
    const plain = new MiniEvent('keydown', { key: 'k', target: document.body });
    document.activeElement = null;
    window.dispatchEvent(plain);
    assert.equal(document.activeElement, null, 'a bare K is not the shortcut');
  } finally { done(); }
});

// Card glmps-2-0-runtime-139 finding 3: a field elsewhere on the page (board
// quick-add, card drawer, file editor) keeps its own Ctrl+K.
test('Ctrl+K typed in another text field is left to that field', async () => {
  const { host, done } = await setup();
  try {
    const input = host.querySelector('input[type="search"]');
    for (const tag of ['input', 'textarea', 'select']) {
      const field = document.createElement(tag); document.body.appendChild(field);
      document.activeElement = field;
      const ev = new MiniEvent('keydown', { key: 'k', ctrlKey: true, target: field });
      window.dispatchEvent(ev);
      assert.equal(document.activeElement, field, `${tag} keeps focus`);
      assert.equal(ev.defaultPrevented, false, `${tag} keeps the key`);
    }
    const editable = document.createElement('div'); editable.isContentEditable = true; document.body.appendChild(editable);
    const ev = new MiniEvent('keydown', { key: 'k', metaKey: true, target: editable });
    window.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false, 'a contenteditable region keeps the key');
    document.activeElement = input;
    const own = new MiniEvent('keydown', { key: 'k', ctrlKey: true, target: input });
    window.dispatchEvent(own);
    assert.equal(own.defaultPrevented, true, 'the search field itself still takes the shortcut');
  } finally { done(); }
});

test('off Surface it finds a card and lands on it on Work', async () => {
  const { host, went, done } = await setup();
  try {
    const input = host.querySelector('input[type="search"]');
    input.dispatchEvent(new MiniEvent('focus'));
    type(input, 'zebra');
    const card = await waitFor(() => options(host).find((o) => o.querySelector('.sr-kind').textContent === 'Card'), { message: 'the backlog card result' });
    assert.ok(card, 'the queued card is a result');
    card.dispatchEvent(new MiniEvent('click'));
    assert.deepEqual(went, ['/work?sel=card%3Amc-7']);
  } finally { done(); }
});

test('off Surface a live session is a result and opens its session page', async () => {
  const { host, went, done } = await setup();
  try {
    const input = host.querySelector('input[type="search"]');
    type(input, 'zebra-1');
    const agent = options(host).find((o) => o.querySelector('.sr-kind').textContent === 'Agent');
    assert.ok(agent, 'the live session is a result');
    agent.dispatchEvent(new MiniEvent('click'));
    assert.deepEqual(went, ['/session/sess-zebra-1']);
  } finally { done(); }
});

test('a lens can lend its own source, and releasing it restores the shell source', async () => {
  const { host, s, went, done } = await setup();
  try {
    const picked = [];
    const api = { data: {}, agentList: () => [{ id: 'globe-agent', title: 'globe agent', repo: null, lastTs: null }] };
    const release = s.setSource({ api, activate: (e) => picked.push(e.id), placeholder: 'Fly to a card, repo, file, agent or place' });
    const input = host.querySelector('input[type="search"]');
    assert.equal(input.getAttribute('placeholder'), 'Fly to a card, repo, file, agent or place');
    type(input, 'globe');
    options(host)[0].dispatchEvent(new MiniEvent('click'));
    assert.deepEqual(picked, ['globe-agent']);
    release();
    assert.notEqual(input.getAttribute('placeholder'), 'Fly to a card, repo, file, agent or place');
    type(input, 'globe');
    assert.equal(options(host).length, 0, 'the lens source is gone after release');
    assert.deepEqual(went, []);
  } finally { done(); }
});
