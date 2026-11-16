// web/surface/declared/policy-library.js
// Guardrail Policy Library - picker drawer.
// XSS discipline: ALL library-derived data via textContent / createElement.
//                 innerHTML is not used; containers are emptied with clear().

import { getPolicyLibrary } from '../../shared/api.js';


import { clear } from '../../shared/dom-util.js';
let _isOpen      = false;
let _prevFocus   = null;
let _backdropEl  = null;
let _drawerEl    = null;
let _bodyEl      = null;
let _packRowEl   = null;
let _footerCountEl  = null;
let _footerAddBtn   = null;
let _searchEl    = null;
let _tagSelectEl  = null;
let _sevSelectEl  = null;
let _typeSelectEl = null;
let _closeBtnEl   = null;

let _libraryData    = null;
let _directivesById = new Map();
let _existing       = new Set();
let _onAdd          = null;

let _selectedIds   = new Set();
let _activePackIds = new Set();

let _filterSearch = '';
let _filterTag    = '';
let _filterSev    = '';
let _filterType   = '';

let _searchDebounce = null;


const normText = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();


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


/**
 * Open the Guardrail Policy Library picker drawer.
 *
 * @param {Object}      opts
 * @param {Set<string>} opts.existing  Normalized texts already in the policy.
 * @param {Function}    opts.onAdd     Called with Array<{id,text,type,tags,severity_hint}> on confirm.
 */
export function openLibraryPicker({ existing, onAdd }) {
  if (_isOpen) return;
  _isOpen = true;

  _existing  = existing instanceof Set ? existing : new Set(existing);
  _onAdd     = onAdd;
  _selectedIds   = new Set();
  _activePackIds = new Set();
  _filterSearch  = '';
  _filterTag     = '';
  _filterSev     = '';
  _filterType    = '';

  _prevFocus = document.activeElement;

  _buildAndMount();
  _fetchLibrary();
}


function _buildAndMount() {
  // Backdrop - click-to-close scrim
  _backdropEl = el('div', 'pol-lib-backdrop');
  _backdropEl.setAttribute('aria-hidden', 'true');
  _backdropEl.addEventListener('click', _closeDrawer);

  // Dialog panel
  _drawerEl = el('div', 'pol-lib-drawer');
  _drawerEl.setAttribute('role', 'dialog');
  _drawerEl.setAttribute('aria-modal', 'true');
  _drawerEl.setAttribute('aria-labelledby', 'pol-lib-title-id');
  // Stop backdrop-close from firing when user clicks inside the drawer
  _drawerEl.addEventListener('click', e => e.stopPropagation());

  // Header
  const header = el('div', 'pol-lib-header');
  const titleEl = txt('h2', 'pol-lib-title', 'Guardrail Policy Library');
  titleEl.id = 'pol-lib-title-id';

  _closeBtnEl = el('button', 'pol-lib-close');
  _closeBtnEl.type = 'button';
  _closeBtnEl.setAttribute('aria-label', 'Close library picker');
  _closeBtnEl.appendChild(_buildCloseSvg());
  _closeBtnEl.addEventListener('click', _closeDrawer);

  header.appendChild(titleEl);
  header.appendChild(_closeBtnEl);
  _drawerEl.appendChild(header);

  // Pack chips row (content populated after fetch)
  _packRowEl = el('div', 'pol-lib-pack-row');
  _packRowEl.setAttribute('role', 'group');
  _packRowEl.setAttribute('aria-label', 'Situation packs');
  _drawerEl.appendChild(_packRowEl);

  // Filter bar
  _drawerEl.appendChild(_buildFilterBar());

  // Scrollable body
  _bodyEl = el('div', 'pol-lib-body');
  _bodyEl.setAttribute('role', 'region');
  _bodyEl.setAttribute('aria-label', 'Directive list');
  _bodyEl.appendChild(txt('p', 'pol-lib-loading', 'Loading library\u2026'));
  _drawerEl.appendChild(_bodyEl);

  // Sticky footer
  _drawerEl.appendChild(_buildFooter());

  // Mount in document
  document.body.appendChild(_backdropEl);
  document.body.appendChild(_drawerEl);

  // Trigger CSS open transition on next frame
  requestAnimationFrame(() => {
    _backdropEl.classList.add('is-open');
    _drawerEl.classList.add('is-open');
  });

  // Move focus into the drawer (close button - first focusable element)
  _closeBtnEl.focus();

  // Global keyboard handler
  document.addEventListener('keydown', _handleKeyDown);
}


