// server/lib/orchestration/vendor-agents.js
// Which vendor's agent CLI runs a card (card glmps-2-0-162,
// docs/specs/2026-11-06-glmps-2-0-162-multi-model-cards.md). Pure: no fs, no
// process. The desktop app keeps its own copy of the argv rules
// (apps/shell/src/lib/vendor-card.js); this module decides WHO runs a card and
// what the vendor is told, never how the CLI is spawned.
import { classifyTask } from '../evaluation/task-classify.js';

export const DEFAULT_VENDOR = 'claude';

// `enabled` is the shipped default; runner config `vendors.<id>.enabled`
// overrides it once the operator has signed in through the desktop app.
// A null defaultModel lets the CLI side pick its newest model at run time
// (for Gemini, the desktop app reads `agy models`; card glmps-2-0-164).
export const VENDORS = Object.freeze([
  { id: 'claude', label: 'Claude', cli: 'claude', aliases: ['claude', 'anthropic'], instructionFile: 'CLAUDE.md', defaultModel: null, enabled: true },
  { id: 'gemini', label: 'Gemini', cli: 'agy', aliases: ['gemini', 'google', 'agy', 'antigravity'], instructionFile: 'GEMINI.md', defaultModel: null, enabled: true, signIn: 'sign in to Antigravity in the desktop app (run agy once in your own terminal)' },
  { id: 'gpt', label: 'GPT', cli: 'codex', aliases: ['gpt', 'openai', 'codex', 'chatgpt'], instructionFile: 'AGENTS.md', defaultModel: null, enabled: false, signIn: 'run `codex login` in your own terminal (the saved ChatGPT sign-in has expired)' },
  { id: 'grok', label: 'Grok', cli: 'grok', aliases: ['grok', 'xai'], instructionFile: 'AGENTS.md', defaultModel: null, enabled: false, signIn: 'install Grok Build and run `grok login` in your own terminal' },
]);

const BY_ALIAS = new Map(VENDORS.flatMap((v) => v.aliases.map((a) => [a, v])));
const ALIAS_ALT = VENDORS.flatMap((v) => v.aliases).sort((a, b) => b.length - a.length).join('|');
// A directive, not a mention: "use gemini" opens the text or a sentence, so
// "we use codex in the tests" never reroutes a card.
const DIRECTIVE_RE = new RegExp(`(?:^|[\\n.;!?(]\\s*|^\\s*[-*]\\s*)use\\s+(${ALIAS_ALT})\\b`, 'i');
// Same token rule the desktop app enforces on a model name.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,59}$/;

export function vendorById(id) {
  return VENDORS.find((v) => v.id === id) ?? null;
}

/** "use gemini" in a card's text -> 'gemini'; null when the text names none. */
export function parseModelDirective(text) {
  const m = DIRECTIVE_RE.exec(String(text ?? ''));
  return m ? BY_ALIAS.get(m[1].toLowerCase()).id : null;
}

/**
 * Validate a card `model` field value: '', 'gemini', 'gpt', 'gemini:Gemini 4 Argon (High)'.
 * Aliases normalise to the vendor id. Returns { ok, value } or { ok:false, error }.
 */
export function normalizeModelField(raw) {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'model must be a string' };
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  const i = s.indexOf(':');
  const head = (i < 0 ? s : s.slice(0, i)).trim().toLowerCase();
  const model = i < 0 ? null : s.slice(i + 1).trim();
  const v = BY_ALIAS.get(head);
  if (!v) return { ok: false, error: `unknown model "${s.slice(0, 40)}"; known: ${VENDORS.map((x) => x.id).join(', ')} (optionally vendor:model)` };
  if (model != null && model !== '' && !MODEL_RE.test(model)) return { ok: false, error: 'model name may use letters, digits, spaces, dots, dashes and parentheses (max 60)' };
  if (v.id === DEFAULT_VENDOR && !model) return { ok: true, value: null };
  return { ok: true, value: model ? `${v.id}:${model}` : v.id };
}

/** Field wins, then a directive in the title or body, else Claude. */
export function resolveCardModel(card) {
  const field = normalizeModelField(card?.model ?? null);
  const value = field.ok ? field.value : null;
  if (value) {
    const [id, ...rest] = value.split(':');
    return { vendor: id, model: rest.length ? rest.join(':') : null, source: 'field' };
  }
  const fromText = parseModelDirective(`${card?.title ?? ''}\n${card?.prompt ?? ''}`);
  if (fromText && fromText !== DEFAULT_VENDOR) return { vendor: fromText, model: null, source: 'text' };
  return { vendor: DEFAULT_VENDOR, model: null, source: 'default' };
}

