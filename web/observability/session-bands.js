// web/observability/session-bands.js
// The session page's header and its Touching and Learning bands, drawn from
// session-model.js (card glmps-2-0-runtime-60). The Doing band's rows and
// paging live in detail.js with the event row they reuse.
import { setText } from '../shared/dom-util.js';
import { interactive } from '../shared/a11y.js';
import { buildDoneGateSlot, buildBounds } from './session-verdicts.js';
import {
  verdictSlots, costStrip, groupFiles, learningLedger, learningSummaryText, touchingSummaryText,
} from './session-model.js';

export function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) setText(n, text);
  return n;
}

const PREF_KEY = 'glmps.session.bands';

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') ?? {}; } catch { return {}; }
}
export function readPref(key) { return readPrefs()[key]; }
export function writePref(key, value) {
  try { const p = readPrefs(); p[key] = value; localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage full or blocked: the page still works */ }
}

export function isPhone() {
  try { return !!globalThis.matchMedia?.('(max-width: 560px)').matches; } catch { return false; }
}

// The page opening or closing a band (phone default, no-log page, an anchor)
// is not the viewer's choice, so its toggle event is not persisted.
export function setBandOpen(band, open) {
  if (band.det.open === open) return;
  band.det._auto = true;
  band.det.open = open;
}

// A band is a <details> so it collapses to its summary line; the open state
// persists per viewer, and on a phone every band starts collapsed.
export function buildBand(id, title, summaryText) {
  const sec = el('section', `session-band session-band-${id}`);
  sec.id = id;
  const det = el('details', 'session-band-details');
  const saved = readPref(`open.${id}`);
  setBandOpen({ det }, isPhone() ? false : saved !== false);
  const sum = el('summary', 'session-band-summary');
  const h = el('h2', 'session-band-title', title);
  h.id = `${id}-title`;
  sum.appendChild(h);
  const line = el('span', 'session-band-line', summaryText);
  sum.appendChild(line);
  det.appendChild(sum);
  const body = el('div', 'session-band-body');
  det.appendChild(body);
  det.addEventListener('toggle', () => {
    if (det._auto) { det._auto = false; return; }
    if (!isPhone()) writePref(`open.${id}`, det.open);
  });
  sec.setAttribute('aria-labelledby', h.id);
  sec.appendChild(det);
  return { sec, det, body, line };
}

function slotEl(s) {
  const slot = el('span', `verdict-slot verdict-${s.id}`);
  slot.appendChild(el('span', 'verdict-label', s.label));
  const word = el(s.url ? 'a' : 'span', `verdict-word tone-${s.tone}`, s.word);
  if (s.url) { word.href = s.url; word.target = '_blank'; word.rel = 'noopener'; }
  slot.appendChild(word);
  if (s.detail) slot.appendChild(el('span', 'verdict-detail', s.detail));
  if (s.comment) slot.title = s.comment;
  return slot;
}

export function buildVerdictStrip(data, stateKey, approvals, gateEvents) {
  const strip = el('div', 'sp-verdicts');
  strip.setAttribute('aria-label', 'Verdicts');
  const [gate, judge, pr, appr] = verdictSlots(data, stateKey, approvals);
  strip.appendChild(slotEl(gate));
  strip.appendChild(slotEl(judge));
  const dg = buildDoneGateSlot(gateEvents);
  strip.appendChild(dg);
  strip.appendChild(slotEl(pr));
  strip.appendChild(slotEl(appr));
  return { strip, doneGate: dg };
}

export function buildCostStrip(summary, data, stateKey) {
  const strip = el('div', 'sp-cost');
  strip.setAttribute('aria-label', 'Cost');
  for (const c of costStrip(summary, data, stateKey)) {
    const cell = el('span', `sp-cost-cell${c.missing ? ' is-missing' : ''}`);
    cell.appendChild(el('span', 'verdict-label', c.label));
    cell.appendChild(el('span', 'sp-cost-value', c.value));
    strip.appendChild(cell);
  }
  if (stateKey === 'idle') strip.appendChild(el('span', 'sp-cost-note', 'as of last event'));
  return strip;
}

