// server/test/system-changes.test.js
// buildSystemChanges() maps each loop's store rows into the unified SystemChange
// ledger + scoreboard. Pure unit tests over fixture data - no fs, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemChanges, buildLoopMetrics, buildLiveness } from '../lib/evaluation/system-changes.js';


test('guard: pending learning-store item maps to type=guard status=proposed', () => {
  const { changes } = buildSystemChanges({
    learningItems: [
      { id: 'gap-1', source: 'gap', code: 'ui-without-frontend-design', title: 'ui without frontend design',
        status: 'pending', lastSessionId: 's1', createdTs: 100, updatedTs: 100 },
    ],
  });
  assert.equal(changes.length, 1);
  const c = changes[0];
  assert.equal(c.type, 'guard');
  assert.equal(c.status, 'proposed');
  assert.equal(c.gatePolicy, 'medium');
  assert.equal(c.measuredEffect, null);
  assert.equal(c.evidence.sessionId, 's1');
  assert.equal(c.ts, 100);
});

test('guard: dispatched item still reads as proposed (not yet confirmed applied)', () => {
  const { changes } = buildSystemChanges({
    learningItems: [{ id: 'gap-2', source: 'gap', code: 'x', title: 'x', status: 'dispatched', createdTs: 1, updatedTs: 2 }],
  });
  assert.equal(changes[0].status, 'proposed');
});

test('guard: applied item joins shadow-arm rates by code -> status measuring with measuredEffect', () => {
  const { changes } = buildSystemChanges({
    learningItems: [{ id: 'gap-3', source: 'gap', code: 'ui-without-frontend-design', title: 'ui gap',
      status: 'applied', createdTs: 1, updatedTs: 5 }],
    shadow: { byClass: { 'ui-without-frontend-design': { n: 4, fireRate: 0.25, fireCount: 1, counterfactualRate: null, episodeCount: null } } },
  });
  const c = changes[0];
  assert.equal(c.status, 'measuring');
  assert.deepEqual(c.measuredEffect, { fireCount: 1, episodes: null, evidence: 'exercised' });
});

test('guard: applied item with no matching shadow bucket -> measuredEffect null (not invented)', () => {
  const { changes } = buildSystemChanges({
    learningItems: [{ id: 'gap-4', source: 'gap', code: 'no-shadow-yet', title: 'y', status: 'applied', createdTs: 1, updatedTs: 1 }],
    shadow: { byClass: {} },
  });
  assert.equal(changes[0].measuredEffect, null);
});

test('guard: discarded/failed items map to status reverted', () => {
  const { changes } = buildSystemChanges({
    learningItems: [
      { id: 'a', source: 'gap', code: 'a', title: 'a', status: 'discarded', createdTs: 1, updatedTs: 1 },
      { id: 'b', source: 'gap', code: 'b', title: 'b', status: 'failed', createdTs: 1, updatedTs: 1 },
    ],
  });
  assert.equal(changes.find(c => c.id === 'guard-a').status, 'reverted');
  assert.equal(changes.find(c => c.id === 'guard-b').status, 'reverted');
});


test('memory: a staged proposal maps to type=memory status=proposed measuredEffect=null', () => {
  const { changes } = buildSystemChanges({
    memoryProposals: [
      { id: 'nt-timezone', fact: { name: 'NT bars close-stamped', description: 'desc', type: 'project' },
        sessionId: 'sess-9', ts: 500 },
    ],
  });
  assert.equal(changes.length, 1);
  const c = changes[0];
  assert.equal(c.type, 'memory');
  assert.equal(c.status, 'proposed');
  assert.equal(c.gatePolicy, 'liberal');
  assert.equal(c.measuredEffect, null);
  assert.equal(c.title, 'NT bars close-stamped');
  assert.equal(c.evidence.sessionId, 'sess-9');
  assert.equal(c.ts, 500);
});