export function vendorEnabled(id, cfg = {}) {
  const v = vendorById(id);
  if (!v) return false;
  const o = cfg?.vendors?.[id]?.enabled;
  return typeof o === 'boolean' ? o : v.enabled;
}

/** Merge a `vendors` patch ({ gpt: { enabled: true } }) into the runner config's. */
export function mergeVendorsConfig(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'vendors must be an object like { "gpt": { "enabled": true } }' };
  const out = { ...(current && typeof current === 'object' ? current : {}) };
  for (const [id, cfg] of Object.entries(patch)) {
    if (id === DEFAULT_VENDOR || !vendorById(id)) return { error: `unknown vendor ${String(id).slice(0, 40)}; known: ${VENDORS.filter((v) => v.id !== DEFAULT_VENDOR).map((v) => v.id).join(', ')}` };
    if (!cfg || typeof cfg.enabled !== 'boolean') return { error: `vendors.${id}.enabled must be true or false` };
    out[id] = { enabled: cfg.enabled };
  }
  return { value: out };
}

// Classes a non-Claude agent may take (operator, 2026-11-06: code and docs
// cards only). ops, review and research stay with the governed agent. `other`
// is allowed (operator, 2026-11-07, card glmps-2-0-159): a vendor run only
// happens when the operator named the model, and plain wording that matches
// no keyword is the commonest way a real code card scores `other`.
export const VENDOR_CLASSES = Object.freeze(['debug', 'feature', 'refactor', 'ui', 'docs', 'other']);
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const CLAUDE_ONLY_RE = /\b(deploy(?:s|ed|ing|ment)?|prod|production|restart|service|secrets?|credentials?|api keys?|live install|cutover|rollback|migrations?)\b/i;

/**
 * Whether a non-Claude vendor may run this card. Claude always may.
 * @returns {{allowed:boolean, reason:string|null, taskClass:string|null}}
 */
export function vendorEligibility({ vendor, card, cfg = {}, reviewer = false }) {
  if (vendor === DEFAULT_VENDOR) return { allowed: true, reason: null, taskClass: null };
  const v = vendorById(vendor);
  if (!v) return { allowed: false, reason: `unknown model ${String(vendor).slice(0, 40)}`, taskClass: null };
  if (reviewer) return { allowed: false, reason: 'reviews stay on Claude', taskClass: null };
  if (!vendorEnabled(vendor, cfg)) return { allowed: false, reason: `${v.label} is not switched on yet: ${v.signIn}, then set vendors.${v.id}.enabled in the runner config`, taskClass: null };
  const text = `${card?.title ?? ''}\n${card?.prompt ?? ''}`;
  const { taskClass } = classifyTask({ firstPrompt: text, filesTouched: card?.relevantFiles ?? [] });
  if (!VENDOR_CLASSES.includes(taskClass)) return { allowed: false, reason: `this reads as ${article(taskClass)} ${taskClass} card, and ${taskClass} work stays on Claude: reword it as a code or docs change, or use claude`, taskClass };
  const hit = CLAUDE_ONLY_RE.exec(text);
  if (hit) return { allowed: false, reason: `the card mentions "${hit[0]}", and deploy, prod, service and secret work stays on Claude`, taskClass };
  return { allowed: true, reason: null, taskClass };
}

/** The desktop app's vendor-card result: one JSON document on stdout. */
export function parseVendorResult(outcome) {
  if (outcome?.error) return { error: String(outcome.error?.message ?? outcome.error) };
  const r = outcome?.result;
  if (!r) return { error: 'the desktop app returned no result' };
  if (r.cancelled) return { error: 'the desktop app stopped the run on request' };
  if (r.timedOut) return { error: 'the run timed out and was stopped' };
  try {
    const doc = JSON.parse(String(r.stdout ?? '').trim());
    if (doc && typeof doc === 'object') return { doc };
  } catch { /* fall through */ }
  return { error: `the desktop app answered without a result document (exit ${r.status}): ${String(r.stderr || r.stdout || '').trim().slice(-200)}` };
}

const minutes = (ms) => `${Math.max(1, Math.round((ms ?? 0) / 60000))} min`;

/**
 * What the runner says and records when a vendor run ends. The runner, not the
 * vendor agent, owns the gate (operator, 2026-11-06, Q5): PASS needs green
 * tests, a held fence and a filed PR; a breach or red tests FAIL; anything
 * that left nothing to judge is CONCERNS.
 * @returns {{ gate, finishText, pushed:boolean }}
 */
