// Tests for the setup health report (server/lib/chassis/setup-status.js).
// Every probe is injected: no real claude, gh, winget or disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupStatus, parseGhScopes, REQUIRED_GH_SCOPES } from '../lib/chassis/setup-status.js';

const ok = (stdout = '', stderr = '') => ({ status: 0, stdout, stderr });
const fail = (status = 1, stderr = '') => ({ status, stdout: '', stderr });

function run(table) {
  return (argv) => {
    const key = argv.join(' ');
    for (const [prefix, res] of Object.entries(table)) if (key.startsWith(prefix)) return typeof res === 'function' ? res(argv) : res;
    return fail(127);
  };
}

const ALL_PRESENT = {
  'node --version': ok('v22.5.0'), 'git --version': ok('git version 2.5.0'), 'graphify --version': ok('1.0.0'),
  'claude --version': ok('2.1.0'), 'gh --version': ok('gh version 2.5'),
};

const base = (over = {}) => ({
  run: run({ ...ALL_PRESENT, 'claude auth status': ok('{"loggedIn":true}'), 'gh auth status': ok("Logged in\n  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'") }),
  latest: {},
  loadCreds: () => ({ botToken: 'xoxb-a', appToken: 'xapp-b', signingSecret: null }),
  exists: () => true,
  readFile: () => JSON.stringify({ entries: [{ id: 'x' }], added: [] }),
  hooksRecordFile: 'H', profilePath: 'P',
  ...over,
});

test('a fully set up machine reports everything ok', () => {
  const s = buildSetupStatus(base());
  assert.ok(s.deps.every((d) => d.action === 'ok'));
  assert.deepEqual(s.claude, { installed: true, signedIn: true });
  assert.deepEqual(s.github, { installed: true, signedIn: true, scopes: ['gist', 'read:org', 'repo', 'workflow'], missingScopes: [] });
  assert.deepEqual(s.slack, { saved: true });
  assert.deepEqual(s.hooks, { installed: true });
  assert.deepEqual(s.profile, { path: 'P', exists: true });
});

test('a fresh machine reports nothing installed and nothing signed in', () => {
  const s = buildSetupStatus(base({
    run: run({}), loadCreds: () => ({ botToken: null, appToken: null, signingSecret: null }),
    exists: () => false, readFile: () => { throw new Error('ENOENT'); },
  }));
  assert.deepEqual(s.claude, { installed: false, signedIn: false });
  assert.deepEqual(s.github, { installed: false, signedIn: false, scopes: [], missingScopes: [] });
  assert.equal(s.slack.saved, false);
  assert.equal(s.hooks.installed, false);
  assert.equal(s.profile.exists, false);
  assert.equal(s.deps.find((d) => d.name === 'git').action, 'install');
});

test('claude auth status: the JSON loggedIn wins, a non-JSON answer falls back to the exit code', () => {
  const via = (res) => buildSetupStatus(base({ run: run({ ...ALL_PRESENT, 'claude auth status': res }) })).claude.signedIn;
  assert.equal(via(ok('{"loggedIn":false}')), false);
  assert.equal(via(ok('{"loggedIn":true}')), true);
  assert.equal(via(ok('Logged in as someone')), true);
  assert.equal(via(fail(1)), false);
});

test('a claude that is not installed is never reported signed in, and auth is not probed', () => {
  let probed = false;
  const s = buildSetupStatus(base({ run: run({ ...ALL_PRESENT, 'claude --version': fail(127), 'claude auth status': () => { probed = true; return ok('{"loggedIn":true}'); } }) }));
  assert.deepEqual(s.claude, { installed: false, signedIn: false });
  assert.equal(probed, false);
});

test('gh scopes are parsed (quoted or bare, stdout or stderr) and the missing ones named', () => {
  assert.deepEqual(parseGhScopes("  - Token scopes: 'gist', 'repo'"), ['gist', 'repo']);
  assert.deepEqual(parseGhScopes('Token scopes: gist, repo'), ['gist', 'repo']);
  assert.equal(parseGhScopes('no scopes here'), null);
  const s = buildSetupStatus(base({ run: run({ ...ALL_PRESENT, 'gh auth status': ok('', "Logged in\n  - Token scopes: 'repo'") }) }));
  assert.deepEqual(s.github.scopes, ['repo']);
  assert.deepEqual(s.github.missingScopes, ['workflow', 'read:org']);
  assert.deepEqual(REQUIRED_GH_SCOPES, ['repo', 'workflow', 'read:org']);
});

