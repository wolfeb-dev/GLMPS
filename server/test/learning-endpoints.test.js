// Routes under test: server/lib/routes/lessons-routes.js
// server/test/learning-endpoints.test.js
// HTTP smoke of the /api/learning* routes against a real server instance on an
// ephemeral port, with a temp GLMPS_STATE_DIR and a temp git GLMPS_ASSETS_DIR so the
// deterministic apply path produces an actual commit. Covers the wired approve
// branch + applied/failed/404 the unit tests can't reach.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startServer } from '../server.js';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { claudeTmp } from './fixtures/claude-dir.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function gitAssetsRepo() {
  const d = tmp('mc-assets-');
  fs.writeFileSync(path.join(d, 'CLAUDE.global.md'), '# Global\n');
  execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init', { cwd: d });
  return d;
}

let stateDir;
let assetsDir;
let claudeDir;
let h;
let base;
const j = async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json() }; };
const post = (p, obj) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

before(async () => {
  stateDir = tmp('mc-state-');
  assetsDir = gitAssetsRepo();
  claudeDir = claudeTmp();
  const env = { ...process.env, GLMPS_STATE_DIR: stateDir, GLMPS_CLAUDE_DIR: claudeDir, GLMPS_ASSETS_DIR: assetsDir, GLMPS_ALLOW_ACT: '1', GLMPS_RUNNER_DRYRUN: '1' };
  h = await startServer({ port: 0, env, configFile: path.join(stateDir, 'no-config.json') });
  base = `http://127.0.0.1:${h.port}`;
});

beforeEach(() => {
  fs.rmSync(path.join(stateDir, 'learning'), { recursive: true, force: true });
  fs.rmSync(path.join(stateDir, 'lessons'), { recursive: true, force: true });
  fs.writeFileSync(path.join(assetsDir, 'CLAUDE.global.md'), '# Global\n');
  h.dryRunLaunches.length = 0;
});

after(async () => {
  await h?.close?.();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  if (assetsDir) fs.rmSync(assetsDir, { recursive: true, force: true });
  if (claudeDir) fs.rmSync(claudeDir, { recursive: true, force: true });
});

test('learning HTTP endpoints: idea, alternative, approve->applied, discard, 404', async () => {
  // Empty queue
  let r = await j('/api/learning');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);

  // Add an idea
  const idea = await post('/api/learning/idea', { text: 'always run lint before committing' });
  assert.equal(idea.status, 200);
  assert.equal(idea.body.source, 'idea');
  assert.equal(idea.body.status, 'pending');
  const id = idea.body.id;

  // It persists
  assert.equal((await j('/api/learning')).body.items.length, 1);

  // Empty idea is rejected
  assert.equal((await post('/api/learning/idea', { text: '   ' })).status, 400);

  // Alternative gives the idea a user-authored guard rule, still pending
  const alt = await post(`/api/learning/item/${id}/alternative`, { rule: '- Run the linter before every commit.' });
  assert.equal(alt.body.status, 'pending');
  assert.equal(alt.body.proposedGuard.rule, '- Run the linter before every commit.');

  // Approve now applies deterministically against the temp git repo
  const ap = await post(`/api/learning/item/${id}/approve`, {});
  assert.equal(ap.body.status, 'applied');
  assert.ok(typeof ap.body.applyCommit === 'string' && ap.body.applyCommit.length >= 7);
  const guard = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
  assert.match(guard, /## Learned guards/);
  assert.match(guard, /Run the linter before every commit/);

  // Discard
  const d2 = await post('/api/learning/idea', { text: 'to discard' });
  const disc = await post(`/api/learning/item/${d2.body.id}/discard`, {});
  assert.equal(disc.body.status, 'discarded');

  // Unknown item -> 404
  assert.equal((await post('/api/learning/item/does-not-exist/approve', {})).status, 404);
});

