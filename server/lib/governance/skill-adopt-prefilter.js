// server/lib/governance/skill-adopt-prefilter.js
//
// Adoption pre-filter for external-skill discovery (glmps-87, docs/evolution
// -framework.md: "the star floor >= 100 gates eligible registry candidates").
//
// This is a NECESSARY-not-sufficient trust pre-filter on executable
// third-party instruction content (a SKILL.md's body is read and, once
// adopted, followed by an agent - it is not inert data). Passing this gate
// means only "cheap reputation signals didn't immediately disqualify it";
// it is not a security review and does not replace one.
//
// FAIL-CLOSED, deliberately the OPPOSITE of this codebase's usual fail-open
// discipline (skill-registry-scan.js, guard-retire.js, system-changes.js all
// fail open - one broken source contributes zero rows but never blocks the
// tick). Here, anything unverifiable is a REJECTION, not a skip:
//   - a sourceRepo that doesn't parse to a github.com/gitlab.com repo (or an
//     operator-allowlisted enterprise host, see GLMPS_SKILL_TRUSTED_HOSTS below)
//     -> reject
//   - a repo API call that errors, 404s, rate-limits, or omits an expected
//     field -> reject (never "treat as passing" or "treat as neutral")
//   - a private repo (API 403/404) -> reject
// A candidate is eligible only when verification affirmatively succeeds.
//
// mc-25 notes:
//   - A `claude-plugin-marketplace` entry with no per-skill `source`/`repo`
//     falls back to the registry's own baseUrl (the index URL, not a repo),
//     which parseRepoRef correctly rejects. This is intentional fail-closed
//     behavior, not a bug: an untrusted, source-less marketplace cannot have
//     its individual skills star-verified, so every skill it lists is
//     rejected as stars-unverifiable until the marketplace entry carries a
//     per-skill `source` pointing at that skill's own repo. (Extracting that
//     per-skill source automatically from marketplace frontmatter was
//     considered and deferred as a separate, more invasive follow-up - see
//     the FINDINGS on mc-25.)
//   - GitHub Enterprise / self-hosted GitLab hosts are opt-in via the
//     GLMPS_SKILL_TRUSTED_HOSTS env var (comma-separated hostnames, optionally
//     suffixed `:gitlab` for a self-hosted GitLab-style host; anything
//     without a suffix is treated as GitHub-style). Empty/unset by default,
//     so this is a strict opt-in and default behavior is unchanged. Even
//     once a host is recognized by parseRepoRef, fetchRepoMeta does NOT
//     attempt live star verification against it yet (see the comment on
//     fetchRepoMeta) - recognizing the host does not, by itself, make a
//     candidate eligible.

// starFloor: absolute minimum stars (a backstop). topStarsPct: the RELATIVE
// "only adopt the top 20% by stars" rule (glmps-114 direction) - applied on
// top of the floor inside filterEligibleAdoptCandidates, so the gate only ever
// gets stricter (a candidate must be >= starFloor AND in the top quintile of
// the batch it was discovered in).
export const DEFAULTS = Object.freeze({ starFloor: 100, freshnessMonths: 12, topStarsPct: 0.2 });

/**
 * Star-count cutoff for "keep only the top `pct` fraction by stars". Given the
 * verified star counts of a candidate pool, returns the minimum star count a
 * candidate needs to be in the top `pct`. Ties AT the cutoff are kept (so more
 * than pct*n may survive - deliberate; we never arbitrarily break a tie).
 * keepCount = max(1, ceil(n*pct)) so a non-empty pool always yields at least
 * its single most-starred candidate. Empty pool -> Infinity (nothing passes).
 */
export function topStarsCutoff(starCounts, pct = DEFAULTS.topStarsPct) {
  const nums = (Array.isArray(starCounts) ? starCounts : []).filter((s) => typeof s === 'number').sort((a, b) => b - a);
  if (nums.length === 0) return Infinity;
  const keepCount = Math.max(1, Math.ceil(nums.length * pct));
  return nums[keepCount - 1];
}

// Parse GLMPS_SKILL_TRUSTED_HOSTS into a lowercase hostname -> 'github'|'gitlab'
// map. Format: comma-separated entries, each "<host>" (GitHub-style, the
// default) or "<host>:gitlab" (self-hosted GitLab-style), e.g.
// "github.mycompany.com,gitlab.mycompany.com:gitlab". Follows the same
// env-override convention as server/lib/paths.js (e.g. GLMPS_EXTRA_EDITORS).
// Malformed/empty entries are skipped, never thrown.
function trustedHostsFromEnv(env) {
  const raw = (env && env.GLMPS_SKILL_TRUSTED_HOSTS) ?? '';
  const map = new Map();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [hostPart, typePart] = entry.split(':');
    const host = (hostPart || '').trim().toLowerCase();
    if (!host) continue;
    const type = (typePart || '').trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
    map.set(host, type);
  }
  return map;
}

