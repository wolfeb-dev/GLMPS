// server/test/web-launch-toast.test.js
// the toast-text decision for Resume, the "Open
// workspace" button and the topbar "New terminal" launcher, pulled out as
// pure functions so a failure (or a cwd fallback) picks the right copy
// without needing a DOM harness for history.js/launcher.js themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeToast, workspaceToast } from '../../web/observability/history.js';
import { launchToast, launchableFolders } from '../../web/shared/launcher.js';
import { postTerminal } from '../../web/shared/api.js';

test('resumeToast: success names the terminal; a cwd fallback names the effective dir', () => {
  assert.equal(resumeToast({ launched: true, cwd: '/a' }), 'Resume opened in a new terminal');
  assert.equal(
    resumeToast({ launched: true, cwd: '/fallback', cwdFallback: true }),
    "Resume opened in /fallback: the session's folder no longer exists",
  );
});

test('resumeToast: a failure shows the server\'s own error text, not the success copy', () => {
  assert.equal(resumeToast(null, new Error('sessionId must be a session UUID')), 'sessionId must be a session UUID');
  assert.equal(resumeToast(null, new Error()), 'Resume failed');
  assert.equal(resumeToast(null, undefined), 'Resume failed');
});

test('workspaceToast: success vs a failure\'s own error text', () => {
  assert.equal(workspaceToast({ opened: true, cwd: '/a' }), 'Opening workspace in Antigravity (conversation resume not supported)');
  assert.equal(workspaceToast(null, new Error('antigravityCommand not configured')), 'antigravityCommand not configured');
  assert.equal(workspaceToast(null, new Error()), 'Resume failed');
});

// Pre-step (a) of Task 12b: a requested cwd the server could not use must
// read differently from an ordinary success, same as resumeToast's own
// cwdFallback branch.
test('workspaceToast: a cwd fallback names the effective dir actually opened', () => {
  assert.equal(
    workspaceToast({ opened: true, cwd: '/fallback', cwdFallback: true }),
    "Opened workspace in /fallback: the session's folder no longer exists",
  );
});

test('launchToast: 200 opens, anything else fails, and neither copy uses an em-dash', () => {
  assert.equal(launchToast(200), 'Terminal opened');
  assert.equal(launchToast(400), 'Launch failed: check the folder');
});

// Fix round 1, m6: a service-mode kernel answers launched: 'queued' instead
// of opening anything - the three launch-starting toasts must name that
// distinct state rather than claiming an ordinary "opened" success.
test('resumeToast: a service-mode "queued" response names that state, not an ordinary success', () => {
  assert.equal(resumeToast({ launched: 'queued', pid: null, cwd: '/a', launchId: 'ln_1' }), 'Queued: the desktop shell will open it');
});

// workspaceToast's own 'queued' branch was removed -
// the workspace route never queues through the broker (it calls
// spawnEditorApp directly, never launchNative); a service-mode kernel now
// refuses it outright with a named 409, which the ordinary error branch
// already covers.
test('workspaceToast: a service-mode refusal shows the server\'s own error text, not a "queued" copy', () => {
  assert.equal(workspaceToast(null, new Error('service mode cannot open a desktop app from session 0')), 'service mode cannot open a desktop app from session 0');
});

test('launchToast: a service-mode "queued" response names that state, not an ordinary success', () => {
  assert.equal(launchToast(200, { launched: 'queued', pid: null, cwd: '/a', launchId: 'ln_1' }), 'Queued: the desktop shell will open it');
  assert.equal(launchToast(200, { launched: true, pid: 42, cwd: '/a' }), 'Terminal opened');
});

test('launchToast: a refusal that names its reason shows that text, not the generic copy', () => {
  const error = 'cwd refused: cwd is not inside a configured project root (add it to launchRoots in config.json)';
  assert.equal(launchToast(403, { error }), error);
  assert.equal(launchToast(403, {}), 'Launch failed: check the folder');
  assert.equal(launchToast(500, { error: '' }), 'Launch failed: check the folder');
});

test('postTerminal: a refusal throws the server\'s own error text', async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'cwd refused: add it to launchRoots' }) });
    await assert.rejects(postTerminal({ terminal: 'Claude', cwd: '/x' }), /cwd refused: add it to launchRoots/);
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    await assert.rejects(postTerminal({ terminal: 'Claude', cwd: '/x' }), /terminal failed/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ launched: true }) });
    assert.deepEqual(await postTerminal({ terminal: 'Claude', cwd: '/x' }), { launched: true });
  } finally { globalThis.fetch = orig; }
});

test('launchableFolders: omits roots the server says it would refuse; fails open when the server does not say', () => {
  assert.deepEqual(launchableFolders({ projectRoots: ['/a', '/b'], launchableRoots: ['/b'] }), ['/b']);
  assert.deepEqual(launchableFolders({ projectRoots: ['/a', '/b'] }), ['/a', '/b']);
  assert.deepEqual(launchableFolders({}), []);
});

// glmps-2-0-30: a session the Antigravity companion opens names Antigravity,
// not a terminal window that never appeared.
test('an Antigravity-hosted launch names Antigravity in both toasts', () => {
  assert.equal(launchToast(200, { launched: 'antigravity', pid: null, cwd: '/a', launchId: null }), 'Opened in Antigravity');
  assert.equal(resumeToast({ launched: 'antigravity', pid: null, cwd: '/a', launchId: null }), 'Resume opened in Antigravity');
});

test('a launch queued for a paired client names that client, not the desktop shell', () => {
  const body = { launched: 'queued', pid: null, cwd: 'C:/w', launchId: 'ln_1', client: 'cli_a', clientName: 'alpha-box' };
  assert.equal(launchToast(200, body), 'Queued: alpha-box will open it');
  assert.equal(resumeToast(body), 'Queued: alpha-box will open it');
  assert.equal(launchToast(200, { ...body, clientName: undefined }), 'Queued: cli_a will open it');
  assert.equal(workspaceToast({ opened: 'queued', launchId: 'ln_2', client: 'cli_a', clientName: 'alpha-box' }), 'Queued: alpha-box will open the workspace');
});
