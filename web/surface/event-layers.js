// web/surface/event-layers.js
// The event and flow layers of the command view: gate verdicts, guard
// refusals, the merge queue, usage to providers and edit trails. Each reads a
// feed Surface or the rest of GLMPS already has; a layer whose feed is missing
// says so in its legend and draws nothing (usage hides its row entirely).
// The models are pure and exported for tests.
import { bindItem } from '../shared/interactive-item.js';
import { linkFor } from '../shared/deep-link.js';
import { LAYERS, FEEDS, SURFACE_ITEM_TYPES, svgEl, place, arcPath, linkOn } from './layers.js';

export const ARC_MIN_PX = 1.5;
export const ARC_MAX_PX = 7;
export const USAGE_HOURS = 168;
FEEDS.refusals = '/api/guards/refusals';
FEEDS.mergeQueue = '/api/merge-queue';
FEEDS.usage = `/api/usage/providers?hours=${USAGE_HOURS}`;
FEEDS.openPrs = '/api/surface/open-prs';

export const EVENT_ITEM_TYPES = { 'provider-arc': 'the provider\'s spend, tokens and sessions from the local store' };
Object.assign(SURFACE_ITEM_TYPES, EVENT_ITEM_TYPES);

// Which platform on the globe stands for a provider the usage feed names.
// OpenAI and "other" have no platform of their own, so they are listed in the
// legend and not drawn.
const PROVIDER_PLAYER = { anthropic: 'anthropic', google: 'gcp', gemini: 'gcp' };
const num = (n) => (Number.isFinite(n) ? n : 0);
const usd = (n) => `$${n.toFixed(2)}`;

export function providerArcs(body, players = []) {
  const providers = Array.isArray(body?.providers) ? body.providers.filter((p) => p && typeof p.id === 'string') : [];
  const have = new Set(players.map((p) => p.id));
  const useSpend = providers.length > 0 && providers.every((p) => Number.isFinite(p.spendUsd));
  const weight = (p) => (useSpend ? num(p.spendUsd) : num(p.tokens));
  const total = providers.reduce((n, p) => n + weight(p), 0);
  const arcs = []; const unplaced = [];
  for (const p of providers) {
    const w = weight(p);
    if (w <= 0 || total <= 0) continue;
    const playerId = PROVIDER_PLAYER[p.id] && have.has(PROVIDER_PLAYER[p.id]) ? PROVIDER_PLAYER[p.id] : null;
    if (!playerId) { unplaced.push(p); continue; }
    const share = w / total;
    arcs.push({ ...p, playerId, share, widthPx: ARC_MIN_PX + (ARC_MAX_PX - ARC_MIN_PX) * share });
  }
  const totalLabel = useSpend ? usd(total) : `${Math.round(total).toLocaleString('en-US')} tokens`;
  return { arcs, unplaced, providers, weightedBy: useSpend ? 'spend' : 'tokens', total, totalLabel };
}

export const gateVerdicts = (events, asOf) => (events ?? []).filter((e) => e.kind === 'gate' && (asOf == null || e.ts <= asOf)).sort((a, b) => b.ts - a.ts);

export function refusalSummary(body) {
  const byHook = Object.entries(body?.byHook ?? {}).map(([hook, c]) => ({ hook, checks: num(c?.checks), refusals: num(c?.refusals) }));
  return { total: byHook.reduce((n, h) => n + h.refusals, 0), byHook, recent: Array.isArray(body?.recent) ? body.recent : [] };
}

export function mergeQueueSummary(body) {
  const branches = Array.isArray(body?.branches) ? body.branches : [];
  const rows = branches.flatMap((b) => (b.requests ?? []).map((r) => ({ ...r, branch: b.branch, repo: b.repo })));
  return { requests: rows.length, branches: branches.length, rows };
}