const promoRows = [
  { unit: 'v1', ts: 1000, turns: 6, verifier: { exitOk: true }, firstTry: true, contextUsageRatio: 0.5 },
  { unit: 'v1', ts: 1001, turns: 7, verifier: { exitOk: true }, firstTry: true, contextUsageRatio: 0.5 },
  { unit: 'v1', ts: 1002, turns: 6, verifier: { exitOk: false }, firstTry: false, contextUsageRatio: 0.6 },
  { unit: 'v2', ts: 2000, turns: 3, verifier: { exitOk: true }, firstTry: true, contextUsageRatio: 0.3 },
  { unit: 'v2', ts: 2001, turns: 3, verifier: { exitOk: true }, firstTry: true, contextUsageRatio: 0.3 },
];

test('promotion: challenger unit that dominates the champion maps to status kept', () => {
  const { changes } = buildSystemChanges({ outcomeRows: promoRows });
  const promo = changes.filter(c => c.type === 'promotion');
  assert.equal(promo.length, 1); // one non-champion unit (v2) vs champion (v1, n=3)
  const c = promo[0];
  assert.equal(c.status, 'kept');
  assert.equal(c.gatePolicy, 'conservative');
  assert.ok(c.measuredEffect.champion);
  assert.ok(c.measuredEffect.challenger);
  assert.equal(c.measuredEffect.perMetric.medianTurns, 'better');
  assert.equal(c.title.includes('v2'), true);
  assert.equal(c.ts, 2001); // latest ts among the challenger's own rows
});

test('promotion: challenger worse than champion maps to status reverted', () => {
  // verifier/firstTry are populated (identical both sides, so they read
  // 'same', not 'worse'/'better') purely so this fixture clears Task 5's
  // two-measured-metrics gate on both sides; turns alone still carries the
  // 'worse' signal that drives the reject/reverted verdict.
  const rows = [
    { unit: 'champ', ts: 10, turns: 3, verifier: { exitOk: true }, firstTry: true },
    { unit: 'champ', ts: 11, turns: 3, verifier: { exitOk: true }, firstTry: true },
    { unit: 'champ', ts: 12, turns: 3, verifier: { exitOk: true }, firstTry: true },
    { unit: 'worse', ts: 20, turns: 9, verifier: { exitOk: true }, firstTry: true },
    { unit: 'worse', ts: 21, turns: 9, verifier: { exitOk: true }, firstTry: true },
  ];
  const { changes } = buildSystemChanges({ outcomeRows: rows });
  const c = changes.find(c => c.type === 'promotion');
  assert.equal(c.status, 'reverted');
});

test('promotion: fewer than two units -> no promotion changes, never throws', () => {
  const { changes } = buildSystemChanges({ outcomeRows: [{ unit: 'only', ts: 1, turns: 3 }] });
  assert.equal(changes.filter(c => c.type === 'promotion').length, 0);
});

test('promotion: insufficient-evidence verdict falls back to measuring status (no crash, no invented kept/reverted)', () => {
  // Construct rows that promotionView() will call insufficient-evidence for.
  const constRows = (unit, n) => new Array(n).fill(0).map(() => ({ unit, turns: 0, verifier: { exitOk: null }, firstTry: true, contextUsageRatio: unit === 'a' ? 0.16 : 0.09 }));
  const { changes } = buildSystemChanges({ outcomeRows: [...constRows('a', 11), ...constRows('b', 8)] });
  const promo = changes.find(c => c.type === 'promotion');
  assert.equal(promo.status, 'measuring');
});


