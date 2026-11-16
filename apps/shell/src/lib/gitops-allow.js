// apps/shell/src/lib/gitops-allow.js
// The allowlist for the git, gh and test operations the service kernel queues
// for the merge queue. The kernel runs without the operator's GitHub sign-in,
// so these run here, in the operator's own session. That makes this file the
// security boundary: a compromised or buggy kernel must not be able to turn a
// 'gitops' record into a push, a force, an admin merge or an arbitrary command.
// Pure: no process is started here; it returns the recipe the runner executes.
//
// Everything is matched by exact shape, not by a deny list. A flag that is not
// listed for its subcommand is refused, and every free token must match a
// narrow character class (no spaces, quotes, ';', '|', '&', '<', '>', '$').
import { fallbackChainFor } from './model-fallback.js';

const PUBLIC_REPOS = new Set(['wolfeb-dev/glmps']);
// The fallback alias comes from the fixed table, never from the record (card glmps-2-0-164).
const claudeFallback = (model) => { const c = fallbackChainFor('claude', model ?? null); return c.length ? ['--fallback-model', c.join(',')] : []; };
const SAFE = /^[A-Za-z0-9._/@^~{}:+,=-]+$/;
const SAFE_REF = /^[A-Za-z0-9._/@^~{}-]+$/;
const MSG = /^[\x20-\x7e]{1,200}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/i;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = { git: 120000, gh: 60000, test: 30 * 60 * 1000, review: 60 * 60 * 1000 };

const no = (reason) => ({ ok: false, reason });

