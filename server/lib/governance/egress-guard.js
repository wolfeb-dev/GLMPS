// server/lib/governance/egress-guard.js
//
// Preventive egress gate for outbound fetches made by server-side background
// code (glmps-103's URL-scoped researchFn, invoked from research-scan-
// tick.js). This is NOT egress-detect.js: that module is a POST-HOC detector
// over the already-recorded session EVENT STREAM (file-read/edit events) - 
// it has no concept of a network destination and cannot block an outbound
// fetch. This module sits in front of the actual fetch() call and refuses
// anything not on a hardcoded allowlist, mirroring skill-adopt-prefilter.js's
// FAIL-CLOSED posture (the deliberate opposite of this codebase's usual
// fail-open discipline for scan/discovery ticks): unparseable, missing, or
// unlisted -> REFUSE, never "treat as passing".
//
// The allowlist is a hardcoded module constant, not read from config.json or
// an engagement profile - this is the last line of defense for what
// glmps-103's researchFn is allowed to reach, independent of whatever a
// (potentially tampered) sourceAllowlist claims. Scoped to exactly the
// kind:'url' entries in engagement-profiles/glmps.json (glmps-103's URL-only
// build scope; kind:'skill' sources such as storm-research are
// explicitly out of scope, see design-glmps-103-104.md sec 1.4: invoking those
// would require an unattended tool-using agent, a different automation class
// this build does not introduce).

/** Every host researchFn is currently permitted to reach: arXiv (+ its
 * export mirror, used for Atom-feed-style access) and the Anthropic
 * engineering blog (engagement-profiles/glmps.json's
 * anthropic-engineering-blog source: https://www.anthropic.com/engineering). */
export const DEFAULT_ALLOWLIST = Object.freeze([
  'arxiv.org',
  'export.arxiv.org',
  'www.anthropic.com',
]);

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Pure check: is `url`'s host on the allowlist? FAIL-CLOSED - an
 * unparseable URL, a missing host, or a host not literally present in the
 * allowlist all return false. Exact hostname match only, no wildcard/suffix
 * matching (mirrors engagement-profile.js's isAllowlistedSource discipline).
 * @param {string} url
 * @param {{allowlist?: string[]}} [opts]  defaults to DEFAULT_ALLOWLIST; the
 *   override exists for test injection only - production call sites never
 *   pass one, so they always get the hardcoded list.
 * @returns {boolean}
 */
export function isAllowedEgressHost(url, { allowlist = DEFAULT_ALLOWLIST } = {}) {
  const host = hostOf(url);
  if (!host) return false;
  const list = Array.isArray(allowlist) ? allowlist : DEFAULT_ALLOWLIST;
  return list.some((h) => typeof h === 'string' && h.toLowerCase() === host);
}

async function defaultFetch(url) {
  const res = await fetch(url);
  if (!res || !res.ok) throw new Error(`egress-guard: fetch failed (${res?.status ?? 'no response'}): ${url}`);
  return res.text();
}

/**
 * Fail-closed fetch wrapper: refuses (throws, never fetches) when `url`'s
 * host is not on the allowlist. This is the ONLY sanctioned way for
 * glmps-103's researchFn to reach the network - callers must never invoke a
 * bare fetch()/fetchImpl() directly.
 * @param {string} url
 * @param {{fetchImpl?: (url:string)=>Promise<string>, allowlist?: string[]}} [opts]
 *   fetchImpl defaults to a thin node fetch() wrapper; tests always inject a
 *   stub - never a real network call in a test. allowlist defaults to
 *   DEFAULT_ALLOWLIST (test-injection override only, see isAllowedEgressHost).
 * @returns {Promise<string>}
 */
export async function guardedFetch(url, { fetchImpl = defaultFetch, allowlist = DEFAULT_ALLOWLIST } = {}) {
  if (!isAllowedEgressHost(url, { allowlist })) {
    throw new Error(`egress-guard: refusing to fetch '${url}' \u2014 host not on the allowlist`);
  }
  return fetchImpl(url);
}