function _buildCloseSvg() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  function line(x1, y1, x2, y2) {
    const n = document.createElementNS(NS, 'line');
    n.setAttribute('x1', String(x1)); n.setAttribute('y1', String(y1));
    n.setAttribute('x2', String(x2)); n.setAttribute('y2', String(y2));
    n.setAttribute('stroke', 'currentColor');
    n.setAttribute('stroke-width', '2');
    n.setAttribute('stroke-linecap', 'round');
    return n;
  }
  svg.appendChild(line(1, 1, 13, 13));
  svg.appendChild(line(13, 1, 1, 13));
  return svg;
}


function _buildFilterBar() {
  const bar = el('div', 'pol-lib-filterbar');

  // Search
  const searchId = 'pol-lib-search-inp';
  const searchLbl = el('label', 'pol-lib-sr-only');
  searchLbl.setAttribute('for', searchId);
  searchLbl.textContent = 'Search directives';
  _searchEl = el('input', 'pol-lib-search');
  _searchEl.id = searchId;
  _searchEl.type = 'search';
  _searchEl.placeholder = 'Search directives\u2026';
  _searchEl.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      _filterSearch = _searchEl.value.trim().toLowerCase();
      _renderList();
    }, 150);
  });
  bar.appendChild(searchLbl);
  bar.appendChild(_searchEl);

  // Tag select - options populated after fetch; placeholder option only for now
  _tagSelectEl = el('select', 'pol-lib-select');
  _tagSelectEl.setAttribute('aria-label', 'Filter by tag');
  const allTagsOpt = document.createElement('option');
  allTagsOpt.value = '';
  allTagsOpt.textContent = 'All tags';
  _tagSelectEl.appendChild(allTagsOpt);
  bar.appendChild(_tagSelectEl);

  // Severity select
  _sevSelectEl = el('select', 'pol-lib-select');
  _sevSelectEl.setAttribute('aria-label', 'Filter by severity');
  for (const [v, lbl] of [['', 'All severities'], ['critical', 'Critical'], ['warn', 'Warn'], ['info', 'Info']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = lbl;
    _sevSelectEl.appendChild(o);
  }
  _sevSelectEl.addEventListener('change', () => { _filterSev = _sevSelectEl.value; _renderList(); });
  bar.appendChild(_sevSelectEl);

  // Type select
  _typeSelectEl = el('select', 'pol-lib-select');
  _typeSelectEl.setAttribute('aria-label', 'Filter by type');
  for (const [v, lbl] of [['', 'All types'], ['finite', 'Finite'], ['template', 'Template']]) {
    const o = document.createElement('option');
    o.value = v; o.textContent = lbl;
    _typeSelectEl.appendChild(o);
  }
  _typeSelectEl.addEventListener('change', () => { _filterType = _typeSelectEl.value; _renderList(); });
  bar.appendChild(_typeSelectEl);

  return bar;
}


function _buildFooter() {
  const footer = el('div', 'pol-lib-footer');

  _footerCountEl = txt('span', 'pol-lib-count', '0 selected');

  const actions = el('div', 'pol-lib-footer-actions');

  const cancelBtn = el('button', 'pol-btn pol-lib-btn-cancel');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', _closeDrawer);

  _footerAddBtn = el('button', 'pol-btn pol-lib-btn-add');
  _footerAddBtn.type = 'button';
  _footerAddBtn.textContent = 'Add to policy';
  _footerAddBtn.disabled = true;
  _footerAddBtn.addEventListener('click', _handleAdd);

  actions.appendChild(cancelBtn);
  actions.appendChild(_footerAddBtn);
  footer.appendChild(_footerCountEl);
  footer.appendChild(actions);
  return footer;
}


