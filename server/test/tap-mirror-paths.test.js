// server/test/tap-mirror-paths.test.js
// The file mirror's path rules (server-and-client-tap task 10): the fixed root
// table, confinement of every mirror path under the client's mirror dir, the
// server-side path set a client's poll runs on, and session id namespacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths } from '../lib/paths.js';
import {
  validateMirrorPath, resolveMirrorFile, mirrorRoots, rootIdOfFile, serverPathsFor,
  clientMirrorDir, namespaceSessionId, splitNamespacedId, validClientId,
} from '../lib/kernel/tap-mirror.js';

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tapmirror-')); tmpDirs.push(d); return d; };

test('validateMirrorPath accepts a known root with plain relative segments', () => {
  for (const p of ['claude/projects/D--x/abc.jsonl', 'claude/.claude-manager/active-sessions.json', 'antigravity-0/brain/u/.system_generated/logs/transcript.jsonl',
    'vscode-3/ws/chatSessions/s.json', 'gemini-tmp/h/chats/session.json', 'agy-cli/conversations/c.db', 'opencode/x.db', 'codex/sessions/2026/10/rollout-a.jsonl',
    'copilot-cli/session-state/u/events.jsonl', 'hermes/state.db']) {
    assert.equal(validateMirrorPath(p), null, p);
  }
});

test('validateMirrorPath refuses an unknown root, and a bare root', () => {
  for (const p of ['etc/passwd', 'claudex/a', 'antigravity/a', 'antigravity-x/a', 'antigravity-100/a', 'Claude/a', 'claude', 'hermes/', '']) {
    assert.notEqual(validateMirrorPath(p), null, JSON.stringify(p));
  }
});

test('validateMirrorPath refuses dot segments, empty segments, backslashes, colons and UNC or leading slashes', () => {
  const bad = ['claude/../x', 'claude/./x', 'claude/..', 'claude/.', 'claude//x', 'claude/x/', 'claude\\x', 'claude/a\\b', 'claude/C:/x', 'claude/a:b', 'C:/x',
    '/claude/x', '//server/share/x', '\\\\server\\share\\x', 'claude/x/../../y'];
  for (const p of bad) assert.notEqual(validateMirrorPath(p), null, JSON.stringify(p));
});

test('validateMirrorPath refuses NUL and control characters, and non-strings', () => {
  for (const p of ['claude/a\0b', 'claude/a\nb', 'claude/a\tb', 'claude/a\x1fb', 'claude/a\x7fb']) assert.notEqual(validateMirrorPath(p), null, JSON.stringify(p));
  for (const p of [undefined, null, 5, {}, ['claude/x']]) assert.notEqual(validateMirrorPath(p), null);
});

test('validateMirrorPath refuses Windows reserved device names, with or without an extension', () => {
  for (const n of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.txt', 'NUL.jsonl', 'aux.tar.gz']) {
    assert.notEqual(validateMirrorPath(`claude/projects/${n}`), null, n);
  }
  assert.equal(validateMirrorPath('claude/projects/console.jsonl'), null, 'a name that merely starts with a device name is fine');
  assert.equal(validateMirrorPath('claude/projects/COM10.jsonl'), null, 'only COM1 to COM9 are devices');
});

test('validateMirrorPath refuses a segment that ends in a dot or a space, and Windows-invalid characters', () => {
  for (const p of ['claude/a.', 'claude/a ', 'claude/a./b', 'claude/a /b', 'claude/a<b', 'claude/a>b', 'claude/a"b', 'claude/a|b', 'claude/a?b', 'claude/a*b']) {
    assert.notEqual(validateMirrorPath(p), null, JSON.stringify(p));
  }
});

test('validateMirrorPath caps segment and path length', () => {
  assert.notEqual(validateMirrorPath(`claude/${'a'.repeat(256)}`), null);
  assert.equal(validateMirrorPath(`claude/${'a'.repeat(255)}`), null);
  assert.notEqual(validateMirrorPath(`claude/${Array(200).fill('abcdefgh').join('/')}`), null);
});

test('resolveMirrorFile joins under the mirror dir and refuses anything that resolves outside it', () => {
  const mirror = path.join(tmp(), 'mirror');
  assert.equal(resolveMirrorFile(mirror, 'claude/projects/a/b.jsonl'), path.join(mirror, 'claude', 'projects', 'a', 'b.jsonl'));
  assert.throws(() => resolveMirrorFile(mirror, 'claude/../../x'), /refused/);
  assert.throws(() => resolveMirrorFile(mirror, 'nope/x'), /refused/);
});

test('resolveMirrorFile refuses a path through a symlink that leaves the mirror', (t) => {
  const root = tmp();
  const mirror = path.join(root, 'mirror');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(mirror, 'claude'), { recursive: true });
  fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(mirror, 'claude', 'link'), 'junction'); } catch (e) { t.skip(`cannot create a symlink or junction here: ${e.code}`); return; }
  assert.throws(() => resolveMirrorFile(mirror, 'claude/link/x.jsonl'), /refused/);
});

