// When GLMPS is reached over the LAN, mutating/secret routes require the shared
// token (see the non-local-bind spec). The token is entered in Settings and kept
// in localStorage; we attach it as `Authorization: Bearer` to same-origin requests.
// Harmless on localhost: the server's loopback bypass ignores it. Since the
// 2026-10-13 hardening every remote /api read needs the token too; SSE (/api/events)
// cannot send a header, so it carries the token via withAccessToken. The wiki
// iframe shows untrusted HTML, so it carries only a read-only wiki ticket
// (getWikiTicket). <img> icon loads (/api/icon/*) stay open.
import { triggerDownload } from './export.js';

const TOKEN_KEY = 'glmps_token';
export function getAccessToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
export function setAccessToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}

// Scan 2026-10-15 F2: file, terminal, resume, open-in-editor and restart need
// the local session from loopback too. The desktop shell adds the header
// itself; a plain browser stores it once via /local-auth.html (the link
// `npm run dashboard-link` prints).
const LOCAL_SESSION_KEY = 'glmps_local_session';
export const LOCAL_SESSION_HEADER = 'X-GLMPS-Local-Session';
export function getLocalSession() { try { return localStorage.getItem(LOCAL_SESSION_KEY) || ''; } catch { return ''; } }
/** Store a session value from the dashboard link; false when it is not one or cannot be stored. */
export function acceptLocalSession(v) {
  if (!/^[0-9a-f]{64}$/.test(String(v ?? ''))) return false;
  try { localStorage.setItem(LOCAL_SESSION_KEY, v); return true; } catch { return false; }
}
const LOCAL_SESSION_TOAST = 'This browser is not authorized for file and terminal actions. Run `npm run dashboard-link` and open the link it prints, or use the desktop app.';

// Baseline 2026-10-17 (card glmps-2-0-53): one page load fetched /api/backlog
// (2.2 MB) up to 3 times and /api/alerts 3 times, because the shell badge, the
// lens and its panels each fetch on their own. Same-origin /api GETs therefore
// share one in-flight request, and a finished response is reused for ttlMs;
// every caller gets its own clone, so each may read the body once as usual.
// The SSE stream, non-GETs and `cache: 'no-store'` requests always go out.
export function createGetDeduper(fetchImpl, { ttlMs = 1000, now = () => Date.now() } = {}) {
  const entries = new Map();
  // A response without clone() (a test double) cannot be shared, so it is
  // handed through and never kept.
  const share = (r) => (typeof r?.clone === 'function' ? r.clone() : r);
  // `url` is the cache key; the request itself goes out as the caller wrote it.
  const get = (url, init = {}, input = url) => {
    const hit = entries.get(url);
    if (hit && (hit.pending || now() - hit.at < ttlMs)) return hit.promise.then(share);
    const entry = { pending: true, at: 0, promise: null };
    entry.promise = fetchImpl(input, init).then(
      (r) => { entry.pending = false; entry.at = now(); if (!r?.ok || typeof r.clone !== 'function') entries.delete(url); return r; },
      (e) => { entries.delete(url); throw e; },
    );
    entries.set(url, entry);
    return entry.promise.then(share);
  };
  // Finished responses are dropped; in-flight ones still resolve their callers.
  get.clear = () => { for (const [k, v] of entries) if (!v.pending) entries.delete(k); };
  return get;
}

// Set by the window wrapper below: a write or a server event makes every
// cached GET stale, so the next read goes to the server.
let clearGetCache = () => {};

export function isDedupableGet(input, init = {}, origin) {
  if (input instanceof Request) return false;
  if ((init.method ?? 'GET').toUpperCase() !== 'GET' || init.cache === 'no-store' || init.body != null) return false;
  let u;
  try { u = new URL(String(input), origin); } catch { return false; }
  return u.origin === new URL(origin).origin && u.pathname.startsWith('/api/') && u.pathname !== '/api/events';
}

