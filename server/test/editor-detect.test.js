import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveEditor, editorCommand, companionInstalled, quoteCommand, EDITOR_ORDER } from '../lib/orchestration/editor-detect.js';

const HOME = 'C:\\Users\\op';
const w = path.win32.join;
const PROG = (rel) => w(HOME, 'AppData', 'Local', 'Programs', rel);
const PATHS = {
  antigravity: PROG('Antigravity IDE\\bin\\antigravity-ide.cmd'),
  vscode: PROG('Microsoft VS Code\\bin\\code.cmd'),
  'vscode-insiders': PROG('Microsoft VS Code Insiders\\bin\\code-insiders.cmd'),
  cursor: PROG('cursor\\resources\\app\\bin\\cursor.cmd'),
  windsurf: PROG('Windsurf\\bin\\windsurf.cmd'),
};
const installed = (...ids) => {
  const set = new Set(ids.map((i) => PATHS[i].toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
};
const base = { home: HOME, programFiles: [] };

test('fallback order is antigravity, vscode, vscode-insiders, cursor, windsurf', () => {
  assert.deepEqual(EDITOR_ORDER, ['antigravity', 'vscode', 'vscode-insiders', 'cursor', 'windsurf']);
});

test('the picker target wins when that IDE is installed', () => {
  const r = resolveEditor({ ...base, lastTarget: 'cursor', exists: installed('antigravity', 'cursor') });
  assert.equal(r.id, 'cursor');
  assert.equal(r.command, PATHS.cursor);
});

test('native-terminal picker falls back to the first installed in order', () => {
  const r = resolveEditor({ ...base, lastTarget: 'native-terminal', exists: installed('windsurf', 'vscode') });
  assert.equal(r.id, 'vscode');
  assert.equal(r.command, PATHS.vscode);
});

test('a picker naming an uninstalled IDE falls back in order', () => {
  const r = resolveEditor({ ...base, lastTarget: 'cursor', exists: installed('vscode-insiders', 'windsurf') });
  assert.equal(r.id, 'vscode-insiders');
});

test('no picker value: antigravity first when installed', () => {
  const r = resolveEditor({ ...base, lastTarget: null, exists: installed('vscode', 'antigravity') });
  assert.equal(r.id, 'antigravity');
});

test('nothing installed resolves to null', () => {
  assert.equal(resolveEditor({ ...base, lastTarget: 'vscode', exists: () => false }), null);
});

test('Program Files system installs are found', () => {
  const pf = 'C:\\Program Files';
  const sys = w(pf, 'Microsoft VS Code', 'bin', 'code.cmd');
  const r = resolveEditor({ home: HOME, programFiles: [pf], lastTarget: null, exists: (p) => p === sys });
  assert.equal(r.id, 'vscode');
  assert.equal(r.command, sys);
});

test('quoteCommand wraps only a command containing a space', () => {
  assert.equal(quoteCommand('code'), 'code');
  assert.equal(quoteCommand('C:\\a b\\code.cmd'), '"C:\\a b\\code.cmd"');
});

test('quoteCommand leaves a command with a double quote alone so it cannot be broken out of', () => {
  assert.equal(quoteCommand('C:\\a b\\"x'), 'C:\\a b\\"x');
});

test('editorCommand names the install path of exactly one IDE, null when absent', () => {
  assert.equal(editorCommand('vscode', { ...base, exists: installed('antigravity', 'vscode') }), PATHS.vscode);
  assert.equal(editorCommand('cursor', { ...base, exists: installed('antigravity', 'vscode') }), null);
  assert.equal(editorCommand('native-terminal', { ...base, exists: () => true }), null);
  assert.equal(editorCommand('vscode', { ...base, exists: () => { throw new Error('boom'); } }), null);
});

test('companionInstalled finds the GLMPS extension folder in that IDE own extensions dir', () => {
  const seen = [];
  const readdir = (dir) => {
    seen.push(dir);
    if (/\.antigravity-ide[\\/]extensions$/.test(dir)) return ['ms-python.python-1.0.0', 'glmps.glmps-companion-0.1.2'];
    if (/\.vscode[\\/]extensions$/.test(dir)) return ['ms-python.python-1.0.0'];
    throw new Error('ENOENT');
  };
  assert.equal(companionInstalled('antigravity', { home: HOME, readdir }), true);
  assert.equal(companionInstalled('vscode', { home: HOME, readdir }), false);
  assert.equal(companionInstalled('cursor', { home: HOME, readdir }), false, 'a missing dir reads as not installed');
  assert.equal(companionInstalled('native-terminal', { home: HOME, readdir }), false);
  assert.equal(companionInstalled('vscode', { home: null, readdir }), false);
  assert.ok(seen.every((d) => d.startsWith(HOME)), 'only ever looks under the given home');
});