export function vendorRunVerdict({ vendor, model, card, parsed, wallMs, acceptanceCount = 0 }) {
  const v = vendorById(vendor) ?? { label: vendor, signIn: '' };
  const name = `${v.label}${model ? ` (${model})` : ''}`;
  const ac = Array.from({ length: acceptanceCount }, (_, i) => `AC-${i + 1}`);
  const claim = (doc) => (doc?.agent?.text ? `agent summary (claimed by ${v.label}, not verified by the runner): ${String(doc.agent.text).slice(0, 1200)}` : null);
  const mk = (status, risk, lead, evidence, summary) => ({ gate: { status, risk, evidence: evidence.filter(Boolean), summary, by: `runner:${vendor}` }, finishText: lead, pushed: false });
  if (parsed.error) {
    return mk('CONCERNS', 'P2', `${name} run on this card did not finish: ${parsed.error}. Nothing was pushed.`,
      [`run error: ${parsed.error}`], `The ${v.label} run did not finish (${parsed.error}). Nothing was pushed; requeue the card to try again.`);
  }
  const d = parsed.doc;
  const tok = d.agent?.usage?.total != null ? `, ${d.agent.usage.total} tokens` : '';
  const took = `${minutes(wallMs)}${tok}`;
  if (d.agent?.authFailed) {
    return mk('CONCERNS', 'P2', `${name} is not signed in, so this card did not run. To switch it on: ${v.signIn}. Then requeue the card.`,
      ['agent run failed on sign-in; no files were changed'], `${v.label} is not signed in, so the card did not run. ${v.signIn}, then requeue it.`);
  }
  if (d.fence && d.fence.ok === false) {
    const list = (d.fence.violations ?? []).slice(0, 10).join(', ');
    return mk('FAIL', 'P1', `${name} changed fenced files (${list}), so the run failed and nothing was committed or pushed. The edits are still in the card's worktree for review.`,
      [`fence breach: ${list}`, `changed files: ${(d.changed ?? []).length}`], `The ${v.label} run edited files a non-Claude run may not touch (${list}); nothing was pushed. Review the worktree before requeueing.`);
  }
  if (d.tests?.ran && d.tests.exitCode !== 0) {
    return mk('FAIL', 'P2', `${name} changed ${d.changed.length} file(s) in ${took}, but the affected tests failed, so nothing was pushed.`,
      [`affected tests exit ${d.tests.exitCode}: ${String(d.tests.tail ?? '').slice(-600)}`, claim(d)], `The ${v.label} run's change failed its affected tests, so it was not pushed. Requeue to let it fix them.`);
  }
  if (d.error) {
    return mk('CONCERNS', 'P2', `${name} run ended with an error after ${took}: ${String(d.error).slice(0, 300)}. Nothing was pushed.`,
      [`run error: ${String(d.error).slice(0, 300)}`, claim(d)], `The ${v.label} run hit an error (${String(d.error).slice(0, 160)}), so nothing was pushed.`);
  }
  if (!(d.changed ?? []).length) {
    return mk('CONCERNS', 'P3', `${name} finished in ${took} without changing any file, so there is nothing to test or merge.`,
      ['no files changed', claim(d)], `The ${v.label} run changed nothing. Read its summary in the thread and requeue or reword the card.`);
  }
  if (!d.prUrl) {
    return mk('CONCERNS', 'P2', `${name} changed ${d.changed.length} file(s) in ${took}, but no pull request was opened${d.error ? `: ${d.error}` : ''}.`,
      [`tests: ${d.tests?.ran ? `exit ${d.tests.exitCode}` : 'not run'}`, 'no PR opened', claim(d)], `The ${v.label} run's change was not turned into a pull request. Check the worktree branch.`);
  }
  // The selection script exits 0 when it runs nothing, so only a selection
  // that names test files and passes them is green (card glmps-2-0-172, F2).
  const tests = d.tests?.ran && d.tests.selection === 'ran' ? `affected tests green (exit 0): ${String(d.tests.tail ?? '').slice(-300)}` : null;
  const noTests = tests ? null
    : d.tests?.skipped ? `tests not run: ${String(d.tests.skipped).slice(0, 300)}`
      : !d.tests?.ran ? 'affected tests did not run in the worktree'
        : d.tests.selection === 'none' ? 'the affected-test selection selected no test file, so no test ran; the merge queue runs them'
          : d.tests.selection === 'full' ? 'the change needs the full suite, which the runner does not run; the merge queue runs it'
            : 'the test step exited 0 but did not say which tests ran, so it is not counted as green';
  const status = tests ? 'PASS' : 'CONCERNS';
  const acLine = ac.length ? `${ac.join(', ')}: see the agent summary; the runner verified only the tests, the fence and the PR` : null;
  return {
    gate: {
      status, risk: tests ? 'P3' : 'P2', by: `runner:${vendor}`,
      evidence: [tests ?? noTests, `fence held: ${d.changed.length} changed file(s), none fenced`, `PR ${d.prReused ? 'reused' : 'opened'}: ${d.prUrl}`, acLine, claim(d)].filter(Boolean),
      summary: `${v.label} delivered a change for this card in ${took}; it is filed to the merge queue as ${d.prUrl}. The runner checked the tests and the fence; the acceptance criteria rest on the agent's own summary.`,
    },
    finishText: `${name} finished in ${took}: ${d.changed.length} file(s) changed, ${tests ? 'affected tests green' : 'tests not run'}, pull request ${d.prUrl} filed to the merge queue.`,
    pushed: true,
  };
}

