// web/shared/huddle.js
// The huddle dock (glmps-2.0 corpus, document 7, section 6): not a page, a
// dock over whatever lens is open, with three parts and no tabs - the roster
// strip, live captions, and the controls. Static files with ONE mount call
// mountHuddle(rootEl) loads its own stylesheet and opens its own
// EventSource while a huddle is open. rootEl is #huddle-dock, which
// web/shared/dock.js mountDocks hands to web/huddle/dock.js. State lives in a pure reducer tested in node; only
// mountHuddle touches the DOM. XSS discipline: textContent / createElement.
import { withAccessToken } from './api.js';
import { createHuddleVoice } from './huddle-voice.js';
import { loadNeuralMouth, loadLocalEars } from './huddle-neural.js';

// Persona hue in the strip and captions, by role, on the stage tokens.
export const HUE_BY_ROLE = Object.freeze({
  orchestrator: 'var(--st-orch)',
  builder: 'var(--st-exec)',
  reviewer: 'var(--st-gate)',
  critic: 'var(--st-adv)',
  researcher: 'var(--st-learn)',
  scout: 'var(--st-commit)',
  assistant: 'var(--primary)',
  dissent: 'var(--fg)',
});

export function initialHuddleState() {
  return { huddleId: null, chips: [], captions: [], partial: null, ended: false, ending: false, summary: '', status: null, extracted: null, deciding: false, kickoff: null, muted: [], agenda: null, answered: [], record: null, saving: false };
}

export function reduceHuddle(state, payload) {
  if (payload?.type === 'huddle-local' && payload.event === 'status') {
    return { ...state, status: { text: String(payload.text ?? ''), level: payload.level === 'error' ? 'error' : 'info' } };
  }
  // Dock-local: the End request is in flight (the server gives a Gemini seat
  // call up to 10 s before aborting it). on:false clears it after a failed End.
  if (payload?.type === 'huddle-local' && payload.event === 'ending') {
    const on = payload.on !== false;
    return { ...state, ending: on, status: on ? { text: 'Ending huddle... this can take up to 10 seconds.', level: 'info' } : state.status };
  }
  if (payload?.type === 'huddle-local' && payload.event === 'deciding') return { ...state, deciding: payload.on !== false };
  if (payload?.type === 'huddle-local' && payload.event === 'answered') return { ...state, answered: [...new Set([...state.answered, ...(payload.indexes ?? [])])] };
  if (payload?.type === 'huddle-local' && payload.event === 'saving') return { ...state, saving: payload.on !== false };
  if (payload?.type === 'huddle-local' && payload.event === 'record') return { ...state, saving: false, record: payload.record ?? null };
  if (payload?.type === 'huddle-local' && payload.event === 'kickoff') return { ...state, kickoff: { cards: payload.cards ?? [], repeat: Boolean(payload.repeat) } };
  if (!payload || payload.type !== 'huddle') return state;
  if (payload.event === 'started') {
    // The server broadcasts `started` for every huddle (another tab's too). A live
    // huddle here is never replaced by one frame; only a finished one is.
    if (state.huddleId && !state.ended) return state;
    return { ...initialHuddleState(), huddleId: payload.huddleId, chips: (payload.personas ?? []).map((p) => ({ ...p, state: 'idle', muted: false })) };
  }
  if (payload.huddleId !== state.huddleId) return state;
  const setChip = (id, chipState) => state.chips.map((c) => (c.id === id ? { ...c, state: chipState } : c));
  switch (payload.event) {
    // state 'idle': the server dropped that speaker's call (an aborted seat
    // dissent), so no utterance will arrive to clear the chip
    case 'speaker':
      return { ...state, chips: setChip(payload.speaker, payload.state === 'idle' ? 'idle' : 'thinking') };
    // A server-side status line for this huddle (a failed turn whose mind also
    // failed to warm up shows why).
    case 'status':
      return { ...state, status: { text: String(payload.text ?? ''), level: payload.level === 'error' ? 'error' : 'info' } };
    case 'partial':
      return { ...state, chips: setChip(payload.speaker, 'speaking'), partial: { speaker: payload.speaker, text: payload.text } };
    case 'utterance':
      return {
        ...state,
        chips: setChip(payload.speaker, 'idle'),
        partial: null,
        captions: [...state.captions, { speaker: payload.speaker, text: payload.text, ts: payload.ts, model: payload.model ?? null, truncated: Boolean(payload.truncated), error: Boolean(payload.error), pass: Boolean(payload.pass), ...(payload.outside ? { outside: true, label: String(payload.label ?? 'From the web, unverified') } : {}) }],
      };
    case 'muted': {
      const muted = Array.isArray(payload.muted) ? payload.muted : [];
      return { ...state, muted, chips: state.chips.map((c) => ({ ...c, muted: muted.includes(c.id) })) };
    }
    case 'agenda':
      return { ...state, answered: [], agenda: { question: payload.question ?? '', items: payload.items ?? [] } };
    case 'decisions':
      return { ...state, deciding: false, extracted: { problem: payload.problem ?? '', against: payload.against ?? [], decisions: payload.decisions ?? [], actions: payload.actions ?? [], open: payload.open ?? [] } };
    case 'ended': {
      const post = payload.summaryPost;
      const status = post ? (post.ok ? { text: 'Summary posted to Slack.', level: 'info' } : { text: `Summary not posted to Slack: ${post.error ?? 'unknown'}`, level: 'error' }) : (state.ending ? null : state.status);
      return { ...state, ended: true, ending: false, summary: payload.summary ?? '', partial: null, status, chips: state.chips.map((c) => ({ ...c, state: 'idle' })) };
    }
    default:
      return state;
  }
}

