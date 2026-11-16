// web/observability/detail.js
import { getState, getApprovals, learningAction, steerSession, resume, updateBacklogItem } from '../shared/api.js';
import { toolAccentHex, makeToolIcon } from '../shared/grid.js';
import { linkFor } from '../shared/deep-link.js';
import { renderAnsi } from '../shared/ansi.js';
import { extractSessionContent, toMarkdown, toJson, triggerDownload } from '../shared/export.js';
import { interactive } from '../shared/a11y.js';
import { setText, clear } from '../shared/dom-util.js';
import { getDiffPopup, positionDiffPopup, fillDiffPopup, closeDiffPopup } from '../shared/diff-popup.js';
import { buildDoneGateSlot, buildStageTrace } from './session-verdicts.js';
import {
  sessionState, sessionTitle, stateSentence, bandOrder, BAND_IDS, primaryAction, filterEvents, KIND_CHIPS, backLabel, fmtSpan, tsMs,
} from './session-model.js';
import { buildBand, setBandOpen, buildTouching, buildLearning, buildVerdictStrip, buildCostStrip, readPref, writePref } from './session-bands.js';
import { formatClock } from '../shared/time-format.js';

function kindChip(kind) {
  const span = document.createElement('span');
  span.className = `chip chip-${kind}`;
  setText(span, kind);
  return span;
}

// Detect tier keyword from a model string (id or displayName)
function tierClass(m) {
  if (!m || typeof m !== 'string') return null;
  const lower = m.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return null;
}

// Return a human-readable tier label from various model string forms
function modelTier(m) {
  if (!m || typeof m !== 'string') return null;
  const lower = m.toLowerCase();
  // Short tier shortcuts
  if (lower === 'opus') return 'Opus';
  if (lower === 'sonnet') return 'Sonnet';
  if (lower === 'haiku') return 'Haiku';
  // displayName like 'Opus 4.8 (1M context)' - strip parenthetical
  if (/^(opus|sonnet|haiku)\s/i.test(m)) {
    return m.replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  // id like 'claude-opus-4-8[1m]' - detect tier and return capitalized tier
  const t = tierClass(m);
  if (t) return t.charAt(0).toUpperCase() + t.slice(1);
  return null;
}

// Module-level parent model context (set at renderDetail time)
let _parentModel = null;
let _parentModelRaw = null;

function fmtTime(ts) {
  if (ts == null) return '??:??:??';
  let d;
  if (typeof ts === 'string') {
    d = new Date(ts);
  } else {
    // epoch ms or epoch s - heuristic: values < 1e12 are likely seconds
    d = new Date(ts < 1e12 ? ts * 1000 : ts);
  }
  if (isNaN(d.getTime())) return '??:??:??';
  return formatClock(d);
}

// getDiffPopup/positionDiffPopup/fillDiffPopup/closeDiffPopup now live in
// web/shared/diff-popup.js so any file, on any page, opens the same popup
// (D17). hideDiffPopup keeps this module's own "diff v/>" toggle in sync.
let _activeToggle = null;

function hideDiffPopup() {
  closeDiffPopup();
  if (_activeToggle) {
    setText(_activeToggle, 'diff \u25B8');
    _activeToggle = null;
  }
}

// One toggle owns the shared popup at a time: the feed's rows and the
// Touching band's file rows open the same diff.
function toggleDiff(toggle, change, label, path, handlers) {
  if (_activeToggle === toggle) { hideDiffPopup(); return; }
  hideDiffPopup();
  const popup = getDiffPopup();
  fillDiffPopup(popup, change, label, { ...handlers, onOpenFile: (p, c) => { handlers.onOpenFile(p, c); hideDiffPopup(); } }, path);
  positionDiffPopup(popup, toggle);
  _activeToggle = toggle;
  setText(toggle, 'diff \u25BE');
}

function makeEventRow(ev, handlers, dimmed) {
  const row = document.createElement('div');
  const isGit = ev.kind === 'git';
  row.className = 'event-row' + (dimmed ? ' event-row-dim' : '') + (isGit ? ' evt-git' : '');

  const timeEl = document.createElement('span');
  timeEl.className = 'event-time';
  setText(timeEl, fmtTime(ev.ts));
  row.appendChild(timeEl);

  // Column 2: a meta wrapper holding the op marker (if any) + chip/icon,
  // so the row keeps a fixed child count regardless of read/write/git.
  const meta = document.createElement('span');
  meta.className = 'event-meta';
  if (isGit) {
    const img = document.createElement('img');
    img.src = '/icons/git-commit.svg';
    img.className = 'evt-icon';
    img.alt = 'git';
    img.addEventListener('error', () => { img.style.display = 'none'; });
    meta.appendChild(img);
  } else {
    const hasOp = ev.op === 'read' || ev.op === 'write';
    if (hasOp && !dimmed) {
      // Task 1: text "rd"/"wr" tokens instead of arrows
      const opEl = document.createElement('span');
      opEl.className = ev.op === 'read' ? 'op-read' : 'op-write';
      opEl.title = ev.op === 'read' ? 'read' : 'write';
      setText(opEl, ev.op === 'read' ? 'rd' : 'wr');
      meta.appendChild(opEl);
    }
    if (ev.kind === 'agent') {
      // Show model tier chip instead of generic 'agent' chip
      const modelChip = document.createElement('span');
      const rawM = ev.model ?? _parentModelRaw;
      const tier = tierClass(rawM);
      const chipText = modelTier(ev.model) ?? _parentModel ?? 'agent';
      modelChip.className = 'chip chip-model' + (tier ? ` model-${tier}` : '');
      setText(modelChip, chipText);
      meta.appendChild(modelChip);
    } else {
      meta.appendChild(kindChip(ev.kind ?? 'tool'));
    }
  }
  row.appendChild(meta);

  const labelEl = document.createElement('span');
  labelEl.className = 'event-label';
  const labelText = ev.label ?? ev.path ?? ev.tool ?? ev.kind ?? '';
  setText(labelEl, labelText);
  if (ev.path) {
    labelEl.classList.add('clickable');
    labelEl.title = ev.path;
    interactive(labelEl, () => handlers.onOpenFile(ev.path), `Open file: ${ev.path}`);
  }
  row.appendChild(labelEl);

  // Column 4: +/- edit counts (file edits / writes) and/or a diff popup toggle.
  const tail = document.createElement('span');
  tail.className = 'event-tail';

  if (ev.add != null || ev.del != null) {
    const ed = document.createElement('span');
    ed.className = 'event-edits';
    const a = document.createElement('span');
    a.className = 'ev-add';
    setText(a, `+${ev.add ?? 0}`);
    const d = document.createElement('span');
    d.className = 'ev-del';
    setText(d, `\u2212${ev.del ?? 0}`);
    ed.appendChild(a);
    ed.appendChild(d);
    tail.appendChild(ed);
  }

  if (ev.op === 'write' && ev.change) {
    row.classList.add('has-diff');
    const toggle = document.createElement('button');
    toggle.className = 'diff-toggle';
    setText(toggle, 'diff \u25B8');

    // Derive a basename for the popup header from the event's label/path (textContent-safe)
    const rawLabel = ev.label ?? ev.path ?? '';
    const labelBasename = rawLabel.replace(/\\/g, '/').split('/').pop() || rawLabel;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDiff(toggle, ev.change, labelBasename, ev.path ?? null, handlers);
    });

    tail.appendChild(toggle);
  }

  row.appendChild(tail);
  return row;
}

