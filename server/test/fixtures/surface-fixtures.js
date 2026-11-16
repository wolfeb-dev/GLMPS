// server/test/fixtures/surface-fixtures.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVendorD3 } from './mini-dom.js';
import { parseLink } from '../../../web/shared/deep-link.js';
import { groupAlerts } from '../../lib/observability/alert-groups.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLAYERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'surface', 'players.json'), 'utf8'));
export const ROWS = [
  { repo: 'glmps', path: 'D:/glmps', remote: 'git@github.com:wolfeb-dev/glmps.git', defaultBranch: 'main', ahead: 1, behind: 3, unpushedBranches: ['feat/x'], noUpstreamBranches: [], dirty: 27, lastFetchTs: Date.now() - 60000, residency: 'diverged', ts: Date.now() },
  { repo: 'glmps-2.0', path: 'D:/glmps-2.0', remote: 'https://github.com/wolfeb-dev/glmps-2.0', defaultBranch: 'main', ahead: 0, behind: 0, unpushedBranches: [], noUpstreamBranches: [], dirty: 0, lastFetchTs: Date.now(), residency: 'synced', ts: Date.now() },
  { repo: 'tidewatch', path: 'D:/tidewatch', remote: null, defaultBranch: 'main', ahead: 0, behind: 0, unpushedBranches: [], noUpstreamBranches: ['main'], dirty: 0, lastFetchTs: null, residency: 'nowhere-else', ts: Date.now() },
];

// Track S contracts (docs/superpowers/plans/2026-10-14-surface-v2-study-fidelity.md):
// GET /api/surface/ledger and GET /api/surface/edits, faked here so the lens
// is built and tested without the server feeds.
export const LEDGER = {
  ts: Date.now(),
  types: [
    { id: 'markdown', label: 'Markdown documents', count: 2519, copies: [{ player: 'github', count: 362 }], onlyHere: 2157 },
    { id: 'config', label: 'Config files', count: 164, copies: [{ player: 'github', count: 155 }], onlyHere: 9 },
    { id: 'code', label: 'Code files', count: 1420, copies: [{ player: 'github', count: 1388 }], onlyHere: 32 },
    { id: 'projects', label: 'Projects', count: 32, copies: [{ player: 'github', count: 15 }], onlyHere: 17 },
    { id: 'cards', label: 'Kanban cards', count: 284, copies: [{ player: 'slack', count: 61 }], onlyHere: 223 },
    { id: 'sessions', label: 'Sessions', count: 1562, copies: [{ player: 'anthropic', count: 600 }, { player: 'gcp', count: null }], onlyHere: 38 },
    { id: 'learning', label: 'Learning loops', count: 361, copies: [], onlyHere: 361 },
    { id: 'alerts', label: 'Alerts', count: 35, copies: [], onlyHere: 35 },
  ],
};
const T0 = Date.now();
export const EDITS = {
  ts: T0, windowMs: 3600000,
  edits: [
    { path: 'D:/glmps/web/app.js', repo: 'glmps', rel: 'web/app.js', ts: T0 - 20000, add: 4, del: 1, sessionId: 's1', title: 'wire the globe', tool: 'claude-code', state: 'working', size: 2048, mtimeMs: T0 - 20000, change: null },
    { path: 'C:/Users/me/.claude/CLAUDE.md', repo: null, rel: null, ts: T0 - 240000, add: 3, del: 1, sessionId: 's2', title: 'memory pass', tool: 'claude-code', state: 'idle', size: 900, mtimeMs: T0 - 240000, change: { old: { text: 'old line', truncated: false }, new: { text: 'new line', truncated: false } } },
    { path: 'D:/glmps-2.0/gone.md', repo: 'glmps-2.0', rel: 'gone.md', ts: T0 - 900000, add: 0, del: 20, sessionId: 's3', title: null, tool: 'claude-code', state: 'idle', size: null, mtimeMs: null, change: null },
  ],
};

