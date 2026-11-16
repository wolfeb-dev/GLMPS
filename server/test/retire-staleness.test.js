// server/test/retire-staleness.test.js
// Task 4 (glmps-138): a staleness-based retire rule alongside the existing
// (too-strict for an active repo) counterfactual/observation rule, so
// retirement proposals actually populate. staleDays=30 flags stale;
// retireDays=90 yields a propose-retire candidate. Propose-only: these
// functions are pure and never mutate any store themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  staleness, staleGuardCandidates, staleGuardCandidatesFromTemplates,
  DEFAULT_STALE_DAYS, DEFAULT_RETIRE_DAYS,
} from '../lib/evaluation/guard-retire.js';
import { staleArchiveCandidates } from '../lib/evaluation/skill-retire.js';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { recordShadow } from '../lib/evaluation/shadow-arm.js';

const MS_PER_DAY = 86400000;
const NOW = Date.parse('2026-07-21T00:00:00Z');
const daysAgo = (n) => NOW - n * MS_PER_DAY;

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }


test('staleness: default boundaries - 100 days is both stale and propose-retire, 40 is stale-only, 10 is neither', () => {
  assert.deepEqual(staleness(daysAgo(100), NOW), { stale: true, proposeRetire: true, lastUsedDays: 100 });
  const at40 = staleness(daysAgo(40), NOW);
  assert.equal(at40.stale, true);
  assert.equal(at40.proposeRetire, false);
  assert.equal(at40.lastUsedDays, 40);
  assert.deepEqual(staleness(daysAgo(10), NOW), { stale: false, proposeRetire: false, lastUsedDays: 10 });
});

test('staleness: default constants are 30/90', () => {
  assert.equal(DEFAULT_STALE_DAYS, 30);
  assert.equal(DEFAULT_RETIRE_DAYS, 90);
});

test('staleness: custom staleDays/retireDays override the defaults', () => {
  assert.deepEqual(staleness(daysAgo(15), NOW, { staleDays: 10, retireDays: 20 }), { stale: true, proposeRetire: false, lastUsedDays: 15 });
  assert.deepEqual(staleness(daysAgo(25), NOW, { staleDays: 10, retireDays: 20 }), { stale: true, proposeRetire: true, lastUsedDays: 25 });
});

test('staleness: no lastUsedTs (missing/invalid) -> neither flag, no evidence, fail-open', () => {
  assert.deepEqual(staleness(undefined, NOW), { stale: false, proposeRetire: false, lastUsedDays: null });
  assert.deepEqual(staleness(null, NOW), { stale: false, proposeRetire: false, lastUsedDays: null });
  assert.deepEqual(staleness(NaN, NOW), { stale: false, proposeRetire: false, lastUsedDays: null });
  assert.deepEqual(staleness('not-a-number', NOW), { stale: false, proposeRetire: false, lastUsedDays: null });
});


const guards = [
  { code: 'sleep-poll', rule: '- Never poll with sleep N then cat.' },
  { code: 'reread-loop', rule: '- Do not re-read an unchanged file.' },
];

test('staleGuardCandidates: a guard unused 100 days is a reason:stale propose-retire candidate with lastUsedDays', () => {
  const out = staleGuardCandidates(guards, { 'sleep-poll': daysAgo(100) }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'sleep-poll');
  assert.equal(out[0].reason, 'stale');
  assert.equal(out[0].lastUsedDays, 100);
});

test('staleGuardCandidates: a guard unused 40 days is stale but NOT a propose-retire candidate (not in the output)', () => {
  const out = staleGuardCandidates(guards, { 'sleep-poll': daysAgo(40) }, { now: NOW });
  assert.deepEqual(out, []);
});

test('staleGuardCandidates: a guard unused 10 days is not a candidate at all', () => {
  const out = staleGuardCandidates(guards, { 'sleep-poll': daysAgo(10) }, { now: NOW });
  assert.deepEqual(out, []);
});

