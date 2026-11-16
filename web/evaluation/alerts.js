// web/evaluation/alerts.js - Alerts page: security/governance detections with
// comprehensive detail - the exact file(s) and diffs (via the shared renderDiff),
// like the Sessions tab. XSS discipline: textContent / createElement only.
import { getAlerts, ackAlert } from '../shared/api.js';
import { renderDiff } from '../shared/diff-view.js';
import { formatTime } from '../shared/time-format.js';

const NS = 'http://www.w3.org/2000/svg';
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function icon(pathD, size = 16) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', pathD); s.appendChild(p);
  return s;
}
const SHIELD = 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z';

const SEV_ORDER = ['critical', 'warn', 'info'];
const SEV_LABEL = { critical: 'Critical', warn: 'Warning', info: 'Info' };
function fmtTs(ts) { return ts ? formatTime(ts) : ''; }

// dismissedOnly: the Surface drawer already lists the live alerts above this
// view, so its Show dismissed history renders only the acknowledged ones.
export async function renderAlerts(container, { dismissedOnly = false } = {}) {
  container.textContent = '';
  const shell = el('div', 'alerts-shell');
  container.appendChild(shell);
  shell.appendChild(el('div', 'alerts-loading', 'Loading alerts\u2026'));
  const state = { showDismissed: dismissedOnly, dismissedOnly };
  await load(shell, state);
}

// No live-state coupling; the page refreshes on entry (and can be re-entered).
export function updateAlerts() {}

// Fetches (honoring state.showDismissed via ?all=1) and repaints. Re-invoked
// after every dismiss/undo/toggle so the list, counts, and dismissed section
// always reflect the persisted server-side ack store.
async function load(shell, state) {
  let data;
  try { data = await getAlerts({ evidence: true, all: state.showDismissed }); }
  catch { shell.textContent = ''; shell.appendChild(el('div', 'alerts-zero-msg', 'Could not load alerts.')); return; }
  paint(shell, data, state);
}

function paint(shell, data, state) {
  shell.textContent = '';
  const all = data.alerts ?? [];
  const alerts = all.filter(a => !a.acknowledged);
  const dismissed = all.filter(a => a.acknowledged);

  const head = el('header', 'alerts-head');
  const eyebrow = el('div', 'alerts-eyebrow');
  eyebrow.appendChild(icon(SHIELD, 13));
  eyebrow.appendChild(el('span', null, 'Alerts'));
  head.appendChild(eyebrow);
  const sub = el('div', 'alerts-sub');
  const counts = { critical: 0, warn: 0, info: 0 };
  for (const a of alerts) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  if (alerts.length) {
    for (const s of SEV_ORDER) if (counts[s]) sub.appendChild(el('span', `alerts-count sev-${s}`, `${counts[s]} ${SEV_LABEL[s].toLowerCase()}`));
  } else sub.appendChild(el('span', 'alerts-count', 'All clear'));
  head.appendChild(sub);

  const toggle = el('button', 'alerts-toggle', state.showDismissed ? 'Hide dismissed' : 'Show dismissed');
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', String(state.showDismissed));
  toggle.classList.toggle('is-active', state.showDismissed);
  toggle.addEventListener('click', async () => {
    state.showDismissed = !state.showDismissed;
    await load(shell, state);
  });
  head.appendChild(toggle);
  if (!state.dismissedOnly) shell.appendChild(head);

  const main = el('div', 'alerts-main');
  shell.appendChild(main);

  if (state.dismissedOnly) {
    if (!dismissed.length) { main.appendChild(el('div', 'alerts-zero-msg', 'No dismissed alerts')); return; }
    main.appendChild(el('div', 'alerts-group-label', `Dismissed \u00B7 ${dismissed.length}`));
    for (const a of dismissed) main.appendChild(card(a, shell, state));
    return;
  }

  if (!alerts.length && !dismissed.length) {
    const zero = el('div', 'alerts-zero');
    const ic = icon(SHIELD, 46); ic.classList.add('alerts-zero-icon'); zero.appendChild(ic);
    zero.appendChild(el('div', 'alerts-zero-msg', 'No active alerts'));
    zero.appendChild(el('div', 'alerts-zero-hint', 'Security and governance detections appear here with the exact file(s) and diffs.'));
    main.appendChild(zero);
    return;
  }

  for (const s of SEV_ORDER) {
    const group = alerts.filter(a => a.severity === s);
    if (!group.length) continue;
    main.appendChild(el('div', `alerts-group-label sev-${s}`, `${SEV_LABEL[s]} \u00B7 ${group.length}`));
    for (const a of group) main.appendChild(card(a, shell, state));
  }

  if (state.showDismissed && dismissed.length) {
    main.appendChild(el('div', 'alerts-group-label', `Dismissed \u00B7 ${dismissed.length}`));
    for (const a of dismissed) main.appendChild(card(a, shell, state));
  }
}

