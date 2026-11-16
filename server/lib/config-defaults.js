// server/lib/config-defaults.js
// The shipped config.json defaults, one source for startServer() (which
// merges config.json over a fresh copy) and for the wiki's admin guide
// reference (server/lib/observability/wiki-facts.js), which must read them
// without starting a server.
import { WIKI_LOOP_DEFAULTS } from './observability/wiki-loop.js';
import { mergeGraphConfig } from './observability/graph-scope.js';
import { MACHINE_SCAN_DEFAULTS } from './observability/graph-machine.js';
import { DEFAULT_INTEGRATION_BRANCHES } from './governance/role-permissions.js';
import { CANONICAL_PROJECT_DEFAULTS } from './orchestration/canonical-project.js';

// The single source for cfg.scut's shipped defaults -
// both the initial `cfg` object literal and the deep-merge protection below
// read this SAME object (spread into a fresh copy each time, never mutated),
// so the two can never drift apart the way two separately-typed literals can.
export const SCUT_DEFAULTS = { enabled: true, ticketChannels: true, channelMessages: false, rejoinReopens: false };
// The huddle (D28). Claude through the operator's plan:
// model names are claude -p aliases. floorModel picks the speaker and writes
// the summary; mindModel speaks; effort goes to the minds as --effort.
// floorEffort goes to the Lead's who-speaks call: with no effort the CLI's
// haiku took a median 1.7 s to its first token, at low 0.86 s (2026-10-24).
// seats merges per persona id over DEFAULT_SEATS (engine, model, personality,
// voice; lib/huddle/roster.js). The agy seats join when the agy conversations
// dir exists, unless agySeats is false (geminiSeat: false still means the same,
// for older configs). decideModel runs the decision extraction.
// rosterMap overrides DEFAULT_ROSTER_MAP (lib/huddle/roster.js).
// staleMs: a huddle untouched that long is ended when the next one starts.
// idleKillMs: a mind with no turn in flight that long has its claude process killed.
export const HUDDLE_DEFAULTS = {
  enabled: true, floorModel: 'haiku', floorEffort: 'low', mindModel: 'opus', effort: 'low', maxTokens: 160, rosterMap: null,
  seats: null, agySeats: true, decideModel: 'sonnet', staleMs: 6 * 60 * 60 * 1000, idleKillMs: 15 * 60 * 1000,
};

