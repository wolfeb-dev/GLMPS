// apps/shell/renderer/setup.js
// First-run setup wizard. Renders purely from the State the main process
// pushes through window.glmpsSetup. The only client-side state is form input
// values, which step is on screen, and whether a call is in flight. Text only
// (createElement / textContent), never innerHTML: item details and error
// messages come from child processes.
'use strict';

const api = window.glmpsSetup;
const SVG_NS = 'http://www.w3.org/2000/svg';
const STATUS_LABEL = { todo: 'To do', running: 'Running', ok: 'Done', warn: 'Attention', failed: 'Failed', skipped: 'Skipped' };
const SATISFIED = new Set(['ok', 'warn', 'skipped']);
const FIELD_ORDER = ['botToken', 'appToken', 'email', 'memberId', 'engagement', 'folder'];
const FIELDS = {
  botToken: { label: 'Bot User OAuth Token', type: 'password', placeholder: 'xoxb-...', hint: 'Starts with xoxb-. Shown under OAuth & Permissions once the app is installed.' },
  appToken: { label: 'App-Level Token', type: 'password', placeholder: 'xapp-...', hint: 'Starts with xapp-. Create it under Basic Information with the connections:write scope.' },
  email: { label: 'Your Slack email', type: 'text', placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email', hint: 'Used to find you in the workspace and invite you to the channels.' },
  memberId: { label: 'Slack member ID', optional: true, type: 'text', placeholder: 'U01234567', hint: 'Only needed if the email lookup fails. Profile menu, then Copy member ID.' },
  engagement: { label: 'Engagement name', type: 'text', placeholder: 'Client or project name', hint: 'Names the profile that scopes your repositories.' },
  folder: { label: 'Repositories folder', type: 'text', placeholder: 'Choose the folder that holds your repositories', browse: true, hint: 'GLMPS searches this folder for git repositories.' },
};

const $ = (id) => document.getElementById(id);
const draft = { botToken: '', appToken: '', email: '', memberId: '', engagement: '', folder: '', launchAtLogin: null };
const touched = new Set();
const results = {};
let state = null;
let viewId = null;
let lastCurrentId = null;
let furthest = 0;
let inflight = false;
let focusHeading = false;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function svg(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// One shape per status so it never relies on colour alone.
function marker(status) {
  const s = STATUS_LABEL[status] ? status : 'todo';
  const root = svg('svg', { class: 'mk mk-' + s, viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  if (s === 'ok') {
    root.append(svg('circle', { cx: 8, cy: 8, r: 7, fill: 'currentColor' }), svg('path', { class: 'cut', d: 'M4.8 8.2 L7 10.4 L11.2 5.8' }));
  } else if (s === 'failed') {
    root.append(svg('circle', { cx: 8, cy: 8, r: 7, fill: 'currentColor' }), svg('path', { class: 'cut', d: 'M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4' }));
  } else if (s === 'warn') {
    root.append(svg('path', { d: 'M8 1.6 L14.8 13.8 H1.2 Z', fill: 'currentColor', 'stroke-linejoin': 'round' }), svg('path', { class: 'cut', d: 'M8 6 V9.2 M8 11.4 V11.5' }));
  } else if (s === 'skipped') {
    root.append(svg('circle', { class: 'ring', cx: 8, cy: 8, r: 6.2 }), svg('path', { class: 'arc', d: 'M5 8 H11' }));
  } else if (s === 'running') {
    root.append(svg('circle', { class: 'ring', cx: 8, cy: 8, r: 6.2, opacity: 0.25 }), svg('path', { class: 'arc', d: 'M8 1.8 A6.2 6.2 0 0 1 14.2 8' }));
  } else {
    root.append(svg('circle', { class: 'ring', cx: 8, cy: 8, r: 6.2 }));
  }
  return root;
}

function chip(status) {
  const s = STATUS_LABEL[status] ? status : 'todo';
  return h('span', { class: 'chip tone-' + s }, marker(s), STATUS_LABEL[s]);
}

const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const idxOf = (id) => state.steps.findIndex((s) => s.id === id);
const viewStep = () => state.steps.find((s) => s.id === viewId) || state.steps[0];
const isBusy = () => inflight || !!state.busy || state.steps.some((s) => s.status === 'running');
const neededFields = (step) => {
  const set = new Set();
  for (const a of step.actions || []) for (const n of a.needs || []) set.add(n);
  return FIELD_ORDER.filter((n) => set.has(n));
};

function validate(name, raw) {
  const v = String(raw || '').trim();
  if (name === 'botToken') {
    if (!v) return 'Paste the Bot User OAuth Token.';
    if (!v.startsWith('xoxb-')) return 'A bot token starts with xoxb-. Copy the Bot User OAuth Token from OAuth & Permissions, not the app-level token.';
  } else if (name === 'appToken') {
    if (!v) return 'Paste the App-Level Token.';
    if (!v.startsWith('xapp-')) return 'An app-level token starts with xapp-. Create one under Basic Information with the connections:write scope.';
  } else if (name === 'email') {
    if (!v) return 'Enter the email you sign in to Slack with.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'That does not look like an email address. Check for typos.';
  } else if (name === 'memberId') {
    if (v && !/^[UW][A-Z0-9]{2,}$/.test(v)) return 'A member ID starts with U or W, for example U01234567. Or leave it empty.';
  } else if (name === 'engagement') {
    if (!v) return 'Name the engagement, for example the client or project.';
  } else if (name === 'folder') {
    if (!v) return 'Choose the folder that holds your repositories.';
  }
  return '';
}

function showFieldError(name) {
  const msg = touched.has(name) ? validate(name, draft[name]) : '';
  const err = $('f-' + name + '-err');
  const input = $('f-' + name);
  if (!err || !input) return msg;
  err.hidden = !msg;
  err.lastChild.textContent = msg;
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  return msg;
}

function field(name) {
  const f = FIELDS[name];
  const id = 'f-' + name;
  const input = h('input', {
    id, type: f.type, 'data-fk': 'field:' + name, value: draft[name], placeholder: f.placeholder, autocomplete: f.autocomplete || 'off',
    inputmode: f.inputmode, spellcheck: 'false', 'aria-invalid': 'false', 'aria-describedby': id + '-hint ' + id + '-err',
    'aria-required': f.optional ? null : 'true',
    oninput: (e) => { draft[name] = e.target.value; if (touched.has(name)) showFieldError(name); },
    onblur: () => { touched.add(name); showFieldError(name); },
  });
  input.value = draft[name];
  const control = h('div', { class: 'control' }, input);
  if (f.browse) {
    control.append(btn('Browse', { class: 'btn', fk: 'browse', onclick: async () => {
      if (isBusy()) return;
      const picked = await api.pickFolder();
      if (picked) { draft.folder = picked; touched.add('folder'); $('f-folder').value = picked; showFieldError('folder'); }
      $('f-folder').focus();
    } }));
  }
  return h('div', { class: 'field' },
    h('label', { for: id }, f.label, f.optional ? h('span', { class: 'opt' }, ' (optional)') : null),
    control,
    h('p', { class: 'hint', id: id + '-hint' }, f.hint),
    h('p', { class: 'err', id: id + '-err', hidden: true }, marker('failed'), h('span', { class: 'sr' }, 'Error: '), h('span', { class: 'err-text' })),
  );
}

function btn(label, { class: cls = 'btn', fk, disabled, onclick, type = 'button' } = {}) {
  const b = h('button', { type, class: cls, 'data-fk': fk, 'aria-disabled': disabled ? 'true' : null }, label);
  // aria-disabled keeps the button focusable so focus survives a busy cycle.
  b.addEventListener('click', (e) => {
    if (b.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    if (onclick) onclick(e);
  });
  return b;
}

function collect(needs) {
  const input = {};
  for (const n of needs || []) input[n] = String(draft[n] || '').trim();
  return input;
}

function openLink(key) {
  if (!isBusy()) api.openLink(key);
}

async function startAction(step, action) {
  if (isBusy()) return;
  const needs = (action.needs || []).filter((n) => FIELDS[n]);
  let first = null;
  for (const n of needs) {
    touched.add(n);
    if (showFieldError(n) && !first) first = n;
  }
  if (first) { $('f-' + first).focus(); return; }
  const input = collect(action.needs);
  inflight = true;
  delete results[step.id];
  render();
  try {
    const r = await api.run(step.id, action.id, action.needs && action.needs.length ? input : undefined);
    results[step.id] = r && typeof r === 'object' ? { ok: !!r.ok, message: r.message || '' } : { ok: false, message: 'Setup did not answer. Try again.' };
  } catch (e) {
    results[step.id] = { ok: false, message: 'Setup could not run this step: ' + ((e && e.message) || e) };
  } finally {
    inflight = false;
    // Secrets never outlive the call that used them.
    if (needs.includes('botToken') || needs.includes('appToken')) {
      draft.botToken = '';
      draft.appToken = '';
      touched.delete('botToken');
      touched.delete('appToken');
    }
    render();
  }
}

async function doFinish() {
  if (isBusy()) return;
  const last = state.steps[state.steps.length - 1];
  inflight = true;
  delete results[last.id];
  render();
  try {
    const r = await api.finish({ launchAtLogin: launchValue() });
    if (!(r && r.ok)) results[last.id] = { ok: false, message: 'Setup could not be marked finished. Try Finish again, or close this window and reopen it from the tray with Run setup wizard.' };
  } catch (e) {
    results[last.id] = { ok: false, message: 'Setup could not be finished: ' + ((e && e.message) || e) };
  } finally {
    inflight = false;
    render();
  }
}

const launchValue = () => (draft.launchAtLogin === null ? !!state.launchAtLogin : draft.launchAtLogin);

function go(id) {
  if (isBusy() || id === viewId) return;
  viewId = id;
  furthest = Math.max(furthest, idxOf(id));
  focusHeading = true;
  render();
}

// Per-item actions are named install-<item> or update-<item> (colon also
// accepted); everything else is a step-level action. 'skip' has its own slot.
function splitActions(step) {
  const perItem = new Map();
  const stepLevel = [];
  let skip = null;
  const keys = (step.items || []).map((it) => slug(it.id || it.name));
  for (const a of step.actions || []) {
    if (a.id === 'skip') { skip = a; continue; }
    const m = /^(?:install|update)[:-](.+)$/.exec(a.id);
    const key = m && slug(m[1]);
    if (key && keys.includes(key) && !perItem.has(key)) perItem.set(key, a);
    else stepLevel.push(a);
  }
  return { perItem, stepLevel, skip };
}

function renderRail() {
  const list = $('rail-list');
  const busy = isBusy();
  list.replaceChildren();
  state.steps.forEach((s, i) => {
    const st = STATUS_LABEL[s.status] ? s.status : 'todo';
    const kids = [marker(st), h('span', { class: 'rail-title' }, s.title), h('span', { class: 'rail-state' }, STATUS_LABEL[st])];
    const current = s.id === viewId ? 'step' : null;
    const row = i <= furthest
      ? btn('', { class: 'rail-row', fk: 'rail:' + s.id, disabled: busy && !current, onclick: () => go(s.id) })
      : h('span', { class: 'rail-row is-locked' });
    row.textContent = '';
    row.append(...kids);
    if (current) row.setAttribute('aria-current', 'step');
    list.append(h('li', null, row));
  });
}

function statusLine(step) {
  const st = STATUS_LABEL[step.status] ? step.status : 'todo';
  const allOk = step.items && step.items.length && step.items.every((it) => it.status === 'ok') && st === 'ok';
  return h('div', { class: 'status-line tone-' + st },
    marker(st),
    h('p', null, h('span', { class: 'status-label' }, allOk ? 'All checks passed' : STATUS_LABEL[st]), step.detail ? h('span', { class: 'status-detail' }, ' ' + step.detail) : null),
  );
}

function resultBlock(step) {
  const r = results[step.id];
  const failed = step.status === 'failed';
  if (!r && !failed) return null;
  const bad = r ? !r.ok : true;
  if (!r && failed) {
    return h('p', { class: 'way' }, 'This step did not finish. Try again with the button at the bottom right, or skip it and finish later from the tray menu (Run setup wizard).');
  }
  const note = h('div', { class: 'notice' + (bad ? '' : ' is-ok') },
    marker(bad ? 'failed' : 'ok'),
    h('div', null,
      h('p', { class: 'notice-title' }, bad ? 'Could not complete this step' : 'Done'),
      r.message ? h('p', { class: 'notice-body' }, r.message) : null,
      bad ? h('p', { class: 'way' }, 'Check the details above, then try again with the button at the bottom right, or skip this step and finish it later.') : null,
    ),
  );
  if (!r.announced) { r.announced = true; note.setAttribute('role', bad ? 'alert' : 'status'); }
  return note;
}

function itemsList(step, perItem) {
  const busy = isBusy();
  const ul = h('ul', { class: 'items' });
  for (const it of step.items) {
    const act = perItem.get(slug(it.id || it.name));
    ul.append(h('li', { class: 'item' },
      h('span', { class: 'item-name' }, it.name),
      chip(it.status),
      h('span', { class: 'item-detail' }, it.detail || ''),
      act ? h('span', { class: 'item-act' }, btn(act.label, { class: 'btn small', fk: 'action:' + act.id, disabled: busy, onclick: () => startAction(step, act) })) : null,
    ));
  }
  return ul;
}

function planList() {
  const ul = h('ul', { class: 'items plan' });
  for (const s of state.steps.slice(1)) {
    ul.append(h('li', { class: 'item' }, h('span', { class: 'item-name' }, s.title), h('span', { class: 'item-detail' }, s.summary || '')));
  }
  return ul;
}

function slackBlock() {
  return h('ol', { class: 'how' },
    h('li', null,
      h('h2', null, 'Create the app'),
      h('p', { class: 'how-text' }, 'Opens Slack with the Riker app already filled in. Pick your workspace and click Create.'),
      btn('Create the app', { class: 'btn small', fk: 'link:create', disabled: isBusy(), onclick: () => openLink('slack-create-app') }),
    ),
    h('li', null,
      h('h2', null, 'Install it and copy two tokens'),
      h('p', { class: 'how-text' }, 'Install to your workspace, then copy the Bot User OAuth Token (xoxb-). Create an App-Level Token with connections:write (xapp-).'),
      btn('Open app settings', { class: 'btn small', fk: 'link:apps', disabled: isBusy(), onclick: () => openLink('slack-apps') }),
    ),
    h('li', null,
      h('h2', null, 'Paste them here'),
      h('div', { class: 'section' }, ...['botToken', 'appToken', 'email', 'memberId'].map(field)),
    ),
  );
}

function finishBlock(step) {
  const failing = (step.items || []).some((it) => it.status === 'failed' || it.status === 'warn');
  return h('div', { class: 'section' },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', id: 'launch', 'data-fk': 'launch', checked: launchValue(), 'aria-describedby': 'launch-hint', onchange: (e) => { draft.launchAtLogin = e.target.checked; } }),
      'Run GLMPS at startup'),
    h('p', { class: 'hint', id: 'launch-hint' }, 'A stopped app stops the runner, the merge queue and the Slack connection.'),
    failing ? h('p', { class: 'way' }, 'Some checks need attention. You can finish now and fix them later from the tray menu (Run setup wizard).') : null,
  );
}

function submitAction(step) {
  const withNeeds = (step.actions || []).filter((a) => a.needs && a.needs.length);
  return withNeeds.find((a) => a.primary) || withNeeds[0] || null;
}

function renderPanel(step, idx) {
  const { perItem } = splitActions(step);
  const last = idx === state.steps.length - 1;
  const fields = neededFields(step);
  const nodes = [
    h('p', { class: 'eyebrow' }, 'Step ' + (idx + 1) + ' of ' + state.steps.length),
    h('h1', { id: 'step-title', tabindex: '-1' }, step.title),
  ];
  if (step.summary) nodes.push(h('p', { class: 'lead' }, step.summary));
  if (step.id === 'welcome') {
    if (step.detail) nodes.push(h('p', { class: 'muted' }, step.detail));
    nodes.push(h('div', { class: 'section' }, h('h2', { class: 'section-title' }, 'What this sets up'), planList()));
  } else {
    nodes.push(statusLine(step));
  }
  const res = resultBlock(step);
  if (res) nodes.push(res);
  if (step.items && step.items.length) nodes.push(h('div', { class: 'section' }, itemsList(step, perItem)));
  if (step.id === 'slack' && fields.length) {
    nodes.push(h('form', { id: 'step-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); const a = submitAction(step); if (a) startAction(step, a); } }, slackBlock()));
  } else if (fields.length) {
    nodes.push(h('form', { id: 'step-form', class: 'section', novalidate: true, onsubmit: (e) => { e.preventDefault(); const a = submitAction(step); if (a) startAction(step, a); } }, ...fields.map(field)));
  }
  if (step.id === 'github') {
    nodes.push(h('div', { class: 'section' }, btn('Open GitHub token settings', { class: 'btn small', fk: 'link:gh', disabled: isBusy(), onclick: () => openLink('github-tokens') })));
  }
  if (last) nodes.push(finishBlock(step));
  $('panel-inner').replaceChildren(...nodes);
  for (const n of fields) showFieldError(n);
}

function renderFoot(step, idx) {
  const busy = isBusy();
  const last = idx === state.steps.length - 1;
  const { stepLevel, skip } = splitActions(step);
  const satisfied = SATISFIED.has(step.status);
  const stepPrimary = !satisfied && !last ? stepLevel.find((a) => a.primary) || null : null;
  const canAdvance = !last && (satisfied || (step.actions || []).length === 0);

  const left = idx === 0
    ? btn('Set up later', { class: 'btn quiet', fk: 'nav:later', disabled: busy, onclick: () => api.close() })
    : btn('Back', { class: 'btn', fk: 'nav:back', disabled: busy, onclick: () => go(state.steps[idx - 1].id) });
  $('foot-left').replaceChildren(left);

  const right = [];
  if (skip) right.push(btn(skip.label || 'Skip', { class: 'btn quiet', fk: 'action:skip', disabled: busy, onclick: () => startAction(step, skip) }));
  else if (idx > 0 && !last && !satisfied && (step.actions || []).length) right.push(btn('Skip', { class: 'btn quiet', fk: 'nav:skip', disabled: busy, onclick: () => go(state.steps[idx + 1].id) }));
  for (const a of stepLevel) {
    const primary = stepPrimary === a;
    right.push(btn(a.label, { class: 'btn' + (primary ? ' primary' : ''), fk: 'action:' + a.id, disabled: busy, onclick: () => startAction(step, a) }));
  }
  if (last) right.push(btn('Finish', { class: 'btn primary', fk: 'nav:finish', disabled: busy, onclick: doFinish }));
  else right.push(btn('Next', { class: 'btn' + (canAdvance && !stepPrimary ? ' primary' : ''), fk: 'nav:next', disabled: busy || !canAdvance, onclick: () => go(state.steps[idx + 1].id) }));
  $('foot-right').replaceChildren(...right);

  const running = state.steps.find((s) => s.status === 'running');
  let text = '';
  if (busy) text = 'Working on ' + (running ? running.title : step.title) + (running && running.detail ? ': ' + running.detail : '') + '. Please wait.';
  $('foot-status').textContent = text;
  $('progress').hidden = !busy;
  $('foot-hint').textContent = !busy && !last && !canAdvance ? 'Run this step or Skip to continue.' : '';
}

function render() {
  if (!state) return;
  const ae = document.activeElement;
  const fk = ae && ae.dataset ? ae.dataset.fk : null;
  const sel = fk && ae.tagName === 'INPUT' && ae.type !== 'checkbox' ? [ae.selectionStart, ae.selectionEnd] : null;
  const panel = $('panel');
  const scroll = panel.scrollTop;
  const prevView = panel.dataset.view;

  const step = viewStep();
  viewId = step.id;
  const idx = idxOf(step.id);
  for (let i = state.steps.length - 1; i >= 0; i--) if (state.steps[i].status !== 'todo') { furthest = Math.max(furthest, i); break; }
  furthest = Math.max(furthest, idxOf(state.currentId), idx);

  renderRail();
  renderPanel(step, idx);
  renderFoot(step, idx);
  panel.dataset.view = step.id;
  document.title = 'GLMPS 2.0 setup: ' + step.title;

  if (prevView === step.id) panel.scrollTop = scroll;
  if (focusHeading) {
    focusHeading = false;
    panel.scrollTop = 0;
    $('step-title').focus();
  } else if (fk) {
    const el = document.querySelector('[data-fk="' + fk.replace(/"/g, '') + '"]');
    if (el) {
      el.focus();
      if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* input type without selection */ } }
    }
  }
}

function applyState(next) {
  state = next;
  if (state.currentId !== lastCurrentId) {
    lastCurrentId = state.currentId;
    if (viewId !== state.currentId) { viewId = state.currentId; focusHeading = viewId !== null && document.activeElement !== document.body; }
  }
  render();
}

if (!api) {
  $('panel-inner').replaceChildren(h('h1', null, 'Setup is not available'), h('p', { class: 'lead' }, 'The setup bridge did not load. Close this window and reopen it from the tray with Run setup wizard.'));
} else {
  api.onState(applyState);
  api.getState().then(applyState).catch((e) => {
    $('panel-inner').replaceChildren(h('h1', null, 'Could not read setup state'), h('p', { class: 'lead' }, String((e && e.message) || e) + ' Close this window and reopen it from the tray with Run setup wizard.'));
  });
}
