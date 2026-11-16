// server/test/web-settings-modal.test.js
// Phase 6 of the HCI/IA redesign (docs/specs/2026-11-02-hci-ia-redesign.md):
// the gear opens a tabbed modal of today's rows, "Open files in" lives in it,
// and the launcher keeps only a warning dot that links to Clients and capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMiniDom, MiniEvent } from './fixtures/mini-dom.js';
import { waitFor } from './helpers/wait-for.js';

const IDES = [{ id: 'antigravity', label: 'Antigravity' }, { id: 'vscode', label: 'VS Code' }];
const COVERAGE_GAP = { reference: 'claude', covered: 1, tools: [{ id: 'claude', displayName: 'Claude', hasAdapter: true, popularityWeight: 9 }, { id: 'cursor', displayName: 'Cursor', hasAdapter: false, popularityWeight: 5 }] };
const COVERAGE_FULL = { reference: 'claude', covered: 1, tools: [{ id: 'claude', displayName: 'Claude', hasAdapter: true, popularityWeight: 9 }] };

function setup({ runner = { config: { openTarget: null }, openTargets: IDES }, coverage = COVERAGE_GAP, restart = { status: 409, body: { ok: false, reason: 'cooldown' } } } = {}) {
  const dom = installMiniDom({ pathname: '/' });
  const calls = { posts: [], tz: [], shown: 0, restartAll: 0, plainRestart: 0 };
  const realCreate = document.createElement;
  document.createElement = (t) => {
    const e = realCreate(t);
    if (String(t).toLowerCase() === 'dialog') e.showModal = () => { calls.shown += 1; e.setAttribute('open', ''); };
    return e;
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url).split('?')[0];
    const method = init.method ?? 'GET';
    if (u === '/api/config') return Response.json({ version: '2.0.0', port: 8123, configPath: 'C:/x/config.json', terminals: [{ label: 'Claude', icon: 'claude' }], projectRoots: [] });
    if (u === '/api/runner') return Response.json(runner);
    if (u === '/api/runner/config') { calls.posts.push(JSON.parse(init.body)); return Response.json({}); }
    if (u === '/api/coverage') return Response.json(coverage);
    if (u === '/api/actions/restart-all' && method === 'POST') { calls.restartAll += 1; return Response.json(restart.body, { status: restart.status }); }
    if (u === '/api/restart' && method === 'POST') { calls.plainRestart += 1; return Response.json({ restarting: true }); }
    if (u === '/api/settings/timezone' && method === 'POST') { const b = JSON.parse(init.body); calls.tz.push(b.timeZone); return Response.json({ timeZone: b.timeZone, label: 'T' }); }
    if (u === '/api/settings/timezone') return Response.json({ timeZone: 'UTC' });
    if (u === '/api/graph/status') return Response.json({ graphs: [] });
    if (u === '/api/learning/status' || u === '/api/learning') return Response.json({ lastRunMs: null, pending: 0 });
    return Response.json({});
  };
  return { dom, calls, async done() { await new Promise((r) => setTimeout(r, 40)); delete globalThis.fetch; dom.restore(); } };
}

async function mountGear() {
  const { mountSettings } = await import(`../../web/shared/settings.js?t=${Date.now()}-${Math.random()}`);
  const bar = document.createElement('div');
  document.body.appendChild(bar);
  mountSettings(bar);
  return { bar, gear: bar.querySelector('.set-btn') };
}

const dialog = () => document.querySelector('dialog');
const tabs = () => dialog().querySelectorAll('[role="tab"]');
const panelOf = (label) => {
  const tab = tabs().find((t) => t.textContent === label);
  return document.getElementById(tab.getAttribute('aria-controls'));
};

