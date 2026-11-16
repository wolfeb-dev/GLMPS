// server/test/gap-pipeline.test.js
// upsertGapAndApply() factors the "detect a gap -> upsert into the learning
// queue -> shadow-record the counterfactual" logic that used to live inline
// in server.js's /api/state gap loop, so a second producer (the alert-derived
// learnable-alert adapter) can reuse the exact same wiring without forking
// it. Injectable recordShadowFn so this is a pure unit test - no fs, no git,
// no real shadow-arm file.
//
// Guard proposer cutover: the auto-apply-with-template branch (and
// its dedicated tests, which lived here, in gap-pipeline-reflex.test.js and
// gap-pipeline-measurement.test.js) is deleted along with the TEMPLATES map
// that used to seed a gap item's proposedGuard. A new gap item's
// proposedGuard is always null now, so there is nothing left for this
// pipeline to auto-apply; every guard lands only through the operator's
// approval (a GEPA proposal, or a gap item they set an alternative rule on).
//
// stateDir is still exercised as a REAL directory (not a stubbed-away value):
// whenever a test omits recordShadowFn, upsertGapAndApply falls through to
// the real shadow-arm.js default, which calls fs.mkdirSync(stateDir/shadow,
// ...). A hardcoded '/state' literal here resolves to a writable C:\state on
// Windows (silently polluting it) but to the unwritable filesystem root on
// Linux CI -> EACCES. Use an isolated mkdtemp dir for every stateDir value so
// this is a real, writable directory on every platform, matching the tmp-dir
// convention in the other test files (backlog-endpoints.test.js, paths.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as learningStore from '../lib/evaluation/learning-store.js';
import { upsertGapAndApply } from '../lib/evaluation/gap-pipeline.js';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gap-pipeline-'));
process.on('exit', () => { try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch {} });

function freshLq() {
  return { ...learningStore.emptyState() };
}

test('new gap -> pending item, no auto-populated proposedGuard, counterfactual shadow recorded', () => {
  let lq = freshLq();
  const shadowCalls = [];
  const { lq: next, dirty, item } = upsertGapAndApply(
    lq, { code: 'ui-without-frontend-design', severity: 'warn', message: 'm' },
    { project: 'p', sessionId: 's1' },
    { stateDir: STATE_DIR, recordShadowFn: (stateDir, rec) => shadowCalls.push({ stateDir, rec }) },
  );
  assert.equal(dirty, true);
  assert.equal(item.status, 'pending');
  assert.equal(item.proposedGuard, null);
  assert.equal(next.items.length, 1);
  assert.deepEqual(shadowCalls, [{ stateDir: STATE_DIR, rec: { taskClass: 'ui-without-frontend-design', fired: false, sid: 's1' } }]);
});

test('recurring (not-new) gap: no shadow call, item just bumps count', () => {
  let lq = freshLq();
  const first = upsertGapAndApply(lq, { code: 'x', severity: 'warn', message: 'm' }, { project: 'p', sessionId: 's1' }, { stateDir: STATE_DIR });
  const shadowCalls = [];
  const second = upsertGapAndApply(first.lq, { code: 'x', severity: 'warn', message: 'm' }, { project: 'p', sessionId: 's2' }, {
    stateDir: STATE_DIR,
    recordShadowFn: (s, rec) => shadowCalls.push(rec),
  });
  assert.equal(second.item.count, 2, 'distinct session bumps recurrence count');
  assert.deepEqual(shadowCalls, [], 'shadow-arm measures NEW gaps only, matching the pre-existing /api/state behavior');
});

test('recordShadowForNew:false suppresses this function\'s own shadow bookkeeping (caller records separately)', () => {
  let lq = freshLq();
  const shadowCalls = [];
  const { item } = upsertGapAndApply(
    lq, { code: 'egress', severity: 'warn', message: 'm' }, { project: '', sessionId: 's1' },
    { stateDir: STATE_DIR, recordShadowForNew: false, recordShadowFn: (s, rec) => shadowCalls.push(rec) },
  );
  assert.equal(item.status, 'pending');
  assert.deepEqual(shadowCalls, [], 'no counterfactual shadow call when recordShadowForNew is false');
});