export function buildGapCallout(gaps) {
  const box = document.createElement('div');
  box.className = 'gap-callout';

  const head = document.createElement('div');
  head.className = 'gap-head';
  const icon = document.createElement('span');
  icon.className = 'gap-icon';
  setText(icon, '\u26A0'); // warning
  head.appendChild(icon);
  const title = document.createElement('span');
  setText(title, gaps.length === 1 ? 'Capability gap' : `Capability gaps (${gaps.length})`);
  head.appendChild(title);
  box.appendChild(head);

  for (const g of gaps) {
    const line = document.createElement('div');
    line.className = 'gap-line gap-' + (g.severity === 'warn' ? 'warn' : 'info');

    const msg = document.createElement('span');
    msg.className = 'gap-msg';
    setText(msg, g.message ?? '');
    line.appendChild(msg);

    // Actionable when the server attached a learning-queue item id.
    if (g.id) {
      const actions = document.createElement('span');
      actions.className = 'gap-actions';
      // a failed action used to only
      // re-enable the buttons, with no sign anything had gone wrong -
      // mirrors capability-row.js's wireAction, which always shows an inline
      // "Failed, try again." next to a re-enabled button group. Created once
      // outside renderState() (which clears/rebuilds `actions` on every
      // call) so it survives across attempts instead of being wiped.
      const statusEl = document.createElement('span');
      statusEl.className = 'gap-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      const renderState = (status) => {
        actions.textContent = '';
        statusEl.classList.remove('gap-status--error');
        setText(statusEl, '');
        if (status === 'pending') {
          // Guard proposer cutover: a gap item's own
          // proposedGuard is null until an operator sets one or a GEPA
          // proposal is separately approved - approving one with no rule
          // now 400s server-side. This compact inline callout has no room
          // for a "set an alternative rule" input (unlike the full
          // Capability Registry panel), so Approve is left off entirely
          // rather than shown disabled with no way to fix it; Promote stays
          // available (it falls back to a rule built from the gap's own
          // title/body server-side, so it still works with no proposedGuard).
          const hasRule = !!g.proposedGuard?.rule;
          const approve = hasRule ? document.createElement('button') : null;
          if (approve) {
            approve.className = 'gap-act gap-act-approve';
            setText(approve, 'Approve');
          }
          const discard = document.createElement('button');
          discard.className = 'gap-act gap-act-discard';
          setText(discard, 'Discard');
          // Promote -> global: lift a capability guard into global CLAUDE.md so every
          // agent sees it (the deterministic default; memory promotion lives on the
          // full Learning card). Disables siblings while in flight.
          const promote = document.createElement('button');
          promote.className = 'gap-act gap-act-promote';
          setText(promote, 'Promote');
          const setDisabled = (v) => { if (approve) approve.disabled = v; discard.disabled = v; promote.disabled = v; };
          const showFailed = () => {
            statusEl.classList.add('gap-status--error');
            setText(statusEl, 'Failed, try again.');
          };
          const run = async (act, target) => {
            setDisabled(true);
            statusEl.classList.remove('gap-status--error');
            setText(statusEl, '');
            try {
              const item = await learningAction(g.id, act, target);
              // Guard proposer cutover: render only
              // the server's own reported status. Guessing 'applied' when
              // it is missing would show success for a request that may
              // not have landed anything; re-enabling the buttons on a
              // missing status is the same honest "something is wrong,
              // let the operator retry or check" outcome as a thrown error -
              // both now say so inline, not just
              // re-enable silently.
              if (item && item.status) renderState(item.status);
              else { setDisabled(false); showFailed(); }
            } catch {
              setDisabled(false);
              showFailed();
            }
          };
          if (approve) approve.addEventListener('click', () => run('approve'));
          discard.addEventListener('click', () => run('discard'));
          promote.addEventListener('click', () => run('promote', 'global'));
          if (approve) actions.appendChild(approve);
          actions.appendChild(discard);
          actions.appendChild(promote);
        } else {
          const tag = document.createElement('span');
          tag.className = 'gap-state gap-state-' + status;
          setText(tag, status);
          actions.appendChild(tag);
        }
      };
      renderState(g.status || 'pending');
      line.appendChild(actions);
      line.appendChild(statusEl);
    }

    box.appendChild(line);
  }
  return box;
}

