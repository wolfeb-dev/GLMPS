import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildState, STEP_ORDER, normalizeProgress, markCompleted, markSkipped, readProgress, writeProgress, progressFile } from '../src/lib/setup/plan.js';

const dep = (name, action = 'ok', required = false, installed = '1.0') => ({ name, required, installed: action === 'install' ? null : installed, latest: null, update: null, action, command: null });

const row = (id, label, installed, companion) => ({ id, label, installed, companion });

const FRESH = {
  deps: [dep('node', 'ok', true), dep('git', 'install', true), dep('graphify', 'install'), dep('claude', 'install'), dep('gh', 'install')],
  claude: { installed: false, signedIn: false },
  github: { installed: false, signedIn: false, scopes: [], missingScopes: [] },
  slack: { saved: false }, hooks: { installed: false }, profile: { path: 'P', exists: false },
  editors: [row('vscode', 'VS Code', true, false), row('cursor', 'Cursor', false, false), row('antigravity', 'Antigravity', true, true), row('native-terminal', 'Native terminal', true, false)],
  editorPick: { lastTarget: null, openTarget: null },
};
const READY = {
  deps: ['node', 'git', 'graphify', 'claude', 'gh'].map((n) => dep(n, 'ok', n === 'node' || n === 'git')),
  claude: { installed: true, signedIn: true },
  github: { installed: true, signedIn: true, scopes: ['repo', 'workflow', 'read:org'], missingScopes: [] },
  slack: { saved: true, live: { ok: true, error: null } }, hooks: { installed: true }, profile: { path: 'P', exists: true },
  editors: FRESH.editors, editorPick: { lastTarget: 'antigravity', openTarget: 'antigravity' },
};
const step = (state, id) => state.steps.find((s) => s.id === id);
const ids = (s) => s.actions.map((a) => a.id);

test('the steps come in the contract order with the contract shape', () => {
  const s = buildState({ status: FRESH, progress: null });
  assert.deepEqual(s.steps.map((x) => x.id), ['welcome', 'deps', 'claude', 'github', 'slack', 'ide', 'editor', 'repos', 'health']);
  assert.deepEqual(STEP_ORDER, s.steps.map((x) => x.id));
  assert.deepEqual(Object.keys(s).sort(), ['busy', 'complete', 'currentId', 'launchAtLogin', 'steps']);
  for (const x of s.steps) {
    assert.deepEqual(['todo', 'running', 'ok', 'warn', 'failed', 'skipped'].includes(x.status), true, x.id);
    for (const k of ['title', 'summary', 'detail']) assert.equal(typeof x[k], 'string');
    for (const a of x.actions) assert.deepEqual(Object.keys(a).filter((k) => !['id', 'label', 'primary', 'needs'].includes(k)), []);
  }
});

test('a fresh machine starts at welcome, nothing complete', () => {
  const s = buildState({ status: FRESH, progress: null });
  assert.equal(s.currentId, 'welcome');
  assert.equal(s.complete, false);
  assert.equal(s.launchAtLogin, true);
});

test('deps: missing tools list as items, install is primary, a missing required tool is todo', () => {
  const d = step(buildState({ status: FRESH, progress: null }), 'deps');
  assert.equal(d.status, 'todo');
  assert.deepEqual(d.items.map((i) => [i.name, i.status]), [['Node.js', 'ok'], ['Git', 'failed'], ['graphify', 'warn'], ['Claude Code', 'warn'], ['GitHub CLI', 'warn']]);
  assert.deepEqual(d.actions.filter((a) => a.primary).map((a) => a.id), ['install-missing']);
  assert.deepEqual(ids(d), ['install-missing', 'install-git', 'install-graphify', 'install-claude', 'install-gh', 'recheck', 'skip']);
  assert.deepEqual(d.items.map((i) => i.id), ['node', 'git', 'graphify', 'claude', 'gh']);
  assert.deepEqual(d.actions.find((a) => a.id === 'skip'), { id: 'skip', label: 'Skip', primary: false });
});