/**
 * Parse a candidate's sourceRepo URL down to { host, owner, repo }. Strips a
 * trailing .git and any /tree|/blob|-/... path segments - owner+repo only.
 * Returns null for anything not a recognized github.com/gitlab.com repo
 * (raw.githubusercontent.com is treated as a github.com repo reference) AND
 * not on the GLMPS_SKILL_TRUSTED_HOSTS allowlist (empty by default -> FAIL-CLOSED
 * unless an operator opts a specific enterprise host in). Allowlisted hosts
 * get an extra `hostname` field carrying the literal matched host, so callers
 * can tell an enterprise ref apart from a canonical public one.
 * @param {string} sourceRepo
 * @param {{env?: object}} [opts]
 * @returns {{host:'github'|'gitlab', owner:string, repo:string, hostname?:string} | null}
 */
export function parseRepoRef(sourceRepo, { env = process.env } = {}) {
  if (typeof sourceRepo !== 'string' || !sourceRepo.trim()) return null;
  let s = sourceRepo.trim();
  // Allow a bare host with no scheme (e.g. "github.com/owner/repo").
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let url;
  try { url = new URL(s); } catch { return null; }
  const host = url.hostname.toLowerCase();
  let logicalHost;
  let hostname; // set only for an allowlisted enterprise/self-hosted host
  if (host === 'github.com' || host === 'www.github.com') logicalHost = 'github';
  else if (host === 'raw.githubusercontent.com') logicalHost = 'github';
  else if (host === 'gitlab.com' || host === 'www.gitlab.com') logicalHost = 'gitlab';
  else {
    const trusted = trustedHostsFromEnv(env).get(host);
    if (!trusted) return null; // unrecognized + not allowlisted -> null (FAIL-CLOSED default)
    logicalHost = trusted;
    hostname = host;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  let [owner, repo] = segments;
  repo = repo.replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return hostname ? { host: logicalHost, owner, repo, hostname } : { host: logicalHost, owner, repo };
}

/**
 * Pure verdict function over already-resolved metadata. Collects ALL failing
 * reasons (never short-circuits on the first one) so callers/operators can
 * see every disqualifying signal at once.
 * @param {{stars?:number, archived?:boolean, pushedAtMs?:number, trusted?:boolean}} meta
 * @param {{starFloor?:number, freshnessMonths?:number, nowMs?:number}} [opts]
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function passesAdoptionPrefilter(meta, { starFloor = DEFAULTS.starFloor, freshnessMonths = DEFAULTS.freshnessMonths, nowMs } = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};
  if (m.trusted === true) return { ok: true, reasons: ['trusted-registry'] };

  const reasons = [];
  if (typeof m.stars !== 'number') reasons.push('stars-unverifiable');
  else if (m.stars < starFloor) reasons.push('below-star-floor');

  if (m.archived === true) reasons.push('archived');

  if (typeof m.pushedAtMs !== 'number') reasons.push('freshness-unverifiable');
  else if (nowMs && (nowMs - m.pushedAtMs) > freshnessMonths * 30.44 * 86400000) reasons.push('stale');

  return { ok: reasons.length === 0, reasons };
}

async function defaultFetch(url, opts) { return fetch(url, opts); }

function ghHeaders() {
  return {
    'User-Agent': 'glmps-skill-adopt',
    Accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

/**
 * Resolve live repo metadata (stars, archived, last-push time) for a
 * candidate's sourceRepo. FAIL-CLOSED: any throw, non-ok response, or
 * missing expected field returns null - never a partial/guessed object.
 * @param {string} sourceRepo
 * @param {{fetchImpl?: (url:string, opts?:object) => Promise<{ok:boolean, json:() => Promise<any>}>}} [opts]
 * @returns {Promise<{stars:number, archived:boolean, pushedAtMs:number} | null>}
 */
export async function fetchRepoMeta(sourceRepo, { fetchImpl = defaultFetch } = {}) {
  const ref = parseRepoRef(sourceRepo);
  if (!ref) return null; // unparseable -> reject without ever calling fetch
  if (ref.hostname) {
    // ref came from the GLMPS_SKILL_TRUSTED_HOSTS allowlist (an enterprise
    // GitHub / self-hosted GitLab host), not a canonical public host. Live
    // verification against these is intentionally NOT implemented yet:
    //   - GitHub Enterprise Server / self-hosted GitLab each have their own
    //     API base per install; hardcoding a guessed convention here isn't
    //     safe without verifying it against the real install.
    //   - Blindly falling through to the public api.github.com/gitlab.com
    //     endpoints below using an enterprise-only owner/repo path would be
    //     actively WRONG, not just unverifiable: if that owner/repo happens
    //     to collide with an unrelated PUBLIC repo of the same path, this
    //     would silently borrow that public repo's star/freshness
    //     reputation for an entirely different, enterprise-only candidate - 
    //     a false-positive spoofing vector, the opposite of this module's
    //     fail-closed design. So: recognized by parseRepoRef, but still
    //     unverifiable here -> reject. See mc-25 FINDINGS for the follow-up
    //     to wire real enterprise/self-hosted verification.
    return null;
  }
  try {
    if (ref.host === 'github') {
      const res = await fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers: ghHeaders() });
      if (!res || !res.ok) return null;
      const body = await res.json();
      const stars = body?.stargazers_count;
      const archived = body?.archived;
      const pushedAtMs = typeof body?.pushed_at === 'string' ? Date.parse(body.pushed_at) : NaN;
      if (typeof stars !== 'number' || typeof archived !== 'boolean' || !Number.isFinite(pushedAtMs)) return null;
      return { stars, archived, pushedAtMs };
    }
    if (ref.host === 'gitlab') {
      const projectId = encodeURIComponent(`${ref.owner}/${ref.repo}`);
      const res = await fetchImpl(`https://gitlab.com/api/v4/projects/${projectId}`, {});
      if (!res || !res.ok) return null;
      const body = await res.json();
      const stars = body?.star_count;
      const archived = body?.archived;
      const pushedAtMs = typeof body?.last_activity_at === 'string' ? Date.parse(body.last_activity_at) : NaN;
      if (typeof stars !== 'number' || typeof archived !== 'boolean' || !Number.isFinite(pushedAtMs)) return null;
      return { stars, archived, pushedAtMs };
    }
    return null;
  } catch {
    return null; // FAIL-CLOSED: any network/parse error -> unverifiable -> reject
  }
}