test('staleGuardCandidates: a guard with no lastUsed evidence is never a candidate (fail-open, not invented)', () => {
  const out = staleGuardCandidates(guards, {}, { now: NOW });
  assert.deepEqual(out, []);
});

test('staleGuardCandidates: multiple guards are each independently evaluated', () => {
  const out = staleGuardCandidates(guards, { 'sleep-poll': daysAgo(100), 'reread-loop': daysAgo(5) }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'sleep-poll');
});

test('staleGuardCandidates: empty/malformed input never throws', () => {
  assert.deepEqual(staleGuardCandidates([], {}, { now: NOW }), []);
  assert.deepEqual(staleGuardCandidates(undefined, {}, { now: NOW }), []);
  assert.deepEqual(staleGuardCandidates(guards, undefined, { now: NOW }), []);
  assert.deepEqual(staleGuardCandidates([null, { rule: 'no code' }], { 'sleep-poll': daysAgo(100) }, { now: NOW }), []);
});

// Guard proposer cutover: learning-templates.js's TEMPLATES map is
// deleted (server.js now builds this same { code -> { rule } } shape from
// applied learning-store items instead of a static map). This fixture Map
// exercises staleGuardCandidatesFromTemplates' own Map-input handling.
test('staleGuardCandidatesFromTemplates: builds the guards list from a Map', () => {
  const fixtureTemplates = new Map([['sleep-poll', { rule: '- Never poll with sleep N then cat.' }]]);
  const out = staleGuardCandidatesFromTemplates(fixtureTemplates, { 'sleep-poll': daysAgo(100) }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, 'sleep-poll');
  assert.match(out[0].rule, /sleep/i);
});


const skills = [
  { id: 'plugin-a:used-100', name: 'used-100', plugin: 'plugin-a', installed: true, uses: 12, lastSeen: new Date(daysAgo(100)).toISOString() },
  { id: 'plugin-a:used-40', name: 'used-40', plugin: 'plugin-a', installed: true, uses: 5, lastSeen: new Date(daysAgo(40)).toISOString() },
  { id: 'plugin-a:used-10', name: 'used-10', plugin: 'plugin-a', installed: true, uses: 3, lastSeen: new Date(daysAgo(10)).toISOString() },
  { id: 'plugin-a:never-used', name: 'never-used', plugin: 'plugin-a', installed: true, uses: 0, lastSeen: null },
  { id: 'plugin-c:not-installed', name: 'not-installed', plugin: 'plugin-c', installed: false, uses: 20, lastSeen: new Date(daysAgo(200)).toISOString() },
];

test('staleArchiveCandidates: a skill last used 100 days ago is a reason:stale propose-retire candidate', () => {
  const out = staleArchiveCandidates(skills, [], { now: NOW });
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes('plugin-a:used-100'));
  const cand = out.find((c) => c.id === 'plugin-a:used-100');
  assert.equal(cand.reason, 'stale');
  assert.equal(cand.lastUsedDays, 100);
});

test('staleArchiveCandidates: a skill last used 40 days ago is NOT a propose-retire candidate', () => {
  const out = staleArchiveCandidates(skills.filter((s) => s.id === 'plugin-a:used-40'), [], { now: NOW });
  assert.deepEqual(out, []);
});

test('staleArchiveCandidates: a skill last used 10 days ago is not a candidate', () => {
  const out = staleArchiveCandidates(skills.filter((s) => s.id === 'plugin-a:used-10'), [], { now: NOW });
  assert.deepEqual(out, []);
});

test('staleArchiveCandidates: a never-used skill (uses:0) is the OTHER rule\'s territory, not staleness', () => {
  const out = staleArchiveCandidates(skills.filter((s) => s.id === 'plugin-a:never-used'), [], { now: NOW });
  assert.deepEqual(out, []);
});

