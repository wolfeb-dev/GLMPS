// server/test/web-settings-toast.test.js
// the settings menu's "Open config.json" button called
// openInEditor and ignored the result outright - in service mode (no
// desktop in session 0) that route always answers 409, so clicking it
// there did nothing at all, with zero feedback. The toast-text decision
// is pulled out as a pure function (same convention as launcher.js's
// launchToast, server/test/web-launch-toast.test.js) so it is tested
// without a DOM harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openInEditorToast, restartStepText, restartRefusalText, followRestartRun } from '../../web/shared/settings.js';

test('openInEditorToast: a 200 needs no toast at all - the editor just opens', () => {
  assert.equal(openInEditorToast(200, { ok: true }), null);
});

test('openInEditorToast: a 409 (service mode) shows the server\'s own named reason', () => {
  const msg = openInEditorToast(409, { error: 'service mode cannot open a desktop app from session 0' });
  assert.match(msg, /service mode cannot open a desktop app from session 0/);
});

test('openInEditorToast: a 500 (or any other failure) shows the server\'s own error text', () => {
  const msg = openInEditorToast(500, { error: 'editor did not start' });
  assert.match(msg, /editor did not start/);
});

test('openInEditorToast: a missing error body still names the status code, never silent', () => {
  const msg = openInEditorToast(403, {});
  assert.match(msg, /403/);
});

// Card glmps-2-0-170: the one Restart row.
test('restartStepText names the step that is running, or that the run is starting', () => {
  assert.equal(restartStepText([]), 'Restart: starting');
  assert.equal(restartStepText([{ step: 'quiesce', status: 'started' }]), 'Restart: waiting for merge work to finish');
  assert.equal(restartStepText([{ step: 'quiesce', status: 'finished' }, { step: 'update', status: 'started' }]), 'Restart: applying the update');
  assert.equal(restartStepText([{ step: 'update', status: 'finished' }, { step: 'rebuild', status: 'started' }]), 'Restart: rebuilding the desktop app');
  assert.equal(restartStepText([{ step: 'rebuild', status: 'skipped' }, { step: 'restart', status: 'started' }]), 'Restart: restarting the server');
  assert.equal(restartStepText([{ step: 'verify', status: 'started' }]), 'Restart: checking the new server');
});

test('restartRefusalText names why a Restart did not start', () => {
  assert.match(restartRefusalText('cooldown'), /ran in the last 5 minutes/);
  assert.match(restartRefusalText('action-running'), /already running/);
  assert.match(restartRefusalText('another-action-running'), /deploy or rebuild/);
  assert.match(restartRefusalText('local-session-required'), /not signed in/);
  assert.match(restartRefusalText('weird'), /weird/);
});

const run = (over = {}) => ({ id: 'apr-1', steps: [], run: { startedTs: 1, finishedTs: null, result: null }, ...over });

test('followRestartRun reports each step, rides out a server that is down, and returns the outcome', async () => {
  const seen = [];
  const answers = [
    () => run({ steps: [{ step: 'quiesce', status: 'started' }] }),
    () => { throw new Error('connection refused'); },
    () => run({ steps: [{ step: 'update', status: 'started' }] }),
    () => run({ steps: [{ step: 'verify', status: 'finished' }], run: { startedTs: 1, finishedTs: 9, result: { ok: true, stepsLine: 'update done, rebuild skipped, restart done, verify done' } } }),
  ];
  let t = 0;
  const r = await followRestartRun({
    id: 'apr-1', getRun: async () => answers.shift()(), onStep: (s) => seen.push(s),
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
  assert.deepEqual(r, { ok: true, text: 'Restarted: update done, rebuild skipped, restart done, verify done' });
  assert.deepEqual(seen, ['Restart: waiting for merge work to finish', 'Restart: applying the update']);
});

test('followRestartRun gives the reason when the run fails', async () => {
  const r = await followRestartRun({
    id: 'apr-1', getRun: async () => run({ run: { startedTs: 1, finishedTs: 9, result: { ok: false, error: 'quiesce: still busy: merge work did not finish in time, nothing was restarted' } } }),
    sleep: async () => {}, now: () => 0,
  });
  assert.deepEqual(r, { ok: false, text: 'Restart failed: quiesce: still busy: merge work did not finish in time, nothing was restarted' });
});

test('followRestartRun stops waiting after its ceiling instead of hanging', async () => {
  let t = 0;
  const r = await followRestartRun({ id: 'apr-1', getRun: async () => run(), sleep: async (ms) => { t += ms; }, now: () => t, timeoutMs: 60_000 });
  assert.equal(r.ok, false);
  assert.match(r.text, /did not finish/);
});