function card(a, shell, state) {
  const c = el('article', `alert-card sev-${a.severity}` + (a.acknowledged ? ' is-acked' : ''));

  const head = el('div', 'alert-card-head');
  head.appendChild(el('span', `alert-sev-chip sev-${a.severity}`, a.severity));
  head.appendChild(el('span', 'alert-src', a.source));
  if (a.ts) head.appendChild(el('span', 'alert-ts', fmtTs(a.ts)));
  head.appendChild(el('span', 'alert-spacer'));
  const ack = el('button', 'alert-ack', a.acknowledged ? 'Undo' : 'Dismiss'); ack.type = 'button';
  ack.title = a.acknowledged ? 'Restore this alert' : 'Dismiss this alert (until it re-fires with new evidence)';
  ack.addEventListener('click', async () => {
    ack.disabled = true;
    try { await ackAlert(a.id, a.acknowledged); }
    finally {
      window.dispatchEvent(new CustomEvent('mc-alerts-refresh'));
      await load(shell, state);
    }
  });
  head.appendChild(ack);
  if (a.target && a.target.view) {
    const go = el('button', 'alert-jump', 'Go to source'); go.type = 'button';
    go.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('mc-navigate', { detail: { view: a.target.view, sessionId: a.target.id || null, target: a.target } })));
    head.appendChild(go);
  }
  c.appendChild(head);

  c.appendChild(el('div', 'alert-title', a.title));
  if (a.detail) c.appendChild(el('div', 'alert-detail', a.detail));
  if (a.target && a.target.path) {
    const fp = el('div', 'alert-path');
    fp.appendChild(el('span', 'alert-path-lab', 'File'));
    fp.appendChild(el('code', null, a.target.path));
    c.appendChild(fp);
  }

  const ev = Array.isArray(a.evidence) ? a.evidence : [];
  if (ev.length) {
    const box = el('section', 'alert-evidence');
    box.appendChild(el('div', 'alert-evidence-lab', `Evidence \u00B7 ${ev.length} file change${ev.length === 1 ? '' : 's'}`));
    for (const e of ev) {
      const f = el('div', 'alert-evfile');
      const fh = el('div', 'alert-evfile-head');
      fh.appendChild(el('code', 'alert-evfile-path', e.path || '(unknown file)'));
      if (e.tool) fh.appendChild(el('span', 'alert-evfile-tool', e.tool));
      f.appendChild(fh);
      const diff = el('div', 'alert-evdiff');
      if (e.change) diff.appendChild(renderDiff(e.change));
      else diff.appendChild(el('span', 'alert-evfile-none', '(no diff captured)'));
      f.appendChild(diff);
      box.appendChild(f);
    }
    c.appendChild(box);
  } else if (a.target && a.target.view === 'sessions') {
    c.appendChild(el('div', 'alert-evnone', 'No captured file changes for this detection.'));
  }
  return c;
}