test('staleArchiveCandidates: a not-installed skill is never a candidate', () => {
  const out = staleArchiveCandidates(skills.filter((s) => s.id === 'plugin-c:not-installed'), [], { now: NOW });
  assert.deepEqual(out, []);
});

test('staleArchiveCandidates: the exempt list is honored', () => {
  const out = staleArchiveCandidates(skills.filter((s) => s.id === 'plugin-a:used-100'), ['plugin-a:used-100'], { now: NOW });
  assert.deepEqual(out, []);
});

test('staleArchiveCandidates: empty/malformed input never throws', () => {
  assert.deepEqual(staleArchiveCandidates([], [], { now: NOW }), []);
  assert.deepEqual(staleArchiveCandidates(undefined, [], { now: NOW }), []);
  assert.deepEqual(staleArchiveCandidates([null, { installed: true, uses: 5 }], [], { now: NOW }), []);
});

// manufacture false "stale" candidates. A fresh 2.0 shadow instance reads
// the real ~/.claude inventory by design (observe-only) but has its own
// sparse, young skill-event history, so a skill whose only recorded use
// happens to be old looks indistinguishable from a genuinely stale one -
// unless the caller can prove the window itself has actually been watched
// long enough (earliestObservedTs) to trust that conclusion. -------------

const threeSkills = skills.filter((s) => ['plugin-a:used-100', 'plugin-a:used-40', 'plugin-a:used-10'].includes(s.id));

test('staleArchiveCandidates: an observation window younger than retireDays yields no candidates, even for a skill that otherwise reads as stale', () => {
  // The whole event log only goes back 5 days - far short of the 90-day
  // retireDays window - so "used-100" cannot be trusted as a real 100-day
  // staleness signal: it could equally be a skill used constantly right up
  // until 5 days ago that we simply have not been watching long enough to see.
  const out = staleArchiveCandidates(threeSkills, [], { now: NOW, earliestObservedTs: daysAgo(5) });
  assert.deepEqual(out, []);
});

test('staleArchiveCandidates: an observation window at least as old as retireDays behaves exactly as before (candidates as today)', () => {
  const withCoverage = staleArchiveCandidates(threeSkills, [], { now: NOW, earliestObservedTs: daysAgo(100) });
  const withoutTheOption = staleArchiveCandidates(threeSkills, [], { now: NOW });
  assert.deepEqual(withCoverage, withoutTheOption);
  assert.equal(withCoverage.length, 1);
  assert.equal(withCoverage[0].id, 'plugin-a:used-100');
});