/**
 * Filter a CandidateSkill[] down to those that pass the adoption pre-filter.
 * SEQUENTIAL (mirrors listRegistrySkills' own per-registry loop) to respect
 * upstream API rate limits - this is a discovery-scan cadence, not a hot path.
 * @param {object[]} candidates  CandidateSkill[] from listRegistrySkills
 * @param {{registries?:object[], starFloor?:number, freshnessMonths?:number, nowMs?:number, fetchImpl?:Function, fetchRepoMetaImpl?:Function}} [opts]
 * @returns {Promise<{eligible:object[], rejected:{candidate:object, reasons:string[]}[]}>}
 */
export async function filterEligibleAdoptCandidates(candidates, {
  registries = [],
  starFloor = DEFAULTS.starFloor,
  freshnessMonths = DEFAULTS.freshnessMonths,
  topStarsPct = DEFAULTS.topStarsPct,
  nowMs,
  fetchImpl,
  fetchRepoMetaImpl,
} = {}) {
  const eligible = [];
  const rejected = [];
  const list = Array.isArray(candidates) ? candidates : [];
  const regs = Array.isArray(registries) ? registries : [];
  const resolveMeta = fetchRepoMetaImpl ?? fetchRepoMeta;

  // Pass 1: trusted registries bypass entirely; untrusted candidates go through
  // the per-candidate baseline gate (fail-closed verification + freshness +
  // not-archived + absolute star floor). We record a provisional decision per
  // candidate (rather than emitting inline) so the RELATIVE top-stars cut below
  // can see the whole baseline-passing pool, while eligible/rejected still come
  // out in input order. Fetches still happen once, sequentially, in input order.
  const decisions = []; // { candidate, kind:'trusted'|'pool'|'rejected', meta?, reasons? }
  for (const candidate of list) {
    const reg = regs.find((r) => r && r.name === candidate?.registryName);
    const isTrusted = !!reg && (reg.trusted === true || reg.official === true);
    if (isTrusted) {
      // passesAdoptionPrefilter({ trusted: true }) always returns ok:true - 
      // routed through it anyway so the trust bypass has one authoritative
      // definition instead of being reimplemented inline here.
      passesAdoptionPrefilter({ trusted: true });
      decisions.push({ candidate, kind: 'trusted' });
      continue;
    }
    const meta = await resolveMeta(candidate?.sourceRepo, { fetchImpl });
    const res = passesAdoptionPrefilter({ ...(meta || {}), trusted: false }, { starFloor, freshnessMonths, nowMs });
    decisions.push(res.ok ? { candidate, kind: 'pool', meta } : { candidate, kind: 'rejected', reasons: res.reasons });
  }

  // Pass 2 (top-20% rule): among untrusted candidates that cleared the baseline,
  // keep only those in the top `topStarsPct` by verified stars. This is AND-ed
  // with the absolute floor (never a replacement), so the floor still backstops
  // an all-low-star batch from admitting its own "top 20%". Batch-relative:
  // eligibility depends on the other candidates resolved in the same scan.
  const cutoff = topStarsCutoff(decisions.filter((d) => d.kind === 'pool').map((d) => d.meta?.stars), topStarsPct);
  for (const d of decisions) {
    if (d.kind === 'trusted') {
      d.candidate.prefilter = { trusted: true };
      eligible.push(d.candidate);
    } else if (d.kind === 'rejected') {
      rejected.push({ candidate: d.candidate, reasons: d.reasons });
    } else if (typeof d.meta?.stars === 'number' && d.meta.stars >= cutoff) {
      d.candidate.prefilter = { stars: d.meta?.stars ?? null, pushedAtMs: d.meta?.pushedAtMs ?? null, archived: d.meta?.archived ?? null };
      eligible.push(d.candidate);
    } else {
      // Cleared the baseline (>= starFloor, fresh, verified) but not in the top
      // `topStarsPct` of this batch by stars.
      rejected.push({ candidate: d.candidate, reasons: ['outside-top-stars-percentile'] });
    }
  }

  return { eligible, rejected };
}