function diffToggle(f, handlers) {
  const b = el('button', 'diff-toggle', 'diff \u25B8');
  b.type = 'button';
  b.addEventListener('click', (e) => { e.stopPropagation(); handlers.onDiff?.(b, f); });
  return b;
}

function fileRow(f, handlers) {
  const row = el('div', 'sp-file-row sp-row');
  row.tabIndex = -1;
  const op = el('span', f.writes ? 'op-write' : 'op-read', f.writes ? 'wr' : 'rd');
  op.title = f.writes ? `${f.writes} write${f.writes === 1 ? '' : 's'}` : `${f.reads} read${f.reads === 1 ? '' : 's'}`;
  row.appendChild(op);
  const edits = el('span', 'event-edits');
  if (f.writes) {
    edits.appendChild(el('span', 'ev-add', `+${f.add ?? 0}`));
    edits.appendChild(el('span', 'ev-del', `-${f.del ?? 0}`));
  }
  row.appendChild(edits);
  const name = el('span', 'sp-file-name clickable', f.name);
  name.title = f.path;
  if (handlers.onOpenFile) interactive(name, () => handlers.onOpenFile(f.path), `Open file: ${f.path}`);
  row.appendChild(name);
  const tail = el('span', 'sp-row-tail');
  if (f.change) tail.appendChild(diffToggle(f, handlers));
  row.appendChild(tail);
  return row;
}

export function buildTouching(data, handlers, root, sessionId) {
  const band = buildBand('touching', 'Touching', touchingSummaryText(data));
  const { body } = band;
  const touch = data?.touch;
  const groups = groupFiles(touch?.files ?? [], root);

  const files = el('div', 'sp-block sp-files');
  files.appendChild(el('h3', 'sp-block-title', 'Files'));
  if (!touch) files.appendChild(el('p', 'band-error', 'Could not load files: the server returned no touch rollup. Reload to retry.'));
  else if (!groups.length) files.appendChild(el('p', 'band-empty', 'No file reads or writes recorded.'));
  for (const g of groups) {
    const det = el('details', 'sp-dir');
    det.open = g.writes > 0 && groups.length <= 6;
    const sum = el('summary', 'sp-dir-row sp-row');
    sum.appendChild(el('span', 'sp-dir-name', g.dir));
    const count = `${g.files.length} file${g.files.length === 1 ? '' : 's'}`;
    sum.appendChild(el('span', 'sp-dir-count', g.writes ? `${count}  +${g.add} -${g.del}` : `${count}  read only`));
    det.appendChild(sum);
    for (const f of g.files) det.appendChild(fileRow(f, handlers));
    files.appendChild(det);
  }
  body.appendChild(files);

  const commits = el('div', 'sp-block sp-commits');
  commits.appendChild(el('h3', 'sp-block-title', 'Commits'));
  const list = touch?.commits ?? [];
  const rev = data?.outcome?.revertedLater;
  if (!list.length) commits.appendChild(el('p', 'band-empty', 'No commits recorded.'));
  for (const c of list) {
    const row = el('div', 'sp-commit-row sp-row');
    row.tabIndex = -1;
    const img = el('img', 'evt-icon');
    img.src = '/icons/git-commit.svg'; img.alt = 'commit';
    row.appendChild(img);
    row.appendChild(el('span', 'sp-commit-subject', c.subject || '(no subject)'));
    commits.appendChild(row);
  }
  if (rev === true) commits.appendChild(el('p', 'sp-revert verdict-word tone-warn', 'REVERTED LATER: a later commit reverted or amended this session\'s work.'));
  if (touch?.pushes) commits.appendChild(el('p', 'sp-meta', `${touch.pushes} push${touch.pushes === 1 ? '' : 'es'}`));
  body.appendChild(commits);

  const bounds = el('div', 'sp-block sp-bounds');
  bounds.appendChild(el('h3', 'sp-block-title', 'Bounds'));
  const zones = data?.scope?.zones ?? [];
  const zr = el('div', 'bounds-row');
  zr.appendChild(el('span', 'bounds-label', 'zones'));
  if (!zones.length) zr.appendChild(el('span', 'bounds-value bounds-none', 'no edits in a zone'));
  for (const z of zones) {
    const zn = el('span', `sp-zone env-${z.env ?? 'dev'}`, `${z.zone} ${z.count ?? ''}`.trim());
    if (handlers.onOpenMap) interactive(zn, () => handlers.onOpenMap(sessionId), `Open ${z.zone} on Surface`);
    zr.appendChild(zn);
  }
  if (data?.scope?.protected?.length) zr.appendChild(el('span', 'verdict-word tone-danger', `${data.scope.protected.length} protected`));
  bounds.appendChild(zr);
  bounds.appendChild(buildBounds(data?.workspace));
  body.appendChild(bounds);

  const ref = el('div', 'sp-block sp-refusals');
  ref.appendChild(el('h3', 'sp-block-title', 'Refusals'));
  const r = data?.refusals;
  if (!r) ref.appendChild(el('p', 'band-error', 'Refusals unavailable: the guard log could not be read.'));
  else if (!r.items.length) ref.appendChild(el('p', 'band-empty', data?.card ? 'No guard refusals for this session.' : 'Refusals are recorded per session and card; this session has none.'));
  for (const it of r?.items ?? []) {
    const row = el('div', 'sp-refusal-row sp-row');
    row.tabIndex = -1;
    row.appendChild(el('span', `verdict-word ${it.failOpen ? 'tone-neutral' : 'tone-warn'}`, it.failOpen ? 'FAIL-OPEN' : 'REFUSED'));
    row.appendChild(el('span', 'sp-refusal-hook', it.hook ?? 'guard'));
    row.appendChild(el('span', 'sp-refusal-reason', `${it.reason}${it.path ? `  ${it.path}` : ''}`));
    if (it.by === 'card') row.title = 'Recorded before refusals carried a session id: joined on the card.';
    ref.appendChild(row);
  }
  body.appendChild(ref);
  return band;
}

