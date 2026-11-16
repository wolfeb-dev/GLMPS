// server/test/learning-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dedupKey,
  normalizeProject,
  applyAction,
  upsertGapInto,
  emptyState,
  addIdea,
  markApplied,
  markDispatched,
  markFailed,
  markSkipped,
  setConfig,
  load,
  save,
} from '../lib/evaluation/learning-store.js';

// Temp dir cleanup

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});
function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-'));
  tmpDirs.push(d);
  return d;
}

// Pure transform tests - verbatim from plan Task 1 Step 1

test('dedupKey: gaps key by code+project, ideas by id', () => {
  assert.equal(dedupKey({ source: 'gap', code: 'ui', project: 'P' }),
               dedupKey({ source: 'gap', code: 'ui', project: 'P' }));
  assert.notEqual(dedupKey({ source: 'gap', code: 'ui', project: 'P' }),
                  dedupKey({ source: 'gap', code: 'ui', project: 'Q' }));
  assert.equal(dedupKey({ source: 'idea', id: 'idea-1' }), 'idea-1');
});

test('upsertGapInto: dedups, counts distinct sessions, never resurfaces/churns discarded', () => {
  let s = emptyState();
  let r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P', sessionId: 's1' });
  assert.equal(r.isNew, true); assert.equal(r.item.count, 1); assert.equal(r.item.status, 'pending');
  assert.equal(r.changed, true);
  s = r.state;
  // Same session re-poll: no churn, no count bump.
  r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P', sessionId: 's1' });
  assert.equal(r.isNew, false); assert.equal(r.changed, false); assert.equal(r.item.count, 1);
  s = r.state;
  // Different session: counts as a recurrence.
  r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P', sessionId: 's2' });
  assert.equal(r.changed, true); assert.equal(r.item.count, 2);
  s = r.state;
  // Discard, then re-detect in a new session: stays discarded, no change emitted.
  s = applyAction(s, r.item.id, 'discard').state;
  r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P', sessionId: 's3' });
  assert.equal(r.item.status, 'discarded'); // stays dismissed
  assert.equal(r.changed, false);
});

// Project-key normalization - the dedup key must collapse the different
// `project` spellings the three writers produce for the same real repo
// (live=raw cwd `D:\glmps`, synth=projects-slug `D--glmps`).

test('normalizeProject: collapses path spellings to the projects-dir slug', () => {
  assert.equal(normalizeProject('D:\\glmps'), 'D--glmps');
  assert.equal(normalizeProject('D:/glmps'), 'D--glmps');
  assert.equal(normalizeProject('D--glmps'), 'D--glmps'); // idempotent
  assert.equal(normalizeProject('D:\\My Web App'), 'D--My-Web-App');
  assert.equal(normalizeProject('D:\\My_Data-Pipeline'), 'D--My-Data-Pipeline');
  assert.equal(normalizeProject(''), '');
  assert.equal(normalizeProject(null), '');
  assert.equal(normalizeProject(undefined), '');
});

test('dedupKey: same repo under raw-cwd and slug spellings hashes to one key', () => {
  assert.equal(
    dedupKey({ source: 'gap', code: 'ui', project: 'D:\\glmps' }),
    dedupKey({ source: 'gap', code: 'ui', project: 'D--glmps' }),
  );
});

test('upsertGapInto: raw-cwd and slug spellings collapse to a single row', () => {
  let s = emptyState();
  let r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'D:\\glmps', sessionId: 's1' });
  assert.equal(r.isNew, true);
  s = r.state;
  // Synth emits the same real repo under the slug spelling - must NOT create a 2nd row.
  r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'D--glmps', sessionId: 's2' });
  assert.equal(r.isNew, false);
  assert.equal(r.state.items.length, 1);
  // Stored project is the canonical slug regardless of which spelling was written.
  assert.equal(r.state.items[0].project, 'D--glmps');
});

test('upsertGapInto: applied row suppresses re-detection under a different project spelling', () => {
  // This is the reported bug: an applied gap reappears as a fresh pending dupe
  // because a different writer spelled `project` differently.
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'D--glmps', sessionId: 's1' }).state;
  s = markApplied(s, s.items[0].id, 'commit1').state;
  const r = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'D:\\glmps', sessionId: 's2' });
  assert.equal(r.isNew, false);            // no fresh pending dupe
  // changed: the new session is recorded as a sighting (card glmps-2-0-201).
  assert.equal(r.changed, true);
  assert.deepEqual(r.item.sightings.map((x) => x.sid), ['s1', 's2']);
  assert.equal(r.item.status, 'applied');  // stays resolved
  assert.equal(r.state.items.length, 1);
});

test('applyAction: discard/alternative transitions', () => {
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P' }).state;
  const id = s.items[0].id;
  let r = applyAction(s, id, 'alternative', { rule: '- custom' });
  assert.equal(r.item.status, 'pending');
  assert.equal(r.item.proposedGuard.rule, '- custom');
  r = applyAction(r.state, id, 'discard');
  assert.equal(r.item.status, 'discarded');
});