async function _fetchLibrary() {
  try {
    const data = await getPolicyLibrary();
    _libraryData    = data;
    _directivesById = new Map((data.directives || []).map(d => [d.id, d]));

    // Rebuild tag select options (clear + rebuild via DOM API)
    clear(_tagSelectEl);
    for (const [v, lbl] of [['', 'All tags'], ...(data.tagVocabulary || []).map(t => [t, t])]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = lbl;
      _tagSelectEl.appendChild(o);
    }
    _tagSelectEl.addEventListener('change', () => { _filterTag = _tagSelectEl.value; _renderList(); });

    _renderPackChips();
    _renderList();
    _renderFooter();
  } catch (err) {
    clear(_bodyEl);
    _bodyEl.appendChild(txt('p', 'pol-lib-error', `Failed to load library: ${err.message}`));
  }
}


function _renderPackChips() {
  clear(_packRowEl);
  if (!_libraryData) return;

  for (const pack of (_libraryData.packs || [])) {
    const isActive = _activePackIds.has(pack.id);
    const chip = el('button', 'pol-lib-pack-chip');
    chip.type = 'button';
    if (isActive) chip.classList.add('is-active');
    chip.setAttribute('aria-pressed', String(isActive));
    if (pack.when) chip.setAttribute('title', pack.when);

    chip.appendChild(txt('span', 'pol-lib-pack-label', pack.label));
    chip.appendChild(txt('span', 'pol-lib-pack-count', String(pack.directiveIds.length)));
    chip.addEventListener('click', () => _togglePack(pack));
    _packRowEl.appendChild(chip);
  }
}

function _togglePack(pack) {
  if (_activePackIds.has(pack.id)) {
    _activePackIds.delete(pack.id);
    // Keep any ID still covered by a remaining active pack
    const covered = new Set();
    for (const pid of _activePackIds) {
      const p = _libraryData.packs.find(p => p.id === pid);
      if (p) p.directiveIds.forEach(id => covered.add(id));
    }
    for (const id of pack.directiveIds) {
      if (!covered.has(id)) _selectedIds.delete(id);
    }
  } else {
    _activePackIds.add(pack.id);
    for (const id of pack.directiveIds) {
      const d = _directivesById.get(id);
      if (d && !_existing.has(normText(d.text))) _selectedIds.add(id);
    }
  }
  _renderPackChips();
  _updateCheckboxes(); // avoid full re-render; just sync checked states
  _renderFooter();
}


function _getVisible() {
  if (!_libraryData) return [];
  return (_libraryData.directives || []).filter(d => {
    if (_filterSev  && d.severity_hint !== _filterSev)            return false;
    if (_filterType && d.type          !== _filterType)            return false;
    if (_filterTag  && !(d.tags || []).includes(_filterTag))       return false;
    if (_filterSearch) {
      const q = _filterSearch;
      const inText = normText(d.text).includes(q);
      const inId   = (d.id   || '').toLowerCase().includes(q);
      const inTags = (d.tags || []).some(t => t.toLowerCase().includes(q));
      if (!inText && !inId && !inTags) return false;
    }
    return true;
  });
}


function _renderList() {
  clear(_bodyEl);

  if (!_libraryData) {
    _bodyEl.appendChild(txt('p', 'pol-lib-loading', 'Loading library\u2026'));
    return;
  }

  const visible = _getVisible();
  if (visible.length === 0) {
    _bodyEl.appendChild(txt('p', 'pol-lib-empty', 'No directives match your filters.'));
    return;
  }

  // Group by category preserving server order
  const grouped = new Map();
  for (const cat of (_libraryData.categories || [])) grouped.set(cat, []);
  for (const d of visible) {
    if (!grouped.has(d.category)) grouped.set(d.category, []);
    grouped.get(d.category).push(d);
  }

  for (const [cat, directives] of grouped) {
    if (directives.length === 0) continue;
    _bodyEl.appendChild(_buildCategory(cat, directives));
  }
}

function _buildCategory(cat, directives) {
  const details = el('details', 'pol-lib-cat');
  details.open = true;

  const summary = el('summary', 'pol-lib-cat-summary');
  summary.appendChild(txt('span', 'pol-lib-cat-name', cat));
  summary.appendChild(txt('span', 'pol-lib-cat-count', String(directives.length)));

  // "Select shown" - updates checked state in-place; does not re-render list
  const selBtn = el('button', 'pol-lib-cat-select-btn');
  selBtn.type = 'button';
  selBtn.textContent = 'Select shown';
  selBtn.addEventListener('click', e => {
    e.stopPropagation(); // prevent <details> toggle
    for (const row of details.querySelectorAll('.pol-lib-row:not(.is-existing)')) {
      const id = row.dataset.id;
      if (id) {
        _selectedIds.add(id);
        const cb = row.querySelector('.pol-lib-cb');
        if (cb) cb.checked = true;
      }
    }
    _renderFooter();
  });
  summary.appendChild(selBtn);
  details.appendChild(summary);

  for (const d of directives) details.appendChild(_buildRow(d));
  return details;
}

