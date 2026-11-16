// server/test/wiki-loop-proof.test.js
// Program plan section 0 "Proof it closes" for the wiki loop: (a) a failing
// maker raises the alert and backs off, (b) a checker that rejects a stub
// build publishes nothing, (c) a good build clears the alert, moves
// current.json and closes the freshness obligation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopRegistry } from '../lib/loops/registry.js';
import { loopAlerts } from '../lib/loops/loop-health.js';
import { openObligationStore, OBLIGATION_KINDS } from '../lib/kernel/obligations.js';
import { registerWikiLoop, WIKI_OBLIGATION_KIND } from '../lib/observability/wiki-loop.js';
import { readCurrentWiki } from '../lib/observability/wiki-publish.js';
import { writeFixtureBuild } from './fixtures/wiki-build-fixture.js';

const HEAD = '9'.repeat(40);
import { loopObligations } from '../lib/kernel/obligation-sweeper.js';
const H6 = 6 * 3600000;

function harness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-wlp-'));
  let t = 1_000_000;
  const now = () => t;
  const streaks = [];
  const obligations = openObligationStore({ dbFile: path.join(stateDir, 'kernel.db'), now });
  const registry = createLoopRegistry({ stateDir, now, setTimer: () => ({}), clearTimer: () => {},
    onStreak: (e) => streaks.push(e), obligations: loopObligations(obligations) }); // production wiring
  const state = { mode: 'good', builds: 0 };
  const handle = registerWikiLoop(registry, {
    repoRoot: stateDir, stateDir, webDir: null, cfg: {}, obligations, now,
    readHead: async () => HEAD,
    readGraph: async () => ({ exists: true, commit: HEAD, fingerprint: 'g1:fixture' }),
    refreshGraph: async () => {},
    runBuild: async (o) => {
      state.builds += 1;
      if (state.mode === 'throw') throw new Error('model timeout');
      return writeFixtureBuild(o.buildDir, { headSha: o.headSha, stub: state.mode === 'stub' });
    },
    log: () => {},
  });
  const run = async (payload = {}) => { t += 1000; await handle.runNow(payload); return registry.get('wiki'); };
  const wikiAlert = () => loopAlerts(registry.snapshot()).find(a => a.title === 'Loop failing: wiki');
  return { stateDir, registry, obligations, state, run, wikiAlert, streaks, done: () => { registry.stop(); obligations.closeDb(); } };
}

test('the obligation kind is registered in K4', () => {
  assert.ok(Object.hasOwn(OBLIGATION_KINDS, WIKI_OBLIGATION_KIND));
});

test('(a) a failing maker raises the alert, backs off 6h then 12h, and a good run clears it', async () => {
  const h = harness();
  try {
    h.state.mode = 'throw';
    const r1 = await h.run();
    assert.match(r1.lastOutcome, /^failed:/);
    assert.match(r1.lastReason, /model timeout/);
    assert.equal(r1.consecutiveFailures, 1);
    assert.equal(h.wikiAlert().severity, 'warn');
    assert.equal(r1.nextRunTs - r1.lastRunTs, H6);
    const r2 = await h.run();
    assert.equal(r2.consecutiveFailures, 2);
    assert.equal(r2.nextRunTs - r2.lastRunTs, 2 * H6);
    h.state.mode = 'good';
    const r3 = await h.run();
    assert.equal(r3.lastOutcome, 'done');
    assert.equal(r3.consecutiveFailures, 0);
    assert.equal(h.wikiAlert(), undefined);
  } finally { h.done(); }
});

test('(b) the checker rejects a stub build: nothing published, critical at 3, one streak event', async () => {
  const h = harness();
  try {
    h.state.mode = 'stub';
    for (let i = 0; i < 3; i++) await h.run();
    const r = h.registry.get('wiki');
    assert.match(r.lastReason, /sections: structural stub/);
    assert.equal(r.consecutiveFailures, 3);
    assert.equal(readCurrentWiki(h.stateDir), null);
    assert.equal(h.wikiAlert().severity, 'critical');
    assert.equal(h.streaks.filter(e => e.name === 'wiki').length, 1);
    assert.ok(h.obligations.findOpen({ kind: WIKI_OBLIGATION_KIND, subject: HEAD }), 'obligation stays open while failing');
  } finally { h.done(); }
});

test('(c) a good build publishes, clears the alert, and closes wiki.reflects-head with the checker ref', async () => {
  const h = harness();
  try {
    h.state.mode = 'stub';
    await h.run();
    const opened = h.obligations.findOpen({ kind: WIKI_OBLIGATION_KIND, subject: HEAD });
    assert.ok(opened);
    h.state.mode = 'good';
    const r = await h.run();
    assert.equal(r.lastOutcome, 'done');
    assert.equal(h.wikiAlert(), undefined);
    const cur = readCurrentWiki(h.stateDir);
    assert.equal(cur.builtAtCommit, HEAD);
    assert.equal(h.obligations.findOpen({ kind: WIKI_OBLIGATION_KIND, subject: HEAD }), null);
    const row = h.obligations.get(opened.id);
    assert.equal(row.closer, 'verified.done');
    assert.equal(row.closedBy, 'wiki-verify');
    assert.equal(row.verifierRef, cur.verifierRef);
    assert.match(row.verifierRef, /^wiki-verify@/);
  } finally { h.done(); }
});

test('(d) an unchanged HEAD is nothing-to-do: no build, no alert, no new obligation', async () => {
  const h = harness();
  try {
    await h.run();
    const before = h.state.builds;
    const r = await h.run();
    assert.equal(r.lastOutcome, 'nothing-to-do');
    assert.equal(h.state.builds, before);
    assert.equal(h.obligations.listOpen().filter((r) => r.kind === 'wiki.reflects-head').length, 0);
    // a merge commit claimed this proof test
    // shows no DUPLICATE loop.freshness row for the wiki loop, but nothing
    // here ever checked it. The wiki loop registers with sla.obligation:
    // false precisely so the registry's own loopObligations adapter never
    // opens a second, redundant loop.freshness row for 'wiki' -- its
    // freshness promise is wiki.reflects-head alone (Decision 3).
    assert.equal(h.obligations.findOpen({ kind: 'loop.freshness', subject: 'wiki' }), null);
  } finally { h.done(); }
});
