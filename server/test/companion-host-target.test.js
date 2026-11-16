import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostTarget, requestsFileName } from '../../companion/src/host-target.ts';

test('the host app maps to one target id, by URI scheme first', () => {
  assert.equal(hostTarget({ uriScheme: 'vscode', appName: 'Visual Studio Code' }), 'vscode');
  assert.equal(hostTarget({ uriScheme: 'vscode-insiders', appName: 'Visual Studio Code - Insiders' }), 'vscode-insiders');
  assert.equal(hostTarget({ uriScheme: 'cursor', appName: 'Cursor' }), 'cursor');
  assert.equal(hostTarget({ uriScheme: 'windsurf', appName: 'Windsurf' }), 'windsurf');
  assert.equal(hostTarget({ uriScheme: 'antigravity', appName: 'Antigravity IDE' }), 'antigravity');
  assert.equal(hostTarget({ uriScheme: 'antigravity-ide', appName: 'Antigravity IDE' }), 'antigravity');
});

test('an unfamiliar scheme falls back to the app name, and an unknown host to null', () => {
  assert.equal(hostTarget({ uriScheme: 'x-ide', appName: 'Antigravity IDE' }), 'antigravity');
  assert.equal(hostTarget({ uriScheme: '', appName: 'Visual Studio Code - Insiders' }), 'vscode-insiders');
  assert.equal(hostTarget({ uriScheme: '', appName: 'Visual Studio Code' }), 'vscode');
  assert.equal(hostTarget({ uriScheme: 'vscodium', appName: 'VSCodium' }), null);
  assert.equal(hostTarget({}), null);
  assert.equal(hostTarget({ uriScheme: 5, appName: null }), null);
});

test('each host drains its own file; antigravity keeps the file older companions use', () => {
  assert.equal(requestsFileName('antigravity'), 'resume.jsonl');
  assert.equal(requestsFileName('vscode'), 'resume.vscode.jsonl');
  assert.equal(requestsFileName('vscode-insiders'), 'resume.vscode-insiders.jsonl');
  assert.equal(requestsFileName('cursor'), 'resume.cursor.jsonl');
  assert.equal(requestsFileName('windsurf'), 'resume.windsurf.jsonl');
});

test('the companion and the server agree on every file name', async () => {
  const { IDE_TARGETS, companionFileName } = await import('../lib/orchestration/editor-targets.js');
  for (const t of IDE_TARGETS) assert.equal(requestsFileName(t), companionFileName(t));
});