// Additional pure transform tests

test('emptyState returns correct shape with seq=0', () => {
  const s = emptyState();
  assert.deepEqual(s.items, []);
  // Guard proposer cutover: autoApplyGaps is retired
  // (inert since the auto-apply-with-template branch it gated was deleted);
  // config is now a plain, empty extension point.
  assert.deepEqual(s.config, {});
  assert.equal(s.seq, 0);
});

test('addIdea: creates idea item with correct fields', () => {
  let s = emptyState();
  const r = addIdea(s, 'try using subagents more');
  s = r.state;
  assert.equal(r.item.source, 'idea');
  assert.equal(r.item.status, 'pending');
  assert.equal(r.item.body, 'try using subagents more');
  assert.equal(r.item.project, '');
  assert.equal(r.item.sessionId, '');
  assert.equal(r.item.proposedGuard, null);
  assert.equal(typeof r.item.id, 'string');
  assert.ok(r.item.id.startsWith('idea-'));
  assert.equal(s.seq, 1);
  assert.equal(s.items.length, 1);
});

test('addIdea: seq increments with each idea', () => {
  let s = emptyState();
  s = addIdea(s, 'first').state;
  s = addIdea(s, 'second').state;
  const r = addIdea(s, 'third');
  assert.equal(r.item.id, 'idea-3');
  assert.equal(r.state.seq, 3);
});

test('applyAction: approve leaves status pending (server orchestrates actual apply)', () => {
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P' }).state;
  const id = s.items[0].id;
  const r = applyAction(s, id, 'approve');
  assert.equal(r.item.status, 'pending');
});

test('applyAction: alternative merges into existing proposedGuard', () => {
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui-without-frontend-design', severity: 'warn', message: 'm' }, { project: 'P' }).state;
  const id = s.items[0].id;
  // The item starts with proposedGuard: null (no template, Task 10); alternative
  // still fills in the default file/section and sets the operator's own rule.
  const r = applyAction(s, id, 'alternative', { rule: '- my custom rule' });
  assert.equal(r.item.proposedGuard.rule, '- my custom rule');
  assert.equal(r.item.proposedGuard.file, 'CLAUDE.global.md');
  assert.equal(r.item.proposedGuard.section, 'Learned guards');
  assert.equal(r.item.status, 'pending');
});

test('markApplied: sets status applied and applyCommit', () => {
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P' }).state;
  const id = s.items[0].id;
  const r = markApplied(s, id, 'abc123');
  assert.equal(r.state.items[0].status, 'applied');
  assert.equal(r.state.items[0].applyCommit, 'abc123');
});

test('markApplied: stores pushed only when given', () => {
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'm' }, { project: 'P' }).state;
  const id = s.items[0].id;
  assert.equal('pushed' in markApplied(s, id, 'abc').item, false);
  const pushed = { repo: 'o/n', branch: 'glmps2/main', sha: 'abc', ts: 5 };
  assert.deepEqual(markApplied(s, id, 'abc', pushed).item.pushed, pushed);
});

test('markDispatched: sets status dispatched', () => {
  let s = emptyState();
  s = addIdea(s, 'some idea').state;
  const id = s.items[0].id;
  const r = markDispatched(s, id);
  assert.equal(r.state.items[0].status, 'dispatched');
});

test('markFailed: sets status failed and error', () => {
  let s = emptyState();
  s = addIdea(s, 'some idea').state;
  const id = s.items[0].id;
  const r = markFailed(s, id, 'something went wrong');
  assert.equal(r.state.items[0].status, 'failed');
  assert.equal(r.state.items[0].error, 'something went wrong');
});

test('markSkipped: sets status skipped and skipReason', () => {
  let s = emptyState();
  s = addIdea(s, 'some idea').state;
  const id = s.items[0].id;
  const r = markSkipped(s, id, 'duplicates existing sleep-poll guard');
  assert.equal(r.state.items[0].status, 'skipped');
  assert.equal(r.state.items[0].skipReason, 'duplicates existing sleep-poll guard');
});

test('markSkipped: throws on unknown id', () => {
  const s = emptyState();
  assert.throws(() => markSkipped(s, 'nope', 'x'), /Item not found/);
});

test('setConfig: merges patch into config', () => {
  let s = emptyState();
  const r = setConfig(s, { someFlag: true });
  assert.equal(r.config.someFlag, true);
  const r2 = setConfig(r, { someFlag: false });
  assert.equal(r2.config.someFlag, false);
});