test('scoreboard tallies tracked/netPositive/revertedNoHelp/unmeasured across all types', () => {
  const { scoreboard } = buildSystemChanges({
    learningItems: [
      { id: 'g1', code: 'g1', title: 'g1', status: 'pending', createdTs: 1, updatedTs: 1 },   // proposed
      { id: 'g2', code: 'g2', title: 'g2', status: 'discarded', createdTs: 1, updatedTs: 1 }, // reverted
    ],
    memoryProposals: [{ id: 'm1', fact: { name: 'm1' }, ts: 1 }], // proposed
    outcomeRows: promoRows, // one promotion change, status kept
  });
  assert.equal(scoreboard.tracked, 4);
  assert.equal(scoreboard.netPositive, 1);   // the kept promotion
  assert.equal(scoreboard.revertedNoHelp, 1); // the discarded guard
  assert.equal(scoreboard.unmeasured, 2);    // the two proposed items
  assert.equal(scoreboard.northStar, null);  // no historical rollup source wired yet - omitted, not invented
});

test('empty input -> empty changes and a zeroed, non-throwing scoreboard', () => {
  const result = buildSystemChanges({});
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.scoreboard, { tracked: 0, netPositive: 0, revertedNoHelp: 0, unmeasured: 0, northStar: null });
});

test('buildSystemChanges() with no args at all does not throw', () => {
  assert.doesNotThrow(() => buildSystemChanges());
});


test('fail-open: a broken learningItems source (null) contributes nothing but other sources still work', () => {
  const { changes } = buildSystemChanges({
    learningItems: null,
    memoryProposals: [{ id: 'm1', fact: { name: 'ok' }, ts: 1 }],
  });
  assert.equal(changes.filter(c => c.type === 'guard').length, 0);
  assert.equal(changes.filter(c => c.type === 'memory').length, 1);
});

test('fail-open: a malformed single learning item does not knock out sibling items', () => {
  const { changes } = buildSystemChanges({
    learningItems: [
      null, // malformed row
      { id: 'ok', code: 'ok', title: 'ok', status: 'pending', createdTs: 1, updatedTs: 1 },
    ],
  });
  assert.equal(changes.filter(c => c.type === 'guard').length, 1);
  assert.equal(changes[0].id, 'guard-ok');
});

test('fail-open: malformed outcomeRows (not an array) contributes no promotion changes, never throws', () => {
  assert.doesNotThrow(() => {
    const { changes } = buildSystemChanges({ outcomeRows: 'not-an-array' });
    assert.equal(changes.filter(c => c.type === 'promotion').length, 0);
  });
});

test('fail-open: malformed shadow object does not break guard mapping', () => {
  assert.doesNotThrow(() => {
    const { changes } = buildSystemChanges({
      learningItems: [{ id: 'g1', code: 'g1', title: 'g1', status: 'applied', createdTs: 1, updatedTs: 1 }],
      shadow: null,
    });
    assert.equal(changes[0].measuredEffect, null);
  });
});

// The shared 'skill' SystemChange branch (docs/superpowers/plans/2026-07-09-
// skill-capability-lifecycle.md Part A). All three new params default to []
// so every test above (which never passes them) is completely unaffected - 
// this section is the only place that exercises them.

const ADOPT_STATUS_MAP = {
  discovered: 'proposed', quarantined: 'proposed', 'pending-approval': 'proposed',
  approved: 'measuring', trialing: 'measuring', kept: 'kept', rejected: 'reverted',
};

for (const [storeStatus, expected] of Object.entries(ADOPT_STATUS_MAP)) {
  test(`skill adopt: store status '${storeStatus}' maps to SystemChange status '${expected}'`, () => {
    const { changes } = buildSystemChanges({
      skillAdoptItems: [{
        id: 'cand-1', gapCode: 'some-gap', status: storeStatus,
        candidate: { name: 'some-skill', registryName: 'reg-a' },
        createdTs: 10, updatedTs: 20,
      }],
    });
    const c = changes.find(c => c.type === 'skill' && c.action === 'adopt');
    assert.ok(c, `expected an adopt row for status ${storeStatus}`);
    assert.equal(c.status, expected);
    assert.equal(c.id, 'skill-adopt-cand-1');
    assert.equal(c.gatePolicy, 'conservative');
    assert.equal(c.title, 'adopt: some-skill');
    assert.deepEqual(c.skillRef, { id: 'cand-1', name: 'some-skill', plugin: 'reg-a', source: 'registry' });
    assert.equal(c.ts, 20);
  });
}

