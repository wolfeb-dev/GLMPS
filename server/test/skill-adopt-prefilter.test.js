// server/test/skill-adopt-prefilter.test.js
//
// Adoption pre-filter (glmps-87): a NECESSARY-not-sufficient trust gate on
// executable third-party skill content. Every check here is FAIL-CLOSED - 
// the opposite of this codebase's usual fail-open discipline (see
// skill-registry-scan.js's own comment on that). A candidate is eligible
// only when verification affirmatively succeeds; anything unparseable,
// unreachable, or missing a field is rejected, never silently skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  parseRepoRef,
  passesAdoptionPrefilter,
  fetchRepoMeta,
  filterEligibleAdoptCandidates,
  topStarsCutoff,
} from '../lib/governance/skill-adopt-prefilter.js';


test('DEFAULTS: starFloor 100, freshnessMonths 12, topStarsPct 0.2', () => {
  assert.deepEqual(DEFAULTS, { starFloor: 100, freshnessMonths: 12, topStarsPct: 0.2 });
});


test('parseRepoRef: github https url', () => {
  assert.deepEqual(parseRepoRef('https://github.com/anthropics/skills'), { host: 'github', owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: github url with trailing .git', () => {
  assert.deepEqual(parseRepoRef('https://github.com/anthropics/skills.git'), { host: 'github', owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: bare github.com host, no scheme', () => {
  assert.deepEqual(parseRepoRef('github.com/anthropics/skills'), { host: 'github', owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: github url with /tree/main/sub/path -> owner/repo only', () => {
  assert.deepEqual(parseRepoRef('https://github.com/anthropics/skills/tree/main/some/skill'), { host: 'github', owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: github url with /blob/... path', () => {
  assert.deepEqual(parseRepoRef('https://github.com/anthropics/skills/blob/main/SKILL.md'), { host: 'github', owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: raw.githubusercontent.com url', () => {
  assert.deepEqual(parseRepoRef('https://raw.githubusercontent.com/anthropics/skills/main/SKILL.md'), { host: 'github', owner: 'anthropics', repo: 'skills' });
});

test('parseRepoRef: gitlab.com url', () => {
  assert.deepEqual(parseRepoRef('https://gitlab.com/some-group/some-repo'), { host: 'gitlab', owner: 'some-group', repo: 'some-repo' });
});

test('parseRepoRef: gitlab.com url with trailing .git and extra path', () => {
  assert.deepEqual(parseRepoRef('https://gitlab.com/some-group/some-repo.git/-/tree/main'), { host: 'gitlab', owner: 'some-group', repo: 'some-repo' });
});

test('parseRepoRef: junk / non-repo strings -> null', () => {
  assert.equal(parseRepoRef('not a url at all'), null);
  assert.equal(parseRepoRef('https://example.com/marketplace.json'), null);
  assert.equal(parseRepoRef(''), null);
  assert.equal(parseRepoRef(null), null);
  assert.equal(parseRepoRef(undefined), null);
});

test('parseRepoRef: a bare host with no owner/repo path -> null', () => {
  assert.equal(parseRepoRef('https://github.com/'), null);
  assert.equal(parseRepoRef('https://github.com/anthropics'), null);
});


test('parseRepoRef: default (no env / GLMPS_SKILL_TRUSTED_HOSTS unset) - enterprise host still rejected, behavior unchanged', () => {
  assert.equal(parseRepoRef('https://github.mycompany.com/team/tool', { env: {} }), null);
  assert.equal(parseRepoRef('https://gitlab.mycompany.com/team/tool', { env: {} }), null);
});

test('parseRepoRef: allowlisted GitHub Enterprise host parses to a repo ref', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'github.mycompany.com' };
  assert.deepEqual(
    parseRepoRef('https://github.mycompany.com/team/tool', { env }),
    { host: 'github', owner: 'team', repo: 'tool', hostname: 'github.mycompany.com' }
  );
});

test('parseRepoRef: allowlisted self-hosted GitLab host (":gitlab" suffix) parses to a repo ref', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'gitlab.mycompany.com:gitlab' };
  assert.deepEqual(
    parseRepoRef('https://gitlab.mycompany.com/team/tool', { env }),
    { host: 'gitlab', owner: 'team', repo: 'tool', hostname: 'gitlab.mycompany.com' }
  );
});

test('parseRepoRef: multiple mixed-style hosts in one allowlist all resolve', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'github.mycompany.com,gitlab.mycompany.com:gitlab' };
  assert.deepEqual(
    parseRepoRef('https://github.mycompany.com/a/b', { env }),
    { host: 'github', owner: 'a', repo: 'b', hostname: 'github.mycompany.com' }
  );
  assert.deepEqual(
    parseRepoRef('https://gitlab.mycompany.com/a/b', { env }),
    { host: 'gitlab', owner: 'a', repo: 'b', hostname: 'gitlab.mycompany.com' }
  );
});

test('parseRepoRef: a host NOT on the allowlist is still rejected, even with an allowlist configured for a different host', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'github.mycompany.com' };
  assert.equal(parseRepoRef('https://evil.example.com/team/tool', { env }), null);
});

test('parseRepoRef: allowlisted host matching is case-insensitive', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'github.mycompany.com' };
  assert.deepEqual(
    parseRepoRef('https://GitHub.MyCompany.com/team/tool', { env }),
    { host: 'github', owner: 'team', repo: 'tool', hostname: 'github.mycompany.com' }
  );
});

