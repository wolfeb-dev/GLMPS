// apps/shell/src/lib/layout.js
// Pure pane geometry for the shell window. No electron import: the root
// npm test runs this on every Node in the CI matrix.
export const SPLITTER_PX = 12;
export const MIN_PANE_PX = 320;
export const DEFAULT_RATIO = 0.62; // the dashboard's share of the usable width
export const NUDGE_STEP = 0.02;
export const SPLIT_PRESETS = Object.freeze({ 'split-50': 0.5, 'split-62': 0.62, 'split-75': 0.75 });

export function clampRatio(ratio, width, { splitterPx = SPLITTER_PX, minPanePx = MIN_PANE_PX } = {}) {
  const usable = width - splitterPx;
  if (usable < minPanePx * 2) return 0.5;
  const r = Number.isFinite(ratio) ? ratio : DEFAULT_RATIO;
  const lo = minPanePx / usable;
  return Math.min(1 - lo, Math.max(lo, r));
}

export function computeLayout({ width, height, ratio, slackVisible = true, swapped = false,
  splitterPx = SPLITTER_PX, minPanePx = MIN_PANE_PX }) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!slackVisible) {
    return { dashboard: { x: 0, y: 0, width: w, height: h }, slack: null, splitter: null, ratio: clampRatio(ratio, w, { splitterPx, minPanePx }) };
  }
  const r = clampRatio(ratio, w, { splitterPx, minPanePx });
  const usable = Math.max(0, w - splitterPx);
  const dashW = Math.round(usable * r);
  const leftW = swapped ? usable - dashW : dashW;
  const left = { x: 0, y: 0, width: leftW, height: h };
  const splitter = { x: leftW, y: 0, width: splitterPx, height: h };
  const right = { x: leftW + splitterPx, y: 0, width: usable - leftW, height: h };
  return swapped
    ? { dashboard: right, slack: left, splitter, ratio: r }
    : { dashboard: left, slack: right, splitter, ratio: r };
}

export function ratioFromPointer({ pointerX, width, swapped = false,
  splitterPx = SPLITTER_PX, minPanePx = MIN_PANE_PX }) {
  const usable = width - splitterPx;
  const leftShare = usable > 0 ? (pointerX - splitterPx / 2) / usable : 0.5;
  return clampRatio(swapped ? 1 - leftShare : leftShare, width, { splitterPx, minPanePx });
}

// Dashboard share at the divider's left or right extreme. The ratio is always
// the dashboard's share, so with the panes swapped Home (left edge) is the
// dashboard's maximum.
export function edgeRatio({ edge, width, swapped = false }) {
  const lo = clampRatio(0, width);
  const hi = clampRatio(1, width);
  const left = edge === 'home';
  return left !== swapped ? lo : hi;
}

export function nudgeRatio({ ratio, width, dir, swapped = false, step = NUDGE_STEP }) {
  const sign = (dir === 'left') !== swapped ? -1 : 1;
  return clampRatio(ratio + sign * step, width);
}

export function presetRatio(action, width) {
  return Object.hasOwn(SPLIT_PRESETS, action) ? clampRatio(SPLIT_PRESETS[action], width) : null;
}

// "left / right" as drawn on screen, not dashboard / Slack.
export function splitLabel({ ratio, swapped = false }) {
  const dash = Math.round(ratio * 100);
  return swapped ? `${100 - dash} / ${dash}` : `${dash} / ${100 - dash}`;
}
