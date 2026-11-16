// web/surface/declared/policy.js
// Guardrail Policy Editor - Surface's declared panel (D2, Governance dissolved).
// XSS discipline: ALL server/user-derived data via textContent/createElement.
// innerHTML is not used; containers are emptied with clear().

import { getPolicy, savePolicy, previewPolicy, pushPolicy } from '../../shared/api.js';
import { openLibraryPicker } from './policy-library.js';
import { bindItem } from '../../shared/interactive-item.js';
import { linkFor } from '../../shared/deep-link.js';

import { clear } from '../../shared/dom-util.js';
export { renderPolicy };


function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function txt(tag, cls, text) {
  const n = el(tag, cls);
  n.textContent = String(text ?? '');
  return n;
}

let _counter = 0;
function uid() { return `pol${++_counter}`; }

// Normalize directive text for de-duplication (against what's already in the policy).
const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();


function collectPolicy(listEl) {
  return [...listEl.querySelectorAll('.pol-directive-row')].map(row => ({
    id:      row.dataset.id,
    text:    row.querySelector('.pol-directive-text').value.trim(),
    enabled: row.querySelector('.pol-toggle-input').checked,
    tags:    row.querySelector('.pol-tag-input').value
               .split(',').map(t => t.trim()).filter(Boolean),
  }));
}

function collectTargets(listEl) {
  return [...listEl.querySelectorAll('.pol-target-row')].map(row => ({
    vendor: row.querySelector('.pol-vendor-select').value,
    path:   row.querySelector('.pol-path-input').value.trim(),
  })).filter(t => t.vendor && t.path);
}


function buildDirectiveRow(d) {
  const rowId = uid();
  const row = el('div', 'pol-directive-row');
  row.dataset.id = d.id || rowId;
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Directive');

  // Enable toggle
  const toggleLabel = el('label', 'pol-toggle');
  const toggleInput = el('input');
  toggleInput.type = 'checkbox';
  toggleInput.className = 'pol-toggle-input';
  toggleInput.checked = d.enabled !== false;
  toggleInput.setAttribute('aria-label', 'Enable this directive');
  const track = el('span', 'pol-toggle-track');
  track.appendChild(el('span', 'pol-toggle-thumb'));
  toggleLabel.appendChild(toggleInput);
  toggleLabel.appendChild(track);
  if (!toggleInput.checked) row.classList.add('pol-directive-dim');
  toggleInput.addEventListener('change', () => {
    row.classList.toggle('pol-directive-dim', !toggleInput.checked);
  });
  row.appendChild(toggleLabel);

  // Directive text (textarea - directives can be long sentences)
  const textarea = el('textarea', 'pol-directive-text');
  textarea.rows = 2;
  textarea.placeholder = 'Enter a guardrail directive\u2026';
  textarea.setAttribute('aria-label', 'Directive text');
  textarea.value = d.text ?? '';
  row.appendChild(textarea);

  // Tags (comma-separated - tool-native format, no complex chip UI needed here)
  const tagWrap = el('div', 'pol-tag-wrap');
  const tagId = `pol-tag-${rowId}`;
  const tagLabel = txt('label', 'pol-field-label', 'Tags');
  tagLabel.setAttribute('for', tagId);
  const tagInput = el('input', 'pol-tag-input');
  tagInput.id = tagId;
  tagInput.type = 'text';
  tagInput.placeholder = 'tag1, tag2';
  tagInput.setAttribute('aria-label', 'Tags, comma-separated');
  tagInput.value = Array.isArray(d.tags) ? d.tags.join(', ') : '';
  tagWrap.appendChild(tagLabel);
  tagWrap.appendChild(tagInput);
  row.appendChild(tagWrap);

  // Delete
  const delBtn = el('button', 'pol-del-btn');
  delBtn.type = 'button';
  delBtn.setAttribute('aria-label', 'Remove directive');
  delBtn.textContent = '\u00D7';
  delBtn.addEventListener('click', () => row.remove());
  row.appendChild(delBtn);

  // Permalink: the row itself is a form group (its inputs need
  // their own clicks, so it does not become a button); a small control
  // inside it is what's deep-linkable and clickable/keyboard-reachable.
  const permalink = el('button', 'pol-permalink');
  permalink.type = 'button';
  permalink.textContent = '#';
  const ruleId = d.id || rowId;
  bindItem(permalink, {
    type: 'policy-rule', id: ruleId,
    link: linkFor({ lens: 'surface', panel: 'declared', sel: { type: 'policy-rule', id: ruleId } }),
    open: () => { row.classList.add('pol-directive-row--focus'); row.scrollIntoView({ block: 'center' }); setTimeout(() => row.classList.remove('pol-directive-row--focus'), 2000); },
    label: 'Link to this directive',
  });
  row.appendChild(permalink);

  return row;
}