test('gh signed in with no scopes line cannot be evaluated, so nothing is reported missing', () => {
  const s = buildSetupStatus(base({ run: run({ ...ALL_PRESENT, 'gh auth status': ok('Logged in via GH_TOKEN') }) }));
  assert.deepEqual(s.github, { installed: true, signedIn: true, scopes: [], missingScopes: [] });
});

test('outdated tools are planned for update from the injected latest versions', () => {
  const s = buildSetupStatus(base({ latest: { git: '9.0.0' } }));
  assert.equal(s.deps.find((d) => d.name === 'git').action, 'update-available');
});

test('hooks: a record with no entries, an unreadable one and a corrupt one all read as not installed', () => {
  for (const readFile of [() => JSON.stringify({ entries: [], added: [] }), () => 'not json', () => { throw new Error('x'); }]) {
    assert.equal(buildSetupStatus(base({ readFile })).hooks.installed, false);
  }
  assert.equal(buildSetupStatus(base({ readFile: () => JSON.stringify({ added: [{ id: 'a' }] }) })).hooks.installed, true);
});

test('a probe that throws degrades that section only', () => {
  const s = buildSetupStatus(base({ loadCreds: () => { throw new Error('boom'); } }));
  assert.equal(s.slack.saved, false);
  assert.equal(s.claude.installed, true);
});

// Card glmps-2-0-205: the live check of the saved tokens rides along, codes only.
test('a live Slack check is reported next to saved; an absent one is left out', () => {
  assert.deepEqual(buildSetupStatus(base({ slackLive: { ok: true } })).slack, { saved: true, live: { ok: true, error: null } });
  assert.deepEqual(buildSetupStatus(base({ slackLive: { ok: false, error: 'app_token:invalid_auth', team: 'x' } })).slack,
    { saved: true, live: { ok: false, error: 'app_token:invalid_auth' } });
  assert.deepEqual(buildSetupStatus(base({ slackLive: null })).slack, { saved: true });
});

test('an unreachable live check is carried as unreachable', () => {
  assert.deepEqual(buildSetupStatus(base({ slackLive: { ok: false, error: 'unreachable', unreachable: true } })).slack,
    { saved: true, live: { ok: false, error: 'unreachable', unreachable: true } });
});

// glmps-2-0-218: the Default IDE step reads which IDEs are installed, whether
// each has the companion, and the saved pick.
test('editors: all six targets with install and companion state, and the saved pick', () => {
  const s = buildSetupStatus(base({
    home: 'C:/h', programFiles: [],
    editorExists: (p) => /Antigravity IDE|Microsoft VS Code[\\/]bin/.test(p),
    readdir: (d) => (/antigravity-ide/.test(d) ? ['glmps.glmps-companion-0.1.3'] : []),
    runnerConfig: { lastTarget: 'vscode', openTarget: 'antigravity' },
  }));
  assert.deepEqual(s.editors.map((e) => e.id), ['vscode', 'vscode-insiders', 'cursor', 'windsurf', 'antigravity', 'native-terminal']);
  const by = Object.fromEntries(s.editors.map((e) => [e.id, e]));
  assert.deepEqual(by.antigravity, { id: 'antigravity', label: 'Antigravity', installed: true, companion: true });
  assert.deepEqual(by.vscode, { id: 'vscode', label: 'VS Code', installed: true, companion: false });
  assert.deepEqual(by.cursor, { id: 'cursor', label: 'Cursor', installed: false, companion: false });
  assert.deepEqual(by['native-terminal'], { id: 'native-terminal', label: 'Native terminal', installed: true, companion: false });
  assert.deepEqual(s.editorPick, { lastTarget: 'vscode', openTarget: 'antigravity' });
});

test('editors: no home or config reads as nothing installed and no pick, never throws', () => {
  const s = buildSetupStatus(base({ readdir: () => { throw new Error('x'); } }));
  assert.equal(s.editors.filter((e) => e.installed).map((e) => e.id).join(), 'native-terminal');
  assert.deepEqual(s.editorPick, { lastTarget: null, openTarget: null });
});
