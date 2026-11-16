// server/test/surface-policy-failures.test.js
// Task 16 silent-failure fixes in Surface's policy editor
// (web/surface/declared/policy.js):
//  SF-C: Save wrapped the save AND the push-results render in one bare
//        catch, so a render bug after a successful save read "Save failed.
//        Retry" (inviting a duplicate write) with nothing logged.
// an empty catch around the library "Added N directives" toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function policyFetch({ put }) {
  return async (url, opts = {}) => {
    const u = String(url).split('?')[0];
    const method = opts.method ?? 'GET';
    if (u === '/api/governance/policy' && method === 'GET') return Response.json({ policy: [], targets: [], vendors: [], autoPush: true });
    if (u === '/api/governance/policy' && method === 'PUT') return put();
    if (u === '/api/governance/policy/library') return Response.json({ directives: [{ id: 'd1', text: 'Write tests first', tags: [], category: 'c' }], categories: ['c'], tagVocabulary: [], packs: [] });
    return Response.json({});
  };
}

async function mountPolicy(fetchImpl) {
  globalThis.fetch = fetchImpl;
  const { renderPolicy } = await import('../../web/surface/declared/policy.js');
  const box = document.createElement('div'); document.body.appendChild(box);
  await renderPolicy(box);
  const saveBtn = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Save policy');
  return { box, saveBtn };
}

function captureErrors() {
  const orig = console.error; const seen = [];
  console.error = (...a) => seen.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  return { seen, restore: () => { console.error = orig; } };
}

test('SF-C: a push-results render failure after a successful save is not reported as a failed save', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const errs = captureErrors();
  try {
    // pushed: [null] makes renderPushPanel throw reading null.vendor
    const { box, saveBtn } = await mountPolicy(policyFetch({ put: () => Response.json({ pushed: [null] }) }));
    assert.ok(saveBtn, 'the Save button renders');
    saveBtn.click();
    await tick();
    assert.doesNotMatch(saveBtn.textContent, /failed/i, `the save landed: "${saveBtn.textContent}"`);
    assert.match(saveBtn.textContent, /Saved/);
    assert.ok(errs.seen.some((m) => /push results/i.test(m)), `logged: ${JSON.stringify(errs.seen)}`);
    assert.ok(box.querySelectorAll('p').some((p) => /Saved, but the push results could not be shown/.test(p.textContent)), 'the operator is told the save landed and the results did not render');
  } finally { errs.restore(); delete globalThis.fetch; dom.restore(); }
});

test('SF-C: a real save failure is logged and names its reason', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const errs = captureErrors();
  try {
    const { box, saveBtn } = await mountPolicy(policyFetch({ put: () => Response.json({ error: 'x' }, { status: 500 }) }));
    saveBtn.click();
    await tick();
    assert.match(saveBtn.textContent, /Save failed/);
    assert.ok(errs.seen.some((m) => /save/i.test(m) && /HTTP 500/.test(m)), `logged: ${JSON.stringify(errs.seen)}`);
    assert.ok(box.querySelectorAll('p').some((p) => /Save failed: HTTP 500/.test(p.textContent)), 'the reason is shown like Preview and Push');
  } finally { errs.restore(); delete globalThis.fetch; dom.restore(); }
});

test('SF-M2: a throwing toast listener after a library add is logged, not swallowed', async () => {
  const dom = installMiniDom({ pathname: '/surface' });
  const errs = captureErrors();
  const boom = () => { throw new Error('toast listener broke'); };
  try {
    const { box } = await mountPolicy(policyFetch({ put: () => Response.json({}) }));
    window.addEventListener('mc-toast', boom);
    [...box.querySelectorAll('button')].find((b) => b.textContent === 'Load from library').click();
    await tick(20);
    const cb = document.querySelector('.pol-lib-cb');
    assert.ok(cb, 'the library lists a directive');
    cb.checked = true; cb.dispatchEvent(new MiniEvent('change'));
    document.querySelector('.pol-lib-btn-add').click();
    assert.ok(errs.seen.some((m) => /toast listener broke/.test(m)), `logged: ${JSON.stringify(errs.seen)}`);
  } finally { window.removeEventListener('mc-toast', boom); errs.restore(); delete globalThis.fetch; dom.restore(); }
});