function buildTargetRow(t, vendors) {
  const row = el('div', 'pol-target-row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Push target');

  // Vendor select
  const vendorWrap = el('div', 'pol-target-field');
  const vendorId = `pol-vendor-${uid()}`;
  const vendorLabel = txt('label', 'pol-field-label', 'Vendor');
  vendorLabel.setAttribute('for', vendorId);
  const sel = el('select', 'pol-vendor-select');
  sel.id = vendorId;
  for (const v of vendors) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    if (t.vendor === v.id) opt.selected = true;
    sel.appendChild(opt);
  }
  vendorWrap.appendChild(vendorLabel);
  vendorWrap.appendChild(sel);
  row.appendChild(vendorWrap);

  // Path input
  const pathWrap = el('div', 'pol-target-field pol-target-field-path');
  const pathId = `pol-path-${uid()}`;
  const pathLabel = txt('label', 'pol-field-label', 'Path');
  pathLabel.setAttribute('for', pathId);
  const pathInput = el('input', 'pol-path-input');
  pathInput.id = pathId;
  pathInput.type = 'text';
  const chosen = vendors.find(v => v.id === t.vendor);
  pathInput.placeholder = chosen?.defaultPath ?? 'path/from/repo/root';
  pathInput.setAttribute('aria-label', 'Target file path');
  pathInput.value = t.path ?? '';
  // Update placeholder when vendor changes
  sel.addEventListener('change', () => {
    const v = vendors.find(v => v.id === sel.value);
    if (v) pathInput.placeholder = v.defaultPath ?? '';
  });
  pathWrap.appendChild(pathLabel);
  pathWrap.appendChild(pathInput);
  row.appendChild(pathWrap);

  // Delete
  const delBtn = el('button', 'pol-del-btn');
  delBtn.type = 'button';
  delBtn.setAttribute('aria-label', 'Remove target');
  delBtn.textContent = '\u00D7';
  delBtn.addEventListener('click', () => row.remove());
  row.appendChild(delBtn);

  return row;
}


const ACTION_CLS = {
  created:   'pol-action-chip pol-action-created',
  updated:   'pol-action-chip pol-action-updated',
  unchanged: 'pol-action-chip pol-action-unchanged',
  skipped:   'pol-action-chip pol-action-skipped',
};

// Renders per-file before/after managed-section diffs.
// XSS: all item fields (vendor, path, before, after, action) go via textContent.

function renderPreviewPanel(outEl, results) {
  clear(outEl);
  outEl.classList.add('pol-out-active');
  outEl.appendChild(txt('h3', 'pol-out-heading', 'Preview \u2014 managed-section changes'));

  if (!Array.isArray(results) || results.length === 0) {
    outEl.appendChild(txt('p', 'pol-out-empty', 'No targets to preview.'));
    return;
  }

  for (const item of results) {
    const details = el('details', 'pol-preview-item');
    // Open by default when something will change; unchanged files stay collapsed.
    if (item.action !== 'unchanged') details.open = true;

    const summary = el('summary', 'pol-preview-summary');
    summary.appendChild(txt('span', 'pol-out-vendor', item.vendor ?? ''));
    summary.appendChild(txt('code', 'pol-out-path', item.path ?? ''));
    summary.appendChild(
      txt('span', ACTION_CLS[item.action] ?? 'pol-action-chip', item.action ?? '')
    );
    details.appendChild(summary);

    // Side-by-side before / after
    const split = el('div', 'pol-diff-split');

    const beforeCol = el('div', 'pol-diff-col');
    beforeCol.appendChild(txt('div', 'pol-diff-label', 'Before'));
    const bPre = el('pre', 'pol-diff-pre');
    const bCode = el('code');
    bCode.textContent = item.before ?? '(empty)';
    bPre.appendChild(bCode);
    beforeCol.appendChild(bPre);
    split.appendChild(beforeCol);

    const afterCol = el('div', 'pol-diff-col');
    afterCol.appendChild(txt('div', 'pol-diff-label', 'After'));
    const aPre = el('pre', 'pol-diff-pre');
    const aCode = el('code');
    aCode.textContent = item.after ?? '(empty)';
    aPre.appendChild(aCode);
    afterCol.appendChild(aPre);
    split.appendChild(afterCol);

    details.appendChild(split);
    outEl.appendChild(details);
  }
}


