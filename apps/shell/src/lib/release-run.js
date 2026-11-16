// apps/shell/src/lib/release-run.js
//
// The release the merge queue asks for after each merged PR (cards
// glmps-2-0-209, glmps-2-0-216; spec docs/specs/glmps-2-0-216-release-in-shell.md).
// The kernel may not push, so it sends values only (checkout, repo, base, PR
// number, card id, bump kind, gate summary) and this module does the rest: it
// reads the version from origin/<base>, the PR title from GitHub, writes both
// package.json files and CHANGELOG.md in a worktree of its own, pushes the
// version commit (never forced), tags it and creates the GitHub Release. Every
// process goes through the injected `run(file, args, { cwd })`, which resolves
// { status, stdout, stderr }. Never throws.
import fs from 'node:fs';
import path from 'node:path';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_ATTEMPTS = 3;
const PACKAGE_NAME = 'glmps';
const VERSION_FILES = ['package.json', path.join('apps', 'shell', 'package.json')];
const CHANGELOG = 'CHANGELOG.md';
const HEADER = '# Changelog';
let worktreeSeq = 0;

export function nextVersion(current, kind) {
  const m = SEMVER.exec(String(current ?? ''));
  if (!m) throw new Error(`not a x.y.z version: ${String(current)}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A PR title names its card at the end ("... (card glmps-2-0-214)"); the entry adds the id itself.
export function changelogTitle(prTitle, cardId) {
  const t = oneLine(prTitle);
  const id = oneLine(cardId);
  return id ? t.replace(new RegExp(`\\s*\\((?:card\\s+)?${escapeRe(id)}\\)$`, 'i'), '').trim() : t;
}

// CHANGELOG.md ships to the public mirror: version, date, PR title and card id only.
export function changelogEntry({ version, date, cardId, title }) {
  const id = oneLine(cardId);
  const t = oneLine(title);
  const line = t ? `${t}${id ? ` (${id})` : ''}` : id;
  return `## v${version} (${date})\n\n- ${line}\n`;
}

// The GitHub Release on the private repo keeps the PR link and the gate summary.
export function releaseNotes({ version, date, cardId, title, summary, prUrl }) {
  const refs = [oneLine(cardId), prUrl ? `[PR](${oneLine(prUrl)})` : ''].filter(Boolean).join(', ');
  const why = oneLine(summary);
  return `## v${version} (${date})\n\n- ${oneLine(title)}${refs ? ` (${refs})` : ''}${why ? `: ${why}` : ''}\n`;
}

export function prependChangelog(existing, entry) {
  const body = String(existing ?? '').replace(/^# Changelog[ \t]*\r?\n+/, '').replace(/^\s+/, '');
  return `${HEADER}\n\n${entry}${body ? `\n${body}` : ''}`;
}

const text = (r) => String(r?.stderr || r?.stdout || `exit ${r?.status}`).trim().slice(0, 300);

// Copy of fetchOrigin's retry in server/lib/orchestration/main-suite.js (the shell
// must not import server code): a queue merge starts the main-suite loop, the
// batch reviewer and this release at once, all fetching the same clone, so a
// ref-lock collision is retried and any other failure returns at once.
const FETCH_ATTEMPTS = 3;
const REF_LOCK_RE = /cannot lock ref|\.lock'?: File exists|some local refs could not be updated/i;
const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function fetchWithRetry(git, cwd, args, sleep) {
  let r;
  for (let i = 1; i <= FETCH_ATTEMPTS; i++) {
    r = await git(cwd, args);
    if (r.status === 0 || i === FETCH_ATTEMPTS || !REF_LOCK_RE.test(String(r.stderr ?? ''))) return r;
    await sleep(500 * i + Math.floor(Math.random() * 250));
  }
  return r;
}

function setVersion(src, version) {
  const re = /("version"\s*:\s*")[^"]*(")/;
  if (!re.test(src)) throw new Error('no "version" field');
  return src.replace(re, `$1${version}$2`);
}

// The owner/repo an origin URL names (https or ssh GitHub forms), lower case, or null.
export function originRepo(url) {
  const m = /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

// The kernel names the repo and base; the shell checks both against the
// checkout's own origin, so a record can only release origin's default branch
// of the repo it was cloned from (card glmps-2-0-223).
async function checkOrigin(git, repoPath, repo, base) {
  const url = await git(repoPath, ['remote', 'get-url', 'origin']);
  if (url.status !== 0) throw new Error(`git remote get-url failed: ${text(url)}`);
  const named = originRepo(url.stdout);
  if (named !== String(repo).toLowerCase()) throw new Error(`release repo ${repo} is not this checkout's origin (${named ?? 'not a GitHub URL'})`);
  const head = await git(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
  if (head.status !== 0) throw new Error(`git ls-remote --symref failed: ${text(head)}`);
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(String(head.stdout ?? ''));
  if (!m) throw new Error('origin does not name a default branch');
  if (m[1] !== base) throw new Error(`release base ${base} is not origin's default branch (${m[1]})`);
}

// Tag and push one tag. A stale local copy (an earlier failed push) is replaced,
// and a failed push deletes the local tag, so the clone never holds a tag origin lacks.
async function pushTag(git, cwd, tag, message, target = []) {
  await git(cwd, ['tag', '-d', tag]);
  const made = await git(cwd, ['tag', '-a', tag, '-m', message, ...target]);
  if (made.status !== 0) throw new Error(`git tag -a failed: ${text(made)}`);
  const pushed = await git(cwd, ['push', 'origin', tag]);
  if (pushed.status !== 0) {
    await git(cwd, ['tag', '-d', tag], { cleanup: true });
    throw new Error(`git push origin ${tag} failed: ${text(pushed)}`);
  }
}

async function readPrTitle(run, repo, number) {
  try {
    const r = await run('gh', ['pr', 'view', String(number), '-R', repo, '--json', 'title'], {});
    if (r?.status !== 0) return '';
    const t = JSON.parse(String(r.stdout ?? '')).title;
    return typeof t === 'string' ? t : '';
  } catch { return ''; }
}

/**
 * Release one merged PR. `recipe` is the allowlist-checked record
 * { cwd, repo, base, number, cardId, bump, summary }. Resolves
 * { ok: true, version, sha }, { ok: true, skipped: true, reason }, or { ok: false, reason }.
 */
export async function runRelease(recipe, { run, worktreesDir, now = () => new Date(), packageName = PACKAGE_NAME, sleep = realSleep }) {
  const { cwd: repoPath, repo, base, number, cardId, bump, summary } = recipe ?? {};
  // `cleanup` marks a step that only undoes local state; the runner lets it run
  // after the release deadline, so a late release still removes its worktree.
  const git = async (cwd, args, o = {}) => (await run('git', args, { cwd, ...o })) ?? { status: 1, stderr: 'git returned nothing' };
  const mustIn = async (cwd, args) => {
    const r = await git(cwd, args);
    if (r.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${text(r)}`);
    return r;
  };
  let lastReject = '';
  try {
    if (typeof worktreesDir !== 'string' || !worktreesDir) return { ok: false, reason: 'the desktop app has no worktrees dir to release in' };
    const prUrl = `https://github.com/${repo}/pull/${number}`;
    let title = null;
    await checkOrigin(git, repoPath, repo, base);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const fetchArgs = ['fetch', '-q', '--tags', 'origin'];
      const fetched = await fetchWithRetry(git, repoPath, fetchArgs, sleep);
      if (fetched.status !== 0) throw new Error(`git fetch -q failed: ${text(fetched)}`);
      const wt = path.join(worktreesDir, 'merge-queue', `release-${process.pid}-${Date.now()}-${(worktreeSeq += 1)}`);
      await mustIn(repoPath, ['worktree', 'add', '--detach', wt, `origin/${base}`]);
      try {
        const must = (args) => mustIn(wt, args);
        const abs = (f) => path.join(wt, f);
        if (!fs.existsSync(abs('package.json'))) return { ok: true, skipped: true, reason: 'no package.json in the checkout' };
        const pkg = JSON.parse(fs.readFileSync(abs('package.json'), 'utf8'));
        if (pkg.name !== packageName) return { ok: true, skipped: true, reason: `package name ${pkg.name} is not ${packageName}` };
        const next = nextVersion(pkg.version, bump === 'minor' ? 'minor' : 'patch');
        title ??= changelogTitle(await readPrTitle(run, repo, number), cardId);

        if (attempt === 1) {
          // Origin's tags, not the clone's: a local tag left by a failed push must not count.
          const tags = await must(['ls-remote', '--tags', 'origin', 'refs/tags/v*']);
          if (!String(tags.stdout).trim()) {
            // The baseline is the commit that started the changelog, not whatever merged since.
            const added = await git(wt, ['log', '--format=%H', '--diff-filter=A', `origin/${base}`, '--', CHANGELOG]);
            const shas = added.status === 0 ? String(added.stdout).split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[0-9a-f]{40}$/i.test(s)) : [];
            await pushTag(git, wt, `v${pkg.version}`, `GLMPS v${pkg.version} (baseline)`, shas.length ? [shas.at(-1)] : []);
          }
        }

        for (const f of VERSION_FILES) {
          if (!fs.existsSync(abs(f))) continue;
          fs.writeFileSync(abs(f), setVersion(fs.readFileSync(abs(f), 'utf8'), next));
        }
        const date = now().toISOString().slice(0, 10);
        const fields = { version: next, date, cardId, title, summary, prUrl };
        const prior = fs.existsSync(abs(CHANGELOG)) ? fs.readFileSync(abs(CHANGELOG), 'utf8') : '';
        fs.writeFileSync(abs(CHANGELOG), prependChangelog(prior, changelogEntry(fields)));

        await must(['add', '--', ...VERSION_FILES.filter((f) => fs.existsSync(abs(f))), CHANGELOG]);
        await must(['commit', '-q', '-m', `Release v${next} (${cardId})`]);
        const pushed = await git(wt, ['push', 'origin', `HEAD:${base}`]);
        if (pushed.status !== 0) {
          lastReject = text(pushed);
          if (/rejected|non-fast-forward|fetch first|failed to push/i.test(lastReject) && attempt < MAX_ATTEMPTS) continue;
          return { ok: false, reason: `push to ${base} rejected after ${attempt} attempt(s): ${lastReject}` };
        }

        const sha = String((await must(['rev-parse', 'HEAD'])).stdout).trim();
        await pushTag(git, wt, `v${next}`, `GLMPS v${next}`);
        const rel = (await run('gh', ['release', 'create', `v${next}`, '-R', repo, '--target', sha, '--title', `GLMPS v${next}`, '--notes', releaseNotes(fields)], {})) ?? { status: 1, stderr: 'gh returned nothing' };
        if (rel.status !== 0) return { ok: false, reason: `gh release create failed: ${text(rel)}` };
        return { ok: true, version: next, sha };
      } finally {
        try { await git(repoPath, ['worktree', 'remove', '--force', wt], { cleanup: true }); } catch { /* best effort */ }
        try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    return { ok: false, reason: `push to ${base} rejected after ${MAX_ATTEMPTS} attempts: ${lastReject}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 300) };
  }
}