// Guard proposer cutover: the autoApplyGaps toggle
// route is retired - it had been inert since Task 10 deleted the branch it
// gated, and nothing in the dashboard called it.
test('POST /api/learning/config is retired (404)', async () => {
  const r = await fetch(`http://127.0.0.1:${h.port}/api/learning/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoApplyGaps: true }),
  });
  assert.equal(r.status, 404);
});

test('promote: target global commits a guard; target memory dispatches a memory-compose', async () => {
  // promote to global -> deterministic guard commit into the assets repo
  const i1 = await post('/api/learning/idea', { text: 'prefer parallel subagents for independent work' });
  const pg = await post(`/api/learning/item/${i1.body.id}/promote`, { target: 'global' });
  assert.equal(pg.status, 200);
  assert.equal(pg.body.status, 'applied');
  assert.ok(typeof pg.body.applyCommit === 'string' && pg.body.applyCommit.length >= 7);
  const guard = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
  assert.match(guard, /## Learned guards/);
  assert.match(guard, /prefer parallel subagents/);

  // promote to memory -> dispatched + a native terminal launched mentioning MEMORY.md
  const i2 = await post('/api/learning/idea', { text: 'managed exit already absorbs the morning edge' });
  const pm = await post(`/api/learning/item/${i2.body.id}/promote`, { target: 'memory' });
  assert.equal(pm.status, 200);
  assert.equal(pm.body.status, 'dispatched');
  const last = h.dryRunLaunches.at(-1);
  assert.match(last.command, /MEMORY\.md/);

  // unknown item -> 404
  assert.equal((await post('/api/learning/item/nope/promote', { target: 'global' })).status, 404);
});

// Guard proposer cutover: the free-form headless composer that
// used to invent a guard line from an idea's text is deleted. Approving an
// item with no proposedGuard.rule now fails closed instead of dispatching a
// hand to compose one - the operator sets a rule first (the 'alternative'
// action), or approves a GEPA proposal, which always carries one.
test('approve on an item with no proposedGuard.rule fails closed (400), no dispatch', async () => {
  const idea = await post('/api/learning/idea', { text: 'an idea with no rule set' });
  const ap = await post(`/api/learning/item/${idea.body.id}/approve`, {});
  assert.equal(ap.status, 400);
  assert.match(ap.body.error, /no guard rule/i);

  // Still pending, no dispatch and no terminal launched.
  const item = (await j('/api/learning')).body.items.find((i) => i.id === idea.body.id);
  assert.equal(item.status, 'pending');
  assert.equal(h.dryRunLaunches.length, 0);
});

// Before this, both these routes called applyGuard directly: the guard landed
// in CLAUDE.global.md with no ledger row, no provenance and no gate decision,
// so it was invisible to the ungated_reflex drift check (which reads the
// ledger) and to the operator. Now the operator's click is recorded as the
// human approval the reflex gate requires.

test('approve records a promoted lesson with provenance before the guard lands', async () => {
  assert.deepEqual((await j('/api/lessons')).body.lessons, [], 'the ledger starts empty');

  const idea = await post('/api/learning/idea', { text: 'always read the file before editing it' });
  await post(`/api/learning/item/${idea.body.id}/alternative`, { rule: '- Read a file before editing it.' });
  const ap = await post(`/api/learning/item/${idea.body.id}/approve`, {});
  assert.equal(ap.body.status, 'applied');

  const lessons = (await j('/api/lessons')).body.lessons;
  assert.equal(lessons.length, 1, 'the apply is now a ledger event');
  const lesson = lessons[0];
  assert.equal(lesson.lessonId, `legacy:${idea.body.id}`, 'one canonical id scheme, all routes');
  assert.equal(lesson.kind, 'guard');
  assert.equal(lesson.status, 'active');
  assert.equal(lesson.scope, 'global', 'a guard in CLAUDE.global.md is global scope');
  assert.equal(lesson.reflex, true);
  assert.equal(lesson.promoted, true, 'the operator click IS the approval, recorded as one');
  assert.ok(lesson.provenance.sourceEventIds.includes(`learning-store:${idea.body.id}`),
    'the queue row is the traceable origin');

  // The guard really is in the file, unchanged from before this landed.
  assert.match(fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8'), /Read a file before editing it/);
});

// Guard proposer cutover: a 'gepa' proposal's provenance also
// names the recurring gap items GEPA reflected on (item.derivedFrom), not
// just the proposal row itself, so the ledger trace reaches back to the
// actual failures.
test('approve on a gepa proposal extends provenance with its derivedFrom ids', async () => {
  // Seed a pending GEPA proposal with provenance back to two recurring gap items.
  const proposal = learningStore.upsertProposal(learningStore.emptyState(), {
    source: 'gepa', title: 'Proposed guard', body: 'from GEPA', rule: '- Read the file before editing it.',
    sourceItemIds: ['gap-1', 'gap-2'],
  });
  learningStore.save(stateDir, proposal.state);
  const id = proposal.item.id;

  const ap = await post(`/api/learning/item/${id}/approve`, {});
  assert.equal(ap.status, 200);
  assert.equal(ap.body.status, 'applied');

  const lessons = (await j('/api/lessons')).body.lessons;
  const lesson = lessons.find((l) => l.lessonId === `legacy:${id}`);
  assert.ok(lesson, 'the gepa proposal lands through the same ledger chokepoint as every other source');
  assert.ok(lesson.provenance.sourceEventIds.includes(`learning-store:${id}`), 'the proposal row itself is traced');
  assert.ok(lesson.provenance.sourceEventIds.includes('learning-store:gap-1'), 'the first recurring failure is traced');
  assert.ok(lesson.provenance.sourceEventIds.includes('learning-store:gap-2'), 'the second recurring failure is traced');

  const guard = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
  assert.match(guard, /Read the file before editing it/);
});

// Review Focus 5: a GEPA proposal with
// no traceable provenance must never land, however it is approved. In
// normal operation runGepa already refuses to ingest a CLI output with an
// empty/foreign sourceItemIds (gepa-plugin.test.js), so a 'gepa' item can
// never legitimately end up with an empty derivedFrom - this is the
// defense-in-depth check at the OTHER end (the landing boundary), for a
// hand-edited store, a bug, or corruption that produced one anyway.
test('approve on a gepa proposal with empty derivedFrom is rejected (400), before landGuard ever runs', async () => {
  const proposal = learningStore.upsertProposal(learningStore.emptyState(), {
    source: 'gepa', title: 'Proposed guard', body: 'from GEPA', rule: '- No provenance here.',
    sourceItemIds: [],
  });
  learningStore.save(stateDir, proposal.state);
  const id = proposal.item.id;

  const ap = await post(`/api/learning/item/${id}/approve`, {});
  assert.equal(ap.status, 400);
  assert.match(ap.body.error, /provenance|derivedFrom/i);

  const lessons = (await j('/api/lessons')).body.lessons;
  assert.deepEqual(lessons, [], 'landGuard never ran - the ledger stays empty');
  const item = (await j('/api/learning')).body.items.find((i) => i.id === id);
  assert.equal(item.status, 'pending', 'the item is untouched, not marked failed or applied');
  const guard = fs.readFileSync(path.join(assetsDir, 'CLAUDE.global.md'), 'utf-8');
  assert.doesNotMatch(guard, /No provenance here/);
});

test('promote to global records the same lesson, and revoking it is visible', async () => {
  const idea = await post('/api/learning/idea', { text: 'never poll with sleep then cat' });
  const pg = await post(`/api/learning/item/${idea.body.id}/promote`, { target: 'global' });
  assert.equal(pg.body.status, 'applied');

  const lessonId = `legacy:${idea.body.id}`;
  let lesson = (await j('/api/lessons')).body.lessons.find((l) => l.lessonId === lessonId);
  assert.ok(lesson, 'promote-to-global is a ledger event too');
  assert.equal(lesson.promoted, true);

  // An operator-granted promotion is revocable like any other.
  const rev = await post(`/api/lessons/${encodeURIComponent(lessonId)}/revoke`, { reason: 'test' });
  assert.equal(rev.status, 200);
  lesson = (await j('/api/lessons')).body.lessons.find((l) => l.lessonId === lessonId);
  assert.equal(lesson.promoted, false);
  assert.equal(lesson.reflex, false);
});

test('promote to memory: an id the shell could interpret answers 400 with the reason, no dispatch', async () => {
  const idea = await post('/api/learning/idea', { text: 'managed exit absorbs the morning edge' });
  const st = learningStore.load(stateDir);
  const evil = 'x$(touch pwned)';
  st.items.find((i) => i.id === idea.body.id).id = evil;
  learningStore.save(stateDir, st);
  const launches = h.dryRunLaunches.length;
  const pm = await post(`/api/learning/item/${encodeURIComponent(evil)}/promote`, { target: 'memory' });
  assert.equal(pm.status, 400);
  assert.match(pm.body.error, /unsafe id/);
  assert.equal(h.dryRunLaunches.length, launches, 'nothing was launched');
  const reqDir = path.join(stateDir, 'learning', 'requests');
  assert.deepEqual(fs.existsSync(reqDir) ? fs.readdirSync(reqDir) : [], [], 'a rejected id leaves no request file');
});
