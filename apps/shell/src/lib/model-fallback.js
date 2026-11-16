// apps/shell/src/lib/model-fallback.js
// Copy of server/lib/orchestration/model-fallback.js (card glmps-2-0-164): the
// desktop app may not import server code, and apps/shell/test/model-fallback.test.js
// keeps the two equal.
import { newestGeminiModel } from './agy-runner.js';

// A row with no quota pattern and no order never falls back: GPT and Grok stay
// that way until someone verifies their CLI's error text.
export const FALLBACK = Object.freeze({
  claude: Object.freeze({ quota: /hit your .*limit/i, order: Object.freeze(['opus', 'sonnet', 'haiku']), byFamily: false }),
  gemini: Object.freeze({ quota: /RESOURCE_EXHAUSTED|quota (?:reached|exceeded|exhausted)/i, order: null, byFamily: true }),
  gpt: Object.freeze({ quota: null, order: null, byFamily: false }),
  grok: Object.freeze({ quota: null, order: null, byFamily: false }),
});

export function isQuotaError(vendor, text) {
  const row = FALLBACK[vendor];
  return !!row?.quota && row.quota.test(String(text ?? ''));
}

const familyOf = (name) => String(name ?? '').replace(/\s*\((High|Medium|Low)\)$/, '');
const tierOf = (name) => /\((High|Medium|Low)\)$/.exec(String(name ?? ''))?.[1] ?? 'High';

/**
 * The model to try after `model` fails on quota, or null. Claude walks a fixed
 * alias order (a full model id maps to its alias; no model means the first).
 * Gemini takes the newest model the CLI lists from another family, because a
 * quota runs out for every tier of a family at once.
 */
export function fallbackModelFor(vendor, model, listed = []) {
  const row = FALLBACK[vendor];
  if (!row) return null;
  if (row.byFamily) {
    const others = (Array.isArray(listed) ? listed : []).filter((m) => familyOf(m) !== familyOf(model));
    return newestGeminiModel(others, tierOf(model)) ?? newestGeminiModel(others, 'High') ?? null;
  }
  if (!row.order) return null;
  const alias = model == null ? row.order[0] : row.order.find((a) => String(model).toLowerCase().includes(a));
  const i = row.order.indexOf(alias);
  return i >= 0 && i + 1 < row.order.length ? row.order[i + 1] : null;
}

/** Every model after `model`, in order: the whole list a CLI can try in turn (claude --fallback-model takes a comma list). */
export function fallbackChainFor(vendor, model, listed = []) {
  const row = FALLBACK[vendor];
  if (!row) return [];
  if (row.byFamily) { const next = fallbackModelFor(vendor, model, listed); return next ? [next] : []; }
  const chain = [];
  for (let m = fallbackModelFor(vendor, model, listed); m; m = fallbackModelFor(vendor, m, listed)) chain.push(m);
  return chain;
}