function buildGuidingBar(guidingFiles, events, handlers, skillsUsed) {
  const bar = document.createElement('div');
  bar.className = 'banner-guiding';

  // Skills: prefer the persisted full list (skillsUsed), union with any in the
  // current event window (the window can age out early skill invocations).
  const seenSkills = new Set();
  const skills = [];
  for (const key of (skillsUsed ?? [])) {
    if (key && !seenSkills.has(key)) { seenSkills.add(key); skills.push(key); }
  }
  for (const e of (events ?? [])) {
    if (e.kind !== 'skill') continue;
    const key = e.label ?? e.path ?? '';
    if (key && !seenSkills.has(key)) { seenSkills.add(key); skills.push(key); }
  }

  const hasFiles = guidingFiles && guidingFiles.length > 0;
  const hasSkills = skills.length > 0;

  if (!hasFiles && !hasSkills) {
    const none = document.createElement('div');
    none.className = 'guiding-none';
    setText(none, 'No guiding context detected');
    bar.appendChild(none);
    return bar;
  }

  // Context files row
  if (hasFiles) {
    const filesRow = document.createElement('div');
    filesRow.className = 'guiding-files';

    for (const gf of guidingFiles) {
      const pill = document.createElement('span');
      pill.className = 'chip guiding-chip';
      pill.title = gf.path ?? '';

      // Scope tag
      const scopeTag = document.createElement('span');
      let scopeClass, scopeLabel;
      if (gf.scope === 'global') {
        scopeClass = 'scope-global'; scopeLabel = 'global';
      } else if (gf.scope === 'memory') {
        scopeClass = 'scope-memory'; scopeLabel = 'memory';
      } else if (gf.scope === 'acceptance') {
        scopeClass = 'scope-acceptance'; scopeLabel = 'done';
      } else {
        scopeClass = 'scope-project'; scopeLabel = 'project';
      }
      scopeTag.className = `scope-tag ${scopeClass}`;
      setText(scopeTag, scopeLabel);
      pill.appendChild(scopeTag);

      // Basename label - clickable
      const nameSpan = document.createElement('span');
      nameSpan.className = 'guiding-file-name clickable';
      const basename = (gf.path ?? gf.name ?? '').replace(/\\/g, '/').split('/').pop() || gf.name;
      setText(nameSpan, basename);
      if (gf.path && handlers?.onOpenFile) {
        interactive(nameSpan, () => handlers.onOpenFile(gf.path), `Open file: ${basename}`);
      }
      pill.appendChild(nameSpan);

      // Edit pencil button
      if (gf.path && handlers?.onOpenFile) {
        const editBtn = document.createElement('button');
        editBtn.className = 'guiding-edit';
        editBtn.title = gf.path;
        setText(editBtn, '\u270E');
        editBtn.addEventListener('click', () => handlers.onOpenFile(gf.path));
        pill.appendChild(editBtn);
      }

      filesRow.appendChild(pill);
    }

    bar.appendChild(filesRow);
  }

  // Skills row
  const skillsRow = document.createElement('div');
  skillsRow.className = 'guiding-skills';

  if (hasSkills) {
    for (const skillLabel of skills) {
      const chip = document.createElement('span');
      chip.className = 'chip chip-skill guiding-skill-chip';
      setText(chip, skillLabel);
      skillsRow.appendChild(chip);
    }
  } else {
    const none = document.createElement('span');
    none.className = 'guiding-none-skills';
    setText(none, 'no skills invoked yet');
    skillsRow.appendChild(none);
  }

  bar.appendChild(skillsRow);

  return bar;
}