/** The run record appended to the card for every card run. */
export function runRecord({ vendor, model, startedAt, endedAt, exit, doc = null }) {
  return {
    vendor, model: model ?? null,
    startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), wallMs: Math.max(0, endedAt - startedAt),
    exit: exit ?? null,
    tokens: doc?.agent?.usage ?? null, costUsd: doc?.agent?.costUsd ?? null,
    sessionId: doc?.agent?.sessionId ?? null, prUrl: doc?.prUrl ?? null,
  };
}

// Capture adapter session ids (server/lib/adapters/*: agy-cli `agy:<conv>`,
// codex-cli `codex:<rollout basename ending in the thread id>`, grok `grok:<id>`).
export function adapterSessionMatcher(vendor, rawId) {
  if (!rawId) return () => false;
  if (vendor === 'gemini') return (sid) => sid === `agy:${rawId}`;
  if (vendor === 'gpt') return (sid) => typeof sid === 'string' && sid.startsWith('codex:') && sid.endsWith(rawId);
  if (vendor === 'grok') return (sid) => sid === `grok:${rawId}` || (typeof sid === 'string' && sid.startsWith('grok:') && sid.endsWith(rawId));
  return () => false;
}

/**
 * One row per recorded card run, joined with the card's merge rounds and gate
 * as they stand now (a merge lands after the run that produced it), so cards
 * run on different models can be lined up side by side.
 */