function renderPushPanel(outEl, results) {
  clear(outEl);
  outEl.classList.add('pol-out-active');
  outEl.appendChild(txt('h3', 'pol-out-heading', 'Push results'));

  if (!Array.isArray(results) || results.length === 0) {
    outEl.appendChild(txt('p', 'pol-out-empty', 'No results returned.'));
    return;
  }

  const list = el('ul', 'pol-result-list');
  for (const r of results) {
    const item = el('li', 'pol-result-row');
    item.appendChild(txt('span', 'pol-out-vendor', r.vendor ?? ''));
    item.appendChild(txt('code', 'pol-out-path', r.path ?? ''));
    item.appendChild(txt('span', ACTION_CLS[r.action] ?? 'pol-action-chip', r.action ?? ''));
    if (r.reason) {
      item.appendChild(txt('span', 'pol-result-reason', r.reason));
    }
    list.appendChild(item);
  }
  outEl.appendChild(list);
}


async function renderPolicy(container) {
  clear(container);

  // Loading state
  container.appendChild(txt('p', 'pol-loading', 'Loading\u2026'));

  let data;
  try {
    data = await getPolicy();
  } catch (err) {
    clear(container);
    container.appendChild(
      txt('p', 'pol-load-error', `Failed to load policy: ${err.message}`)
    );
    return;
  }

  clear(container);

  const vendors = Array.isArray(data.vendors) ? data.vendors : [];

  const wrap = el('div', 'pol-panel');

  const header = el('div', 'pol-header');
  header.appendChild(txt('h2', 'pol-heading', 'Guardrail Policy'));
  if (!data.configured) {
    // Green note - signals a capability to enable, not an error
    header.appendChild(
      txt('p', 'pol-unconfigured-note',
        'No baseline file found \u2014 save to create it with these directives.')
    );
  } else if (data.path) {
    header.appendChild(txt('code', 'pol-path-note', data.path));
  }
  wrap.appendChild(header);

  const dirSection = el('section', 'pol-section');
  dirSection.appendChild(txt('h3', 'pol-section-title', 'Directives'));

  const dirList = el('div', 'pol-directive-list');
  for (const d of (Array.isArray(data.policy) ? data.policy : [])) {
    dirList.appendChild(buildDirectiveRow(d));
  }
  dirSection.appendChild(dirList);

  const addDirBtn = el('button', 'pol-add-btn');
  addDirBtn.type = 'button';
  addDirBtn.textContent = '+ Add directive';
  addDirBtn.addEventListener('click', () => {
    const row = buildDirectiveRow({ id: '', text: '', enabled: true, tags: [] });
    dirList.appendChild(row);
    row.querySelector('.pol-directive-text')?.focus();
  });
  dirSection.appendChild(addDirBtn);

  // Load from library: open the picker; append selected directives, de-duped by text.
  const loadLibBtn = el('button', 'pol-add-btn pol-load-lib-btn');
  loadLibBtn.type = 'button';
  loadLibBtn.textContent = 'Load from library';
  loadLibBtn.addEventListener('click', () => {
    const existing = new Set(collectPolicy(dirList).map((d) => normText(d.text)));
    openLibraryPicker({
      existing,
      onAdd: (items) => {
        let added = 0;
        for (const it of (Array.isArray(items) ? items : [])) {
          const key = normText(it.text);
          if (!it.text || existing.has(key)) continue;
          existing.add(key);
          dirList.appendChild(buildDirectiveRow({ id: '', text: it.text, enabled: true, tags: it.tags || [] }));
          added++;
        }
        if (added) {
          // a throwing toast listener is logged, not swallowed.
          try { window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Added ${added} directive${added === 1 ? '' : 's'} from the library` })); }
          catch (e) { console.error('mc-toast dispatch failed', e); }
        }
      },
    });
  });
  dirSection.appendChild(loadLibBtn);
  wrap.appendChild(dirSection);

  const tgtSection = el('section', 'pol-section');
  tgtSection.appendChild(txt('h3', 'pol-section-title', 'Push targets'));

  const tgtList = el('div', 'pol-target-list');
  for (const t of (Array.isArray(data.targets) ? data.targets : [])) {
    tgtList.appendChild(buildTargetRow(t, vendors));
  }
  tgtSection.appendChild(tgtList);

  const addTgtBtn = el('button', 'pol-add-btn');
  addTgtBtn.type = 'button';
  addTgtBtn.textContent = '+ Add target';
  addTgtBtn.addEventListener('click', () => {
    const def = vendors[0] ?? { id: '', label: '' };
    const row = buildTargetRow({ vendor: def.id, path: '' }, vendors);
    tgtList.appendChild(row);
    row.querySelector('.pol-path-input')?.focus();
  });
  tgtSection.appendChild(addTgtBtn);
  wrap.appendChild(tgtSection);

  // Color encodes risk level: muted=safe, blue=read-only, green=writes files.
  const actionBar = el('div', 'pol-action-bar');

  // Auto-push toggle - when on, Save also pushes to vendor files immediately.
  // Defined before Save so the Save handler can read its state.
  const autoWrap = el('label', 'pol-autopush');
  const autoInput = el('input');
  autoInput.type = 'checkbox';
  // Reuse the directive-toggle visual (hidden input + styled track/thumb).
  autoInput.className = 'pol-toggle-input pol-autopush-input';
  autoInput.checked = data.autoPush === true;
  autoInput.setAttribute('aria-label', 'Auto-push to vendor files on save');
  const autoTrack = el('span', 'pol-toggle-track');
  autoTrack.appendChild(el('span', 'pol-toggle-thumb'));
  autoWrap.appendChild(autoInput);
  autoWrap.appendChild(autoTrack);
  autoWrap.appendChild(txt('span', 'pol-autopush-label', 'Auto-push on save'));
  const autoCaption = txt('p', 'pol-autopush-caption',
    'On: saving writes to the vendor files immediately. Off: save only, then preview and push manually.');

  // Save - always enabled, neutral. Honors the auto-push toggle.
  const saveBtn = el('button', 'pol-btn pol-btn-save');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save policy';
  saveBtn.addEventListener('click', async () => {
    const policy = collectPolicy(dirList);
    const targets = collectTargets(tgtList);
    const autoPush = autoInput.checked;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';
    // Task 16, SF-C: the save and the push-results render fail separately.
    // A render bug after the save landed must never read "Save failed"
    // (that invites a duplicate write); both failures are logged and shown
    // with their reason, like Preview and Push below.
    let saved;
    try {
      saved = await savePolicy(policy, targets, autoPush);
    } catch (err) {
      console.error('savePolicy failed', err);
      saveBtn.textContent = 'Save failed. Retry';
      clear(outEl);
      outEl.classList.add('pol-out-active');
      outEl.appendChild(txt('p', 'pol-load-error', `Save failed: ${err.message}`));
      setTimeout(() => { saveBtn.textContent = 'Save policy'; saveBtn.disabled = false; }, 2500);
      return;
    }
    saveBtn.textContent = autoPush ? 'Saved + pushed' : 'Saved';
    if (autoPush && saved && Array.isArray(saved.pushed)) {
      try { renderPushPanel(outEl, saved.pushed); }
      catch (err) {
        console.error('rendering the push results after a successful save failed', err);
        clear(outEl);
        outEl.classList.add('pol-out-active');
        outEl.appendChild(txt('p', 'pol-load-error', `Saved, but the push results could not be shown: ${err.message}`));
      }
    }
    setTimeout(() => { saveBtn.textContent = 'Save policy'; saveBtn.disabled = false; }, 1500);
  });
  actionBar.appendChild(saveBtn);

  // Preview - always enabled, blue (read-only)
  const previewBtn = el('button', 'pol-btn pol-btn-preview');
  previewBtn.type = 'button';
  previewBtn.textContent = 'Preview changes';
  let previewShown = false;

  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    previewBtn.textContent = 'Previewing\u2026';
    try {
      const results = await previewPolicy();
      renderPreviewPanel(outEl, results);
      previewShown = true;
      pushBtn.disabled = false;
      pushBtn.classList.remove('pol-btn-push-locked');
      pushBtn.title = '';
      previewBtn.textContent = 'Refresh preview';
    } catch (err) {
      clear(outEl);
      outEl.classList.add('pol-out-active');
      outEl.appendChild(
        txt('p', 'pol-load-error', `Preview failed: ${err.message}`)
      );
      previewBtn.textContent = 'Preview changes';
    } finally {
      previewBtn.disabled = false;
    }
  });
  actionBar.appendChild(previewBtn);

  // Push - locked (muted) until preview, then green; left-border accent signals "writes files"
  const pushBtn = el('button', 'pol-btn pol-btn-push pol-btn-push-locked');
  pushBtn.type = 'button';
  pushBtn.textContent = 'Push to vendors';
  pushBtn.disabled = true;
  pushBtn.title = 'Run Preview first to confirm changes, then push';

  pushBtn.addEventListener('click', async () => {
    if (!previewShown) return;
    pushBtn.disabled = true;
    pushBtn.textContent = 'Pushing\u2026';
    try {
      const results = await pushPolicy();
      renderPushPanel(outEl, results);
    } catch (err) {
      clear(outEl);
      outEl.classList.add('pol-out-active');
      outEl.appendChild(
        txt('p', 'pol-load-error', `Push failed: ${err.message}`)
      );
    } finally {
      pushBtn.textContent = 'Push to vendors';
      pushBtn.disabled = !previewShown;
    }
  });
  actionBar.appendChild(pushBtn);
  wrap.appendChild(actionBar);

  const autoRow = el('div', 'pol-autopush-row');
  autoRow.appendChild(autoWrap);
  autoRow.appendChild(autoCaption);
  wrap.appendChild(autoRow);

  // Hidden until a preview or push action is taken.
  const outEl = el('div', 'pol-output');
  wrap.appendChild(outEl);

  container.appendChild(wrap);
}
