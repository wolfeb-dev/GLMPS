// web/shared/tabs.js
// A pillar's sub-tab strip (card glmps-2-0-137, story 45): a WAI-ARIA tab
// list with one panel per tab, roving tabindex, and arrow-key, Home and End
// focus that also selects (automatic activation, as the Learning strip did).
// select() only shows the panel; loading its content is the caller's job.
export function createTabs(host, tabs, { label, idPrefix, onSelect = () => {}, className = 'pillar-tabs' }) {
  const strip = document.createElement('div');
  strip.className = className;
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', label);
  const wrap = document.createElement('div');
  wrap.className = `${className}-panels`;
  const btns = new Map();
  const panels = new Map();
  for (const t of tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `${className}-tab`;
    b.id = `${idPrefix}-tab-${t.id}`;
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('aria-controls', `${idPrefix}-panel-${t.id}`);
    b.tabIndex = -1;
    btns.set(t.id, b);
    strip.appendChild(b);
    const p = document.createElement('div');
    p.className = `${className}-panel`;
    p.id = `${idPrefix}-panel-${t.id}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', b.id);
    p.hidden = true;
    panels.set(t.id, p);
    wrap.appendChild(p);
  }
  host.append(strip, wrap);

  let active = null;
  function show(id) {
    if (!btns.has(id)) return false;
    for (const [tid, b] of btns) {
      const on = tid === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panels.get(tid).hidden = !on;
    }
    active = id;
    return true;
  }
  const pick = (id) => { if (show(id)) onSelect(id); };

  strip.addEventListener('click', (ev) => {
    const b = ev.target?.closest?.('[role="tab"]');
    if (b) pick(b.id.slice(`${idPrefix}-tab-`.length));
  });
  strip.addEventListener('keydown', (ev) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault?.();
    const i = tabs.findIndex((t) => t.id === active);
    const n = ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1
      : (i + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    btns.get(tabs[n].id).focus?.();
    pick(tabs[n].id);
  });

  return {
    el: strip,
    panel: (id) => panels.get(id),
    active: () => active,
    // a route's choice: shown without calling onSelect, so no history entry
    show,
    // no tab selected (a host showing something that is not one of its tabs);
    // the first tab stays the strip's single Tab stop.
    none() {
      tabs.forEach((t, i) => { const b = btns.get(t.id); b.setAttribute('aria-selected', 'false'); b.tabIndex = i === 0 ? 0 : -1; panels.get(t.id).hidden = true; });
      active = null;
    },
    select: pick,
  };
}