test('skill adopt: joins shadow-arm rates by gapCode into measuredEffect.shadowRates', () => {
  const { changes } = buildSystemChanges({
    skillAdoptItems: [{ id: 'cand-2', gapCode: 'recurring-gap', status: 'trialing', candidate: { name: 'x' }, createdTs: 1, updatedTs: 1 }],
    shadow: { byClass: { 'recurring-gap': { n: 10, fireRate: 0, counterfactualRate: 0 } } },
  });
  const c = changes.find(c => c.id === 'skill-adopt-cand-2');
  assert.deepEqual(c.measuredEffect, { shadowRates: { n: 10, fireRate: 0, counterfactualRate: 0 } });
});

test('skill adopt: no matching shadow bucket -> measuredEffect null (not invented)', () => {
  const { changes } = buildSystemChanges({
    skillAdoptItems: [{ id: 'cand-3', gapCode: 'no-bucket', status: 'approved', candidate: { name: 'x' }, createdTs: 1, updatedTs: 1 }],
    shadow: { byClass: {} },
  });
  assert.equal(changes.find(c => c.id === 'skill-adopt-cand-3').measuredEffect, null);
});

test('skill archive: candidate always maps to status=proposed, gatePolicy=medium, action=archive', () => {
  const { changes } = buildSystemChanges({
    skillArchiveCandidates: [{ id: 'plugin:old-skill', name: 'old-skill', plugin: 'plugin', reason: 'installed and unused for 200 days', observedDays: 200 }],
  });
  const c = changes.find(c => c.type === 'skill' && c.action === 'archive');
  assert.ok(c);
  assert.equal(c.id, 'skill-archive-plugin:old-skill');
  assert.equal(c.status, 'proposed');
  assert.equal(c.gatePolicy, 'medium');
  assert.equal(c.title, 'archive: old-skill');
  assert.deepEqual(c.measuredEffect, { uses: 0, observedDays: 200, exempt: false });
  assert.deepEqual(c.skillRef, { id: 'plugin:old-skill', name: 'old-skill', plugin: 'plugin', source: 'installed' });
});

test('skill update: candidate always maps to status=proposed, gatePolicy=medium, action=update', () => {
  const { changes } = buildSystemChanges({
    skillUpdateCandidates: [{ id: 'plugin:foo', sourceRepo: 'https://example.com/foo', version: '1.0.0', latestVersion: '1.2.0' }],
  });
  const c = changes.find(c => c.type === 'skill' && c.action === 'update');
  assert.ok(c);
  assert.equal(c.id, 'skill-update-plugin:foo');
  assert.equal(c.status, 'proposed');
  assert.equal(c.gatePolicy, 'medium');
  assert.match(c.title, /1\.0\.0.*1\.2\.0/);
  assert.deepEqual(c.measuredEffect, { currentVersion: '1.0.0', latestVersion: '1.2.0', sourceRepo: 'https://example.com/foo' });
});

test('skill: an unrecognized adopt store status falls back to proposed rather than throwing', () => {
  const { changes } = buildSystemChanges({
    skillAdoptItems: [{ id: 'cand-x', gapCode: 'g', status: 'some-future-status', candidate: { name: 'x' }, createdTs: 1, updatedTs: 1 }],
  });
  assert.equal(changes.find(c => c.id === 'skill-adopt-cand-x').status, 'proposed');
});