test('parseRepoRef: allowlisted self-hosted GitLab host strips a trailing /-/tree/... path to owner+repo', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'gitlab.mycompany.com:gitlab' };
  assert.deepEqual(
    parseRepoRef('https://gitlab.mycompany.com/team/tool.git/-/tree/main', { env }),
    { host: 'gitlab', owner: 'team', repo: 'tool', hostname: 'gitlab.mycompany.com' }
  );
});

test('parseRepoRef: canonical public hosts are unaffected by an allowlist and still return the plain {host,owner,repo} shape', () => {
  const env = { GLMPS_SKILL_TRUSTED_HOSTS: 'github.mycompany.com' };
  assert.deepEqual(
    parseRepoRef('https://github.com/anthropics/skills', { env }),
    { host: 'github', owner: 'anthropics', repo: 'skills' }
  );
});


const NOW = Date.parse('2026-07-16T00:00:00Z');
const RECENT = Date.parse('2026-06-01T00:00:00Z'); // ~1.5 months ago
const STALE = Date.parse('2024-01-01T00:00:00Z'); // way over a year ago

test('passesAdoptionPrefilter: fresh, above floor, not archived -> ok', () => {
  const res = passesAdoptionPrefilter({ stars: 500, archived: false, pushedAtMs: RECENT }, { nowMs: NOW });
  assert.deepEqual(res, { ok: true, reasons: [] });
});

test('passesAdoptionPrefilter: stars below floor -> below-star-floor', () => {
  const res = passesAdoptionPrefilter({ stars: 3, archived: false, pushedAtMs: RECENT }, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.reasons, ['below-star-floor']);
});

