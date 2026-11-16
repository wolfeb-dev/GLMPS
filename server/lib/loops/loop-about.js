// Why each registered loop runs, what it produces, and which Personality cards
// steer it. Kept in one module so a registration site stays small; the registry
// attaches the record by loop name unless the spec carries its own `about`.
// Card ids are Personality card ids (server/lib/personality/index.js).
const r = (card) => ({ card, mode: 'reads' });
const w = (card) => ({ card, mode: 'writes' });
const i = (card) => ({ card, mode: 'indirect' });

export const LOOP_ABOUT = Object.freeze({
  'launch-queue': { group: 'ship', why: 'Launches queued cards as sessions', produces: 'Runner session, prompt file, role settings',
    steers: [r('runtime-card-prompt'), r('agents-skills'), r('project-settings'), i('machine-global-instructions'), i('project-claude-md'), i('memory-learned-guards')] },
  'nightly-run': { group: 'ship', why: 'Overnight card runs, never merges (off in the 2.0 shadow)', produces: 'Run report; executes queued cards and files PRs',
    steers: [i('runtime-card-prompt'), i('project-claude-md'), i('machine-global-instructions')] },
  'scut-reopen': { group: 'ship', why: 'A reply in a card thread reopens the card', produces: 'Relaunch or resume, thread notice',
    steers: [r('runtime-card-prompt')] },
  'scut-park-sweep': { group: 'ship', why: 'Releases stale parks, recovers unread wake notes', produces: 'Park ledger changes, card closes', steers: [] },
  'card-close-sync': { group: 'ship', why: 'A closed card owns no channel, park or session', produces: 'Hidden channels, ended parks', steers: [] },
  'orphan-sweep': { group: 'ship', why: 'A card with no host and no steering is listed to the operator once a day', produces: 'One Slack post of orphaned cards', steers: [] },
  'merge-queue-main-suite': { group: 'ship', why: 'Full suite on main after merges, bisects a red run', produces: 'Suite record, bisect findings', steers: [] },
  'merge-queue-live-notice': { group: 'ship', why: 'Each queue merge says once when it is live, or why not', produces: 'Live and waiting notices on merged cards', steers: [] },
  'merge-queue-batch-review': { group: 'ship', why: 'Independent review every 5 merges, after the live task', produces: 'One findings card per batch', steers: [] },
  'obligation-sweeper': { group: 'ship', why: 'An expired obligation never goes silent', produces: 'Operator notices, a triage card for a failing loop',
    steers: [r('runtime-prompt-loop-diagnosis')] },

  'session-judge': { group: 'learn', why: 'Independent verdict on what a session claimed', produces: 'Verdict row, closes the gate obligation',
    steers: [r('runtime-prompt-session-judge')] },
  'memory-admission': { group: 'learn', why: 'Admits durable facts to memory, poison-scanned', produces: 'Mem0 rows, quarantine file',
    steers: [r('runtime-prompt-memory-extraction'), i('memory-auto-memory')] },
  'guard-proposals': { group: 'learn', why: 'Proposes guard rules from repeated failures', produces: 'Guard proposals; lands in Learned guards when the operator approves (templated rules can also land through guard-auto-approve)',
    steers: [r('runtime-prompt-guard-proposer'), r('memory-learned-guards'), w('memory-learned-guards'), w('machine-global-instructions')] },
  'guard-auto-approve': { group: 'learn', why: 'Ages out stale guard proposals and lands a templated guard once its gap recurs across repos, on 14-day probation', produces: 'Aged-out queue rows, auto-approved or reverted guards, a daily Slack digest',
    steers: [w('memory-learned-guards'), w('machine-global-instructions')] },
  'lesson-decay': { group: 'learn', why: 'Ages out stale lessons so old rules stop acting', produces: 'Decayed rows in the lesson ledger', steers: [i('memory-learned-guards')] },
  'revert-sweep': { group: 'learn', why: 'A reverted commit voids the lessons it taught', produces: 'Invalidated lesson rows', steers: [i('memory-learned-guards')] },
  'platform-autonomy': { group: 'learn', why: 'Lesson decay, revert sweep and autonomy graduation', produces: 'Graduation records', steers: [i('memory-learned-guards')] },

  'companion-launch-watch': { group: 'ship', why: 'A launch Antigravity never opened would sit as launched with no session', produces: 'One stall devlog on the card, a companion-unclaimed alert', steers: [] },
  'runner-prompt-retention': { group: 'ship', why: 'Runner prompt files otherwise pile up forever, one per launch', produces: 'Deleted prompt files of cards closed 14+ days ago', steers: [] },
  'old-cleanup': { group: 'ship', why: 'Agents rename to .old instead of deleting; only this deletes them', produces: 'Deleted .old paths in tracked git repos, spine records', steers: [] },
  'state-backup': { group: 'feeds', why: 'Nightly verified copy of the state dir to a second disk', produces: 'Daily and weekly backup dirs, client mirror tree', steers: [] },
  'cert-expiry': { group: 'feeds', why: 'Warns 30 days before the server or a client certificate of local-only HTTPS expires', produces: 'Certificate expiry alerts', steers: [] },
  'graph-integrity': { group: 'graphs', why: 'Catches a silently collapsed graph', produces: 'Integrity record, alerts', steers: [] },
  'graph-machine-merge': { group: 'graphs', why: 'Merges opted-in repos into the machine graph', produces: 'Machine graph and manifest', steers: [] },
  wiki: { group: 'graphs', why: 'Keeps the codebase wiki at HEAD', produces: 'Wiki build, publish pointer', steers: [r('runtime-prompt-wiki-writer')] },

  'git-remote-feed': { group: 'feeds', why: 'Fresh git residency and remote state', produces: 'Residency rows', steers: [] },
  'tap-git-clones': { group: 'feeds', why: 'Local clones of tapped remotes', produces: 'Clones', steers: [] },
  'plugin-retry': { group: 'feeds', why: 'Self-heals failed memory and judge jobs', produces: 'Acks, dead-letter file', steers: [] },
  'actions-minutes': { group: 'feeds', why: 'Watches the GitHub Actions minutes budget', produces: 'Budget doc, alerts', steers: [] },
  'alert-digest': { group: 'feeds', why: 'One deduplicated attention digest to Slack', produces: 'Slack post', steers: [] },
});