if (typeof window !== 'undefined' && typeof window.fetch === 'function' && !window.__glmpsFetchWrapped) {
  window.__glmpsFetchWrapped = true;
  const _rawFetch = window.fetch.bind(window);
  // 5 s covers the shell, the lens and its panels asking during one mount;
  // writes and server events clear it, so it never hides a change.
  const _dedupe = createGetDeduper(_rawFetch, { ttlMs: 5000 });
  clearGetCache = _dedupe.clear;
  const _fetch = (input, init) => {
    if (typeof location !== 'undefined' && isDedupableGet(input, init, location.href)) return _dedupe(new URL(String(input), location.href).href, init, input);
    if ((init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() !== 'GET') _dedupe.clear();
    return _rawFetch(input, init);
  };
  window.fetch = (input, init = {}) => {
    const tok = getAccessToken();
    const local = getLocalSession();
    let sameOrigin = true;
    try {
      const target = input instanceof Request ? input.url : input;
      sameOrigin = new URL(target, location.href).origin === location.origin;
    } catch { sameOrigin = true; }
    if ((tok || local) && sameOrigin) {
      const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      if (tok && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + tok);
      if (local && !headers.has(LOCAL_SESSION_HEADER)) headers.set(LOCAL_SESSION_HEADER, local);
      init = { ...init, headers };
    }
    return _fetch(input, init).then(async (r) => {
      if (r && r.status === 401 && sameOrigin) {
        let reason = '';
        try { reason = (await r.clone().json())?.error || ''; } catch {}
        const detail = reason === 'local-session-required' ? LOCAL_SESSION_TOAST : 'Access token required. Set it in Settings (gear menu).';
        try { window.dispatchEvent(new CustomEvent('mc-toast', { detail })); } catch {}
      }
      return r;
    });
  };
}

/** `limit` and `before` page a session's feed server-side: the newest `limit` events older than `before`. */
export async function getState(session, { limit, before } = {}) {
  let q = session ? `?session=${encodeURIComponent(session)}` : '';
  if (session && limit) q += `&limit=${encodeURIComponent(limit)}`;
  if (session && before != null) q += `&before=${encodeURIComponent(before)}`;
  return (await fetch(`/api/state${q}`)).json();
}
/** The shell's periodic refresh: live sessions, board, tools and health only (~10 KB, not 2.5 MB). `include` keeps one extra session's summary. */
export async function getStateSlim(include) {
  const q = include ? `&include=${encodeURIComponent(include)}` : '';
  return (await fetch(`/api/state?slim=1${q}`)).json();
}
/** One-time loads: only the named top-level fields of the full state. */
export async function getStateFields(fields) {
  return (await fetch(`/api/state?fields=${fields.map(encodeURIComponent).join(',')}`)).json();
}
/** Remote mode: EventSource and iframes cannot send Authorization, so the stored token rides the URL (reads only). */
export function withAccessToken(url, token = getAccessToken()) {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
}
/**
 * a short-lived, read-only ticket for the wiki lens's sandboxed iframe
 * (whose untrusted script can read its own URL, so it never gets the token).
 * Fetched with the normal Authorization header; cached until a minute before
 * expiry. Never throws: '' means "no ticket" (loopback needs none).
 */
// Scan 2026-10-15 F4: a ticket opens only the wiki it was minted for, so one
// is cached per wiki base ('/wiki' or '/wiki-ext/<project>').
const _wikiTickets = new Map();
export function _resetWikiTicketCache() { _wikiTickets.clear(); }
export async function getWikiTicket(base = '/wiki', now = Date.now()) {
  const cached = _wikiTickets.get(base);
  if (cached && cached.expiresAt - 60_000 > now) return cached.ticket;
  try {
    const r = await fetch(`/api/wiki/ticket?base=${encodeURIComponent(base)}`);
    if (!r.ok) return '';
    const j = await r.json();
    if (!j || typeof j.ticket !== 'string' || !j.ticket) return '';
    _wikiTickets.set(base, { ticket: j.ticket, expiresAt: Number(j.expiresAt) || 0 });
    return j.ticket;
  } catch { return ''; }
}
export function onEvents(handler) {
  const es = new EventSource(withAccessToken('/api/events'));
  es.onmessage = m => { clearGetCache(); try { handler(JSON.parse(m.data)); } catch {} };
  return es;
}
export async function search(q, filters = {}) {
  const p = new URLSearchParams({ q });
  if (filters.messageType) p.set('messageType', filters.messageType);
  if (filters.hasErrors) p.set('hasErrors', '1');
  if (filters.hasToolCalls) p.set('hasToolCalls', '1');
  if (filters.hasFileChanges) p.set('hasFileChanges', '1');
  if (filters.project) p.set('project', filters.project);
  if (filters.dateRange?.from) p.set('from', filters.dateRange.from);
  if (filters.dateRange?.to) p.set('to', filters.dateRange.to);
  return (await fetch(`/api/search?${p.toString()}`)).json();
}
export async function readFile(p) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(p)}`);
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `read failed (${r.status})`); }
  return r.json();
}
export async function saveFile(path, content, hash, force = false) {
  const r = await fetch('/api/file', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content, hash, force }) });
  return { status: r.status, body: await r.json() };
}
export async function undoFile(path) {
  return (await fetch('/api/file/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })).json();
}
export async function resume(sessionId, cwd, location) {
  const res = await fetch('/api/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, cwd, location }) });
  const json = await res.json();
  // a non-2xx response (a non-UUID id, a missing
  // antigravityCommand, a terminal that did not start) used to resolve
  // normally, so every caller's success toast fired regardless.
  if (!res.ok) throw new Error(json?.error || `resume failed (${res.status})`);
  return json;
}
export async function steerSession(id, note) {
  const r = await fetch(`/api/workspace/${encodeURIComponent(id)}/steer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error || `steer failed (${r.status})`);
  return json;
}
export async function getApprovals() {
  const r = await fetch('/api/approvals');
  if (!r.ok) throw new Error(`approvals ${r.status}`);
  return r.json();
}
export async function getPersonality() {
  const r = await fetch('/api/personality');
  if (!r.ok) throw new Error(`GET /api/personality returned ${r.status}`);
  return r.json();
}
export async function openInEditor(path, kind) {
  const r = await fetch('/api/open-in-editor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind ? { path, kind } : { path }) });
  return { status: r.status, body: await r.json() };
}
export async function getConfig() { return (await fetch('/api/config')).json(); }
export async function getGuardAutoApprove() { return (await fetch('/api/settings/guard-auto-approve')).json(); }
export async function setGuardAutoApprove(enabled) {
  const r = await fetch('/api/settings/guard-auto-approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
export async function getTimeZone() { return (await fetch('/api/settings/timezone')).json(); }
export async function setTimeZone(timeZone) {
  const r = await fetch('/api/settings/timezone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeZone }) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
export async function getAlerts(opts = {}) {
  const o = typeof opts === 'boolean' ? { evidence: opts } : (opts || {});
  const params = new URLSearchParams();
  if (o.evidence) params.set('evidence', '1');
  if (o.all) params.set('all', '1');
  const qs = params.toString();
  return (await fetch('/api/alerts' + (qs ? `?${qs}` : ''))).json();
}
export async function ackAlert(id, undo = false) {
  const r = await fetch('/api/alerts/ack', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(undo ? { id, undo: true } : { id }),
  });
  return { status: r.status, body: await r.json() };
}
export async function getCoverage() { return (await fetch('/api/coverage')).json(); }
export async function launchTerminal(terminal, cwd, isolate) {
  const r = await fetch('/api/terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ terminal, cwd, isolate: !!isolate }) });
  return { status: r.status, body: await r.json() };
}
export async function restartServer() {
  return (await fetch('/api/restart', { method: 'POST' })).json();
}
// Card glmps-2-0-170: Settings > Server "Restart" (update, rebuild if stale, restart).
export async function restartAll() {
  const r = await fetch('/api/actions/restart-all', { method: 'POST' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
// Clients panel (server-and-client-tap task 8). Each answers { status, body } so
// the panel can name a refusal rather than throw it away.
async function clientCall(url, method = 'GET', body) {
  const init = method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) };
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
export const listClients = () => clientCall('/api/clients');
export const mintPairCode = (clientId = null) => clientCall('/api/tap/pair-code', 'POST', clientId ? { clientId } : {});
export const revokeClient = (id) => clientCall(`/api/clients/${encodeURIComponent(id)}/revoke`, 'POST');
export const getInstallerInfo = () => clientCall('/api/tap/release');
export async function health() {
  try { return (await fetch('/api/health')).ok; } catch { return false; }
}
export async function getLearning() { return (await fetch('/api/learning')).json(); }
export async function addIdea(text) {
  return (await fetch('/api/learning/idea', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json();
}
export async function learningAction(id, action, arg) {
  // promote carries a { target } ('global'|'memory'); alternative carries a { rule }.
  const body = action === 'promote' ? { target: arg } : (arg != null ? { rule: arg } : {});
  const res = await fetch(`/api/learning/item/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  // Guard proposer cutover: a non-2xx response (e.g.
  // approving an item with no proposedGuard.rule now 400s) must throw, or
  // every caller's wireAction/run() sees a "successful" resolved promise and
  // renders as if the action landed - the dashboard silently claiming an
  // approval succeeded when it 400'd server-side.
  if (!res.ok) throw new Error(json?.error || `learning ${action} failed (${res.status})`);
  return json;
}
// setLearningConfig (the autoApplyGaps toggle) is retired (guard proposer
// cutover, Task 10, fix round 1): POST /api/learning/config no longer
// exists, and had no caller in this dashboard either.

// The legacy learning store above holds PROPOSALS. These three read and act on
// the ledger, which holds the guards that actually landed, with provenance,
// decay and the reflex promotion gate. Same board, different question.
export async function getLessons() { return (await fetch('/api/lessons')).json(); }
/** Promote a lesson to the reflex layer. humanApproved is required by the gate. */
export async function promoteLesson(id, body = {}) {
  return (await fetch(`/api/lessons/${encodeURIComponent(id)}/promote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ humanApproved: true, ...body }),
  })).json();
}
export async function revokeLesson(id, body = {}) {
  return (await fetch(`/api/lessons/${encodeURIComponent(id)}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
}
export async function fetchBudget() { return (await fetch('/api/budget')).json(); }
export async function fetchEngagement() { return (await fetch('/api/engagement')).json(); }
export async function getAgents() { return (await fetch('/api/agents')).json(); }
export async function getGraph(project, session, scope) {
  const q = new URLSearchParams();
  if (project) q.set('project', project);
  if (session) q.set('session', session);
  if (scope) q.set('scope', scope);
  return (await fetch('/api/graph?' + q)).json();
}
// The secondary graph scan (card glmps-2-0-101). Each resolves to { status, body }
// so the panel can show the server's own refusal text.
const statusJson = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
export async function getGraphMachine() { return statusJson(await fetch('/api/graph/machine')); }
export async function setGraphMachine(patch) {
  return statusJson(await fetch('/api/graph/machine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }));
}
export async function buildMachineGraph() {
  return statusJson(await fetch('/api/graph/machine/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
}
/** Card counts by state, without the item list (the shell badge needs only these). */
export async function getBacklogCounts() {
  const r = await fetch('/api/backlog?counts=1');
  if (!r.ok) throw new Error(`GET /api/backlog?counts=1 returned ${r.status}`);
  return (await r.json()).counts ?? {};
}
export async function getBacklog(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  return (await fetch(`/api/backlog${q}`)).json();
}
/** Only the named cards, plus the ids that no longer exist. */
export async function getBacklogCards(ids) {
  const r = await fetch(`/api/backlog?ids=${encodeURIComponent(ids.join(','))}`);
  if (!r.ok) throw new Error(`GET /api/backlog?ids returned ${r.status}`);
  return r.json();
}
// a non-2xx response (e.g. POST /api/backlog 400 on an
// empty title) used to resolve with the server's error body instead of
// rejecting - every caller's try/catch saw a "successful" resolved promise
// and treated the item as filed. Same fix as learningAction above.
export async function addBacklogItem(item) {
  const res = await fetch('/api/backlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || `backlog item failed (${res.status})`);
  return json;
}
export async function updateBacklogItem(id, patch) {
  return (await fetch(`/api/backlog/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).json();
}
export async function setBacklogPaused(paused) {
  return (await fetch('/api/backlog/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) })).json();
}
export async function approveBacklogItem(id) {
  return (await fetch(`/api/backlog/${encodeURIComponent(id)}/approve`, { method: 'POST' })).json();
}
export async function appendTicketDevlog(id, entry) {
  return (await fetch(`/api/backlog/${encodeURIComponent(id)}/devlog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) })).json();
}
export async function setTicketGate(id, gate) {
  return (await fetch(`/api/backlog/${encodeURIComponent(id)}/gate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(gate) })).json();
}

export async function getRunner() { return (await fetch('/api/runner')).json(); }
export async function setRunnerConfig(patch) {
  return (await fetch('/api/runner/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).json();
}
export async function runBacklogItem(id) {
  const r = await fetch(`/api/runner/run/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}


export async function graphStatus() {
  return (await fetch('/api/graph/status')).json();
}
// same fix as addBacklogItem above (a non-2xx used to
// resolve instead of reject). On success the real route (server/server.js)
// answers { graphs, skipped }, where skipped is [{ root, reason:
// 'graphify-busy' }] for any root the request named but could not rebuild
// because a rebuild was already running for it - that is NOT an error
// (res.ok is still true, no error field), so callers must read skipped
// themselves to distinguish "rebuilt" from "busy, not rebuilt this time".
export async function rebuildGraph(root) {
  const body = root ? { root } : {};
  const res = await fetch('/api/graph/rebuild', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || `graph rebuild failed (${res.status})`);
  // 202 means this request's own rebuild outlived the reply budget; the
  // running list is server-wide and cannot say that on its own.
  return { ...json, pending: res.status === 202 };
}
export async function learningStatus() {
  return (await fetch('/api/learning/status')).json();
}
export async function runSynth(days) {
  const body = days != null ? { days } : {};
  return (await fetch('/api/learning/synth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
}


export async function reorderBacklog({ project, status, ids }) {
  const r = await fetch('/api/backlog/reorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, status, ids }) });
  if (!r.ok) throw new Error('reorder failed'); return r.json();
}
export async function deleteBacklogItem(id) {
  const r = await fetch(`/api/backlog/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('delete failed'); return r.json();
}
export async function getProjects() {
  const r = await fetch('/api/projects'); if (!r.ok) throw new Error('projects failed'); return r.json();
}
export async function postTerminal({ terminal, cwd }) {
  const r = await fetch('/api/terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ terminal, cwd }) });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error || 'terminal failed');
  }
  return r.json();
}


/** GET /api/governance/policy
 * Returns { configured, path, policy, targets, vendors }.
 * When configured:false the UI starts from an empty editable state.
 */
export async function getPolicy() {
  const r = await fetch('/api/governance/policy');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** GET /api/governance/policy/library
 * The Guardrail Policy Library (directives + situation packs) for the editor's picker.
 */
export async function getPolicyLibrary() {
  const r = await fetch('/api/governance/policy/library');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** PUT /api/governance/policy
 * Body: { policy:[{id,text,enabled,tags}], targets:[{vendor,path}], autoPush }
 * Returns the saved object (server re-slugs ids and validates paths). When autoPush
 * is true the response also carries `pushed:[...results]`.
 */
export async function savePolicy(policy, targets, autoPush) {
  const r = await fetch('/api/governance/policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy, targets, autoPush: !!autoPush }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** POST /api/governance/policy/preview
 * Read-only - returns [{vendor,path,exists,action,before,after}].
 * No writes; shows what push would do.
 */
export async function previewPolicy() {
  const r = await fetch('/api/governance/policy/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** POST /api/governance/policy/push
 * Mutating. Optional body: { vendors:[ids] } to filter targets.
 * Returns [{vendor,path,action,reason?}].
 */
export async function pushPolicy(vendors) {
  const body = vendors ? { vendors } : {};
  const r = await fetch('/api/governance/policy/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function getMemoryProposals() {
  return (await fetch('/api/memory/proposals')).json();
}
export async function approveMemoryProposal(id) {
  return (await fetch(`/api/memory/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST' })).json().catch(() => ({}));
}
export async function rejectMemoryProposal(id) {
  return (await fetch(`/api/memory/proposals/${encodeURIComponent(id)}/reject`, { method: 'POST' })).json().catch(() => ({}));
}

// Propose-only pipeline: quarantined -> pending-approval -> approved -> trialing
// -> kept | rejected. Every forward transition is an explicit human-gate call.
export async function getCrossAgentMemory() {
  return (await fetch('/api/cross-agent-memory')).json();
}
export async function captureCrossAgentMemory() {
  return (await fetch('/api/cross-agent-memory/capture', { method: 'POST' })).json().catch(() => ({}));
}
export async function approveCrossAgentMemory(id) {
  return (await fetch(`/api/cross-agent-memory/${encodeURIComponent(id)}/approve`, { method: 'POST' })).json().catch(() => ({}));
}
export async function rejectCrossAgentMemory(id) {
  return (await fetch(`/api/cross-agent-memory/${encodeURIComponent(id)}/reject`, { method: 'POST' })).json().catch(() => ({}));
}
// A 'quarantined' item can't go straight to /approve (the store requires
// 'pending-approval' first) - this releases it into the pending-approval
// state so a follow-up Approve click succeeds. See memory.js's camHandlers.
export async function releaseQuarantineCrossAgentMemory(id) {
  return (await fetch(`/api/cross-agent-memory/${encodeURIComponent(id)}/release-quarantine`, { method: 'POST' })).json().catch(() => ({}));
}
export async function startTrialCrossAgentMemory(id) {
  return (await fetch(`/api/cross-agent-memory/${encodeURIComponent(id)}/start-trial`, { method: 'POST' })).json().catch(() => ({}));
}
export async function pushCrossAgentMemory() {
  return (await fetch('/api/cross-agent-memory/push', { method: 'POST' })).json().catch(() => ({}));
}

/** GET /api/skills - { skills:[{name,description,plugin,uses,lastSeen,installed}],
 * neverUsed:[...], installedAvailable }. Fail-open on the server; never throws here. */
export async function getSkills() {
  return (await fetch('/api/skills')).json();
}

// Same propose-only state machine shape as cross-agent memory / research
// candidates: discovered|quarantined -> pending-approval -> approved ->
// trialing -> kept|rejected. Each transition is its own explicit POST (never
// a generic PATCH - an externally-discovered skill's instructions are
// executable content, so only a human click ever advances a candidate).
// NOTE: there is no dedicated GET listing endpoint for skill-adopt-store's
// raw per-item status (GET /api/skills/lifecycle is a DIFFERENT route - the
// glmps-88 archive/update-candidate list). skills.js binds its Skill-adopt
// section to GET /api/changes (getChanges() below) instead, which is the
// only surface that already exposes these candidates read-only - see
// skills.js's own header comment for the status-collapsing consequence.
export async function releaseQuarantineSkillAdopt(id) {
  const r = await fetch(`/api/skills/lifecycle/${encodeURIComponent(id)}/release-quarantine`, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function approveSkillAdopt(id) {
  const r = await fetch(`/api/skills/lifecycle/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function startTrialSkillAdopt(id) {
  const r = await fetch(`/api/skills/lifecycle/${encodeURIComponent(id)}/start-trial`, { method: 'POST' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
export async function resolveTrialSkillAdopt(id, measured) {
  const r = await fetch(`/api/skills/lifecycle/${encodeURIComponent(id)}/resolve-trial`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(measured || {}),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** GET /api/changes - { changes: SystemChange[], scoreboard }. Used by
 * substrate-loop.js (own inline fetch) and skills.js's Skill-adopt section. */
export async function getChanges() {
  return (await fetch('/api/changes')).json();
}

/** Returns the URL for the AI Usage & Risk Baseline report.
 * @param {boolean} [download] - if true, adds ?download=1 to trigger file download
 */
export function baselineReportUrl(download) {
  return '/api/report/baseline' + (download ? '?download=1' : '');
}
/**
 * a header-less <a download> of an /api route is 401 for a remote client,
 * so fetch it (the fetch wrapper adds Authorization) and save it as a blob.
 * Throws on a non-2xx so the caller can surface it.
 */
export async function downloadBaselineReport({ save = triggerDownload } = {}) {
  const r = await fetch(baselineReportUrl(true));
  if (!r.ok) throw new Error(`baseline report export failed (${r.status})`);
  save('ai-usage-risk-baseline.html', await r.text(), 'text/html');
}
export async function getLoopCatalog() {
  const r = await fetch('/api/loops/catalog');
  if (!r.ok) throw new Error(`GET /api/loops/catalog returned ${r.status}`);
  return r.json();
}
