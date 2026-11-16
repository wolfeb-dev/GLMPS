// server/lib/scut/toggle.js
// Bob-mode toggle: parse an intent from a slash-command arg or free text, apply
// it against an injected settings store, and return an Easter-egg-flavored
// message. Pure logic (persistence injected) so it is fully testable.

const MAGIC = /\bwe are (bob|legion)\b/i; // the hidden Easter-egg phrase

/** @returns {'on'|'off'|'toggle'|'status'|null} */
export function parseIntent(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (MAGIC.test(s)) return 'on';
  if (/^(on|enable|engage)$/.test(s)) return 'on';
  if (/^(off|disable|disengage)$/.test(s)) return 'off';
  if (/^status$/.test(s)) return 'status';
  if (s === '' || s === 'toggle') return 'toggle';
  return null;
}

/**
 * Apply an intent. deps: { getBobMode(), setBobMode(bool) }.
 * @returns {{ changed:boolean, bobMode:boolean, message:string }}
 */
export function applyToggle(intent, { getBobMode, setBobMode }) {
  const cur = !!getBobMode();
  let next = cur;
  if (intent === 'on') next = true;
  else if (intent === 'off') next = false;
  else if (intent === 'toggle') next = !cur;
  // 'status' (and null) leave it unchanged
  const changed = next !== cur;
  if (changed) setBobMode(next);
  return { changed, bobMode: next, message: message(intent, next, changed) };
}

function message(intent, bobMode, changed) {
  if (intent === 'status') return `Bob mode is ${bobMode ? 'ON' : 'OFF'}.`;
  if (!changed) return `Bob mode already ${bobMode ? 'ON' : 'OFF'}.`;
  return bobMode
    ? 'We are Bob. We are legion. :rocket:'
    : 'Bob mode disengaged. Back to business.';
}
