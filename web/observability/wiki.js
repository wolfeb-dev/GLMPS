// web/observability/wiki.js - Codebase Wiki: LLM-authored narrative docs per subsystem,
// with cross-links, back-links, tags, and search. XSS rule: all data via
// textContent / createElement. The article is UNTRUSTED (LLM output) and is shown
// ONLY inside a sandboxed iframe; all navigation stays in this parent frame.

import { getProjects, getWikiTicket } from '../shared/api.js';
import { countsAsLive } from '../shared/dom-util.js';
import { wikiLoopChip, rebuildPollStep, wikiRetentionLine, acceptIfNotStale } from './wiki-loop-model.js';
import { groupSections, firstWikiSlug, shouldFallBackToDefault, emptyStateCopy, wikiMetaLine, effectiveTheme } from './wiki-nav-model.js';

export { groupSections, firstWikiSlug, shouldFallBackToDefault, emptyStateCopy, wikiMetaLine, effectiveTheme };

const SVGNS = 'http://www.w3.org/2000/svg';
// keyed by GET /api/wiki staleReason (wiki-status.js computeWikiStatus)
const WIKI_STALE_WHY = {
  commit: 'Commits have landed since this wiki was built.',
  graph: 'The code graph changed at the same commit since this wiki was built.',
  'commit-unrecorded': 'This wiki carries no build marker, so its freshness cannot be checked against HEAD.',
  'head-unreadable': 'The repo HEAD could not be read, so freshness cannot be checked.',
  'graph-unrecorded': 'This wiki was built before graph fingerprints were recorded; the next build records one.',
  'graph-unreadable': 'The code graph is missing or unreadable, so freshness cannot be checked.',
};

/** the sandboxed article URL; carries a read-only wiki ticket when one was issued.
 *  The article is its own document and cannot see our CSS, so the theme rides along. */
export function wikiFrameSrc(base, slug, bust, ticket, theme = effectiveTheme()) {
  let url = `${base}/${encodeURIComponent(slug)}.html${bust}`;
  if (ticket) url += `${url.includes('?') ? '&' : '?'}wiki_ticket=${encodeURIComponent(ticket)}`;
  if (theme) url += `${url.includes('?') ? '&' : '?'}theme=${encodeURIComponent(theme)}`;
  return url;
}

// The project the operator is working in: the project whose path contains the
// cwd of the most recent live session (deepest match wins), else null so the
// caller lets the server resolve its own repo.
export function pickWikiProject(projects, sessions) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const live = (sessions ?? []).filter((s) => countsAsLive(s) && s.cwd).sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  for (const s of live) {
    const cwd = norm(s.cwd);
    let best = null;
    for (const p of projects ?? []) {
      const root = norm(p.path);
      if (root && (cwd === root || cwd.startsWith(root + '/')) && (!best || root.length > norm(best.path).length)) best = p;
    }
    if (best) return best.path;
  }
  return null;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function icon(pathD, size = 24) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size)); s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', pathD);
  s.appendChild(p);
  return s;
}
const BOOK = 'M12 7v14M3 18V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2m0 0a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-5a2 2 0 0 0-2 2 2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z';

// Single message listener for in-article link clicks (replaced on each paint).
let wikiMsgHandler = null;
// bumped at the start of every load() and by renderWiki's
// returned cleanup(). rebuild()'s poll captures the token active when it
// started and checks it before every fetch and every paint, so a slow poll
// from a project you've since switched away from (or a wiki view you've
// left entirely) cannot paint stale data over whatever is showing now, and
// stops polling instead of running forever in the background.
let wikiLoadToken = 0;
// the page mount that currently owns the shared
// token and message listener. A wiki page overtaken by a newer navigation
// (ctx.isCurrent() false) never loads or paints, and its late cleanup only
// releases the module state if it is still the owner, so it cannot cancel a
// newer wiki page's load or drop its listener.
let wikiMountSeq = 0;
let wikiOwner = 0;
// Re-points the open article when the dashboard theme changes; one at a time.
let themeWatch = null;
function stopThemeWatch() { if (themeWatch) { themeWatch(); themeWatch = null; } }