test('deps: only optional tools missing is warn; outdated offers update; all ok offers continue', () => {
  const warn = step(buildState({ status: { ...READY, deps: [dep('node', 'ok', true), dep('git', 'ok', true), dep('graphify', 'install')] }, progress: null }), 'deps');
  assert.equal(warn.status, 'warn');
  const upd = step(buildState({ status: { ...READY, deps: [dep('node', 'ok', true), { ...dep('git', 'update-available', true), latest: '9' }] }, progress: null }), 'deps');
  assert.deepEqual(ids(upd), ['update-all', 'update-git', 'recheck', 'skip']);
  assert.equal(upd.items[1].detail, '1.0, update available (9)');
  const ok = step(buildState({ status: READY, progress: null }), 'deps');
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ids(ok), ['recheck', 'skip']);
});

test('claude: not installed offers no sign-in; installed but signed out offers it; signed in is ok', () => {
  assert.deepEqual(ids(step(buildState({ status: FRESH, progress: null }), 'claude')), ['recheck', 'skip']);
  const out = step(buildState({ status: { ...READY, claude: { installed: true, signedIn: false } }, progress: null }), 'claude');
  assert.deepEqual(ids(out), ['sign-in', 'recheck', 'skip']);
  assert.equal(out.actions[0].primary, true);
  assert.equal(step(buildState({ status: READY, progress: null }), 'claude').status, 'ok');
});

test('github: sign-in when signed out, refresh-scopes (warn) when a scope is missing, ok when complete', () => {
  const signedOut = step(buildState({ status: { ...READY, github: { installed: true, signedIn: false, scopes: [], missingScopes: [] } }, progress: null }), 'github');
  assert.deepEqual(ids(signedOut), ['sign-in', 'recheck', 'skip']);
  const scopes = step(buildState({ status: { ...READY, github: { installed: true, signedIn: true, scopes: ['repo'], missingScopes: ['workflow', 'read:org'] } }, progress: null }), 'github');
  assert.equal(scopes.status, 'warn');
  assert.match(scopes.detail, /workflow, read:org/);
  assert.deepEqual(ids(scopes), ['refresh-scopes', 'recheck', 'skip']);
  assert.equal(step(buildState({ status: READY, progress: null }), 'github').status, 'ok');
});

test('slack: connect names the inputs the renderer collects', () => {
  const s = step(buildState({ status: FRESH, progress: null }), 'slack');
  assert.deepEqual(s.actions[0], { id: 'connect', label: 'Connect Slack', primary: true, needs: ['botToken', 'appToken', 'email', 'memberId'] });
  const saved = step(buildState({ status: READY, progress: null }), 'slack');
  assert.equal(saved.status, 'ok');
  assert.equal(saved.actions[0].primary, false);
});

test('ide and repos actions', () => {
  assert.deepEqual(ids(step(buildState({ status: FRESH, progress: null }), 'ide')), ['install-hooks', 'skip']);
  const repos = step(buildState({ status: FRESH, progress: null }), 'repos');
  assert.deepEqual(repos.actions[0], { id: 'scan', label: 'Find my repositories', primary: true, needs: ['folder', 'engagement'] });
  assert.equal(step(buildState({ status: READY, progress: null }), 'repos').detail, 'P');
});

test('health: every check is an item; a missing required tool fails it, optional gaps warn', () => {
  assert.equal(step(buildState({ status: READY, progress: null }), 'health').status, 'ok');
  assert.equal(step(buildState({ status: FRESH, progress: null }), 'health').status, 'failed');
  const warn = step(buildState({ status: { ...READY, slack: { saved: false } }, progress: null }), 'health');
  assert.equal(warn.status, 'warn');
  assert.equal(warn.items.length, 7);
  assert.deepEqual(ids(warn), ['recheck']);
});

