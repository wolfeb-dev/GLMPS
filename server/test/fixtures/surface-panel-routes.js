// server/test/fixtures/surface-panel-routes.js
// The JSON bodies renderPolicy, renderEngagement, renderDecisions and
// renderMap fetch, keyed by URL path (surfaceFetch strips the query string
// before matching, so these keys are bare paths). Shapes read from each
// route's real server handler (server/server.js) and each render function's
// own field usage (web/surface/declared/policy.js, web/surface/declared/engagement.js,
// web/observability/decisions.js, web/observability/map.js), since
// engagement-view.test.js and file-graph.test.js test pure functions with
// in-memory data, not a fetch-level fixture to copy verbatim.
export const SURFACE_PANEL_ROUTES = {
  // GET /api/usage/providers?hours=168 (R3's feed): one placed provider so the
  // usage layer's arc is rendered for the every-item-type sweeps.
  '/api/usage/providers': { from: 1, to: 2, providers: [{ id: 'anthropic', label: 'Anthropic', spendUsd: 3.5, tokens: 12000, sessions: 2 }] },
  // GET /api/governance/policy (getPolicy, web/shared/api.js) - shape from
  // server/server.js's own GET handler (the "no baseline yet" branch).
  '/api/governance/policy': {
    configured: false,
    path: 'D:/glmps/governance-baseline.json',
    policy: [{ id: 'p1', text: 'Never commit secrets', enabled: true, tags: ['security'] }],
    targets: [{ vendor: 'claude-code', path: 'CLAUDE.md' }],
    autoPush: false,
    vendors: [{ id: 'claude-code', label: 'Claude Code', defaultPath: 'CLAUDE.md' }],
  },
  // GET /api/engagement (fetchEngagement, web/shared/api.js) - shape from
  // renderEngagement's own field reads (web/surface/declared/engagement.js).
  '/api/engagement': {
    engagement: 'default', controllable: true,
    identity: { handle: 'operator' },
    tiers: { artifact: { roots: ['D:/glmps'] }, brain: { roots: [] }, ephemeral: { roots: [] } },
    mutationPolicy: { artifact: 'gate', brain: 'versioned', ephemeral: 'readonly' },
  },
  // GET /api/decisions?limit=1000 (renderDecisions) - the one-entry shape
  // the brief pins verbatim.
  '/api/decisions': { entries: [{ repo: 'glmps', commit: 'abc1234', what: 'x', why: 'y' }], repos: ['glmps'] },
  // GET /api/state (getState, web/shared/api.js) - both the sessions-list
  // call and the per-session detail call (?session=s1) hit this same bare
  // path once the query string is stripped; renderMap only ever reads
  // .sessions from the list call and .events from the detail call, so one
  // shape serves both. countsAsLive() needs live:true, internal falsy.
  '/api/state': {
    sessions: [{ id: 's1', live: true, internal: false, cwd: 'D:/glmps', summary: 'wire the globe' }],
    events: [],
  },
  // GET /api/graph (getGraph, web/shared/api.js) - shape from server.js's
  // own GET /api/graph handler. One real node so aggregateToFiles produces
  // a file pill a graph-file item can bind to.
  '/api/graph': {
    project: 'D:/glmps',
    graph: {
      nodes: [{ id: 'n1', source_file: 'web/app.js', community: 0, god: false, protected: false, env: 'dev' }],
      links: [],
      builtAtCommit: 'abc1234def',
      stale: false,
    },
    graphRoot: 'D:/glmps',
    zoneConfig: null,
  },
};
