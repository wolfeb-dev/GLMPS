// server/test/guard-fire-continuous.test.js
// glmps-139: shadow-arm's fired:true for a guard's (code, project) class was
// only ever recorded near ADOPTION (learning-apply.js's applyGuard on
// auto-apply, or the alert-priming seen-set path in server.js) - a
// MANUALLY-approved guard (POST /api/learning/item/:id/approve, the common
// path) never got a fired:true entry recorded AT ALL, ever. Combined with
// learning-store.js's upsertGapInto "resolved items are immutable on
// re-detection" rule (an applied item is left alone, no churn), a guard's
// fire-history goes silent forever after adoption, even while its trigger
// condition keeps recurring session after session. That starves
// guard-staleness (guard-retire.js's staleGuardCandidates, glmps-138, reads
// lastFiredByClass) and the Loop view's guardHits metric
// (shadow-arm.js's firedCountInWindow).
//
// Fix: learningStore.upsertGap(stateDir, gap, ctx) - the fs load->mutate->save
// wrapper used EXCLUSIVELY by the Stop hook (hooks/capability-feed.js) - now
// records a measurement-only shadow observation (fired:true, taskClass =
// gap.code) whenever upsertGapInto's "leave alone" branch returns an item
// with status 'applied'. This is purely additional bookkeeping: the pure
// upsertGapInto transform and the persisted item are completely untouched
// (no state change, no updatedTs bump, no re-proposal).
//
// CORRECTION (2026-07-29, glmps-139 follow-up): the two paragraphs above
// were written believing the Stop hook "runs once per session end" and that
// this therefore "fires at most once per (session, code), not once per
// /api/state tick". That belief was WRONG, measured directly: a Stop hook
// fires once per agent TURN, not once per conversation. Session 56cff9f7
// produced 143 fired:true rows for one gap code, at 143 distinct
// timestamps, median gap ~508s across 7 days - turn cadence, not poll
// cadence, and not a burst. Every turn re-detected the same already-applied
// gap and the un-gated write below recorded a row every time.
//
// The tests below this comment (added when the correction landed) pin the
// actual fix: upsertGap now fires at most once per DISTINCT
// (episodeId ?? sessionId, code) transition, via a lastFiredEpisodeId marker
// persisted on the item (see learning-store.js's upsertGap doc comment for
// the full writeup). Same-episode re-calls are a no-op; a new episode (or,
// absent a real episodeId, a new sessionId - the only case wired into
// production today) fires again. Contrast gap-pipeline.js's
// upsertGapAndApply, which server.js's /api/state poll loop calls repeatedly
// per session and which deliberately gates its OWN shadow write on
// up.isNew for a different flooding reason - untouched by this change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { lastFiredByClass, firedCountInWindow } from '../lib/evaluation/shadow-arm.js';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Seeds an applied guard the way a MANUAL approve does in practice: create the
// gap item, then markApplied directly (mirrors server.js's POST
// /api/learning/item/:id/approve route, which calls learningStore.markApplied
// but never recordShadow), so the store starts with ZERO shadow history,
// matching the real-world bug this ticket fixes.
function seedAppliedGuard(stateDir, gap, ctx) {
  let state = learningStore.emptyState();
  const created = learningStore.upsertGapInto(state, gap, ctx);
  state = learningStore.markApplied(created.state, created.item.id, 'commit1').state;
  learningStore.save(stateDir, state);
  return state.items[0];
}