// One legend row per open PR, opening it on GitHub, where it is reviewed and approved.
export function openPrRows(prs, now = Date.now()) {
  const age = (iso) => { const h = Math.max(0, (now - Date.parse(iso)) / 3600000); return h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
  return (prs ?? []).map((p) => ({
    type: 'open-pr', id: `${p.repo}#${p.number}`, href: p.url,
    text: [`${p.repo}#${p.number}`, p.title, p.draft ? 'draft' : null, p.queue ? `queue: ${p.queue.stage ?? 'filed'} (${p.queue.cardId})` : null, p.updatedAt ? age(p.updatedAt) : null].filter(Boolean).join('  '),
  }));
}

// One trail per session: the repositories it edited, oldest first, a repeat of
// the same repository folded. A session needs two places to have a trail.
export function trailsBySession(edits) {
  const by = new Map();
  for (const e of edits ?? []) {
    if (!e.sessionId || !e.repo) continue;
    if (!by.has(e.sessionId)) by.set(e.sessionId, []);
    by.get(e.sessionId).push(e);
  }
  const out = [];
  for (const [sessionId, rows] of by) {
    const repos = [];
    for (const r of rows.sort((a, b) => a.ts - b.ts)) if (repos.at(-1) !== r.repo) repos.push(r.repo);
    if (repos.length >= 2) out.push({ sessionId, repos });
  }
  return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const feedFact = (feed) => ['feed', feed?.ok ? `fetched ${Math.round((Date.now() - feed.fetchedAt) / 1000)} s ago` : `not available: ${feed?.error ?? 'no data'}`];

// A count pill beside a platform. It opens the layer's legend, like the row.
function badge(api, group, { layerId, anchor, slot }) {
  const g = svgEl('g', `event-badge badge-${layerId}`);
  const bg = svgEl('rect', 'badge-bg'); bg.setAttribute('height', '18'); bg.setAttribute('y', '-9'); bg.setAttribute('rx', '9');
  const tx = svgEl('text', 'badge-text'); tx.setAttribute('x', '9'); tx.setAttribute('y', '4');
  g.append(bg, tx);
  group.appendChild(g);
  let shown = false;
  bindItem(g, { type: 'layer', id: layerId, link: api.link({ type: 'layer', id: layerId }), open: () => api.open({ type: 'layer', id: layerId }), label: layerId });
  return {
    set(text, label) { shown = !!text; tx.textContent = text ?? ''; bg.setAttribute('width', String(Math.round((text ?? '').length * 6.6 + 18))); g.setAttribute('aria-label', label ?? text ?? ''); },
    place() { const c = shown ? api.playerScreen?.(anchor) ?? null : null; place(g, c ? [c[0] + 34, c[1] + 40 + slot * 22] : null); },
  };
}

const workLink = (id) => linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id } });

const gatesLayer = {
  id: 'gates', key: 'V', label: 'Gate verdicts', swatch: '#c96b52', group: 'events', source: 'GET /api/timeline (gate events, last 24 h)',
  build(api, group) {
    const b = badge(api, group, { layerId: 'gates', anchor: 'local', slot: 0 });
    let list = [];
    const out = {
      count: 0,
      refresh() {
        list = gateVerdicts(api.timeline?.get().events, api.timeline?.asOf() ?? null);
        out.count = list.length;
        b.set(list.length ? plural(list.length, 'gate verdict', 'gate verdicts') : null);
        api.globe.render();
      },
      facts: () => [['window', 'gate events in the 24 h timeline, up to the as-of time'], ['status', api.timeline?.get().status ?? 'loading']],
      rows: () => list.slice(0, 10).map((e) => ({ type: 'card', id: e.cardId ?? 'unknown', text: `${e.cardId ?? 'a card'}  ${e.state ?? 'gate'}  ${e.cardTitle ?? ''}`.trim(), link: workLink(e.cardId ?? ''), open: () => api.ctx.go(workLink(e.cardId ?? '')) })).filter((r) => r.id !== 'unknown'),
      place() { b.place(); },
    };
    return out;
  },
};

