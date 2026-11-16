// web/surface/panels.js
// What Surface's context drawer (drawer.js) renders: the inspector, which
// shows any item's detail from a plain model, text only, and the Policy
// bounds view (declared policy and engagement beside observed divergence).
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { fetchEngagement } from '../shared/api.js';
import { bandError, emptyState } from '../shared/bands.js';
import { workspaceSummary } from '../overview/workspace-view.js';

export function renderInspector(body, model) {
  body.textContent = '';
  if (model.word) { const w = document.createElement('p'); w.className = 'insp-word'; w.textContent = model.word; body.appendChild(w); }
  if (model.facts?.length) {
    const dl = document.createElement('dl'); dl.className = 'insp-facts';
    for (const [k, v] of model.facts) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v == null ? 'none' : String(v);
      dl.appendChild(dt); dl.appendChild(dd);
    }
    body.appendChild(dl);
  }
  for (const a of model.actions ?? []) body.appendChild(a);
  if (model.rows?.length) {
    const ul = document.createElement('ul'); ul.className = 'insp-rows';
    for (const r of model.rows) {
      const li = document.createElement('li'); li.className = 'insp-row';
      // A row with an href leaves GLMPS (an open PR on GitHub), so it is a plain
      // link in a new tab, not an in-app item.
      if (r.href) {
        const a = document.createElement('a'); a.className = 'insp-row-link'; a.href = r.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = r.text; li.appendChild(a);
      } else {
        li.textContent = r.text;
        bindItem(li, { type: r.type, id: r.id, link: r.link, open: r.open, label: r.text });
      }
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }
  if (model.empty) { const p = document.createElement('p'); p.className = 'band-empty'; p.textContent = model.empty; body.appendChild(p); }
}

export const PANEL_ITEM_TYPES = {
  panel: 'the dock or drawer view',
  divergence: 'a live session\'s declared goal against its observed work',
  'policy-rule': 'the directive in the policy editor',
};

function sub(body, title) {
  const s = document.createElement('section'); s.className = 'panel-sub';
  const h = document.createElement('h3'); h.textContent = title; s.appendChild(h);
  const b = document.createElement('div'); s.appendChild(b); body.appendChild(s);
  return b;
}

// D2: Policy and Engagement are the declared half of Surface, set beside the
// observed half (workspace divergence), on one page.
export async function renderDeclaredPanel(body, api) {
  const declared = sub(body, 'Declared: policy');
  try { await (await import('./declared/policy.js')).renderPolicy(declared); } catch (e) { bandError(declared, 'The policy editor', e); }
  const engagement = sub(body, 'Declared: engagement');
  try { (await import('./declared/engagement.js')).renderEngagement(engagement, await fetchEngagement()); } catch (e) { bandError(engagement, 'Engagement', e); }
  const observed = sub(body, 'Observed: live sessions against their declared goal');
  const ws = api.data.workspace;
  if (!ws?.ok) { emptyState(observed, `Workspace divergence not available: ${ws?.error ?? 'no data'}.`); return; }
  const list = ws.data.sessions ?? [];
  if (!list.length) emptyState(observed, 'No live session has declared a goal.');
  const ul = document.createElement('ul'); ul.className = 'insp-rows'; observed.appendChild(ul);
  for (const w of list) {
    const s = workspaceSummary(w);
    const li = document.createElement('li'); li.className = `insp-row drift-${s.drift}`;
    li.textContent = `${w.title ?? w.sessionId}  drift ${s.drift}`;
    bindItem(li, {
      type: 'divergence', id: w.sessionId,
      link: linkFor({ lens: 'surface', panel: 'declared', sel: { type: 'divergence', id: w.sessionId } }),
      open: () => {
        const go = document.createElement('a'); go.className = 'fa-btn'; go.textContent = 'Open session page';
        go.href = linkFor({ lens: 'session', sessionId: w.sessionId });
        go.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); api.ctx.go(go.href); });
        api.inspect({ title: w.title ?? w.sessionId, word: `drift ${s.drift}`, facts: [['declared goal', s.goal || 'none declared'], ...s.lines.map((l) => [l.k, l.v]), ['observed paths', s.paths.join(', ') || 'none']], actions: [go] });
      },
      label: `Session ${w.title ?? w.sessionId}: drift ${s.drift}`,
    });
    ul.appendChild(li);
  }
}
