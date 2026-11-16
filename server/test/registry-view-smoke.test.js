// Routes under test: server/lib/routes/cross-agent-memory-routes.js
// Routes under test: server/lib/routes/lessons-routes.js
// server/test/registry-view-smoke.test.js
// glmps-138 Task 6: no-browser smoke check for web/evaluation/registry.js.
// There is no jsdom/Playwright in this zero-runtime-dependency codebase, so
// this hand-rolls just enough of `document`/`fetch` to exercise
// renderRegistry()'s real DOM-construction path end to end: every capability
// kind renders a row, the filter chips and search input exist, pagination
// works, a row action wires and disables its button group, and (the
// XSS-discipline guarantee this file exists to enforce) the stub's innerHTML
// setter THROWS on any non-empty assignment, so a stray `el.innerHTML = data`
// anywhere in registry.js/capability-row.js fails this test immediately
// rather than silently passing. A static source-text scan below backs that
// up with a second, independent check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');


class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text ?? ''); this.parentNode = null; }
}

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag ?? 'div').toUpperCase();
    this.parentNode = null;
    this._children = [];
    this._attrs = new Map();
    this._listeners = new Map();
    this._classes = new Set();
    this._text = '';
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.style = {};
    // D-surface Task 6: web/shared/interactive-item.js's bindItem (now wired
    // onto every registry row) reads/writes dataset and calls hasAttribute
    // via web/shared/a11y.js's interactive() - this stub needs both, it
    // previously only backed setAttribute/getAttribute.
    this.dataset = {};
  }
  hasAttribute(k) { return this._attrs.has(k); }
  get classList() {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self._classes.delete(c)),
      toggle(c, force) {
        const has = self._classes.has(c);
        const shouldHave = force === undefined ? !has : force;
        if (shouldHave) self._classes.add(c); else self._classes.delete(c);
        return shouldHave;
      },
      contains: (c) => self._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v ?? '').split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this._listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  click() { for (const fn of this._listeners.get('click') || []) fn({ target: this }); }
  appendChild(node) { node.parentNode = this; this._children.push(node); return node; }
  append(...nodes) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }
  removeChild(node) {
    const i = this._children.indexOf(node);
    if (i >= 0) this._children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get children() { return this._children.filter((c) => c.nodeType === 1); }
  get lastChild() { return this._children[this._children.length - 1] ?? null; }
  get textContent() {
    if (!this._children.length) return this._text;
    return this._children.map((c) => c.textContent ?? '').join('');
  }
  set textContent(v) { this._children = []; this._text = String(v ?? ''); }
  replaceChildren(...nodes) { this._children = []; this._text = ''; this.append(...nodes); }
  set innerHTML(v) {
    // The XSS-discipline guarantee: any non-empty assignment is a bug (data
    // routed through innerHTML instead of textContent/createElement) and
    // must fail the test loudly, not silently pass.
    if (v !== '') throw new Error('XSS-discipline violation: innerHTML assigned non-empty content: ' + v);
    this._children = [];
    this._text = '';
  }
  get innerHTML() { return this._children.length ? '[stub:has-children]' : ''; }
  querySelectorAll() { return []; }
  // Deep text search helper for assertions below (not a real DOM API).
  findAll(pred, out = []) {
    if (pred(this)) out.push(this);
    for (const c of this._children) if (c instanceof FakeElement) c.findAll(pred, out);
    return out;
  }
}

// registry.js's mc-research-candidate handler used to
// look up `#view-registry` by id at fire time and check `.classList.contains
// ('hidden')`; it now holds a container reference and checks
// `document.contains(container)` instead (there is no more hidden/shown
// toggling under the four-lens shell - a lens's bands exist only while that
// lens is mounted). `getElementById`/`contains`/`appendChild`/`removeChild`
// below are real enough to exercise both mechanisms: a test can attach a
// container (simulating "the Learning lens is mounted"), find it by id, then
// detach it (simulating a lens change) and prove the live-update stops.
function makeDocument() {
  const doc = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
    _children: [],
    appendChild(node) { node.parentNode = doc; doc._children.push(node); return node; },
    removeChild(node) {
      const i = doc._children.indexOf(node);
      if (i >= 0) doc._children.splice(i, 1);
      node.parentNode = null;
      return node;
    },
    getElementById(id) {
      for (const c of doc._children) {
        if (!(c instanceof FakeElement)) continue;
        const hit = c.findAll((n) => n instanceof FakeElement && n.getAttribute('id') === id)[0];
        if (hit) return hit;
      }
      return null;
    },
    contains(node) {
      for (let n = node; n; n = n.parentNode) if (n === doc) return true;
      return false;
    },
  };
  return doc;
}

