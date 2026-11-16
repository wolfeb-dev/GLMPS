// apps/shell/test/window-decisions.test.js
// the decisions shell-window.js applies, as pure
// functions (shell-window.js itself imports electron and cannot run here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openExternalSafely, dashboardLoadedDecision, slackToDashboardAction } from '../src/lib/window-decisions.js';

const KERNEL = 'http://127.0.0.1:8124';

// SF-2: shell.openExternal rejecting (no browser association, an OS failure)
// used to be a shell.log line only: the operator clicked a link and nothing
// visibly happened. The two security refusals stay log-only by design.
test('SF-2: an openExternal rejection notifies the operator and logs', async () => {
  const notes = []; const logs = [];
  const r = await openExternalSafely({ url: 'https://example.com/a', openExternal: async () => { throw new Error('no handler'); }, log: (...a) => logs.push(a), notify: (...a) => notes.push(a) });
  assert.equal(r, 'failed');
  assert.equal(notes.length, 1);
  assert.match(notes[0].join(' '), /Could not open the link/);
  assert.match(notes[0].join(' '), /https:\/\/example\.com\/a/);
  assert.match(notes[0].join(' '), /no handler/);
  assert.ok(logs.some((l) => l[0] === 'error'));
});

test('SF-2: an unsafe external URL is refused and logged, never opened and never notified', async () => {
  const notes = []; const logs = []; const opened = [];
  const r = await openExternalSafely({ url: 'javascript:alert(1)', openExternal: async (u) => { opened.push(u); }, log: (...a) => logs.push(a), notify: (...a) => notes.push(a) });
  assert.equal(r, 'refused');
  assert.deepEqual(opened, []);
  assert.deepEqual(notes, []);
  assert.ok(logs.some((l) => l[0] === 'warn'));
});

test('SF-2: a safe URL that opens is neither notified nor logged as an error', async () => {
  const notes = []; const opened = [];
  const r = await openExternalSafely({ url: 'https://example.com/', openExternal: async (u) => { opened.push(u); }, log: () => {}, notify: (...a) => notes.push(a) });
  assert.equal(r, 'opened');
  assert.deepEqual(opened, ['https://example.com/']);
  assert.deepEqual(notes, []);
});

// a first dashboard load slower than the 20 s timeout set
// load-failed:timeout, and did-finish-load's own `!loadFailure` guard then
// kept the timeout page up even after the page actually finished.
test('W1: a kernel-origin page finishing after the timeout clears load-failed:timeout and reveals the dashboard', () => {
  assert.deepEqual(dashboardLoadedDecision({ loadFailure: 'load-failed:timeout', url: `${KERNEL}/`, kernelOrigin: KERNEL }), { clearFailure: true, reveal: true });
});

test('W1: any other load failure is not cleared by a finish, and nothing off the kernel origin is revealed', () => {
  assert.deepEqual(dashboardLoadedDecision({ loadFailure: 'load-failed:renderer crashed', url: `${KERNEL}/`, kernelOrigin: KERNEL }), { clearFailure: false, reveal: false });
  assert.deepEqual(dashboardLoadedDecision({ loadFailure: 'load-failed:timeout', url: 'http://127.0.0.1:1/', kernelOrigin: KERNEL }), { clearFailure: false, reveal: false });
  // Origin comparison, not a string prefix: :81245 is not :8124.
  assert.deepEqual(dashboardLoadedDecision({ loadFailure: null, url: 'http://127.0.0.1:81245/', kernelOrigin: KERNEL }), { clearFailure: false, reveal: false });
  assert.deepEqual(dashboardLoadedDecision({ loadFailure: null, url: 'not a url', kernelOrigin: KERNEL }), { clearFailure: false, reveal: false });
  assert.deepEqual(dashboardLoadedDecision({ loadFailure: null, url: `${KERNEL}/x`, kernelOrigin: KERNEL }), { clearFailure: false, reveal: true });
});

// a Slack link to the kernel while the supervisor reports it refused or
// down began a dashboard load anyway, which replaced the offline page's true
// reason (and its install command) with "loading the dashboard failed".
test('W2: a Slack link to the kernel loads the dashboard only while the kernel is up or degraded', () => {
  assert.equal(slackToDashboardAction('up'), 'load');
  assert.equal(slackToDashboardAction('degraded'), 'load');
  for (const s of ['refused', 'offline', 'down', 'checking', 'starting', undefined]) assert.equal(slackToDashboardAction(s), 'focus', String(s));
});
