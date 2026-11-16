// web/learning/outcome-metrics.js
// The Learning lens headline (D6b): four tiles, each value beside its evidence
// tag and sample size, never a bare number. A tile opens its evidence rows,
// and each row opens where that card, CI run or session lives.
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';

const fmtMinutes = (x) => (x < 90 ? `${Math.round(x)} min` : x < 48 * 60 ? `${(x / 60).toFixed(1)} h` : `${(x / 1440).toFixed(1)} d`);

export function formatMetric(m) {
  const v = m?.value ?? {};
  const n = Number.isFinite(v.n) ? v.n : 0;
  const absent = v.evidence === 'absent' || v.value == null;
  const valueText = absent ? 'not yet measurable'
    : m.unit === 'ratio' ? `${Math.round(v.value * 100)}%` : fmtMinutes(v.value);
  const evidenceText = v.evidence === 'measured' ? 'measured'
    : v.evidence === 'constant' ? `no variance (${v.reason ?? 'zero variance'})`
      : `not yet measurable: ${v.reason ?? 'no samples'}`;
  return { valueText, evidenceText, nText: `n = ${n}`, basis: m?.basis ?? '' };
}

export function refLink(ref) {
  if (ref.kind === 'card') return linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id: ref.id } });
  if (ref.kind === 'ci-run') return linkFor({ lens: 'work', band: 'gates', sel: { type: 'ci-run', id: ref.id } });
  return linkFor({ lens: 'session', sessionId: ref.id });
}

export function renderMetricDetail(container, metric, { go } = {}) {
  container.textContent = '';
  const box = document.createElement('div');
  box.className = 'om-detail';
  const h = document.createElement('h3'); h.textContent = metric.label; box.appendChild(h);
  const basis = document.createElement('p'); basis.className = 'om-basis'; basis.textContent = metric.basis; box.appendChild(basis);
  if (!metric.refs?.length) {
    const p = document.createElement('p'); p.className = 'band-empty';
    p.textContent = metric.value?.reason ? `No evidence rows: ${metric.value.reason}.` : 'No evidence rows in this window.';
    box.appendChild(p);
  }
  const list = document.createElement('ul'); list.className = 'om-refs';
  for (const ref of metric.refs ?? []) {
    const li = document.createElement('li'); li.className = 'om-ref';
    const id = document.createElement('code'); id.textContent = String(ref.id); li.appendChild(id);
    const val = document.createElement('span'); val.textContent = ` ${ref.value}`; li.appendChild(val);
    const link = refLink(ref);
    bindItem(li, { type: ref.kind, id: ref.id, link, open: () => go?.(link), label: `Open ${ref.kind} ${ref.id}` });
    list.appendChild(li);
  }
  box.appendChild(list);
  container.appendChild(box);
}

export function renderOutcomeMetrics(container, data, { onOpen } = {}) {
  const row = document.createElement('div');
  row.className = 'om-row';
  for (const m of data.metrics ?? []) {
    const f = { ...formatMetric(m) };
    f.absent = f.valueText === 'not yet measurable';
    const tile = document.createElement('article');
    tile.className = `om-tile om-${m.value?.evidence ?? 'absent'}`;
    const label = document.createElement('h3'); label.className = 'om-label'; label.textContent = m.label; tile.appendChild(label);
    const value = document.createElement('p'); value.className = 'om-value'; value.textContent = f.valueText; tile.appendChild(value);
    // An absent metric says why it cannot be measured yet (the reason is the
    // evidence text); a measured one keeps its evidence tag and sample size.
    const tag = document.createElement('p'); tag.className = 'om-tag';
    tag.textContent = f.absent
      ? `${f.evidenceText.replace(/^not yet measurable: /, '')}, ${f.nText}, last ${data.windowDays} days`
      : `${f.evidenceText}, ${f.nText}, last ${data.windowDays} days`;
    tile.appendChild(tag);
    bindItem(tile, {
      type: 'metric', id: m.id,
      link: linkFor({ lens: 'learning', band: 'metrics', sel: { type: 'metric', id: m.id } }),
      open: () => onOpen?.(m), label: f.absent ? `${m.label}: ${f.evidenceText}` : `${m.label}: ${f.valueText}, ${f.evidenceText}`,
    });
    row.appendChild(tile);
  }
  container.appendChild(row);
}
