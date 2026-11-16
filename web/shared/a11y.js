// web/shared/a11y.js
// Keyboard/ARIA affordance for clickable non-button elements (glmps-52).
// A card/row built as a <div> with a click handler is invisible to keyboard
// and AT users; this gives it button semantics: role, tab stop, Enter/Space
// activation, and an optional accessible name. Buttons/links never need this.

/**
 * Make a clickable element keyboard-activatable with button semantics.
 * Attach the click handler separately (this only adds the keyboard/ARIA layer),
 * or pass `onActivate` to wire both key activation and click in one call.
 * @param {HTMLElement} el
 * @param {(ev: Event) => void} [onActivate] - also bound to click when given
 * @param {string} [label] - accessible name (aria-label) for the element
 */
export function interactive(el, onActivate, label) {
  el.setAttribute('role', 'button');
  if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    if (onActivate) onActivate(ev);
    else el.click();
  });
  if (onActivate) el.addEventListener('click', onActivate);
}
