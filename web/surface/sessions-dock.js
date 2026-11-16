// web/surface/sessions-dock.js
// The sessions on the globe's ring, in the right-hand Sessions dock: those
// waiting on you first, each with its latest action and last 5 minutes of
// calls, and the colour legend the dials and arcs share. A row picks that
// session (Wall mode locks it).
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, cls) => { const e = document.createElementNS(SVG_NS, tag); if (cls) e.setAttribute('class', cls); return e; };
const SPARK_W = 84; const SPARK_H = 20;
export const LEGEND = [['info', 'activity'], ['ok', 'commit, push, pass'], ['err', 'failure'], ['warn', 'needs you'], ['idle', 'idle']];

// The 5-minute calls-per-minute line, drawn into an existing svg.
function drawSpark(svg, series, tone) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const max = Math.max(4, ...series);
  const step = SPARK_W / Math.max(1, series.length - 1);
  const pts = series.map((v, i) => [i * step, SPARK_H - 2 - (v / max) * (SPARK_H - 5)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = svgEl('path', `spark-area spark-${tone}`); area.setAttribute('d', `${line}L${SPARK_W},${SPARK_H}L0,${SPARK_H}Z`);
  const stroke = svgEl('path', `spark-line spark-${tone}`); stroke.setAttribute('d', line);
  svg.append(area, stroke);
}

export function createSessionsRoster(dock, { onPick = () => {} } = {}) {
  const list = el('ul', 'roster-list');
  const empty = el('p', 'roster-empty', 'No live sessions on the ring.');
  const legend = el('div', 'roster-legend'); legend.setAttribute('aria-label', 'Colour key');
  for (const [tone, label] of LEGEND) {
    const item = el('span', 'legend-item'); const dot = el('i', `legend-dot tone-${tone}`); dot.setAttribute('aria-hidden', 'true');
    item.append(dot, document.createTextNode(label)); legend.appendChild(item);
  }
  dock.body.append(list, empty);
  dock.el.insertBefore(legend, dock.footEl);
  dock.subEl.hidden = false;

  const rows = new Map();
  const text = (node, v) => { if (node.textContent !== v) node.textContent = v; };
  function setRoster(data, { lockedId = null, wall = null } = {}) {
    empty.hidden = data.length > 0;
    const busy = data.filter((r) => r.status === 'active').length;
    const waiting = data.filter((r) => r.status === 'waiting').length;
    text(dock.subEl, wall ? (lockedId ? 'Wall mode, locked' : 'Wall mode, touring') : `${busy} busy, ${waiting} waiting on you`);
    const live = new Set(data.map((r) => r.id));
    for (const [id, r] of rows) if (!live.has(id)) { r.li.remove(); rows.delete(id); }
    data.forEach((row, i) => {
      let r = rows.get(row.id);
      if (!r) {
        const li = el('li', 'roster-item');
        const btn = el('button', 'roster-row'); btn.type = 'button';
        const dot = el('i', 'roster-dot'); dot.setAttribute('aria-hidden', 'true');
        const mid = el('span', 'roster-mid');
        const name = el('span', 'roster-name'); const word = el('span', 'roster-word');
        mid.append(name, word);
        const spark = svgEl('svg', 'roster-spark'); spark.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`); spark.setAttribute('aria-hidden', 'true');
        const rate = el('span', 'roster-rate');
        btn.append(dot, mid, spark, rate);
        btn.addEventListener('click', () => onPick(row.id));
        li.appendChild(btn);
        r = { li, btn, name, word, spark, rate, sig: '' };
        rows.set(row.id, r);
      }
      if (list.children[i] !== r.li) list.insertBefore(r.li, list.children[i] ?? null);
      const tone = row.tone ?? 'info';
      r.btn.dataset.state = row.status;
      r.btn.dataset.tone = tone;
      r.btn.setAttribute('aria-pressed', lockedId === row.id ? 'true' : 'false');
      text(r.name, row.repo ? `${row.name} in ${row.repo}` : row.name);
      text(r.word, row.word);
      text(r.rate, `${row.cpm}/m`);
      r.btn.setAttribute('aria-label', `${row.name}, ${row.word}, ${row.cpm} calls a minute`);
      const sig = `${tone}|${row.series.join(',')}`;
      if (sig !== r.sig) { r.sig = sig; drawSpark(r.spark, row.series, tone); }
    });
  }
  return { setRoster, count: () => rows.size };
}