// glmps-138 fix pass: registry.js now binds a window-level
// 'mc-research-candidate' listener on first render (bindRegistryEvents(),
// moved here from the retired research-candidates.js), so `globalThis.window
// = globalThis` alone is no longer enough - plain Node globalThis has no
// addEventListener. Minimal hand-rolled event bus, same bookkeeping shape as
// FakeElement's own _listeners map above, attached directly to globalThis so
// `window.addEventListener(...)` (window === globalThis per setupGlobals)
// resolves to a real function instead of throwing.
function installWindowEventBus() {
  const listeners = new Map();
  globalThis.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  globalThis.removeEventListener = (type, fn) => {
    const arr = listeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  globalThis.dispatchEvent = (evt) => {
    for (const fn of (listeners.get(evt?.type) || []).slice()) fn(evt);
  };
}

// throwaway server instance during this task's investigation) ------------
const now = Date.now();
const DAY = 86400000;

const learningItems = [
  // Guard proposer cutover: g1 carries a
  // proposedGuard.rule - a "legacy item" fixture (one from before the
  // cutover, or a GEPA/alternative-derived rule) - so its Approve button
  // stays enabled, exercising the existing click-through-to-POST test below.
  // rule text deliberately over 80 chars
  // (the row's own `name` is truncated to a "Proposed guard: <80 chars>"
  // title server-side) so the "full rule text next to Approve" test below
  // can tell a real fix from one that only ever showed the truncated title.
  { id: 'g1', code: 'code-a', status: 'pending', title: 'Guard A', body: 'body a', project: 'proj', sessionId: 's1', updatedTs: now - 1000, createdTs: now - 5000,
    proposedGuard: { file: 'CLAUDE.global.md', section: 'Learned guards', rule: '- Always read the file before editing it, even when the diff looks trivial or the caller claims context is unnecessary.' } },
  { id: 'g2', code: 'code-b', status: 'applied', title: 'Guard B', body: 'body b', project: 'proj', sessionId: 's2', updatedTs: now - 90 * DAY, createdTs: now - 100 * DAY },
  { id: 'g3', code: 'code-c', status: 'discarded', title: 'Guard C (dropped)', body: 'x', project: 'proj', sessionId: 's3', updatedTs: now, createdTs: now },
  // g4: a fresh gap with no auto-populated proposedGuard (the normal case
  // after the cutover - proposing rule text is the GEPA plugin's job).
  { id: 'g4', code: 'code-d', status: 'pending', title: 'Guard D (no rule yet)', body: 'body d', project: 'proj', sessionId: 's4', updatedTs: now, createdTs: now,
    proposedGuard: null },
];

const measurables = [
  { id: 'guard-retire:code-b', kind: 'guard-retire', title: 'Guard retire candidate: code-b', detail: 'stale: unused for 95 days', evidence: { sessionId: null, ref: 'code-b' }, metric: {}, labels: [], createdTs: 0, updatedTs: 0 },
  { id: 'skill-retire:project:some-skill', kind: 'skill-retire', title: 'Skill archive candidate: some-skill', detail: 'stale: unused for 200 days', evidence: { sessionId: null, ref: 'project:some-skill' }, metric: {}, labels: [], createdTs: 0, updatedTs: 0 },
  // Final-review Important 5: an agent retire candidate, so the agent row
  // below renders DEPRECATED and must expose the same three retire actions
  // every other deprecated kind does.
  { id: 'agent-retire:ninjascript-coder', kind: 'agent-retire', title: 'Agent retire candidate: ninjascript-coder', detail: 'unused for 200 days', evidence: { sessionId: null, ref: 'ninjascript-coder' }, metric: {}, labels: [], createdTs: 0, updatedTs: 0 },
];

const skillLifecycleCandidates = [
  { id: 'sc1', skill: 'external-skill-1', status: 'quarantined', source: 'github.com/x/y', provenance: 'scan', ts: now - 1000 },
  { id: 'sc2', skill: 'external-skill-2', status: 'trialing', source: 'github.com/x/z', provenance: 'scan', ts: now - 2000 },
  { id: 'sc3', skill: 'external-skill-3', status: 'rejected', source: null, provenance: null, ts: null },
];

const skills = [
  { id: 'project:some-skill', name: 'some-skill', description: 'desc', plugin: 'project', uses: 5, lastSeen: new Date(now - 200 * DAY).toISOString(), installed: true },
  { id: 'project:other-skill', name: 'other-skill', description: 'desc2', plugin: 'project', uses: 10, lastSeen: new Date(now).toISOString(), installed: true },
  { id: 'project:not-installed', name: 'ghost', description: null, plugin: null, uses: 0, lastSeen: null, installed: false },
];

const memoryProposals = Array.from({ length: 55 }, (_, i) => ({
  id: `mem-${i}`,
  fact: { name: `fact-${i}`, description: `description ${i}` },
  sessionId: `sess-${i}`,
  ts: now - i * 1000,
}));

const researchItems = [
  { id: 'r1', candidate: { name: 'paper-1', description: 'd', sourceRef: 'https://arxiv.org/abs/1', sourceName: 'arXiv' }, status: 'proposed', updatedTs: now, createdTs: now },
  { id: 'r2', candidate: { name: 'paper-2', description: 'd2', sourceRef: 'https://x', sourceName: 'blog' }, status: 'quarantined', updatedTs: now, createdTs: now },
];

const camItems = [
  { id: 'c1', status: 'pending-approval', fact: { name: 'shared-fact-1', description: 'd' }, sourceProject: 'proj', updatedTs: now, createdTs: now },
  { id: 'c2', status: 'rejected', fact: { name: 'shared-fact-2-rejected', description: 'd' }, sourceProject: 'proj', updatedTs: now, createdTs: now },
];

// Task 10 (glmps-138 agent-routing plan): GET /api/agents rows joining the
// registry as kind 'agent'. One dispatched (active) + one never-dispatched
// (proposed), the same mix every other kind's fixture above already covers.
const agentItems = [
  { name: 'ui-designer', source: 'assets', dispatchCount: 3, lastUsed: now - 1000, modelSplit: { sonnet: 3, haiku: 0, opus: 0, none: 0 } },
  { name: 'ninjascript-coder', source: 'assets', dispatchCount: 0, lastUsed: null, modelSplit: {} },
];

// Lesson ledger fixture (ADR-0001): one promoted+active lesson, one dormant,
// one invalidated. Covers all three status tints, both action branches, and
// the invalidated row's deliberate no-actions case.
const lessons = [
  {
    lessonId: 'legacy:l1', kind: 'guard', title: 'ui without frontend design',
    scope: 'global', status: 'active', strength: 1, reflex: true, promoted: true,
    provenance: { scope: 'global', sourceEventIds: ['learning-store:l1'], derivedFromRefs: ['abc'] },
    createdAt: new Date(now - 5 * 86400000).toISOString(), updatedAt: new Date(now - 86400000).toISOString(),
  },
  {
    lessonId: 'legacy:l2', kind: 'guard', title: 'plan skipped on large change',
    scope: 'repo', status: 'dormant', strength: 0.18, reflex: false, promoted: false,
    provenance: { scope: 'repo', sourceEventIds: ['learning-store:l2'], derivedFromRefs: [] },
    createdAt: new Date(now - 90 * 86400000).toISOString(), updatedAt: new Date(now - 30 * 86400000).toISOString(),
  },
  {
    lessonId: 'legacy:l3', kind: 'guard', title: 'duplicate guard line',
    scope: 'global', status: 'invalidated', strength: 0, reflex: false, promoted: false,
    provenance: { scope: 'global', sourceEventIds: ['learning-store:l3'], derivedFromRefs: ['def'] },
    createdAt: new Date(now - 60 * 86400000).toISOString(), updatedAt: new Date(now - 2 * 86400000).toISOString(),
  },
];

const GET_ROUTES = {
  '/api/learning': { items: learningItems, config: {} },
  '/api/lessons': { lessons, active: 1, config: { freeze: true } },
  '/api/measurables': { measurables, scoreboard: {} },
  '/api/skills/lifecycle-candidates': { items: skillLifecycleCandidates },
  '/api/skills': { skills, neverUsed: [], installedAvailable: true },
  '/api/agents': { agents: agentItems },
  '/api/memory/proposals': { proposals: memoryProposals },
  '/api/cross-agent-memory': { items: camItems },
};

let postCount = 0;
let getCount = 0; // every GET, across every path - proves a full renderRegistry() re-fetch happened
// `excludePaths` simulates a tier-gated route 404ing (e.g. free-tier
// GET /api/cross-agent-memory) without having to duplicate the whole route
// table per test. Real server 404s for an unregistered route fall through to
// the static handler (not a JSON body) - cross-agent-memory-routes.test.js's
// own `j()` helper wraps `.json()` in try/catch for exactly this reason, so
// this mock's excluded-path branch throws on `.json()` too, matching
// getCrossAgentMemory()'s real un-r.ok-checked `(await fetch(...)).json()`
// call, which really does reject the returned promise on a non-JSON 404.
function makeFetch(excludePaths = new Set()) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const path_ = url.split('?')[0];
    if (!init || (init.method ?? 'GET') === 'GET') {
      getCount += 1;
      if (excludePaths.has(path_)) {
        return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); } };
      }
      const body = GET_ROUTES[path_];
      if (body) return { ok: true, status: 200, json: async () => body };
      return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    }
    postCount += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, item: { id: 'x', status: 'kept' } }) };
  };
}

