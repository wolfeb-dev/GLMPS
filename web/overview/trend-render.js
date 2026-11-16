// web/overview/trend-render.js
// The DOM half of the 2h vitals trend: the Fleet board tiles' delta chip (the
// sparkline left with the retired Surface Pulse panel). The arithmetic lives
// in stage-board-calc.js. All text goes through textContent.
import { setText } from '../shared/dom-util.js';

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

// Delta chip: sign + magnitude + a direction arrow (never colour alone), a
// "flat" mark when unchanged, or nothing without a baseline. Built once per
// tile and updated in place so its footprint is reserved and the value line
// never reflows when it appears.
export function buildDeltaChip() {
  const wrap = el('span', 'sb-vt-delta sb-vt-delta--empty');
  wrap.setAttribute('aria-hidden', 'true');
  const arrow = el('span', 'sb-vt-delta-arrow');
  const num = el('span', 'sb-vt-delta-num');
  wrap.appendChild(arrow);
  wrap.appendChild(num);
  return { wrap, arrow, num };
}

export function setDeltaChip(chip, rawDelta, warnOnUp) {
  const { wrap, arrow, num } = chip;
  wrap.classList.remove('sb-vt-delta--up', 'sb-vt-delta--down', 'sb-vt-delta--flat', 'sb-vt-delta--warn');
  if (rawDelta == null) {
    wrap.classList.add('sb-vt-delta--empty');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.removeAttribute('aria-label');
    setText(arrow, '');
    setText(num, '');
    return;
  }
  // Round before the zero-check: a 0.4pp budget move reads as "flat" at this
  // display resolution rather than a misleading "+0".
  const delta = Math.round(rawDelta);
  wrap.classList.remove('sb-vt-delta--empty');
  wrap.removeAttribute('aria-hidden');
  if (delta === 0) {
    wrap.classList.add('sb-vt-delta--flat');
    setText(arrow, '\u2192');
    setText(num, 'flat');
    wrap.setAttribute('aria-label', 'flat versus an hour ago');
    return;
  }
  const up = delta > 0;
  wrap.classList.add(up ? 'sb-vt-delta--up' : 'sb-vt-delta--down');
  if (warnOnUp && up) wrap.classList.add('sb-vt-delta--warn');
  setText(arrow, up ? '\u25B2' : '\u25BC');
  setText(num, `${up ? '+' : '-'}${Math.abs(delta)}`);
  wrap.setAttribute('aria-label', `${up ? 'up' : 'down'} ${Math.abs(delta)} versus an hour ago`);
}
