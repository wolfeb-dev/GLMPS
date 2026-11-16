// server/test/detail-gap-callout.test.js
// web/observability/detail.js's gap-callout
// run() catch used to only re-enable the action buttons on failure, with no
// sign anything had gone wrong - unlike capability-row.js's wireAction,
// which always shows an inline "Failed, try again." next to a re-enabled
// button group. A minimal hand-rolled DOM (no jsdom in this zero-runtime-
// dependency codebase) is enough to exercise buildGapCallout()'s real
// click -> fetch -> render path end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this._classes = new Set();
    this.disabled = false;
    this._listeners = {};
    this._text = '';
    this.parentNode = null;
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self._classes.delete(c)),
      contains: (c) => self._classes.has(c),
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  addEventListener(evt, fn) { (this._listeners[evt] ||= []).push(fn); }
  setAttribute() { /* role/aria-live: not asserted on, just must not throw */ }
  findAll(pred) {
    const out = [];
    const walk = (n) => { if (pred(n)) out.push(n); (n.children || []).forEach(walk); };
    walk(this);
    return out;
  }
}

async function setup({ fetchImpl }) {
  globalThis.document = { createElement: (tag) => new FakeEl(tag) };
  globalThis.fetch = fetchImpl;
  const mod = await import(`../../web/observability/detail.js?t=${Date.now()}-${Math.random()}`);
  return mod.buildGapCallout;
}

function click(el, tag, text) {
  const btn = el.findAll((n) => n instanceof FakeEl && n.tag === tag && n.textContent === text)[0];
  assert.ok(btn, `expected a <${tag}> reading "${text}"`);
  (btn._listeners.click || []).forEach((fn) => fn());
  return btn;
}

const gap = (overrides = {}) => ({
  id: 'g1', message: 'Missed a step', severity: 'warn', status: 'pending',
  proposedGuard: { rule: '- Read first.' }, ...overrides,
});

test('a failed gap action shows "Failed, try again." inline and re-enables the buttons', async () => {
  const buildGapCallout = await setup({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  });
  const box = buildGapCallout([gap()]);
  const discard = click(box, 'button', 'Discard');
  assert.equal(discard.disabled, true, 'disabled immediately while in flight');
  // learningAction's fetch + the catch are async; let microtasks settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(discard.disabled, false, 're-enabled after the failure');
  const status = box.findAll((n) => n instanceof FakeEl && n.classList.contains('gap-status'))[0];
  assert.ok(status, 'expected a gap-status element');
  assert.equal(status.textContent, 'Failed, try again.');
  assert.equal(status.classList.contains('gap-status--error'), true);
});

test('a missing-status success response (the same "something is wrong" case) also shows the inline error', async () => {
  const buildGapCallout = await setup({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }), // no `status` field
  });
  const box = buildGapCallout([gap()]);
  click(box, 'button', 'Approve');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const status = box.findAll((n) => n instanceof FakeEl && n.classList.contains('gap-status'))[0];
  assert.equal(status.textContent, 'Failed, try again.');
});

test('a successful action clears any previously-shown error text', async () => {
  let call = 0;
  const buildGapCallout = await setup({
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, status: 200, json: async () => ({ status: 'discarded' }) };
    },
  });
  const box = buildGapCallout([gap()]);
  click(box, 'button', 'Discard');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  let status = box.findAll((n) => n instanceof FakeEl && n.classList.contains('gap-status'))[0];
  assert.equal(status.textContent, 'Failed, try again.');

  // Retry: this time it succeeds.
  click(box, 'button', 'Discard');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  status = box.findAll((n) => n instanceof FakeEl && n.classList.contains('gap-status'))[0];
  assert.equal(status.textContent, '', 'a successful retry clears the earlier error text');
});