async function setupGlobals(excludePaths) {
  const doc = makeDocument();
  globalThis.document = doc;
  globalThis.window = globalThis;
  installWindowEventBus();
  globalThis.fetch = makeFetch(excludePaths);
  globalThis.__glmpsFetchWrapped = false; // allow api.js's wrapper to (re)install per test module load
}

test('renderRegistry renders rows for every kind, filters/search/pager exist, no throw, no innerHTML-with-data', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-1`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  // glmps-138 fix pass: pagination is now scoped to the memory kind ONLY
  // (wave2-review.md Registry Important #1) - every other kind renders in
  // full, unpaginated, so all 5 kinds must already be visible on page 1
  // without ever touching Next (55 memory rows no longer bury
  // research-candidate/cross-agent-memory on page 2).
  const collectKinds = () => {
    const chips = container.findAll((n) => n instanceof FakeElement && [...n._classes].some((c) => c.startsWith('rg-kind-chip--')));
    return chips.map((n) => [...n._classes].find((c) => c.startsWith('rg-kind-chip--')).replace('rg-kind-chip--', ''));
  };
  const kindsPresent = new Set(collectKinds());

  for (const kind of ['guard', 'skill', 'agent', 'memory', 'cross-agent-memory']) {
    assert.ok(kindsPresent.has(kind), `expected at least one ${kind} row on page 1 (unpaginated except memory), found kinds: ${[...kindsPresent]}`);
  }

  // Discarded guard (g3) and rejected skill-adopt/cross-agent-memory candidates must not appear anywhere in the tree.
  const allText = container.textContent;
  assert.ok(!allText.includes('Guard C (dropped)'), 'discarded guard must be dropped, not rendered');
  assert.ok(!allText.includes('external-skill-3'), 'rejected skill-adopt candidate must be dropped');
  assert.ok(!allText.includes('shared-fact-2-rejected'), 'rejected cross-agent-memory candidate must be dropped (registry-state.js gap workaround)');

  // Filter chips: KIND_ORDER.length + 1 ("All kinds"), STATE_ORDER.length + 1 ("All states").
  const filterChips = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-filter-chip'));
  assert.equal(filterChips.length, (6 + 1) + (4 + 1), 'expected the six capability kind chips + All kinds, then 4 state chips + All states');

  // Search input exists.
  const searchInputs = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-search-input'));
  assert.equal(searchInputs.length, 1);

  // Pager exists; total-row count matches, and paging is now scoped to the
  // memory kind only (9 non-memory rows always shown in full + memory's own
  // page 1 of 50).
  const pagerInfo = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-pager-info'))[0];
  assert.ok(pagerInfo, 'pager info missing');
  // guard(2 visible) + skill-adopt(2 visible) + skill-inventory(2 installed) + agent(2) + memory(55) + cam(1 visible) = 64
  // +1 row (g4) from the guard proposer cutover fixture (Task 10, fix round 1).
  assert.match(pagerInfo.textContent, /^65 rows \(60 shown, Memory page 1 of 2\)$/);

  // Deprecated guard row (g2, matched to the guard-retire measurable) carries the 3-button retire-label action set.
  const deprecatedRows = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-row--deprecated'));
  assert.equal(deprecatedRows.length >= 1, true, 'expected at least one deprecated row (guard g2 + measurable match)');
  const retireButtons = deprecatedRows[0].findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON');
  const retireLabels = retireButtons.map((b) => b.textContent).sort();
  assert.deepEqual(retireLabels, ['Approve retire', 'Prune', 'Reject']);
});

// web/learning/lens.js's Registry band body used to
// mount with no id at all, so registry.js's `getElementById('view-registry')`
// (its ONLY mechanism for reaching a live-mounted container) always returned
// null and every SSE research-candidate push silently stopped refreshing the
// table. registry.js now holds a container reference instead and checks
// `document.contains(container)`. These two tests prove the actual observable
// behaviour end to end (dispatch the real event, watch the container really
// re-render), not just that the wiring doesn't throw.
test('mc-research-candidate: the mounted container really re-renders (D-surface fix round 1)', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-9`);

  const container = new FakeElement('div');
  container.setAttribute('id', 'view-registry'); // matches web/learning/lens.js's band-body id
  document.appendChild(container); // simulate: the Learning lens is mounted

  await renderRegistry(container);
  assert.strictEqual(document.getElementById('view-registry'), container, 'sanity: the fake document must find the mounted container by id');
  const headerBefore = container.findAll((n) => n instanceof FakeElement && n._classes.has('exp-header'))[0];
  const getCountBefore = getCount;

  globalThis.dispatchEvent({ type: 'mc-research-candidate' });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(getCount > getCountBefore, 'the SSE event must trigger a fresh fetch batch while the container is mounted');
  const headerAfter = container.findAll((n) => n instanceof FakeElement && n._classes.has('exp-header'))[0];
  assert.notStrictEqual(headerAfter, headerBefore, 'renderRegistry must have rebuilt the container (a real re-render), not left it untouched');
});