export function agendaView(state) {
  const items = (state.agenda?.items ?? []).map((it, i) => ({ n: i + 1, text: it.text, lean: it.lean ?? '', answered: state.answered.includes(i) }));
  return { question: state.agenda?.question ?? '', items, empty: items.length === 0 };
}

// "1 yes, 2 b" typed against the agenda becomes a line the team can read
// without the agenda in front of them. Anything that is not wholly numbered
// answers to open questions is a normal turn (null).
export function expandAgendaAnswers(text, agenda) {
  const items = agenda?.items ?? [];
  if (!items.length) return null;
  const parts = String(text ?? '').split(/\s*[,;\n]\s*/).filter(Boolean);
  if (!parts.length) return null;
  const answered = [];
  const said = [];
  for (const part of parts) {
    const m = part.match(/^(\d{1,2})[.):]?\s+(.+)$/);
    const i = m ? Number(m[1]) - 1 : -1;
    if (!m || i < 0 || i >= items.length) return null;
    answered.push(i);
    said.push(`${i + 1} (${items[i].text}): ${m[2].trim().replace(/[.!]+$/, '')}.`);
  }
  return { answered, text: `Answering the open questions. ${said.join(' ')}` };
}

export function recordView(state) {
  const r = state.record;
  if (!r) return null;
  return { id: r.id, problem: r.problem ?? '', decisions: r.decisions ?? [], open: r.open ?? [], actions: r.actions ?? [], summary: r.summary ?? '', canFile: (r.decisions?.length ?? 0) > 0 || (r.actions?.length ?? 0) > 0 };
}

export function decisionsView(state) {
  const x = state.extracted;
  const decisions = x?.decisions ?? [];
  const actions = (x?.actions ?? []).map((a, i) => ({ i, title: a.title, detail: a.detail }));
  return { decisions, actions, open: x?.open ?? [], canPlan: decisions.length > 0 || actions.length > 0, canQueue: actions.length > 0 };
}

// A queued card runs in its project's repo, so kick-off always names one.
export function pickProject(projects, remembered) {
  const names = (projects ?? []).map((p) => p?.name).filter(Boolean);
  if (remembered && names.includes(remembered)) return remembered;
  if (names.includes('glmps')) return 'glmps';
  return names[0] ?? '';
}
const PROJECT_KEY = 'huddle.project';

// "File that": the last operator line and every reply after it become a card.
export function fileThatPayload(state) {
  const idx = state.captions.map((c) => c.speaker).lastIndexOf('operator');
  if (idx === -1) return null;
  const displayOf = (id) => (id === 'operator' ? 'Operator' : state.chips.find((c) => c.id === id)?.display ?? id);
  const slice = state.captions.slice(idx);
  const title = slice[0].text.slice(0, 120);
  const prompt = slice.map((c) => `${displayOf(c.speaker)}: ${c.text}`).join('\n') + `\n\n(from huddle ${state.huddleId})`;
  // source 'huddle': the prompt is model-written text, so the backlog's poison
  // scan must treat it as external (OPERATOR_SOURCES is manual/dashboard/operator).
  return { title, prompt, source: 'huddle', origin: { via: 'huddle', huddleId: state.huddleId } };
}

// DOM below this line.
async function postJson(url, obj) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `request failed (${r.status})`);
  return body;
}

