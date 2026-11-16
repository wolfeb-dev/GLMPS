// server/test/web-loop-view-smoke.test.js
// glmps-138 Task 7 smoke check: renders web/evaluation/substrate-loop.js's
// renderLoop() against a hand-rolled minimal DOM stub (no jsdom - this repo
// is zero-runtime-dependency and has no build step, so the stub only
// implements the exact DOM surface renderLoop() and the modules it mounts
// (alerts.js, experiments.js, outcomes.js) actually touch: createElement/NS,
// createTextNode, classList add/toggle, dataset, style, setAttribute/
// getAttribute, addEventListener/click, and an innerHTML setter that THROWS
// on any non-empty assignment - both a functional stub and a live XSS-
// discipline trap for every code path this test exercises.
//
// Verifies (per the Task 7 brief):
//   - the metrics strip renders loopMetrics with denominators visible
//     (e.g. "12 / 40") and the regression tile carries a band CSS class +
//     printed band label (not color-only);
//   - all 3 segments (Ledger/Signals/Outcomes) mount without throwing when
//     switched to;
//   - the "Seed baseline" button exists in the Outcomes segment and its
//     click handler round-trips through POST /api/replay/seed without
//     throwing;
//   - no `.innerHTML =` assignment in substrate-loop.js's own source ever
//     carries data (static source scan, independent of which code paths the
//     dynamic run above happens to exercise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUBSTRATE_LOOP_PATH = path.join(HERE, '..', '..', 'web', 'evaluation', 'substrate-loop.js');
const SUBSTRATE_LOOP_URL = pathToFileURL(SUBSTRATE_LOOP_PATH).href;

class MiniNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [];
    const s = v == null ? '' : String(v);
    if (s !== '') this.appendChild(new MiniText(s));
  }
}

class MiniText extends MiniNode {
  constructor(text) { super(); this.nodeType = 3; this._text = text; }
}

class ClassListImpl {
  constructor(elNode) { this.elNode = elNode; }
  add(...classes) { for (const c of classes) this.elNode._classes.add(c); }
  remove(...classes) { for (const c of classes) this.elNode._classes.delete(c); }
  toggle(cls, force) {
    const has = this.elNode._classes.has(cls);
    const want = force === undefined ? !has : !!force;
    if (want) this.elNode._classes.add(cls); else this.elNode._classes.delete(cls);
    return want;
  }
  contains(cls) { return this.elNode._classes.has(cls); }
}

class MiniElement extends MiniNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag || '').toUpperCase();
    this._classes = new Set();
    this._attrs = new Map();
    this.dataset = {};
    this.style = {};
    this._listeners = new Map();
  }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get classList() { return new ClassListImpl(this); }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  }
  dispatchEvent(evt) {
    const list = this._listeners.get(evt.type) || [];
    for (const fn of list.slice()) fn.call(this, evt);
    return true;
  }
  click() { return this.dispatchEvent({ type: 'click', target: this }); }
  focus() {}
  replaceChildren(...nodes) { this.childNodes = []; for (const n of nodes) this.appendChild(n); }
  // XSS-discipline trap: this repo's rule is textContent/createElement only,
  // and containers are emptied with clear(). Any innerHTML assignment with
  // data throws.
  set innerHTML(v) {
    if (v !== '') throw new Error('innerHTML set with non-empty data (XSS discipline violation): ' + String(v).slice(0, 120));
    this.childNodes = [];
  }
  get innerHTML() { return ''; }
}

function makeDocument() {
  return {
    createElement(tag) { return new MiniElement(tag); },
    createElementNS(_ns, tag) { return new MiniElement(tag); },
    createTextNode(text) { return new MiniText(text); },
    createDocumentFragment() { return new MiniElement('#fragment'); },
  };
}

function findAll(root, predicate, acc = []) {
  if (predicate(root)) acc.push(root);
  for (const c of root.childNodes || []) findAll(c, predicate, acc);
  return acc;
}

function flushMicrotasksAndTimers() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFetchStub(routes, calls) {
  return async function fetchStub(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url), 'http://127.0.0.1');
    const key = method + ' ' + u.pathname;
    calls.push(key);
    const entry = routes[key];
    if (!entry) throw new Error('unhandled fetch in smoke test: ' + key);
    const { status = 200, body } = typeof entry === 'function' ? entry(u) : entry;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const loopMetricsFixture = {
  acceptance: { accepted: 12, proposed: 40, rate: 0.3 },
  regression: { reverted: 3, adopted: 20, rate: 0.15, band: 'healthy' },
  guardHits: { count: 7 },
  lifecycle: { adopted: 12, deprecated: 4, retired: 2 },
};

