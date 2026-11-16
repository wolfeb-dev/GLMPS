// web/orchestration/board-drawer.js - card detail/edit slide-over drawer
// XSS discipline: textContent/createElement only; clear() empties containers.
import { updateBacklogItem, deleteBacklogItem, runBacklogItem, appendTicketDevlog } from '../shared/api.js';
import { gateClass } from './board-model.js';
import { markSelected } from '../shared/interactive-item.js';
import { formatTime } from '../shared/time-format.js';

const STATES = ['queued', 'held', 'in_progress', 'in_review', 'idle', 'done', 'cancelled', 'archived'];
const RUNNER_LABELS = {
  'vscode': 'VS Code', 'vscode-insiders': 'VS Code Insiders', 'cursor': 'Cursor',
  'windsurf': 'Windsurf', 'antigravity': 'Antigravity', 'native-terminal': 'a terminal', 'headless': 'the background (headless)',
};
const STATE_LABELS = {
  queued: 'Queued', held: 'Backlog',
  in_progress: 'In Progress', in_review: 'In Review', idle: 'Paused',
  done: 'Done', cancelled: 'Cancelled', archived: 'Archived',
};
// Ids are <project-slug>-<n>; legacy glmps-## still matches (mirrors backlog-store.js).
const TICKET_ID_RE = /^[a-z0-9][a-z0-9-]*-\d+$/;
const PRIORITY_OPTIONS = [
  { value: '', label: 'None' },
  { value: '0', label: 'Low' },
  { value: '1', label: 'Normal' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Urgent' },
];
const MODE_OPTIONS = [
  { value: '', label: 'Auto (headless only under an open host)' },
  { value: 'interactive', label: 'Interactive' },
  { value: 'headless', label: 'Headless' },
];
function lastRunLabel(rs) {
  if (!rs?.launcher) return null;
  return rs.launcher === 'headless' ? 'headless' : `interactive (${rs.launcher})`;
}
// TaskSpec intent contract (glmps-69) - optional goal/boundary metadata
// rendered into the queue-runner launch header (server/lib/orchestration/queue-runner.js
// renderSpec). '' means the field is unset; normalizeSpec drops it server-side.
const SPEC_ACT_OPTIONS = [
  { value: '', label: '\u2014' },
  { value: 'act', label: 'Act' },
  { value: 'assess', label: 'Assess only' },
];
const SPEC_RISK_OPTIONS = [
  { value: '', label: '\u2014' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const SPEC_PROFILE_OPTIONS = [
  { value: '', label: 'Worker (default)' },
  { value: 'worker', label: 'Worker' },
  { value: 'critic', label: 'Critic' },
];

function fmt(ts) {
  if (!ts) return '\u2014';
  return formatTime(ts) || String(ts);
}

function mk(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function labeledField(labelText, control) {
  const wrap = mk('div', 'drawer-field');
  const lbl = mk('label', 'drawer-label');
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  wrap.appendChild(control);
  return wrap;
}

// the one open drawer (it lives on document.body, outside
// any lens root), so a lens can close it on unmount or when its selection
// is cleared, and a replaced drawer takes its Escape listener with it.
let active = null;

export function closeCardDrawer() {
  if (active) { const a = active; active = null; a.close(); }
  for (const s of document.querySelectorAll('.backlog-drawer-scrim')) s.remove();
}

export function openCardDrawer(item, { onChange } = {}) {
  // Prevent duplicate drawers
  closeCardDrawer();

  // Scrim
  const scrim = mk('div', 'backlog-drawer-scrim');

  // The scrim covers the board, so the drawer is modal: focus goes in, Tab
  // stays in, and focus returns to the card that opened it.
  const opener = document.activeElement;
  const panel = mk('aside', 'backlog-drawer');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', item.id ? `Card ${item.id}` : 'Card');

  const header = mk('div', 'drawer-header');
  const headerLeft = mk('div', 'drawer-header-left');

  const titleInput = mk('input', 'drawer-title-input');
  titleInput.type = 'text';
  titleInput.value = item.title ?? '';
  titleInput.setAttribute('aria-label', 'Card title');

  const idTag = mk('span', 'drawer-id-tag');
  idTag.textContent = item.id ? String(item.id).slice(0, 8) : '';

  headerLeft.appendChild(titleInput);
  headerLeft.appendChild(idTag);

  const closeBtn = mk('button', 'drawer-close-btn');
  closeBtn.textContent = '\u2715';
  closeBtn.setAttribute('aria-label', 'Close drawer');

  header.appendChild(headerLeft);
  header.appendChild(closeBtn);

  const body = mk('div', 'drawer-body');

  // Prompt textarea
  const promptTA = mk('textarea', 'drawer-textarea');
  promptTA.value = item.prompt ?? '';
  promptTA.rows = 4;
  promptTA.setAttribute('aria-label', 'Prompt');
  body.appendChild(labeledField('Prompt', promptTA));

  // Description textarea
  const descTA = mk('textarea', 'drawer-textarea');
  descTA.value = item.description ?? '';
  descTA.rows = 3;
  descTA.setAttribute('aria-label', 'Description');
  body.appendChild(labeledField('Description', descTA));

  const acField = mk('div', 'drawer-field');
  const acLabel = mk('label', 'drawer-label');
  acLabel.textContent = 'Acceptance Criteria';
  acField.appendChild(acLabel);

  const acList = mk('div', 'drawer-ac-list');
  acField.appendChild(acList);
  const acRows = [];

  function addAcRow(text = '', done = false) {
    const row = mk('div', 'drawer-ac-row');

    const checkbox = mk('input', 'drawer-ac-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = !!done;
    checkbox.setAttribute('aria-label', 'Criterion done');

    const textInput = mk('input', 'drawer-input drawer-ac-text');
    textInput.type = 'text';
    textInput.value = text;
    textInput.placeholder = 'Criterion\u2026';
    textInput.setAttribute('aria-label', 'Criterion text');

    const removeBtn = mk('button', 'drawer-ac-remove');
    removeBtn.type = 'button';
    removeBtn.textContent = '\u2715';
    removeBtn.setAttribute('aria-label', 'Remove criterion');
    removeBtn.addEventListener('click', () => {
      row.remove();
      const idx = acRows.findIndex(r => r.row === row);
      if (idx !== -1) acRows.splice(idx, 1);
    });

    row.appendChild(checkbox);
    row.appendChild(textInput);
    row.appendChild(removeBtn);
    acList.appendChild(row);
    acRows.push({ row, checkbox, textInput });
  }

  for (const c of (item.acceptanceCriteria ?? [])) addAcRow(c.text, c.done);

  const addAcBtn = mk('button', 'drawer-ac-add');
  addAcBtn.type = 'button';
  addAcBtn.textContent = '+ Add criterion';
  addAcBtn.addEventListener('click', () => addAcRow());
  acField.appendChild(addAcBtn);
  body.appendChild(acField);

  // Assignee
  const assigneeInput = mk('input', 'drawer-input');
  assigneeInput.type = 'text';
  assigneeInput.value = item.assignee ?? '';
  assigneeInput.setAttribute('aria-label', 'Assignee');
  body.appendChild(labeledField('Assignee', assigneeInput));

  // Due date
  const dueInput = mk('input', 'drawer-input');
  dueInput.type = 'date';
  dueInput.value = item.dueDate ?? '';
  dueInput.setAttribute('aria-label', 'Due date');
  body.appendChild(labeledField('Due date', dueInput));

  // Blocked by (comma-separated ticket ids)
  const blockedInput = mk('input', 'drawer-input');
  blockedInput.type = 'text';
  blockedInput.value = (item.blockedBy ?? []).join(', ');
  blockedInput.placeholder = 'glmps-12, glmps-34';
  blockedInput.setAttribute('aria-label', 'Blocked by');
  body.appendChild(labeledField('Blocked by', blockedInput));

  // Relevant files (one path per line)
  const filesTA = mk('textarea', 'drawer-textarea');
  filesTA.value = (item.relevantFiles ?? []).join('\n');
  filesTA.rows = 3;
  filesTA.setAttribute('aria-label', 'Relevant files');
  body.appendChild(labeledField('Relevant files', filesTA));

  // Deferred refs - read-only chips (populated by other tickets deferring work here)
  const deferredRefs = item.deferredRefs ?? [];
  if (deferredRefs.length > 0) {
    const drField = mk('div', 'drawer-field');
    const drLabel = mk('label', 'drawer-label');
    drLabel.textContent = 'Deferred Refs';
    drField.appendChild(drLabel);
    const chipRow = mk('div', 'drawer-chip-row');
    for (const ref of deferredRefs) {
      const chip = mk('span', 'drawer-chip');
      chip.textContent = ref;
      chipRow.appendChild(chip);
    }
    drField.appendChild(chipRow);
    body.appendChild(drField);
  }

  const devLogField = mk('div', 'drawer-field');
  const devLogLabel = mk('label', 'drawer-label');
  devLogLabel.textContent = 'Dev Log';
  devLogField.appendChild(devLogLabel);

  const devLogList = mk('div', 'drawer-devlog-list');
  devLogField.appendChild(devLogList);

  function renderDevLog(entries) {
    devLogList.textContent = ''; // clear only - repopulated via textContent/createElement below
    if (!entries || entries.length === 0) {
      const empty = mk('div', 'drawer-devlog-empty');
      empty.textContent = 'No notes yet.';
      devLogList.appendChild(empty);
      return;
    }
    for (const entry of entries) { // append-only log: oldest first, newest last
      const row = mk('div', 'drawer-devlog-row');
      const ts = mk('span', 'drawer-devlog-ts');
      ts.textContent = fmt(entry.ts);
      const by = mk('span', 'drawer-devlog-by');
      by.textContent = entry.by ?? 'agent';
      const text = mk('span', 'drawer-devlog-text');
      text.textContent = entry.text ?? '';
      row.appendChild(ts);
      row.appendChild(by);
      row.appendChild(text);
      devLogList.appendChild(row);
    }
  }
  renderDevLog(item.devLog ?? []);

  const devLogAddRow = mk('div', 'drawer-devlog-add');
  const noteInput = mk('input', 'drawer-input');
  noteInput.type = 'text';
  noteInput.placeholder = 'Add note\u2026';
  noteInput.setAttribute('aria-label', 'New dev log note');
  const noteBtn = mk('button', 'drawer-btn drawer-btn-muted drawer-devlog-add-btn');
  noteBtn.type = 'button';
  noteBtn.textContent = 'Add note';
  devLogAddRow.appendChild(noteInput);
  devLogAddRow.appendChild(noteBtn);
  devLogField.appendChild(devLogAddRow);
  body.appendChild(devLogField);

  async function submitDevLogNote() {
    if (noteBtn.disabled) return;
    const text = noteInput.value.trim();
    if (!text) return;
    noteBtn.disabled = true;
    const prevLabel = noteBtn.textContent;
    noteBtn.textContent = 'Adding\u2026';
    try {
      const result = await appendTicketDevlog(item.id, { text });
      if (result?.error) {
        emit('Could not add note: ' + result.error);
      } else {
        item.devLog = result.devLog ?? item.devLog;
        renderDevLog(item.devLog);
        noteInput.value = '';
        if (onChange) onChange();
      }
    } catch (err) {
      emit('Could not add note: ' + (err?.message ?? err));
    } finally {
      noteBtn.disabled = false;
      noteBtn.textContent = prevLabel;
    }
  }
  noteBtn.addEventListener('click', submitDevLogNote);
  noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitDevLogNote(); }
  });

  if (item.gate) {
    const gateField = mk('div', 'drawer-field');
    const gateLabel = mk('label', 'drawer-label');
    gateLabel.textContent = 'Gate';
    gateField.appendChild(gateLabel);

    const gateBlock = mk('div', 'drawer-gate-block');
    const gateTop = mk('div', 'drawer-gate-top');

    const gc = gateClass(item.gate);
    const pill = mk('span', `board-pill board-gate-pill${gc ? ' ' + gc : ''}`);
    pill.textContent = `gate ${item.gate.status}`;
    gateTop.appendChild(pill);

    if (item.gate.risk) {
      const riskTag = mk('span', 'drawer-gate-risk');
      riskTag.textContent = `risk ${item.gate.risk}`;
      gateTop.appendChild(riskTag);
    }
    if (item.gate.by) {
      const byTag = mk('span', 'drawer-gate-by');
      byTag.textContent = `by ${item.gate.by}`;
      gateTop.appendChild(byTag);
    }
    gateBlock.appendChild(gateTop);

    if (Array.isArray(item.gate.evidence) && item.gate.evidence.length) {
      const evList = mk('ul', 'drawer-gate-evidence');
      for (const e of item.gate.evidence) {
        const li = mk('li');
        li.textContent = e;
        evList.appendChild(li);
      }
      gateBlock.appendChild(evList);
    }

    gateField.appendChild(gateBlock);
    body.appendChild(gateField);
  }

  // State select
  const stateSelect = mk('select', 'drawer-select');
  for (const s of STATES) {
    const opt = mk('option');
    opt.value = s;
    opt.textContent = STATE_LABELS[s] ?? s;
    if (s === item.state) opt.selected = true;
    stateSelect.appendChild(opt);
  }
  body.appendChild(labeledField('State', stateSelect));

  // Priority select
  const prioritySelect = mk('select', 'drawer-select');
  for (const { value, label } of PRIORITY_OPTIONS) {
    const opt = mk('option');
    opt.value = value;
    opt.textContent = label;
    const itemPriority = item.priority == null ? '' : String(item.priority);
    if (value === itemPriority) opt.selected = true;
    prioritySelect.appendChild(opt);
  }
  body.appendChild(labeledField('Priority', prioritySelect));

  // Launch mode override (unattended reliability T5). Auto lets the runner
  // decide from lineage; it applies from the card's next launch or resume.
  const modeSelect = mk('select', 'drawer-select');
  for (const { value, label } of MODE_OPTIONS) {
    const opt = mk('option');
    opt.value = value;
    opt.textContent = label;
    if (value === (item.mode ?? '')) opt.selected = true;
    modeSelect.appendChild(opt);
  }
  body.appendChild(labeledField('Launch mode', modeSelect));

  // Optional goal/boundary metadata; rendered into the queue-runner launch
  // header (see queue-runner.js renderSpec). All fields optional - leaving
  // everything at its default ' - '/'Worker (default)' is identical to no spec.
  const specTitle = mk('div', 'drawer-section-title');
  specTitle.textContent = 'Task Spec';
  body.appendChild(specTitle);

  const spec = item.spec ?? {};

  function specSelect(labelText, ariaLabel, options, selected) {
    const select = mk('select', 'drawer-select');
    select.setAttribute('aria-label', ariaLabel);
    for (const { value, label } of options) {
      const opt = mk('option');
      opt.value = value;
      opt.textContent = label;
      if (value === (selected ?? '')) opt.selected = true;
      select.appendChild(opt);
    }
    body.appendChild(labeledField(labelText, select));
    return select;
  }

  const specActSelect = specSelect('Act', 'Spec act', SPEC_ACT_OPTIONS, spec.act);
  const specRiskSelect = specSelect('Risk tier', 'Spec risk tier', SPEC_RISK_OPTIONS, spec.riskTier);
  const specProfileSelect = specSelect('Profile', 'Spec profile', SPEC_PROFILE_OPTIONS, spec.profile);

  const specDeliverableInput = mk('input', 'drawer-input');
  specDeliverableInput.type = 'text';
  specDeliverableInput.value = spec.deliverable ?? '';
  specDeliverableInput.placeholder = 'What does done look like\u2026';
  specDeliverableInput.setAttribute('aria-label', 'Spec deliverable');
  body.appendChild(labeledField('Deliverable', specDeliverableInput));

  const specEscalationInput = mk('input', 'drawer-input');
  specEscalationInput.type = 'text';
  specEscalationInput.value = spec.escalation ?? '';
  specEscalationInput.placeholder = 'When to stop and ask\u2026';
  specEscalationInput.setAttribute('aria-label', 'Spec escalation');
  body.appendChild(labeledField('Escalate when', specEscalationInput));

  // Branch input
  const branchInput = mk('input', 'drawer-input');
  branchInput.type = 'text';
  branchInput.value = item.branch ?? '';
  branchInput.setAttribute('aria-label', 'Branch');
  body.appendChild(labeledField('Branch', branchInput));

  // PR URL input
  const prUrlInput = mk('input', 'drawer-input');
  prUrlInput.type = 'text';
  prUrlInput.value = item.prUrl ?? '';
  prUrlInput.setAttribute('aria-label', 'PR URL');
  body.appendChild(labeledField('PR URL', prUrlInput));

  const meta = mk('div', 'drawer-meta-block');

  function metaRow(label, value) {
    const row = mk('div', 'drawer-meta-row');
    const k = mk('span', 'drawer-meta-key');
    k.textContent = label;
    const v = mk('span', 'drawer-meta-val');
    v.textContent = value ?? '\u2014';
    row.appendChild(k);
    row.appendChild(v);
    return row;
  }

  meta.appendChild(metaRow('Project', item.project));
  meta.appendChild(metaRow('Source', item.source));
  meta.appendChild(metaRow('Parent', item.parentId));
  meta.appendChild(metaRow('Last run', lastRunLabel(item.runSession)));
  meta.appendChild(metaRow('Created', fmt(item.createdAt)));
  meta.appendChild(metaRow('Updated', fmt(item.updatedAt)));
  const approval = item.testEditsApproved;
  const approvalRow = mk('div', 'drawer-meta-row');
  const approvalKey = mk('span', 'drawer-meta-key');
  approvalKey.textContent = 'Test edits';
  const approvalVal = mk('span', 'drawer-meta-val');
  approvalVal.textContent = approval ? `Approved by operator, ${fmt(approval.at)}` : 'Not approved';
  const approvalBtn = mk('button', 'drawer-btn');
  approvalBtn.type = 'button';
  approvalBtn.textContent = approval ? 'Revoke' : 'Approve test edits';
  approvalRow.appendChild(approvalKey);
  approvalRow.appendChild(approvalVal);
  approvalRow.appendChild(approvalBtn);
  meta.appendChild(approvalRow);
  approvalBtn.addEventListener('click', async () => {
    approvalBtn.disabled = true;
    try {
      const res = await updateBacklogItem(item.id, { testEditsApproved: approval ? null : true });
      if (res?.error) throw new Error(res.error);
      if (onChange) onChange();
      dismiss();
      document.removeEventListener('keydown', onKeyDown);
    } catch (err) {
      emit('Action failed: ' + (err?.message ?? err));
      approvalBtn.disabled = false;
    }
  });
  body.appendChild(meta);

  const activity = item.activity ?? [];
  if (activity.length > 0) {
    const actSection = mk('div', 'drawer-activity');
    const actTitle = mk('div', 'drawer-section-title');
    actTitle.textContent = 'Activity';
    actSection.appendChild(actTitle);

    const list = mk('ul', 'drawer-activity-list');
    // newest-first
    const sorted = [...activity].sort((a, b) => {
      const ta = a.ts ? new Date(a.ts).getTime() : 0;
      const tb = b.ts ? new Date(b.ts).getTime() : 0;
      return tb - ta;
    });
    for (const entry of sorted) {
      const li = mk('li', 'drawer-activity-item');
      const ts = mk('span', 'drawer-activity-ts');
      ts.textContent = fmt(entry.ts);
      const text = mk('span', 'drawer-activity-text');
      text.textContent = entry.text ?? '';
      li.appendChild(ts);
      li.appendChild(text);
      list.appendChild(li);
    }
    actSection.appendChild(list);
    body.appendChild(actSection);
  }

  const footer = mk('div', 'drawer-footer');

  // Run now: launch this card as a live session immediately, regardless of the
  // Auto-run toggle. Nothing to launch for finished cards, so disable those.
  const runBtn = mk('button', 'drawer-btn drawer-btn-run');
  runBtn.textContent = 'Run now';
  const finished = item.state === 'done' || item.state === 'cancelled' || item.state === 'archived';
  runBtn.disabled = finished;
  runBtn.title = finished
    ? `This card is ${STATE_LABELS[item.state]?.toLowerCase() ?? item.state} \u2014 nothing to run.`
    : 'Launch this card as a live session now.';

  const saveBtn = mk('button', 'drawer-btn drawer-btn-primary');
  saveBtn.textContent = 'Save';

  const cancelTicketBtn = mk('button', 'drawer-btn drawer-btn-warning');
  cancelTicketBtn.textContent = 'Cancel ticket';

  const deleteBtn = mk('button', 'drawer-btn drawer-btn-danger');
  deleteBtn.textContent = 'Delete';

  const closeFooterBtn = mk('button', 'drawer-btn drawer-btn-muted');
  closeFooterBtn.textContent = 'Close';

  footer.appendChild(runBtn);
  footer.appendChild(saveBtn);
  footer.appendChild(cancelTicketBtn);
  footer.appendChild(deleteBtn);

  const footerRight = mk('div', 'drawer-footer-right');
  footerRight.appendChild(closeFooterBtn);
  footer.appendChild(footerRight);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  scrim.appendChild(panel);
  document.body.appendChild(scrim);
  titleInput.focus();

  // Trigger animation on next frame
  requestAnimationFrame(() => {
    scrim.classList.add('open');
    panel.classList.add('open');
  });

  function dismiss() {
    if (active === self) active = null;
    scrim.classList.remove('open');
    panel.classList.remove('open');
    setTimeout(() => scrim.remove(), 200);
    // the card's detail (this drawer) is gone; nothing is the
    // selection any more until something else is opened.
    markSelected(null);
    if (opener && document.body.contains(opener)) opener.focus();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') { dismiss(); document.removeEventListener('keydown', onKeyDown); return; }
    if (e.key === 'Tab') keepTabInside(e);
  }
  function keepTabInside(e) {
    const stops = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
      .filter((n) => n.getClientRects().length);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', onKeyDown);
  const self = { close: () => { document.removeEventListener('keydown', onKeyDown); scrim.remove(); } };
  active = self;

  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) { dismiss(); document.removeEventListener('keydown', onKeyDown); }
  });

  closeBtn.addEventListener('click', () => { dismiss(); document.removeEventListener('keydown', onKeyDown); });
  closeFooterBtn.addEventListener('click', () => { dismiss(); document.removeEventListener('keydown', onKeyDown); });

  function getCurrentPriority() {
    const v = prioritySelect.value;
    return v === '' ? null : Number(v);
  }

  // Mirrors backlog-store.js normalizeSpec: only present fields are kept, and
  // an all-empty spec collapses to null (same as "no spec" pre-glmps-69).
  function getCurrentSpec() {
    const out = {};
    if (specActSelect.value) out.act = specActSelect.value;
    if (specRiskSelect.value) out.riskTier = specRiskSelect.value;
    if (specProfileSelect.value) out.profile = specProfileSelect.value;
    const esc = specEscalationInput.value.trim();
    if (esc) out.escalation = esc;
    const del = specDeliverableInput.value.trim();
    if (del) out.deliverable = del;
    return Object.keys(out).length ? out : null;
  }

  async function doMutation(fn) {
    try {
      await fn();
      if (onChange) onChange();
      dismiss();
      document.removeEventListener('keydown', onKeyDown);
    } catch (err) {
      emit('Action failed: ' + (err?.message ?? err));
    }
  }

  // Save - diff against original, PATCH only changed fields
  saveBtn.addEventListener('click', async () => {
    const patch = {};
    const newTitle = titleInput.value.trim();
    if (newTitle !== (item.title ?? '')) patch.title = newTitle;

    const newPrompt = promptTA.value;
    if (newPrompt !== (item.prompt ?? '')) patch.prompt = newPrompt;

    const newState = stateSelect.value;
    if (newState !== (item.state ?? '')) patch.state = newState;

    const newPriority = getCurrentPriority();
    const origPriority = item.priority == null ? null : Number(item.priority);
    if (newPriority !== origPriority) patch.priority = newPriority;

    const newMode = modeSelect.value || null;
    if (newMode !== (item.mode ?? null)) patch.mode = newMode;

    const newBranch = branchInput.value.trim();
    if (newBranch !== (item.branch ?? '')) patch.branch = newBranch || null;

    const newPrUrl = prUrlInput.value.trim();
    if (newPrUrl !== (item.prUrl ?? '')) patch.prUrl = newPrUrl || null;

    const newDescription = descTA.value;
    if (newDescription !== (item.description ?? '')) patch.description = newDescription;

    const newAssignee = assigneeInput.value.trim() || null;
    if (newAssignee !== (item.assignee ?? null)) patch.assignee = newAssignee;

    const newDueDate = dueInput.value || null;
    if (newDueDate !== (item.dueDate ?? null)) patch.dueDate = newDueDate;

    const newBlockedBy = blockedInput.value.split(',').map(s => s.trim()).filter(s => TICKET_ID_RE.test(s));
    if (JSON.stringify(newBlockedBy) !== JSON.stringify(item.blockedBy ?? [])) patch.blockedBy = newBlockedBy;

    const newRelevantFiles = filesTA.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (JSON.stringify(newRelevantFiles) !== JSON.stringify(item.relevantFiles ?? [])) patch.relevantFiles = newRelevantFiles;

    const newAC = acRows.map(r => ({ text: r.textInput.value, done: r.checkbox.checked })).filter(c => c.text.trim());
    if (JSON.stringify(newAC) !== JSON.stringify(item.acceptanceCriteria ?? [])) patch.acceptanceCriteria = newAC;

    const newSpec = getCurrentSpec();
    if (JSON.stringify(newSpec) !== JSON.stringify(item.spec ?? null)) patch.spec = newSpec;

    if (Object.keys(patch).length === 0) { dismiss(); document.removeEventListener('keydown', onKeyDown); return; }

    await doMutation(() => updateBacklogItem(item.id, patch));
  });

  // Run now - launch this specific card; keep the drawer open on failure so the
  // reason stays in view.
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    const prev = runBtn.textContent;
    runBtn.textContent = 'Launching\u2026';
    try {
      const { status, body } = await runBacklogItem(item.id);
      if (status === 200) {
        emit(`Launched in ${RUNNER_LABELS[body.target] ?? body.target ?? 'your editor'}`);
        if (onChange) onChange();
        dismiss();
        document.removeEventListener('keydown', onKeyDown);
      } else {
        emit(body?.error ? `Couldn't run: ${body.error}` : "Couldn't start the session");
        runBtn.disabled = false;
        runBtn.textContent = prev;
      }
    } catch {
      emit("Couldn't reach the runner");
      runBtn.disabled = false;
      runBtn.textContent = prev;
    }
  });

  // Cancel ticket
  cancelTicketBtn.addEventListener('click', async () => {
    await doMutation(() => updateBacklogItem(item.id, { state: 'cancelled' }));
  });

  // Delete
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm('Delete this ticket? This cannot be undone.')) return;
    await doMutation(() => deleteBacklogItem(item.id));
  });

  return { dismiss };
}

function emit(msg) { window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg })); }