const refusalsLayer = {
  id: 'refusals', key: 'U', label: 'Guard refusals', swatch: '#e0a23a', group: 'events', source: 'GET /api/guards/refusals',
  build(api, group) {
    const feed = api.data.refusals;
    const b = badge(api, group, { layerId: 'refusals', anchor: 'local', slot: 1 });
    if (!feed?.ok) return { count: null, facts: () => [feedFact(feed)], place() {} };
    const s = refusalSummary(feed.data);
    b.set(s.total ? plural(s.total, 'guard refusal', 'guard refusals') : null);
    return {
      count: s.total,
      facts: () => [feedFact(feed), ...s.byHook.map((h) => [h.hook, `${h.refusals} of ${h.checks} checks refused`])],
      rows: () => s.recent.slice(0, 10).map((r) => ({ type: 'layer', id: 'refusals', text: `${r.hook}: ${r.reason || 'no reason given'}`, link: api.link({ type: 'layer', id: 'refusals' }), open: () => {} })),
      place() { b.place(); },
    };
  },
};

const queueLayer = {
  id: 'queue', key: 'M', label: 'Merge queue', swatch: '#7ea8b8', group: 'work', source: 'GET /api/merge-queue',
  build(api, group) {
    const feed = api.data.mergeQueue;
    const b = badge(api, group, { layerId: 'queue', anchor: 'github', slot: 0 });
    if (!feed?.ok) return { count: null, facts: () => [feedFact(feed)], place() {} };
    const q = mergeQueueSummary(feed.data);
    b.set(q.requests ? `${plural(q.requests, 'request', 'requests')} in the queue` : null);
    return {
      count: q.requests,
      facts: () => [feedFact(feed), ['branches', q.branches]],
      rows: () => q.rows.slice(0, 10).map((r) => ({ type: 'card', id: r.id, text: `${r.id}  ${r.stage ?? ''} round ${r.round ?? 1}  ${r.repo}/${r.branch}`, link: workLink(r.id), open: () => api.ctx.go(workLink(r.id)) })),
      place() { b.place(); },
    };
  },
};

const openPrsLayer = {
  id: 'prs', key: 'Q', label: 'Open PRs', swatch: '#a371f7', group: 'work', source: 'GET /api/surface/open-prs (gh search prs, open, on the signed-in account)',
  build(api, group) {
    const feed = api.data.openPrs;
    const b = badge(api, group, { layerId: 'prs', anchor: 'github', slot: 1 });
    if (!feed?.ok) return { count: null, facts: () => [feedFact(feed)], place() {} };
    const prs = feed.data?.prs ?? [];
    const drafts = prs.filter((p) => p.draft).length;
    const queued = prs.filter((p) => p.queue).length;
    b.set(prs.length ? `${plural(prs.length, 'open PR', 'open PRs')}` : null);
    return {
      count: prs.length,
      facts: () => [feedFact(feed), ['account', feed.data?.owner ?? 'unknown'], ['drafts', drafts], ['in the merge queue', queued], ['order', 'most recently updated first'], ...(feed.data?.truncated ? [['shown', 'the first 100 only']] : [])],
      rows: () => openPrRows(prs),
      place() { b.place(); },
    };
  },
};