function projectName(session) {
  // Prefer the stamped parent project over a worktree cwd's own last segment
  // (e.g. "session-abc123"), same reasoning as web/shared/grid.js (glmps-71).
  const wtParent = session?.worktree && typeof session.worktree.parent === 'string' ? session.worktree.parent : '';
  if (wtParent) return wtParent;
  if (session?.cwd) {
    const seg = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (seg) return seg;
  }
  if (session?.title) return session.title;
  return '';
}

// Small neutral pill showing the isolated worktree's branch name, mirrors
// web/shared/grid.js's session-card badge (see there for how session.worktree
// is expected to be derived server-side). Absence of session.worktree renders
// nothing (defensive - most sessions aren't worktree-isolated).
function makeWorktreeBadge(session) {
  const branch = session?.worktree?.branch;
  if (typeof branch !== 'string' || !branch) return null;
  const badge = document.createElement('span');
  badge.className = 'worktree-badge';
  setText(badge, branch);
  badge.title = session.worktree.parent
    ? `Isolated worktree (branch: ${branch}, parent project: ${session.worktree.parent})`
    : `Isolated worktree (branch: ${branch})`;
  return badge;
}

// One shared popup, mirrors the .resume-menu pattern. All labels via textContent.
let _exportMenu = null;

function closeExportMenu() {
  if (_exportMenu) { _exportMenu.remove(); _exportMenu = null; }
}

function openExportMenu(anchorBtn, sessionId, summary, data) {
  // Toggle off if already open
  if (_exportMenu) { closeExportMenu(); return; }

  const titleText = summary
    ? (projectName(summary) || summary.title || sessionId.slice(0, 8))
    : sessionId.slice(0, 8);
  const meta = {
    title: titleText,
    sessionId,
    tool: summary?.tool ?? null,
    model: summary?.status?.model?.displayName ?? null,
    exportedAt: new Date().toISOString(),
  };
  const base = sessionId.slice(0, 8);

  const menu = document.createElement('div');
  menu.className = 'resume-menu export-menu';

  const items = [
    { label: 'Markdown', run: (parts) => triggerDownload(`${base}.md`, toMarkdown(meta, parts), 'text/markdown') },
    { label: 'JSON',     run: (parts) => triggerDownload(`${base}.json`, toJson(meta, parts), 'application/json') },
  ];
  for (const it of items) {
    const row = document.createElement('button');
    row.className = 'resume-menu-row';
    setText(row, it.label);
    // The page holds one 50-event page of the feed; an export takes the whole log.
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeExportMenu();
      let events = data?.events ?? [];
      try { events = (await getState(sessionId))?.events ?? events; } catch { /* export what the page holds */ }
      it.run(extractSessionContent(events));
    });
    menu.appendChild(row);
  }

  // Anchor the menu to the button's positioned wrapper.
  anchorBtn.parentElement.appendChild(menu);
  _exportMenu = menu;

  // Outside-click closes (deferred so this click doesn't immediately dismiss).
  setTimeout(() => {
    const onAway = (e) => {
      if (_exportMenu && !_exportMenu.contains(e.target) && e.target !== anchorBtn) {
        closeExportMenu();
        document.removeEventListener('click', onAway, true);
      }
    };
    document.addEventListener('click', onAway, true);
  }, 0);
}