test('the gear opens a modal dialog with three tabs holding the existing rows, regrouped; the Knowledge tab is gone (glmps-2-0-140)', async () => {
  const s = setup();
  try {
    const { gear } = await mountGear();
    gear.click();
    const dlg = await waitFor(dialog, { message: 'the settings dialog' });
    assert.equal(dlg.getAttribute('role'), 'dialog');
    assert.equal(dlg.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(dlg.getAttribute('aria-labelledby')).textContent, 'Settings');
    assert.equal(s.calls.shown, 1, 'opened with showModal so the page behind is inert');

    assert.deepEqual(tabs().map((t) => t.textContent), ['General', 'Clients and capture', 'Server']);
    assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');

    const rows = {
      General: ['Appearance', 'Timezone', 'Open files in'],
      'Clients and capture': ['Add a client', 'Clients', 'Capture coverage'],
      Server: ['Restart', 'Open config.json', 'Access token'],
    };
    assert.ok(!dlg.textContent.includes('Rebuild'), 'Restart rebuilds the app when needed, so no separate Rebuild row');
    assert.ok(!/power/i.test(dlg.textContent), 'GLMPS does not control Windows power settings');
    const serverActions = [...panelOf('Server').querySelectorAll('.set-row-label')].map((l) => l.textContent).filter((t) => /restart|reset|rebuild|deploy/i.test(t));
    assert.deepEqual(serverActions, ['Restart'], 'the Server tab offers exactly one restart action');
    for (const gone of ['Knowledge graph', 'Learning loop']) assert.ok(!dlg.textContent.includes(gone), `the dialog must not hold "${gone}"`);
    for (const [tab, labels] of Object.entries(rows)) {
      const text = panelOf(tab).textContent;
      for (const l of labels) assert.ok(text.includes(l), `${tab} should hold "${l}"`);
      for (const [other, otherLabels] of Object.entries(rows)) {
        if (other === tab) continue;
        for (const l of otherLabels) if (!labels.some((own) => own.includes(l) || l.includes(own))) assert.ok(!text.includes(l), `${tab} must not hold "${l}"`);
      }
    }
  } finally { await s.done(); }
});

test('focus moves into the dialog, Escape closes it, and focus returns to the gear', async () => {
  const s = setup();
  try {
    const { gear } = await mountGear();
    gear.focus();
    gear.click();
    const dlg = await waitFor(dialog, { message: 'the settings dialog' });
    assert.ok(dlg.contains(document.activeElement), 'focus is inside the dialog');
    assert.equal(document.activeElement, tabs()[0], 'focus lands on the selected tab');

    dlg.dispatchEvent(new MiniEvent('keydown', { key: 'Escape' }));
    assert.equal(dialog(), null, 'Escape removes the dialog');
    assert.equal(document.activeElement, gear, 'focus returns to the gear');
  } finally { await s.done(); }
});

test('the tab list moves with the arrow keys', async () => {
  const s = setup();
  try {
    const { gear } = await mountGear();
    gear.click();
    await waitFor(dialog, { message: 'the settings dialog' });
    tabs()[0].dispatchEvent(new MiniEvent('keydown', { key: 'ArrowRight' }));
    assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, tabs()[1]);
    tabs()[1].dispatchEvent(new MiniEvent('keydown', { key: 'ArrowLeft' }));
    assert.equal(tabs()[0].getAttribute('aria-selected'), 'true');
  } finally { await s.done(); }
});

test('the open-settings event opens on the requested tab', async () => {
  const s = setup();
  try {
    await mountGear();
    window.dispatchEvent(new CustomEvent('mc-open-settings', { detail: { tab: 'clients' } }));
    await waitFor(dialog, { message: 'the settings dialog' });
    assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
    assert.equal(tabs()[1].textContent, 'Clients and capture');
  } finally { await s.done(); }
});

test('Open files in sits in General, shows the saved IDE, and a change saves openTarget only', async () => {
  const s = setup({ runner: { config: { openTarget: 'vscode' }, openTargets: IDES } });
  try {
    const { gear } = await mountGear();
    gear.click();
    await waitFor(dialog, { message: 'the settings dialog' });
    const sel = await waitFor(() => panelOf('General').querySelector('select[aria-label="Open files in"]'), { message: 'the Open files in picker in General' });
    await waitFor(() => sel.value === 'vscode', { message: 'the saved IDE to show' });
    assert.deepEqual(sel.children.map((o) => o.value), ['', 'antigravity', 'vscode']);
    sel.value = 'antigravity';
    sel.dispatchEvent(new Event('change'));
    await waitFor(() => s.calls.posts.length === 1, { message: 'one config post' });
    assert.deepEqual(s.calls.posts, [{ openTarget: 'antigravity' }]);
  } finally { await s.done(); }
});

