// web/huddle/dock.js
// The huddle as a D-surface dock (DOCKS in web/shared/dock-list.js): one mount,
// one unmount. The dock itself is web/shared/huddle.js.
import { mountHuddle } from '../shared/huddle.js';
export function mount(rootEl) {
  const h = mountHuddle(rootEl);
  return { unmount() { h?.close?.(); } };
}