const FEED_PAGE = 50;
const HEADER_REFRESH_MS = 10000;
const ROW_SELECTOR = '.sp-row, .event-row';

function guidingSummary(guiding, skillsUsed) {
  const f = guiding?.length ?? 0;
  const s = skillsUsed?.length ?? 0;
  return `Guiding context: ${f} file${f === 1 ? '' : 's'}, ${s} skill${s === 1 ? '' : 's'}`;
}

// Arrow keys walk the rows of one band; Enter on a row opens its diff or
// file, the same as a click (operational expert tool keyboard rule).
function wireRowKeys(body) {
  body.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const rows = [...body.querySelectorAll(ROW_SELECTOR)];
    if (!rows.length) return;
    const at = rows.findIndex((r) => r === e.target || r.contains?.(e.target));
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    e.preventDefault();
    next.tabIndex = -1;
    next.focus();
  });
}

function actionStatus() {
  const s = document.createElement('span');
  s.className = 'sp-action-status';
  s.setAttribute('role', 'status');
  s.setAttribute('aria-live', 'polite');
  return s;
}

function buildActions(state, data, summary, sessionId, embedded, handlers) {
  const wrap = document.createElement('div');
  wrap.className = 'sp-actions';
  const status = actionStatus();
  const act = primaryAction(state, data);
  const card = data?.card ?? null;
  const say = (t, bad) => { setText(status, t); status.classList.toggle('is-error', !!bad); };
  if (act?.id === 'pr' || act?.id === 'card') {
    const a = document.createElement('a');
    a.className = 'sp-primary';
    setText(a, act.label);
    if (act.id === 'pr') { a.href = act.url; a.target = '_blank'; a.rel = 'noopener'; }
    else a.href = linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id: card.id } });
    wrap.appendChild(a);
  } else if (act) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-primary';
    setText(b, act.label);
    wrap.appendChild(b);
    if (act.id === 'steer') {
      const form = document.createElement('form');
      form.className = 'sp-steer';
      form.hidden = true;
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'sp-steer-input';
      input.setAttribute('aria-label', 'Steer note for the running session');
      input.placeholder = 'Note to inject into the running agent';
      const send = document.createElement('button');
      send.type = 'submit';
      setText(send, 'Send');
      form.appendChild(input);
      form.appendChild(send);
      b.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) input.focus(); });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const note = input.value.trim();
        if (!note) return;
        send.disabled = true;
        try { await steerSession(sessionId, note); input.value = ''; form.hidden = true; say('Steer note queued for the next tool call.'); }
        catch (err) { say(`Steer failed: ${err.message}`, true); }
        finally { send.disabled = false; }
      });
      wrap.appendChild(form);
    } else if (act.id === 'resume') {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { await resume(sessionId, summary?.cwd ?? null); say('Resume opened in a terminal.'); }
        catch (err) { say(`Resume failed: ${err.message}`, true); }
        finally { b.disabled = false; }
      });
    } else if (act.id === 'requeue') {
      b.addEventListener('click', async () => {
        if (typeof confirm === 'function' && !confirm(`Requeue ${card.id}? The runner will launch it again.`)) return;
        b.disabled = true;
        try { await updateBacklogItem(card.id, { labels: ['agent:backlog'] }); say(`${card.id} requeued.`); }
        catch (err) { say(`Requeue failed: ${err.message}`, true); b.disabled = false; }
      });
    }
  }
  if (!embedded) {
    const exportWrap = document.createElement('span');
    exportWrap.className = 'detail-export-wrap';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'detail-export';
    setText(exportBtn, 'Export');
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); openExportMenu(exportBtn, sessionId, summary, data); });
    exportWrap.appendChild(exportBtn);
    wrap.appendChild(exportWrap);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'detail-copy-link';
    setText(copy, 'Copy link');
    copy.addEventListener('click', async () => {
      const url = `${location.origin}${linkFor({ lens: 'session', sessionId })}`;
      try { await navigator.clipboard.writeText(url); say('Link copied.'); } catch { say(url); }
    });
    wrap.appendChild(copy);
  }
  wrap.appendChild(status);
  return wrap;
}