export function normPath(p) {
  const parts = [];
  for (const seg of String(p ?? '').replace(/\\/g, '/').toLowerCase().split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

const isAbs = (p) => /^[A-Za-z]:[\\/]/.test(String(p)) || /^[\\/]/.test(String(p));

// The real path of p, for comparing a record's paths with the shell's roots by
// where they land rather than how they are spelled: after the cutover the old
// state folder is a junction to the new one, and cards recorded before it
// carry the old spelling. A path that does not exist yet (a worktree about to
// be added) resolves its deepest existing ancestor and keeps the rest. A path
// with a '..' segment or that is not absolute is returned as given, so the
// checks that refuse those still see it. So is a UNC or device path
// (\\server\share, \\?\C:\...): its root would resolve to the current drive's,
// making a network path pass as a local one. With no resolver it is the identity.
export function canonicalPath(p, realpath) {
  if (typeof realpath !== 'function' || typeof p !== 'string' || !isAbs(p) || /^[\\/]{2}/.test(p)) return p;
  const segs = p.split(/[\\/]+/);
  if (segs.includes('..')) return p;
  const sep = /^[A-Za-z]:/.test(p) || p.includes('\\') ? '\\' : '/';
  const rest = [];
  for (let n = segs.length; n > 0; n--) {
    const head = segs.slice(0, n).join(sep);
    let real = null;
    try { real = realpath(head === '' || /^[A-Za-z]:$/.test(head) ? `${head}${sep}` : head); } catch { real = null; }
    if (typeof real === 'string' && real) {
      const tail = rest.filter((x) => x !== '' && x !== '.');
      return tail.length ? [real.replace(/[\\/]+$/, ''), ...tail].join(sep) : real;
    }
    rest.unshift(segs[n - 1]);
  }
  return p;
}

// A UNC or device path (\\server\share, \\.\C:\, //x) is never inside a root:
// normPath drops the leading separators, so it could otherwise compare equal
// to a local root while canonicalPath leaves it unresolved (card glmps-2-0-155).
const DOUBLE_ROOT = /^[\\/]{2}/;

export function insideRoot(p, root) {
  if (typeof p !== 'string' || typeof root !== 'string' || !p || !root || !isAbs(p) || !isAbs(root)) return false;
  if (DOUBLE_ROOT.test(p) || DOUBLE_ROOT.test(root)) return false;
  const n = normPath(p);
  const r = normPath(root);
  if (!r) return false;
  return n === r || n.startsWith(`${r}/`);
}

function strictlyInside(p, root) {
  return insideRoot(p, root) && normPath(p) !== normPath(root);
}

function allRoots(roots) {
  const list = [...(Array.isArray(roots?.repos) ? roots.repos : []), roots?.worktrees];
  return list.filter((r) => typeof r === 'string' && r && isAbs(r));
}
const canonOf = (roots) => roots?.canon ?? ((p) => p);
const inAnyRoot = (p, roots) => allRoots(roots).some((r) => insideRoot(canonOf(roots)(p), r));

const FLAGS = {
  fetch: new Set(['-q', '--quiet', '--prune', '--no-tags']),
  merge: new Set(['--abort', '--no-ff', '--no-edit', '-q', '--quiet']),
  'rev-parse': new Set(['--abbrev-ref', '--symbolic-full-name', '--short', '--verify', '-q', '--quiet', '--show-toplevel', '--is-inside-work-tree']),
  diff: new Set(['--name-only', '--name-status', '--stat', '--numstat', '--shortstat', '--no-color', '--quiet', '--exit-code', '--no-renames', '--']),
  status: new Set(['--porcelain', '--porcelain=v1', '-s', '--short', '-b', '--branch', '-uno', '--untracked-files=no']),
  log: new Set(['--oneline', '--no-color', '--name-only', '--stat', '--no-merges', '--first-parent']),
  show: new Set(['--oneline', '--no-color', '--name-only', '--stat', '--name-status']),
};
const FLAG_PATTERNS = {
  diff: [/^--diff-filter=[ACDMRTUXB]+$/, /^-U\d{1,4}$/],
  log: [/^-n\d{1,5}$/, /^--max-count=\d{1,5}$/, /^--(pretty|format)=[A-Za-z0-9%:,._ -]*$/],
  show: [/^--(pretty|format)=[A-Za-z0-9%:,._ -]*$/],
};

// Generic walk: listed flags and patterns pass, everything else must be a safe
// positional. `positional` validates each free token (index, token).
function walkArgs(sub, rest, positional) {
  const flags = FLAGS[sub] ?? new Set();
  const patterns = FLAG_PATTERNS[sub] ?? [];
  let seen = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (flags.has(t) || patterns.some((re) => re.test(t))) continue;
    if (sub === 'log' && t === '-n') {
      if (!/^\d{1,5}$/.test(rest[i + 1] ?? '')) return no('git log -n needs a number');
      i++; continue;
    }
    if (sub === 'merge' && t === '-m') {
      const m = rest[i + 1];
      if (typeof m !== 'string' || m.startsWith('-') || !MSG.test(m)) return no('git merge -m needs a plain one-line message');
      i++; continue;
    }
    if (t.startsWith('-')) return no(`git ${sub}: flag is not allowed: ${t}`);
    const bad = positional(seen++, t);
    if (bad) return no(bad);
  }
  return { ok: true };
}

// The server's own mirror clones of client repos (card glmps-2-0-runtime-40). The host is fixed here, so
// kernel config cannot widen what this shell will clone from; the destination must be a new .git
// directory strictly inside a root the kernel named.
const CLONE_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git$/;
const DOTS = new Set(['.', '..']);

function validateClone(rest, roots) {
  if (rest.length !== 4 || rest[0] !== '--mirror' || rest[1] !== '-q') return no('git clone may only be: --mirror -q <url> <dest>');
  const m = CLONE_URL.exec(rest[2]);
  if (!m || DOTS.has(m[1]) || DOTS.has(m[2])) return no('git clone url must be https://github.com/<owner>/<repo>.git');
  const dest = rest[3];
  if (typeof dest !== 'string' || !isAbs(dest) || !/^[ -~]+$/.test(dest) || dest.replace(/\\/g, '/').split('/').includes('..')) return no('git clone destination must be a plain absolute path');
  if (!/\.git$/.test(dest)) return no('git clone destination must end in .git');
  if (!allRoots(roots).some((r) => strictlyInside(canonOf(roots)(dest), r))) return no(`git clone destination is outside the allowed roots: ${dest}`);
  return { ok: true };
}

function validateGit(op, roots) {
  const args = op.args;
  if (typeof op.cwd !== 'string' || !op.cwd) return no('git needs a cwd');
  if (!inAnyRoot(op.cwd, roots)) return no(`cwd is outside the allowed roots: ${op.cwd}`);
  let i = 0;
  for (;;) {
    if (args[i] === '-C') {
      if (!inAnyRoot(args[i + 1], roots)) return no(`-C directory is outside the allowed roots: ${args[i + 1]}`);
      i += 2;
    } else if (args[i] === '-c') {
      const s = args[i + 1];
      const okSetting = typeof s === 'string' && (/^user\.name=[A-Za-z0-9._@ -]{1,60}$/.test(s) || /^user\.email=[A-Za-z0-9._@+-]{1,80}$/.test(s) || s === 'commit.gpgsign=false');
      if (!okSetting) return no(`git -c setting is not allowed: ${s}`);
      i += 2;
    } else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);

  if (sub === 'fetch') {
    return walkArgs('fetch', rest, (n, t) => (n === 0 ? (t === 'origin' ? null : 'git fetch may only fetch origin') : (SAFE_REF.test(t) ? null : `git fetch refspec is not allowed: ${t}`)));
  }
  if (sub === 'clone') return validateClone(rest, roots);
  if (sub === 'merge') {
    const abort = rest.includes('--abort');
    if (abort) return rest.every((t) => t === '--abort' || t === '-q') ? { ok: true } : no('git merge --abort takes no other arguments');
    return walkArgs('merge', rest, (n, t) => (SAFE_REF.test(t) ? null : `git merge target is not allowed: ${t}`));
  }
  if (sub === 'rev-parse' || sub === 'show') {
    return walkArgs(sub, rest, (n, t) => (SAFE.test(t) ? null : `git ${sub} argument is not allowed: ${t}`));
  }
  if (sub === 'diff' || sub === 'log') {
    return walkArgs(sub, rest, (n, t) => (SAFE.test(t) ? null : `git ${sub} argument is not allowed: ${t}`));
  }
  if (sub === 'status') return walkArgs('status', rest, (n, t) => `git status takes no positional: ${t}`);
  if (sub === 'remote') {
    return rest.length === 2 && rest[0] === 'get-url' && rest[1] === 'origin' ? { ok: true } : no('git remote may only be: get-url origin');
  }
  if (sub === 'config') {
    return rest.length === 2 && rest[0] === '--get' && /^[A-Za-z0-9.-]+$/.test(rest[1]) ? { ok: true } : no('git config may only be: --get <key>');
  }
  if (sub === 'worktree') {
    const wt = roots?.worktrees;
    const action = rest[0];
    const underWt = (p) => (typeof wt === 'string' && wt && strictlyInside(canonOf(roots)(p), wt) ? null : `worktree directory is outside the worktrees root: ${p}`);
    if (action === 'prune') return rest.length === 1 ? { ok: true } : no('git worktree prune takes no arguments');
    if (action === 'add') {
      const r = rest.slice(1).filter((t) => t !== '--detach');
      if (r.length < 1 || r.length > 2) return no('git worktree add needs <dir> [<commit>]');
      const bad = underWt(r[0]) ?? (r[1] === undefined || SAFE_REF.test(r[1]) ? null : `worktree start point is not allowed: ${r[1]}`);
      return bad ? no(bad) : { ok: true };
    }
    if (action === 'remove') {
      const r = rest.slice(1).filter((t) => t !== '--force' && t !== '-f');
      if (r.length !== 1) return no('git worktree remove needs <dir>');
      const bad = underWt(r[0]);
      return bad ? no(bad) : { ok: true };
    }
    return no(`git worktree ${action} is not allowed`);
  }
  return no(`git ${sub} is not allowed`);
}

// Read-only GETs for the kernel's Actions minutes tracker
// (server/lib/observability/actions-minutes.js ghArgs): no -X, -f or -F, so gh
// sends GET, and the jq filters are fixed strings. Change both files together.
// Reads only, so the public-repo rule that keeps merge-queue writes out of
// wolfeb-dev/glmps does not apply.
const ACTIONS_JQ = {
  repos: '.[] | select(.private) | .full_name',
  runs: '.workflow_runs[] | {id, created_at, status, event, conclusion, name, head_branch}',
  runsLegacy: '.workflow_runs[] | {id, created_at, status}',
  jobs: '.jobs[] | {labels, started_at, completed_at, steps: (.steps | length)}',
};

function validateGhApi(args) {
  if (args.length !== 5 || args[1] !== '--paginate' || args[3] !== '--jq') return no('gh api may only be: --paginate <path> --jq <filter>');
  const p = args[2];
  if (p === 'user/repos?per_page=100&affiliation=owner') return args[4] === ACTIONS_JQ.repos ? { ok: true } : no('gh api user/repos: unexpected --jq filter');
  if (/^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\?per_page=100&created=%3E%3D\d{4}-\d{2}-01$/.test(p)) {
    return args[4] === ACTIONS_JQ.runs || args[4] === ACTIONS_JQ.runsLegacy ? { ok: true } : no('gh api actions runs: unexpected --jq filter');
  }
  if (/^repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/actions\/runs\/\d{1,15}\/jobs\?per_page=100&filter=all$/.test(p)) {
    return args[4] === ACTIONS_JQ.jobs ? { ok: true } : no('gh api actions jobs: unexpected --jq filter');
  }
  return no('gh api path is not allowed');
}

// Read-only reads for the kernel's QA-trends CI sampler
// (server/lib/observability/qa-trends-store.js qaGhArgs), in exact shapes.
// Change both files together. Reads only, like the gh api rules above.
const QA_RUN_FIELDS = 'databaseId,conclusion,status,headSha,createdAt';
const ID = /^\d{1,15}$/;

function validateGhRead(args) {
  const same = (shape) => args.length === shape.length && shape.every((s, i) => (typeof s === 'string' ? args[i] === s : s.test(args[i] ?? '')));
  const shapes = {
    'run list': ['run', 'list', '-R', REPO, '--workflow=ci.yml', '-L', /^(?:[1-9]|[1-4]\d|50)$/, '--json', QA_RUN_FIELDS],
    'run view': ['run', 'view', ID, '-R', REPO, '--json', 'jobs'],
    'run view --job': ['run', 'view', '--job', ID, '-R', REPO, '--log'],
    'issue list': ['issue', 'list', '-R', REPO, '--state', 'open', '--json', 'number'],
  };
  if (!args.includes('-R')) return no('gh needs -R <owner/repo>');
  return Object.values(shapes).some(same) ? { ok: true } : no(`gh ${args[0]} ${args[1] ?? ''} may only take the QA-trends sampler's exact shape`);
}

function validateGh(args) {
  if (args[0] === 'api') return validateGhApi(args);
  if ((args[0] === 'run' && (args[1] === 'list' || args[1] === 'view')) || (args[0] === 'issue' && args[1] === 'list')) return validateGhRead(args);
  if (args[0] !== 'pr' || (args[1] !== 'view' && args[1] !== 'merge')) return no(`gh ${args[0]} ${args[1] ?? ''} is not allowed`.trim());
  if (!/^\d{1,9}$/.test(args[2] ?? '')) return no('gh pr number must be digits');
  if (args[3] !== '-R' || !REPO.test(args[4] ?? '')) return no('gh needs -R <owner/repo>');
  if (PUBLIC_REPOS.has(args[4].toLowerCase())) return no(`${args[4]} is a public repo; the merge queue does not handle it`);
  if (args[1] === 'view') {
    return args.length === 7 && args[5] === '--json' && /^[A-Za-z]+(,[A-Za-z]+)*$/.test(args[6]) ? { ok: true } : no('gh pr view may only be: <n> -R <repo> --json <fields>');
  }
  if (args.length < 8 || args[5] !== '--merge' || args[6] !== '--match-head-commit') return no('gh pr merge needs --merge --match-head-commit <sha> and nothing else');
  if (args.length !== 8) return no('gh pr merge takes no other flags (no --admin, no --auto)');
  return SHA.test(args[7]) ? { ok: true } : no('gh pr merge head pin must be a 40-character sha');
}

const TEST_TOKEN = /^[A-Za-z0-9_.=:@*/-]+$/;
const NODE_CODE_FLAGS = /^(--import|--require|-r|--eval|-e|-p|--print|--loader|--experimental-loader)\b/;
function validTestCommand(command) {
  if (typeof command !== 'string' || !command) return false;
  // The merge queue's fallback for a repo with no test script: exactly these two, no args.
  if (command === 'npm run build' || command === 'npm run lint') return true;
  const m = /^(?:(?:npm|pnpm|yarn)(?: run)? test|node --test)((?: \S+)*)$/.exec(command);
  if (!m) return false;
  const tokens = m[1].split(' ').filter(Boolean);
  return tokens.every((t) => TEST_TOKEN.test(t) && !t.startsWith('/') && !t.includes('..') && !NODE_CODE_FLAGS.test(t));
}

function validateTest(op, roots) {
  if (!validTestCommand(op.command)) return no(`test command is not an allowed package test command: ${String(op.command).slice(0, 80)}`);
  const wt = roots?.worktrees;
  const canon = canonOf(roots);
  const base = typeof wt === 'string' && wt ? canon(`${wt}\\merge-queue`) : '';
  if (!base || typeof op.cwd !== 'string' || !strictlyInside(canon(op.cwd), base)) return no('test cwd must be inside the merge-queue worktrees directory');
  return { ok: true };
}

// The headless reviewer (`claude -p` in a review worktree). The argv is fixed
// here; the record contributes only a model alias and three paths, each pinned
// to a directory this shell knows on its own (the worktrees root from the
// kernel's roots, the state dir from its own resolution).
const MODEL = /^[A-Za-z][A-Za-z0-9._[\]-]{0,39}$/;
const REVIEW_DIR = /-(?:review|repair)-r\d{1,3}$/i;
const REVIEWER_SETTINGS = /^reviewer-[A-Za-z0-9_.-]+\.json$/i;
const PROMPT_FILE = /^[A-Za-z0-9_.-]+\.prompt\.md$/i;

function directChild(p, dir, pattern) {
  if (typeof p !== 'string' || !isAbs(p)) return false;
  const n = normPath(p);
  const d = `${normPath(dir)}/`;
  if (!n.startsWith(d)) return false;
  const name = n.slice(d.length);
  return !name.includes('/') && pattern.test(name);
}

function validateReview(op, roots, stateDir) {
  if (typeof stateDir !== 'string' || !stateDir || !isAbs(stateDir)) return no('review needs the shell state dir, which is not resolved');
  const wt = roots?.worktrees;
  const canon = canonOf(roots);
  const state = canon(stateDir);
  if (typeof op.cwd !== 'string' || !(typeof wt === 'string' && wt && strictlyInside(canon(op.cwd), wt))) return no(`review cwd must be inside the worktrees root: ${String(op.cwd).slice(0, 120)}`);
  if (!REVIEW_DIR.test(normPath(op.cwd))) return no('review cwd must be a review or repair worktree directory');
  if (!directChild(canon(op.settings), `${state}/role-settings`, REVIEWER_SETTINGS)) return no('review settings must be a reviewer-*.json file in <stateDir>/role-settings');
  if (!directChild(canon(op.promptFile), `${state}/runner`, PROMPT_FILE)) return no('review prompt must be a *.prompt.md file in <stateDir>/runner');
  if (typeof op.model !== 'string' || !MODEL.test(op.model)) return no('review model must be a short alias');
  return { ok: true };
}

// A secondary card run headless (`claude -p`) in its own runner worktree
// (<worktrees>/<project>/<card>), under worker settings and a session id the
// kernel records so a Slack reply can resume it. Same pinning as the reviewer.
const WORKER_SETTINGS = /^worker-[A-Za-z0-9_.-]+\.json$/i;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const CARD_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function validateCard(op, roots, stateDir, { vendor = false } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || !isAbs(stateDir)) return no('card needs the shell state dir, which is not resolved');
  const wt = roots?.worktrees;
  const canon = canonOf(roots);
  const state = canon(stateDir);
  const cwd = canon(op.cwd);
  if (typeof op.cwd !== 'string' || !(typeof wt === 'string' && wt && strictlyInside(cwd, wt))) return no(`card cwd must be inside the worktrees root: ${String(op.cwd).slice(0, 120)}`);
  const rel = normPath(cwd).slice(normPath(wt).length + 1).split('/');
  if (rel.length !== 2 || rel[0] === 'merge-queue' || REVIEW_DIR.test(rel[1])) return no('card cwd must be a card worktree directory (<worktrees>/<project>/<card>)');
  if (!vendor && !directChild(canon(op.settings), `${state}/role-settings`, WORKER_SETTINGS)) return no('card settings must be a worker-*.json file in <stateDir>/role-settings');
  if (!directChild(canon(op.promptFile), `${state}/runner`, PROMPT_FILE)) return no('card prompt must be a *.prompt.md file in <stateDir>/runner');
  if (vendor) return { ok: true };
  if (typeof op.sessionId !== 'string' || !SESSION_UUID.test(op.sessionId)) return no('card session id must be a UUID');
  if (typeof op.resume !== 'boolean') return no('card resume must be true or false');
  if (op.model != null && (typeof op.model !== 'string' || !MODEL.test(op.model))) return no('card model must be a short alias');
  return { ok: true };
}