const usageLayer = {
  id: 'usage', key: 'W', label: 'Usage to providers', swatch: '#b48cff', group: 'links', link: true, source: `GET /api/usage/providers?hours=${USAGE_HOURS}`,
  build(api, group) {
    const feed = api.data.usage;
    // No feed means no layer: the row is hidden rather than showing a dead toggle.
    if (!feed?.ok) return { hidden: true, count: null, place() {} };
    const m = providerArcs(feed.data, api.players ?? []);
    const to = new Map((api.players ?? []).map((p) => [p.id, [p.lon, p.lat]]));
    const arcs = m.arcs.map((a) => {
      const p = svgEl('path', 'usage-arc');
      p.setAttribute('stroke-width', a.widthPx.toFixed(2));
      group.appendChild(p);
      const detail = `${a.label}: ${m.weightedBy === 'spend' ? usd(a.spendUsd) : `${num(a.tokens).toLocaleString('en-US')} tokens`}, ${plural(num(a.sessions), 'session', 'sessions')}, ${Math.round(a.share * 100)}% of usage`;
      bindItem(p, { type: 'provider-arc', id: a.id, link: api.link({ type: 'provider-arc', id: a.id }), open: () => api.open({ type: 'provider-arc', id: a.id }), label: `Usage to ${detail}` });
      return { a, p };
    });
    api.registerOpener('provider-arc', (id) => {
      const x = m.providers.find((p) => p.id === id);
      if (!x) return false;
      api.inspect({ title: x.label ?? x.id, word: `Usage over the last ${USAGE_HOURS / 24} days`, facts: [['spend', x.spendUsd == null ? 'not recorded' : usd(x.spendUsd)], ['tokens', num(x.tokens).toLocaleString('en-US')], ['sessions', num(x.sessions)], ['arc', m.arcs.some((a) => a.id === id) ? 'drawn from the local store' : 'not drawn: no platform for this provider, or no usage']] });
      return true;
    });
    return {
      count: m.totalLabel,
      touches: (placeId) => placeId === 'local' || m.arcs.some((a) => a.playerId === placeId),
      facts: () => [feedFact(feed), ['arc width', m.weightedBy === 'spend' ? 'share of spend' : 'share of tokens (some providers have no cost recorded)'], ...(m.unplaced.length ? [['not drawn', m.unplaced.map((p) => p.label ?? p.id).join(', ')]] : [])],
      place(project) {
        for (const { a, p } of arcs) {
          const d = api.local && to.get(a.playerId) && linkOn(api, 'usage', ['local', a.playerId]) ? arcPath(api.d3, api.local, to.get(a.playerId), project) : '';
          p.setAttribute('d', d);
          if (d) { p.removeAttribute('display'); p.setAttribute('tabindex', '0'); } else { p.setAttribute('display', 'none'); p.setAttribute('tabindex', '-1'); }
        }
      },
    };
  },
};

const trailsLayer = {
  id: 'trails', key: 'T', label: 'Edit trails', swatch: '#3ddc84', group: 'links', link: true, source: 'GET /api/surface/edits (the last hour of edits, by session)',
  build(api, group) {
    let trails = [];
    const paths = new Map();
    const out = {
      count: 0,
      refresh() {
        const asOf = api.timeline?.asOf() ?? null;
        trails = trailsBySession((api.edits?.get().edits ?? []).filter((e) => asOf == null || e.ts <= asOf));
        out.count = trails.length;
        const keep = new Set(trails.map((t) => t.sessionId));
        for (const [id, p] of paths) if (!keep.has(id)) { p.remove(); paths.delete(id); }
        for (const t of trails) if (!paths.has(t.sessionId)) { const p = svgEl('path', 'edit-trail'); p.setAttribute('aria-hidden', 'true'); group.appendChild(p); paths.set(t.sessionId, p); }
        api.globe.render();
      },
      touches: (placeId) => placeId === 'local',
      facts: () => [['source', 'edits seen in the last hour; one dashed line per session through the repositories it edited, oldest first'], ['sessions with a trail', trails.length]],
      place(project, cam) {
        const on = linkOn(api, 'trails', ['local']);
        for (const t of trails) {
          if (!on) { paths.get(t.sessionId)?.setAttribute('d', ''); continue; }
          const pts = t.repos.map((r) => api.repoPos?.(r)).filter(Boolean).map((ll) => project(ll));
          const head = api.agentPos?.(t.sessionId, cam.k);
          const hp = head ? project(head) : null;
          const seq = [...pts, hp].filter(Boolean);
          paths.get(t.sessionId)?.setAttribute('d', seq.length > 1 ? `M${seq.map((s) => `${s[0].toFixed(1)},${s[1].toFixed(1)}`).join('L')}` : '');
        }
      },
    };
    return out;
  },
};

LAYERS.push(gatesLayer, refusalsLayer, queueLayer, openPrsLayer, usageLayer, trailsLayer);
