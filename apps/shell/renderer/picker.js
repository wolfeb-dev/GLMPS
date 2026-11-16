// apps/shell/renderer/picker.js
// Lists the sources main sends over 'picker:sources' and reports the
// operator's choice back. Text only (textContent), never innerHTML: names
// come from whatever the operator is running (window titles, say).
const api = window.glmpsPicker;
const groups = document.getElementById('groups');
const empty = document.getElementById('empty');
const audioRow = document.getElementById('audio-row');
const audioBox = document.getElementById('audio');
const shareBtn = document.getElementById('share');
const cancelBtn = document.getElementById('cancel');

let tiles = [];
let selectedId = null;
// Tags the request the currently shown sources belong to (PR #29 review,
// minor), echoed back on choose/cancel so a stale tile - from a request that
// already settled, if a message somehow arrived late - can never select.
let currentRequestId = null;

function render({ sources, canShareAudio, requestId }) {
  currentRequestId = requestId;
  groups.replaceChildren();
  tiles = [];
  selectedId = null;
  shareBtn.disabled = true;
  audioRow.hidden = !canShareAudio;
  audioBox.checked = false;

  const byKind = [
    ['screen', 'Screens'],
    ['window', 'Windows'],
  ];
  for (const [kind, label] of byKind) {
    const list = sources.filter((s) => s.kind === kind);
    if (!list.length) continue;
    const section = document.createElement('section');
    section.className = 'group';
    const h2 = document.createElement('h2');
    h2.textContent = label;
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const source of list) grid.append(makeTile(source));
    section.append(h2, grid);
    groups.append(section);
  }
  empty.hidden = sources.length > 0;
}

// Fired when main hides the picker (a request settled, or was force-denied):
// drops the tile list at once rather than leaving it to be replaced only once
// a next request's sources arrive (PR #29 review, minor).
function clear() {
  currentRequestId = null;
  groups.replaceChildren();
  tiles = [];
  selectedId = null;
  shareBtn.disabled = true;
  empty.hidden = true;
}

function makeTile(source) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.setAttribute('aria-pressed', 'false');

  const frame = document.createElement('div');
  frame.className = 'frame';
  const img = document.createElement('img');
  img.src = source.thumbnail;
  img.alt = '';
  // The checkmark is drawn in CSS (.mark::after), not a Unicode glyph: state
  // is already conveyed by the tile's own aria-pressed, so this is decorative.
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.setAttribute('aria-hidden', 'true');
  frame.append(img, mark);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = source.name;

  tile.append(frame, name);
  tile.addEventListener('click', () => select(source.id));
  tile.addEventListener('dblclick', () => { select(source.id); share(); });
  tiles.push(tile);
  tile.dataset.sourceId = source.id;
  return tile;
}

function select(id) {
  selectedId = id;
  for (const t of tiles) t.setAttribute('aria-pressed', String(t.dataset.sourceId === id));
  shareBtn.disabled = false;
}

function share() {
  if (!selectedId) return;
  api.choose(selectedId, audioBox.checked, currentRequestId);
}

shareBtn.addEventListener('click', share);
cancelBtn.addEventListener('click', () => api.cancel(currentRequestId));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.cancel(currentRequestId); }
});

api.onSources(render);
api.onClear(clear);
