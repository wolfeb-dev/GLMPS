// apps/shell/test/debug-switches.test.js
// Task 15, L2 (security review): a packaged build honoured
// --remote-debugging-port / --remote-debugging-pipe from its own command line,
// which hands DevTools-protocol control of the Slack and dashboard sessions to
// anything that can start the exe with an extra argument. A packaged build now
// refuses to start with either; a dev build is unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusedDebugSwitch } from '../src/lib/debug-switches.js';

const EXE = 'C:\\Program Files\\GLMPS 2.0\\GLMPS 2.0.exe';

test('L2: a packaged build refuses --remote-debugging-port and --remote-debugging-pipe in every Chromium switch spelling', () => {
  for (const arg of ['--remote-debugging-port=9222', '--remote-debugging-port', '--remote-debugging-pipe', '-remote-debugging-port=9222', '/remote-debugging-port=9222', '--REMOTE-DEBUGGING-PORT=9222', '--remote-debugging-pipe=cbor']) {
    const r = refusedDebugSwitch({ isDev: false, argv: [EXE, arg] });
    assert.ok(r, arg);
    assert.match(r, /remote-debugging-(port|pipe)/);
  }
});

test('L2: the switch is also caught when only Chromium\'s own command line reports it', () => {
  const hasSwitch = (name) => name === 'remote-debugging-pipe';
  assert.equal(refusedDebugSwitch({ isDev: false, argv: [EXE], hasSwitch }), 'remote-debugging-pipe');
});

test('L2: ordinary arguments, look-alike switches and dev builds are not refused', () => {
  assert.equal(refusedDebugSwitch({ isDev: false, argv: [EXE, '--hidden'] }), null);
  assert.equal(refusedDebugSwitch({ isDev: false, argv: [EXE, '--remote-debugging-portal'] }), null);
  assert.equal(refusedDebugSwitch({ isDev: false, argv: [EXE], hasSwitch: () => false }), null);
  assert.equal(refusedDebugSwitch({ isDev: true, argv: [EXE, '--remote-debugging-port=9222'], hasSwitch: () => true }), null);
});