test('mc-research-candidate: a no-op once the container is detached (Learning lens navigated away)', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-9b`);

  const container = new FakeElement('div');
  container.setAttribute('id', 'view-registry');
  document.appendChild(container);
  await renderRegistry(container);

  document.removeChild(container); // simulate: app.js's doEnter did root.innerHTML = '' on a lens change
  const getCountBefore = getCount;

  globalThis.dispatchEvent({ type: 'mc-research-candidate' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(getCount, getCountBefore, 'a detached container must not be refreshed by a stale SSE listener');
});

// fix round 1's `document.contains` guard stopped a
// detached Registry subtree from being RE-RENDERED, but did nothing to
// release the module-level `_registryContainer` reference itself - Learning's
// `unmount()` was a no-op, so leaving Learning kept the whole detached
// subtree (every row, every wired button) reachable from `registry.js`'s
// module scope, unreachable to garbage collection, for as long as the page
// stayed open. `unmountRegistry()` (called from web/learning/lens.js's real
// unmount()) and the SSE handler's own stale-reference drop both close this;
// `_registryContainerForTest()` proves the reference itself, not just
// behaviour, since a "no re-render happened" assertion alone cannot tell a
// nulled reference apart from a merely-guarded stale one.
test('unmountRegistry() releases the container reference (D-surface fix round 2)', async () => {
  await setupGlobals();
  const { renderRegistry, unmountRegistry, _registryContainerForTest } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-9c`);

  const container = new FakeElement('div');
  container.setAttribute('id', 'view-registry');
  document.appendChild(container);
  await renderRegistry(container);
  assert.strictEqual(_registryContainerForTest(), container, 'sanity: the module holds the container reference while mounted');

  unmountRegistry();
  assert.strictEqual(_registryContainerForTest(), null, 'unmountRegistry() must null the container reference, not merely guard against using it');

  const getCountBefore = getCount;
  globalThis.dispatchEvent({ type: 'mc-research-candidate' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(getCount, getCountBefore, 'no re-render after unmountRegistry()');
});