test('a time zone change still saves and reloads the page', async () => {
  const s = setup();
  try {
    const { gear } = await mountGear();
    gear.click();
    await waitFor(dialog, { message: 'the settings dialog' });
    const sel = panelOf('General').querySelector('.set-tz-select');
    sel.value = 'Europe/Paris';
    sel.dispatchEvent(new Event('change'));
    await waitFor(() => s.calls.tz.length === 1, { message: 'the timezone post' });
    assert.deepEqual(s.calls.tz, ['Europe/Paris']);
    await waitFor(() => window.reloaded === true, { message: 'the deliberate reload' });
  } finally { await s.done(); }
});

test('the launcher shows a warning dot for an uncaptured tool, linking to Clients and capture', async () => {
  const s = setup();
  try {
    const { mountLauncher } = await import('../../web/shared/launcher.js');
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    await mountLauncher(bar);
    const dot = await waitFor(() => bar.querySelector('.term-capture-warn'), { message: 'the capture warning dot' });
    assert.match(dot.getAttribute('aria-label'), /Cursor/);
    assert.match(dot.getAttribute('aria-label'), /Clients and capture/);
    const seen = [];
    window.addEventListener('mc-open-settings', (e) => seen.push(e.detail));
    dot.click();
    assert.deepEqual(seen, [{ tab: 'clients' }]);
  } finally { await s.done(); }
});

test('the launcher shows no dot when every tool is captured', async () => {
  const s = setup({ coverage: COVERAGE_FULL });
  try {
    const { mountLauncher } = await import('../../web/shared/launcher.js');
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    await mountLauncher(bar);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bar.querySelector('.term-capture-warn'), null);
  } finally { await s.done(); }
});

test('the Server tab names the product version as GLMPS 2.0', async () => {
  const s = setup();
  try {
    const { gear } = await mountGear();
    gear.click();
    await waitFor(dialog, { message: 'the settings dialog' });
    const info = panelOf('Server').querySelector('.set-info');
    await waitFor(() => info.textContent.startsWith('GLMPS'), { message: 'the version line' });
    assert.equal(info.textContent, 'GLMPS v2.0.0 \u00B7 :8123');
  } finally { await s.done(); }
});

// glmps-2-0-170: the one Restart row starts the sequence and names a refusal.
async function clickRestart() {
  const toasts = [];
  const onToast = (e) => toasts.push(e.detail);
  window.addEventListener('mc-toast', onToast);
  const { gear } = await mountGear();
  gear.click();
  await waitFor(dialog, { message: 'the settings dialog' });
  const rowEl = [...panelOf('Server').querySelectorAll('.set-row')].find((r) => r.querySelector('.set-row-label')?.textContent === 'Restart');
  assert.ok(rowEl, 'the Server tab has a Restart row');
  rowEl.click();
  await waitFor(() => toasts.length > 0, { message: 'the restart toast' });
  window.removeEventListener('mc-toast', onToast);
  return { toasts, rowEl };
}

test('Restart: a refusal is named and the row is usable again', async () => {
  const s = setup();
  try {
    const { toasts, rowEl } = await clickRestart();
    assert.equal(s.calls.restartAll, 1);
    assert.equal(s.calls.plainRestart, 0);
    assert.match(toasts[0], /^Restart not started: it ran in the last 5 minutes/);
    assert.equal(rowEl.classList.contains('busy'), false);
  } finally { await s.done(); }
});

test('Restart: with the action runner off it says the update step was skipped and restarts only', async () => {
  const s = setup({ restart: { status: 503, body: { ok: false, reason: 'scut-not-running' } } });
  let reloads = 0;
  try {
    location.reload = () => { reloads += 1; };
    const { toasts } = await clickRestart();
    assert.match(toasts[0], /Update step skipped/);
    await waitFor(() => reloads === 1, { message: 'the page reload after the plain restart' });
    assert.equal(s.calls.plainRestart, 1);
  } finally { await s.done(); }
});