function ensureStylesheet() {
  const href = new URL('./huddle.css', import.meta.url).href;
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

export function mountHuddle(rootEl) {
  ensureStylesheet();
  let state = initialHuddleState();
  let es = null;
  let starting = false; // a start request is in flight: the launcher only toggles the panel
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const apply = (payload) => { state = reduceHuddle(state, payload); render(); };
  const status = (text, level = 'error') => apply({ type: 'huddle-local', event: 'status', text, level });

  const voice = createHuddleVoice({
    win: window,
    onHeard: (text) => { input.value = ''; submitLine(text); },
    onInterim: (text) => { if (text || input.dataset.interim) { input.value = text; input.dataset.interim = text ? '1' : ''; } },
    onBargeIn: () => { if (state.huddleId && !state.ended) postJson(`/api/huddle/${state.huddleId}/interrupt`, {}).catch(() => {}); },
    onMetric: (m) => { if (state.huddleId) postJson(`/api/huddle/${state.huddleId}/metric`, m).catch(() => {}); },
    onStatus: (text) => status(text, 'error'),
    onChange: () => render(),
  });

  // Neural voices and local ears load in the background once a huddle starts;
  // until then, and if they cannot load, the browser's own engines speak and
  // listen. Local ears are only used with the neural mouth: the browser's voices
  // play outside the page, where echo cancellation cannot reach them.
  let upgrade = null;
  function upgradeVoices(personas, audioCtx) {
    if (upgrade) return upgrade;
    upgrade = (async () => {
      let mouth;
      try {
        mouth = await loadNeuralMouth({
          win: window, personas, audioCtx,
          onError: (e) => { voice.useBrowserMouth(); voice.useBrowserEars(); status(`Neural voices stopped, using the browser's voices: ${e?.message ?? e}`); },
        });
      } catch (e) {
        status(`Using the browser's voices: ${e?.message ?? e}.`, 'info');
        return;
      }
      voice.setMouth(mouth);
      try {
        voice.setEars(await loadLocalEars({
          win: window,
          onSpeechStart: () => voice.speechStarted(),
          onFinal: (text, at) => voice.heardLine(text, at),
          onStatus: (text) => status(text),
          isPlaying: () => voice.audible,
        }));
        status('Neural voices and local hearing are ready.', 'info');
      } catch (e) {
        status(`Neural voices are ready; hearing stays with the browser: ${e?.message ?? e}.`, 'info');
      }
    })();
    return upgrade;
  }

  const launch = el('button', 'huddle-launch', 'Huddle');
  launch.type = 'button';
  launch.setAttribute('aria-label', 'Start a huddle');
  launch.setAttribute('aria-expanded', 'false');
  rootEl.appendChild(launch);

  const dock = el('aside', 'huddle-dock hidden');
  dock.setAttribute('aria-label', 'Huddle');
  const strip = el('div', 'huddle-strip');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', 'Seats');
  // The scroller holds three siblings: an empty-state note, the live region
  // (settled lines only, appended once each), and the in-progress line, which
  // sits outside the live region so screen readers hear a line once, settled.
  const scroller = el('div', 'huddle-captions');
  const emptyNote = el('div', 'huddle-empty');
  const log = el('div', 'huddle-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', 'Huddle captions');
  const partialEl = el('div', 'huddle-partial');
  partialEl.setAttribute('aria-hidden', 'true');
  scroller.append(emptyNote, log, partialEl);
  const statusLine = el('div', 'huddle-status');
  statusLine.setAttribute('role', 'status');
  const form = el('form', 'huddle-form');
  const input = el('textarea', 'huddle-input');
  input.rows = 2;
  input.placeholder = 'Type a line, or name a seat first. Answer the agenda like: 1 yes, 2 b';
  input.setAttribute('aria-label', 'Your line');
  const send = el('button', 'huddle-send', 'Send');
  send.type = 'submit';
  const controls = el('div', 'huddle-controls');
  const interruptBtn = el('button', 'huddle-btn', 'Interrupt');
  // One input, typing by default: the mic sits beside the text box and
  // push-to-talk stays a toggle on it.
  const talkBtn = el('button', 'huddle-btn huddle-talk', 'Mic');
  const voicesBtn = el('button', 'huddle-btn', 'Voices');
  const decideBtn = el('button', 'huddle-btn', 'Decide');
  const fileBtn = el('button', 'huddle-btn', 'File that');
  const agendaBtn = el('button', 'huddle-btn huddle-agenda-toggle', 'Agenda');
  const recordBtn = el('button', 'huddle-btn', 'Record');
  const endBtn = el('button', 'huddle-btn huddle-btn-end', 'End and save');
  for (const b of [talkBtn, voicesBtn, interruptBtn, decideBtn, fileBtn, agendaBtn, recordBtn, endBtn]) b.type = 'button';
  agendaBtn.setAttribute('aria-expanded', 'false');
  recordBtn.hidden = true;
  controls.append(voicesBtn, interruptBtn, decideBtn, fileBtn, agendaBtn, recordBtn, endBtn);

  // The agenda column: the question on the table, then the open questions with
  // the team's leading recommendation. Answered inline through the one input.
  const agendaEl = el('section', 'huddle-agenda');
  agendaEl.setAttribute('aria-label', 'Agenda');
  const agendaHead = el('div', 'huddle-agenda-head');
  agendaHead.appendChild(el('h3', 'huddle-dhead', 'Agenda'));
  const agendaRefresh = el('button', 'huddle-btn huddle-agenda-refresh', 'Update');
  agendaRefresh.type = 'button';
  agendaHead.appendChild(agendaRefresh);
  const agendaQuestion = el('p', 'huddle-agenda-question');
  const agendaList = el('ol', 'huddle-agenda-list');
  const agendaNote = el('p', 'huddle-agenda-note');
  agendaNote.setAttribute('role', 'status');
  agendaEl.append(agendaHead, agendaQuestion, agendaList, agendaNote);
  const body = el('div', 'huddle-body');
  const main = el('div', 'huddle-main');

  // End and save: a modal with the four-part record and the two offers.
  const dlg = el('dialog', 'huddle-record');
  dlg.setAttribute('aria-labelledby', 'huddle-record-title');
  const dlgTitle = el('h3', 'huddle-record-title', 'Huddle record');
  dlgTitle.id = 'huddle-record-title';
  const dlgState = el('p', 'huddle-record-state');
  dlgState.setAttribute('role', 'status');
  const dlgBody = el('div', 'huddle-record-body');
  const dlgProjLabel = el('label', 'huddle-project');
  dlgProjLabel.appendChild(el('span', null, 'Project'));
  const dlgProj = el('select', 'huddle-project-select');
  dlgProjLabel.appendChild(dlgProj);
  const dlgActions = el('div', 'huddle-kick');
  const fileCardBtn = el('button', 'huddle-btn huddle-btn-go', 'File as card');
  const draftBtn = el('button', 'huddle-btn huddle-btn-go', 'Draft spec');
  const dlgClose = el('button', 'huddle-btn', 'Close');
  for (const b of [fileCardBtn, draftBtn, dlgClose]) b.type = 'button';
  dlgActions.append(fileCardBtn, draftBtn, dlgClose);
  dlg.append(dlgTitle, dlgState, dlgBody, dlgProjLabel, dlgActions);
  // Decisions sit under the captions and scroll on their own, so a long list
  // never pushes the input or the controls out of the small dock.
  const decide = el('section', 'huddle-decide');
  decide.setAttribute('aria-label', 'Decisions');
  decide.hidden = true;
  const decideBody = el('div', 'huddle-decide-body');
  const kickRow = el('div', 'huddle-kick');
  const planBtn = el('button', 'huddle-btn huddle-btn-go', 'Plan and build');
  const queueBtn = el('button', 'huddle-btn huddle-btn-go', 'Queue picked');
  const backlogBtn = el('button', 'huddle-btn', 'Backlog instead');
  for (const b of [planBtn, queueBtn, backlogBtn]) b.type = 'button';
  backlogBtn.setAttribute('aria-pressed', 'false');
  const projLabel = el('label', 'huddle-project');
  projLabel.appendChild(el('span', null, 'Project'));
  const projSel = el('select', 'huddle-project-select');
  projLabel.appendChild(projSel);
  let projectsLoaded = false;
  async function loadProjects() {
    if (projectsLoaded) return;
    projectsLoaded = true;
    let projects = [];
    try { const r = await fetch('/api/projects'); if (r.ok) projects = (await r.json()).projects ?? []; }
    catch { /* the empty select below says so */ }
    let remembered = null;
    try { remembered = localStorage.getItem(PROJECT_KEY); } catch { /* private mode */ }
    projSel.textContent = '';
    dlgProj.textContent = '';
    if (!projects.length) { projSel.appendChild(el('option', null, 'No projects found')); projSel.value = ''; dlgProj.appendChild(el('option', null, 'No projects found')); dlgProj.value = ''; projectsLoaded = false; }
    for (const p of projects) {
      for (const sel of [projSel, dlgProj]) { const o = el('option', null, p.name); o.value = p.name; sel.appendChild(o); }
    }
    if (projects.length) { projSel.value = pickProject(projects, remembered); dlgProj.value = projSel.value; }
    render();
  }
  projSel.addEventListener('change', () => { try { localStorage.setItem(PROJECT_KEY, projSel.value); } catch { /* private mode */ } render(); });
  kickRow.append(projLabel, planBtn, queueBtn, backlogBtn);
  decide.append(decideBody, kickRow);
  main.append(scroller, decide);
  body.append(main, agendaEl);
  form.append(input, talkBtn, send);
  dock.append(strip, body, statusLine, form, controls, dlg);
  rootEl.appendChild(dock);

  function openEvents() {
    if (es) return;
    es = new EventSource(withAccessToken('/api/events'));
    es.onmessage = (m) => {
      let payload;
      try { payload = JSON.parse(m.data); } catch { return; } // other producers' frames are not ours to judge
      // `started` comes only from our own start response (another tab's huddle is not ours).
      if (payload?.type === 'huddle' && payload.event !== 'started') apply(payload);
      if (payload?.type === 'huddle' && payload.event !== 'started' && payload.huddleId === state.huddleId) feedVoice(payload);
    };
    es.onerror = () => { if (es?.readyState === EventSource.CLOSED) status('Lost the live connection; reload to reconnect.'); };
  }
  // Mouths follow the settled stream: partials start the first sentence early,
  // the utterance flushes the rest. Captions are unchanged either way.
  function feedVoice(p) {
    if (p.event === 'partial') voice.speakPartial(p.speaker, p.text);
    else if (p.event === 'utterance' && !p.outside) voice.speakFinal({ speaker: p.speaker, text: p.text, error: p.error, pass: p.pass, truncated: p.truncated });
    else if (p.event === 'speaker' && p.state === 'idle') voice.release(p.speaker);
    else if (p.event === 'ended') voice.reset();
  }
  function closeEvents() { if (es) { es.close(); es = null; } }
  function setOpen(open) {
    dock.classList.toggle('hidden', !open);
    launch.setAttribute('aria-expanded', String(open));
  }

  const chipEls = new Map(); // persona id -> button, updated in place so focus survives a frame
  const muteEls = new Map();
  const seatEls = new Map();
  let agendaKey = '';
  let agendaBusy = false;
  let agendaOpen = false;
  let rosterKey = '';
  let renderedLines = 0;
  let renderedHuddle = null;
  let renderedSummary = false;
  let partialKey = '';
  let statusKey = '';
  let renderedExtracted = null;
  let kicking = false;
  let asBacklog = false;
  const pickBoxes = [];

  function buildDecisions(v) {
    decideBody.textContent = '';
    pickBoxes.length = 0;
    const group = (title, items) => {
      if (!items.length) return;
      const g = el('div', 'huddle-dgroup');
      g.appendChild(el('h4', 'huddle-dhead', title));
      const ul = el('ul', 'huddle-dlist');
      for (const t of items) ul.appendChild(el('li', null, t));
      g.appendChild(ul);
      decideBody.appendChild(g);
    };
    group('Decided', v.decisions);
    if (v.actions.length) {
      const g = el('div', 'huddle-dgroup');
      g.appendChild(el('h4', 'huddle-dhead', 'Actions'));
      for (const a of v.actions) {
        const lab = el('label', 'huddle-pick');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = true;
        box.addEventListener('change', render);
        pickBoxes[a.i] = box;
        const txt = el('span', 'huddle-pick-text', a.title);
        if (a.detail) txt.title = a.detail;
        lab.append(box, txt);
        g.appendChild(lab);
      }
      decideBody.appendChild(g);
    }
    group('Still open', v.open);
    if (!v.decisions.length && !v.actions.length && !v.open.length) decideBody.appendChild(el('div', 'huddle-dnone', 'Nothing was decided yet. Keep talking, then press Decide again.'));
  }

  function lineRow(c) {
    const chip = state.chips.find((x) => x.id === c.speaker);
    const row = el('div', 'huddle-line' + (c.speaker === 'operator' ? ' huddle-line-operator' : '') + (c.partial ? ' huddle-line-partial' : '') + (c.truncated ? ' huddle-line-truncated' : '') + (c.error ? ' huddle-line-error' : '') + (c.pass ? ' huddle-line-pass' : '') + (c.outside ? ' huddle-line-outside' : ''));
    row.style.setProperty('--line-hue', chip ? (HUE_BY_ROLE[chip.role] ?? 'var(--primary)') : 'var(--fg)');
    const who = el('span', 'huddle-who', c.speaker === 'operator' ? 'you' : (chip?.display ?? c.speaker));
    const said = el('span', 'huddle-text', c.text + (c.truncated ? ' [interrupted]' : ''));
    row.append(who, said);
    if (c.outside) row.appendChild(el('span', 'huddle-outside', c.label ?? 'From the web, unverified'));
    if (c.model) row.appendChild(el('span', 'huddle-model', c.model));
    return row;
  }

  function render() {
    // Roster: rebuild only when the set of minds changes (a new huddle or a reset).
    const key = state.chips.map((c) => c.id).join('|');
    if (key !== rosterKey) {
      rosterKey = key;
      strip.textContent = '';
      chipEls.clear();
      muteEls.clear();
      seatEls.clear();
      for (const c of state.chips) {
        // One seat: a face, name, role and model that call on the seat by name,
        // its speaking state in words, and a mute toggle beside it.
        const seat = el('div', 'huddle-seat');
        if (c.seat) seat.dataset.seat = c.seat;
        seat.style.setProperty('--chip-hue', HUE_BY_ROLE[c.role] ?? 'var(--primary)');
        const chip = el('button', 'huddle-chip');
        chip.type = 'button';
        const face = el('span', 'huddle-face', (c.display || '?').slice(0, 1).toUpperCase());
        face.setAttribute('aria-hidden', 'true');
        const text = el('span', 'huddle-seat-text');
        text.append(el('span', 'huddle-seat-name', c.display), el('span', 'huddle-seat-meta', [c.seatRole ?? c.role, c.modelName ?? c.model].filter(Boolean).join(', ')));
        const stateText = el('span', 'huddle-seat-state');
        chip.append(face, text, stateText);
        chip.title = `Call on ${c.display}: ${c.seatRole ?? c.role}, ${c.modelName ?? c.model ?? 'default model'}`;
        chip.addEventListener('click', () => { input.value = `${c.display}, ${input.value}`.replace(/,\s*$/, ', '); input.focus(); });
        const mute = el('button', 'huddle-mute');
        mute.type = 'button';
        // The chair holds the floor and cannot be muted.
        mute.hidden = Boolean(c.role === 'orchestrator');
        mute.addEventListener('click', () => toggleMute(c.id));
        seat.append(chip, mute);
        chipEls.set(c.id, chip);
        muteEls.set(c.id, mute);
        seatEls.set(c.id, seat);
        strip.appendChild(seat);
      }
    }
    for (const c of state.chips) {
      const chip = chipEls.get(c.id);
      const seat = seatEls.get(c.id);
      const mute = muteEls.get(c.id);
      const shown = c.muted ? 'muted' : c.state;
      if (chip.dataset.state !== shown) {
        chip.dataset.state = shown;
        seat.dataset.state = shown;
        chip.querySelector('.huddle-seat-state').textContent = shown;
        chip.setAttribute('aria-label', `Call on ${c.display}, ${c.seatRole ?? c.role}, ${c.modelName ?? c.model ?? 'default model'}, ${shown}`);
        mute.textContent = c.muted ? 'Unmute' : 'Mute';
        mute.setAttribute('aria-pressed', String(Boolean(c.muted)));
        mute.setAttribute('aria-label', `${c.muted ? 'Unmute' : 'Mute'} ${c.display}`);
      }
      const off = state.ending || state.ended;
      // A muted seat is never scheduled, so calling on it by name would do nothing.
      const noCall = off || Boolean(c.muted);
      if (chip.disabled !== noCall) chip.disabled = noCall;
      if (mute.disabled !== off) mute.disabled = off;
    }

    // Captions: settled lines are appended once; follow the bottom only if the
    // operator is already near it.
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    if (state.huddleId !== renderedHuddle || state.captions.length < renderedLines) {
      log.textContent = '';
      renderedLines = 0;
      renderedSummary = false;
      renderedHuddle = state.huddleId;
    }
    for (; renderedLines < state.captions.length; renderedLines += 1) log.appendChild(lineRow(state.captions[renderedLines]));
    if (state.ended && state.summary && !renderedSummary) {
      renderedSummary = true;
      const sum = el('section', 'huddle-summary');
      sum.setAttribute('aria-label', 'Huddle summary');
      sum.appendChild(el('div', 'huddle-summary-text', state.summary));
      log.appendChild(sum);
    }
    const pKey = state.partial ? `${state.partial.speaker}|${state.partial.text}` : '';
    if (pKey !== partialKey) {
      partialKey = pKey;
      partialEl.textContent = '';
      if (state.partial) partialEl.appendChild(lineRow({ speaker: state.partial.speaker, text: state.partial.text, partial: true }));
    }
    if (state.extracted !== renderedExtracted) {
      renderedExtracted = state.extracted;
      decide.hidden = !state.extracted;
      if (state.extracted) { buildDecisions(decisionsView(state)); loadProjects(); }
    }
    const dv = decisionsView(state);
    const picked = pickBoxes.some((b) => b?.checked);
    const kickOff = state.ending || kicking || !projSel.value;
    planBtn.disabled = kickOff || !dv.canPlan;
    queueBtn.disabled = kickOff || !dv.canQueue || !picked;
    backlogBtn.setAttribute('aria-pressed', String(asBacklog));
    const anyMind = state.captions.some((c) => c.speaker !== 'operator');
    decideBtn.disabled = state.ending || state.deciding || !anyMind;
    decideBtn.textContent = state.deciding ? 'Deciding...' : 'Decide';
    talkBtn.textContent = voice.talking ? 'Listening' : 'Mic';
    talkBtn.setAttribute('aria-pressed', String(voice.talking));
    talkBtn.disabled = !voice.support.ears || state.ended || state.ending;
    talkBtn.title = voice.support.ears ? 'Speak instead of typing (push to talk)' : voice.support.why;
    voicesBtn.setAttribute('aria-pressed', String(voice.voicesOn));
    voicesBtn.textContent = voice.mouthKind === 'neural' ? 'Voices: neural' : 'Voices';
    if (voice.earsKind === 'local') talkBtn.title = 'Speak instead of typing (heard on this machine)';
    voicesBtn.disabled = !voice.support.mouths;
    voicesBtn.title = voice.support.mouths ? 'Hear the replies spoken' : 'This browser has no speech synthesis.';
    talkBtn.dataset.live = voice.talking ? 'true' : 'false';
    const empty = !state.huddleId ? (state.status ? '' : 'Starting the huddle...')
      : (!state.captions.length && !state.partial && !state.ended ? 'Nobody has spoken yet. Say something, or click a name to address them.' : '');
    if (emptyNote.textContent !== empty) emptyNote.textContent = empty;
    emptyNote.hidden = !empty;
    if (nearBottom) scroller.scrollTop = scroller.scrollHeight;

    // Status: written only when it changes, so the polite region does not re-announce.
    const sKey = `${state.status?.level ?? 'info'}|${state.status?.text ?? ''}`;
    if (sKey !== statusKey) {
      statusKey = sKey;
      statusLine.textContent = state.status?.text ?? '';
      statusLine.dataset.level = state.status?.level ?? 'info';
    }
    statusLine.dataset.busy = state.ending ? 'true' : 'false';
    dock.setAttribute('aria-busy', String(state.ending));
    dock.dataset.phase = state.ending ? 'ending' : state.ended ? 'ended' : state.huddleId ? 'live' : 'idle';
    // Typing is never blocked by a turn in flight (a new line interrupts it);
    // it is blocked only once the huddle is ending or over.
    const closed = state.ended || state.ending;
    input.disabled = closed;
    send.disabled = closed;
    interruptBtn.disabled = closed || !state.huddleId;
    fileBtn.disabled = state.ending;
    endBtn.disabled = state.ending;
    endBtn.textContent = state.ending ? 'Saving...' : state.ended || !state.huddleId ? 'Close' : 'End and save';
    recordBtn.hidden = !(state.ended && state.huddleId);
    agendaBtn.setAttribute('aria-expanded', String(agendaOpen));
    agendaEl.dataset.open = String(agendaOpen);
    agendaRefresh.disabled = agendaBusy || state.ended || state.ending || !anyMind;
    agendaRefresh.textContent = agendaBusy ? 'Updating...' : 'Update';
    const aKey = JSON.stringify([state.agenda, state.answered, anyMind]);
    if (aKey !== agendaKey) {
      agendaKey = aKey;
      const av = agendaView(state);
      agendaQuestion.textContent = av.question;
      agendaQuestion.hidden = !av.question;
      agendaList.textContent = '';
      for (const it of av.items) {
        const li = el('li', 'huddle-agenda-item' + (it.answered ? ' huddle-agenda-answered' : ''));
        li.value = it.n;
        li.appendChild(el('span', 'huddle-agenda-text', it.text));
        if (it.lean) li.appendChild(el('span', 'huddle-agenda-lean', `Leaning: ${it.lean}`));
        if (it.answered) li.appendChild(el('span', 'huddle-agenda-done', 'answered'));
        agendaList.appendChild(li);
      }
      agendaNote.textContent = av.empty ? (anyMind ? 'No open questions. Press Update after the next few turns.' : 'The agenda appears once the team has spoken.') : 'Answer inline in the box below, for example: 1 yes, 2 b';
      agendaNote.dataset.level = 'info';
    }
  }

  launch.addEventListener('click', async () => {
    // A live (or finished, not yet closed) huddle: the launcher only shows or
    // hides the panel (a second click used to start a second huddle and
    // orphan the first).
    if (state.huddleId || starting) {
      setOpen(dock.classList.contains('hidden'));
      if (!dock.classList.contains('hidden') && !state.ended) input.focus();
      return;
    }
    starting = true;
    setOpen(true);
    // Made inside the click, so the browser lets it play without another gesture.
    let audioCtx = null;
    try { audioCtx = upgrade ? null : new window.AudioContext(); } catch { /* no Web Audio: the loader reports it */ }
    try {
      openEvents();
      const snap = await postJson('/api/huddle', {});
      voice.reset();
      voice.setPersonas(snap.personas);
      upgradeVoices(snap.personas, audioCtx);
      loadProjects();
      apply({ type: 'huddle', huddleId: snap.id, event: 'started', personas: snap.personas });
      // Seat problems found at start are broadcast before this dock is listening.
      if (Array.isArray(snap.notes) && snap.notes.length) status(snap.notes.join(' '));
      input.focus();
    } catch (err) {
      closeEvents();
      status(`Could not start a huddle: ${err.message}`);
    } finally { starting = false; }
  });
  function sayText(text) {
    if (!text || !state.huddleId || state.ended || state.ending) return;
    const id = state.huddleId;
    // Not awaited by the UI beyond error handling: the request resolves when
    // the turn finishes, and the operator may type again meanwhile.
    // The project rides along for a spoken work command ("make this work"),
    // which files into it.
    postJson(`/api/huddle/${id}/say`, { text, ...(projSel.value ? { project: projSel.value } : {}) }).then(() => refreshAgenda(), (err) => {
      if (state.huddleId !== id) return;
      status(`Not sent: ${err.message}`);
      if (!input.value && !input.disabled) input.value = text;
    });
  }
  // Typed or spoken, one path: a line that is wholly numbered answers to the
  // agenda's open questions ("1 yes, 2 b"), anything else is an ordinary turn.
  function submitLine(text) {
    const x = expandAgendaAnswers(text, state.agenda);
    if (x) { apply({ type: 'huddle-local', event: 'answered', indexes: x.answered }); sayText(x.text); } else sayText(text);
  }
  async function refreshAgenda() {
    if (!state.huddleId || state.ended || state.ending || agendaBusy) return;
    const id = state.huddleId;
    agendaBusy = true;
    render();
    try {
      const out = await postJson(`/api/huddle/${id}/agenda`, {});
      // The SSE frame normally lands first; the response is the backstop.
      if (state.huddleId === id && JSON.stringify(state.agenda) !== JSON.stringify(out)) apply({ type: 'huddle', huddleId: id, event: 'agenda', ...out });
    } catch (err) {
      if (state.huddleId === id) { agendaNote.textContent = `Agenda not updated: ${err.message}. Press Update to try again.`; agendaNote.dataset.level = 'error'; }
    } finally { agendaBusy = false; render(); }
  }
  agendaRefresh.addEventListener('click', () => refreshAgenda());
  agendaBtn.addEventListener('click', () => { agendaOpen = !agendaOpen; render(); });
  async function toggleMute(pid) {
    const c = state.chips.find((x) => x.id === pid);
    if (!c || !state.huddleId || state.ended) return;
    const id = state.huddleId;
    try {
      const out = await postJson(`/api/huddle/${id}/mute`, { seat: pid, muted: !c.muted });
      if (state.huddleId === id) apply({ type: 'huddle', huddleId: id, event: 'muted', muted: out.muted });
    } catch (err) { status(`Could not ${c.muted ? 'unmute' : 'mute'} ${c.display}: ${err.message}`); }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    submitLine(text);
  });
  talkBtn.addEventListener('click', () => voice.setTalk(!voice.talking));
  voicesBtn.addEventListener('click', () => voice.setVoicesOn(!voice.voicesOn));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  dock.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); launch.focus(); } });
  interruptBtn.addEventListener('click', async () => {
    if (!state.huddleId) return;
    try { await postJson(`/api/huddle/${state.huddleId}/interrupt`, {}); }
    catch (err) { status(`Interrupt failed: ${err.message}`); }
  });
  decideBtn.addEventListener('click', async () => {
    if (!state.huddleId || state.deciding) return;
    const id = state.huddleId;
    apply({ type: 'huddle-local', event: 'deciding', on: true });
    try {
      const out = await postJson(`/api/huddle/${id}/decide`, {});
      // The SSE decisions frame normally lands first; the response is the backstop.
      if (state.huddleId === id && !state.extracted) apply({ type: 'huddle', huddleId: id, event: 'decisions', ...out });
      apply({ type: 'huddle-local', event: 'deciding', on: false });
    } catch (err) {
      apply({ type: 'huddle-local', event: 'deciding', on: false });
      status(`Decide failed: ${err.message}`);
    }
  });
  backlogBtn.addEventListener('click', () => { asBacklog = !asBacklog; render(); });
  async function kickoff(mode) {
    if (!state.huddleId || kicking) return;
    const id = state.huddleId;
    if (!projSel.value) { status('Pick a project first: the card runs in that project.'); return; }
    const body = { mode, state: asBacklog ? 'backlog' : 'queued', project: projSel.value };
    if (mode === 'actions') body.picks = pickBoxes.map((b, i) => (b?.checked ? i : -1)).filter((i) => i >= 0);
    kicking = true;
    render();
    try {
      const out = await postJson(`/api/huddle/${id}/kickoff`, body);
      apply({ type: 'huddle-local', event: 'kickoff', cards: out.cards, repeat: out.repeat });
      const cards = out.cards ?? [];
      const names = cards.map((c) => c.id).join(', ');
      // The board's parking state is 'held': the runner never starts it.
      const queued = cards.length > 0 && cards.every((c) => c.state === 'queued');
      const threaded = cards.length > 0 && cards.every((c) => c.thread);
      const where = (queued ? 'for the runner' : 'on the board, held until you queue it') + (threaded ? ', each with its own Slack thread' : cards.find((c) => c.slackError) ? ` (no Slack thread: ${cards.find((c) => c.slackError).slackError})` : '');
      status(out.repeat ? `Already filed: ${names}.` : `${queued ? 'Queued' : 'Filed'} ${names} ${where}.`, 'info');
    } catch (err) { status(`Could not kick off: ${err.message}`); }
    finally { kicking = false; render(); }
  }
  planBtn.addEventListener('click', () => kickoff('plan'));
  queueBtn.addEventListener('click', () => kickoff('actions'));
  fileBtn.addEventListener('click', async () => {
    const payload = fileThatPayload(state);
    if (!payload) { status('Nothing to file yet.', 'info'); return; }
    try {
      const card = await postJson('/api/backlog', payload);
      status(`Filed ${card.id ?? 'a card'}.`, 'info');
    } catch (err) { status(`Could not file it: ${err.message}`); }
  });
  // End and save: end the huddle, keep the four-part record, then offer to file
  // it. Nothing is filed until File as card or Draft spec is pressed here.
  let filing = false;
  function renderRecord(note, level = 'info') {
    const v = recordView(state);
    if (note != null) { dlgState.textContent = note; dlgState.dataset.level = level; }
    dlgBody.textContent = '';
    if (v) {
      const part = (title, nodes) => {
        const g = el('div', 'huddle-dgroup');
        g.appendChild(el('h4', 'huddle-dhead', title));
        if (!nodes.length) g.appendChild(el('div', 'huddle-dnone', 'None.'));
        else { const ul = el('ul', 'huddle-dlist'); for (const n of nodes) ul.appendChild(n); g.appendChild(ul); }
        dlgBody.appendChild(g);
      };
      const li = (text, extra) => { const n = el('li', null, text); if (extra) n.appendChild(el('span', 'huddle-against', extra)); return n; };
      const p = el('div', 'huddle-dgroup');
      p.appendChild(el('h4', 'huddle-dhead', 'Problem'));
      p.appendChild(el('div', v.problem ? 'huddle-record-problem' : 'huddle-dnone', v.problem || 'Not stated in the huddle.'));
      dlgBody.appendChild(p);
      part('Decisions', v.decisions.map((d) => li(d.text, d.against ? `argued against by ${d.against}` : '')));
      part('Open questions', v.open.map((t) => li(t)));
      part('Next actions', v.actions.map((a) => li(a.detail ? `${a.title}: ${a.detail}` : a.title)));
    }
    fileCardBtn.disabled = !v || !v.canFile || filing || !dlgProj.value;
    draftBtn.disabled = !v || filing;
  }
  function showRecord(note, level) {
    if (!dlg.open) dlg.showModal();
    loadProjects();
    renderRecord(note, level);
  }
  async function saveRecord() {
    const id = state.huddleId;
    apply({ type: 'huddle-local', event: 'saving', on: true });
    showRecord('Saving the record...');
    try {
      const out = await postJson(`/api/huddle/${id}/record`, {});
      apply({ type: 'huddle-local', event: 'record', record: out.record });
      showRecord('Record saved. Nothing is filed until you press a button below.');
    } catch (err) {
      apply({ type: 'huddle-local', event: 'saving', on: false });
      showRecord(`Could not save the record: ${err.message}. Close this and press Record to try again.`, 'error');
    }
  }
  endBtn.addEventListener('click', async () => {
    if (state.ending) return;
    if (!state.huddleId || state.ended) { if (dlg.open) dlg.close(); voice.setTalk(false); voice.reset(); setOpen(false); closeEvents(); state = initialHuddleState(); agendaKey = ''; agendaOpen = false; render(); launch.focus(); return; }
    const id = state.huddleId;
    voice.setTalk(false);
    voice.reset();
    apply({ type: 'huddle-local', event: 'ending' });
    showRecord('Ending the huddle... this can take up to 10 seconds.');
    try {
      const out = await postJson(`/api/huddle/${id}/end`, {});
      // The SSE `ended` frame normally lands first; the response is the backstop.
      if (!state.ended) apply({ type: 'huddle', huddleId: id, event: 'ended', summary: out.summary, summaryPost: out.summaryPost });
    } catch (err) {
      apply({ type: 'huddle-local', event: 'ending', on: false });
      dlg.close();
      status(`End failed: ${err.message}`);
      return;
    }
    await saveRecord();
  });
  recordBtn.addEventListener('click', () => { if (state.record) showRecord(); else saveRecord(); });
  dlgClose.addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  dlgProj.addEventListener('change', () => { try { localStorage.setItem(PROJECT_KEY, dlgProj.value); } catch { /* private mode */ } projSel.value = dlgProj.value; renderRecord(); });
  fileCardBtn.addEventListener('click', async () => {
    if (filing || !dlgProj.value) return;
    filing = true;
    renderRecord('Filing the card...');
    try {
      const out = await postJson(`/api/huddle/${state.huddleId}/kickoff`, { mode: 'record', state: 'backlog', project: dlgProj.value });
      const names = (out.cards ?? []).map((c) => c.id).join(', ');
      filing = false;
      renderRecord(out.repeat ? `Already filed: ${names}.` : `Filed ${names} on the board, held until you queue it.`);
    } catch (err) {
      filing = false;
      renderRecord(`Could not file the card: ${err.message}. Press File as card to try again.`, 'error');
    }
  });
  draftBtn.addEventListener('click', async () => {
    try {
      const out = await postJson(`/api/huddle/${state.huddleId}/spec`, {});
      const a = document.createElement('a');
      const url = URL.createObjectURL(new Blob([out.markdown], { type: 'text/markdown' }));
      a.href = url;
      a.download = out.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      renderRecord(`Spec draft downloaded as ${out.filename} and kept with the record. It is not committed anywhere.`);
    } catch (err) { renderRecord(`Could not draft the spec: ${err.message}.`, 'error'); }
  });
  render();

  return { close() {
    voice.destroy();
    closeEvents();
    launch.remove();
    dock.remove();
  } };
}
