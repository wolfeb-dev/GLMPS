// web/knowledge/graphs-table.js
// The Graphs table under the Architecture graph (card glmps-2-0-137 phase 5,
// story 28): every graph, what builds it, why it exists and the Personality
// files that steer it. It moved here from the Loops tab so graph health sits
// with the graph. Rendered once per mount; server data reaches the DOM only
// through textContent.
import { getLoopCatalog, getPersonality } from '../shared/api.js';
import { clear } from '../shared/dom-util.js';
import { mergeSteers, modeLabel } from '../loops/model.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function cardNames(settled) {
  const m = new Map();
  if (settled?.status !== 'fulfilled') return m;
  for (const g of settled.value?.groups ?? []) for (const c of g.cards ?? []) if (c?.id) m.set(c.id, c.name ?? c.id);
  return m;
}

export async function renderGraphsTable(host, { isCurrent = () => true } = {}) {
  clear(host);
  const wrap = el('section', 'lp kn-graphs');
  wrap.setAttribute('aria-labelledby', 'kn-graphs-h');
  const head = el('h3', 'lp-sub', 'Graphs');
  head.id = 'kn-graphs-h';
  const status = el('p', 'lp-muted', 'Loading...');
  status.setAttribute('role', 'status');
  wrap.append(head, status);
  host.appendChild(wrap);

  const [cat, pers] = await Promise.allSettled([getLoopCatalog(), getPersonality()]);
  if (!isCurrent()) return;
  if (cat.status === 'rejected') {
    status.remove();
    const box = el('p', 'lp-error', `Could not load the graphs: ${cat.reason?.message ?? cat.reason}. Check that the server is running, then reload.`);
    box.setAttribute('role', 'alert');
    wrap.appendChild(box);
    return;
  }
  const graphs = cat.value?.graphs ?? [];
  const names = cardNames(pers);
  head.textContent = `Graphs (${graphs.length})`;
  if (!graphs.length) { status.textContent = 'No graphs are registered.'; return; }
  status.remove();

  const table = el('table', 'lp-table lp-graphs');
  table.appendChild(el('caption', 'lp-sr', 'Graphs, what builds them and what steers them'));
  const thead = el('thead');
  const hr = el('tr');
  for (const [text, cls] of [['Graph', ''], ['Built by', ''], ['Why it exists', 'c-why'], ['Steered by', '']]) {
    const th = el('th', cls, text);
    th.setAttribute('scope', 'col');
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = el('tbody');
  for (const g of graphs) {
    const tr = el('tr');
    tr.append(el('td', 'c-name mono', g.name), el('td', 'lp-muted', g.builtBy ?? ''), el('td', 'c-why', g.why ?? ''));
    const td = el('td');
    const list = mergeSteers(g.steers);
    if (!list.length) td.appendChild(el('span', 'lp-muted', 'none'));
    else {
      const chips = el('div', 'lp-chips');
      for (const c of list) {
        const chip = el('span', `lp-chip${c.direct ? '' : ' ind'}`);
        chip.title = modeLabel(c);
        chip.appendChild(document.createTextNode(names.get(c.card) ?? c.card));
        if (c.writes) chip.appendChild(el('span', 'lp-w', 'writes'));
        if (!c.direct) chip.appendChild(el('span', 'lp-sr', ' (indirect)'));
        chips.appendChild(chip);
      }
      td.appendChild(chips);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  const tw = el('div', 'lp-tablewrap');
  tw.appendChild(table);
  wrap.appendChild(tw);
}
