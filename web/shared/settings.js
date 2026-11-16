// web/shared/settings.js
// Topbar settings gear. It opens a tabbed modal dialog (phase 6 of the HCI/IA
// redesign) of today's rows: General (appearance, timezone, Open files in),
// Clients and capture, Server (the one Restart, config.json, access token).
// Restart also rebuilds the desktop app when its code changed, so there is no
// separate rebuild row, and GLMPS does not change Windows power settings (card
// glmps-2-0-170). The graph and learning-loop controls moved to the Knowledge
// and Learning lenses (card glmps-2-0-140).
// All data via textContent/createElement; no innerHTML with data.
import { getConfig, getTimeZone, setTimeZone, getGuardAutoApprove, setGuardAutoApprove,restartServer, restartAll, getApprovals, health, openInEditor, getAccessToken, setAccessToken, getCoverage, getRunner, setRunnerConfig } from './api.js';
import { createTabs } from './tabs.js';
import { openClientsPanel } from './clients-panel.js';
import { setDisplayTimeZone, displayTimeZone, listTimeZones, zoneName, formatTime, isValidTimeZone } from './time-format.js';

// Theme choice (phase 2, Q4): 'system' follows prefers-color-scheme, 'light' and
// 'dark' pin it. Stored per browser; every storage touch is guarded because
// localStorage throws in private or locked-down contexts.
export const THEME_KEY = 'mc.theme';
export const THEME_CHOICES = ['system', 'light', 'dark'];

export function readTheme(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(THEME_KEY);
    return THEME_CHOICES.includes(v) ? v : 'system';
  } catch { return 'system'; }
}

export function applyTheme(choice, root = globalThis.document?.documentElement) {
  if (!root) return;
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;
}

export function saveTheme(choice, storage = globalThis.localStorage) {
  const v = THEME_CHOICES.includes(choice) ? choice : 'system';
  try { if (v === 'system') storage?.removeItem(THEME_KEY); else storage?.setItem(THEME_KEY, v); } catch { /* choice still applies for this page */ }
  return v;
}

// Applied when this module loads (the shell imports it at boot, before the
// first lens paints) so a pinned theme never flashes the other one.
applyTheme(readTheme());

// Operator timezone (card glmps-2-0-runtime-66). The server holds the setting;
// this browser keeps a copy so first paint is already in the right zone, then
// the server's answer wins.
export const TZ_KEY = 'mc.tz';

export function readTz(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(TZ_KEY);
    return isValidTimeZone(v) ? v : null;
  } catch { return null; }
}

export function saveTz(tz, storage = globalThis.localStorage) {
  try { if (isValidTimeZone(tz)) storage?.setItem(TZ_KEY, tz); } catch { /* still applies for this page */ }
}

export function timeZoneToast(status, body) {
  if (status === 200 && body?.timeZone) return `Times now shown in ${body.timeZone} (${body.label || zoneName(body.timeZone)})`;
  return `Timezone not saved: ${body?.error || `server answered ${status}`}`;
}