test('mc-research-candidate firing against a detached container also releases the stale reference, not just skips the render', async () => {
  await setupGlobals();
  const { renderRegistry, _registryContainerForTest } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-9d`);

  const container = new FakeElement('div');
  container.setAttribute('id', 'view-registry');
  document.appendChild(container);
  await renderRegistry(container);

  document.removeChild(container); // detached, but no unmountRegistry() call - a caller that forgets
  assert.strictEqual(_registryContainerForTest(), container, 'sanity: merely detaching does not itself clear the reference');

  globalThis.dispatchEvent({ type: 'mc-research-candidate' });
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(_registryContainerForTest(), null, 'the SSE handler must drop the stale reference once document.contains fails, not only skip the render');
});

test('web/learning/lens.js calls registry.unmountRegistry() from its own unmount() (the actual call site)', () => {
  const src = fs.readFileSync(path.join(WEB_DIR, 'learning', 'lens.js'), 'utf-8');
  const unmountBlock = src.match(/unmount\(\)\s*\{[^}]*\}/s);
  assert.ok(unmountBlock, 'expected an unmount() method in web/learning/lens.js');
  assert.match(unmountBlock[0], /unmountRegistry\(\)/, 'lens.js\'s unmount() must call registry.unmountRegistry()');
});

// Static-scan companion to the two dynamic tests above: those prove
// registry.js's OWN mechanism is correct once wired to a live, id'd
// container, but the actual historical bug was one level up - web/learning/
// lens.js mounted the Registry band with no id at all, so this real mount
// site (not a hand-wired test container) is the thing that must pin the id.
test('web/learning/lens.js sets id="view-registry" on the Registry band body before rendering (the actual mount site)', () => {
  const src = fs.readFileSync(path.join(WEB_DIR, 'learning', 'lens.js'), 'utf-8');
  const idIdx = src.indexOf("id = 'view-registry'");
  const renderIdx = src.indexOf('renderRegistry(');
  assert.ok(idIdx >= 0, 'expected an element to be given id \'view-registry\' in web/learning/lens.js');
  assert.ok(renderIdx >= 0, 'expected a renderRegistry(...) call in web/learning/lens.js');
  assert.ok(idIdx < renderIdx, 'the id must be set on the band body BEFORE renderRegistry() is called, not after');
});

test('kind filter chips (All kinds -> isolate Memory) actually filter the rendered rows', async () => {
  await setupGlobals();
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-2`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  const allKindsBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'All kinds')[0];
  const memoryBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Memory and lessons')[0];
  assert.ok(allKindsBtn && memoryBtn, 'expected All kinds + Memory filter chips');

  allKindsBtn.click(); // clears every kind
  memoryBtn.click();   // re-adds only memory

  const kindChips = container.findAll((n) => n instanceof FakeElement && [...n._classes].some((c) => c.startsWith('rg-kind-chip--')));
  assert.ok(kindChips.length > 0, 'expected memory rows after isolating the Memory filter');
  for (const chip of kindChips) {
    assert.ok(['rg-kind-chip--memory', 'rg-kind-chip--cross-agent-memory'].some((c) => chip._classes.has(c)), 'every visible row must be Memory and lessons after the filter');
  }

  const pagerInfo = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-pager-info'))[0];
  assert.match(pagerInfo.textContent, /^56 rows \(51 shown, Memory page 1 of 2\)$/);
});

