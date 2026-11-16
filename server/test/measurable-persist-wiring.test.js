// Routes under test: server/lib/routes/guards-routes.js
// server/test/measurable-persist-wiring.test.js
// The two retire-candidate routes already recompute candidates fresh per
// request (no persisted state machine); this proves each request ALSO now
// persists a durable Measurable row and surfaces an info-severity alert via
// the signal-producer registry.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import { recordShadow } from '../lib/evaluation/shadow-arm.js';
import { recordFirstSeen } from '../lib/evaluation/skill-observation-log.js';
import { listMeasurables } from '../lib/evaluation/measurables-store.js';
import * as learningStore from '../lib/evaluation/learning-store.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Guard proposer cutover: server.js's guard-retire routes now read
// their guard catalog from applied learning-store items (appliedGuardCatalog()),
// not a static template map - seed one the way an operator actually gets a
// gap item to 'applied' now (the 'alternative' action sets a rule, then it
// lands), so these tests still have a guard the retire-candidate rule can see.
function seedAppliedGuard(stateDir, code) {
  let state = learningStore.emptyState();
  const up = learningStore.upsertGapInto(state, { code, message: 'm' }, { project: 'p', sessionId: 's1' });
  state = learningStore.applyAction(up.state, up.item.id, 'alternative', { rule: `- Guard for ${code}.` }).state;
  state = learningStore.markApplied(state, up.item.id, 'commit1').state;
  learningStore.save(stateDir, state);
}

let stateDir;
let claudeDir;
let h;

before(async () => {
  stateDir = tmp('mc-state-');
  claudeDir = tmp('mc-claude-');
  const skillDir = path.join(claudeDir, 'skills', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nBody.\n');
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir };
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
});

after(async () => {
  await h?.close?.();
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const sub of ['learning', 'shadow', 'measurables', 'skills']) {
    fs.rmSync(path.join(stateDir, sub), { recursive: true, force: true });
  }
});

test('GET /api/guards/retire-candidates persists each candidate as a durable measurable + surfaces an info alert', async () => {
  // guard-retire.js's DEFAULT_MIN_OBSERVATIONS is 20 (default.min-observations
  // floor a low-evidence route override can't lower for the registered signal
  // producer below, which has no request-scoped args to pass minObservations
  // through) - record enough observations to clear that fixed default too, so
  // the info-alert assertion below is consistent with the route assertion.
  for (let i = 0; i < 20; i++) {
    recordShadow(stateDir, { taskClass: 'ui-without-frontend-design', wouldFire: false, fired: false });
  }
  seedAppliedGuard(stateDir, 'ui-without-frontend-design');
  const r = await fetch(`http://127.0.0.1:${h.port}/api/guards/retire-candidates?minObservations=1`);
  const body = await r.json();
  assert.ok(body.candidates.some(c => c.code === 'ui-without-frontend-design'));

  const stored = listMeasurables(stateDir, { kind: 'guard-retire' });
  assert.ok(stored.some(m => m.id === 'guard-retire:ui-without-frontend-design'));

  const alerts = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
  assert.ok(alerts.alerts.some(a => a.source === 'guard-retire-candidate'));
});

test('GET /api/skills/lifecycle persists an archive candidate as a durable measurable + surfaces an info alert', async () => {
  recordFirstSeen(stateDir, ['user:demo-skill'], Date.now() - 200 * 86400000);

  const r = await fetch(`http://127.0.0.1:${h.port}/api/skills/lifecycle`);
  const body = await r.json();
  assert.ok(body.archiveCandidates.some(c => c.id === 'user:demo-skill'));

  const stored = listMeasurables(stateDir, { kind: 'skill-retire' });
  assert.ok(stored.some(m => m.id === 'skill-retire:user:demo-skill'));

  const alerts = await (await fetch(`http://127.0.0.1:${h.port}/api/alerts`)).json();
  assert.ok(alerts.alerts.some(a => a.source === 'skill-retire-candidate'));
});

// glmps-102: guard/skill retire-candidate measurables used to persist ONLY
// as a side effect of the two routes above - GET /api/measurables (the
// Scoreboard source) never computed them itself, so a fresh server, or a
// user who opens the Scoreboard first, saw zero guard/skill rows. glmps-140
// later moved that compute off GET /api/measurables entirely and onto a
// scheduled tick (measurablesTick), called once synchronously at boot - so
// this now hits GET /api/measurables ALONE (neither /api/guards/retire-
// candidates nor /api/skills/lifecycle is ever called) with fixtures seeded
// BEFORE startServer(), and asserts both candidate kinds still show up, now
// via the boot-time tick rather than the GET request itself.
test('GET /api/measurables reflects both guard AND skill retire-candidate rows the boot-time tick persisted, without either dedicated route ever being hit', async () => {
  const bootStateDir = tmp('mc-state-');
  const bootClaudeDir = tmp('mc-claude-');
  for (let i = 0; i < 20; i++) {
    recordShadow(bootStateDir, { taskClass: 'ui-without-frontend-design', wouldFire: false, fired: false });
  }
  seedAppliedGuard(bootStateDir, 'ui-without-frontend-design');
  const skillDir = path.join(bootClaudeDir, 'skills', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: demo\n---\nBody.\n');
  recordFirstSeen(bootStateDir, ['user:demo-skill'], Date.now() - 200 * 86400000);

  const env = { ...process.env, GLMPS_STATE_DIR: bootStateDir, GLMPS_CLAUDE_DIR: bootClaudeDir };
  const srv = await startServer({ port: 0, env, configFile: path.join(bootStateDir, 'no-config.json') });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/measurables`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.measurables.some(m => m.id === 'guard-retire:ui-without-frontend-design'),
      `expected a self-populated guard-retire row, got: ${JSON.stringify(body.measurables.map(m => m.id))}`);
    assert.ok(body.measurables.some(m => m.id === 'skill-retire:user:demo-skill'),
      `expected a self-populated skill-retire row, got: ${JSON.stringify(body.measurables.map(m => m.id))}`);
  } finally {
    await srv.close?.();
    fs.rmSync(bootStateDir, { recursive: true, force: true });
    fs.rmSync(bootClaudeDir, { recursive: true, force: true });
  }
});

test('empty state dir: neither route errors and neither persists anything', async () => {
  const r1 = await fetch(`http://127.0.0.1:${h.port}/api/guards/retire-candidates`);
  assert.equal(r1.status, 200);
  const r2 = await fetch(`http://127.0.0.1:${h.port}/api/skills/lifecycle`);
  assert.equal(r2.status, 200);
  assert.equal(listMeasurables(stateDir).length, 0);
});
