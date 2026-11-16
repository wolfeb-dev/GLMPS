// web/observability/budget.js
// Usage panel - renderUsage(container, data)
// Matches the official Claude Code extension usage panel.
// Fetches via fetchBudget() from api.js when called from renderAnalytics.
// Pure DOM construction: createElement / textContent ONLY.
// innerHTML is not used; containers are emptied with clear().

import { fetchBudget } from '../shared/api.js';
import { setText, clear } from '../shared/dom-util.js';
import { formatTime } from '../shared/time-format.js';

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function fmtPlan(tier) {
  if (!tier) return null;
  if (tier === 'default_claude_max_5x')  return 'Claude Max 5x';
  if (tier === 'default_claude_max_20x') return 'Max 20x';
  if (tier === 'pro') return 'Pro';
  // Fallback: capitalise first letter, strip "default_claude_" prefix
  const cleaned = tier.replace(/^default_claude_/, '').replace(/_/g, ' ');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function fmtReset(resetsAt) {
  if (!resetsAt) return null;
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return 'soon';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return 'in ' + diffMin + 'm';
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 48) return 'in ' + diffH + 'h';
  const diffD = Math.floor(diffH / 24);
  return 'in ' + diffD + 'd';
}

function fillClass(pct) {
  return pct >= 80 ? 'usage-bar-fill usage-bar-fill-warn' : 'usage-bar-fill usage-bar-fill-normal';
}

function pctTextClass(pct) {
  return pct >= 80 ? 'usage-bar-pct usage-bar-pct-warn' : 'usage-bar-pct';
}

function buildBar(label, limiter) {
  if (!limiter) return null;

  const pct = Math.floor(limiter.usedPercent ?? 0);

  const row = el('div', 'usage-bar-row');

  // Label + % line
  const top = el('div', 'usage-bar-top');

  const labelEl = el('span', 'usage-bar-label');
  setText(labelEl, label);
  top.appendChild(labelEl);

  const pctEl = el('span', pctTextClass(pct));
  setText(pctEl, pct + '%');
  top.appendChild(pctEl);

  row.appendChild(top);

  // Track + fill
  const track = el('div', 'usage-bar-track');
  const fill = el('div', fillClass(pct));
  fill.style.width = Math.min(100, pct) + '%';
  track.appendChild(fill);
  row.appendChild(track);

  // Reset countdown
  const reset = fmtReset(limiter.resetsAt);
  if (reset) {
    const resetEl = el('div', 'usage-bar-reset');
    setText(resetEl, 'Resets ' + reset);
    row.appendChild(resetEl);
  }

  return row;
}

function buildFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return null;

  const wrap = el('div', 'usage-flags');
  for (const flag of flags) {
    const chip = el('span', 'usage-flag-chip usage-flag-chip-' + (flag.severity ?? 'info'));
    setText(chip, flag.message ?? flag.code ?? flag.severity ?? 'flag');
    wrap.appendChild(chip);
  }
  return wrap;
}

/**
 * renderUsage(container, data)
 *
 * Renders the Usage panel into container.
 * data is the shape returned by GET /api/budget.
 */
