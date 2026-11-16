// server/test/file-actions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';

test('the file actions row opens the diff popup, the editor and the IDE', async () => {
  const dom = installMiniDom();
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([String(url), opts.method ?? 'GET', opts.body ?? null]);
    if (String(url).startsWith('/api/file?')) return new Response(JSON.stringify({ path: 'C:/r/a.js', content: 'a\nb\n', hash: 'h' }), { status: 200 });
    if (url === '/api/open-in-editor') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const pane = document.createElement('div'); pane.id = 'editor-pane'; pane.className = 'hidden'; document.body.appendChild(pane);
    const { buildFileActions } = await import('../../web/shared/file-actions.js');
    const change = { old: { text: 'a', truncated: false }, new: { text: 'b', truncated: false } };
    const row = buildFileActions('C:/r/a.js', { getChange: async () => change });
    document.body.appendChild(row);
    const [diffBtn, editBtn, ideBtn] = row.querySelectorAll('button');
    assert.deepEqual([diffBtn.textContent, editBtn.textContent, ideBtn.textContent], ['Diff', 'Edit', 'Open in IDE']);

    diffBtn.click(); await new Promise((r) => setTimeout(r, 0));
    const popup = document.body.querySelector('.diff-popup');
    assert.ok(popup, 'diff popup mounted');
    assert.ok(popup.querySelector('.diff-old') && popup.querySelector('.diff-new'));

    editBtn.click(); await new Promise((r) => setTimeout(r, 10));
    assert.equal(pane.classList.contains('hidden'), false, 'editor pane open');
    assert.ok(calls.some(([u]) => u === '/api/file?path=C%3A%2Fr%2Fa.js'));

    ideBtn.click(); await new Promise((r) => setTimeout(r, 0));
    const ide = calls.find(([u]) => u === '/api/open-in-editor');
    assert.deepEqual(JSON.parse(ide[2]), { path: 'C:/r/a.js' });
  } finally { delete globalThis.fetch; dom.restore(); }
});

test('a rejecting getChange toasts once, not twice', async () => {
  const dom = installMiniDom();
  const toasts = [];
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  try {
    window.addEventListener('mc-toast', (e) => toasts.push(e.detail));
    const { buildFileActions } = await import('../../web/shared/file-actions.js');
    const row = buildFileActions('C:/r/a.js', { getChange: async () => { throw new Error('boom'); } });
    document.body.appendChild(row);
    const [diffBtn] = row.querySelectorAll('button');
    diffBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(toasts, ['Could not load the diff: boom']);
  } finally { delete globalThis.fetch; dom.restore(); }
});

test('a failed IDE open shows a toast with the server error', async () => {
  const dom = installMiniDom();
  const toasts = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'openInEditor not configured' }), { status: 400 });
  try {
    window.addEventListener('mc-toast', (e) => toasts.push(e.detail));
    const { openFileInIde } = await import('../../web/shared/file-actions.js');
    const r = await openFileInIde('C:/r/a.js');
    assert.equal(r.ok, false);
    assert.deepEqual(toasts, ['openInEditor not configured']);
  } finally { delete globalThis.fetch; dom.restore(); }
});