test('fail-open: malformed skill sources (non-array / malformed rows) contribute nothing but never throw', () => {
  assert.doesNotThrow(() => {
    const { changes } = buildSystemChanges({
      skillAdoptItems: 'not-an-array',
      skillArchiveCandidates: [null, { id: 'ok-1', name: 'ok', plugin: null }],
      skillUpdateCandidates: [{ /* missing id */ sourceRepo: 'x' }],
    });
    const skillRows = changes.filter(c => c.type === 'skill');
    assert.equal(skillRows.length, 1);
    assert.equal(skillRows[0].id, 'skill-archive-ok-1');
  });
});

test('backward compat: buildSystemChanges() called with the OLD param shape only (no skill* params) never emits type=skill rows', () => {
  const { changes, scoreboard } = buildSystemChanges({
    outcomeRows: promoRows,
    learningItems: [{ id: 'g1', code: 'g1', title: 'g1', status: 'pending', createdTs: 1, updatedTs: 1 }],
    memoryProposals: [{ id: 'm1', fact: { name: 'm1' }, ts: 1 }],
    shadow: { byClass: {} },
  });
  assert.equal(changes.filter(c => c.type === 'skill').length, 0);
  assert.equal(scoreboard.tracked, changes.length);
});


test('measurable: unlabeled durable measurable maps to type=measurable status=proposed', () => {
  const { changes } = buildSystemChanges({
    measurables: [{ id: 'guard-retire:x', kind: 'guard-retire', title: 'Guard retire candidate: x', detail: 'never fired', evidence: { sessionId: null, ref: 'x' }, metric: { n: 20 }, labels: [], createdTs: 100, updatedTs: 100 }],
  });
  assert.equal(changes.length, 1);
  const c = changes[0];
  assert.equal(c.type, 'measurable');
  assert.equal(c.status, 'proposed');
  assert.equal(c.gatePolicy, 'medium');
  assert.deepEqual(c.measuredEffect, { n: 20 });
  assert.equal(c.ts, 100);
});

test('measurable: latest label wins - approve maps to kept, reject/prune map to reverted', () => {
  const base = (labels) => ({ id: 'a', kind: 'workspace-divergence', title: 't', detail: 'd', evidence: {}, metric: null, labels, createdTs: 1, updatedTs: 2 });
  const approved = buildSystemChanges({ measurables: [base([{ decision: 'approve', ts: 2 }])] }).changes[0];
  assert.equal(approved.status, 'kept');
  const rejected = buildSystemChanges({ measurables: [base([{ decision: 'reject', ts: 2 }])] }).changes[0];
  assert.equal(rejected.status, 'reverted');
  const pruned = buildSystemChanges({ measurables: [base([{ decision: 'approve', ts: 1 }, { decision: 'prune', ts: 2 }])] }).changes[0];
  assert.equal(pruned.status, 'reverted'); // latest label (prune) wins over an earlier approve
});

test('measurable: malformed rows are skipped, not fatal to the batch', () => {
  const { changes } = buildSystemChanges({ measurables: [null, { id: '' }, { kind: 'x' }] });
  assert.equal(changes.length, 0);
});


test('buildLiveness: groups by type, lastTs is the max ts, stale past the threshold', () => {
  const now = 1000000000000;
  const staleDays = 14;
  const changes = [
    { type: 'guard', ts: now - 1 * 86400000 },   // 1 day ago -> fresh
    { type: 'guard', ts: now - 30 * 86400000 },  // older sibling, ignored for lastTs
    { type: 'memory', ts: now - 20 * 86400000 }, // 20 days ago -> stale
    { type: 'promotion', ts: null },             // no ts at all -> stale, lastTs null
  ];
  const live = buildLiveness(changes, { now, staleDays });
  assert.equal(live.guard.stale, false);
  assert.equal(live.guard.lastTs, now - 86400000);
  assert.equal(live.memory.stale, true);
  assert.equal(live.promotion.lastTs, null);
  assert.equal(live.promotion.stale, true);
});

test('buildLiveness: empty input -> empty object, never throws', () => {
  assert.deepEqual(buildLiveness([], {}), {});
  assert.deepEqual(buildLiveness(undefined, {}), {});
});