test('passesAdoptionPrefilter: stars missing (unverifiable) -> stars-unverifiable, FAIL-CLOSED', () => {
  const res = passesAdoptionPrefilter({ archived: false, pushedAtMs: RECENT }, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.ok(res.reasons.includes('stars-unverifiable'));
});

test('passesAdoptionPrefilter: archived -> archived', () => {
  const res = passesAdoptionPrefilter({ stars: 500, archived: true, pushedAtMs: RECENT }, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.reasons, ['archived']);
});

test('passesAdoptionPrefilter: stale pushedAtMs (> freshnessMonths ago) -> stale', () => {
  const res = passesAdoptionPrefilter({ stars: 500, archived: false, pushedAtMs: STALE }, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.reasons, ['stale']);
});

test('passesAdoptionPrefilter: pushedAtMs missing (unverifiable) -> freshness-unverifiable, FAIL-CLOSED', () => {
  const res = passesAdoptionPrefilter({ stars: 500, archived: false }, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.ok(res.reasons.includes('freshness-unverifiable'));
});

test('passesAdoptionPrefilter: trusted:true bypasses everything else', () => {
  const res = passesAdoptionPrefilter({ trusted: true });
  assert.deepEqual(res, { ok: true, reasons: ['trusted-registry'] });
});

test('passesAdoptionPrefilter: trusted:true bypasses even when stars/pushedAtMs would otherwise fail', () => {
  const res = passesAdoptionPrefilter({ trusted: true, stars: 0, archived: true }, { nowMs: NOW });
  assert.deepEqual(res, { ok: true, reasons: ['trusted-registry'] });
});

test('passesAdoptionPrefilter: multiple simultaneous failures collect all reasons', () => {
  const res = passesAdoptionPrefilter({ stars: 1, archived: true, pushedAtMs: STALE }, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.reasons.sort(), ['archived', 'below-star-floor', 'stale'].sort());
});

test('passesAdoptionPrefilter: totally empty meta (nothing verifiable) -> both unverifiable reasons', () => {
  const res = passesAdoptionPrefilter({}, { nowMs: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.reasons.sort(), ['freshness-unverifiable', 'stars-unverifiable'].sort());
});

test('passesAdoptionPrefilter: custom starFloor/freshnessMonths override defaults', () => {
  const okAtLowerFloor = passesAdoptionPrefilter({ stars: 50, archived: false, pushedAtMs: RECENT }, { nowMs: NOW, starFloor: 10 });
  assert.equal(okAtLowerFloor.ok, true);
  const failsAtHigherFloor = passesAdoptionPrefilter({ stars: 50, archived: false, pushedAtMs: RECENT }, { nowMs: NOW, starFloor: 1000 });
  assert.equal(failsAtHigherFloor.ok, false);
  assert.deepEqual(failsAtHigherFloor.reasons, ['below-star-floor']);
});

test('passesAdoptionPrefilter: no nowMs supplied -> freshness check is skipped (cannot evaluate staleness)', () => {
  const res = passesAdoptionPrefilter({ stars: 500, archived: false, pushedAtMs: STALE });
  assert.equal(res.ok, true);
});


function stubFetch(map) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (!(url in map)) throw new Error(`unexpected fetch: ${url}`);
    const v = map[url];
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = calls;
  return fn;
}

test('fetchRepoMeta: github repo -> maps stargazers_count/archived/pushed_at', async () => {
  const url = 'https://api.github.com/repos/anthropics/skills';
  const fetchImpl = stubFetch({
    [url]: { ok: true, json: async () => ({ stargazers_count: 321, archived: false, pushed_at: '2026-06-01T00:00:00Z' }) },
  });
  const meta = await fetchRepoMeta('https://github.com/anthropics/skills', { fetchImpl });
  assert.equal(meta.stars, 321);
  assert.equal(meta.archived, false);
  assert.equal(meta.pushedAtMs, Date.parse('2026-06-01T00:00:00Z'));
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, url);
});

test('fetchRepoMeta: gitlab repo -> maps star_count/archived/last_activity_at', async () => {
  const url = 'https://gitlab.com/api/v4/projects/' + encodeURIComponent('some-group/some-repo');
  const fetchImpl = stubFetch({
    [url]: { ok: true, json: async () => ({ star_count: 150, archived: false, last_activity_at: '2026-05-01T00:00:00Z' }) },
  });
  const meta = await fetchRepoMeta('https://gitlab.com/some-group/some-repo', { fetchImpl });
  assert.equal(meta.stars, 150);
  assert.equal(meta.archived, false);
  assert.equal(meta.pushedAtMs, Date.parse('2026-05-01T00:00:00Z'));
});

test('fetchRepoMeta: !res.ok -> null, FAIL-CLOSED', async () => {
  const url = 'https://api.github.com/repos/anthropics/skills';
  const fetchImpl = stubFetch({ [url]: { ok: false, json: async () => ({}) } });
  const meta = await fetchRepoMeta('https://github.com/anthropics/skills', { fetchImpl });
  assert.equal(meta, null);
});

test('fetchRepoMeta: throwing fetch -> null, FAIL-CLOSED', async () => {
  const url = 'https://api.github.com/repos/anthropics/skills';
  const fetchImpl = stubFetch({ [url]: new Error('network down') });
  const meta = await fetchRepoMeta('https://github.com/anthropics/skills', { fetchImpl });
  assert.equal(meta, null);
});

test('fetchRepoMeta: unparseable sourceRepo -> null without ever calling fetch', async () => {
  const fetchImpl = stubFetch({});
  const meta = await fetchRepoMeta('https://example.com/marketplace.json', { fetchImpl });
  assert.equal(meta, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('fetchRepoMeta: allowlisted enterprise host is recognized by parseRepoRef but still rejected here - no live verification wired, and no fallback to the public API (would risk spoofing an unrelated public repo\'s stars)', async () => {
  const prevEnv = process.env.GLMPS_SKILL_TRUSTED_HOSTS;
  process.env.GLMPS_SKILL_TRUSTED_HOSTS = 'github.mycompany.com';
  try {
    const fetchImpl = stubFetch({}); // must never be called
    const meta = await fetchRepoMeta('https://github.mycompany.com/team/tool', { fetchImpl });
    assert.equal(meta, null);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    if (prevEnv === undefined) delete process.env.GLMPS_SKILL_TRUSTED_HOSTS;
    else process.env.GLMPS_SKILL_TRUSTED_HOSTS = prevEnv;
  }
});

test('fetchRepoMeta: missing expected field on an ok response -> null, FAIL-CLOSED', async () => {
  const url = 'https://api.github.com/repos/anthropics/skills';
  // stargazers_count absent entirely -> stars would be undefined, not a number
  const fetchImpl = stubFetch({ [url]: { ok: true, json: async () => ({ archived: false, pushed_at: '2026-06-01T00:00:00Z' }) } });
  const meta = await fetchRepoMeta('https://github.com/anthropics/skills', { fetchImpl });
  assert.equal(meta, null);
});


test('filterEligibleAdoptCandidates: a trusted registry bypasses verification entirely (no fetch call)', async () => {
  const candidates = [{ id: '1', name: 'trusted-skill', sourceRepo: 'https://github.com/org/repo', registryName: 'curated' }];
  const registries = [{ name: 'curated', baseUrl: 'https://x', format: 'skill-md', trusted: true }];
  let fetchCalls = 0;
  const fetchRepoMetaImpl = async () => { fetchCalls++; return null; };
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.equal(eligible.length, 1);
  assert.equal(rejected.length, 0);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(eligible[0].prefilter, { trusted: true });
});

test('filterEligibleAdoptCandidates: registry marked official:true also counts as trusted', async () => {
  const candidates = [{ id: '1', name: 'official-skill', sourceRepo: 'https://github.com/org/repo', registryName: 'official-reg' }];
  const registries = [{ name: 'official-reg', baseUrl: 'https://x', format: 'skill-md', official: true }];
  const fetchRepoMetaImpl = async () => { throw new Error('should not be called'); };
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.equal(eligible.length, 1);
  assert.equal(rejected.length, 0);
});

test('filterEligibleAdoptCandidates: a 500-star fresh repo is kept eligible with prefilter metadata attached', async () => {
  const candidates = [{ id: '2', name: 'good-skill', sourceRepo: 'https://github.com/org/good', registryName: 'reg-untrusted' }];
  const registries = [{ name: 'reg-untrusted', baseUrl: 'https://x', format: 'skill-md' }];
  const fetchRepoMetaImpl = async () => ({ stars: 500, archived: false, pushedAtMs: RECENT });
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.equal(eligible.length, 1);
  assert.equal(rejected.length, 0);
  assert.deepEqual(eligible[0].prefilter, { stars: 500, pushedAtMs: RECENT, archived: false });
});

test('filterEligibleAdoptCandidates: a 3-star repo is rejected with reason below-star-floor', async () => {
  const candidates = [{ id: '3', name: 'small-skill', sourceRepo: 'https://github.com/org/small', registryName: 'reg-untrusted' }];
  const registries = [{ name: 'reg-untrusted', baseUrl: 'https://x', format: 'skill-md' }];
  const fetchRepoMetaImpl = async () => ({ stars: 3, archived: false, pushedAtMs: RECENT });
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.equal(eligible.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].candidate.id, '3');
  assert.deepEqual(rejected[0].reasons, ['below-star-floor']);
});

test('filterEligibleAdoptCandidates: an unverifiable sourceRepo (fetchRepoMeta returns null) is rejected stars-unverifiable, FAIL-CLOSED', async () => {
  const candidates = [{ id: '4', name: 'unverifiable-skill', sourceRepo: 'not-a-real-repo-url', registryName: 'reg-untrusted' }];
  const registries = [{ name: 'reg-untrusted', baseUrl: 'https://x', format: 'skill-md' }];
  const fetchRepoMetaImpl = async () => null;
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.equal(eligible.length, 0);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reasons.includes('stars-unverifiable'));
  assert.ok(rejected[0].reasons.includes('freshness-unverifiable'));
});

test('filterEligibleAdoptCandidates: mixed batch - trusted bypass, kept, and rejected all in one pass, processed sequentially', async () => {
  const order = [];
  const candidates = [
    { id: 'a', name: 'trusted-one', sourceRepo: 'https://github.com/org/a', registryName: 'curated' },
    { id: 'b', name: 'good-one', sourceRepo: 'https://github.com/org/b', registryName: 'reg-untrusted' },
    { id: 'c', name: 'bad-one', sourceRepo: 'https://github.com/org/c', registryName: 'reg-untrusted' },
  ];
  const registries = [
    { name: 'curated', baseUrl: 'https://x', format: 'skill-md', trusted: true },
    { name: 'reg-untrusted', baseUrl: 'https://y', format: 'skill-md' },
  ];
  const fetchRepoMetaImpl = async (sourceRepo) => {
    order.push(sourceRepo);
    if (sourceRepo.endsWith('/b')) return { stars: 200, archived: false, pushedAtMs: RECENT };
    return { stars: 1, archived: false, pushedAtMs: RECENT };
  };
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.equal(eligible.length, 2); // trusted 'a' + good 'b'
  assert.equal(rejected.length, 1); // bad 'c'
  assert.deepEqual(order, ['https://github.com/org/b', 'https://github.com/org/c']); // sequential, trusted never fetched
});

test('filterEligibleAdoptCandidates: empty candidates list -> empty eligible/rejected, no fetch calls', async () => {
  let calls = 0;
  const fetchRepoMetaImpl = async () => { calls++; return null; };
  const { eligible, rejected } = await filterEligibleAdoptCandidates([], { registries: [], fetchRepoMetaImpl });
  assert.deepEqual(eligible, []);
  assert.deepEqual(rejected, []);
  assert.equal(calls, 0);
});


test('topStarsCutoff: empty pool -> Infinity (nothing qualifies)', () => {
  assert.equal(topStarsCutoff([], 0.2), Infinity);
  assert.equal(topStarsCutoff([undefined, null, 'x'], 0.2), Infinity); // non-numbers filtered out
});

test('topStarsCutoff: single-member pool keeps its one candidate (keepCount >= 1)', () => {
  assert.equal(topStarsCutoff([500], 0.2), 500);
});

test('topStarsCutoff: top 20% of 5 is the single most-starred', () => {
  assert.equal(topStarsCutoff([1000, 800, 300, 200, 150], 0.2), 1000); // ceil(5*0.2)=1 -> cutoff = #1
  assert.equal(topStarsCutoff([1000, 800, 300, 200, 150, 140, 130, 120, 110, 105], 0.2), 800); // 10 -> keep 2 -> cutoff = #2
});

test('topStarsCutoff: ties at the cutoff are included via >=', () => {
  // ceil(3*0.2)=1 -> cutoff index 0 -> 500; both 500s clear it via >=.
  assert.equal(topStarsCutoff([500, 500, 300], 0.2), 500);
});

test('filterEligibleAdoptCandidates: top-20% keeps only the single most-starred of a 5-candidate pool', async () => {
  const registries = [{ name: 'reg-untrusted', baseUrl: 'https://x', format: 'skill-md' }];
  const stars = { a: 1000, b: 800, c: 300, d: 200, e: 150 };
  const candidates = Object.keys(stars).map((id) => ({ id, name: id, sourceRepo: `https://github.com/org/${id}`, registryName: 'reg-untrusted' }));
  const fetchRepoMetaImpl = async (sourceRepo) => ({ stars: stars[sourceRepo.split('/').pop()], archived: false, pushedAtMs: RECENT });
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.deepEqual(eligible.map((c) => c.id), ['a']); // only the 1000-star one
  assert.deepEqual(rejected.map((r) => r.candidate.id), ['b', 'c', 'd', 'e']);
  for (const r of rejected) assert.deepEqual(r.reasons, ['outside-top-stars-percentile']);
});

test('filterEligibleAdoptCandidates: ties at the top-stars cutoff are all kept', async () => {
  const registries = [{ name: 'reg-untrusted', baseUrl: 'https://x', format: 'skill-md' }];
  const stars = { a: 500, b: 500, c: 120 }; // ceil(3*0.2)=1 -> cutoff 500 -> a,b both kept
  const candidates = Object.keys(stars).map((id) => ({ id, name: id, sourceRepo: `https://github.com/org/${id}`, registryName: 'reg-untrusted' }));
  const fetchRepoMetaImpl = async (sourceRepo) => ({ stars: stars[sourceRepo.split('/').pop()], archived: false, pushedAtMs: RECENT });
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.deepEqual(eligible.map((c) => c.id).sort(), ['a', 'b']);
  assert.deepEqual(rejected.map((r) => r.candidate.id), ['c']);
});

test('filterEligibleAdoptCandidates: a below-floor candidate is rejected at the floor, never entering the top-20% pool', async () => {
  // The floor gates FIRST: the 50-star repo is below-star-floor, so the pool is
  // just [1000] and it survives the top-20% cut (it is not itself rejected as
  // "outside-top-stars-percentile"). Proves the two gates are AND-ed, floor first.
  const registries = [{ name: 'reg-untrusted', baseUrl: 'https://x', format: 'skill-md' }];
  const stars = { big: 1000, small: 50 };
  const candidates = Object.keys(stars).map((id) => ({ id, name: id, sourceRepo: `https://github.com/org/${id}`, registryName: 'reg-untrusted' }));
  const fetchRepoMetaImpl = async (sourceRepo) => ({ stars: stars[sourceRepo.split('/').pop()], archived: false, pushedAtMs: RECENT });
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.deepEqual(eligible.map((c) => c.id), ['big']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].candidate.id, 'small');
  assert.deepEqual(rejected[0].reasons, ['below-star-floor']); // floor reason, NOT the percentile reason
});

test('filterEligibleAdoptCandidates: trusted-registry candidates bypass the top-20% cut entirely', async () => {
  // Two trusted + two untrusted; the untrusted top-20% keeps only the top one,
  // but BOTH trusted candidates stay eligible regardless of any star ranking.
  const registries = [
    { name: 'curated', baseUrl: 'https://x', format: 'skill-md', trusted: true },
    { name: 'reg-untrusted', baseUrl: 'https://y', format: 'skill-md' },
  ];
  const candidates = [
    { id: 't1', name: 't1', sourceRepo: 'https://github.com/org/t1', registryName: 'curated' },
    { id: 'u1', name: 'u1', sourceRepo: 'https://github.com/org/u1', registryName: 'reg-untrusted' },
    { id: 't2', name: 't2', sourceRepo: 'https://github.com/org/t2', registryName: 'curated' },
    { id: 'u2', name: 'u2', sourceRepo: 'https://github.com/org/u2', registryName: 'reg-untrusted' },
  ];
  const stars = { u1: 900, u2: 200 };
  const fetchRepoMetaImpl = async (sourceRepo) => ({ stars: stars[sourceRepo.split('/').pop()], archived: false, pushedAtMs: RECENT });
  const { eligible, rejected } = await filterEligibleAdoptCandidates(candidates, { registries, fetchRepoMetaImpl, nowMs: NOW });
  assert.deepEqual(eligible.map((c) => c.id), ['t1', 'u1', 't2']); // input order preserved; both trusted + the top untrusted
  assert.deepEqual(rejected.map((r) => r.candidate.id), ['u2']);
  assert.deepEqual(rejected[0].reasons, ['outside-top-stars-percentile']);
});
