// web/evaluation/lesson-ledger-panel.js
// Lesson ledger - the outbound surface for <stateDir>/lessons/ledger.ndjson
// (GET /api/lessons), mounted inside the Capability Registry (Evolution
// pillar, View 2). Before this, the endpoint appeared nowhere in web/: a store
// nobody could see and nothing wrote to is indistinguishable from a store that
// does not exist, which is how it stayed frozen for a week without anyone
// noticing. See docs/adr/0001-learning-store-lesson-ledger-boundary.md.
//
// What this panel answers that the capability table above it cannot: the table
// lists PROPOSALS from the legacy learning queue. This lists the guards that
// actually landed, with the two facts only the ledger carries - where the
// lesson came from (provenance scope) and how much of it is left (strength,
// which decays on a per-scope half-life until the lesson goes dormant).
//
// The strength meter is the one piece of visual invention here, and it earns
// it: decay is the only continuous quantity anywhere in this pillar, and it is
// precisely the thing the proposals queue cannot express. Everything else
// reuses the registry's existing chips, buttons and row idiom, because a
// second visual language for one panel would be noise.
//
// It is a one-line STRIP at rest, not a panel, and that is a measured
// decision rather than a stylistic one. A headless render check against the
// real 52-row ledger showed the first cut (a full .an-panel band) taking 136px
// of the capability list's 186px - .rg-root is a fixed-height flex column
// whose only growing child is that list. At rest this now states what is live
// in one line and costs the list a fraction of that; the rows appear only when
// an operator asks for them, and shrinking the list is then their choice.
//
// XSS discipline: every server-derived string reaches the DOM via setText /
// createElement / setAttribute. innerHTML is not used; containers are emptied
// with clear().
import { setText } from '../shared/dom-util.js';
import { el, buildActionsWrap, buildButton, wireAction, fmtRelative } from './capability-row.js';
import { promoteLesson, revokeLesson } from '../shared/api.js';

export { renderLessonLedger, setLedgerExpanded };

/** Test seam: force the disclosure open or closed without a synthetic click. */
function setLedgerExpanded(next) { expanded = next === true; }

// Reflex-promoted first (those are live in CLAUDE.global.md right now), then
// active, dormant, invalidated. Within a group, most recently touched first.
// The order encodes blast radius, not alphabet: what is shaping behaviour now
// is what an operator needs to see without scrolling.
const STATUS_RANK = { active: 0, dormant: 1, invalidated: 2 };

// Disclosure state, module-level for the same reason registry.js keeps its
// filter state that way: every row action triggers a full re-render, and a
// panel that collapsed under the operator each time they clicked Revoke would
// be unusable. Collapsed by default because this view's height budget belongs
// to the capability list below - the counts strip alone already answers the
// question the ledger was invisible for ("is anything live, and how much").
let expanded = false;

function rankOf(lesson) {
  const promoted = lesson.promoted === true || lesson.reflex === true;
  return (promoted ? 0 : 1) * 10 + (STATUS_RANK[lesson.status] ?? 3);
}

function sortLessons(lessons) {
  return [...lessons].sort((a, b) => {
    const r = rankOf(a) - rankOf(b);
    if (r !== 0) return r;
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
  });
}

function statusChip(status) {
  const label = status ?? 'unknown';
  return el('span', `rg-ledger-chip rg-ledger-chip--${label}`, label);
}

function scopeChip(scope) {
  const label = scope ?? 'no scope';
  return el('span', `rg-ledger-scope rg-ledger-scope--${scope ?? 'none'}`, label);
}

// A thin horizontal meter: filled fraction = the lesson's remaining strength.
// aria-valuenow carries the same number for a screen reader, so the meter is
// not the only place the value exists.
function strengthMeter(strength) {
  const value = Number.isFinite(Number(strength)) ? Math.max(0, Math.min(1, Number(strength))) : 0;
  const wrap = el('div', 'rg-ledger-strength');
  wrap.setAttribute('role', 'meter');
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', '1');
  wrap.setAttribute('aria-valuenow', String(value));
  wrap.setAttribute('aria-label', `lesson strength ${Math.round(value * 100)} percent`);
  const bar = el('div', 'rg-ledger-strength-bar');
  bar.style.width = `${Math.round(value * 100)}%`;
  wrap.appendChild(bar);
  const num = el('span', 'rg-ledger-strength-num', value.toFixed(2));
  const host = el('div', 'rg-ledger-strength-host');
  host.appendChild(wrap);
  host.appendChild(num);
  return host;
}

