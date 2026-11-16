// web/shared/clients-panel.js
// The Clients panel and "Add a client" (server-and-client-tap task 8), opened
// from the settings gear. The pure functions at the top decide every piece of
// text and are tested without a DOM; openClientsPanel builds the dialog.
// All data via textContent/createElement; no innerHTML.
import { listClients, mintPairCode, revokeClient, getInstallerInfo } from './api.js';
import { clear } from './dom-util.js';
import { formatTime } from './time-format.js';

// Task 6's heartbeat interval must stay well under this.
export const STALE_MS = 5 * 60 * 1000;

export function clientStatus(c, now = Date.now()) {
  if (!c.paired) return { key: 'revoked', label: 'Revoked', tone: 'neutral' };
  if (c.lastSeenTs == null) return { key: 'never', label: 'Never seen', tone: 'neutral' };
  if (now - c.lastSeenTs > STALE_MS) return { key: 'stale', label: 'Stale', tone: 'warning' };
  return { key: 'online', label: 'Online', tone: 'success' };
}

export function lastSeenText(ts, now = Date.now()) {
  if (ts == null) return null;
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function depthText(n) {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : null;
}

export function formatCode(code) {
  const s = String(code ?? '').toUpperCase();
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function expiresInText(expiresAt, now = Date.now()) {
  const left = Math.ceil((expiresAt - now) / 1000);
  if (!(left > 0)) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// Reads task 7's GET /api/tap/release: { version, installer: { sha256, url, fileName } }.
export function installerLine(status, body) {
  if (status === 404) return { available: false, text: 'No installer is published on this server yet.' };
  if (status !== 200) return { available: false, text: `Installer details unavailable: ${body?.error || `server answered ${status}`}` };
  const version = body?.version;
  const { sha256, url, fileName } = body?.installer || {};
  if (typeof version !== 'string' || !/^[0-9a-f]{64}$/i.test(String(sha256)) || typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
    return { available: false, text: 'Installer details unavailable: incomplete answer' };
  }
  // The installer reads the server URL from its own filename, so a Host the name cannot carry makes the download refuse.
  if (typeof fileName !== 'string' || !fileName) {
    return { available: false, text: 'The installer cannot name this server from this address; open the dashboard by its private address.' };
  }
  return { available: true, version, sha256, url, fileName };
}

// The server's certificate expiry alert fires inside this window (card glmps-2-0-152).
export const CERT_WARN_MS = 30 * 86_400_000;
const isoDay = (ts) => new Date(ts).toISOString().slice(0, 10);

/** The Certificate cell for a client row: { text, tone: neutral|warning|danger, title }, or null for a revoked client. */
export function certExpiry(c, now = Date.now()) {
  if (!c.paired) return null;
  if (!Number.isFinite(c.certNotAfter)) return { text: 'None', tone: 'warning', title: 'Paired before client certificates; pair again' };
  const left = c.certNotAfter - now;
  if (left <= 0) return { text: 'Expired', tone: 'danger', title: `Client certificate expired ${isoDay(c.certNotAfter)}; pair again` };
  const days = Math.floor(left / 86_400_000);
  const text = days < 1 ? 'today' : `${days}d`;
  if (left <= CERT_WARN_MS) return { text, tone: 'warning', title: `Client certificate expires ${isoDay(c.certNotAfter)}; pair again to renew` };
  return { text, tone: 'neutral', title: `Client certificate expires ${isoDay(c.certNotAfter)}` };
}

/** The server CA fingerprint the installer asks for, grouped for comparing by eye; null when there is none. */
export function fingerprintText(f) {
  return /^[0-9a-f]{64}$/.test(String(f ?? '')) ? f.replace(/(.{4})(?=.)/g, '$1 ') : null;
}

export function mintErrorText(status, body) {
  if (status === 429) return '10 codes are already live. Wait for one to expire, then try again.';
  if (status === 404) return 'That client no longer exists. Reload the list.';
  if (status === 503) return `The clients store is unavailable on this server: ${body?.error || 'no reason given'}`;
  return `Could not mint a pairing code (server answered ${status}).`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function dash(srLabel) {
  const s = el('span', 'cp-none', '\u2013');
  s.setAttribute('aria-label', srLabel);
  return s;
}
const toast = (detail) => window.dispatchEvent(new CustomEvent('mc-toast', { detail }));

export function openClientsPanel({ addClient = false } = {}) {
  const dlg = el('dialog', 'cp-dialog');
  dlg.setAttribute('aria-labelledby', 'cp-title');

  const head = el('div', 'cp-head');
  const title = el('h2', 'cp-title', 'Clients');
  title.id = 'cp-title';
  const summary = el('span', 'cp-summary');
  const addBtn = button('Add a client', 'cp-btn cp-btn-primary', () => showCode(null));
  const closeBtn = button('\u00D7', 'cp-close', () => dlg.close());
  closeBtn.setAttribute('aria-label', 'Close');
  head.append(title, summary, addBtn, closeBtn);

  // Code card, revealed token and errors land here; announced when they change.
  const notice = el('div', 'cp-notice');
  notice.setAttribute('aria-live', 'polite');
  const body = el('div', 'cp-body');
  dlg.append(head, notice, body);

  let timer = null;
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  dlg.addEventListener('close', () => { stopTimer(); dlg.remove(); });

  async function showCode(client) {
    stopTimer();
    clear(notice);
    const card = el('section', 'cp-card');
    card.setAttribute('aria-label', 'Pairing code');
    notice.appendChild(card);
    card.appendChild(el('div', 'cp-card-cap', client ? `Pair ${client.name} again (keeps its id)` : 'Add a client'));
    const wait = el('div', 'cp-muted', 'Minting a code\u2026');
    card.appendChild(wait);
    let minted;
    try { minted = await mintPairCode(client?.id ?? null); }
    catch (e) { minted = { status: 0, body: { error: e?.message } }; }
    wait.remove();
    if (minted.status !== 201) {
      card.classList.add('cp-card-error');
      card.appendChild(el('div', 'cp-err', minted.status === 0 ? `Could not reach the server: ${minted.body.error || 'network error'}` : mintErrorText(minted.status, minted.body)));
      card.appendChild(button('Try again', 'cp-btn', () => showCode(client)));
      return;
    }
    const codeRow = el('div', 'cp-code-row');
    const code = el('code', 'cp-code', formatCode(minted.body.code));
    code.setAttribute('aria-label', `Pairing code ${minted.body.code.split('').join(' ')}`);
    const expiry = el('span', 'cp-expiry');
    codeRow.append(code, expiry);
    card.appendChild(codeRow);
    const tick = () => {
      const t = expiresInText(minted.body.expiresAt);
      if (t) { expiry.textContent = `expires in ${t}`; return; }
      stopTimer();
      card.classList.add('cp-card-expired');
      code.classList.add('cp-code-dead');
      expiry.textContent = 'expired';
      card.appendChild(button('New code', 'cp-btn', () => showCode(client)));
    };
    tick();
    timer = setInterval(tick, 1000);

    const facts = el('dl', 'cp-facts');
    const fact = (k, v) => { facts.append(el('dt', null, k), v instanceof Node ? (() => { const d = el('dd'); d.appendChild(v); return d; })() : el('dd', null, v)); };
    fact('Server', location.origin);
    // The installer pins the server by this; a mismatch there means another machine answered.
    const fp = fingerprintText(minted.body.trustFingerprint);
    if (fp) {
      const fpEl = el('code', 'cp-fp', fp);
      fpEl.setAttribute('aria-label', `Server fingerprint ${minted.body.trustFingerprint.split('').join(' ')}`);
      fact('Fingerprint', fpEl);
    } else fact('Fingerprint', el('span', 'cp-muted', 'None: this server listens on loopback only, so no other machine can pair yet.'));
    fact('Use', fp ? 'Single use, 10 minutes. Enter the code and the fingerprint in the installer on the new machine.' : 'Single use, 10 minutes. Enter it in the installer on the new machine.');
    const inst = el('span', 'cp-muted', '\u2026');
    fact('Installer', inst);
    card.appendChild(facts);
    card.appendChild(button('Done', 'cp-btn', () => { stopTimer(); clear(notice); load(); }));

    let info;
    try { const r = await getInstallerInfo(); info = installerLine(r.status, r.body); }
    catch (e) { info = { available: false, text: `Installer details unavailable: ${e?.message || 'network error'}` }; }
    clear(inst);
    if (!info.available) { inst.textContent = info.text; return; }
    inst.className = '';
    const a = el('a', 'cp-link', `Download v${info.version}`);
    a.href = info.url;
    a.setAttribute('download', info.fileName);
    const sha = el('code', 'cp-sha', `SHA-256 ${info.sha256}`);
    inst.append(a, sha);
  }

  function actionCell(c) {
    const td = el('td', 'cp-actions');
    const paint = () => {
      clear(td);
      // A new certificate is issued over the tap's new key, which the browser never holds,
      // so a paired client is rotated by pairing it again from the tap (card glmps-2-0-177).
      td.appendChild(button('Pair again', 'cp-btn cp-btn-quiet', () => showCode(c)));
      if (!c.paired) return;
      td.appendChild(button('Revoke', 'cp-btn cp-btn-quiet cp-btn-danger', () => confirmRevoke()));
    };
    const confirmRevoke = () => {
      clear(td);
      td.appendChild(el('span', 'cp-consequence', 'Its next request is refused. Pair it again with a new code.'));
      const yes = button('Confirm revoke', 'cp-btn cp-btn-destructive', async () => {
        yes.disabled = true;
        const r = await revokeClient(c.id).catch((err) => ({ status: 0, body: { error: err?.message } }));
        if (r.status === 200) { toast(`${c.name} revoked`); load(); return; }
        toast(`Revoke failed: ${r.body?.error || `server answered ${r.status}`}`);
        paint();
      });
      const no = button('Cancel', 'cp-btn cp-btn-quiet', paint);
      td.append(yes, no);
      no.focus();
    };
    paint();
    return td;
  }

  async function load() {
    clear(body);
    body.appendChild(el('div', 'cp-muted cp-pad', 'Loading clients\u2026'));
    let r;
    try { r = await listClients(); } catch (e) { r = { status: 0, body: { error: e?.message || 'network error' } }; }
    clear(body);
    if (r.status !== 200 || !Array.isArray(r.body?.clients)) {
      const why = r.status === 0 ? `could not reach the server (${r.body.error})` : (r.body?.error || `server answered ${r.status}`);
      const box = el('div', 'cp-empty');
      box.appendChild(el('div', 'cp-err', `Could not load clients: ${why}.`));
      box.appendChild(button('Retry', 'cp-btn', load));
      body.appendChild(box);
      summary.textContent = '';
      return;
    }
    const clients = r.body.clients;
    const paired = clients.filter((c) => c.paired).length;
    summary.textContent = `${paired} paired \u00B7 ${clients.length - paired} revoked`;
    if (!clients.length) {
      const box = el('div', 'cp-empty');
      box.appendChild(el('div', null, 'No clients paired yet. Add one to start shipping its sessions here.'));
      body.appendChild(box);
      return;
    }
    const now = Date.now();
    const table = el('table', 'cp-table');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Client', 'Status', 'Last seen', 'Spool', 'Tap', 'Cert expires']) { const th = el('th', null, h); th.scope = 'col'; hr.appendChild(th); }
    const ath = el('th', 'cp-actions', null);
    ath.scope = 'col';
    ath.appendChild(el('span', 'cp-sr', 'Actions'));
    hr.appendChild(ath);
    thead.appendChild(hr);
    const tbody = el('tbody');
    for (const c of clients) {
      const st = clientStatus(c, now);
      const tr = el('tr', `cp-row cp-row-${st.key}`);
      const name = el('td', 'cp-name');
      name.append(el('div', 'cp-name-main', c.name), el('div', 'cp-id', c.id));
      const status = el('td');
      const pill = el('span', `cp-status cp-tone-${st.tone}`, st.label);
      status.appendChild(pill);
      const seen = el('td', 'cp-num');
      const seenText = lastSeenText(c.lastSeenTs, now);
      if (seenText) { seen.textContent = seenText; seen.title = formatTime(c.lastSeenTs); } else seen.appendChild(dash('Never'));
      const depth = el('td', 'cp-num');
      const d = depthText(c.spoolDepth);
      if (d != null) depth.textContent = d; else depth.appendChild(dash('No value'));
      const tap = el('td', 'cp-num');
      if (c.tapVersion) tap.textContent = c.tapVersion; else tap.appendChild(dash('No value'));
      const cert = el('td', 'cp-num');
      const ce = certExpiry(c, now);
      if (ce) {
        cert.textContent = ce.text;
        cert.title = ce.title;
        if (ce.tone !== 'neutral') cert.classList.add(`cp-cert-${ce.tone}`);
      } else cert.appendChild(dash('No certificate'));
      tr.append(name, status, seen, depth, tap, cert, actionCell(c));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    body.appendChild(table);
  }

  document.body.appendChild(dlg);
  dlg.showModal();
  load();
  if (addClient) showCode(null);
  return dlg;
}
