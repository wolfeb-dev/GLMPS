// web/observability/session-verdicts.js
// Draws three fields /api/state?session= already returns as verdicts instead
// of feed rows: done-gate results, the loop stage and the workspace bounds
// (session-detail spec section 8 item 4). Kept apart from detail.js so the
// page rebuild can move them into its header and bands unchanged.
import { setText } from '../shared/dom-util.js';

const GATE_WORD = {
  pass: ['PASS', 'ok'],
  block: ['BLOCKED', 'danger'],
  yield: ['YIELDED', 'warn'],
  skipped: ['SKIPPED', 'warn'],
  unapproved: ['UNAPPROVED', 'warn'],
};
const COUNTED = new Set(['pass', 'block', 'yield']);

const STAGES = [
  { key: 'orchestrate', short: 'orch', hue: 'orch' },
  { key: 'execute', short: 'exec', hue: 'exec' },
  { key: 'adversarial', short: 'adv', hue: 'adv' },
  { key: 'gate', short: 'gate', hue: 'gate' },
  { key: 'learning', short: 'learn', hue: 'learn' },
];

const DIVERGENCE_TONE = { none: 'ok', low: 'warn', high: 'danger' };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) setText(n, text);
  return n;
}

// Latest result decides the word; the count is passes over runs that executed
// the commands (skipped and unapproved never ran them).
export function doneGateVerdict(events) {
  const gates = (events ?? []).filter(e => e?.kind === 'done-gate' && GATE_WORD[e.result]);
  if (!gates.length) return null;
  const latest = gates.reduce((a, b) => ((b.ts ?? 0) >= (a.ts ?? 0) ? b : a));
  const [word, tone] = GATE_WORD[latest.result];
  const run = gates.filter(e => COUNTED.has(e.result)).length;
  const passed = gates.filter(e => e.result === 'pass').length;
  const detail = (latest.result === 'block' || latest.result === 'yield') && latest.failedCommand
    ? `${latest.failedCommand} failed` : null;
  return { word, tone, passed, run, detail };
}

export function buildDoneGateSlot(events) {
  const slot = el('span', 'verdict-slot verdict-done-gate');
  slot.appendChild(el('span', 'verdict-label', 'DONE-GATE'));
  const v = doneGateVerdict(events);
  if (!v) {
    slot.appendChild(el('span', 'verdict-word tone-neutral', 'no done-gate run'));
    return slot;
  }
  slot.appendChild(el('span', `verdict-word tone-${v.tone}`, v.word));
  if (v.run) slot.appendChild(el('span', 'verdict-count', `${v.passed}/${v.run} passed`));
  if (v.detail) slot.appendChild(el('span', 'verdict-detail', v.detail));
  return slot;
}

function fmtElapsed(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under 1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function buildStageTrace(loop, now = Date.now()) {
  const wrap = el('div', 'stage-trace');
  if (!loop || !Number.isInteger(loop.stage)) {
    wrap.appendChild(el('span', 'stage-trace-empty', 'No loop stage: no events captured for this session.'));
    return wrap;
  }
  const row = el('ol', 'stage-trace-row');
  row.setAttribute('aria-label', 'Loop stage');
  STAGES.forEach((s, i) => {
    const n = i + 1;
    const pos = n < loop.stage ? 'is-past' : n === loop.stage ? 'is-current' : 'is-future';
    const li = el('li', `stage-seg stage-${s.hue} ${pos}`, s.short);
    if (n === loop.stage) li.setAttribute('aria-current', 'step');
    row.appendChild(li);
  });
  wrap.appendChild(row);
  const cur = STAGES[loop.stage - 1];
  const parts = [`${(cur?.key ?? 'unknown').toUpperCase()} ${loop.status ?? ''}`.trim()];
  if (loop.detail) parts.push(loop.detail);
  if (loop.agent) parts.push(`agent ${loop.agent}`);
  if (Number.isFinite(loop.enteredTs) && now >= loop.enteredTs) parts.push(`${fmtElapsed(now - loop.enteredTs)} in stage`);
  wrap.appendChild(el('span', 'stage-trace-detail', parts.join(' | ')));
  return wrap;
}

export function buildBounds(workspace) {
  const wrap = el('div', 'session-bounds');
  if (!workspace) {
    wrap.appendChild(el('span', 'bounds-empty', 'No workspace snapshot: declared versus observed is not recorded for this session.'));
    return wrap;
  }
  const declared = el('div', 'bounds-row');
  declared.appendChild(el('span', 'bounds-label', 'declared'));
  const goal = workspace.declared?.goal;
  declared.appendChild(el('span', goal ? 'bounds-value' : 'bounds-value bounds-none', goal || 'no goal recorded'));
  wrap.appendChild(declared);

  const observed = el('div', 'bounds-row');
  observed.appendChild(el('span', 'bounds-label', 'observed'));
  const paths = workspace.observed?.activePaths ?? [];
  const zone = workspace.observed?.zone;
  if (!workspace.observed) {
    observed.appendChild(el('span', 'bounds-value bounds-none', 'nothing observed yet'));
  } else {
    // Basenames, three at most: the full paths are in the title and the Files list.
    const names = paths.map((p) => String(p).replace(/\\/g, '/').split('/').pop());
    const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
    const value = el('span', 'bounds-value bounds-paths', paths.length ? shown : 'no edits');
    if (paths.length) value.title = paths.join('\n');
    observed.appendChild(value);
    if (zone) observed.appendChild(el('span', 'bounds-zone', `zone ${zone}`));
  }
  wrap.appendChild(observed);

  const div = el('div', 'bounds-row');
  div.appendChild(el('span', 'bounds-label', 'divergence'));
  const level = workspace.divergence?.level;
  if (!level) {
    div.appendChild(el('span', 'verdict-word tone-neutral', 'not assessed'));
  } else {
    div.appendChild(el('span', `verdict-word tone-${DIVERGENCE_TONE[level] ?? 'neutral'}`, level.toUpperCase()));
    const reasons = workspace.divergence.reasons ?? [];
    if (reasons.length) div.appendChild(el('span', 'bounds-reason', reasons.join('; ')));
  }
  wrap.appendChild(div);
  return wrap;
}
