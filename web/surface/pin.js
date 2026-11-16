// web/surface/pin.js
// File as card: from the selected item, a short form prefilled with the item
// and a link back to this exact view. Nothing is posted until the operator
// presses the button.
import { linkFor } from '../shared/deep-link.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function pinDraft({ sel, model, viewUrl }) {
  const title = `Follow up on ${model?.title ?? `${sel.type} ${sel.id}`}`.slice(0, 200);
  const lines = [`Follow up from Surface: ${sel.type} ${sel.id}.`];
  if (model?.word) lines.push(model.word);
  for (const [k, v] of (model?.facts ?? []).slice(0, 5)) lines.push(`${k}: ${v == null ? 'none' : v}`);
  lines.push('', `View it on Surface: ${viewUrl}`);
  return { title, prompt: lines.join('\n') };
}

export function createPin({ panels, modelFor, urlNow, ctx, fetchImpl = (u, o) => fetch(u, o) }) {
  function open(sel) {
    const model = modelFor(sel.type, sel.id);
    const draft = pinDraft({ sel, model, viewUrl: `${location.origin}${urlNow()}` });
    panels.open('pin', 'File as card', (body) => {
      body.textContent = '';
      body.appendChild(el('p', 'panel-note', 'Nothing is filed until you press File card.'));
      const form = el('div', 'pin-form');
      const tId = 'pin-title', pId = 'pin-prompt';
      const tl = el('label', 'pin-l', 'Title'); tl.setAttribute('for', tId);
      const title = el('input', 'pin-in'); title.id = tId; title.type = 'text'; title.value = draft.title; title.setAttribute('maxlength', '200');
      const pl = el('label', 'pin-l', 'Prompt'); pl.setAttribute('for', pId);
      const prompt = el('textarea', 'pin-in pin-prompt'); prompt.id = pId; prompt.setAttribute('rows', '7'); prompt.value = draft.prompt;
      const out = el('p', 'pin-out'); out.setAttribute('role', 'status');
      const acts = el('div', 'trk-acts');
      const submit = el('button', 'fa-btn pin-submit', 'File card'); submit.type = 'button';
      const cancel = el('button', 'fa-btn', 'Cancel'); cancel.type = 'button';
      cancel.addEventListener('click', () => panels.close('pin'));
      let busy = false;
      async function post() {
        if (busy) return;
        const t = title.value.trim();
        if (!t) { out.className = 'pin-out pin-bad'; out.setAttribute('role', 'alert'); out.textContent = 'A card needs a title.'; title.focus(); return; }
        busy = true; submit.disabled = true; out.className = 'pin-out'; out.setAttribute('role', 'status'); out.textContent = 'Filing';
        try {
          const res = await fetchImpl('/api/backlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'manual', title: t, prompt: prompt.value }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error ?? `POST /api/backlog returned ${res.status}`);
          out.textContent = '';
          out.appendChild(document.createTextNode(`Filed card ${data.id ?? '(no id returned)'}. `));
          if (data.id) {
            const href = linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id: data.id } });
            const a = el('a', 'pin-card', 'Open it on Work'); a.href = href;
            a.addEventListener('click', (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); ctx.go(href); });
            out.appendChild(a);
          }
          submit.textContent = 'Filed';
        } catch (e) {
          out.className = 'pin-out pin-bad'; out.setAttribute('role', 'alert');
          out.textContent = `Could not file the card: ${e.message}`;
          submit.disabled = false;
        } finally { busy = false; }
      }
      submit.addEventListener('click', post);
      title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); post(); } });
      acts.append(submit, cancel);
      form.append(tl, title, pl, prompt, acts, out);
      body.appendChild(form);
      title.focus();
    });
  }
  // A button for the inspector's action row.
  function button(sel) {
    const b = el('button', 'fa-btn pin-open', 'File as card'); b.type = 'button';
    b.addEventListener('click', () => open(sel));
    return b;
  }
  return { open, button };
}