// A card run by a non-Claude vendor CLI (agy, codex, grok) in its card worktree.
// The record carries values only; the argv, the fence and the commit/push/PR
// sequence are fixed in vendor-card.js. The vendor model may be an agy display
// name, so spaces and parentheses are allowed here (and nowhere else).
const VENDORS = new Set(['gemini', 'gpt', 'grok']);
const VENDOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CARD_ID = /^[a-z0-9][a-z0-9-]{1,80}$/;
const AGENT_TEXT_MAX = 4000;
const TITLE = /^[\x20-\x7e]{1,200}$/;

function validateVendorCard(op, roots, stateDir) {
  const r = validateCard({ ...op, settings: null, sessionId: null, resume: null }, roots, stateDir, { vendor: true });
  if (!r.ok) return r;
  if (typeof op.vendor !== 'string' || !VENDORS.has(op.vendor)) return no('vendor-card vendor must be gemini, gpt or grok');
  if (op.model != null && (typeof op.model !== 'string' || !VENDOR_MODEL.test(op.model))) return no('vendor-card model must be a short safe name');
  const ref = (v) => typeof v === 'string' && GIT_REF.test(v) && !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock');
  if (!ref(op.branch)) return no('vendor-card branch must be a safe git ref');
  if (!ref(op.base)) return no('vendor-card base must be a safe git ref');
  if (typeof op.cardId !== 'string' || !CARD_ID.test(op.cardId)) return no('vendor-card card id is not a card id');
  if (typeof op.title !== 'string' || !TITLE.test(op.title)) return no('vendor-card title must be 1-200 printable ASCII characters');
  if (op.finishOnly != null && typeof op.finishOnly !== 'boolean') return no('vendor-card finishOnly must be true or false');
  if (op.agentText != null && (typeof op.agentText !== 'string' || op.agentText.length > AGENT_TEXT_MAX)) return no(`vendor-card agentText must be a string of at most ${AGENT_TEXT_MAX} characters`);
  return { ok: true };
}