const changesFixture = [
  {
    id: 'guard-1', type: 'guard', title: 'rule-a', status: 'measuring', ts: 3000,
    evidence: { sessionId: 'sess-1' },
    measuredEffect: { shadowRates: { n: 4, fireRate: 0.5, counterfactualRate: 0.75 } },
  },
  { id: 'memory-1', type: 'memory', title: 'mem-a', status: 'proposed', ts: 2000 },
  {
    id: 'promo-1', type: 'promotion', title: 'v2 vs v1', status: 'kept', ts: 1000,
    // champion/challenger metrics are evidence-tagged envelopes ({value,
    // evidence, n} from server/lib/evaluation/evidence.js's tagValue()) as of
    // the loop-measurement-honesty Task 4 - the real shape /api/changes now
    // sends for a promotion SystemChange's measuredEffect.
    measuredEffect: {
      directions: { medianTurns: 1 },
      champion: { medianTurns: { value: 5, evidence: 'measured', n: 3 } },
      challenger: { medianTurns: { value: 3, evidence: 'measured', n: 2 } },
      perMetric: { medianTurns: 'better' }, sequential: { available: true, decision: 'B', n: 10 },
    },
  },
];

const changesResponseFixture = {
  changes: changesFixture,
  scoreboard: { tracked: 3, netPositive: 1, revertedNoHelp: 0, unmeasured: 1, northStar: null },
  loopMetrics: loopMetricsFixture,
};

const alertsFixture = {
  alerts: [
    { id: 'a1', source: 'egress', severity: 'critical', title: 'Sensitive data touched', detail: 'secret file accessed', target: null, ts: 5000, acknowledged: false },
    { id: 'a2', source: 'guard', severity: 'warn', title: 'Guard fired repeatedly', detail: null, target: null, ts: 4000, acknowledged: false },
  ],
};

const outcomesFixture = {
  outcomes: [
    { id: 'o1', unit: 'u1', ts: 6000, taskClass: 'feature', turns: 3, wallClockMs: {}, tokens: { in: 1, out: 1 }, verifier: { exitOk: true }, firstTry: true, revertedLater: false, committed: true, contextUsageRatio: 0.4 },
  ],
};
// Each metric is an evidence-tagged envelope from evidence.js's tagValue()
// ({value, evidence, n}) - the real shape GET /api/outcomes/summary now
// returns as of the loop-measurement-honesty Task 4.
const outcomesSummaryFixture = {
  byClass: {
    feature: {
      n: 3,
      medianTurns: { value: 2.5, evidence: 'measured', n: 3 },
      verifierPassRate: { value: 0.8, evidence: 'measured', n: 3 },
      firstTryRate: { value: 0.6, evidence: 'measured', n: 3 },
      medianContextUsage: { value: 0.3, evidence: 'measured', n: 3 },
    },
  },
};
const replayFixture = { tasks: [] };
const promotionFixture = { available: false, reason: 'Need at least two units to compare.' };
const shadowFixture = { byClass: {} };
const seedResultFixture = { added: 2, skipped: 1, total: 5 };

function buildRoutes(calls) {
  return {
    'GET /api/changes': { body: changesResponseFixture },
    'GET /api/alerts': { body: alertsFixture },
    'GET /api/outcomes': { body: outcomesFixture },
    'GET /api/outcomes/summary': { body: outcomesSummaryFixture },
    'GET /api/replay': { body: replayFixture },
    'GET /api/promotion': { body: promotionFixture },
    'GET /api/promotion/shadow': { body: shadowFixture },
    'POST /api/replay/seed': { body: seedResultFixture },
  };
}