test('currentId is the first step that is not ok, warn or skipped; complete needs every step before health settled', () => {
  const welcomed = markCompleted(null, 'welcome');
  assert.equal(buildState({ status: FRESH, progress: welcomed }).currentId, 'deps');
  assert.equal(step(buildState({ status: FRESH, progress: welcomed }), 'welcome').status, 'ok');
  // deps skipped, claude and github not done
  const p = markSkipped(welcomed, 'deps');
  assert.equal(step(buildState({ status: FRESH, progress: p }), 'deps').status, 'skipped');
  assert.equal(buildState({ status: FRESH, progress: p }).currentId, 'claude');
  // a step that becomes ok by itself is passed over
  const mid = { ...FRESH, claude: { installed: true, signedIn: true } };
  assert.equal(buildState({ status: mid, progress: p }).currentId, 'github');
  const almost = buildState({ status: { ...READY, profile: { path: 'P', exists: false } }, progress: welcomed });
  assert.equal(almost.currentId, 'repos');
  assert.equal(almost.complete, false);
  const done = buildState({ status: { ...READY, profile: { path: 'P', exists: false } }, progress: markSkipped(welcomed, 'repos') });
  assert.equal(done.currentId, 'health');
  assert.equal(done.complete, true);
});

test('a skipped step that is actually ok stays ok, and completing it clears the skip', () => {
  const p = markSkipped(null, 'claude');
  assert.equal(step(buildState({ status: READY, progress: p }), 'claude').status, 'ok');
  assert.deepEqual(markCompleted(p, 'claude'), { completed: ['claude'], skipped: [] });
});

test('running and the last action result shape the step', () => {
  const s = buildState({ status: FRESH, progress: null, busy: true, running: 'deps', results: { github: { ok: false, message: 'cancelled' } } });
  assert.equal(s.busy, true);
  assert.equal(step(s, 'deps').status, 'running');
  assert.equal(step(s, 'deps').actions[0].id, 'install-missing');
  const g = step(s, 'github');
  assert.equal(g.status, 'failed');
  assert.equal(g.detail, 'cancelled');
});

test('unreadable input degrades instead of throwing', () => {
  const s = buildState({ status: null, progress: 'junk' });
  assert.equal(s.steps.length, 9);
  assert.deepEqual(normalizeProgress({ completed: ['deps', 'nope', 'deps'], skipped: ['deps', 'ide'] }), { completed: ['deps'], skipped: ['ide'] });
});