// The release after a merged PR (card glmps-2-0-216). This is the only kind
// that pushes, and it pushes only what release-run.js computes itself: a
// version commit fast-forwarded onto `base` and its tag, plus a Release on a
// private repo. The record names which checkout, repo, PR and bump; it never
// carries argv, a version or file content. The checkout must be one of the
// record's repos, not a worktree. The summary only reaches the private notes.
const RELEASE_TIMEOUT_MS = 10 * 60 * 1000;
const SUMMARY_MAX = 4000;
const SUMMARY = /^[^\x00-\x09\x0b-\x1f\x7f]*$/;

function validateRelease(op, roots) {
  const canon = canonOf(roots);
  const repos = (Array.isArray(roots?.repos) ? roots.repos : []).filter((r) => typeof r === 'string' && isAbs(r));
  if (typeof op.cwd !== 'string' || !repos.some((r) => insideRoot(canon(op.cwd), r))) return no(`release cwd must be a merge-queue checkout: ${String(op.cwd).slice(0, 120)}`);
  if (typeof op.repo !== 'string' || !REPO.test(op.repo)) return no('release repo must be <owner>/<repo>');
  if (PUBLIC_REPOS.has(op.repo.toLowerCase())) return no(`${op.repo} is a public repo; the merge queue does not release it`);
  if (typeof op.base !== 'string' || !GIT_REF.test(op.base) || op.base.includes('..') || op.base.endsWith('/') || op.base.endsWith('.lock')) return no('release base must be a safe git ref');
  if (!Number.isInteger(op.number) || op.number < 1 || op.number > 999999999) return no('release PR number must be a positive integer');
  if (typeof op.cardId !== 'string' || !CARD_ID.test(op.cardId)) return no('release card id is not a card id');
  if (op.bump !== 'minor' && op.bump !== 'patch') return no('release bump must be minor or patch');
  if (op.summary != null && (typeof op.summary !== 'string' || op.summary.length > SUMMARY_MAX || !SUMMARY.test(op.summary))) return no(`release summary must be plain text of at most ${SUMMARY_MAX} characters`);
  return { ok: true };
}