function ledgerRow(kind, word, tone, text, title) {
  const row = el('div', 'sp-ledger-row sp-row');
  row.tabIndex = -1;
  row.appendChild(el('span', 'sp-ledger-kind', kind));
  row.appendChild(el('span', `verdict-word tone-${tone}`, word));
  const t = el('span', 'sp-ledger-text', text);
  if (title) t.title = title;
  row.appendChild(t);
  return row;
}

const STATUS_TONE = { applied: 'ok', active: 'ok', pending: 'warn', discarded: 'neutral', retired: 'neutral', revoked: 'neutral' };

export function buildLearning(data, { gapRows, onOpenGap } = {}) {
  const led = learningLedger(data);
  const band = buildBand('learning', 'Learning', learningSummaryText(led.summary));
  const { body } = band;
  if (!data?.learning && !data?.gaps) {
    body.appendChild(el('p', 'band-error', 'Learning data unavailable: the server returned none. Reload to retry.'));
    return band;
  }
  if (led.empty) {
    body.appendChild(el('p', 'band-empty', 'No gaps, guards, memory writes or measurables from this session.'));
    return band;
  }
  if (led.gaps.length && gapRows) body.appendChild(gapRows(led.gaps));
  for (const g of led.guards) {
    const row = ledgerRow('guard', (g.status ?? 'pending').toUpperCase(), STATUS_TONE[g.status] ?? 'neutral', g.rule, g.title);
    if (onOpenGap) interactive(row.lastChild, () => onOpenGap(g.id), 'Open in the Registry');
    body.appendChild(row);
  }
  for (const o of led.others) body.appendChild(ledgerRow(o.source ?? 'item', (o.status ?? '').toUpperCase() || 'OPEN', STATUS_TONE[o.status] ?? 'neutral', o.title || o.id));
  for (const m of led.memory) body.appendChild(ledgerRow(m.kind === 'memory' ? 'mem' : 'instr', 'WROTE', 'info', m.name, m.path));
  for (const l of led.lessons) body.appendChild(ledgerRow('lesson', (l.status ?? '').toUpperCase(), STATUS_TONE[l.status] ?? 'neutral', `${l.title || l.id}${l.reflex ? '  reflex' : ''}`));
  for (const x of led.measurables) body.appendChild(ledgerRow('measure', String(x.n), 'neutral', x.kind));
  return band;
}