test('pager Next/Prev paginate without a network refetch (postCount unchanged)', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-3`);

  const container = new FakeElement('div');
  await renderRegistry(container);
  const before = postCount;

  const nextBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Next')[0];
  assert.ok(nextBtn && !nextBtn.disabled, 'Next should be enabled on page 1 of 2 (Memory kind has 2 pages)');
  nextBtn.click();

  const pagerInfo = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-pager-info'))[0];
  assert.match(pagerInfo.textContent, /Memory page 2 of 2\)$/);
  assert.equal(postCount, before, 'pagination must not trigger any POST/network call');
});

test('a guard Approve click disables its button group, POSTs, and re-renders on success', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-4`);

  const container = new FakeElement('div');
  await renderRegistry(container);
  const before = postCount;

  const approveBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Approve')[0];
  assert.ok(approveBtn, 'expected an Approve button on the proposed guard row');
  approveBtn.click();
  // wireAction's handler is async; let its microtasks (the POST + rerender) settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(postCount > before, 'expected at least one POST from the Approve action');
});

// Guard proposer cutover: approving a guard item with
// no proposedGuard.rule now 400s server-side (there is no rule to land, and
// the free-form headless composer that used to invent one is deleted) - the
// button is disabled up front instead of letting the operator discover that
// by clicking. A legacy item that already carries a rule (g1, above) is
// unaffected.
test('a guard row with no proposedGuard.rule renders Approve disabled; one that has a rule stays enabled', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-4b`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  const rows = container.findAll((n) => n instanceof FakeElement && [...n._classes].includes('rg-row'));
  const rowForTitle = (title) => rows.find((row) => row.textContent.includes(title));

  const noRuleRow = rowForTitle('Guard D (no rule yet)');
  assert.ok(noRuleRow, 'expected the no-rule guard row to render');
  const noRuleApprove = noRuleRow.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Approve')[0];
  assert.ok(noRuleApprove, 'expected an Approve button even with no rule (disabled, not hidden)');
  assert.equal(noRuleApprove.disabled, true);

  const hasRuleRow = rowForTitle('Guard A');
  const hasRuleApprove = hasRuleRow.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Approve')[0];
  assert.equal(hasRuleApprove.disabled, false, 'a legacy item with a rule still approves');
});

// the row's own `name` is the server's
// 80-char-truncated "Proposed guard: <rule>" title - an operator approving
// straight from this row must see the FULL proposed rule, not just that
// truncated title, before committing to it.
test('a guard row shows the full proposed rule text next to Approve, not just the truncated title', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-4c`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  const rows = container.findAll((n) => n instanceof FakeElement && [...n._classes].includes('rg-row'));
  const guardARow = rows.find((row) => row.textContent.includes('Guard A'));
  assert.ok(guardARow, 'expected the Guard A row to render');

  const fullRule = 'Always read the file before editing it, even when the diff looks trivial or the caller claims context is unnecessary.';
  assert.ok(guardARow.textContent.includes(fullRule), 'the full rule text must appear somewhere in the row');

  const approveBtn = guardARow.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Approve')[0];
  assert.ok(approveBtn, 'expected an Approve button');
  // "next to Approve": the full rule text lives in the SAME actions subtree
  // as the button, not merely somewhere else in the row (e.g. the name/
  // detail cell), and it must be visible without expanding "More".
  let actionsHost = approveBtn;
  while (actionsHost && !(actionsHost instanceof FakeElement && [...actionsHost._classes].includes('rg-actions-host'))) {
    actionsHost = actionsHost.parentNode;
  }
  assert.ok(actionsHost, 'expected to find the actions-host ancestor of the Approve button');
  assert.ok(actionsHost.textContent.includes(fullRule), 'the full rule text must sit alongside Approve, visible without expanding "More"');
});

test('filter state persists across a row-action rerender, it does not snap back to "all" (glmps-138 fix pass)', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-6`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  const allKindsBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'All kinds')[0];
  const memoryBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Memory and lessons')[0];
  allKindsBtn.click(); // clears every kind
  memoryBtn.click();   // re-adds only memory

  const approveBtn = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Approve')[0];
  assert.ok(approveBtn, 'expected an Approve button on a memory row after isolating the Memory filter');
  approveBtn.click();
  // wireAction's handler is async: POST, then a full renderRegistry() rerender.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Previously renderRegistry() built a fresh {kinds:ALL, states:ALL,
  // search:'', page:1} on every call, so this single row action would
  // silently reset the Memory-only filter back to "all" (wave2-review.md
  // Registry Minor #2). It must now still be isolated to Memory post-rerender.
  const kindChipsAfter = container.findAll((n) => n instanceof FakeElement && [...n._classes].some((c) => c.startsWith('rg-kind-chip--')));
  assert.ok(kindChipsAfter.length > 0, 'expected memory rows still visible after the action rerender');
  for (const chip of kindChipsAfter) {
    assert.ok(['rg-kind-chip--memory', 'rg-kind-chip--cross-agent-memory'].some((c) => chip._classes.has(c)), 'every visible row must still be Memory and lessons after the row-action rerender');
  }
  const memoryChipBtnAfter = container.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON' && n.textContent === 'Memory and lessons')[0];
  assert.equal(memoryChipBtnAfter.getAttribute('aria-pressed'), 'true', 'the Memory filter chip must still read active after the rerender');
});

test('free tier (GET /api/cross-agent-memory 404s): the Shared memory (Pro) toolbar + Push button are never rendered', async () => {
  await setupGlobals(new Set(['/api/cross-agent-memory']));
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-7`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  // glmps-138 fix pass (wave2-review.md Registry Minor #1): previously the
  // "Shared memory (Pro)" header + a live "Push approved facts to agents"
  // button rendered unconditionally, even when the underlying fetch failed
  // (as it always does on free tier, a 404 tier gate) - the button looked
  // functional but would only ever 404 on click. Mirrors memory.js's
  // renderSharedMemorySection, which likewise renders nothing on a failed fetch.
  const allText = container.textContent;
  assert.ok(!allText.includes('Shared memory (Pro)'), 'the Shared memory (Pro) panel must not render when the fetch failed');
  assert.ok(!allText.includes('Push approved facts to agents'), 'the Push button must not render when the fetch failed');
  // cross-agent-memory rows are also absent (camItems never resolved), unlike
  // the guard/skill/memory/research rows which are unaffected by this one
  // endpoint's failure.
  const camChips = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-kind-chip--cross-agent-memory'));
  assert.equal(camChips.length, 0);
});

