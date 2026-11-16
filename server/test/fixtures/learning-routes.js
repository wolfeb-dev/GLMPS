// server/test/fixtures/learning-routes.js
// Route fixtures for the Learning lens smoke test (server/test/
// lens-learning-items.test.js). LEARNING_ROUTES maps a URL path PREFIX to the
// JSON body a stub fetch should answer with (see that test's fetch stub:
// `Object.entries(LEARNING_ROUTES).find(([k]) => u.startsWith(k))`), so a key
// that is itself a prefix of a longer, more specific key must be declared
// AFTER it below or the longer route never matches.
//
// The bodies are trimmed copies of the fixtures already proven against
// web/evaluation/substrate-loop.js's renderLoop() (server/test/
// web-loop-view-smoke.test.js) and web/evaluation/registry.js's
// renderRegistry() (server/test/registry-view-smoke.test.js). Only the
// Ledger segment of the loop view mounts eagerly (the Learning lens never
// switches to Signals/Outcomes in this test), so /api/alerts, /api/outcomes,
// /api/promotion and /api/replay are intentionally left out, see this task's
// FINDINGS.
//
// The changes fixture below adds a SECOND 'guard' change sharing the title
// 'rule-a' with the first, so groupGuardChanges() produces a real 2-instance
// rollup group and web/evaluation/substrate-loop.js's buildGuardGroupRow
// (bound as a Learning 'guard' item) actually renders without needing to
// expand anything first.

const loopMetricsFixture = {
  acceptance: { accepted: 12, proposed: 40, rate: 0.3 },
  regression: { reverted: 3, adopted: 20, rate: 0.15, band: 'healthy' },
  guardHits: { count: 7 },
  lifecycle: { adopted: 12, deprecated: 4, retired: 2 },
};

const changesFixture = [
  {
    id: 'guard-1', type: 'guard', title: 'rule-a', status: 'measuring', ts: 3000,
    evidence: { sessionId: 'sess-1' },
    measuredEffect: { fireCount: 4, episodes: 2, evidence: 'exercised' },
  },
  {
    id: 'guard-2', type: 'guard', title: 'rule-a', status: 'proposed', ts: 2500,
    evidence: { sessionId: 'sess-2' },
    measuredEffect: null,
  },
  { id: 'memory-1', type: 'memory', title: 'mem-a', status: 'proposed', ts: 2000 },
];

const changesResponseFixture = {
  changes: changesFixture,
  scoreboard: { tracked: 3, netPositive: 1, revertedNoHelp: 0, unmeasured: 1, northStar: null },
  loopMetrics: loopMetricsFixture,
};

// Registry fixtures: one row per kind, trimmed from registry-view-smoke.
const now = Date.now();

const learningItems = [
  { id: 'g1', code: 'code-a', status: 'pending', title: 'Guard A', body: 'body a', project: 'proj', sessionId: 's1', updatedTs: now - 1000, createdTs: now - 5000, proposedGuard: null },
];

const lessons = [
  {
    lessonId: 'legacy:l1', kind: 'guard', title: 'ui without frontend design',
    scope: 'global', status: 'active', strength: 1, reflex: true, promoted: true,
    provenance: { scope: 'global', sourceEventIds: ['learning-store:l1'], derivedFromRefs: ['abc'] },
    createdAt: new Date(now - 5 * 86400000).toISOString(), updatedAt: new Date(now - 86400000).toISOString(),
  },
];

const measurables = [];
const skillLifecycleCandidates = [];

const skills = [
  { id: 'project:some-skill', name: 'some-skill', description: 'desc', plugin: 'project', uses: 5, lastSeen: new Date(now - 200 * 86400000).toISOString(), installed: true },
];

const agentItems = [
  { name: 'ui-designer', source: 'assets', dispatchCount: 3, lastUsed: now - 1000, modelSplit: { sonnet: 3, haiku: 0, opus: 0, none: 0 } },
];

const memoryProposals = [
  { id: 'mem-0', fact: { name: 'fact-0', description: 'description 0' }, sessionId: 'sess-0', ts: now - 1000 },
];

const camItems = [
  { id: 'c1', status: 'pending-approval', fact: { name: 'shared-fact-1', description: 'd' }, sourceProject: 'proj', updatedTs: now, createdTs: now },
];

export const LEARNING_ROUTES = {
  // Ordered so a longer path never gets shadowed by a shorter prefix above it
  // (e.g. '/api/skills/lifecycle-candidates' before '/api/skills').
  '/api/changes': changesResponseFixture,
  '/api/learning': { items: learningItems, config: {} },
  '/api/lessons': { lessons, active: 1, config: { freeze: true } },
  '/api/measurables': { measurables, scoreboard: {} },
  '/api/skills/lifecycle-candidates': { items: skillLifecycleCandidates },
  '/api/skills': { skills, neverUsed: [], installedAvailable: true },
  '/api/agents': { agents: agentItems },
  '/api/memory/proposals': { proposals: memoryProposals },
  '/api/cross-agent-memory': { items: camItems },
};
