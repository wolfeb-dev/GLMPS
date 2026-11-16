// web/evaluation/capability-row.js
// Shared row-rendering primitives for the Capability Registry (glmps-138
// Task 6): the small pieces every kind's row builder in registry.js reuses
// verbatim, the DOM element helper, kind/state chip builders, the relative-
// time + staleness formatter, and the generic "disable buttons, show
// Working.../Failed, re-render on success" action-wiring helper (byte-for-
// byte the same contract as skills.js's wireAdoptAction / research-
// candidates.js's buildActions inline wiring, lifted out once so
// registry.js's five kind builders don't each reimplement it).
//
// No I/O, no fetch, pure DOM construction + formatting. Importable under
// node:test with a stubbed `document` (no top-level DOM access).
//
// XSS discipline: every data-derived string here goes through `el`'s
// textContent assignment (setText). No innerHTML anywhere in this file.
import { setText } from '../shared/dom-util.js';
import { formatDate } from '../shared/time-format.js';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) setText(node, text);
  return node;
}

export const KIND_ORDER = ['instructions', 'guard', 'skill', 'agent', 'memory', 'cross-agent-memory', 'harness'];
// The operator-facing taxonomy: six kinds. Shared memory is a row kind of its
// own (it has its own actions) but reads as part of Memory and lessons.
export const CAPABILITY_KINDS = Object.freeze([
  { id: 'instructions', label: 'Instructions', rowKinds: ['instructions'] },
  { id: 'guards', label: 'Guards', rowKinds: ['guard'] },
  { id: 'skills', label: 'Skills', rowKinds: ['skill'] },
  { id: 'agents', label: 'Agents', rowKinds: ['agent'] },
  { id: 'memory', label: 'Memory and lessons', rowKinds: ['memory', 'cross-agent-memory'] },
  { id: 'harness', label: 'Harness code', rowKinds: ['harness'] },
]);
export const STATE_ORDER = ['proposed', 'active', 'deprecated', 'retired'];

const KIND_LABEL = {
  instructions: 'Instruction file',
  harness: 'Harness code',
  guard: 'Guard',
  skill: 'Skill',
  agent: 'Agent',
  memory: 'Memory',
  'cross-agent-memory': 'Shared memory',
};
export function kindLabel(kind) { return KIND_LABEL[kind] ?? kind ?? 'unknown'; }

const STATE_LABEL = {
  proposed: 'Proposed',
  active: 'Active',
  deprecated: 'Deprecated',
  retired: 'Retired',
};
export function stateLabel(state) { return STATE_LABEL[state] ?? state ?? 'unknown'; }

// Kind chip, a pill per row, tinted per kind (rg-kind-chip--<kind> in
// registry.css).
export function buildKindChip(kind) {
  return el('span', `rg-kind-chip rg-kind-chip--${kind}`, kindLabel(kind));
}

// State chip, the unified 4-state lifecycle, with the true native status
// appended when it adds information beyond the state name itself (e.g.
// "Proposed - trialing"), so an operator can always see exactly what the
// underlying store says, not just the collapsed bucket.
export function buildStateChip(state, subLabel) {
  const base = stateLabel(state);
  const extra = subLabel && subLabel.toLowerCase() !== state && subLabel.toLowerCase() !== base.toLowerCase()
    ? ` - ${subLabel}` : '';
  return el('span', `rg-state-chip rg-state-chip--${state}`, base + extra);
}

// Same 30/90-day thresholds as guard-retire.js's staleness() (glmps-138
// Task 4), reimplemented here rather than imported because that module
// lives under server/lib/ (not served to the browser by the static file
// server; a cross-boundary import would 404 client-side even though it
// resolves fine under node:test). Display-only: this never decides retire
// eligibility itself, it just informs the operator, the actual
// propose-retire candidate a row is showing (if any) already came from the
// server's own computation.
export const STALE_DAYS = 30;
export const RETIRE_DAYS = 90;
const MS_PER_DAY = 86400000;

export function fmtRelative(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 'never';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatDate(ts);
}

/**
 * @param {number|null} ts   epoch ms of last known use, or null/NaN for "never observed"
 * @param {number} [now]
 * @returns {{ label: string, className: string }}
 *   className is one of rg-stale--fresh|stale|old|unknown, for a text+color
 *   pairing (never color-only, per the color-only accessibility guideline).
 */
export function staleInfo(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return { label: 'never', className: 'rg-stale--unknown' };
  }
  const days = (now - ts) / MS_PER_DAY;
  const rel = fmtRelative(ts);
  if (days >= RETIRE_DAYS) return { label: `${rel} - stale`, className: 'rg-stale--old' };
  if (days >= STALE_DAYS) return { label: `${rel} - aging`, className: 'rg-stale--stale' };
  return { label: rel, className: 'rg-stale--fresh' };
}

// A fresh actions-row shell: caller adds buttons to `wrap` (pushing each
// into `buttons` so the whole group disables together), then appends
// `status` LAST (after every button), then wires each button via
// wireAction() below. Mirrors skills.js's wireAdoptAction / research-
// candidates.js's buildActions inline pattern exactly.
export function buildActionsWrap() {
  const wrap = el('div', 'rg-actions');
  const status = el('span', 'rg-row-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  return { wrap, status, buttons: [] };
}

export function buildButton(label, variant) {
  const btn = el('button', `rg-action-btn rg-action-btn--${variant}`, label);
  btn.type = 'button';
  return btn;
}

/**
 * Click-wires one action button: disables the whole sibling group while in
 * flight, shows "Working..." / "Failed, try again." inline (never a silent
 * no-op), and hands off to `onSuccess` (the caller's full re-render) only
 * once `run()` resolves. On failure the buttons re-enable so the operator
 * can retry, never left permanently disabled.
 */
export function wireAction(btn, siblingButtons, statusEl, run, onSuccess) {
  btn.addEventListener('click', async () => {
    siblingButtons.forEach((b) => { b.disabled = true; });
    statusEl.classList.remove('rg-row-status--error');
    setText(statusEl, 'Working...');
    try {
      await run();
      await onSuccess();
    } catch {
      siblingButtons.forEach((b) => { b.disabled = false; });
      statusEl.classList.add('rg-row-status--error');
      setText(statusEl, 'Failed, try again.');
    }
  });
}