test('upsertGapInto: gap item has correct fields', () => {
  let s = emptyState();
  const r = upsertGapInto(s, { code: 'ui-without-frontend-design', severity: 'warn', message: 'Use frontend-design skill' }, { project: 'my-proj', sessionId: 'ses-1' });
  const item = r.item;
  assert.equal(item.source, 'gap');
  assert.equal(item.code, 'ui-without-frontend-design');
  assert.equal(item.severity, 'warn');
  assert.equal(item.body, 'Use frontend-design skill');
  assert.equal(item.project, 'my-proj');
  assert.equal(item.sessionId, 'ses-1');
  assert.equal(item.lastFiredEpisodeId, null, 'new items start with no fired-transition marker');
  assert.equal(item.count, 1);
  assert.equal(item.status, 'pending');
  assert.equal(typeof item.id, 'string');
  assert.equal(typeof item.createdTs, 'number');
  assert.equal(typeof item.updatedTs, 'number');
  assert.equal(typeof item.title, 'string');
  assert.ok(item.title.length > 0);
  // Guard proposer cutover: no auto-populated template - a new gap
  // item always starts with proposedGuard: null, whatever its code.
  assert.equal(item.proposedGuard, null);
});

test('upsertGapInto: a gap item never gets an auto-populated proposedGuard (no live templates)', () => {
  let s = emptyState();
  const r = upsertGapInto(s, { code: 'unknown-code', severity: 'info', message: 'something' }, { project: 'P' });
  assert.equal(r.item.proposedGuard, null);
});

// fs round-trip test

test('save and load round-trip under a temp dir', () => {
  const tmpDir = mkTmp();

  // Build some state
  let s = emptyState();
  s = upsertGapInto(s, { code: 'ui', severity: 'warn', message: 'Use frontend skill' }, { project: 'proj-1', sessionId: 'ses-1' }).state;
  s = addIdea(s, 'think harder').state;
  s = setConfig(s, { someFlag: true });

  // Save then load
  save(tmpDir, s);
  const loaded = load(tmpDir);

  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.config.someFlag, true);
  assert.equal(loaded.seq, 1);

  const gapItem = loaded.items.find(i => i.source === 'gap');
  assert.equal(gapItem.code, 'ui');
  assert.equal(gapItem.project, 'proj-1');
  assert.equal(gapItem.count, 1);

  const ideaItem = loaded.items.find(i => i.source === 'idea');
  assert.equal(ideaItem.body, 'think harder');
  assert.equal(ideaItem.id, 'idea-1');
});

test('load returns emptyState() when file is absent', () => {
  const tmpDir = mkTmp();
  const s = load(tmpDir);
  assert.deepEqual(s.items, []);
  assert.deepEqual(s.config, {});
  assert.equal(s.seq, 0);
});

test('load returns emptyState() when file is unparseable', () => {
  const tmpDir = mkTmp();
  const storeDir = path.join(tmpDir, 'learning');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'store.json'), 'not valid json {{');
  const s = load(tmpDir);
  assert.deepEqual(s.items, []);
});

// Card glmps-2-0-192: rows filed before 'covered' existed, keyed to worktree
// slugs that never recur, stayed 'pending' forever because coverage was only
// re-applied on re-detection of the same key.
test('reconcileCoverage re-sorts orphaned pending rows against the current guard file', async () => {
  const { reconcileCoverage } = await import('../lib/evaluation/learning-store.js');
  let s = emptyState();
  for (const [code, project] of [['sleep-poll', 'D:/old-worktree-a'], ['ticket-closed-without-gate', 'D:/old-worktree-b'], ['reread-loop', 'D:/old-worktree-c']]) {
    s = upsertGapInto(s, { code, severity: 'warn', message: code }, { project, sessionId: 's1' }).state;
  }
  s = { ...s, items: s.items.map((i) => (i.code === 'reread-loop' ? { ...i, status: 'covered' } : i)) };
  const before = JSON.stringify(s);
  const r = reconcileCoverage(s, new Set(['sleep-poll']));
  assert.equal(r.changed, true);
  assert.equal(JSON.stringify(s), before, 'input state is not mutated');
  const by = Object.fromEntries(r.state.items.map((i) => [i.code, i.status]));
  assert.deepEqual(by, { 'sleep-poll': 'covered', 'ticket-closed-without-gate': 'pending', 'reread-loop': 'pending' });
  assert.equal(reconcileCoverage(r.state, new Set(['sleep-poll'])).changed, false, 'idempotent');
});

test('reconcileCoverage leaves resolved rows alone and is a no-op without a coverage set', async () => {
  const { reconcileCoverage } = await import('../lib/evaluation/learning-store.js');
  let s = upsertGapInto(emptyState(), { code: 'sleep-poll', severity: 'warn', message: 'x' }, { project: 'p', sessionId: 's' }).state;
  s = { ...s, items: s.items.map((i) => ({ ...i, status: 'discarded' })) };
  assert.equal(reconcileCoverage(s, new Set(['sleep-poll'])).changed, false);
  assert.equal(reconcileCoverage(s, undefined).changed, false);
});