// Independent of the DOM-stub run above: greps the actual source text for
// any `innerHTML =` assignment that is not the literal empty-string clear.
test('static scan: the Registry view modules never assign non-empty data to innerHTML', () => {
  for (const file of ['registry.js', 'capability-row.js', 'lesson-ledger-panel.js']) {
    const src = fs.readFileSync(path.join(WEB_DIR, 'evaluation', file), 'utf-8');
    const matches = src.match(/\.innerHTML\s*=\s*[^;]+/g) || [];
    for (const m of matches) {
      assert.match(m.replace(/\s+/g, ' ').trim(), /^\.innerHTML\s*=\s*''\s*;?$/,
        `${file} has a non-empty-string innerHTML assignment: ${m}`);
    }
  }
});

// buildAgentRows passed `buildActions: () => null`, so a DEPRECATED agent row
// (one carrying an agent-retire candidate) was the only deprecated row in the
// whole table an operator could not act on: no Approve retire, no Reject, no
// Prune, while guard and skill rows all had them. The measurable-label endpoint
// behind those buttons is kind-agnostic, so there was never a reason for the
// gap. This drives the real renderRegistry() DOM path, the same way the guard
// assertion in the first test does.
test('a deprecated AGENT row exposes the same three retire actions as a guard/skill row', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-8`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  const agentRowNodes = container.findAll((n) => n instanceof FakeElement
    && n._classes.has('rg-row--deprecated')
    && n.findAll((c) => c instanceof FakeElement && c._classes.has('rg-kind-chip--agent')).length > 0);
  assert.equal(agentRowNodes.length, 1, 'expected exactly one deprecated agent row (ninjascript-coder + agent-retire measurable)');

  const labels = agentRowNodes[0]
    .findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON')
    .map((b) => b.textContent)
    .sort();
  assert.deepEqual(labels, ['Approve retire', 'Prune', 'Reject']);
});

test('an ACTIVE agent row (no retire candidate) still renders no actions', async () => {
  await setupGlobals();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-9`);

  const container = new FakeElement('div');
  await renderRegistry(container);

  const activeAgentRows = container.findAll((n) => n instanceof FakeElement
    && n._classes.has('rg-row--active')
    && n.findAll((c) => c instanceof FakeElement && c._classes.has('rg-kind-chip--agent')).length > 0);
  assert.equal(activeAgentRows.length, 1, 'expected the ui-designer row to be active');
  assert.equal(activeAgentRows[0].findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON').length, 0);
});

// capability-row.js emits `rg-kind-chip--<kind>` for every kind in KIND_ORDER,
// but registry.css only tinted the five that predated the agent kind, so agent
// was the one chip in the table with no tint at all. A per-kind assertion, not
// a one-off check for `--agent`, so the next kind added to KIND_ORDER cannot
// repeat it.
test('every registry kind has a matching kind-chip tint rule in registry.css', async () => {
  const css = fs.readFileSync(path.join(WEB_DIR, 'evaluation', 'registry.css'), 'utf-8');
  const { KIND_ORDER } = await import(`../../web/evaluation/capability-row.js?t=${Date.now()}-10`);
  for (const kind of KIND_ORDER) {
    assert.ok(css.includes(`.rg-kind-chip--${kind}`), `registry.css has no tint rule for the "${kind}" kind chip`);
  }
});

// GET /api/lessons appeared nowhere in web/ before this: the ledger was
// invisible to the operator, which is how it stayed frozen unnoticed. These
// tests pin that it renders, that it says which guards are live, that opening
// it lists them with the right action per row, and that it never takes the
// capability list's height without being asked (the first cut of this panel
// starved that list to zero, caught in a headless render check).

// The disclosure flag is module state, and registry.js's static import of the
// panel resolves to the same module URL however hard the test cache-busts
// registry.js itself - so each test resets it explicitly rather than
// inheriting whatever the previous test left behind.
async function resetLedger() {
  const { setLedgerExpanded } = await import('../../web/evaluation/lesson-ledger-panel.js');
  setLedgerExpanded(false);
}