export function renderUsage(container, data) {
  clear(container);

  const root = el('div', 'usage-root');

  const card = el('div', 'usage-card');

  const heading = el('div', 'usage-heading');
  setText(heading, 'Usage');
  card.appendChild(heading);

  // Not-available guard
  if (!data?.available) {
    const note = el('div', 'usage-unavailable');
    setText(note, 'Usage tracking requires an active Claude.ai session');
    card.appendChild(note);
    root.appendChild(card);
    container.appendChild(root);
    return;
  }

  const plan = data?.plan ?? null;
  const meta = data?.meta ?? null;

  if (plan || meta) {
    const metaRow = el('div', 'usage-meta-row');

    const planLabel = fmtPlan(plan?.rateLimitTier);
    if (planLabel) {
      const planChip = el('span', 'usage-plan-chip');
      setText(planChip, planLabel);
      metaRow.appendChild(planChip);
    }

    if (meta?.model) {
      const sep = el('span', 'usage-meta-sep');
      setText(sep, '\u00B7');
      metaRow.appendChild(sep);

      const modelEl = el('span', 'usage-meta-model');
      setText(modelEl, meta.model);
      metaRow.appendChild(modelEl);
    }

    if (meta?.contextPercent != null) {
      const sep = el('span', 'usage-meta-sep');
      setText(sep, '\u00B7');
      metaRow.appendChild(sep);

      const ctxEl = el('span', 'usage-meta-ctx');
      setText(ctxEl, meta.contextPercent + '% context');
      metaRow.appendChild(ctxEl);
    }

    if (meta?.costUsd != null && meta.costUsd > 0) {
      const sep = el('span', 'usage-meta-sep');
      setText(sep, '\u00B7');
      metaRow.appendChild(sep);

      const costEl = el('span', 'usage-meta-cost');
      setText(costEl, '$' + meta.costUsd.toFixed(2) + ' session');
      metaRow.appendChild(costEl);
    }

    if (metaRow.childNodes.length > 0) card.appendChild(metaRow);
  }

  const usage = data?.usage ?? {};
  const barsWrap = el('div', 'usage-bars');

  const bar1 = buildBar('Session (5hr)', usage.fiveHour);
  const bar2 = buildBar('Weekly (7 day)', usage.sevenDay);
  const bar3 = buildBar('Weekly Sonnet', usage.sevenDaySonnet);

  let hasBars = false;
  if (bar1) { barsWrap.appendChild(bar1); hasBars = true; }
  if (bar2) { barsWrap.appendChild(bar2); hasBars = true; }
  if (bar3) { barsWrap.appendChild(bar3); hasBars = true; }

  if (hasBars) card.appendChild(barsWrap);

  const flagEl = buildFlags(data?.flags);
  if (flagEl) card.appendChild(flagEl);

  const manageRow = el('div', 'usage-manage-row');

  const link = el('a', 'usage-manage-link');
  link.href = 'https://claude.ai/settings/usage';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  setText(link, 'Manage usage on claude.ai');
  manageRow.appendChild(link);

  if (data?.updatedTs) {
    const d = new Date(data.updatedTs);
    if (!isNaN(d.getTime())) {
      const tsEl = el('span', 'usage-updated-ts');
      setText(tsEl, 'Updated ' + formatTime(d, { date: false }));
      manageRow.appendChild(tsEl);
    }
  }

  card.appendChild(manageRow);

  root.appendChild(card);
  container.appendChild(root);
}

// (fetchAndRenderUsage removed: analytics fetches budget itself and calls renderUsage)

/**
 * renderActionsMinutes(container, view)
 *
 * GitHub Actions billed minutes card (card glmps-2-0-73), in the Usage card's
 * styles. view is actionsMinutesView(GET /api/usage/actions); null renders nothing.
 */
export function renderActionsMinutes(container, view) {
  clear(container);
  if (!view) return;

  const root = el('div', 'usage-root');
  const card = el('div', 'usage-card');

  const heading = el('div', 'usage-heading');
  setText(heading, 'GitHub Actions');
  card.appendChild(heading);

  if (!view.measured) {
    const note = el('div', 'usage-unavailable');
    setText(note, 'Not measured yet: the minutes tracker runs hourly.');
    card.appendChild(note);
    root.appendChild(card);
    container.appendChild(root);
    return;
  }

  const row = el('div', 'usage-bar-row');
  const top = el('div', 'usage-bar-top');
  const labelEl = el('span', 'usage-bar-label');
  setText(labelEl, `Billed minutes \u00B7 ${view.monthLabel}`);
  top.appendChild(labelEl);
  const pctEl = el('span', 'usage-bar-pct' + (view.level === 'normal' ? '' : ' usage-bar-pct-' + view.level));
  setText(pctEl, view.pctText);
  top.appendChild(pctEl);
  row.appendChild(top);

  const track = el('div', 'usage-bar-track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-label', `GitHub Actions billed minutes, ${view.summary}`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(view.fillPct)));
  const fill = el('div', 'usage-bar-fill usage-bar-fill-' + view.level);
  fill.style.width = view.fillPct + '%';
  track.appendChild(fill);
  row.appendChild(track);

  const sub = el('div', 'usage-bar-reset');
  setText(sub, [view.summary, view.resets].filter(Boolean).join(' \u00B7 '));
  row.appendChild(sub);
  if (view.osLine) {
    const os = el('div', 'usage-bar-reset');
    setText(os, view.osLine);
    row.appendChild(os);
  }
  for (const r of view.repos) {
    const repo = el('div', 'usage-bar-reset');
    setText(repo, `${r.repo} ${r.billed}`);
    row.appendChild(repo);
  }
  card.appendChild(row);

  if (view.refused) {
    const flags = el('div', 'usage-flags');
    const chip = el('span', 'usage-flag-chip usage-flag-chip-error');
    setText(chip, view.refused);
    flags.appendChild(chip);
    card.appendChild(flags);
  }

  const footer = el('div', 'usage-manage-row');
  const link = el('a', 'usage-manage-link');
  link.href = 'https://github.com/settings/billing';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  setText(link, 'Billing on github.com');
  footer.appendChild(link);
  const d = new Date(view.updatedTs);
  if (!isNaN(d.getTime())) {
    const tsEl = el('span', 'usage-updated-ts');
    setText(tsEl, 'Updated ' + formatTime(d, { date: false }));
    footer.appendChild(tsEl);
  }
  card.appendChild(footer);

  root.appendChild(card);
  container.appendChild(root);
}