export function modelRunRows(items, { project = null } = {}) {
  const rows = [];
  for (const c of items ?? []) {
    if (project && c.project !== project) continue;
    for (const r of c.runs ?? []) {
      rows.push({
        cardId: c.id, project: c.project, title: c.title,
        vendor: r.vendor ?? DEFAULT_VENDOR, model: r.model ?? null,
        startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null, wallMs: r.wallMs ?? null,
        exit: r.exit ?? null, tokens: r.tokens ?? null, costUsd: r.costUsd ?? null,
        mergeRounds: c.mergeRequest?.round ?? 0, mergeStage: c.mergeRequest?.stage ?? null,
        gate: c.gate?.status ?? null, cardState: c.state,
      });
    }
  }
  return rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** Per-vendor totals over modelRunRows output. */
export function modelRunSummary(rows) {
  const by = new Map();
  for (const r of rows) {
    const s = by.get(r.vendor) ?? { vendor: r.vendor, runs: 0, wallMsTotal: 0, tokensTotal: 0, costUsdTotal: 0, gatePass: 0, mergeRoundsTotal: 0 };
    s.runs += 1;
    s.wallMsTotal += r.wallMs ?? 0;
    s.tokensTotal += r.tokens?.total ?? 0;
    s.costUsdTotal += r.costUsd ?? 0;
    s.gatePass += r.gate === 'PASS' ? 1 : 0;
    s.mergeRoundsTotal += r.mergeRounds ?? 0;
    by.set(r.vendor, s);
  }
  return [...by.values()];
}

/**
 * The prompt a vendor agent gets. The rules are not inlined (CLAUDE.md is
 * larger than the Windows argv limit agy is given its prompt through); the
 * agent is told to read its own instruction file, which carries them.
 */
export function buildVendorPrompt({ card, vendor, seed, doneFile = null }) {
  const v = vendorById(vendor);
  const last = doneFile
    ? `7. When you are finished, write a short plain summary to ${doneFile} (create the file): what you changed, and for each acceptance criterion (AC-1, AC-2, ...) what shows it is met or what is still open. Writing it hands the work to the runner, which checks, tests, commits and opens the pull request. The operator may keep typing to you; if you change anything after that, write the summary file again to hand over the new work.`
    : '7. End with a short plain summary: what you changed, and for each acceptance criterion (AC-1, AC-2, ...) what shows it is met or what is still open.';
  const ac = Array.isArray(card?.acceptanceCriteria) ? card.acceptanceCriteria.map((a) => (typeof a === 'string' ? a : a?.text)).filter(Boolean) : [];
  return [
    `You are ${v.label}, working GLMPS backlog card ${card.id} as a coding agent.`,
    '',
    'Run contract (the GLMPS runner enforces it; breaking it fails the run):',
    `1. First read ${v.instructionFile} in the repository root. It holds this project's rules, the same rules every model here follows. Follow them.`,
    '2. Work only inside the current directory. It is your own git worktree on the card branch.',
    '3. Do not commit, push, merge, or run gh. The runner tests, commits, pushes and opens the pull request after you finish.',
    '4. Do not create or edit secret or credential files, anything under a prod path, CLAUDE.md, AGENTS.md, GEMINI.md, hooks/, .claude/, .codex/, .grok/ or the Gemini config dir. A change to any of them fails the run and nothing is pushed.',
    '5. Do not POST to the GLMPS server, even where the card text below says to (devlog, gate, progress, merge-request). The runner posts your progress, the gate and the merge request for you.',
    '6. Write the tests first where the rules ask for it, then run `node scripts/affected-tests.mjs` and make it pass.',
    last,
    '',
    ...(ac.length ? ['Acceptance criteria:', ...ac.map((t) => `- ${t}`), ''] : []),
    seed,
  ].join('\n');
}

// AC-6: vendors whose interactive mode is verified (agy -i, codex [PROMPT]).
// Grok's is not, so a Grok card stays headless.
export const TAB_VENDORS = Object.freeze(['gemini', 'gpt']);
export const VENDOR_DONE_FILE = '.glmps-vendor-done.md';

// A tab run reports no session id, so its captured sessions are the vendor's
// sessions that touched a path inside the card worktree.
const SESSION_PREFIX = { gemini: 'agy:', gpt: 'codex:', grok: 'grok:' };
export function tabSessionMatcher(vendor, events, cwd) {
  const prefix = SESSION_PREFIX[vendor];
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const root = norm(cwd);
  if (!prefix || !root) return () => false;
  const sids = new Set();
  for (const e of events ?? []) {
    const sid = e?.sessionId;
    const p = norm(e?.path);
    if (typeof sid === 'string' && sid.startsWith(prefix) && (p === root || p.startsWith(`${root}/`))) sids.add(sid);
  }
  return (sid) => sids.has(sid);
}

// The tab title the companion shows for a card's session, "<vendor> <card-id>".
// The card id is what ties a tab to its ticket; there is no "mc: " prefix, and a
// companion built before card glmps-2-0-166 shows a given name verbatim.
export function vendorTabName(vendor, cardId) {
  return `${String(vendor).replace(/[^a-z0-9-]/gi, '')} ${String(cardId).replace(/[^a-z0-9-]/gi, '')}`.slice(0, 60);
}

/**
 * The command the companion types into the card's tab. Paths only, each
 * double-quoted (a Windows path cannot hold a double quote); the prompt path
 * rides along so the companion closes the tab's shell when the session ends.
 */
export function vendorTabCommand({ wrapper, sessionFile, promptFile }) {
  for (const [k, p] of Object.entries({ wrapper, sessionFile, promptFile })) {
    if (typeof p !== 'string' || !p || /["\r\n]/.test(p)) throw new Error(`vendorTabCommand: unusable ${k}`);
  }
  return `node "${wrapper}" "${sessionFile}" "${promptFile}"`;
}

/**
 * Whether a vendor tab signal may start a finish: the right nonce and a known
 * event. Each done file is one hand-off round, so a signal after an earlier
 * finish is a later round, and one that arrives while a finish runs is queued
 * to run after it (card glmps-2-0-172, F4).
 */
export function vendorSignalCheck({ session, body, finishing = false }) {
  if (!session) return { ok: false, status: 404, error: 'no tab session is open for this card' };
  if (typeof body?.nonce !== 'string' || body.nonce !== session.nonce) return { ok: false, status: 403, error: 'the run nonce does not match this card\'s tab session' };
  if (body.event !== 'done' && body.event !== 'exit') return { ok: false, status: 400, error: 'event must be done or exit' };
  if (finishing) return { ok: true, status: 202, already: false, queued: true };
  if (session.finishedAt) return { ok: true, status: 202, already: false, laterRound: true };
  return { ok: true, status: 202, already: false };
}

/** The agent's done-file summary as the desktop app accepts it: text, capped. */
export function vendorSummaryText(raw) {
  return String(raw ?? '').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ').slice(0, 4000);
}