test('upsertGap: re-detecting an applied guard records a continuous shadow fired:true observation', () => {
  const stateDir = tmp('mc-guard-fire-');
  const gap = { code: 'sleep-poll', severity: 'warn', message: 'Never poll with sleep N then cat' };
  const seeded = seedAppliedGuard(stateDir, gap, { project: 'p', sessionId: 's1' });

  // Baseline: no shadow observations at all yet (manual-approve path records none).
  assert.deepEqual(lastFiredByClass(stateDir), {});
  assert.equal(firedCountInWindow(stateDir, {}), 0);

  const before = Date.now();
  const result = learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's2' });

  // (a) a new shadow observation with fired:true is recorded; lastFiredByClass advances to ~now.
  const lf = lastFiredByClass(stateDir);
  assert.ok(typeof lf['sleep-poll'] === 'number', 'sleep-poll taskClass now has a fired:true observation');
  assert.ok(lf['sleep-poll'] >= before, 'recorded timestamp is ~now, not stale');

  // (c) firedCountInWindow increases.
  assert.equal(firedCountInWindow(stateDir, {}), 1);

  // (b) the gap item's state/updatedTs/count are UNCHANGED, no resurrection.
  // The one addition is the new session's sighting, which the auto-approve
  // probation measures (card glmps-2-0-201), so the row is rewritten once.
  assert.equal(result.isNew, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.item.sightings.map((x) => x.sid), ['s1', 's2']);
  assert.equal(result.item.status, 'applied');
  assert.equal(result.item.updatedTs, seeded.updatedTs);
  assert.equal(result.item.count, seeded.count);

  const persisted = learningStore.load(stateDir);
  assert.equal(persisted.items.length, 1, 'no new/duplicate item created');
  assert.equal(persisted.items[0].status, 'applied');
  assert.equal(persisted.items[0].updatedTs, seeded.updatedTs, 'persisted item is byte-identical, no resurrection');
});

test('upsertGap: repeated re-detections across sessions keep accumulating fired observations', () => {
  const stateDir = tmp('mc-guard-fire-');
  const gap = { code: 'reread-loop', severity: 'warn', message: 'Do not re-read an unchanged file' };
  seedAppliedGuard(stateDir, gap, { project: 'p', sessionId: 's1' });

  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's2' });
  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's3' });
  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's4' });

  assert.equal(firedCountInWindow(stateDir, {}), 3, 'one fired observation per re-detecting session');
});

test('upsertGap: a still-PENDING (not applied) gap keeps existing behavior, no continuous-fire shadow write', () => {
  const stateDir = tmp('mc-guard-fire-');
  const gap = { code: 'pending-code', severity: 'warn', message: 'm' };

  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's1' }); // creates as pending
  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's2' }); // re-detect, still pending

  assert.deepEqual(lastFiredByClass(stateDir), {}, 'pending items are out of scope for this fix');
  assert.equal(firedCountInWindow(stateDir, {}), 0);
});

test('upsertGap: a DISCARDED gap keeps existing behavior, no continuous-fire shadow write', () => {
  const stateDir = tmp('mc-guard-fire-');
  const gap = { code: 'discarded-code', severity: 'warn', message: 'm' };

  let state = learningStore.emptyState();
  const created = learningStore.upsertGapInto(state, gap, { project: 'p', sessionId: 's1' });
  state = learningStore.applyAction(created.state, created.item.id, 'discard').state;
  learningStore.save(stateDir, state);

  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's2' }); // re-detect a discarded gap

  assert.deepEqual(lastFiredByClass(stateDir), {}, 'a discarded gap never resurfaces and is not a "firing guard"');
  assert.equal(firedCountInWindow(stateDir, {}), 0);

  const persisted = learningStore.load(stateDir);
  assert.equal(persisted.items[0].status, 'discarded', 'discarded status untouched');
});

test('upsertGap: edge-triggered - the same (episode, code) asserted 100 times yields exactly 1 fired record', () => {
  const stateDir = tmp('mc-guard-fire-');
  const gap = { code: 'done-without-verification', severity: 'warn', message: 'm' };
  seedAppliedGuard(stateDir, gap, { project: 'p', sessionId: 's1' });

  for (let i = 0; i < 100; i++) {
    // Same episodeId every call (simulating 100 Stop-hook firings within one
    // long-running session/task), distinct sessionId ignored once episodeId is given.
    learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's1', episodeId: 'ep-constant' });
  }

  assert.equal(firedCountInWindow(stateDir, {}), 1, 'one transition, not one write per call');
});

test('upsertGap: edge-triggered - a DIFFERENT episode is a new transition and fires again', () => {
  const stateDir = tmp('mc-guard-fire-');
  const gap = { code: 'reread-loop', severity: 'warn', message: 'm' };
  seedAppliedGuard(stateDir, gap, { project: 'p', sessionId: 's1' });

  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's1', episodeId: 'ep-a' });
  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's1', episodeId: 'ep-a' }); // same episode, no-op
  learningStore.upsertGap(stateDir, gap, { project: 'p', sessionId: 's1', episodeId: 'ep-b' }); // new episode, fires

  assert.equal(firedCountInWindow(stateDir, {}), 2);
});
