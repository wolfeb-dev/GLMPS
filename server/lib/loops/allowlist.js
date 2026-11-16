// Pre-2.0 intervals the loop registry does not own yet. Each row names the
// phase that will register or delete it (program section 6). Adding a row
// needs a reason a reviewer accepts; the registry test fails on anything else.
export const LOOP_ALLOWLIST = Object.freeze([
  { file: 'server.js', match: 'setInterval(memoryDistillSweep', reason: 'memory distiller sweep: drains distill requests and emits session.condensed into the memory-admission loop (K Task 6); register it as a loop when its phase touches it' },
  { file: 'server.js', match: 'setInterval(memoryUsageTick', reason: 'memory eviction; program section 6 "register when its phase touches it"' },
  { file: 'server.js', match: 'setInterval(measurablesTick', reason: 'measurables cache refresh for the dashboard (read-only recompute)' },
  { file: 'server.js', match: 'setInterval(skillLifecycleTick', reason: 'skill lifecycle scan; pre-2.0 loop, not in any 2.0 phase' },
  { file: 'server.js', match: 'crossAgentMemoryTrialTimer = setInterval', reason: 'cross-agent memory trial; pre-2.0 loop, not in any 2.0 phase' },
  { file: 'server.js', match: 'setInterval(decisionSweepTickFn', reason: 'decision-log git sweep; pre-2.0 loop, logs errors' },
  { file: 'server.js', match: 'suspendHeartbeat = setInterval', reason: 'host-sleep detector for loop freshness (glmps-2-0-64); its signal is its own steady wall-clock cadence, which a registered loop backs off and records a run for every 10 s' },
  { file: 'server.js', match: 'heartbeatTimer = setInterval', reason: 'SCUT host-liveness heartbeat; owned by SCUT (phase C touches SCUT but not the heartbeat)' },
  { file: 'server.js', match: 'setInterval(poll, pollMs)', reason: 'the capture poll: the hot path of the server itself, not a background job' },
  { file: 'server.js', match: 'setInterval(checkAgAlive', reason: 'Antigravity process presence check for the UI' },
  { file: 'server.js', match: 'invTimer = setInterval', reason: 'inventory rescan and worktree sweep for the UI' },
  { file: 'server.js', match: 'setInterval(runnerTick', reason: 'the queue runner tick (dispatch and progressTick); the SCUT park sweep left it for the scut-park-sweep loop in Phase C Task 4' },
  { file: 'server.js', match: 'unmergedRefreshTimer = setInterval', reason: 'unmerged-branch scan cache; program section 6 "register when its phase touches it"' },
  { file: 'server.js', match: 'setInterval(qaTrendsTickFn', reason: 'QA trends sampler (read-only gh poll feeding a chart)' },
  { file: 'server.js', match: 'setInterval(vitalsTrendsTickFn', reason: 'vitals trends sampler feeding a chart' },
  { file: 'server.js', match: 'graphRebuildTimer = cfg.graphRebuild.enabled ? setInterval', reason: 'graphify refresh; program section 6 "register when its phase touches it"' },
  { file: 'server.js', match: 'setInterval(() => { graphifyVersionTick', reason: 'graphify version audit; pre-2.0 loop' },
  { file: 'lib/scut/channel-server.js', match: 'setInterval(() => { void poll(); }', reason: 'Slack channel-server child process poll, runs in its own process' },
  { file: 'lib/kernel/parent-watch.js', match: 'const timer = setInterval', reason: 'service-mode parent-pid watch (glmps-2-0-58): exits the process when its WinSW wrapper dies; process lifetime, not a background job with an outcome' },
  // K Task 6 absorbed Phase P's retry tick and optional GEPA interval into
  // the registered plugin-retry and guard-proposals loops (server/lib/loops/
  // plugin-loops.js) and deleted both setInterval calls; their rows are
  // removed here with them.
  // Trunk sync (glmps2/main PR #21, GLMPS 2.0 Phase P shadow instance): the
  // shadow instance's own outcomes-finalize sweep. Owned by Phase P, not this
  // plan; becomes a registered loop once its owner migrates it onto the
  // registry.
  { file: 'server.js', match: 'setInterval(finalizeSweepTick', reason: 'Phase P shadow-instance finalize sweep (server/lib/evaluation/finalize-sweep.js); becomes a registered loop when its owner migrates it onto the registry' },
]);
