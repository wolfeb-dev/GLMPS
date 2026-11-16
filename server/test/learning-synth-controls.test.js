// The learning loop's status and Run now (Settings until card glmps-2-0-140,
// now the Learning lens's Loops tab): the status line reads the server, and
// Run now posts once, toasts the result and refreshes the status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom } from './fixtures/mini-dom.js';
import { waitFor } from './helpers/wait-for.js';

async function mount(statusSeq, synth) {
  const calls = { synth: 0, status: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).split('?')[0];
    if (u === '/api/learning/status') { const r = statusSeq[Math.min(calls.status, statusSeq.length - 1)]; calls.status += 1; return Response.json(r); }
    if (u === '/api/learning/synth' && opts.method === 'POST') { calls.synth += 1; return Response.json(synth); }
    return Response.json({});
  };
  const { mountSynthControls } = await import(`../../web/learning/synth-controls.js?t=${Date.now()}-${Math.random()}`);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const handle = mountSynthControls(host);
  await handle.ready;
  return { host, calls, ...handle };
}

test('the status line says never run, then Run now posts once, toasts the count and refreshes', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  try {
    const m = await mount([{ lastRunMs: null, pending: 2 }, { lastRunMs: Date.now(), pending: 0 }], { ok: true, upserted: 3, scanned: 9 });
    assert.ok(m.host.textContent.includes('Learning loop'));
    assert.equal(m.statusLine.textContent, 'Never run \u00B7 2 pending');
    m.runBtn.click();
    await waitFor(() => toasts.length >= 2 && !m.runBtn.disabled, { message: 'the run outcome and status refresh' });
    assert.equal(m.calls.synth, 1);
    assert.ok(toasts.includes('3 gaps from 9 sessions'), JSON.stringify(toasts));
    assert.equal(m.statusLine.textContent, 'Last synthesized just now \u00B7 0 pending');
    assert.equal(m.runBtn.disabled, false);
  } finally {
    window.removeEventListener('mc-toast', onToast);
    delete globalThis.fetch;
    dom.restore();
  }
});

test('a failed run toasts the server message and re-enables Run now', async () => {
  const dom = installMiniDom({ pathname: '/learning' });
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  try {
    const m = await mount([{ lastRunMs: null, pending: 0 }], { ok: false, message: 'no transcripts in range' });
    m.runBtn.click();
    await waitFor(() => toasts.length >= 2 && !m.runBtn.disabled, { message: 'the run outcome and status refresh' });
    assert.ok(toasts.includes('no transcripts in range'), JSON.stringify(toasts));
    assert.equal(m.runBtn.disabled, false);
    assert.equal(m.runBtn.textContent, 'Run now');
  } finally {
    window.removeEventListener('mc-toast', onToast);
    delete globalThis.fetch;
    dom.restore();
  }
});