// A fresh object on every call: startServer() runs many times in one test
// process and Object.assign mutates its target.
export function configDefaults() {
  return {
    port: 8123, host: '127.0.0.1', accessToken: null, workingThresholdMs: 10000, idleThresholdMs: 60000,
    inventoryScanMs: 60000, agCheckMs: 5000, runnerTickMs: 5000, searchResultCap: 200, backfillBytes: 2 * 1024 * 1024,
    antigravityCommand: null, openInEditorArgs: ['-g', '{path}'], editableRoots: [],
    backlog: { archiveDays: 7 },
    // Per-repo merge-queue overrides: repos["owner/name"] = { path?, test?, timeoutMs? }.
    mergeQueue: { repos: {} },
    surface: { localGeo: null },
    huddle: { ...HUDDLE_DEFAULTS },
    // Actor identity spine (glmps-72 Workstream B): `actor` is this server's own
    // default local identity (loopback capture default + runner identity);
    // `actors` is the optional per-team config table (see lib/governance/actors.js).
    // Both absent = solo mode, byte-identical to before this existed.
    actor: null, actors: [],
    // The kernel's wiki loop (D-W5). enabled: null means "on exactly in the
    // kernel service" (GLMPS_SERVICE=1), so a dev or test server never spawns a
    // real model build; set true or false in config.json to override.
    wikiLoop: { ...WIKI_LOOP_DEFAULTS },
    // Scheduled FULL graph rebuild. Default ENABLED: this is AST-only, costs
    // no API tokens, and it is the repair path for a silently collapsed
    // knowledge graph. On 2026-07-28 this repo's graph fell from 9,675
    // nodes to 55 and stayed there for 54 commits with nothing reporting it. It
    // fires on the interval ALONE, never on commit drift; see graph-refresh.js
    // for why a drift gate would have missed that outage entirely.
    graphRebuild: { enabled: true, checkMs: 30 * 60 * 1000, minIntervalMs: 24 * 60 * 60 * 1000 },
    // Daily graphify version audit (glmps-86, glmps-2.0 repo upgrade-plan item 7b step
    // 1). Upstream's CHANGELOG.md stops at 0.1.8 while it ships 0.9.51, so a
    // changelog read cannot gate an upgrade; the audit is behavioural instead
    // (see graphify-version.js). `autoUpgrade` defaults true ONLY because the
    // tick audits the candidate's CLI surface before adopting and rolls back
    // to the known-good version on a rebuild regression -- if either guard is
    // ever removed, flip this default to false. `pinned` is the known-good
    // version: what `glmps init` installs when graphify is missing, and a
    // pending-rollback marker whose candidate is the pinned version is stale
    // rather than acted on (graphify-toolchain.js).
    graphifyUpdate: {
      enabled: true, autoUpgrade: true, tickMs: 24 * 60 * 60 * 1000, minRatio: 0.8, pinned: '0.9.95',
      requiredCommands: ['query', 'explain', 'path', 'update', 'watch', 'affected', 'install'],
    },
    // Graph scope (observability/graph-scope.js). The ship scope is the kernel
    // plus the corpus repo; the machine scan is off by default. exclude is
    // per-machine config and empty in code, so another user's machine starts
    // with nothing excluded.
    graph: mergeGraphConfig(),
    // Writes the merged machine graph (observability/graph-machine.js); a no-op
    // until graph.machine is enabled and a repo is opted in.
    graphMachineScan: { ...MACHINE_SCAN_DEFAULTS },
    // QA Trends panel (docs/superpowers/specs/2026-07-14-qa-trends-design.md):
    // periodic sampler that records one point per completed CI run (test counts
    // + open issues) into <stateDir>/qa-trends/history.ndjson. Default ENABLED:
    // this is a cheap, bounded, fail-open read-only `gh` poll, not an LLM
    // rebuild; the operator can still opt out via config.json.
    qaTrends: { enabled: true, checkMs: 30 * 60 * 1000 },
    // Platform autonomy (docs/handoff-platform-autonomy-v2.md): the nightly
    // decay sweep plus the reconciliation integrity checks. Default DISABLED,
    // on purpose. It is the write side of the learning-integrity layer, and an
    // operator should turn it on deliberately.
    platformAutonomy: { enabled: false, tickMs: 24 * 60 * 60 * 1000 },
    // Learning integrity (handoff A0). The freeze starts ON: until A0
    // acceptance passes, an autonomous runner may read lessons but never
    // write them, so its first runs cannot contaminate the lesson store.
    learningIntegrity: { freeze: true },
    // Nightly run (handoff Part A). repoAllowlist is empty by default and an
    // empty allowlist denies everything, which is the fail-closed default the
    // guardrails depend on.
    nightly: { enabled: false, repoAllowlist: [], maxItems: 1, budget: { maxUsd: null, maxTokens: null } },
    // Vitals Trends sampler (docs/superpowers/specs/2026-07-22-vitals-trends-
    // design.md, Step 2): periodic sampler that records one point per tick
    // (board.vitals counts + budget/alerts/queue) into <stateDir>/vitals-
    // trends/history.ndjson. Default ENABLED, same rationale as qaTrends above
    // (cheap, bounded, fail-open, read-only over already-computed values, not
    // an LLM rebuild) -- the operator can still opt out via config.json.
    vitalsTrends: { enabled: true, tickMs: 30_000 },
    // Phase K kernel: the program section 0 loop contract's own periodic
    // jobs and the D6a failure-streak diagnosis. gitRemoteFeedMs and
    // obligationSweepMs are consumed by later tasks (K9, K11); diagnosis is
    // Task 4's own config, ON by default (D6a: it only files a queued card,
    // never applies a fix, so there is no reason to make an operator opt in).
    // maxPerDay bounds the model calls a runaway streak can spend; past it
    // the card still files, with the ceiling breach recorded in its body.
    // `project`: null means the canonical-project target below. A fixed column, not derived
    // from the running checkout's own directory name - that name is
    // 'glmps2-k' in this worktree and something else again on the 2.0
    // runtime, so a derived value would file cards into a column nobody is
    // watching depending on which checkout happens to be running. The column
    // is the canonical 2.0 project (outside-2.0 inventory Q3, card
    // glmps-2-0-runtime-151): the kernel's own failures belong on the board of
    // the repo that runs it.
    kernel: { gitRemoteFeedMs: 15 * 60_000, obligationSweepMs: 60_000, diagnosis: { enabled: true, maxPerDay: 10, project: null } },
    // The canonical-project table (orchestration/canonical-project.js): board
    // intake, Slack routing, the runner's checkout lookup and every auto-filer
    // resolve these names to `target`. Cutover flips `target` to glmps-2.0.
    canonicalProject: { target: CANONICAL_PROJECT_DEFAULTS.target, names: [...CANONICAL_PROJECT_DEFAULTS.names], intakeDefault: CANONICAL_PROJECT_DEFAULTS.intakeDefault },
    // SCUT, the Slack chat layer (server/lib/scut/**). `enabled` only says the
    // operator has not opted out: SCUT still starts ONLY when Slack credentials
    // exist, so this default is inert on every machine that never ran the setup
    // wizard. GLMPS_SCUT=off overrides it from the environment.
    // `ticketChannels` gives every Slack-started ticket its own Slack channel,
    // hidden (renamed closed-, operators removed) when the card closes, D27 -
    // never archived. `channelMessages` lets the operator talk in a ticket
    // channel WITHOUT addressing anyone. It stays false until
    // `message.channels` is added to the Slack app's event subscriptions and
    // the app is reinstalled: until then no such event arrives, so turning it
    // on would only widen a code path with nothing to feed it. Set it false
    // to fall back to @mentions.
    // `rejoinReopens` (D27): rejoining a hidden ticket channel reopens its
    // ticket. Off until `member_joined_channel` is added to the Slack app's
    // event subscriptions and the app is reinstalled - see docs/scut-ticket-channels.md.
    // Spread from SCUT_DEFAULTS, which is also the deep-merge protection in
    // startServer(): one source, so the two can never drift apart.
    scut: { ...SCUT_DEFAULTS },
    // Agent routing (docs/superpowers/specs/2026-08-02-agent-routing-design.md
    // section B3: "the map belongs in config.json, which already merges over
    // shipped defaults"). These MUST be declared here, not only in
    // config.example.json: `configFile` resolves to <repo>/config.json, which is
    // gitignored and absent on a fresh install, so an example file nothing reads
    // left `cfg.agentRoutes` undefined and every launched card took the NO_ROUTE
    // path forever. resolveRoute's `routes = {}` default IS the documented off
    // switch, so an absent default is indistinguishable from "routing disabled".
    // A user config.json still merges OVER these (Object.assign, shallow), which
    // is what makes `"agentRoutes": {}` the opt-out.
    // All eight classes are mapped as of the 2026-08-12 roster re-cut. Before
    // it, only `research` and `ui` were, because those were the only two the
    // roster covered, and routing consequently fired zero times in the ten days
    // after it shipped. See docs/superpowers/specs/2026-08-12-agent-roster-recut-design.md.
    agentRoutes: {
      debug: 'debugger',
      feature: 'tdd-implementer',
      refactor: 'tdd-implementer',
      ops: 'tdd-implementer',
      review: 'code-critic',
      docs: 'docs-writer',
      research: 'web-researcher',
      ui: 'ui-designer',
    },
    agentRouteMinConfidence: 0.5,
    agentRouteMinScore: 1,
    // Branches a worker session may not push to and a reviewer may never push to.
    integrationBranches: [...DEFAULT_INTEGRATION_BRANCHES],
    // Agent capability-lifecycle (computeAgentRetireCandidates). Same reason as
    // above; every reader already tolerates a partial override
    // (`agCfg.exempt ?? []`, `agCfg.minObservationDays ?? AGENT_MIN_OBS_DAYS`),
    // so this stays a shallow default like `backlog` rather than growing another
    // deep-merge line.
    agentLifecycle: { exempt: [], minObservationDays: 180 },
    terminals: [
      { label: 'Claude', command: 'claude', icon: 'claude' },
      { label: 'Gemini', command: 'gemini', icon: 'gemini' },
      { label: 'Codex', command: 'codex', icon: 'codex' },
      { label: 'Blank', command: '', icon: 'terminal' },
    ],
  };
}
