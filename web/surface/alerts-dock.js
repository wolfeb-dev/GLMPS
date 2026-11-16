// web/surface/alerts-dock.js
// The one place Surface lists what needs attention: every critical alert with
// Fly to and Acknowledge, the warnings folded by source, and the data feeds
// that could not be drawn. It is the Alerts tab of the context drawer, opened
// from the rail, the globe's alert pulses and any ?panel=attention link; past
// alerts sit in the same view behind "Show dismissed". It is the only place on
// Surface that posts (an acknowledge), and only on the button.
import { ackAlert, getAlerts } from '../shared/api.js';
import { PULSE_PLACE } from './orbits.js';
import { attentionModel, warningsWord } from './summary.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function ageWord(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const m = Math.max(0, Math.round((now - ts) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// The view's sub line: the alert counts, split by kind.
export function alertsSubLine(m, feedCount) {
  const parts = [`${m.criticalCount} critical`, warningsWord(m).toLowerCase()];
  if (feedCount) parts.push(`${feedCount} feed${feedCount === 1 ? '' : 's'} not drawn`);
  return parts.join(', ');
}

export function createAlertsDock(dock, { api, isDestroyed = () => false, renderHistory = async () => {} }) {
  let body = api.data.alerts?.ok ? api.data.alerts.data ?? {} : null;
  let feedError = api.data.alerts?.ok ? null : api.data.alerts?.error ?? 'no data';
  const feeds = [];
  const gone = new Set();
  const busy = new Set();
  let error = null;

  // Sections take the Layers dock's group markup, so the two read as one family.
  const section = (id, label) => {
    const sec = el('div', `layer-group alerts-${id}`); sec.setAttribute('role', 'group');
    const h = el('h3', 'layer-group-h', label); h.id = `alerts-group-${id}`; sec.setAttribute('aria-labelledby', h.id);
    const list = el('div', 'layer-list'); sec.append(h, list);
    dock.body.appendChild(sec);
    return { sec, h, list };
  };
  const crit = section('critical', 'Critical');
  const warn = section('warnings', 'Warnings');
  const feed = section('feeds', 'Data feeds');

  const where = (alert) => {
    const place = PULSE_PLACE[alert.source];
    if (!place) return null;
    if (place === 'local') return api.localPos();
    const p = api.players?.find((x) => x.id === place);
    return p && Number.isFinite(p.lon) && Number.isFinite(p.lat) ? [p.lon, p.lat] : null;
  };
  const openAlert = (id) => api.open({ type: 'alert', id });

  async function acknowledge(a) {
    if (busy.has(a.id)) return;
    busy.add(a.id); error = null; paint();
    try {
      const r = await ackAlert(a.id);
      if (r.status >= 400) throw new Error(r.body?.error ?? `HTTP ${r.status}`);
      gone.add(a.id);
      window.dispatchEvent(new CustomEvent('mc-alerts-refresh'));
    } catch (e) { error = `Could not acknowledge ${a.title}: ${e.message}`; }
    busy.delete(a.id);
    paint();
  }

  function criticalRow(a) {
    const row = el('div', 'adock-row is-critical');
    const title = el('button', 'adock-title', a.title); title.type = 'button';
    title.title = 'Open this alert';
    title.addEventListener('click', () => openAlert(a.id));
    const meta = el('p', 'adock-meta', [a.detail, ageWord(a.ts)].filter(Boolean).join(' | '));
    const acts = el('div', 'adock-acts');
    const fly = el('button', 'fa-btn', 'Fly to'); fly.type = 'button';
    const pos = where(a);
    if (pos) fly.addEventListener('click', () => api.flyTo(pos, 6));
    else { fly.disabled = true; fly.title = 'This alert is not placed on the globe'; }
    const ack = el('button', 'fa-btn adock-ack', 'Acknowledge'); ack.type = 'button';
    ack.setAttribute('aria-label', `Acknowledge: ${a.title}`);
    ack.disabled = busy.has(a.id);
    ack.addEventListener('click', () => acknowledge(a));
    acts.append(fly, ack);
    row.append(title, meta, acts);
    return row;
  }

  function groupRow(g) {
    const b = el('button', 'adock-group'); b.type = 'button';
    b.append(el('span', 'sw'), el('span', 'name', g.label), el('span', 'n', String(g.count)));
    b.title = `Show the ${g.count} ${g.label} alert${g.count === 1 ? '' : 's'}`;
    b.addEventListener('click', () => api.inspect({
      title: `${g.label}: ${g.count}`,
      rows: g.alerts.map((a) => ({ type: 'alert', id: a.id, text: a.title, link: api.link({ type: 'alert', id: a.id }), open: () => openAlert(a.id) })),
    }));
    return b;
  }

  function paint() {
    if (isDestroyed()) return;
    crit.list.textContent = ''; warn.list.textContent = ''; feed.list.textContent = '';
    if (body == null) {
      crit.list.appendChild(el('p', 'band-empty', `Alerts not available: ${feedError}`));
      warn.sec.hidden = true;
    } else {
      const m = attentionModel(body, gone);
      dock.subEl.hidden = false;
      dock.subEl.textContent = alertsSubLine(m, feeds.length);
      dock.el.classList.toggle('is-critical', m.criticalCount > 0);
      crit.h.textContent = `Critical ${m.criticalCount}`;
      if (!m.critical.length) crit.list.appendChild(el('p', 'band-empty', 'Nothing critical.'));
      for (const a of m.critical) crit.list.appendChild(criticalRow(a));
      warn.sec.hidden = false;
      warn.h.textContent = `Warnings ${m.warningTotal}`;
      if (!m.groups.length) warn.list.appendChild(el('p', 'band-empty', 'No warnings.'));
      for (const g of m.groups) warn.list.appendChild(groupRow(g));
    }
    if (error) { const p = el('p', 'band-error', error); p.setAttribute('role', 'alert'); crit.list.appendChild(p); }
    feed.h.textContent = `Data feeds ${feeds.length}`;
    if (!feeds.length) feed.list.appendChild(el('p', 'band-empty', 'Every feed drew.'));
    for (const text of feeds) feed.list.appendChild(el('p', 'adock-feed', text));
  }

  // Live and past alerts are one list (story 14): the full list with its
  // dismissed alerts and diffs loads under the live sections on first use.
  const toggle = el('label', 'adock-dismissed');
  const box = el('input'); box.type = 'checkbox'; box.name = 'alerts-show-dismissed';
  toggle.append(box, document.createTextNode(' Show dismissed'));
  const historyHost = el('div', 'adock-history');
  historyHost.hidden = true;
  let historyLoaded = false;
  box.addEventListener('change', async () => {
    historyHost.hidden = !box.checked;
    if (!box.checked || historyLoaded) return;
    historyLoaded = true;
    try { await renderHistory(historyHost); } catch (e) { historyLoaded = false; historyHost.textContent = `Alert history failed to load: ${e.message}`; }
  });
  dock.footEl.hidden = false;
  dock.footEl.textContent = '';
  dock.footEl.appendChild(toggle);
  dock.body.appendChild(historyHost);

  const refetch = async () => {
    try { const next = await getAlerts(); if (isDestroyed()) return; body = next ?? {}; feedError = null; paint(); } catch { /* keep what is shown */ }
  };
  window.addEventListener('mc-alerts-refresh', refetch);
  paint();
  return {
    paint,
    // A layer whose feed could not be drawn reports here instead of floating over the globe.
    feed(text) { feeds.push(String(text)); paint(); },
    destroy() { window.removeEventListener('mc-alerts-refresh', refetch); },
  };
}