test('progress record round-trips through a file, and a missing or corrupt one is a fresh start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glmps-progress-'));
  try {
    const file = progressFile(dir);
    assert.equal(path.basename(file), 'setup-progress.json');
    assert.deepEqual(readProgress({ file }), { completed: [], skipped: [] });
    writeProgress({ file, progress: { completed: ['welcome'], skipped: ['ide'] } });
    assert.deepEqual(readProgress({ file }), { completed: ['welcome'], skipped: ['ide'] });
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readProgress({ file }), { completed: [], skipped: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Card glmps-2-0-205: saved is not connected. Only tokens Slack accepted live read OK.
test('slack: saved tokens Slack rejected send the operator back to connect; health names the code', () => {
  const rejected = { ...READY, slack: { saved: true, live: { ok: false, error: 'app_token:invalid_auth' } } };
  const s = step(buildState({ status: rejected, progress: null }), 'slack');
  assert.equal(s.status, 'todo');
  assert.equal(s.actions[0].primary, true);
  assert.match(s.detail, /app_token:invalid_auth/);
  const row = step(buildState({ status: rejected, progress: null }), 'health').items.find((i) => i.name === 'Slack');
  assert.deepEqual(row, { name: 'Slack', status: 'warn', detail: 'Slack rejected the saved tokens (app_token:invalid_auth)' });
});

test('health: saved tokens not yet checked live are a warning, not OK', () => {
  const unchecked = { ...READY, slack: { saved: true } };
  const row = step(buildState({ status: unchecked, progress: null }), 'health').items.find((i) => i.name === 'Slack');
  assert.deepEqual(row, { name: 'Slack', status: 'warn', detail: 'Tokens saved, not checked with Slack yet' });
  const ok = step(buildState({ status: READY, progress: null }), 'health').items.find((i) => i.name === 'Slack');
  assert.deepEqual(ok, { name: 'Slack', status: 'ok', detail: 'Connected' });
});

test('slack: an unreachable Slack leaves saved tokens OK on the step and says so on the Ready check', () => {
  const offline = { ...READY, slack: { saved: true, live: { ok: false, error: 'unreachable', unreachable: true } } };
  assert.equal(step(buildState({ status: offline, progress: null }), 'slack').status, 'ok');
  const row = step(buildState({ status: offline, progress: null }), 'health').items.find((i) => i.name === 'Slack');
  assert.deepEqual(row, { name: 'Slack', status: 'warn', detail: 'Tokens saved, Slack could not be reached to check them' });
});

test('editor: no pick yet offers every installed target, none for an IDE that is not installed', () => {
  const e = step(buildState({ status: FRESH, progress: null }), 'editor');
  assert.equal(e.title, 'Default IDE');
  assert.equal(e.status, 'todo');
  assert.deepEqual(ids(e), ['choose-vscode', 'choose-antigravity', 'choose-native-terminal', 'recheck', 'skip']);
  assert.deepEqual(e.items.map((i) => [i.name, i.status, i.detail]), [
    ['VS Code', 'warn', 'Installed, GLMPS extension not installed'],
    ['Cursor', 'warn', 'Not installed'],
    ['Antigravity', 'ok', 'Installed, GLMPS extension ready'],
    ['Native terminal', 'ok', 'Always available'],
  ]);
});

test('editor: ok when the pick is the native terminal, or an installed IDE with the companion', () => {
  const pick = (t) => step(buildState({ status: { ...READY, editorPick: { lastTarget: t, openTarget: t } }, progress: null }), 'editor');
  assert.equal(pick('native-terminal').status, 'ok');
  assert.equal(pick('antigravity').status, 'ok');
  assert.match(pick('antigravity').items.find((i) => i.name === 'Antigravity').detail, /default/);
});

test('editor: an IDE picked without the companion is todo and offers to install it; an uninstalled pick is todo too', () => {
  const vs = step(buildState({ status: { ...READY, editorPick: { lastTarget: 'vscode', openTarget: 'vscode' } }, progress: null }), 'editor');
  assert.equal(vs.status, 'todo');
  assert.deepEqual(vs.actions[0], { id: 'install-companion', label: 'Install the GLMPS extension into VS Code', primary: true });
  const gone = step(buildState({ status: { ...READY, editorPick: { lastTarget: 'cursor', openTarget: 'cursor' } }, progress: null }), 'editor');
  assert.equal(gone.status, 'todo');
  assert.match(gone.detail, /Cursor is not installed/);
  assert.equal(gone.actions.some((a) => a.id === 'install-companion'), false);
});

test('editor: a kernel that does not report editors is passed over, not blocking', () => {
  const { editors: _e, editorPick: _p, ...old } = READY;
  const e = step(buildState({ status: old, progress: null }), 'editor');
  assert.equal(e.status, 'warn');
  assert.deepEqual(ids(e), ['recheck', 'skip']);
});

test('editor: the Ready check has a Default IDE row', () => {
  const rowOf = (status) => step(buildState({ status, progress: null }), 'health').items.find((i) => i.name === 'Default IDE');
  assert.deepEqual(rowOf(READY), { name: 'Default IDE', status: 'ok', detail: 'Antigravity' });
  assert.deepEqual(rowOf(FRESH), { name: 'Default IDE', status: 'warn', detail: 'Not chosen' });
  assert.deepEqual(rowOf({ ...READY, editorPick: { lastTarget: 'vscode', openTarget: 'vscode' } }), { name: 'Default IDE', status: 'warn', detail: 'VS Code, GLMPS extension not installed' });
});