export const GRAPH_CATALOG = Object.freeze([
  { name: 'Repo knowledge graph', builtBy: 'graphify update: 24 h rebuild and commit hook', why: 'Cheap code orientation for every session',
    steers: [r('project-claude-md'), r('machine-global-instructions'), r('machine-hooks'), r('project-settings')] },
  { name: 'Ship graph', builtBy: 'ship build tick', why: 'Default product graph on the map', steers: [] },
  { name: 'Machine graph', builtBy: 'graph-machine-merge loop', why: 'Cross-repo view',
    steers: [w('project-claude-md'), w('project-agents-md'), w('project-gemini-md')] },
  { name: 'Integrity baseline', builtBy: 'graph-integrity loop', why: 'Collapse guard', steers: [] },
  { name: 'Ranked code graph', builtBy: 'code graph with PageRank on the work in hand', why: 'Ranking follows the work', steers: [] },
  { name: 'File graph', builtBy: 'map view', why: 'One node per file, readable', steers: [] },
  { name: 'Wiki graph', builtBy: 'wiki loop', why: 'Docs grounded in the graph', steers: [] },
  { name: 'Lesson ledger', builtBy: 'lesson-decay, revert-sweep, learning store', why: 'Learning integrity; lands rules',
    steers: [w('memory-learned-guards'), w('machine-global-instructions')] },
  { name: 'Memory store', builtBy: 'memory-admission loop', why: 'Recall across sessions', steers: [r('memory-auto-memory')] },
]);