function ledgerRows(container) {
  return container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-ledger-row'));
}
function ledgerToggle(container) {
  return container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-ledger-toggle'))[0];
}

test('the Lesson ledger panel states what is live without taking the list height, and lists nothing until asked', async () => {
  await setupGlobals();
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-20`);
  const container = new FakeElement('div');
  await renderRegistry(container);

  const allText = container.textContent;
  assert.ok(allText.includes('Lesson ledger'), 'the panel must be mounted in the Registry view');
  assert.ok(allText.includes('on the reflex layer'), 'the counts strip answers "is anything live" at rest');
  assert.ok(allText.includes('invalidated'), 'and how much has been invalidated');
  assert.equal(ledgerRows(container).length, 0, 'collapsed by default, so the capability list keeps its height');

  const toggle = ledgerToggle(container);
  assert.ok(toggle, 'the disclosure control must exist');
  assert.equal(toggle.textContent, 'Show all 3');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('opening the ledger lists every lesson with its status and provenance scope, promoted first', async () => {
  await setupGlobals();
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-21`);
  const container = new FakeElement('div');
  await renderRegistry(container);

  ledgerToggle(container).click();
  await new Promise((r) => setTimeout(r, 0));

  const allText = container.textContent;
  assert.ok(allText.includes('ui without frontend design'), 'a lesson title must render');
  assert.ok(allText.includes('legacy:l2'), 'the lesson id is the join key and must be visible');
  assert.ok(allText.includes('dormant'), 'a decayed lesson must read as dormant');

  const rows = ledgerRows(container);
  assert.equal(rows.length, 3, 'one row per ledger lesson');
  // Promoted first: what is live in CLAUDE.global.md right now is what an
  // operator needs to see without scrolling.
  assert.ok(rows[0]._classes.has('rg-ledger-row--reflex'), 'a promoted lesson sorts to the top');
  assert.equal(ledgerToggle(container).textContent, 'Hide lessons');
  assert.equal(ledgerToggle(container).getAttribute('aria-expanded'), 'true');
});

test('the ledger offers Revoke for a promoted lesson, Promote for an un-promoted one, nothing for an invalidated one', async () => {
  await setupGlobals();
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-22`);
  const container = new FakeElement('div');
  await renderRegistry(container);
  ledgerToggle(container).click();
  await new Promise((r) => setTimeout(r, 0));

  const rows = ledgerRows(container);
  const labelsIn = (row) => row.findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON').map((b) => b.textContent);
  const byId = (id) => rows.find((r) => r.textContent.includes(id));

  assert.deepEqual(labelsIn(byId('legacy:l1')), ['Revoke'], 'a promoted lesson is revocable');
  assert.deepEqual(labelsIn(byId('legacy:l2')), ['Promote'], 'a dormant, un-promoted lesson can be promoted');
  assert.deepEqual(labelsIn(byId('legacy:l3')), [], 'an invalidated lesson offers nothing to promote');
  assert.ok(byId('legacy:l3').textContent.includes('no actions'), 'and says so rather than rendering an empty cell');
});

test('the strength meter carries the value for a screen reader, not just as a width', async () => {
  await setupGlobals();
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-23`);
  const container = new FakeElement('div');
  await renderRegistry(container);
  ledgerToggle(container).click();
  await new Promise((r) => setTimeout(r, 0));

  const meters = container.findAll((n) => n instanceof FakeElement && n._classes.has('rg-ledger-strength'));
  assert.equal(meters.length, 3);
  assert.equal(meters[0].getAttribute('role'), 'meter');
  assert.deepEqual(meters.map((m) => m.getAttribute('aria-valuenow')).sort(), ['0', '0.18', '1']);
  // The number is printed too, so the meter is never the only carrier.
  assert.ok(container.textContent.includes('0.18'));
});

test('the ledger stays open across a row-action rerender, it does not collapse under the operator', async () => {
  await setupGlobals();
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-24`);
  const container = new FakeElement('div');
  await renderRegistry(container);
  ledgerToggle(container).click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ledgerRows(container).length, 3);

  const revoke = ledgerRows(container)[0].findAll((n) => n instanceof FakeElement && n.tagName === 'BUTTON')[0];
  revoke.click();
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(ledgerRows(container).length, 3, 'the panel must survive its own action rerender');
});

test('a failed GET /api/lessons says the ledger is unavailable rather than rendering an empty one', async () => {
  await setupGlobals(new Set(['/api/lessons']));
  await resetLedger();
  const { renderRegistry } = await import(`../../web/evaluation/registry.js?t=${Date.now()}-25`);
  const container = new FakeElement('div');
  await renderRegistry(container);

  const text = container.textContent;
  assert.ok(text.includes('Lesson ledger') && text.includes('unavailable, GET /api/lessons failed to respond.'),
    'an invisible store is the defect this panel exists to fix, so a failed fetch must be stated');
  assert.equal(ledgerRows(container).length, 0);
});