test('mirrorRoots names the getPaths fields of the spec table, by index for the list fields', () => {
  const base = tmp();
  const P = getPaths({ GLMPS_CLAUDE_DIR: path.join(base, 'c'), GLMPS_ANTIGRAVITY_DIR: path.join(base, 'ag'), GLMPS_STATE_DIR: path.join(base, 's'),
    GLMPS_VSCODE_STORAGE_DIR: path.join(base, 'vs'), GLMPS_GEMINI_TMP_DIR: path.join(base, 'g'), GLMPS_AGY_CLI_DIR: path.join(base, 'agy'),
    GLMPS_OPENCODE_DIR: path.join(base, 'oc'), GLMPS_CODEX_DIR: path.join(base, 'cx'), GLMPS_COPILOT_CLI_DIR: path.join(base, 'cp'), GLMPS_HERMES_DIR: path.join(base, 'h') });
  const roots = Object.fromEntries(mirrorRoots(P).map((r) => [r.id, r.dir]));
  assert.deepEqual(roots, {
    claude: P.claudeDir, 'antigravity-0': P.antigravityDirs[0], 'vscode-0': P.vscodeStorageDirs[0], 'gemini-tmp': P.geminiTmpDir,
    'agy-cli': P.agyCliDir, opencode: P.opencodeDir, codex: P.codexDir, 'copilot-cli': P.copilotCliDir, hermes: P.hermesDir,
  });
});

test('rootIdOfFile maps a file to <rootId>/<rel> with forward slashes, and null outside every root', () => {
  const base = tmp();
  const roots = [{ id: 'claude', dir: path.join(base, 'c') }, { id: 'codex', dir: path.join(base, 'cx') }];
  assert.equal(rootIdOfFile(roots, path.join(base, 'c', 'projects', 'a', 'b.jsonl')), 'claude/projects/a/b.jsonl');
  assert.equal(rootIdOfFile(roots, path.join(base, 'cx', 'sessions', 'r.jsonl')), 'codex/sessions/r.jsonl');
  assert.equal(rootIdOfFile(roots, path.join(base, 'elsewhere', 'r.jsonl')), null);
  assert.equal(rootIdOfFile(roots, path.join(base, 'c')), null, 'the root itself is not a file');
  assert.equal(rootIdOfFile(roots, path.join(base, 'c-other', 'x')), null, 'a sibling that shares a prefix is not inside');
});

test('serverPathsFor points every mirrored field at the mirror and every other data field at a path that does not exist', () => {
  const base = tmp();
  const P = getPaths({ GLMPS_CLAUDE_DIR: path.join(base, 'real-claude'), GLMPS_STATE_DIR: path.join(base, 'real-state'), GLMPS_ANTIGRAVITY_DIR: path.join(base, 'real-ag') });
  fs.mkdirSync(P.stateDir, { recursive: true });
  const mirror = path.join(base, 'real-state', 'clients', 'cli_0123456789abcdef', 'mirror');
  fs.mkdirSync(path.join(mirror, 'antigravity-0'), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'antigravity-1'), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'vscode-0'), { recursive: true });
  const C = serverPathsFor(P, mirror);
  assert.equal(C.claudeDir, path.join(mirror, 'claude'));
  assert.equal(C.projectsDir, path.join(mirror, 'claude', 'projects'));
  assert.equal(C.activeSessionsFile, path.join(mirror, 'claude', '.claude-manager', 'active-sessions.json'));
  assert.deepEqual(C.antigravityDirs, [path.join(mirror, 'antigravity-0'), path.join(mirror, 'antigravity-1')]);
  assert.deepEqual(C.vscodeStorageDirs, [path.join(mirror, 'vscode-0')]);
  for (const [field, id] of [['geminiTmpDir', 'gemini-tmp'], ['agyCliDir', 'agy-cli'], ['opencodeDir', 'opencode'], ['codexDir', 'codex'], ['copilotCliDir', 'copilot-cli'], ['hermesDir', 'hermes']]) {
    assert.equal(C[field], path.join(mirror, id), field);
  }
  const inside = (p) => { const rel = path.relative(mirror, p); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  for (const [k, v] of Object.entries(C)) {
    for (const s of Array.isArray(v) ? v : [v]) if (typeof s === 'string') assert.ok(inside(s), `${k} = ${s} is outside the mirror`);
  }
  for (const f of ['stateDir', 'copilotOtelDir', 'credentialsFile', 'settingsFile', 'statusDir', 'memoryDir', 'worktreesDir', 'offsetsFile']) {
    assert.equal(fs.existsSync(C[f]), false, `${f} must not exist`);
  }
  assert.notEqual(C.stateDir, P.stateDir);
});

test('serverPathsFor gives a single mirror dir for the list fields when the client has not shipped any', () => {
  const base = tmp();
  const P = getPaths({ GLMPS_CLAUDE_DIR: path.join(base, 'c'), GLMPS_STATE_DIR: path.join(base, 's') });
  const mirror = path.join(base, 'm');
  const C = serverPathsFor(P, mirror);
  assert.deepEqual(C.antigravityDirs, [path.join(mirror, 'antigravity-0')]);
  assert.deepEqual(C.vscodeStorageDirs, [path.join(mirror, 'vscode-0')]);
});

test('clientMirrorDir is <stateDir>/clients/<clientId>/mirror and refuses an unsafe client id', () => {
  const base = tmp();
  assert.equal(clientMirrorDir(base, 'cli_0123456789abcdef'), path.join(base, 'clients', 'cli_0123456789abcdef', 'mirror'));
  for (const bad of ['', '..', 'a/b', 'a\\b', 'cli_x:y', 'a b', undefined]) assert.throws(() => clientMirrorDir(base, bad), /client id/);
  assert.equal(validClientId('cli_0123456789abcdef'), true);
  assert.equal(validClientId('../x'), false);
});

test('session ids are namespaced <clientId>:<sessionId> and split back on the first colon', () => {
  assert.equal(namespaceSessionId('cli_0123456789abcdef', 'sess-1'), 'cli_0123456789abcdef:sess-1');
  assert.deepEqual(splitNamespacedId('cli_0123456789abcdef:copilot-cli:abc'), { clientId: 'cli_0123456789abcdef', sessionId: 'copilot-cli:abc' });
  assert.equal(splitNamespacedId('plain-local-id'), null);
});
