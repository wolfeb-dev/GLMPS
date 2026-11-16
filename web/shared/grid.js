// web/shared/grid.js
// All DOM references are inside exported functions - safe to import in Node for syntax checks.
import { setText } from './dom-util.js';

const TOOL_BADGES = {
  'claude-code': 'CC', 'antigravity': 'AG', 'agy-cli': 'AG',
  'gemini-cli': 'GC', 'copilot-chat': 'CP', 'hermes': 'HE',
  'codex-cli': 'CX',
};

// Signature color per tool - maps to CSS class suffix for tool-chip-<color>
// and hex for inline border-left on rail entries.
const TOOL_COLOR = {
  'claude-code':   { cls: 'gold',   hex: '#d4a437' },
  'antigravity':   { cls: 'blue',   hex: '#4a8cd8' },
  'agy-cli':       { cls: 'blue',   hex: '#4a8cd8' },
  'gemini-cli':    { cls: 'green',  hex: '#3fb87f' },
  'copilot-chat':  { cls: 'purple', hex: '#a878d8' },
  'hermes':        { cls: 'amber',  hex: '#e0a23a' },
  'codex-cli':     { cls: 'red',    hex: '#e05656' },
};

function toolAccentHex(tool) {
  return TOOL_COLOR[tool]?.hex ?? '#252a32';
}

function toolColorClass(tool) {
  return TOOL_COLOR[tool]?.cls ?? 'muted';
}

function badgeText(tool) {
  if (TOOL_BADGES[tool]) return TOOL_BADGES[tool];
  return (tool || '').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

function makeBadgeFallback(tool) {
  const span = document.createElement('span');
  span.className = 'tool-badge';
  setText(span, badgeText(tool));
  return span;
}

function makeToolIcon(tool) {
  const img = document.createElement('img');
  img.src = `/api/icon/${tool}`;
  img.className = 'tool-icon';
  img.alt = badgeText(tool);
  img.width = 18;
  img.height = 18;
  img.addEventListener('error', () => {
    // Replace img with text badge fallback
    const badge = makeBadgeFallback(tool);
    img.replaceWith(badge);
  });
  return img;
}

export { TOOL_COLOR, toolAccentHex, toolColorClass, makeToolIcon, badgeText };