const cachedTz = readTz();
if (cachedTz) setDisplayTimeZone(cachedTz);
if (globalThis.document) {
  getTimeZone().then((r) => {
    if (!isValidTimeZone(r?.timeZone) || r.timeZone === displayTimeZone()) return;
    setDisplayTimeZone(r.timeZone);
    saveTz(r.timeZone);
    globalThis.dispatchEvent?.(new CustomEvent('mc-timezone', { detail: r.timeZone }));
  }).catch(() => { /* the cached or browser zone stays */ });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "Open config.json" used to call openInEditor and
// ignore the result outright - in service mode (no desktop in session 0,
// Task 12b) that route always answers 409, so clicking it there did
// nothing at all, with zero feedback. Pulled out as a pure function (same
// convention as web/shared/launcher.js's launchToast) so the toast-text
// decision is tested without a DOM harness. null means "no toast" - the
// ordinary success case, where the editor just opens.
export function openInEditorToast(status, body) {
  if (status === 200) return null;
  return `Could not open config.json: ${body?.error || `server answered ${status}`}`;
}



// Card glmps-2-0-170: the one Restart row. Text decisions are pure so they are
// tested without a DOM; followRestartRun is the only waiting loop.
const RESTART_STEP_TEXT = {
  quiesce: 'waiting for merge work to finish',
  update: 'applying the update',
  rebuild: 'rebuilding the desktop app',
  restart: 'restarting the server',
  verify: 'checking the new server',
};
export function restartStepText(steps = []) {
  const current = [...steps].reverse().find((s) => s.status === 'started');
  return `Restart: ${current ? RESTART_STEP_TEXT[current.step] ?? current.step : 'starting'}`;
}
const RESTART_REFUSED = {
  cooldown: 'Restart not started: it ran in the last 5 minutes. Try again later.',
  'action-running': 'Restart not started: a restart is already running.',
  'another-action-running': 'Restart not started: a deploy or rebuild is running. Try again when it finishes.',
  'local-session-required': 'Restart not started: this window is not signed in to the server. Open the dashboard from the desktop app, then try again.',
};
export function restartRefusalText(reason) {
  return RESTART_REFUSED[reason] ?? `Restart not started: ${reason || 'the server refused it'}`;
}
// A rebuild can take 30 minutes and the kernel goes away mid-run, so a failed
// poll is waited out, not reported.
export async function followRestartRun({ id, getRun, onStep = () => {}, sleep: wait = sleep, now = Date.now, timeoutMs = 50 * 60_000, pollMs = 2000 }) {
  const deadline = now() + timeoutMs;
  let lastText = null;
  while (now() < deadline) {
    let r = null;
    try { r = await getRun(id); } catch { /* the server is down or restarting */ }
    if (r?.run?.finishedTs != null) {
      const res = r.run.result ?? {};
      return res.ok
        ? { ok: true, text: `Restarted: ${res.stepsLine || 'done'}` }
        : { ok: false, text: `Restart failed: ${res.error || 'see the approvals log'}` };
    }
    if (r) {
      const text = restartStepText(r.steps);
      if (text !== lastText) { lastText = text; onStep(text); }
    }
    await wait(pollMs);
  }
  return { ok: false, text: 'Restart did not finish in time. Check the server before trying again.' };
}

function icon(name) {
  const span = document.createElement('span');
  span.className = 'set-ic';
  const safe = String(name).replace(/[^a-z0-9_-]/gi, '');
  const url = `url("icons/${safe || 'gear'}.svg")`;
  span.style.webkitMaskImage = url;
  span.style.maskImage = url;
  return span;
}

export function mountSettings(topbar) {
  const wrap = document.createElement('div');
  wrap.className = 'set-launcher';

  const btn = document.createElement('button');
  btn.className = 'set-btn';
  btn.type = 'button';
  btn.title = 'Settings';
  btn.setAttribute('aria-label', 'Settings');
  btn.appendChild(icon('gear'));
  wrap.appendChild(btn);

  let dlg = null, tabsApi = null, cfg = null;

  // Removing an open modal dialog closes it. Focus goes back to the gear so a
  // keyboard user lands where they started.
  function closeMenu() {
    if (!dlg) return;
    const d = dlg;
    dlg = null; tabsApi = null;
    d.remove();
    btn.classList.remove('open');
    btn.focus();
  }

  function row(iconName, label, onClick) {
    const r = document.createElement('div');
    r.className = 'set-row';
    r.appendChild(icon(iconName));
    const t = document.createElement('span');
    t.className = 'set-row-label';
    t.textContent = label;
    r.appendChild(t);
    r.setAttribute('role', 'button');
    r.tabIndex = 0;
    r.addEventListener('click', (e) => { e.stopPropagation(); onClick(r); });
    r.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      onClick(r);
    });
    return r;
  }

  function capStyle(label) {
    const el = document.createElement('div');
    el.className = 'set-cap-style';
    el.textContent = label;
    return el;
  }


  function buildCoverageSection(menu) {
    const wrap = document.createElement('div');
    wrap.className = 'set-section';
    const divider = document.createElement('div');
    divider.className = 'set-divider';
    wrap.appendChild(divider);
    wrap.appendChild(capStyle('Capture coverage'));
    const status = document.createElement('div');
    status.className = 'set-learning-status';
    status.textContent = '\u2026';
    wrap.appendChild(status);
    const list = document.createElement('div');
    list.className = 'set-coverage-list';
    wrap.appendChild(list);
    menu.appendChild(wrap);
    return { status, list };
  }

  async function refreshCoverage(status, list) {
    try {
      const cov = await getCoverage();
      const total = cov.tools.length;
      status.textContent = `${cov.covered}/${total} tools captured \u00B7 ${cov.reference} = reference`;
      list.textContent = '';
      const uncovered = cov.tools.filter(t => !t.hasAdapter).sort((a, b) => b.popularityWeight - a.popularityWeight);
      if (uncovered.length === 0) {
        const d = document.createElement('div'); d.className = 'set-graph-empty'; d.textContent = 'All tracked tools have adapters.';
        list.appendChild(d); return;
      }
      const lbl = document.createElement('div'); lbl.className = 'set-coverage-lbl'; lbl.textContent = 'No adapter yet:';
      list.appendChild(lbl);
      const chips = document.createElement('div'); chips.className = 'set-coverage-chips';
      for (const t of uncovered) {
        const c = document.createElement('span'); c.className = 'set-coverage-chip'; c.textContent = t.displayName;
        chips.appendChild(c);
      }
      list.appendChild(chips);
    } catch { status.textContent = 'Coverage unavailable.'; }
  }

  function buildThemeSection(menu) {
    const sec = document.createElement('div');
    sec.className = 'set-section set-theme';
    const divider = document.createElement('div');
    divider.className = 'set-divider';
    sec.appendChild(divider);
    sec.appendChild(capStyle('Appearance'));

    const group = document.createElement('div');
    group.className = 'set-theme-group';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Colour theme');
    let current = readTheme();
    const buttons = [];
    const paint = () => {
      for (const b of buttons) {
        const on = b.dataset.theme === current;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        b.classList.toggle('on', on);
      }
    };
    const choose = (c) => { current = saveTheme(c); applyTheme(current); paint(); };
    for (const c of THEME_CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'set-theme-btn';
      b.dataset.theme = c;
      b.setAttribute('role', 'radio');
      b.textContent = c === 'system' ? 'System' : c === 'light' ? 'Light' : 'Dark';
      b.addEventListener('click', (e) => { e.stopPropagation(); choose(c); });
      b.addEventListener('keydown', (e) => {
        const i = THEME_CHOICES.indexOf(current);
        let j = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % THEME_CHOICES.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i + THEME_CHOICES.length - 1) % THEME_CHOICES.length;
        if (j < 0) return;
        e.preventDefault();
        choose(THEME_CHOICES[j]);
        buttons[j].focus();
      });
      buttons.push(b);
      group.appendChild(b);
    }
    paint();
    sec.appendChild(group);

    const note = document.createElement('div');
    note.className = 'set-theme-note';
    note.textContent = 'Surface and the Fleet board stay dark in light mode.';
    sec.appendChild(note);

    const tzRow = document.createElement('label');
    tzRow.className = 'set-tz';
    const tzLabel = document.createElement('span');
    tzLabel.className = 'set-tz-label';
    tzLabel.textContent = 'Timezone';
    tzRow.appendChild(tzLabel);
    const sel = document.createElement('select');
    sel.className = 'set-tz-select';
    sel.setAttribute('aria-label', 'Timezone for every time shown');
    for (const z of listTimeZones()) {
      const o = document.createElement('option');
      o.value = z;
      o.textContent = z.replace(/_/g, ' ');
      sel.appendChild(o);
    }
    sel.value = displayTimeZone();
    tzRow.appendChild(sel);
    sec.appendChild(tzRow);
    const tzNote = document.createElement('div');
    tzNote.className = 'set-theme-note';
    const paintTzNote = () => { tzNote.textContent = `Now ${formatTime(Date.now(), { date: false })}. Slack, alerts and agents use this zone too.`; };
    paintTzNote();
    sec.appendChild(tzNote);
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async () => {
      const prev = displayTimeZone();
      sel.disabled = true;
      try {
        const { status, body } = await setTimeZone(sel.value);
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: timeZoneToast(status, body) }));
        if (status !== 200) { sel.value = prev; return; }
        setDisplayTimeZone(body.timeZone);
        saveTz(body.timeZone);
        paintTzNote();
        // Every lens formats at render time, so a reload is the one way to
        // be sure nothing on screen is left in the old zone.
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        sel.value = prev;
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Timezone not saved: ${err.message}` }));
      } finally { sel.disabled = false; }
    });

    // Card glmps-2-0-201: guard auto-approval and age-out, on by default.
    const autoRow = document.createElement('label');
    autoRow.className = 'set-field';
    const autoBox = document.createElement('input');
    autoBox.type = 'checkbox';
    autoBox.disabled = true;
    autoRow.appendChild(autoBox);
    const autoLabel = document.createElement('span');
    autoLabel.className = 'set-field-label';
    autoLabel.textContent = 'Auto-approve proven guards';
    autoRow.appendChild(autoLabel);
    sec.appendChild(autoRow);
    const autoNote = document.createElement('div');
    autoNote.className = 'set-theme-note';
    autoNote.textContent = 'Lands a reviewed guard after 5 sessions in 2 repos, on 14-day probation. Also ages out proposals unseen for 30 days.';
    sec.appendChild(autoNote);
    autoRow.addEventListener('click', (e) => e.stopPropagation());
    getGuardAutoApprove().then((r) => { autoBox.checked = r?.enabled !== false; autoBox.disabled = false; }).catch(() => {});
    autoBox.addEventListener('change', async () => {
      const want = autoBox.checked;
      autoBox.disabled = true;
      try {
        const { status, body } = await setGuardAutoApprove(want);
        if (status !== 200) throw new Error(body?.error || `HTTP ${status}`);
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: want ? 'Guard auto-approval on' : 'Guard auto-approval off' }));
      } catch (err) {
        autoBox.checked = !want;
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Not saved: ${err.message}` }));
      } finally { autoBox.disabled = false; }
    });

    menu.appendChild(sec);
  }

  function buildAccessSection(menu) {
    const wrap = document.createElement('div');
    wrap.className = 'set-section';

    const divider = document.createElement('div');
    divider.className = 'set-divider';
    wrap.appendChild(divider);

    wrap.appendChild(capStyle('Access token'));

    const state = document.createElement('div');
    state.className = 'set-access-state';
    state.textContent = '\u2026';
    wrap.appendChild(state);

    const label = document.createElement('label');
    label.className = 'set-token-label';
    label.htmlFor = 'set-token-input';
    label.textContent = 'Access token (for remote use)';
    wrap.appendChild(label);

    const input = document.createElement('input');
    input.className = 'set-token-input';
    input.id = 'set-token-input';
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'paste shared token';
    input.setAttribute('aria-label', 'Shared access token for remote use');
    input.value = getAccessToken();
    wrap.appendChild(input);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'set-action-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save token';
    saveBtn.addEventListener('click', () => {
      const v = input.value.trim();
      setAccessToken(v);
      window.dispatchEvent(new CustomEvent('mc-toast', { detail: v ? 'Access token saved' : 'Access token cleared' }));
    });
    wrap.appendChild(saveBtn);

    menu.appendChild(wrap);
    return { state };
  }

  async function doRestartAll(r) {
    if (r.classList.contains('busy')) return;
    r.classList.add('busy');
    const lbl = r.querySelector('.set-row-label');
    const toast = (detail) => window.dispatchEvent(new CustomEvent('mc-toast', { detail }));
    let started;
    try { started = await restartAll(); } catch (e) { started = { status: 0, body: { reason: e?.message || 'the server is not reachable' } }; }
    const { status, body } = started;
    if (!(status === 200 && body?.ok)) {
      r.classList.remove('busy');
      if (body?.reason === 'scut-not-running') {
        // No action runner: the update step cannot run, so restart as before and say so.
        toast('Update step skipped: the server action runner is off. Restarting only.');
        r.classList.add('busy');
        return doRestart(r);
      }
      toast(restartRefusalText(body?.reason ?? body?.error));
      return;
    }
    if (lbl) lbl.textContent = restartStepText([]);
    const out = await followRestartRun({
      id: body.id,
      getRun: async (id) => (await getApprovals()).requests?.find((q) => q.id === id) ?? null,
      onStep: (text) => { if (lbl) lbl.textContent = text; },
    });
    if (out.ok) { toast(out.text); await sleep(600); location.reload(); return; }
    r.classList.remove('busy');
    if (lbl) lbl.textContent = 'Restart';
    toast(out.text);
  }

  async function doRestart(r) {
    r.classList.add('busy');
    const lbl = r.querySelector('.set-row-label');
    if (lbl) lbl.textContent = 'Restarting\u2026';
    window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Restarting server\u2026' }));
    try { await restartServer(); } catch {}
    closeMenu();
    await sleep(800); // let the old server release the port before polling
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await health()) { location.reload(); return; }
      await sleep(500);
    }
    window.dispatchEvent(new CustomEvent('mc-toast', { detail: "Server didn't come back \u2014 relaunch manually" }));
  }

  // Card glmps-2-0-runtime-90 put this in the launcher; phase 6 moved it here
  // because it is a global preference, not part of launching. Saved server-side
  // (openTarget) so the next open follows it with no restart.
  function buildOpenFilesIn(panel) {
    const sec = document.createElement('div');
    sec.className = 'set-section';
    const lab = document.createElement('label');
    lab.className = 'set-field';
    const cap = document.createElement('span');
    cap.className = 'set-field-label';
    cap.textContent = 'Open files in';
    const sel = document.createElement('select');
    sel.className = 'set-field-select';
    sel.setAttribute('aria-label', 'Open files in');
    sel.title = 'The IDE that opens files from GLMPS. Automatic uses the first installed IDE.';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Automatic';
    sel.appendChild(auto);
    sel.value = '';
    sel.addEventListener('change', async () => {
      try { await setRunnerConfig({ openTarget: sel.value || null }); }
      catch { window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'Failed to save Open files in' })); }
    });
    getRunner().then((r) => {
      const ides = Array.isArray(r?.openTargets) ? r.openTargets : [];
      for (const { id, label } of ides) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label ?? id;
        sel.appendChild(opt);
      }
      const saved = r?.config?.openTarget;
      sel.value = saved && ides.some((i) => i.id === saved) ? saved : '';
    }).catch(() => {});
    lab.append(cap, sel);
    sec.appendChild(lab);
    panel.appendChild(sec);
  }

  const TABS = [
    { id: 'general', label: 'General' },
    { id: 'clients', label: 'Clients and capture' },
    { id: 'server', label: 'Server' },
  ];
  const TAB_IDS = TABS.map((t) => t.id);

  async function openMenu(tabId = 'general') {
    if (dlg) { tabsApi?.select(tabId); return; }

    dlg = document.createElement('dialog');
    dlg.className = 'cp-dialog set-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'set-title');

    const head = document.createElement('div');
    head.className = 'cp-head';
    const title = document.createElement('h2');
    title.className = 'cp-title';
    title.id = 'set-title';
    title.textContent = 'Settings';
    const spacer = document.createElement('span');
    spacer.className = 'cp-summary';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cp-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.addEventListener('click', closeMenu);
    head.append(title, spacer, closeBtn);

    const body = document.createElement('div');
    body.className = 'set-body';
    dlg.append(head, body);
    tabsApi = createTabs(body, TABS, { label: 'Settings sections', idPrefix: 'set' });
    const general = tabsApi.panel('general');
    const clients = tabsApi.panel('clients');
    const server = tabsApi.panel('server');

    buildThemeSection(general);
    buildOpenFilesIn(general);

    clients.appendChild(row('plus', 'Add a client', () => { closeMenu(); openClientsPanel({ addClient: true }); }));
    clients.appendChild(row('clients', 'Clients', () => { closeMenu(); openClientsPanel(); }));
    const { status: covStatus, list: covList } = buildCoverageSection(clients);


    const info = document.createElement('div');
    info.className = 'set-info';
    info.textContent = '\u2026';
    server.appendChild(info);
    server.appendChild(row('restart', 'Restart', doRestartAll));
    server.appendChild(row('file', 'Open config.json', () => {
      if (!cfg?.configPath) { window.dispatchEvent(new CustomEvent('mc-toast', { detail: 'config path unknown' })); return; }
      closeMenu();
      // M-7: the result is no longer ignored - a service-mode 409 (or any
      // other failure) now surfaces as a toast instead of the menu just
      // closing with no feedback at all.
      openInEditor(cfg.configPath).then(({ status, body }) => {
        const msg = openInEditorToast(status, body);
        if (msg) window.dispatchEvent(new CustomEvent('mc-toast', { detail: msg }));
      }).catch((e) => {
        window.dispatchEvent(new CustomEvent('mc-toast', { detail: `Could not open config.json: ${e?.message || e}` }));
      });
    }));
    const { state: accessState } = buildAccessSection(server);

    // showModal gives the focus trap and makes the page behind inert; the
    // keydown and close listeners cover Escape and the native cancel path.
    dlg.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      closeMenu();
    });
    dlg.addEventListener('close', closeMenu);
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) closeMenu(); });

    tabsApi.show(TAB_IDS.includes(tabId) ? tabId : 'general');
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    btn.classList.add('open');
    tabsApi.el.querySelector('[aria-selected="true"]')?.focus();

    refreshCoverage(covStatus, covList);

    try {
      cfg = await getConfig();
      const v = cfg.version ? `GLMPS v${cfg.version}` : '';
      const p = cfg.port ? `:${cfg.port}` : '';
      info.textContent = [v, p].filter(Boolean).join(' \u00B7 ') || '\u2014';
      if (accessState) {
        const host = cfg.host || '127.0.0.1';
        accessState.textContent = '';
        const base = document.createElement('span');
        base.textContent = `Serving on ${host}${cfg.port ? ':' + cfg.port : ''} \u00B7 `;
        accessState.appendChild(base);
        const net = document.createElement('span');
        if (cfg.nonLocal) { net.className = 'set-access-net'; net.textContent = 'network-accessible'; }
        else { net.textContent = 'localhost only'; }
        accessState.appendChild(net);
      }
    } catch { info.textContent = '\u2014'; }
  }

  btn.addEventListener('click', () => openMenu());
  // The launcher's capture warning dot asks for the Clients and capture tab.
  window.addEventListener('mc-open-settings', (ev) => { openMenu(ev.detail?.tab); });
  topbar.appendChild(wrap);
}