// `worktreesDir` is the shell's own worktrees root. The record's roots.worktrees
// is ignored: only the checkouts (`repos`) are taken from the record, since the
// shell has no independent list of them. `realpath` (fs.realpathSync.native in
// the app) makes every root check compare resolved paths; the recipe still
// carries the paths as the record spelled them, which land in the same place.
export function validateGitopsOp(op, { roots: claimed, stateDir, worktreesDir, realpath = null } = {}) {
  if (!op || typeof op !== 'object') return no('no operation');
  const canon = (p) => canonicalPath(p, realpath);
  const roots = { repos: Array.isArray(claimed?.repos) ? claimed.repos.map(canon) : claimed?.repos, worktrees: canon(worktreesDir), canon };
  const { kind } = op;
  if (kind !== 'git' && kind !== 'gh' && kind !== 'test' && kind !== 'review' && kind !== 'card' && kind !== 'vendor-card' && kind !== 'release') return no(`unknown gitops kind: ${String(kind).slice(0, 40)}`);
  if (kind === 'release') {
    const r = validateRelease(op, roots);
    if (!r.ok) return r;
    return {
      ok: true,
      recipe: { kind, cwd: op.cwd, repo: op.repo, base: op.base, number: op.number, cardId: op.cardId, bump: op.bump, summary: op.summary ?? '', timeoutMs: RELEASE_TIMEOUT_MS },
    };
  }
  if (kind === 'vendor-card') {
    const r = validateVendorCard(op, roots, stateDir);
    if (!r.ok) return r;
    const asked = Number(op.timeoutMs);
    const timeoutMs = Number.isFinite(asked) && asked >= 1000 ? Math.min(asked, CARD_MAX_TIMEOUT_MS) : CARD_DEFAULT_TIMEOUT_MS;
    return {
      ok: true,
      recipe: {
        kind, vendor: op.vendor, model: op.model ?? null, cwd: op.cwd, promptFile: op.promptFile,
        branch: op.branch, base: op.base, cardId: op.cardId, title: op.title, timeoutMs,
        finishOnly: op.finishOnly === true, agentText: op.finishOnly === true ? String(op.agentText ?? '') : null,
      },
    };
  }
  if (kind === 'card') {
    const r = validateCard(op, roots, stateDir);
    if (!r.ok) return r;
    const asked = Number(op.timeoutMs);
    const timeoutMs = Number.isFinite(asked) && asked >= 1000 ? Math.min(asked, CARD_MAX_TIMEOUT_MS) : CARD_DEFAULT_TIMEOUT_MS;
    return {
      ok: true,
      recipe: {
        kind, cwd: op.cwd, settings: op.settings, promptFile: op.promptFile, timeoutMs,
        args: ['-p', '--settings', op.settings, '--permission-mode', 'auto', op.resume ? '--resume' : '--session-id', op.sessionId,
          ...(op.model != null ? ['--model', op.model] : []), ...claudeFallback(op.model)],
      },
    };
  }
  if (kind === 'review') {
    const r = validateReview(op, roots, stateDir);
    if (!r.ok) return r;
    const asked = Number(op.timeoutMs);
    const timeoutMs = Number.isFinite(asked) && asked >= 1000 ? Math.min(asked, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS.review;
    return {
      ok: true,
      recipe: {
        kind, cwd: op.cwd, settings: op.settings, promptFile: op.promptFile, timeoutMs,
        args: ['-p', '--model', op.model, '--settings', op.settings, '--permission-mode', 'auto', ...claudeFallback(op.model)],
      },
    };
  }
  if (kind !== 'test' && (!Array.isArray(op.args) || op.args.length === 0 || !op.args.every((a) => typeof a === 'string'))) return no('args must be a non-empty array of strings');
  const v = kind === 'git' ? validateGit(op, roots) : kind === 'gh' ? validateGh(op.args) : validateTest(op, roots);
  if (!v.ok) return v;
  const asked = Number(op.timeoutMs);
  const timeoutMs = Number.isFinite(asked) && asked >= 1000 ? Math.min(asked, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS[kind];
  const recipe = kind === 'test'
    ? { kind, command: op.command, cwd: op.cwd, timeoutMs }
    : { kind, file: kind, args: [...op.args], cwd: kind === 'git' ? op.cwd : null, timeoutMs };
  return { ok: true, recipe };
}
