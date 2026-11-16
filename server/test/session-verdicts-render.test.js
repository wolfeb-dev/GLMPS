// web/observability/session-verdicts.js: done-gate results, the loop stage
// and the workspace bounds drawn as verdicts (session-detail spec section 8
// item 4). A minimal hand-rolled DOM, as in detail-gap-callout.test.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

class FakeEl {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.attrs = {}; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join(' ') : this._text; }
  appendChild(n) { this.children.push(n); return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  findAll(pred) { const out = []; const walk = (n) => { if (pred(n)) out.push(n); n.children.forEach(walk); }; walk(this); return out; }
  find(cls) { return this.findAll(n => n.className.split(' ').includes(cls))[0]; }
}

let M;
before(async () => {
  globalThis.document = { createElement: (tag) => new FakeEl(tag) };
  M = await import('../../web/observability/session-verdicts.js');
});

const gate = (ts, result, failedCommand = null) => ({ kind: 'done-gate', ts, result, failedCommand, label: `done-gate: ${result}` });

test('done-gate verdict: latest result decides the word, count is passes over runs', () => {
  const v = M.doneGateVerdict([gate(1, 'block', 'npm test'), gate(2, 'pass'), { kind: 'file-edit', ts: 3 }]);
  assert.deepEqual(v, { word: 'PASS', tone: 'ok', passed: 1, run: 2, detail: null });
});

test('done-gate verdict: a block names the failing command and is drawn red', () => {
  const slot = M.buildDoneGateSlot([gate(1, 'pass'), gate(2, 'block', 'npm test')]);
  assert.equal(slot.find('verdict-word').textContent, 'BLOCKED');
  assert.ok(slot.find('verdict-word').className.includes('tone-danger'));
  assert.equal(slot.find('verdict-count').textContent, '1/2 passed');
  assert.equal(slot.find('verdict-detail').textContent, 'npm test failed');
});

test('done-gate verdict: skipped and unapproved do not count as runs', () => {
  const v = M.doneGateVerdict([gate(1, 'unapproved'), gate(2, 'skipped')]);
  assert.equal(v.word, 'SKIPPED');
  assert.equal(v.run, 0);
  assert.equal(M.buildDoneGateSlot([gate(1, 'skipped')]).find('verdict-count'), undefined);
});

test('done-gate slot is never blank: no results says so', () => {
  const slot = M.buildDoneGateSlot([{ kind: 'file-edit', ts: 1 }]);
  assert.equal(slot.find('verdict-label').textContent, 'DONE-GATE');
  assert.equal(slot.find('verdict-word').textContent, 'no done-gate run');
});

test('stage trace marks past, current and future stages and time in stage', () => {
  const loop = { stage: 2, key: 'execute', status: 'active', detail: '3 files edited', agent: null, enteredTs: 0 };
  const t = M.buildStageTrace(loop, 12 * 60000);
  const segs = t.findAll(n => n.className.startsWith('stage-seg'));
  assert.equal(segs.length, 5);
  assert.deepEqual(segs.map(s => s.className.split(' ')[2]), ['is-past', 'is-current', 'is-future', 'is-future', 'is-future']);
  assert.equal(segs[1].attrs['aria-current'], 'step');
  assert.equal(t.find('stage-trace-detail').textContent, 'EXECUTE active | 3 files edited | 12m in stage');
});

test('stage trace with no loop states why', () => {
  assert.match(M.buildStageTrace(null).textContent, /No loop stage/);
});

test('bounds: declared versus observed, divergence drawn with its reason', () => {
  const b = M.buildBounds({
    declared: { goal: 'spec the session page' },
    observed: { activePaths: ['server/x.js'], zone: 'prod' },
    divergence: { level: 'high', reasons: ['edits entered prod zone'] },
  });
  assert.match(b.textContent, /declared spec the session page/);
  assert.match(b.textContent, /observed x\.js zone prod/);
  const word = b.find('verdict-word');
  assert.equal(word.textContent, 'HIGH');
  assert.ok(word.className.includes('tone-danger'));
  assert.equal(b.find('bounds-reason').textContent, 'edits entered prod zone');
});

test('bounds: observed paths show three basenames and a count, full paths in the title', () => {
  const b = M.buildBounds({ observed: { activePaths: ['a/1.js', 'b\\2.js', 'c/3.js', 'd/4.js', 'e/5.js'] } });
  const v = b.find('bounds-paths');
  assert.equal(v.textContent, '1.js, 2.js, 3.js and 2 more');
});

test('bounds: missing pieces are named, never blank', () => {
  assert.match(M.buildBounds(null).textContent, /No workspace snapshot/);
  const b = M.buildBounds({ declared: null, observed: null, divergence: null });
  assert.match(b.textContent, /no goal recorded/);
  assert.match(b.textContent, /nothing observed yet/);
  assert.match(b.textContent, /not assessed/);
});

test('builders never assign innerHTML', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/observability/session-verdicts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /innerHTML/);
});

test('the session page mounts the three verdicts in its header and bands', async () => {
  const fs = await import('node:fs');
  const src = ['detail.js', 'session-bands.js']
    .map((f) => fs.readFileSync(new URL(`../../web/observability/${f}`, import.meta.url), 'utf8')).join('\n');
  for (const fn of ['buildDoneGateSlot', 'buildStageTrace', 'buildBounds']) {
    assert.ok(src.includes(`${fn}(`), `${fn} is not called from the session page`);
  }
});
