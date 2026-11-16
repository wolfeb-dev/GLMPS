// apps/shell/test/shortcuts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchShortcut } from '../src/lib/shortcuts.js';

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, control: true, alt: true, shift: false, meta: false, isAutoRepeat: false, ...mods });

test('the three shell shortcuts', () => {
  assert.equal(matchShortcut(key('s')), 'toggle-slack');
  assert.equal(matchShortcut(key('S')), 'toggle-slack');
  assert.equal(matchShortcut(key('r')), 'reload-focused');
  assert.equal(matchShortcut(key('x')), 'swap-sides');
});

test('anything else passes through to the page (Slack keeps its own shortcuts)', () => {
  assert.equal(matchShortcut(key('k')), null);
  assert.equal(matchShortcut(key('s', { alt: false })), null);          // Ctrl+S
  assert.equal(matchShortcut(key('s', { shift: true })), null);         // Ctrl+Alt+Shift+S
  assert.equal(matchShortcut(key('r', { control: false })), null);      // Alt+R
  assert.equal(matchShortcut(key('s', { type: 'keyUp' })), null);
  assert.equal(matchShortcut(key('s', { isAutoRepeat: true })), null);
  assert.equal(matchShortcut(null), null);
});

test('Ctrl+Alt+1/2/3 are the 50/62/75 split presets', () => {
  assert.equal(matchShortcut(key('1')), 'split-50');
  assert.equal(matchShortcut(key('2')), 'split-62');
  assert.equal(matchShortcut(key('3')), 'split-75');
  assert.equal(matchShortcut(key('4')), null);
  assert.equal(matchShortcut(key('1', { alt: false })), null);
});

test('every shortcut action has a label', async () => {
  const { SHORTCUT_LABELS } = await import('../src/lib/shortcuts.js');
  for (const a of ['toggle-slack', 'reload-focused', 'swap-sides', 'split-50', 'split-62', 'split-75']) assert.ok(SHORTCUT_LABELS[a], a);
});