function _buildRow(d) {
  const isExisting = _existing.has(normText(d.text));
  const isSelected = _selectedIds.has(d.id);

  const labelEl = el('label', 'pol-lib-row');
  labelEl.dataset.id = d.id;
  if (isExisting) labelEl.classList.add('is-existing');

  // Real checkbox - keyboard-reachable, label-wrapped
  const cb = el('input', 'pol-lib-cb');
  cb.type     = 'checkbox';
  cb.checked  = isSelected;
  cb.disabled = isExisting;
  cb.setAttribute('aria-label', d.text || '');
  if (!isExisting) {
    cb.addEventListener('change', () => {
      if (cb.checked) _selectedIds.add(d.id);
      else            _selectedIds.delete(d.id);
      _renderFooter();
    });
  }
  labelEl.appendChild(cb);

  // Severity chip
  labelEl.appendChild(txt('span', `pol-lib-sev ${_sevClass(d.severity_hint)}`, d.severity_hint || 'info'));

  // Type badge
  labelEl.appendChild(txt('span', `pol-lib-type pol-lib-type-${d.type || 'finite'}`, d.type || 'finite'));

  // Directive text
  labelEl.appendChild(txt('span', 'pol-lib-row-text', d.text || ''));

  // Tags
  if ((d.tags || []).length > 0) {
    const tagsWrap = el('span', 'pol-lib-tags');
    for (const tag of d.tags) tagsWrap.appendChild(txt('span', 'pol-lib-tag', tag));
    labelEl.appendChild(tagsWrap);
  }

  // "in policy" marker
  if (isExisting) labelEl.appendChild(txt('span', 'pol-lib-in-policy', 'in policy'));

  return labelEl;
}

function _sevClass(hint) {
  if (hint === 'critical') return 'pol-lib-sev-critical';
  if (hint === 'warn')     return 'pol-lib-sev-warn';
  return 'pol-lib-sev-info';
}

// Sync checkbox checked states without re-rendering the full list
// (used after pack chip toggles so focus/scroll position is preserved)
function _updateCheckboxes() {
  if (!_bodyEl) return;
  for (const row of _bodyEl.querySelectorAll('.pol-lib-row:not(.is-existing)')) {
    const id = row.dataset.id;
    if (!id) continue;
    const cb = row.querySelector('.pol-lib-cb');
    if (cb) cb.checked = _selectedIds.has(id);
  }
}


function _renderFooter() {
  const n = _selectedIds.size;
  _footerCountEl.textContent = n === 1 ? '1 selected' : `${n} selected`;
  _footerAddBtn.disabled = n === 0;
}


function _handleAdd() {
  if (!_libraryData || _selectedIds.size === 0) return;
  const directives = [..._selectedIds].map(id => _directivesById.get(id)).filter(Boolean);
  _onAdd(directives);
  _closeDrawer();
}


function _closeDrawer() {
  if (!_isOpen) return;
  document.removeEventListener('keydown', _handleKeyDown);
  clearTimeout(_searchDebounce);

  _backdropEl.classList.remove('is-open');
  _drawerEl.classList.remove('is-open');

  // Store refs before nulling so the timeout closure can remove them
  const bd = _backdropEl;
  const dr = _drawerEl;
  setTimeout(() => { bd.remove(); dr.remove(); }, 220);

  if (_prevFocus && typeof _prevFocus.focus === 'function') _prevFocus.focus();
  _prevFocus  = null;
  _isOpen     = false;
  _backdropEl = null;
  _drawerEl   = null;
}


function _handleKeyDown(e) {
  if (e.key === 'Escape') { e.preventDefault(); _closeDrawer(); return; }
  if (e.key === 'Tab' && _drawerEl) _trapFocus(e);
}

function _trapFocus(e) {
  const focusable = [..._drawerEl.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )].filter(n => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length));

  if (focusable.length === 0) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}