function identityLine(state, summary, data) {
  const line = document.createElement('div');
  line.className = 'sp-identity';
  const word = document.createElement('span');
  word.className = `sp-state verdict-word tone-${state.tone}`;
  setText(word, state.word);
  line.appendChild(word);
  const span = data?.touch?.span;
  const wall = span?.firstTs != null && span?.lastTs != null ? fmtSpan(tsMs(span.lastTs) - tsMs(span.firstTs)) : null;
  const parts = [wall, summary?.tool, summary?.status?.model?.displayName].filter(Boolean);
  for (const p of parts) {
    const s = document.createElement('span');
    s.className = 'sp-identity-part';
    setText(s, p);
    line.appendChild(s);
  }
  const wt = makeWorktreeBadge(summary);
  if (wt) line.appendChild(wt);
  const last = document.createElement('span');
  last.className = 'sp-last-event';
  line.appendChild(last);
  return { line, last };
}

function setLastEvent(node, ts) {
  const ms = tsMs(ts);
  setText(node, ms ? `last event ${fmtTime(ms)}` : 'no events received');
}

export async function renderDetail(sessionId, container, handlers, summary, opts) {
  const embedded = (opts && typeof opts === 'object') ? !!opts.embedded : false;

  const _rawModelStr = summary?.status?.model?.displayName ?? summary?.status?.model?.id ?? null;
  _parentModelRaw = _rawModelStr;
  _parentModel = modelTier(_rawModelStr);

  clear(container);
  hideDiffPopup();

  const header = document.createElement('header');
  header.className = 'session-header';
  if (summary?.tool) header.style.borderLeftColor = toolAccentHex(summary.tool);
  const top = document.createElement('div');
  top.className = 'sp-top';
  if (!embedded) {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'detail-back';
    setText(backBtn, backLabel(handlers.backLabel ?? null));
    backBtn.addEventListener('click', () => handlers.onBack());
    top.appendChild(backBtn);
  }
  if (summary?.tool) {
    const icon = makeToolIcon(summary.tool);
    icon.className = 'tool-icon detail-tool-icon';
    icon.title = summary.tool;
    top.appendChild(icon);
  }
  const titleId = document.createElement('a');
  titleId.className = 'sp-card-id';
  const titleEl = document.createElement('h1');
  titleEl.className = 'detail-title';
  setText(titleEl, sessionTitle(summary, null, sessionId).text);
  top.appendChild(titleEl);
  header.appendChild(top);
  const skeleton = document.createElement('p');
  skeleton.className = 'sp-sentence is-loading';
  setText(skeleton, 'Loading session...');
  header.appendChild(skeleton);
  container.appendChild(header);

  let data;
  let approvals = null;
  try {
    data = await getState(sessionId, { limit: FEED_PAGE });
    if (!data || typeof data !== 'object') throw new Error('empty response');
    // Approvals are filed per card, so only a card session asks for them.
    if (data.card?.id) approvals = await getApprovals().catch(() => null);
  } catch (err) {
    skeleton.classList.remove('is-loading');
    skeleton.classList.add('band-error');
    setText(skeleton, `Session data unavailable: ${err?.message ?? err}. Reload to retry.`);
    return () => {};
  }
  data.events = Array.isArray(data.events) ? data.events : [];

  const state = sessionState(summary, data);
  header.dataset.state = state.key;
  const title = sessionTitle(summary, data, sessionId);
  if (title.id) {
    setText(titleId, title.id);
    titleId.href = linkFor({ lens: 'work', band: 'board', sel: { type: 'card', id: title.id } });
    top.insertBefore(titleId, titleEl);
  }
  setText(titleEl, title.text);

  const { line: identity, last: lastEventEl } = identityLine(state, summary, data);
  setLastEvent(lastEventEl, data.touch?.span?.lastTs ?? summary?.lastTs);
  header.insertBefore(identity, skeleton);
  skeleton.classList.remove('is-loading');
  setText(skeleton, stateSentence(state, summary, data));
  const sentence = skeleton;

  let gateEvents = data.events.filter((e) => e?.kind === 'done-gate');
  let verdicts = buildVerdictStrip(data, state.key, approvals, gateEvents);
  header.appendChild(verdicts.strip);
  let cost = buildCostStrip(summary, data, state.key);
  header.appendChild(cost);
  header.appendChild(buildActions(state, data, summary, sessionId, embedded, handlers));
  const notice = document.createElement('p');
  notice.className = 'sp-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  header.appendChild(notice);

  const bandsRoot = document.createElement('div');
  bandsRoot.className = 'session-bands';
  container.appendChild(bandsRoot);

  const diffHandlers = {
    ...handlers,
    onDiff: (btn, f) => toggleDiff(btn, f.change, f.name ?? f.path, f.path, handlers),
  };
  const root = summary?.worktree?.path ?? summary?.cwd ?? null;
  const touching = buildTouching(data, diffHandlers, root, sessionId);
  const learning = buildLearning(data, {
    gapRows: buildGapCallout,
    onOpenGap: (id) => { location.assign(linkFor({ lens: 'learning', band: 'registry', sel: { type: 'capability', id: `guard:${id}` } })); },
  });

  // Doing: stage trace, guiding context, kind chips, search, one paged list.
  const page = data.page ?? { total: data.events.length, hasMore: false, nextBefore: null };
  const doing = buildBand('doing', 'Doing', '');
  const doingSummary = () => `${page.total} event${page.total === 1 ? '' : 's'}${data.loop?.key ? `  stage ${data.loop.key.toUpperCase()}` : ''}`;
  setText(doing.line, doingSummary());
  doing.body.appendChild(buildStageTrace(data.loop));
  const guide = document.createElement('details');
  guide.className = 'sp-guiding';
  const gsum = document.createElement('summary');
  setText(gsum, guidingSummary(data.guiding, data.skillsUsed));
  guide.appendChild(gsum);
  guide.appendChild(buildGuidingBar(data.guiding ?? [], data.events, handlers, data.skillsUsed ?? []));
  doing.body.appendChild(guide);

  const controls = document.createElement('div');
  controls.className = 'sp-feed-controls';
  const chips = document.createElement('div');
  chips.className = 'sp-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Filter events by kind');
  let chip = KIND_CHIPS.includes(readPref('kind')) ? readPref('kind') : 'context';
  let query = '';
  const chipBtns = new Map();
  for (const k of KIND_CHIPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-chip';
    setText(b, k);
    b.setAttribute('aria-pressed', String(k === chip));
    b.addEventListener('click', () => {
      chip = k; writePref('kind', k);
      for (const [kk, bb] of chipBtns) bb.setAttribute('aria-pressed', String(kk === chip));
      drawFeed();
    });
    chipBtns.set(k, b);
    chips.appendChild(b);
  }
  controls.appendChild(chips);
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'sp-search';
  search.placeholder = 'Search in session';
  search.setAttribute('aria-label', 'Search events in this session');
  search.addEventListener('input', () => { query = search.value; drawFeed(); });
  controls.appendChild(search);
  const newChip = document.createElement('button');
  newChip.type = 'button';
  newChip.className = 'sp-new-chip';
  newChip.hidden = true;
  controls.appendChild(newChip);
  doing.body.appendChild(controls);

  const feedList = document.createElement('div');
  feedList.className = 'event-list sp-feed';
  doing.body.appendChild(feedList);
  const foot = document.createElement('div');
  foot.className = 'sp-feed-foot';
  const shown = document.createElement('span');
  shown.className = 'sp-feed-count';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'sp-more';
  setText(more, 'Older 50');
  foot.appendChild(shown);
  foot.appendChild(more);
  doing.body.appendChild(foot);

  // Oldest first, as the server returns it; drawn newest first.
  let loaded = data.events.slice();
  let pending = [];
  let pagedAway = false;
  let nextBefore = page.hasMore ? page.nextBefore : null;

  function drawFeed() {
    clear(feedList);
    const rows = filterEvents(loaded, chip, query).reverse();
    for (const ev of rows) {
      const r = makeEventRow(ev, handlers, false);
      r.tabIndex = -1;
      feedList.appendChild(r);
    }
    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'band-empty';
      setText(p, loaded.length
        ? `No ${chip === 'all' ? '' : chip + ' '}events${query ? ` matching "${query}"` : ''} in the ${loaded.length} loaded. Pick another kind or load older.`
        : `No events captured for this session. ${summary?.tool ?? 'The tool'} stores none locally for it.`);
      feedList.appendChild(p);
    }
    const total = Math.max(page.total, loaded.length);
    setText(shown, rows.length === loaded.length
      ? `showing ${loaded.length} of ${total}`
      : `showing ${rows.length} ${chip} of ${loaded.length} loaded, ${total} total`);
    more.hidden = nextBefore == null;
  }

  async function loadOlder() {
    if (nextBefore == null) return;
    more.disabled = true;
    try {
      const older = await getState(sessionId, { limit: FEED_PAGE, before: nextBefore });
      const evs = (older?.events ?? []);
      loaded = [...evs, ...loaded];
      nextBefore = older?.page?.hasMore ? older.page.nextBefore : null;
      pagedAway = true;
      drawFeed();
    } catch (err) {
      setText(shown, `Event feed unavailable: ${err?.message ?? err}. Retry with Older 50.`);
    } finally { more.disabled = false; }
  }
  more.addEventListener('click', loadOlder);

  newChip.addEventListener('click', () => {
    loaded = [...loaded, ...pending];
    pending = [];
    pagedAway = false;
    newChip.hidden = true;
    drawFeed();
    feedList.scrollIntoView?.({ block: 'start' });
  });

  drawFeed();

  const bands = { touching, learning, doing };
  for (const b of Object.values(bands)) wireRowKeys(b.body);
  if (state.key === 'nolog') {
    // Header only, with the reason; the bands stay reachable but closed.
    for (const id of BAND_IDS) { setBandOpen(bands[id], false); bandsRoot.appendChild(bands[id].sec); }
  } else {
    for (const id of bandOrder(state.key)) bandsRoot.appendChild(bands[id].sec);
  }

  // /session/<id>#touching lands on that band, open.
  const hash = (location.hash ?? '').replace(/^#/, '');
  if (bands[hash]) { setBandOpen(bands[hash], true); bands[hash].sec.scrollIntoView?.({ block: 'start' }); }

  function onDocClick(e) {
    if (e.target?.closest?.('.diff-popup') || e.target?.classList?.contains('diff-toggle')) return;
    hideDiffPopup();
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') {
      hideDiffPopup();
      closeExportMenu();
      return;
    }
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ']') { e.preventDefault?.(); loadOlder(); }
    if (e.key === '[') { e.preventDefault?.(); feedList.scrollIntoView?.({ block: 'start' }); }
  }

  function onListScroll() {
    hideDiffPopup();
  }

  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onDocKeydown);
  feedList.addEventListener('scroll', onListScroll);

  let headerFetchedAt = Date.now();
  let headerFetching = false;
  let shownKey = state.key;
  let disposed = false;

  function redrawHeader(fresh, freshSummary) {
    const st = sessionState(freshSummary, fresh);
    const nextVerdicts = buildVerdictStrip(fresh, st.key, approvals, gateEvents);
    header.replaceChild(nextVerdicts.strip, verdicts.strip);
    verdicts = nextVerdicts;
    const nextCost = buildCostStrip(freshSummary, fresh, st.key);
    header.replaceChild(nextCost, cost);
    cost = nextCost;
    setText(sentence, stateSentence(st, freshSummary, fresh));
    // The page never reorders under the reader (spec section 4).
    if (st.key !== shownKey && (st.key === 'finished' || st.key === 'abandoned')) {
      notice.hidden = false;
      setText(notice, 'Session finished. Verdicts arriving. Reload to reorder the page.');
    }
  }

  async function refreshHeader() {
    if (headerFetching || Date.now() - headerFetchedAt < HEADER_REFRESH_MS) return;
    headerFetching = true;
    headerFetchedAt = Date.now();
    try {
      const fresh = await getState(sessionId, { limit: 1 });
      if (disposed || !fresh || typeof fresh !== 'object') return;
      fresh.events = Array.isArray(fresh.events) ? fresh.events : [];
      redrawHeader(fresh, handlers.getSummary?.() ?? summary);
    } catch { /* the header keeps its last values and the last-event time shows how old they are */ }
    finally { headerFetching = false; }
  }

  function onMcEvents(e) {
    if (e.detail?.sessionId !== sessionId) return;
    const incoming = (e.detail?.events ?? []).filter(Boolean);
    if (!incoming.length) return;
    const newGates = incoming.filter((ev) => ev.kind === 'done-gate');
    if (newGates.length) {
      gateEvents = [...gateEvents, ...newGates];
      const next = buildDoneGateSlot(gateEvents);
      verdicts.strip.replaceChild(next, verdicts.doneGate);
      verdicts.doneGate = next;
    }
    setLastEvent(lastEventEl, incoming[incoming.length - 1].ts);
    page.total += incoming.length;
    setText(doing.line, doingSummary());
    // Live rows land in place unless the reader has paged or scrolled away.
    const scrolledPast = (feedList.getBoundingClientRect?.().top ?? 0) < 0;
    if (pagedAway || scrolledPast || query) {
      pending = [...pending, ...incoming];
      newChip.hidden = false;
      setText(newChip, `${pending.length} new`);
    } else {
      loaded = [...loaded, ...incoming];
      drawFeed();
    }
    if (state.key === 'live' || state.key === 'idle') refreshHeader();
  }

  window.addEventListener('mc-events', onMcEvents);

  // { releaseShared: false } drops only this render's own listeners and
  // leaves the shared diff popup and export menu alone, for a caller that no
  // longer owns the page (a newer page may have them open).
  return function cleanup({ releaseShared = true } = {}) {
    disposed = true;
    window.removeEventListener('mc-events', onMcEvents);
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKeydown);
    feedList.removeEventListener('scroll', onListScroll);
    if (!releaseShared) return;
    hideDiffPopup();
    closeExportMenu();
  };
}
