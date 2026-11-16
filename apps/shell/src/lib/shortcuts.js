// apps/shell/src/lib/shortcuts.js
// The shell reserves a few Ctrl+Alt chords; every other key reaches the page,
// so Slack's own shortcuts work as they do in a browser. The app menu is
// removed (main.js), so the split presets live here rather than in a menu.
const KEYS = Object.freeze({
  s: 'toggle-slack', r: 'reload-focused', x: 'swap-sides',
  1: 'split-50', 2: 'split-62', 3: 'split-75',
});

export const SHORTCUT_LABELS = Object.freeze({
  'toggle-slack': 'Ctrl+Alt+S',
  'reload-focused': 'Ctrl+Alt+R',
  'swap-sides': 'Ctrl+Alt+X',
  'split-50': 'Ctrl+Alt+1',
  'split-62': 'Ctrl+Alt+2',
  'split-75': 'Ctrl+Alt+3',
});

export function matchShortcut(input) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null;
  if (!input.control || !input.alt || input.shift || input.meta) return null;
  return KEYS[String(input.key).toLowerCase()] ?? null;
}