// app.js hides a view by toggling a `.hidden` class on its
// container (showView()) rather than removing it from the DOM, so a poll
// cannot tell it has been left just by checking whether its elements are
// still connected. This reads that same convention directly (app.js is not
// modified), so the poll below stops on its own even though app.js does not
// yet call the cleanup() renderWiki returns -- the token and this check are
// deliberately redundant, independent guards against the same class of bug.
function viewIsHidden(node) {
  const view = node && node.closest && node.closest('.view');
  return !!(view && view.classList.contains('hidden'));
}

async function fetchWiki(project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  // no-store: the manifest must be fresh so the iframe cache-bust stamp (below)
  // reflects the latest rebuild rather than a heuristically-cached response.
  const res = await fetch(`/api/wiki${q}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  return res.json();
}

// glmps-43: cross-repo wiki. The project picker is a persistent bar OUTSIDE
// `shell` - paint() fully clears+rebuilds `shell` on every load/refresh
// (including the empty-state branch), so the picker would vanish if it lived
// inside it. Keeping it as a sibling means you can switch to a project with
// no wiki yet, see the empty state, and still have the picker to switch away.
export async function renderWiki(container, ctx) {
  const mountId = ++wikiMountSeq;
  const owns = () => ctx?.isCurrent?.() !== false;
  container.textContent = '';
  const root = el('div', 'wiki-root');
  container.appendChild(root);

  const picker = el('div', 'wiki-picker');
  picker.appendChild(el('span', 'wiki-picker-label', 'Project'));
  const select = el('select', 'wiki-project-select');
  select.setAttribute('aria-label', 'Wiki project');
  picker.appendChild(select);
  root.appendChild(picker);

  const shell = el('div', 'wiki-shell');
  root.appendChild(shell);
  shell.appendChild(el('div', 'wiki-loading', 'Loading wiki\u2026'));

  async function load(project, { chosen = true } = {}) {
    if (!owns()) return;
    wikiOwner = mountId;
    // Bump the shared token before doing anything else: this IS the new
    // current generation, so any earlier load() or rebuild() poll still in
    // flight is now stale and must not paint over what this call renders.
    const myToken = ++wikiLoadToken;
    shell.textContent = '';
    shell.appendChild(el('div', 'wiki-loading', 'Loading wiki\u2026'));
    let data;
    try { data = await fetchWiki(project); }
    catch (e) {
      if (myToken !== wikiLoadToken) return;
      shell.textContent = '';
      shell.appendChild(emptyState(null, { title: 'Wiki unavailable', lines: [String(e.message)] }));
      return;
    }
    if (myToken !== wikiLoadToken || !owns()) return;
    if (shouldFallBackToDefault({ chosen, requested: project, data })) return load(null);
    // Keep the picker in sync with whatever root the server actually resolved
    // (e.g. the very first load, where `project` is unset and the server
    // defaults to its own repo) so it never silently drifts from the article.
    if (data.root && [...select.options].some(o => o.value === data.root)) select.value = data.root;
    paint(shell, data);
  }

  // Populate the picker from the known project list (GET /api/projects).
  // Fails soft: if it's unavailable the picker just sits empty and the
  // default project (this server's own repo) still loads normally.
  let known = [];
  try {
    const { projects = [] } = await getProjects();
    known = projects;
    for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
      const opt = el('option', null, p.name);
      opt.value = p.path;
      select.appendChild(opt);
    }
  } catch { /* picker stays empty; default project still loads below */ }

  select.addEventListener('change', () => load(select.value));

  // An explicit ctx.project wins; otherwise the project of the most recent live
  // session; otherwise null and the server resolves its own repo (the runtime).
  // Later picker changes are the user's.
  const requested = ctx?.project || null;
  const picked = requested ? null : pickWikiProject(known, ctx?.sessions);
  await load(requested || picked || null, { chosen: !!requested || !picked });

  // Unmount cleanup, matching the contract history.js/board.js return to
  // app.js: invalidate any load or rebuild poll still in flight and drop the
  // article-nav message listener so a later mount never receives a message
  // meant for this one.
  return function cleanup() {
    if (wikiOwner !== mountId) return;
    wikiOwner = 0;
    wikiLoadToken++;
    stopThemeWatch();
    if (wikiMsgHandler) { window.removeEventListener('message', wikiMsgHandler); wikiMsgHandler = null; }
  };
}

export function updateWiki() {}

function paint(shell, data, opts = {}) {
  shell.textContent = '';
  const sections = data.sections ?? [];
  if (!data.manifest || !sections.length || !data.base) {
    shell.appendChild(emptyState(data));
    return;
  }

  const layout = el('div', 'wiki-layout');
  const side = el('aside', 'wiki-side');
  const main = el('div', 'wiki-main');
  layout.append(side, main);
  shell.appendChild(layout);

  // Sidebar header
  const head = el('header', 'wiki-head');
  const info = el('div', 'wiki-head-info');
  const eyebrow = el('div', 'wiki-eyebrow');
  eyebrow.appendChild(icon(BOOK, 13));
  eyebrow.appendChild(el('span', null, 'Wiki'));
  info.appendChild(eyebrow);
  info.appendChild(el('h2', 'wiki-project', data.project));
  info.appendChild(el('div', 'wiki-sub', wikiMetaLine(data, sections.length)));
  head.appendChild(info);
  const actions = el('div', 'wiki-head-actions');
  if (data.needsUpdate) {
    const pill = el('span', 'wiki-stale', 'stale');
    pill.title = WIKI_STALE_WHY[data.staleReason] ?? WIKI_STALE_WHY.commit;
    actions.appendChild(pill);
  } else if (data.freshness === 'unknown') {
    // Not a severity: a marker needed to check freshness is missing. Says so
    // plainly rather than showing nothing, which is what let a blind wiki
    // read as a fresh one.
    const pill = el('span', 'wiki-unknown', 'unknown');
    pill.title = WIKI_STALE_WHY[data.staleReason] ?? WIKI_STALE_WHY['commit-unrecorded'];
    actions.appendChild(pill);
  }
  if (data.loop !== undefined) {
    const chip = wikiLoopChip(data.loop, Date.now(), { pending: !!opts.pendingBuild });
    const pill = el('span', `wiki-loop wiki-loop-${chip.tone}`, chip.label);
    pill.title = chip.title;
    actions.appendChild(pill);
  }
  const refreshBtn = el('button', 'wiki-rebuild', 'Refresh');
  refreshBtn.type = 'button';
  refreshBtn.title = 'Regenerate narrative for changed sections';
  actions.appendChild(refreshBtn);
  head.appendChild(actions);
  side.appendChild(head);

  // Retention warning: a structured signal from the
  // loop's onRetention dependency, set and cleared server-side.
  // Its own line rather than a pill, since the message is free text (old
  // build names). Only ever created when set: nothing to clear here since
  // paint() rebuilds this whole subtree from scratch every time.
  const retentionMsg = wikiRetentionLine(data.loop);
  if (retentionMsg) side.appendChild(el('div', 'wiki-retention', retentionMsg));

  // Rebuild-error line: hidden until a manual
  // Refresh throws (network error, 409, etc.), so the failure reads as
  // visible text, not only the button's title tooltip.
  const refreshError = el('div', 'wiki-rebuild-error');
  refreshError.hidden = true;
  side.appendChild(refreshError);

  // Search box
  const search = el('input', 'wiki-search');
  search.type = 'search';
  search.placeholder = 'Search wiki\u2026';
  search.setAttribute('aria-label', 'Search wiki');
  side.appendChild(search);

  // Ask-the-wiki box (glmps-44): grounded Q&A over the generated sections.
  const askRow = el('div', 'wiki-ask');
  const askInput = el('input', 'wiki-ask-input');
  askInput.type = 'text';
  askInput.placeholder = 'Ask the wiki\u2026';
  askInput.setAttribute('aria-label', 'Ask the wiki a question');
  askInput.maxLength = 2000;
  const askBtn = el('button', 'wiki-ask-btn', 'Ask');
  askBtn.type = 'button';
  askRow.append(askInput, askBtn);
  side.appendChild(askRow);

  const list = el('ul', 'wiki-list');
  side.appendChild(list);

  // Main pane: ask-answer panel + connections bar + article iframe
  const answerPanel = el('div', 'wiki-answer');
  answerPanel.hidden = true;
  main.appendChild(answerPanel);
  const conn = el('div', 'wiki-conn');
  main.appendChild(conn);
  const frame = el('iframe', 'wiki-frame');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', 'Wiki article');
  main.appendChild(frame);

  const base = data.base;
  // Cache-bust the sandboxed iframe: wiki pages are served with no cache
  // headers, so a browser will heuristically re-serve a stale <slug>.html after
  // a rebuild. Versioning the URL by the manifest build stamp forces a fresh
  // fetch whenever the wiki was regenerated (even if a slug's contentHash is
  // unchanged but its rendered HTML changed, e.g. a render-pipeline fix).
  const buildStamp = (data.manifest && (data.manifest.generatedAt || data.manifest.builtAtCommit)) || '';
  const bust = buildStamp ? `?v=${encodeURIComponent(buildStamp)}` : '';
  let activeSlug = null;
  const itemsBySlug = new Map();

  async function select(slug) {
    const s = sections.find(x => x.slug === slug);
    if (!s) return;
    activeSlug = slug;
    for (const [sl, li] of itemsBySlug) {
      li.classList.toggle('active', sl === slug);
      if (sl === slug) li.setAttribute('aria-current', 'page'); else li.removeAttribute('aria-current');
    }
    renderConnections(conn, s, select);
    // the article is untrusted and can read its own URL, so it gets a
    // read-only wiki ticket, never the stored token.
    const ticket = await getWikiTicket(base);
    if (activeSlug !== slug) return;  // a newer selection won the race
    frame.setAttribute('src', wikiFrameSrc(base, slug, bust, ticket));
  }

  // The article cannot see our theme; reload it with the new one when it changes.
  stopThemeWatch();
  {
    let shown = effectiveTheme();
    const check = () => {
      const now = effectiveTheme();
      if (now === shown) return;
      shown = now;
      if (activeSlug) select(activeSlug);
    };
    const mo = typeof MutationObserver === 'function' && document.documentElement && document.documentElement.nodeType
      ? new MutationObserver(check) : null;
    if (mo) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = globalThis.matchMedia ? globalThis.matchMedia('(prefers-color-scheme: light)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', check);
    themeWatch = () => { if (mo) mo.disconnect(); if (mq && mq.removeEventListener) mq.removeEventListener('change', check); };
  }

  // Relay in-article link clicks (postMessage from the sandboxed iframe) to a
  // section switch. Resolves either a slug (Related pages) or a title ([[wikilink]]).
  if (wikiMsgHandler) window.removeEventListener('message', wikiMsgHandler);
  wikiMsgHandler = (ev) => {
    if (ev.source !== frame.contentWindow) return;
    const d = ev.data;
    if (!d || d.type !== 'wiki-nav') return;
    let slug = d.slug;
    if (!slug && d.title) {
      const t = String(d.title).toLowerCase();
      const hit = sections.find(x => String(x.title || '').toLowerCase() === t)
        || sections.find(x => x.slug === t);
      slug = hit && hit.slug;
    }
    if (slug && sections.some(x => x.slug === slug)) select(slug);
  };
  window.addEventListener('message', wikiMsgHandler);

  function itemEl(s) {
    const li = el('li', 'wiki-item');
    li.tabIndex = 0;
    const mainCol = el('div', 'wiki-item-main');
    mainCol.appendChild(el('span', 'wiki-item-title', s.title || s.slug));
    if (s.summary) mainCol.appendChild(el('span', 'wiki-item-summary', s.summary));
    else if (typeof s.updatedTs === 'number') {
      // An old build carries no summary; the update age keeps the row scannable.
      const when = el('span', 'wiki-item-summary', `updated ${relTime(s.updatedTs)}`);
      when.title = typeof s.createdTs === 'number'
        ? `Created ${fmtDateAbs(s.createdTs)} \u00B7 Updated ${fmtDateAbs(s.updatedTs)}`
        : `Updated ${fmtDateAbs(s.updatedTs)}`;
      mainCol.appendChild(when);
    }
    li.appendChild(mainCol);
    const tags = el('span', 'wiki-item-tags');
    // File counts size a code subsystem; for guides and concepts they are noise.
    if (!s.group || s.group === 'code') tags.appendChild(el('span', 'wiki-item-count', String(s.fileCount ?? 0)));
    if (!s.group && s.llm) tags.appendChild(el('span', 'wiki-item-ai', 'AI'));
    if (s.stale) { const d = el('span', 'wiki-item-stale'); d.title = 'Changed since last build'; tags.appendChild(d); }
    if (tags.childNodes.length) li.appendChild(tags);
    li.addEventListener('click', () => select(s.slug));
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(s.slug); }
    });
    itemsBySlug.set(s.slug, li);
    if (s.slug === activeSlug) { li.classList.add('active'); li.setAttribute('aria-current', 'page'); }
    return li;
  }

  const grouped = groupSections(sections);

  function buildList() {
    list.textContent = '';
    itemsBySlug.clear();
    const q = search.value.trim().toLowerCase();
    const matches = (s) => !q || String(s.searchText ?? s.title ?? '').toLowerCase().includes(q);
    let shown = 0;
    if (!grouped) {
      for (const s of sections) {
        if (!matches(s)) continue;
        list.appendChild(itemEl(s));
        shown++;
      }
    } else {
      for (const g of grouped) {
        const parts = g.parts.map((part) => ({ label: part.label, items: part.items.filter(matches) })).filter((part) => part.items.length);
        if (!parts.length) continue;
        const sec = el('li', 'wiki-group');
        sec.appendChild(el('h3', 'wiki-group-title', g.label));
        for (const part of parts) {
          if (part.label) sec.appendChild(el('h4', 'wiki-subgroup-title', part.label));
          const ul = el('ul', 'wiki-group-items');
          for (const s of part.items) { ul.appendChild(itemEl(s)); shown++; }
          sec.appendChild(ul);
        }
        list.appendChild(sec);
      }
    }
    if (!shown) list.appendChild(el('li', 'wiki-empty-hint', 'No pages match.'));
  }

  // Ask-the-wiki wiring (glmps-44). All answer/citation data is untrusted
  // (LLM output + manifest titles): textContent only, never innerHTML.
  function paintAnswer(state) {
    answerPanel.textContent = '';
    answerPanel.hidden = false;
    const head = el('div', 'wiki-answer-head');
    head.appendChild(el('span', 'wiki-answer-lab', 'Answer'));
    const close = el('button', 'wiki-answer-close', '\u00D7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss answer');
    close.addEventListener('click', () => { answerPanel.hidden = true; answerPanel.textContent = ''; });
    head.appendChild(close);
    answerPanel.appendChild(head);
    if (state.loading) {
      answerPanel.appendChild(el('div', 'wiki-answer-loading', 'Asking the wiki\u2026'));
      return;
    }
    if (state.error) {
      answerPanel.appendChild(el('div', 'wiki-answer-error', state.error));
      return;
    }
    answerPanel.appendChild(el('div', 'wiki-answer-text', state.answer));
    if (Array.isArray(state.citations) && state.citations.length) {
      const cites = el('div', 'wiki-answer-cites');
      cites.appendChild(el('span', 'wiki-conn-lab', 'Sources'));
      for (const c of state.citations) {
        const chip = el('button', 'wiki-conn-link', c.title || c.slug);
        chip.type = 'button';
        chip.addEventListener('click', () => select(c.slug));
        cites.appendChild(chip);
      }
      answerPanel.appendChild(cites);
    }
  }

  async function ask() {
    const question = askInput.value.trim();
    if (!question || askBtn.disabled) return;
    askBtn.disabled = true;
    askBtn.textContent = 'Asking\u2026';
    paintAnswer({ loading: true });
    try {
      const res = await fetch('/api/wiki/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, project: data.root }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `ask failed (${res.status})`);
      paintAnswer({ answer: body.answer, citations: body.citations });
    } catch (e) {
      paintAnswer({ error: String(e.message || e) });
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = 'Ask';
    }
  }
  askBtn.addEventListener('click', ask);
  askInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ask(); } });

  search.addEventListener('input', buildList);
  refreshBtn.addEventListener('click', () => rebuild(shell, data, refreshBtn, refreshError));

  buildList();
  select(firstWikiSlug(sections));
}

function renderConnections(container, s, onSelect) {
  container.textContent = '';
  const group = (label, items) => {
    if (!Array.isArray(items) || !items.length) return;
    const grp = el('div', 'wiki-conn-grp');
    grp.appendChild(el('span', 'wiki-conn-lab', label));
    for (const it of items) {
      const link = el('button', 'wiki-conn-link', it.title || it.slug);
      link.type = 'button';
      link.addEventListener('click', () => onSelect(it.slug));
      grp.appendChild(link);
    }
    container.appendChild(grp);
  };
  // The page renders its own Related nav; only back-links are worth a bar, and
  // an empty bar takes no space (.wiki-conn:empty).
  group('Referenced by', s.backlinks);
}

// `errEl` is the hidden-by-default line created alongside `btn` (paint()'s
// refreshError or emptyState()'s own slot); shown with the error text on
// failure, cleared at the start of every attempt.
async function rebuild(shell, data, btn, errEl) {
  // the token active right now, for the whole poll below
  // to check itself against. A project switch or leaving the wiki view bumps
  // wikiLoadToken, which makes every check here fail and stops this poll
  // from fetching again or painting over whatever is showing now.
  const myToken = wikiLoadToken;
  // True once this poll is no longer the one anyone should see: a newer
  // load()/rebuild() started (token bumped), or app.js switched the view
  // away (the .hidden check -- see viewIsHidden above).
  const stale = () => myToken !== wikiLoadToken || viewIsHidden(shell);
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Queued\u2026';
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  try {
    const res = await fetch('/api/wiki/rebuild', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: data.root, llm: true }),
    });
    if (stale()) return;
    if (res.status === 200) {
      // the earlier stale() check above only covers the
      // window up to the POST resolving; res.json() itself awaits again, and
      // a project switch landing during that parse must still be caught
      // before painting, not just before starting to parse.
      const fresh = await acceptIfNotStale(res.json(), stale);
      if (fresh) paint(shell, fresh);
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (res.status !== 202) throw new Error(body.error || `rebuild ${res.status}`);
    btn.textContent = 'Building\u2026';
    const startedTs = Date.now();
    for (;;) {
      if (stale()) return;
      await new Promise(r => setTimeout(r, 10000));
      if (stale()) return;
      const after = await fetchWiki(data.root);
      if (stale()) return;
      const step = rebuildPollStep({ before: data, after, startedTs, now: Date.now() });
      if (step === 'waiting') continue;
      // A timeout is a client-side "gave up waiting", not a server outcome:
      // the build may well still be running. Say so instead of quietly
      // repainting as if nothing had been asked for.
      if (step === 'timeout') { paint(shell, after, { pendingBuild: true }); return; }
      paint(shell, after);
      if (step === 'unchanged') {
        const refresh = shell.querySelector('.wiki-rebuild');
        if (refresh) { refresh.textContent = 'Up to date'; refresh.title = 'The published wiki already reflects HEAD.'; }
      }
      return;
    }
  } catch (e) {
    if (stale()) return;
    btn.disabled = false;
    btn.textContent = originalLabel;
    const msg = String(e.message || e);
    btn.title = msg;
    if (errEl) { errEl.hidden = false; errEl.textContent = msg; }
  }
}

// `data` is the GET /api/wiki response for a project with no build; `fallback`
// ({ title, lines }) is for a fetch failure, which has no response to explain.
function emptyState(data, fallback) {
  const wrap = el('div', 'wiki-empty');
  const ic = icon(BOOK, 46); ic.classList.add('wiki-empty-icon');
  wrap.appendChild(ic);
  const copy = fallback || emptyStateCopy(data);
  wrap.appendChild(el('div', 'wiki-empty-msg', copy.title));
  for (const line of copy.lines) wrap.appendChild(el('div', 'wiki-empty-hint', line));
  if (!fallback) {
    const gen = el('button', 'wiki-empty-btn', 'Generate wiki');
    gen.type = 'button';
    const genError = el('div', 'wiki-rebuild-error');
    genError.hidden = true;
    gen.addEventListener('click', () => rebuild(wrap.closest('.wiki-shell'), data, gen, genError));
    wrap.appendChild(gen);
    wrap.appendChild(genError);
  }
  return wrap;
}