// GET /api/loops (keyed by loop name) and GET /api/alerts, shapes read from the
// live routes: one failing, one stale, one healthy timed loop; a critical and a
// warning alert at the local store and one at Slack.
export const LOOPS = {
  'git-remote-feed': { lastOutcome: 'done', lastRunTs: Date.now() - 120000, ageS: 120, consecutiveFailures: 0, lastReason: null, nextRunTs: Date.now() + 780000, trigger: { everyMs: 900000 }, sla: { maxAgeMs: 3600000 } },
  'nightly-run': { lastOutcome: 'done', lastRunTs: Date.now() - 200000000, ageS: 200000, consecutiveFailures: 0, lastReason: null, nextRunTs: null, trigger: { external: 'Windows Scheduled Task' }, sla: { maxAgeMs: 129600000 } },
  'wiki-build': { lastOutcome: 'failed', lastRunTs: Date.now() - 60000, ageS: 60, consecutiveFailures: 3, lastReason: 'build exited 1', nextRunTs: Date.now() + 60000, trigger: { everyMs: 120000 }, sla: { maxAgeMs: 600000 } },
};
const ALERT_LIST = [
    { id: 'a1', source: 'kernel-health', severity: 'warn', title: 'Kernel health: mem0-quarantine', acknowledged: false, target: { view: 'loops' } },
    { id: 'a2', source: 'kernel-health', severity: 'critical', title: 'Kernel health: plugin-retry-gaveup', acknowledged: false, target: { view: 'loops' } },
    { id: 'a3', source: 'capture-health', severity: 'warn', title: 'Capture health: slack silent', acknowledged: false, target: { view: 'tools' } },
    { id: 'a4', source: 'poison', severity: 'critical', title: 'Poison: acked', acknowledged: true, target: { view: 'loops' } },
];
// attention is the server grouping itself, as GET /api/alerts returns it.
export const ALERTS = { alerts: ALERT_LIST, attention: groupAlerts(ALERT_LIST) };

// GET /api/timeline?hours=24 (built on another branch; this is its contract):
// ascending by ts, one event per edit, card move, gate, alert or loop run.
export const TIMELINE = {
  hours: 24, from: T0 - 24 * 3600000, to: T0, truncated: false,
  events: [
    { ts: T0 - 20 * 3600000, kind: 'loop', loop: 'git-remote-feed', outcome: 'done' },
    { ts: T0 - 5 * 3600000, kind: 'card', cardId: 'mc-7', cardTitle: 'globe', state: 'queued' },
    { ts: T0 - 4 * 3600000, kind: 'alert', severity: 'critical', title: 'Kernel health: plugin-retry-gaveup' },
    { ts: T0 - 3 * 3600000, kind: 'edit', sessionId: 's1', path: 'D:/glmps/web/surface/globe.js', title: 'wire the globe' },
    { ts: T0 - 2 * 3600000, kind: 'edit', sessionId: 's1', path: 'D:/glmps/web/app.js', title: 'wire the globe' },
    { ts: T0 - 90 * 60000, kind: 'gate', cardId: 'mc-7', cardTitle: 'globe', state: 'in_review' },
    { ts: T0 - 60 * 60000, kind: 'card', cardId: 'mc-7', cardTitle: 'globe', state: 'in_progress' },
    { ts: T0 - 30 * 60000, kind: 'alert', severity: 'warn', title: 'Kernel health: mem0-quarantine' },
    { ts: T0 - 10 * 60000, kind: 'card', cardId: 'mc-8', cardTitle: 'thread', state: 'in_progress' },
  ],
};

export function surfaceFetch(overrides = {}) {
  const routes = {
    '/api/residency': { ts: Date.now(), rows: ROWS },
    '/api/config': { surface: { localGeo: { city: 'Testville', lon: -117.2, lat: 32.7, precision: 'city', source: 'operator' } } },
    '/surface/players.json': PLAYERS,
    '/api/backlog': { items: [] },
    '/api/surface/ledger': LEDGER,
    '/api/surface/edits': EDITS,
    '/api/loops': LOOPS,
    '/api/alerts': ALERTS,
    '/api/timeline': TIMELINE,
    ...overrides,
  };
  return async (url) => {
    const u = String(url).split('?')[0];
    if (u === '/vendor/countries-110m.json') return new Response('{"type":"Topology","transform":{"scale":[1,1],"translate":[0,0]},"arcs":[],"objects":{"countries":{"type":"GeometryCollection","geometries":[]}}}', { status: 200 });
    if (!(u in routes)) return new Response('{"error":"not found"}', { status: 404 });
    const v = routes[u];
    return v instanceof Response ? v : Response.json(v);
  };
}

export async function mountSurface(search, fetchImpl = surfaceFetch(), ctxExtra = {}) {
  globalThis.fetch = fetchImpl;
  window.d3 = loadVendorD3();
  const lens = await import('../../../web/surface/lens.js');
  const root = document.createElement('div'); document.body.appendChild(root);
  const go = [];
  const handle = await lens.mount(root, parseLink('/surface', search), { getState: () => ({ tools: [{ id: 'claude-code', sessionsFound: 12 }] }), toast: () => {}, go: (l) => go.push(l), handlers: {}, ...ctxExtra });
  return { root, handle, go };
}
