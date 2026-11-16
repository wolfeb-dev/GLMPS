// server/lib/observability/open-prs.js
// Every pull request still open on the signed-in GitHub account's repos, for
// the Surface Open PRs layer (card glmps-2-0-113,
// docs/specs/2026-10-27-surface-open-prs.md). The merge queue only knows PRs a
// card filed; this is all of them, each marked with the queue stage when a
// card did file it.

export const OPEN_PRS_TTL_MS = 2 * 60_000;
export const OPEN_PRS_LIMIT = 100;

export const openPrsGhArgs = {
  login: () => ['api', 'user', '--jq', '.login'],
  search: (owner) => ['search', 'prs', '--owner', owner, '--state', 'open', '--limit', String(OPEN_PRS_LIMIT),
    '--json', 'number,title,url,repository,author,isDraft,createdAt,updatedAt'],
};

const str = (v) => (typeof v === 'string' ? v : '');
const prKey = (url) => str(url).trim().toLowerCase();

// Fail closed per row: a row without a GitHub PR url is dropped, not guessed.
export function parseOpenPrs(stdout) {
  let j;
  try { j = JSON.parse(String(stdout ?? '')); } catch { return null; }
  if (!Array.isArray(j)) return null;
  return j.filter((p) => p && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(str(p.url))).map((p) => ({
    repo: str(p.repository?.nameWithOwner) || str(p.repository?.name),
    number: Number(p.number),
    title: str(p.title),
    url: p.url,
    author: str(p.author?.login) || null,
    draft: p.isDraft === true,
    createdAt: str(p.createdAt) || null,
    updatedAt: str(p.updatedAt) || null,
  }));
}

// glmps-2-0-191: the open set as a prUrl -> state map (the backlog-store check
// takes a map so it can learn other states). A failed lookup is an empty map:
// no PR is known open, so nothing is flagged.
export function openPrStates(result) {
  const m = new Map();
  if (result?.ok && Array.isArray(result.prs)) for (const p of result.prs) if (p?.url) m.set(prKey(p.url), 'OPEN');
  return m;
}

// Marks each PR with the card that filed it to the merge queue, if any.
export function annotateWithQueue(prs, items = []) {
  const byUrl = new Map();
  for (const i of items) {
    const mr = i?.mergeRequest;
    if (mr?.prUrl) byUrl.set(prKey(mr.prUrl), { cardId: i.id, stage: mr.stage ?? null });
  }
  return prs.map((p) => ({ ...p, queue: byUrl.get(prKey(p.url)) ?? null }));
}

// Newest update first: the live agent work leads, long-abandoned PRs sink.
export function sortOpenPrs(prs) {
  return [...prs].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.repo.localeCompare(b.repo) || a.number - b.number);
}

// One gh round trip per TTL, shared by concurrent callers. A failure is
// returned (not thrown) and not cached, so the next request retries.
export function createOpenPrsSource({ gh, now = Date.now, ttlMs = OPEN_PRS_TTL_MS }) {
  let cached = null; let inFlight = null; let owner = null;
  async function fetchOnce() {
    if (!owner) {
      const r = await gh('gh', openPrsGhArgs.login());
      if (r?.status !== 0) return { ok: false, error: `gh login lookup failed: ${String(r?.stderr || '').trim().slice(0, 200)}` };
      owner = String(r.stdout).trim();
      if (!owner) return { ok: false, error: 'gh returned no login' };
    }
    const r = await gh('gh', openPrsGhArgs.search(owner));
    if (r?.status !== 0) return { ok: false, error: `gh search prs failed: ${String(r?.stderr || '').trim().slice(0, 200)}` };
    const prs = parseOpenPrs(r.stdout);
    if (!prs) return { ok: false, error: 'gh search prs returned unreadable output' };
    return { ok: true, owner, prs, fetchedAt: now(), truncated: prs.length >= OPEN_PRS_LIMIT };
  }
  return {
    async get() {
      if (cached && now() - cached.fetchedAt < ttlMs) return cached;
      if (!inFlight) {
        inFlight = fetchOnce().catch((e) => ({ ok: false, error: e?.message ?? 'gh failed' })).finally(() => { inFlight = null; });
      }
      const out = await inFlight;
      if (out.ok) cached = out;
      return out;
    },
  };
}