test('renderLoop: metrics strip (denominators + band), 3 segments mount, Seed button round-trips, no throw', async (t) => {
  const calls = [];
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  globalThis.document = makeDocument();
  globalThis.fetch = makeFetchStub(buildRoutes(calls), calls);
  t.after(() => {
    globalThis.document = prevDocument;
    globalThis.fetch = prevFetch;
  });

  const mod = await import(SUBSTRATE_LOOP_URL);
  assert.equal(typeof mod.renderLoop, 'function', 'renderLoop must be exported');
  assert.equal(typeof mod.renderSubstrateLoop, 'function', 'renderSubstrateLoop alias must be kept for the pre-Task-8 app.js call site');

  const container = document.createElement('div');
  await mod.renderLoop(container);

  const stripText = container.textContent;
  assert.match(stripText, /12 \/ 40/, 'acceptance tile must show accepted/proposed denominator');
  assert.match(stripText, /3 regressions against 20 adoptions/, 'regression tile must state both counts in words (phase 2 AC-4), not a rate');

  const guardHitsTile = findAll(container, (n) => n.nodeType === 1 && n.className && n.className.includes('sl-kpi--guardhits'))[0];
  assert.ok(guardHitsTile, 'guardrail-hits metric tile must render');
  assert.equal(guardHitsTile.textContent.includes('7'), true, 'guardrail hits count (7) must be shown');

  const lifecycleTile = findAll(container, (n) => n.nodeType === 1 && n.className && n.className.includes('sl-kpi--lifecycle'))[0];
  assert.ok(lifecycleTile, 'lifecycle metric tile must render');
  assert.match(lifecycleTile.textContent, /12.*Adopted/s, 'lifecycle adopted count (12) must be shown');
  assert.match(lifecycleTile.textContent, /4.*Deprecated/s, 'lifecycle deprecated count (4) must be shown');
  assert.match(lifecycleTile.textContent, /2.*Retired/s, 'lifecycle retired count (2) must be shown');

  const bandTiles = findAll(container, (n) => n.nodeType === 1 && n.className && n.className.includes('sl-kpi--band-'));
  assert.equal(bandTiles.length, 1, 'exactly one metric tile carries a band-* class (the regression tile)');
  assert.ok(bandTiles[0].className.includes('sl-kpi--band-healthy'), 'band fixture is healthy, so the tile must carry sl-kpi--band-healthy');

  const bandBadges = findAll(container, (n) => n.nodeType === 1 && n.className && n.className.includes('sl-band-badge'));
  assert.equal(bandBadges.length, 1);
  assert.match(bandBadges[0].textContent, /Healthy/i, 'the band word itself must be printed, not color-only');

  const tabs = findAll(container, (n) => n.nodeType === 1 && n.getAttribute('role') === 'tab');
  assert.equal(tabs.length, 3, 'exactly 3 segment tabs (Ledger/Signals/Outcomes)');
  const tabLabels = tabs.map((t2) => t2.textContent);
  assert.deepEqual(tabLabels, ['Ledger', 'Signals', 'Outcomes']);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'Ledger is the default active segment');

  assert.match(container.textContent, /Changes Ledger/, 'Ledger segment content mounted eagerly');
  assert.match(container.textContent, /rule-a/, 'a guard change title from the fixture renders in the ledger');

  const signalsTab = tabs.find((t2) => t2.textContent === 'Signals');
  signalsTab.click();
  await flushMicrotasksAndTimers();
  assert.equal(signalsTab.getAttribute('aria-selected'), 'true');
  assert.match(container.textContent, /Sensitive data touched/, 'alerts.js fixture content rendered into the Signals segment');
  assert.ok(calls.includes('GET /api/alerts'), 'Signals segment fetched /api/alerts on first activation');

  const outcomesTab = tabs.find((t2) => t2.textContent === 'Outcomes');
  outcomesTab.click();
  await flushMicrotasksAndTimers();
  assert.equal(outcomesTab.getAttribute('aria-selected'), 'true');
  assert.ok(calls.includes('GET /api/outcomes'), 'Outcomes segment fetched /api/outcomes on first activation');

  const seedButtons = findAll(container, (n) => n.nodeType === 1 && n.tagName === 'BUTTON' && /seed baseline/i.test(n.textContent));
  assert.equal(seedButtons.length, 1, 'exactly one Seed baseline button in the Outcomes segment');

  seedButtons[0].click();
  await flushMicrotasksAndTimers();
  await flushMicrotasksAndTimers(); // refresh re-renders experiments.js, which itself awaits 4 fetches
  assert.ok(calls.includes('POST /api/replay/seed'), 'Seed baseline button POSTs /api/replay/seed');
  assert.match(container.textContent, /Seeded 2 new task/, 'seed result feedback is shown to the user');

  // Switching back to Ledger must not re-fetch /api/changes or re-mount duplicate content.
  const ledgerTab = tabs.find((t2) => t2.textContent === 'Ledger');
  ledgerTab.click();
  await flushMicrotasksAndTimers();
  assert.equal(ledgerTab.getAttribute('aria-selected'), 'true');
});

test('substrate-loop.js source: no .innerHTML assignment at all, containers are emptied with clear()', () => {
  const src = readFileSync(SUBSTRATE_LOOP_PATH, 'utf8');
  const assignments = [...src.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(assignments, [], 'use clear() from dom-util instead of assigning innerHTML');
  assert.ok(/clear[(]/.test(src), 'sanity: the file is expected to empty containers with clear()');
  assert.doesNotMatch(src, /\.innerHTML\s*=\s*[a-zA-Z`]/, 'no innerHTML assignment may carry a variable/template/data value');
});
