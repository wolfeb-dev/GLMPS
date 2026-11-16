import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TERMINAL_ICON_ID, stripMcPrefix, terminalTabTitle } from '../../companion/src/terminal-icon.ts';
import { terminalName } from '../../companion/src/terminal-name.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('TERMINAL_ICON_ID matches the glmps-mark icon contributed in companion/package.json', () => {
  assert.equal(TERMINAL_ICON_ID, 'glmps-mark');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'companion', 'package.json'), 'utf8'));
  const icon = pkg?.contributes?.icons?.[TERMINAL_ICON_ID];
  assert.ok(icon, 'companion/package.json contributes glmps-mark icon');
  assert.equal(icon.default?.fontPath, './media/glmps-icons.woff');
});

test('stripMcPrefix removes leading mc: and mc prefixes while keeping the rest of the label', () => {
  assert.equal(stripMcPrefix('mc: claude'), 'claude');
  assert.equal(stripMcPrefix('mc: gemini'), 'gemini');
  assert.equal(stripMcPrefix('mc: gemini glmps-2-0-166'), 'gemini glmps-2-0-166');
  assert.equal(stripMcPrefix('mc terminal'), 'terminal');
  assert.equal(stripMcPrefix('MC: glmps-2-0-166'), 'glmps-2-0-166');
  assert.equal(stripMcPrefix('mc glmps-2-0-166'), 'glmps-2-0-166');
  assert.equal(stripMcPrefix('claude'), 'claude');
  assert.equal(stripMcPrefix('mc'), '');
});

test('terminalTabTitle strips the mc prefix from terminalName outputs for Antigravity tabs', () => {
  assert.equal(terminalTabTitle(terminalName({ name: 'mc: gemini glmps-2-0-166', command: 'node "x"' })), 'gemini glmps-2-0-166');
  assert.equal(terminalTabTitle(terminalName({ command: 'claude --session-id 1 "go"' })), 'claude');
  assert.equal(terminalTabTitle(terminalName({ name: 5, command: '' })), 'terminal');
  assert.equal(terminalTabTitle('mc'), 'terminal');
  assert.equal(terminalTabTitle(''), 'terminal');
});

test('companion/src/extension.ts attaches ThemeIcon(TERMINAL_ICON_ID) and terminalTabTitle to created terminals', () => {
  const ext = fs.readFileSync(path.join(ROOT, 'companion', 'src', 'extension.ts'), 'utf8');
  assert.match(ext, /from '\.\/terminal-icon'/);
  assert.match(ext, /new vscode\.ThemeIcon\(TERMINAL_ICON_ID\)/);
  assert.match(ext, /terminalTabTitle\(opts\.name\)/);
});