function countsStrip(lessons, rerender) {
  const strip = el('div', 'rg-ledger-line');
  strip.appendChild(el('span', 'rg-ledger-label', 'Lesson ledger'));
  const counts_ = el('div', 'rg-ledger-counts');
  const promoted = lessons.filter((l) => l.promoted === true || l.reflex === true).length;
  const counts = [
    ['on the reflex layer', promoted],
    ['active', lessons.filter((l) => l.status === 'active').length],
    ['dormant', lessons.filter((l) => l.status === 'dormant').length],
    ['invalidated', lessons.filter((l) => l.status === 'invalidated').length],
  ];
  for (const [label, n] of counts) {
    const cell = el('div', 'rg-ledger-count');
    cell.appendChild(el('span', 'rg-ledger-count-val', String(n)));
    cell.appendChild(el('span', 'rg-ledger-count-label', label));
    counts_.appendChild(cell);
  }
  strip.appendChild(counts_);

  const toggle = el('button', 'rg-ledger-toggle', expanded ? 'Hide lessons' : `Show all ${lessons.length}`);
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.addEventListener('click', () => { expanded = !expanded; rerender(); });
  strip.appendChild(toggle);

  return strip;
}

function buildRow(lesson, rerender) {
  const promoted = lesson.promoted === true || lesson.reflex === true;
  const row = el('div', `rg-ledger-row${promoted ? ' rg-ledger-row--reflex' : ''}`);

  const nameWrap = el('div', 'rg-ledger-name-wrap');
  nameWrap.appendChild(el('div', 'rg-ledger-name', lesson.title || lesson.lessonId || '(untitled lesson)'));
  const meta = el('div', 'rg-ledger-meta');
  meta.appendChild(el('code', 'rg-ledger-id', lesson.lessonId ?? ''));
  const touchedTs = Date.parse(lesson.updatedAt ?? lesson.createdAt ?? '');
  if (Number.isFinite(touchedTs)) meta.appendChild(el('span', 'rg-ledger-touched', fmtRelative(touchedTs)));
  nameWrap.appendChild(meta);
  row.appendChild(nameWrap);

  const chips = el('div', 'rg-ledger-chips');
  chips.appendChild(scopeChip(lesson.scope));
  chips.appendChild(statusChip(lesson.status));
  if (promoted) chips.appendChild(el('span', 'rg-ledger-chip rg-ledger-chip--reflex', 'reflex'));
  row.appendChild(chips);

  row.appendChild(strengthMeter(lesson.strength));

  const host = el('div', 'rg-actions-host');
  const { wrap, status, buttons } = buildActionsWrap();
  // An invalidated lesson is not a candidate for anything: promoting it would
  // put a guard the revert sweep already disowned back on the reflex layer.
  if (lesson.status !== 'invalidated') {
    if (promoted) {
      const revoke = buildButton('Revoke', 'retire');
      buttons.push(revoke);
      wrap.appendChild(revoke);
      wireAction(revoke, buttons, status,
        () => revokeLesson(lesson.lessonId, { reason: 'revoked from the Capability Registry' }), rerender);
    } else {
      const promote = buildButton('Promote', 'approve');
      buttons.push(promote);
      wrap.appendChild(promote);
      wireAction(promote, buttons, status, () => promoteLesson(lesson.lessonId), rerender);
    }
  }
  if (!buttons.length) wrap.appendChild(el('span', 'rg-no-actions', 'no actions'));
  host.appendChild(wrap);
  host.appendChild(status);
  row.appendChild(host);

  return row;
}

/**
 * renderLessonLedger(container, data, rerender)
 *
 * `data` is GET /api/lessons's body ({ lessons, active, config }) or null when
 * the fetch failed. A failed fetch renders a stated empty, never a silent
 * absence: this panel exists because an invisible store went unnoticed.
 */
function renderLessonLedger(container, data, rerender) {
  if (!container) return;
  const panel = el('section', `rg-ledger-panel${expanded ? ' rg-ledger-panel--open' : ''}`);
  panel.setAttribute('aria-label', 'Lesson ledger');

  if (!data) {
    const line = el('div', 'rg-ledger-line');
    line.appendChild(el('span', 'rg-ledger-label', 'Lesson ledger'));
    line.appendChild(el('span', 'rg-ledger-unavailable',
      'unavailable, GET /api/lessons failed to respond.'));
    panel.appendChild(line);
    container.appendChild(panel);
    return;
  }

  const lessons = Array.isArray(data.lessons) ? data.lessons : [];
  if (!lessons.length) {
    const line = el('div', 'rg-ledger-line');
    line.appendChild(el('span', 'rg-ledger-label', 'Lesson ledger'));
    line.appendChild(el('span', 'rg-ledger-unavailable',
      'empty. A guard joins the ledger when it lands, so approve one below.'));
    panel.appendChild(line);
    container.appendChild(panel);
    return;
  }

  panel.appendChild(countsStrip(lessons, rerender));

  if (expanded) {
    // The explanation appears with the rows, not at rest: at rest the counts
    // are self-explanatory and the line has to stay one line.
    panel.appendChild(el('p', 'rg-ledger-sub',
      'Guards that actually landed, with their provenance. The list below holds proposals; this holds what is live.'));
    const scroll = el('div', 'rg-ledger-scroll');
    const list = el('div', 'rg-ledger-list');
    for (const lesson of sortLessons(lessons)) {
      if (!lesson || typeof lesson !== 'object' || !lesson.lessonId) continue;
      list.appendChild(buildRow(lesson, rerender));
    }
    scroll.appendChild(list);
    panel.appendChild(scroll);
  }

  container.appendChild(panel);
}