test('acceptance: guard-retire.js and skill-retire.js still contain no filesystem-mutation calls', async () => {
  const fsMod = await import('node:fs');
  const url = await import('node:url');
  for (const rel of ['../lib/evaluation/guard-retire.js', '../lib/evaluation/skill-retire.js']) {
    const src = fsMod.readFileSync(url.fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
    assert.doesNotMatch(src, /fs\.writeFileSync|fs\.rmSync|fs\.rm\(|fs\.unlink|fs\.rename/, `${rel} must stay propose-only`);
  }
});

// (glmps-138 C1 fix + M3: a dedicated regression test for the wiring bug -
// the unit tests above only ever exercise the pure functions with a
// directly-supplied lastUsedByCode map, which is exactly why C1 (deriving
// "last used" from learning-store's adoption-time updatedTs instead of
// shadow-arm's real per-fire log) was never caught by TDD. This hits the
// REAL server route, GET /api/measurables - fixtures are seeded BEFORE
// startServer() below, so the boot-time measurablesTick() call (glmps-140:
// GET /api/measurables is now a pure read, no longer a self-populate side
// effect - see server.js's computeGuardStaleCandidates and measurablesTick)
// computes the guard-retire-stale measurables these assertions read back.

function seedTwoAppliedGuards(stateDir, { firingCode, dormantCode, adoptedTs }) {
  let state = learningStore.emptyState();

  // Guard proposer cutover: a gap item's proposedGuard is always
  // null at detection (no more TEMPLATES auto-populate), so seed a rule the
  // way an operator actually gets one onto a gap item now - the
  // 'alternative' action - before marking it applied. server.js's
  // appliedGuardCatalog() (which computeGuardStaleCandidates reads) only
  // sees items that carry a real proposedGuard.rule.
  const firing = learningStore.upsertGapInto(state, { code: firingCode, message: 'x' }, { project: 'p', sessionId: 's1' });
  state = learningStore.applyAction(firing.state, firing.item.id, 'alternative', { rule: `- Guard for ${firingCode}.` }).state;
  state = learningStore.markApplied(state, firing.item.id, 'commit1').state;

  const dormant = learningStore.upsertGapInto(state, { code: dormantCode, message: 'y' }, { project: 'p', sessionId: 's2' });
  state = learningStore.applyAction(dormant.state, dormant.item.id, 'alternative', { rule: `- Guard for ${dormantCode}.` }).state;
  state = learningStore.markApplied(state, dormant.item.id, 'commit2').state;

  // Backdate both items' updatedTs to a fixed old adoption time - markApplied
  // always stamps Date.now(), which a real test can't control at the moment
  // of the call, so overwrite it directly on the saved state (still a
  // realistic learning-store shape; only the timestamp is synthetic).
  state = { ...state, items: state.items.map((it) => ({ ...it, updatedTs: adoptedTs })) };
  learningStore.save(stateDir, state);
}

test('end-to-end: GET /api/measurables does NOT flag an old-but-actively-firing guard as stale (glmps-138 C1 fix)', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  const adoptedTs = Date.now() - 120 * MS_PER_DAY; // adopted 120 days ago (past the 90-day default retireDays)

  seedTwoAppliedGuards(stateDir, { firingCode: 'sleep-poll', dormantCode: 'reread-loop', adoptedTs });
  // sleep-poll fired recently -> real usage since adoption, must NOT be flagged.
  recordShadow(stateDir, { taskClass: 'sleep-poll', wouldFire: true, fired: true, sid: 'recent' });
  // reread-loop: zero shadow-arm observations since adoption -> never fired -> should be flagged.

  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/measurables`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const ids = body.measurables.map((m) => m.id);
    assert.ok(!ids.includes('guard-retire-stale:sleep-poll'),
      `actively-firing guard was falsely flagged stale (the C1 bug), got: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('guard-retire-stale:reread-loop'),
      `never-fired-since-adoption guard should be flagged stale, got: ${JSON.stringify(ids)}`);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});


test('end-to-end: config.json retireStaleness.retireDays actually changes what GET /api/measurables flags (glmps-138 I5 fix)', async () => {
  const stateDir = tmp('mc-state-');
  const claudeDir = tmp('mc-claude-');
  // Adopted 15 days ago, never fired: NOT stale under the 90-day default,
  // but IS stale under an explicit config override of retireDays:10.
  const adoptedTs = Date.now() - 15 * MS_PER_DAY;
  seedTwoAppliedGuards(stateDir, { firingCode: 'sleep-poll', dormantCode: 'reread-loop', adoptedTs });

  const configFile = path.join(stateDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ retireStaleness: { staleDays: 5, retireDays: 10 } }));
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  const h = await startServer({ port: 0, env, configFile });
  try {
    const r = await fetch(`http://127.0.0.1:${h.port}/api/measurables`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const ids = body.measurables.map((m) => m.id);
    assert.ok(ids.includes('guard-retire-stale:reread-loop'),
      `a 15-day-old never-fired guard should be flagged under retireDays:10, got: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes('guard-retire-stale:sleep-poll'),
      `both never-fired guards should be flagged under retireDays:10, got: ${JSON.stringify(ids)}`);
  } finally {
    await h.close?.();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  }
});
