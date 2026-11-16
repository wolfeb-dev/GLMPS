// server/server.js
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { getPaths, ensureStateDirs, graphPathFor, isTestProcess, claudeProjectDirName, configFileFor } from './lib/paths.js';
import { computeGraphStatus, selectRebuildTargets } from './lib/observability/graph-status.js';
import { computeWikiStatus, wikiRebuildArgs } from './lib/observability/wiki-status.js';
import { createGraphFingerprintReader } from './lib/observability/graph-fingerprint.js';
import { planGraphRebuildTick, selectRebuildRoots } from './lib/observability/graph-refresh.js';
import { classifyGraphifyRun } from './lib/observability/graphify-outcome.js';
import { recordSyncOutcome, graphSyncHealth, loadSyncHealth, persistSyncHealth } from './lib/observability/graph-sync-health.js';
import { focusFromEvents } from './lib/observability/graph-rank.js';
import { graphShape, observeGraphShape, stampVerifiedNoop, verifiedCommitFor, hasIntegrityRecord, graphIntegrity, loadGraphIntegrity, persistGraphIntegrity } from './lib/observability/graph-integrity.js';
import { compareVersions, auditSurface, auditRebuildWithFailures, planVersionTick } from './lib/observability/graphify-version.js';
import { askWiki } from './lib/observability/wiki-ask.js';
import { wikiPaths, readCurrentWiki, writeJsonAtomic } from './lib/observability/wiki-publish.js';
import { isWikiAssetRequest, resolveWikiRequest, realpathContained } from './lib/observability/wiki-serve.js';
import { agyGenerate } from './lib/observability/wiki-agy.js';
import { registerWikiLoop, spawnWikiBuild, readHeadAsync, readGraphCommit, WIKI_LOOP_DEFAULTS } from './lib/observability/wiki-loop.js';
import { createGraphifySingleFlight, GraphifyBusyError, waitForGraphifyUpdate } from './lib/observability/graphify-single-flight.js';
import { listGraphifyProcesses, waitForNoGraphifyProcess, describeGraphifyProcesses } from './lib/observability/graphify-toolchain.js';
import { skillRefreshPlan, refreshGraphifySkills, installRepoIntegrations } from './lib/observability/graphify-integrations.js';
import { appendEvent, appendEvents, readEvents } from './lib/observability/event-log.js';
import { defaultCallModel } from './lib/observability/wiki-llm.js';
import { sessionScope } from './lib/zones.js';
import { isProjectRootCandidate } from './lib/project-roots.js';
import { loadPrivateDirs, isPrivateDir } from './lib/private-dirs.js';
import { markTrusted } from './lib/orchestration/claude-trust.js';
import { createProject } from './lib/orchestration/project-dirs.js';
import { loadGraph } from './lib/observability/code-graph.js';
import { seedShipGraph } from './lib/observability/graph-ship-seed.js';
import { seedMemoryStore } from './lib/governance/memory-ship-seed.js';
import { seedWikiSnapshot, isInstalledBundle, wikiLoopEnabled as wikiLoopDefault } from './lib/observability/wiki-ship-seed.js';
import { readNewLines } from './lib/tailer.js';
import { extractClaudeEvents } from './lib/observability/extract-claude.js';
import { extractAgEvents } from './lib/observability/extract-antigravity.js';
import { discoverClaudeSessions, createClaudeDiscovery, discoverAgSessions, livenessOf, isInternalSession, createStatusReader, readClaudeSessionRegistry, procStartsSettled } from './lib/observability/sessions.js';
import { loadInternal } from './lib/evaluation/internal-sessions.js';
import { loadAgLabels } from './lib/observability/ag-labels.js';
import { scanInventoryAsync } from './lib/observability/inventory.js';
import { contextNow, splitUsage } from './lib/observability/usage.js';
import { buildSkillsView } from './lib/observability/skills-view.js';
import { IndexStore } from './lib/index-store.js';
import { searchTranscripts } from './lib/observability/search.js';
import { FileApi } from './lib/governance/file-api.js';
import { isInsideReal } from './lib/governance/real-path.js';
import { gitLimiter } from './lib/git-limiter.js';
import { collectSessionEdits } from './lib/surface/session-edits.js';
import { ledgerModel, lsFilesByRepo } from './lib/surface/ledger.js';
import { createSwrMemo } from './lib/surface/swr-memo.js';
import { surfaceConfig } from './lib/surface/config.js';
import { loadOperatorSettings, saveOperatorTimeZone, loadGuardAutoApprove, saveGuardAutoApprove } from './lib/operator-settings.js';
import { setDisplayTimeZone, displayTimeZone, zoneName } from '../web/shared/time-format.js';
import { adapters, detectAll } from './lib/adapters/index.js';
import { adapterHealth, reportMiss, clearMiss, persistAdapterHealth, loadAdapterHealth } from './lib/adapters/health.js';
// glmps-44: the channel-server.js writer runs in a different
// process (a spawned MCP child), so unlike adapterHealth() above there is no
// in-process registry to read - this snapshot is re-read from disk on every
// /api/alerts pass (see channel-health.js's header for why load-once-at-boot,
// the adapterHealth() pattern, does not apply here).
import { scutChannelHealth } from './lib/scut/channel-health.js';
import { retryUntilConnected, STOPPED as SCUT_CONNECT_STOPPED } from './lib/scut/connect-retry.js';
import { createSourceGuard } from './lib/observability/source-guard.js';
import { assertCanAct } from './lib/governance/act-gate.js';
import { sweepOldFiles, OLD_CLEANUP_DEFAULTS } from './lib/governance/old-cleanup.js';
import { prunePromptFiles } from './lib/orchestration/prompt-retention.js';
import * as decisionStore from './lib/observability/decision-log-store.js';
import { sweepRepos as sweepDecisionRepos, normalizeRepoList } from './lib/observability/decision-log-sweep.js';
import { computeGuiding } from './lib/observability/guiding.js';
import { annotateUnused } from './lib/orchestration/asset-scope.js';
import { detectGaps } from './lib/observability/gap-detect.js';
import { filterDispatchedWorktreeGaps } from './lib/observability/capability-feed-core.js';
import { doneGateEvents } from './lib/observability/done-gate-feed.js';
import { pageFeed, tsMs } from './lib/observability/feed-page.js';
import { sessionTouch } from './lib/observability/session-touch.js';
import { scanFleet } from './lib/observability/agent-fleet.js';
import { aggregateAgentUsage } from './lib/observability/agent-usage.js';
import { loopStage } from './lib/observability/loop-stage.js';
import { workPhase } from './lib/observability/work-phase.js';
import { gitStatus } from './lib/observability/git-status.js';
import { buildBoard, buildVitals, followupsBySession as countFollowups } from './lib/observability/stage-board.js';
import { inferObserved, scopeZone } from './lib/observability/workspace-observe.js';
import { computeDivergence } from './lib/orchestration/workspace-divergence.js';
import { workspaceSignal } from './lib/orchestration/workspace-signal.js';
import { spawnGraphifyUpdateWith, resolveGraphifyBin, runGraphifyWith, GRAPHIFY_UPDATE_TIMEOUT_MS } from './lib/orchestration/graphify-spawn.js';
import { readWorkspace, writeObserved, writeDivergence, writeDeclared, writeSteer } from './lib/orchestration/workspace-store.js';
import { registerRoute as publishRoute, createRouteRegistry } from './lib/observability/route-registry.js';
import { computeOutcomeMetrics } from './lib/evaluation/lens-outcome-metrics.js';
import { applyWorkspaceMeta } from './lib/orchestration/workspace-meta.js';
import * as learningStore from './lib/evaluation/learning-store.js';
import * as backlogStore from './lib/orchestration/backlog-store.js';
import { normalizeModelField, resolveCardModel, vendorEligibility, vendorById, buildVendorPrompt, modelRunRows, modelRunSummary, mergeVendorsConfig, parseVendorResult, vendorRunVerdict, runRecord, adapterSessionMatcher, tabSessionMatcher, DEFAULT_VENDOR, TAB_VENDORS, VENDOR_DONE_FILE, vendorTabName, vendorTabCommand, vendorSignalCheck, vendorSummaryText } from './lib/orchestration/vendor-agents.js';
import { canonicalTable, resolveProject as resolveCanonicalProject, makeAutoFiler, checkoutForProject, isRetiredProject } from './lib/orchestration/canonical-project.js';
import { createStateBackup } from './lib/kernel/state-backup.js';
import { readMaintenance, releaseOrphanedMaintenance } from './lib/kernel/maintenance.js';
import * as mergeQueue from './lib/orchestration/merge-queue.js';
import * as mergeUtil from './lib/orchestration/merge-util.js';
import * as mergeTests from './lib/orchestration/merge-tests.js';
import * as testedTrees from './lib/orchestration/tested-trees.js';
import * as mergeQueueRuns from './lib/orchestration/merge-queue-runs.js';
import * as mainSuite from './lib/orchestration/main-suite.js';
import * as batchReview from './lib/orchestration/batch-review.js';
import * as mergeExec from './lib/orchestration/merge-exec.js';
import { createMergeQueueDriver } from './lib/orchestration/merge-queue-driver.js';
import { relevantFilesFor, deferredRefsFor } from './lib/orchestration/ticket-enrich.js';
import * as runnerStore from './lib/orchestration/runner-store.js';
import { resolveEditor, editorCommand, installedEditors, companionInstalled, defaultProgramFiles, quoteCommand } from './lib/orchestration/editor-detect.js';
import { loadRoutingLog, appendRoutingLog, mergeRoutingLedger } from './lib/orchestration/routing-log.js';
import { detectConcurrentWriters, DEFAULT_STALE_MS } from './lib/orchestration/concurrent-writers.js';
import * as memoryScan from './lib/governance/memory-scan.js';
import { SEVERITY as POISON_SEVERITY, scanText, quarantineDecision } from './lib/governance/poison-scan.js';
import { TAP_PROTOCOL_HEADER, TAP_PROTOCOL, TAP_PROTOCOL_MIN, tapProtocolRefusal } from './lib/kernel/tap-protocol.js';
import { checkAccess, presentedTokenFrom, isLoopback, isLoopbackHost, tokenMatches, mintWikiTicket, wikiTicketScope, remoteBindPolicy, peerAddress, localSessionValue, LOCAL_SESSION_KEY_FILE, LOCAL_SESSION_HEADER, TAP_UPDATE_PATH } from './lib/governance/access-guard.js';
import { readOrCreateLaunchToken } from './lib/governance/launch-token.js';
import { computeProof, proofsMatch, sha256Hex } from './lib/governance/launch-auth.js';
import { createNonceGuard } from './lib/governance/launch-nonces.js';
import { loadActors, actorForToken, gateCheck } from './lib/governance/actors.js';
import { TOOL_REGISTRY, REFERENCE_TOOL } from './lib/observability/capture-registry.js';
import { collectAlerts, attachEvidence } from './lib/observability/alert-sources.js';
import { usageCaptureFindings, readUsageCaptureInputs } from './lib/observability/usage-capture-health.js';
import { loadAcks, ack as ackAlertId, unack as unackAlertId, applyAcks } from './lib/observability/alert-acks.js';
import { scanRepos as scanUnmergedRepos, detectUnmergedBranches, loadCherryCache, saveCherryCache, closableExec } from './lib/observability/unmerged-branches.js';
import { scanEventsForInjection } from './lib/governance/injection-detect.js';
import { detectEgress } from './lib/governance/egress-detect.js';
import { renderBaselineReport } from './lib/governance/report-export.js';
import { resolveBaselinePath, readBaseline, writeBaseline } from './lib/governance/baseline-store.js';
import { SUPPORTED_VENDORS, renderPolicyBody, mergeManagedSection, extractManagedSection, normalizeManagedBody, applyPush, validatePolicyUpdate } from './lib/governance/vendor-writers.js';
import { makeWritePathGuard } from './lib/governance/write-path-guard.js';
import { launchCwdCheck, launchCwdChecker } from './lib/governance/launch-roots.js';
// SCUT (the Slack chat layer). Imported unconditionally, started conditionally:
// startScut() below is a no-op unless credentials exist, so a server with no
// Slack app configured pays nothing but these module loads.
import { loadCreds as scutLoadCreds, credsPath as scutCredsPath } from './lib/scut/config.js';
import { resolveTheme as scutResolveTheme, radarChannelNames as scutRadarChannelNames } from './lib/scut/bobiverse.js';
import { createClaudeStreamPool, claudeCliAvailable } from './lib/plugins/claude-stream.js';
import { loadPersonas as huddleLoadPersonas, mergeSeats as huddleMergeSeats, validateSeats as huddleValidateSeats, DEFAULT_SEATS as HUDDLE_DEFAULT_SEATS } from './lib/huddle/roster.js';
import { createAgyBroker } from './lib/huddle/agy-broker.js';
import { createGitopsBroker, createShellSeams, isGitopsInfraError, DEFAULT_CLAIM_WAIT_MS, PICKUP_SAMPLES, pickupSummary } from './lib/orchestration/gitops-broker.js';
import { AGY_RESULT_MAX, AGY_MODELS, newestGeminiModel } from './lib/huddle/agy-models.js';
import { planCard as huddlePlanCard, actionCards as huddleActionCards, isWorkCommand as huddleIsWorkCommand } from './lib/huddle/decisions.js';
import { buildRecord as huddleBuildRecord, saveRecord as huddleSaveRecord, loadRecord as huddleLoadRecord, recordCard as huddleRecordCard, draftSpec as huddleDraftSpec } from './lib/huddle/record.js';
import { createHuddle } from './lib/huddle/session.js';
import { buildBrief as buildHuddleBrief } from './lib/huddle/brief.js';
import { createAgySeat } from './lib/huddle/agy-seat.js';
import { createResearcher } from './lib/huddle/researcher.js';
import { getBobMode as scutGetBobMode, setBobMode as scutSetBobMode, getAllowedUsers as scutGetAllowedUsers, getOutbound as scutGetOutbound, getAvatarBaseUrl as scutGetAvatarBaseUrl, getProjectSystems as scutGetProjectSystems } from './lib/scut/settings.js';
import { createSlackWeb } from './lib/scut/slack-web.js';
import { createSocketMode } from './lib/scut/socket-mode.js';
import { createEngine as createScutEngine, makeBobToggleHandler as makeScutBobToggle } from './lib/scut/engine.js';
import { makeGuard as makeScutGuard } from './lib/scut/guard.js';
import { makeApprovals as makeScutApprovals, approvalsConfig as scutApprovalsConfig, readLog as scutApprovalsLog, finishedRunNotes as scutFinishedRunNotes } from './lib/scut/approvals.js';
import { autoDeployDue, deployActionFor, mergeIsLive } from './lib/orchestration/auto-deploy.js';
import { createLiveNoticeLoop, createLiveNoticeGit, gitFailureText, LIVE_NOTICE_LOOP } from './lib/orchestration/live-notice-loop.js';
import { runApprovalAction as scutRunApprovalAction, checkHealth as scutCheckHealth } from './lib/scut/approval-run.js';
import { makeRestartAllRunner } from './lib/scut/restart-all.js';
import { appIsStale, readAppTreeId } from './lib/kernel/app-stamp.js';
import { verifyDeployedHealthz, readRepoHead } from './lib/kernel/deploy-verify.js';
import { makeDedup as makeScutDedup } from './lib/scut/dedup.js';
import { makePresence as makeScutPresence } from './lib/scut/presence.js';
import { makeRouter as makeScutRouter } from './lib/scut/router.js';
import { writeRoleSettings } from './lib/governance/role-permissions.js';
import { configDefaults, SCUT_DEFAULTS, HUDDLE_DEFAULTS } from './lib/config-defaults.js';
import { mergeGraphConfig, classifyGraphRootsAsync, inScopeRoots, gitProbeAsync, cachedProbeAsync } from './lib/observability/graph-scope.js';
import {
  MACHINE_SCAN_DEFAULTS, parseGraphScope, loadMachineState, saveMachineState, effectiveGraphConfig, applyOptIn,
  machineGraphPaths, shipGraphPaths, machineGraphStale, buildMachineGraph, graphLabel,
} from './lib/observability/graph-machine.js';
import { planScopeMigration, appendScopeArchive } from './lib/observability/graph-scope-migrate.js';
import { buildShipGraph } from './lib/observability/graph-ship-build.js';
import { channelLaunchPlan as scutChannelLaunchPlan, appendArgs as scutAppendArgs, mergeApproval as scutMergeApproval } from './lib/scut/channel-launch.js';
import { makeNotifier as makeScutNotifier } from './lib/scut/notify.js';
import { getRoom as scutGetRoom, bindRoom as scutBindRoom, findRoomByTicket as scutFindRoomByTicket, findRoomBySession as scutFindRoomBySession, roomsPath as scutRoomsPath, planRebinds as scutPlanRebinds, listRooms as scutListRooms } from './lib/scut/room-mapper.js';
import { isParked as parkIsParked, stampPoll as parkStampPoll, takePending as parkTakePending, queueNote as parkQueueNote, bankStretch as parkBankStretch, parkWaitMs as scutParkWaitMs, pickEviction as parkPickEviction, releaseTarget as scutReleaseTarget, ticketActivityMs as scutTicketActivityMs, STALE_MS as scutStaleMs } from './lib/scut/park.js';
import { noteProvenance as scutNoteProvenance, decideWakeDelivery as scutDecideWakeDelivery } from './lib/scut/wake-delivery.js';
import { GRAPH_CATALOG } from './lib/loops/loop-about.js';
import { createParkSweepLoop as createScutParkSweepLoop, PARK_SWEEP_LOOP as SCUT_PARK_SWEEP_LOOP } from './lib/scut/park-sweep-loop.js';
import { planRunSessionRecords, activityEntryFor, ledgerPatchFor, diagnoseUnrecorded, recordLaunchSessionSafe, REOPENABLE_STATES } from './lib/scut/reopen.js';
import { createReopenLoop as createScutReopenLoop, REOPEN_LOOP as SCUT_REOPEN_LOOP, REOPEN_EVENT as SCUT_REOPEN_EVENT, rejoinEmitFailure } from './lib/scut/reopen-loop.js';
import { projectForChannelName as scutProjectForChannelName, channelsPath as scutChannelsPath } from './lib/scut/channel-map.js';
import { pendingReopensPath as scutPendingReopensPath, addPendingReopen as scutAddPendingReopen, hasPendingReopen as scutHasPendingReopen, listPendingReopens as scutListPendingReopens, takePendingReopens as scutTakePendingReopens, restorePendingReopens as scutRestorePendingReopens, nextDrainAction as scutNextDrainAction, drainConsumed as scutDrainConsumed, MAX_DRAIN_ATTEMPTS as SCUT_MAX_DRAIN_ATTEMPTS } from './lib/scut/pending-reopens.js';
import { ticketChannelsPath as scutTicketChannelsPath, bindTicketChannel as scutBindTicketChannel, ticketForChannel as scutTicketForChannel, channelForTicket as scutChannelForTicket, markHidden as scutMarkChannelHidden, listTicketChannels as scutListTicketChannels, originThread as scutOriginThread } from './lib/scut/ticket-channels.js';
import { retainedJobIds as scutRetainedJobIds } from './lib/scut/ticket-retention.js';
import { ticketChannelPlan as scutTicketChannelPlan, visibilityAction as scutVisibilityAction, closingSummary as scutClosingSummary, openChannelPlan as scutOpenChannelPlan } from './lib/scut/ticket-channel-ops.js';
import { hideTicketChannel as scutHideTicketChannel, unhideTicketChannel as scutUnhideTicketChannel } from './lib/scut/ticket-visibility.js';
import { planCloseSync, planSessionGuard, PROMOTED_NOTE, MAX_HIDES_PER_RUN } from './lib/scut/close-sync.js';
import { createSessionCloser, lastWriteWithHelpers } from './lib/orchestration/session-closer.js';
import { makeHeartbeat as makeScutHeartbeat } from './lib/scut/heartbeat.js';
import { getHeartbeatMinutes as scutGetHeartbeatMinutes, getParkHours as scutGetParkHours } from './lib/scut/settings.js';
import { postAs as scutPostAs } from './lib/scut/provision.js';
import { splitRelayText as scutSplitRelayText, createRelayQueue as scutCreateRelayQueue } from './lib/scut/relay.js';
import { collectAttachments as scutCollectAttachments } from './lib/scut/attachments.js';
import { planProgress, progressCheckIn, formatCheckIn } from './lib/scut/progress.js';
import { readProgress as scutReadProgress, recordPosted as scutRecordPosted } from './lib/scut/progress-store.js';
// a card's intent/spec/plan chain, read by the plan gate hook
// (hooks/plan-gate.js) over HTTP so the hook itself carries no state-store
// knowledge beyond one GET.
import { cardChain } from './lib/kernel/chain.js';
import { classifyTask } from './lib/evaluation/task-classify.js';
import { readCapped } from './lib/observability/append-log.js';
import {
  load as camLoad,
} from './lib/governance/cross-agent-memory-store.js';
import {
  computeMemoryAttestation, runTrialTick, memoryAttestationAlerts,
} from './lib/governance/cross-agent-memory.js';

import { otelToEvents, groupBySession } from './lib/observability/otel-bridge.js';
import { summarizeAlerts } from './lib/observability/alerts.js';
import { groupAlerts, morningDigest } from './lib/observability/alert-groups.js';
import { TARGET_IDS, TARGET_LABELS, IDE_TARGETS, liveIdeTargets, companionFileName, resolveTarget, launchTargetFor, seededCommand, resumedCommand, resumeCommand, nativeTerminalRecipe, companionRecord, companionRequestsFile, staleCompanionRequests } from './lib/orchestration/editor-targets.js';
import { guardedSpawn, shellSafePath, shellSafePathSyntax, shellArg } from './lib/orchestration/guarded-spawn.js';
import { createLaunchBroker, LAUNCH_ORIGINS, launchQueueStaleness } from './lib/orchestration/launch-broker.js';
import { buildPersonality, openOnlyRoots } from './lib/personality/index.js';
import { pickNextJob, blockedQueued, releasableHeld, shouldClaim, slotUsage, hasCapacity, isOperatorCard, reconcileLedger, shouldIsolate, worktreePlan, worktreeAddRecipe, worktreePruneRecipe, worktreeFetchRecipe, upstreamRefRecipe, launchHeader, buildSeedDoc, reopenSeedSection, actorForJob, reclaimVerdict, resolveRoute, resolveSkills, operatorReply, launchMode, openChildren, hostOpen } from './lib/orchestration/queue-runner.js';
import { hostsReadyToClose } from './lib/orchestration/orphans.js';
import { orphanSweepLoop } from './lib/orchestration/orphan-sweep.js';
import { loadSkillCues, withWakeSkills } from './lib/orchestration/skill-cues.js';
import { buildMemoryApplyCommand, ingestResults, repoSlug } from './lib/evaluation/learning-apply.js';
import { landGuard, unlandGuard } from './lib/evaluation/guard-lesson.js';
import { AUTO_APPROVER } from './lib/evaluation/reflex-gate.js';
import { POLICY as AUTO_APPROVE_POLICY, runAutoApproveTick, revertRecord, readAutoApproveState, writeAutoApproveState } from './lib/evaluation/guard-auto-approve.js';
import { sectionBodyLines } from './lib/evaluation/learning-templates.js';
import { runGepa, refreshGepaQuarantineHealth } from './lib/plugins/gepa-plugin.js';
import { DEFAULT_SIM_THRESHOLD } from './lib/evaluation/semantic-dedup.js';
import { retireCandidatesFromTemplates, staleGuardCandidatesFromTemplates, DEFAULT_STALE_DAYS, DEFAULT_RETIRE_DAYS } from './lib/evaluation/guard-retire.js';
import { consolidateCandidates, memoryEntriesFromDir, guardEntriesFromClaudeMd } from './lib/evaluation/memory-consolidate.js';
import { buildTerminalRequest } from './lib/orchestration/terminal-request.js';
import { outcomeRecord, writeOutcome, flagKept, markRemoved, removalVerdict, gatherWorktreeFacts, integrationRefsFor, whenSettled } from './lib/orchestration/worktree-outcome.js';
import { sessionWorktreePlan, safeSeg as wtSafeSeg, pathsEqual, worktreeCheckoutRecipe, addWorktree, branchOwnerFromStderr, remoteDefaultRefRecipe, REMOTE_DEFAULT_REF_ARGS } from './lib/orchestration/worktrees.js';
import { testRealGitWriteRefused } from './lib/orchestration/test-write-guard.js';
import { readUsage, appendSnapshot } from './lib/observability/usage-store.js';
import { readProviderSpend } from './lib/observability/provider-spend.js';
import { createOpenPrsSource, openPrStates } from './lib/observability/open-prs.js';
import { readActionsMinutes, readActionsMinutesDoc, writeActionsMinutesDoc, refreshActionsMinutes, actionsMinutesFindings, pendingPosts, ghArgs as actionsGhArgs } from './lib/observability/actions-minutes.js';
import { readQaTrends, qaTrendsView, sampleLatestRun, qaTrendsTick, repoFromRemote } from './lib/observability/qa-trends-store.js';
import { appendVitalsPoint, readVitalsTrends, sampleVitals, parseWindowMs, decideAlertsSource, ALERTS_MAX_STALE_MS } from './lib/observability/vitals-trends-store.js';
import { extractUsage as extractCopilotOtelUsage, toSnapshots as copilotOtelSnapshots, toFeedEvents as copilotOtelFeed } from './lib/observability/copilot-otel.js';
import { readOutcomes } from './lib/evaluation/outcome-store.js';
import { summarizeOutcomes, summarizeByActor, isPromptEvent, otherShare } from './lib/evaluation/outcome-metrics.js';
import { finalizeSession, createSessionOutcomeLookup } from './lib/evaluation/session-outcome.js';
import { createSessionLearningLookup } from './lib/evaluation/session-learning.js';
import { sessionRefusals } from './lib/governance/session-refusals.js';
import { runFinalizeSweep } from './lib/evaluation/finalize-sweep.js';
import { promptVersionFor } from './lib/evaluation/prompt-version.js';
import { listReplayTasks, refreshReplayBaseline } from './lib/evaluation/replay-set.js';
import { seedReplaySet } from './lib/evaluation/replay-seed.js';
import { runReplayTask, validModel } from './lib/evaluation/replay-launch.js';
import { scoreReplay, scoreReplayHistory } from './lib/evaluation/replay-score.js';
import { promotionView } from './lib/evaluation/promotion-view.js';
import { recordShadow, shadowRates, lastFiredByClass, firedCountInWindow } from './lib/evaluation/shadow-arm.js';
import { buildSystemChanges, buildLoopMetrics, buildLiveness, DEFAULT_WINDOW_DAYS as LOOP_DEFAULT_WINDOW_DAYS, MS_PER_DAY as LOOP_MS_PER_DAY } from './lib/evaluation/system-changes.js';
import { registerProducer, collectSignals, _resetProducers } from './lib/evaluation/signal-producer.js';
import { upsertMeasurable, listMeasurables, getMeasurable, addLabel } from './lib/evaluation/measurables-store.js';
import { buildMeasurablesScoreboard } from './lib/evaluation/measurables-scoreboard.js';
import { measurableFromGuardCandidate, measurableFromSkillCandidate, measurableFromWorkspaceSignal } from './lib/evaluation/measurable-persist.js';
import { upsertGapAndApply } from './lib/evaluation/gap-pipeline.js';
import { coveredCodesFromFile, GUARD_TEMPLATES } from './lib/evaluation/guard-coverage.js';
import { INGEST_ROUTES, INGEST_MAX_BODY_BYTES } from './lib/ingest-routes.js';
import { registerLoopsRoutes } from './lib/routes/loops-routes.js';
import { registerBacklogRoutes } from './lib/routes/backlog-routes.js';
import { registerLessonsRoutes } from './lib/routes/lessons-routes.js';
import { registerWorkspaceRoutes } from './lib/routes/workspace-routes.js';
import { registerTapRoutes } from './lib/routes/tap-routes.js';
import { registerSurfaceRoutes } from './lib/routes/surface-routes.js';
import { registerPluginsRoutes } from './lib/routes/plugins-routes.js';
import { registerGuardsRoutes } from './lib/routes/guards-routes.js';
import { registerMergeQueueRoutes } from './lib/routes/merge-queue-routes.js';
import { registerLearningIntegrityRoutes } from './lib/routes/learning-integrity-routes.js';
import { registerCrossAgentMemoryRoutes } from './lib/routes/cross-agent-memory-routes.js';
// Platform autonomy (docs/handoff-platform-autonomy-v2.md): learning integrity,
// the reconciliation registry and the nightly run.
import { buildBrief } from './lib/observability/morning-brief.js';
import { readSpineEvents, emitSpineEvent, SPINE_KINDS } from './lib/observability/spine.js';
import { headRef } from './lib/observability/head-ref.js';
import { runReconciliation, reconciliationConfig } from './lib/observability/reconciliation.js';
import { gateRunsFromSpine, orphanedArtifactsFromSpine, lessonsForIntegrity } from './lib/observability/integrity-context.js';
import { readLessonRows, lessonsCurrent } from './lib/evaluation/lesson-ledger.js';
import { activeLessons, runDecaySweep } from './lib/evaluation/lesson-decay.js';
import { isPromoted } from './lib/evaluation/reflex-gate.js';
import { learningIntegrityConfig } from './lib/evaluation/learning-integrity-config.js';
import { runRevertSweep } from './lib/evaluation/revert-sweep-run.js';
import { readWatermark } from './lib/observability/revert-scan.js';
import { recordTouch, readTouches, autonomyMetrics, TOUCH_TYPES, currentTiers, runGraduationSweep } from './lib/evaluation/autonomy-telemetry.js';
import { alertsToGaps } from './lib/observability/alert-learn.js';
import { loadAlertSeen, saveAlertSeen } from './lib/observability/alert-seen.js';
import { getMemoryDistillConfig } from './lib/evaluation/memory-distill-config.js';
import { enqueue as mdEnqueue } from './lib/evaluation/memory-distill-queue.js';
import { listProposals as mdListProposals, approveProposal as mdApproveProposal, rejectProposal as mdRejectProposal } from './lib/evaluation/memory-writer.js';
import { drainQueue as mdDrainQueue } from './lib/evaluation/memory-distill-worker.js';
import { runSweep as mdRunSweep, sanitizeRoot as mdSanitizeRoot } from './lib/evaluation/memory-distill-sweeper.js';
import { refreshUsage as memRefreshUsage, readUsage as memReadUsage } from './lib/evaluation/memory-usage-store.js';
import { runEviction as memRunEviction, budgetFromEnv as memBudget, parseIndex as memParseIndex, pinnedTargets as memPinned } from './lib/evaluation/memory-evict-runner.js';
import { evictionPlan as memEvictionPlan } from './lib/evaluation/memory-evict.js';
import { lookupFacts as memLookupFacts, faultIn as memFaultIn } from './lib/evaluation/memory-fault.js';
import { readProbes as memReadProbes, scoreProbes as memScoreProbes, demotionAllowed as memDemotionAllowed } from './lib/evaluation/memory-probe.js';
import { readBudget, combineBudget } from './lib/observability/budget.js';
// D23/D24 loop plugins: memory cutover (glmps-159 task 6). The Mem0 plugin
// is now the memory loop; pre-D23 distillation/promotion is retired.
import { loadAdapter } from '../plugins/host.js';
import { createMemoryWorker } from './lib/plugins/memory-worker-client.js';
import { createRetryQueue } from './lib/plugins/retry-queue.js';
import { createSingleFlight } from './lib/plugins/single-flight.js';
import {
  lookup as memPluginLookup, migrateDistilled, readAllDistilledFacts, projectSlugFor, wrapChatCompletionForMem0, refreshQuarantineHealth,
} from './lib/plugins/memory-plugin.js';
// D23/D24 loop plugins: judge cutover (glmps-159 task 8). Every finished
// session gets a classification and an independent verdict from the judge
// plugin, a different actor from the session that did the work; the old
// classifyTask() heuristic is deleted from the outcome-row path (task-
// classify.js itself stays - queue-runner.js's resolveRoute is its only
// remaining caller, never ported).
import { readVerdicts, judgeSummary, getJudgeConfig } from './lib/plugins/judge-plugin.js';
import { pickTitle, cleanFirstPrompt } from './lib/observability/session-title.js';
import { worktreeParent, worktreeInfo } from './lib/orchestration/worktree-project.js';
import { dedupeByCommonDir } from './lib/orchestration/git-common-dir.js';
import { sweepSessionWorktrees, worktreeRemoveSafeRecipe, jobIdFromRunnerBranch } from './lib/orchestration/worktree-sweeper.js';
import { dirInUse, writeReclaimMarker, clearReclaimMarker } from './lib/orchestration/worktree-occupancy.js';
import { gateConfig, gateDeadlineMs, describeWait } from './lib/orchestration/gate-config.js';
import {
  readControl as ctlReadControl, setStop as ctlSetStop, clearStop as ctlClearStop,
  openGate as ctlOpenGate, decideGate as ctlDecideGate, findGate as ctlFindGate,
} from './lib/orchestration/control-store.js';
import { engagementView, loadProfile, deriveTierRoots } from './lib/chassis/profile.js';
// Skill capability-lifecycle (glmps-87 adopt / glmps-88 archive+update) - 
// docs/superpowers/plans/2026-07-09-skill-capability-lifecycle.md.
import { getObservedSince, recordFirstSeen } from './lib/evaluation/skill-observation-log.js';
import { archiveCandidates, staleArchiveCandidates } from './lib/evaluation/skill-retire.js';
// Agent capability-lifecycle (glmps-166 Task 9) - same shape as the skill
// pair above, applied to the installed agent roster instead of skills.
import { recordFirstSeen as recordAgentFirstSeen, getObservedSince as getAgentObservedSince } from './lib/evaluation/agent-observation-log.js';
import { agentRetireCandidates, DEFAULT_MIN_OBSERVATION_DAYS as AGENT_MIN_OBS_DAYS } from './lib/evaluation/agent-retire.js';
// Routing compliance (glmps-166 Task 11) - did a routed card's session
// actually dispatch the agent the runner named.
import { computeRoutingCompliance } from './lib/evaluation/routing-compliance.js';
import { loadProvenance, saveProvenance, checkForUpdates, updateCandidates } from './lib/evaluation/skill-provenance.js';
import { getSkillLifecycleConfig } from './lib/evaluation/skill-lifecycle-config.js';
import * as skillAdoptStore from './lib/evaluation/skill-adopt-store.js';
import { listRegistrySkills, matchGapToCandidate, DEFAULT_GAP_MATCH_THRESHOLD } from './lib/governance/skill-registry-scan.js';
import { filterEligibleAdoptCandidates } from './lib/governance/skill-adopt-prefilter.js';
import { loadEngagementProfileFromFile } from './lib/evaluation/engagement-profile.js';
import { createChatCompletion, getModelConfig, runClaude } from './lib/plugins/claude-model.js';
import { createLoopRegistry } from './lib/loops/registry.js';
import { registerPluginLoops } from './lib/loops/plugin-loops.js';
import { createMemoryAdapter, createJudgeAdapter, createGepaAdapter } from './lib/loops/plugin-adapters.js';
import { handleLoopStreak, handleFreshnessExpiry } from './lib/loops/auto-diagnosis.js';
import { buildHealthz, readBootVersion, createEventLoopDelayMonitor } from './lib/kernel/healthz.js';
import { createBootTrace } from './lib/kernel/boot-trace.js';
import { captureCpuProfile, analyzeProfile, keepProfile, trackSpawns } from './lib/kernel/cpu-profile.js';
import { watchParent } from './lib/kernel/parent-watch.js';
import { isServiceMode, serviceRestart } from './lib/kernel/service-mode.js';
import { kernelCrashAlerts } from './lib/kernel/crash-records.js';
import { recordStart, recordStop, noteStopOverrun, readStarts, startsSummary, kernelStartAlerts, requesterOf } from './lib/kernel/start-reason.js';
import { openObligationStore, OBLIGATION_KINDS } from './lib/kernel/obligations.js';
import { openClientStore } from './lib/kernel/clients.js';
import { tlsConfigured, loadServerTls, ensureClientCa } from './lib/kernel/tls-material.js';
import { certExpiryFindings } from './lib/kernel/cert-expiry.js';
import { issueClientCert, validTapPublicKey } from './lib/kernel/x509-lite.js';
import { openTapIngest, validateBatch, TAP_INGEST_MAX_BYTES } from './lib/kernel/tap-ingest.js';
import { openTapMirror } from './lib/kernel/tap-mirror-store.js';
import { openTapGit, canonicalRemote, TAP_GIT_MAX_BYTES } from './lib/kernel/tap-git.js';
import { createTapGitClonesLoop, cloneDirFor } from './lib/kernel/tap-git-clones.js';
import { serverPathsFor, clientMirrorDir, namespaceSessionId, validClientId, splitNamespacedId } from './lib/kernel/tap-mirror.js';
import { resolveTarget as resolveClientTarget, ownerOfSession } from './lib/kernel/client-actions.js';
import { createClientFileCall } from './lib/kernel/client-file-call.js';
import { createPairing } from './lib/kernel/pairing.js';
import { createTapRelease } from './lib/kernel/tap-release.js';
import { loopObligations, obligationSweeperLoop, closeGateVerdict, createSuspendDetector, rebaseForSuspend, overdueNotice } from './lib/kernel/obligation-sweeper.js';
import { ticketIdForSession, reconcileGateObligation, reconcileOpenGateRows } from './lib/kernel/gate-reconcile.js';
import { createGitRemoteFeedLoop, stripRemoteUserinfo } from './lib/kernel/git-remote-feed.js';
import zlib from 'node:zlib';
import { writeJson } from './lib/http-json.js';
import { createSessionCardLookup, withCards } from './lib/orchestration/session-cards.js';
import { buildSlimState, pickFields, SLIM_HISTORY } from './lib/state-slim.js';
import { buildTimeline, clampHours } from './lib/timeline.js';
import { dbFileFor, stateFile, readPathFor, rebaseLegacyStatePath } from './lib/state-dir.js';

const WEB_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'web');
const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
// Read once at boot and scrubbed, so the git, agent and tool children this
// server spawns do not inherit "I am supervised" and misbehave on their own restarts.
const SUPERVISED_AT_BOOT = process.env.GLMPS_SUPERVISED === '1';
delete process.env.GLMPS_SUPERVISED;

// the real spawn-and-wait for ONE `graphify
// update <root>` call, shared by graphRebuildTick, the wiki loop maker's
// refreshGraph and POST /api/graph/rebuild through graphifyUpdate() below,
// all three wrapped in the SAME per-root single-flight guard so two of them
// never write the same root's graph.json at once (the 2026-07-28 collapse-
// incident class). windowsHide (CREATE_NO_WINDOW) gives the child its own
// hidden console that its python/git descendants inherit; never detached
// (on Windows DETACHED_PROCESS overrides CREATE_NO_WINDOW, popping a
// visible console for every descendant).
function defaultSpawnGraphifyUpdate(root, { timeout = GRAPHIFY_UPDATE_TIMEOUT_MS } = {}) {
  return spawnGraphifyUpdateWith({ resolveBin: resolveGraphifyBin }, root, { timeout });
}

// mirrors the wiki loop's own default
// runBuild guard (R-M4) -- a test process with no spawnGraphifyUpdate
// override given must never spawn a real graphify process. A pure
// rejection, no fs/process access at all, so there is nothing further to
// inject: the refusal itself is the guard.
function testRefusingSpawnGraphifyUpdate() {
  return Promise.reject(new Error('graphify update refused: isTestProcess() is true and no spawnGraphifyUpdate override was given'));
}

// `graphify merge-graphs` for the merged machine graph (card glmps-2-0-101),
// injectable as mergeGraphs; refuses under isTestProcess like the update seam.
function defaultMergeGraphs(files, out) {
  return runGraphifyWith({
    resolveBin: resolveGraphifyBin,
    runCmd: (bin, args) => new Promise((res) => {
      execFile(bin, args, { encoding: 'utf-8', windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONHASHSEED: '0' } },
        (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || String(err?.message ?? '') }));
    }),
  }, ['merge-graphs', ...files, '--out', out]);
}
function testRefusingMergeGraphs() {
  return Promise.reject(new Error('graphify merge-graphs refused: isTestProcess() is true and no mergeGraphs override was given'));
}

// the three real-process/network seams
// graphifyVersionTick depends on (uvx/uv/graphify install + rollback, the
// PyPI version lookup, and the installed-version check), injectable via
// graphifyVersionOverrides so a test can drive the tick's own audit/
// rollback decision without ever running a real uv/uvx/PyPI/graphify call.
// Each default REFUSES under isTestProcess({ env }) when no override was
// given -- mirrors spawnGraphifyUpdate's own guard (M2) exactly.
function testRefusingGraphifyVersionRunCmd(bin) {
  return Promise.reject(new Error(`graphify version tick refused: isTestProcess() is true and no graphifyVersionOverrides.runCmd override was given (tried to run '${bin}')`));
}
function testRefusingLatestGraphifyVersion() {
  return Promise.reject(new Error('graphify version tick refused: isTestProcess() is true and no graphifyVersionOverrides.latestGraphifyVersion override was given'));
}
function testRefusingGraphifyVersionCheck() {
  return Promise.reject(new Error('graphify version tick refused: isTestProcess() is true and no graphifyVersionOverrides.graphifyVersion override was given'));
}

// the real spawn for a non-repo-root
// POST /api/wiki/rebuild (the structural-only, no-LLM case is left to run
// for real even in a test process -- see spawnWikiRebuildCli's own comment
// above in startServer's parameter list).
function defaultSpawnWikiRebuildCli(cliArgs, { cwd, timeout = 300000 } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, cliArgs, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => res({ code, stderr }));
    child.on('error', (err) => res({ code: 1, stderr: String(err?.message ?? err) }));
  });
}

const PKG = readJsonSafe(path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'package.json')) ?? {};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const MAX_BODY = 5 * 1024 * 1024; // editor payload cap
const WIKI_ASK_SYSTEM = 'You answer questions about a codebase using only the wiki excerpts in the prompt. Cite sections as [slug]. Answer in Markdown. Never use em-dashes.';
// an OTLP export is far smaller than an editor payload; 1 MiB bounds what
// one unauthenticated-looking exporter post can push into the event spine.
const OTLP_MAX_BYTES = 1024 * 1024;
const OTLP_DRAIN_MAX = 16 * 1024 * 1024;
// generated wiki pages (LLM output, or repo-supplied HTML for /wiki-ext)
// are untrusted. sandbox makes them an opaque origin even when opened
// top-level, so their script can never call the kernel API as the dashboard.
// Scan 2026-10-15 F5: the page's script may read the wiki ticket in its own
// URL, so it gets no fetch/XHR/beacon/WebSocket, no form posts, no remote
// images and no nested frames or plugins. Its own scripts and stylesheet
// (/vendor, /observability) stay allowed; generated pages draw inline SVG.
const UNTRUSTED_HTML_CSP = "sandbox allow-scripts; connect-src 'none'; form-action 'none'; img-src data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'";
const UNTRUSTED_HTML_HEADERS = Object.freeze({ 'content-security-policy': UNTRUSTED_HTML_CSP, 'x-content-type-options': 'nosniff' });

const branchCache = new Map(); // root -> { value, ts }
function branchFor(root) {
  const hit = branchCache.get(root);
  if (hit && (Date.now() - hit.ts) < 15000) return Promise.resolve(hit.value);
  return new Promise(res => {
    execFile('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true }, (e, out) => {
      const value = e ? null : out.trim();
      branchCache.set(root, { value, ts: Date.now() });
      res(value);
    });
  });
}
function normRoot(p) { return p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : ''; }

// Async (non-blocking) git exec for the unmerged-branch scan and the
// worktree sweeper. Both used to inject an `execFileSync` wrapper here,
// which - spawned once per branch per repo, across every known repo root - 
// blocked the entire Node event loop (every concurrent HTTP request queues
// behind a synchronous subprocess call) for anywhere from several seconds to
// tens of seconds on a workstation with dozens of repos/branches. execFile
// yields control back to the event loop between calls, so other requests
// (and other timers) keep being served while this runs.
function execFileAsync(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}
// The TLS peer certificate as the access guard reads it; null on plain HTTP or
// when the caller sent none. `authorized` is the chain check against the
// client-issuing CA (the listener's only `ca`), validity dates included.
function peerClientCert(socket) {
  if (!socket?.encrypted || typeof socket.getPeerCertificate !== 'function') return null;
  const c = socket.getPeerCertificate();
  if (!c || !c.fingerprint256) return null;
  return { fingerprint256: c.fingerprint256.replace(/:/g, '').toLowerCase(), authorized: socket.authorized === true };
}
// Bound how many `git` child processes this process ever has in flight at
// once. Both scanRepos and sweepSessionWorktrees fan out with Promise.all
// (repos x branches) for wall-clock speed, which without a cap could spawn
// hundreds of concurrent subprocesses on a workstation with many repos/
// branches (real process-creation + AV-scan overhead per spawn on Windows
// then makes the *concurrent* version slower, or under parallel test-file
// load starves the whole machine, than the sequential one it replaced). The
// limiter itself lives in lib/git-limiter.js and is shared with the surface
// routes' repoTree/fileDiff, so the cap is process-wide rather than
// per-caller.
const gitExecAsync = (file, args) =>
  gitLimiter(() => execFileAsync(file, args, { encoding: 'utf-8', timeout: 4000, windowsHide: true }));

// A git or process call for the request and tick paths: never blocks the event
// loop, never rejects (a failure is a non-zero status with stderr), bounded by
// the same process-wide limiter as the scans, and always has a timeout.
const defaultRunAsync = (file, args, { cwd, timeout = 30_000 } = {}) => gitLimiter(() => new Promise((resolve) => {
  execFile(file, args, { cwd, encoding: 'utf-8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({
      status: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: stdout ?? '',
      stderr: gitFailureText(err, stderr, timeout),
    });
  });
}));

// Non-blocking, TTL-cached git working-tree status for the stage board. Same
// stale-while-revalidate shape as branchCache above: /api/state stays sync and
// never waits on a git child; a background refresh (bounded by gitLimiter) fills
// the cache within a poll or two. Deduped per dir via an in-flight set.
const gitStatusCache = new Map();      // normalized dir -> { value, ts }
const gitStatusInflight = new Set();   // normalized dir currently being refreshed
const GIT_STATUS_TTL = 4000;
function gitStatusFor(dir) {
  const key = normRoot(dir);
  if (!key) return null;
  const hit = gitStatusCache.get(key);
  const fresh = hit && (Date.now() - hit.ts) < GIT_STATUS_TTL;
  if (!fresh && !gitStatusInflight.has(key)) {
    gitStatusInflight.add(key);
    gitStatus(dir, gitExecAsync)
      .then(value => gitStatusCache.set(key, { value, ts: Date.now() }))
      .catch(() => gitStatusCache.set(key, { value: null, ts: Date.now() }))
      .finally(() => gitStatusInflight.delete(key));
  }
  return hit ? hit.value : null; // stale-while-revalidate; null until first refresh lands
}

// Exported for testability: proves a test
// process never scans the operator's real extensions dir or install path,
// without needing to boot a server and hit /api/icon/:tool.
export function resolveIcons() {
  // Phase K final review (minors wave): findCCIcon/findAgIcon used to scan
  // the operator's REAL .antigravity-ide/.vscode extensions dir and
  // LOCALAPPDATA install path unconditionally - this is the one module-level
  // resolver that runs before any server instance (and its own getPaths()
  // call) exists, so there is no P to route through; isTestProcess() is the
  // same signal getPaths() itself uses.
  const testProcess = isTestProcess();
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

  // claude-code: newest anthropic.claude-code-* in .antigravity-ide/extensions, else .vscode/extensions
  function findCCIcon() {
    if (testProcess) return null;
    const bases = [
      path.join(home, '.antigravity-ide', 'extensions'),
      path.join(home, '.vscode', 'extensions'),
    ];
    for (const base of bases) {
      try {
        const entries = fs.readdirSync(base);
        const matches = entries
          .filter(e => e.startsWith('anthropic.claude-code-'))
          .sort()
          .reverse();
        for (const m of matches) {
          const candidate = path.join(base, m, 'resources', 'claude-logo.svg');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* not found */ }
    }
    return null;
  }

  // antigravity: fixed path under LOCALAPPDATA
  function findAgIcon() {
    if (testProcess) return null;
    const candidate = path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'out', 'vs', 'platform', 'browserOnboarding', 'static', 'antigravity.svg');
    return fs.existsSync(candidate) ? candidate : null;
  }

  const base = {
    'claude-code': findCCIcon(),
    'antigravity': findAgIcon(),
  };
  return {
    ...base,
    // Antigravity-family tools share the Antigravity icon
    'agy-cli': base['antigravity'],
    // Tools without an install-resolved logo ship a bundled brand mark.
    'codex-cli': path.join(WEB_DIR, 'icons', 'codex.svg'),
    'hermes': path.join(WEB_DIR, 'icons', 'hermes.svg'),
  };
}

const ICON_PATHS = resolveIcons();

export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    model: {
      id: raw.model?.id ?? null,
      displayName: raw.model?.display_name ?? raw.model?.displayName ?? raw.model?.id ?? null,
    },
    context: { usedPercent: raw.context_window?.used_percentage ?? raw.context?.usedPercent ?? null },
    cost: { totalUsd: raw.cost?.total_cost_usd ?? raw.cost?.totalUsd ?? null },
    rateLimits: raw.rate_limits ?? raw.rateLimits ?? null,
    sessionName: raw.session_name ?? null,
    capturedAt: raw.capturedAt ?? null,
  };
}

/**
 * Pure. Deep-merges `outcomes.finalizeSweep` over its own defaults (GLMPS 2.0
 * shadow-instance plan, Task 1; final-fix-wave item 6): a config.json that
 * sets only `outcomes.finalizeSweep.enabled` must still keep tickMs/maxAgeMs
 * at their defaults, because the top-level `Object.assign` in startServer is
 * shallow and would otherwise let a partial block wipe the rest of the
 * sub-object. Exported so this deep-merge is unit-testable without booting a
 * server. `enabled` defaults false: production's own Stop hook already pings
 * POST /api/outcomes/finalize on every turn, so only an isolated instance
 * with none wired to it (the 2.0 shadow) needs this periodic sweep at all.
 * `maxAgeMs` defaults to 24h so a fresh shadow state dir does not finalize
 * and queue a judge call for every historical session already in the index.
 */
export function mergeFinalizeSweepConfig(outcomes = {}) {
  const src = outcomes || {};
  return {
    ...src,
    finalizeSweep: { enabled: false, tickMs: 300000, maxAgeMs: 86400000, ...(src.finalizeSweep || {}) },
  };
}

// Server close() gives each open huddle's end() this long, then closes its pool
// regardless. Under SERVICE_RESTART_CLOSE_TIMEOUT_MS (8 s) so scut.stop() and
// the rest of close() still run before a service restart exits.
const HUDDLE_CLOSE_DEADLINE_MS = 5000;
// After the pools close, an in-flight say request gets this long to answer
// (5000 + 1000 still leaves close() inside the 8 s restart race).
const HUDDLE_SAY_DRAIN_MS = 1000;

// Scan F3: what a paired client's token may do to a backlog card. An allowlist,
// so a field added to the store later is refused to clients until listed here.
const CLIENT_BACKLOG_STATES = new Set(['held', 'idle']);
const CLIENT_PATCH_FIELDS = new Set(['labels', 'removeLabels', 'comment', 'state', 'sessionId', 'branch', 'prUrl', 'relevantFiles', 'deferredRefs']);
function clientOwnsCard(card, clientId) {
  return card.actor === `client:${clientId}` || card.origin?.clientId === clientId;
}
function clientPatchRefusal(body) {
  const field = Object.keys(body).find((k) => !CLIENT_PATCH_FIELDS.has(k));
  if (field) return { field };
  if (body.state === 'queued') return { field: 'state' };
  if (Array.isArray(body.labels) && body.labels.includes('agent:backlog')) return { field: 'labels' };
  return null;
}

export async function startServer({
  port, pollMs = 1000, env = process.env, configFile, restartFn,
  // defaultRestart's own spawn/exit, injectable
  // separately from restartFn. restartFn replaces the whole restart function
  // (so injecting it bypasses defaultRestart, and with it isServiceMode(),
  // entirely); these two let a test exercise the real defaultRestart --
  // including its service-mode branch -- and still prove "never spawns,
  // always exits 75" without ever spawning a real detached process or
  // exiting the test runner. Default to the real primitives in production.
  restartSpawnFn = spawn, restartExitFn = process.exit,
  // The clone url the tap-git-clones loop uses for a canonical remote (card glmps-2-0-runtime-40). canonicalRemote
  // refuses file:// and local paths, so a test points the loop at a local bare repo through this; production never sets it.
  tapGitCloneUrlFor = null,
  // the address the private HTTPS listener binds instead of config.json's
  // host, so a test can run a LAN-configured kernel on a loopback alias.
  listenHostOverride = null,
  // the close reconciler's process lister and killer, so a test never lists
  // or ends real processes (card glmps-2-0-85).
  sessionCloser = null,
  // pid -> process start FILETIME for Claude Code's session registry, so a
  // test can vouch for a fake open window without a real process probe.
  procStarts = null,
  // injectable so a test can prove the sweep is (or is
  // not) reached without ever letting real git run against this checkout's
  // own repo (gitRepoRoots() always includes REPO_ROOT). Defaults to the real
  // sweeper in production.
  sweepSessionWorktreesFn = sweepSessionWorktrees,
  // the wiki loop's readHead/readGraph/refreshGraph/runBuild (and,
  // narrowly, rm/readdir for retention-error tests) so a test never spawns a
  // real model build. Empty in production -- the real implementations below.
  wikiLoopOverrides = {},
  // the actual spawn-and-wait for ONE
  // `graphify update <root>` call, injectable so a test can drive the
  // mutual-exclusion wiring shared by graphRebuildTick, the wiki loop's
  // refreshGraph and POST /api/graph/rebuild without a real graphify binary
  // or touching this repo's own graph.json. M2 fix: defaults to a refusal
  // under isTestProcess({ env }) with no override given (mirrors R-M4's
  // wiki runBuild guard); the real spawn otherwise.
  spawnGraphifyUpdate = (isTestProcess({ env }) ? testRefusingSpawnGraphifyUpdate : defaultSpawnGraphifyUpdate),
  // How long POST /api/graph/rebuild waits before answering 202 and leaving
  // the rebuild to finish in the background (card glmps-2-0-runtime-148).
  graphRebuildReplyMs = 2 * 60 * 1000,
  // graphifyVersionTick's own three real-
  // process/network seams (runCmd, latestGraphifyVersion, graphifyVersion),
  // so a test can drive its audit/rollback decision without ever running a
  // real uv/uvx/PyPI/graphify call. Resolved inside startServer's body
  // (below), not as a parameter default, since the real implementations
  // they fall back to are defined there.
  graphifyVersionOverrides = {},
  // the boot-time graph store scope cleanup (card glmps-2-0-93); off under
  // test so hundreds of short-lived test servers never probe git at boot.
  // Tests call srv.migrateGraphScopeState() directly.
  graphScopeMigrateOnBoot = !isTestProcess({ env }),
  // the git probe behind graph scope classification, wrapped in the server's
  // cross-tick cache below; injectable so a test can count probes.
  graphProbeAsync = gitProbeAsync,
  mergeGraphs = (isTestProcess({ env }) ? testRefusingMergeGraphs : defaultMergeGraphs),
  // the ship graph build the rebuild tick runs, so a test can watch the
  // schedule without the kernel root (this checkout) needing a graph.
  buildShipGraphFn = buildShipGraph,
  // the LLM-backed CLI spawn for a
  // non-repo-root POST /api/wiki/rebuild, injectable so a test can drive
  // that path without ever starting a real model build. Always defaults to
  // the real spawn (unlike spawnGraphifyUpdate/spawnWikiRebuildCli's
  // siblings): body.llm is a PER-REQUEST value the route itself gates on,
  // not something a parameter default can see -- the existing no-LLM
  // structural-only rebuild test relies on the real spawn still running
  // under isTestProcess.
  spawnWikiRebuildCli = defaultSpawnWikiRebuildCli,
  // TEST-ONLY root list for the worktree sweep, so a
  // test can prove the per-root test-write guard with one temp root and one
  // non-temp root. Absent (every production caller), gitRepoRoots() is used.
  gitRepoRootsFn = null,
  // TEST-ONLY spawn seam for every
  // editor/terminal spawn (the four request routes and launchSession's two).
  // When given, those sites call it in place of child_process.spawn, and
  // launchSession runs its real (non-dry-run) branches against it. A fake
  // never creates a process, so a test can drive sync throws, async 'error'
  // events, non-zero exits and shell-metacharacter payloads with no real
  // shell. Absent (every production caller), spawn is used and
  // GLMPS_RUNNER_DRYRUN behaves exactly as before.
  editorSpawnFn = null,
  // TEST-ONLY Antigravity IDE process probe. Returns true
  // when the IDE is running. Absent, the real tasklist probe runs.
  agAliveProbe = null,
  // TEST-ONLY: the live IDE targets (an array of target ids), for routing to a non-Antigravity IDE.
  liveIdesProbe = null,
  // TEST-ONLY IDE install probe for the Open buttons: { home, programFiles, exists }.
  // Absent, home is the parent of the resolved claudeDir and the real disk is checked.
  editorDetect = null,
  // glmps-2-0-30: TEST-ONLY path for the companion's request file. Absent,
  // production writes the real one (companionRequestsFile()) and a test
  // process gets no companion target at all.
  companionRequestsFile: companionRequestsFileOpt = null,
  // H1 (huddle) test seams. huddleStream replaces the claude -p pool; huddleCliCheck
  // replaces the `claude --version` probe; huddleSeats is undefined (auto: the agy
  // seats join when <P.agyCliDir>/conversations exists), false (none) or an array
  // of injected seats keyed by persona id; huddlePostSummary replaces the Slack relay. All null/undefined in production.
  huddleStream = null, huddleCliCheck = null, huddleSeats = undefined, huddlePostSummary = null, huddleCardThreads = null,
  // undefined: build the real researcher; false: no Howard; an object: a fake { run, busy, model }.
  huddleResearcher = undefined,
  // glmps-2-0-42: `gh` runner for the merge-request route, (file, args) -> a
  // spawnSync-shaped result, same seam as pr-file.js. Absent in a test process
  // it refuses, so no test ever reaches the network.
  ghRun = null,
  // TEST-ONLY replacement for the async git/process runner behind worktree create,
  // remove and list, the start point and the origin lookup: (file, args, { cwd, timeout })
  // -> Promise<{ status, stdout, stderr }>. Lets a test make git slow and prove the
  // event loop keeps serving requests meanwhile.
  gitRunner = null,
  // glmps-2-0-43: TEST-ONLY replacement for the merge-queue test job,
  // async ({ id, mr, repoPath, workDir, override }) -> an outcome. Absent,
  // merge-tests.js runs real git and the real test command.
  mergeTestsRun = null,
  // glmps-2-0-44: TEST-ONLY replacement for the git calls that prepare a
  // reviewer (fetch, detached worktree, diff): async (args, { cwd }) -> { status, stdout, stderr }.
  reviewGit = null,
  // glmps-2-0-216: TEST-ONLY stand-in for the desktop app's release action:
  // async (op) -> { status, stdout, stderr }, the gitops broker's run() shape.
  releaseRun = null,
  // glmps-2-0-runtime-98: TEST-ONLY count of running `node --test` processes,
  // async () -> number|null, and the batched full-suite run's test command.
  countTestProcs = null,
  mainSuiteRunTest = null,
  // Card glmps-2-0-176: TEST-ONLY git for the live check, async (args) -> { status, stdout, stderr },
  // run against this checkout. Absent, real git runs, and a fetch is refused in a test process.
  liveNoticeGit = null,
  // glmps-2-0-runtime-126: TEST-ONLY, registers the batched review loop in a test process.
  batchReviewInTest = false,
} = {}) {
  const bootTrace = createBootTrace();
  bootTrace.mark('import');
  // Handlers close over this call's state, so dispatch stays on this server's
  // own table; the module table only lets tests see what was registered.
  const serverRoutes = createRouteRegistry();
  const { matchRoute } = serverRoutes;
  const registerRoute = (route) => { serverRoutes.registerRoute(route); publishRoute(route); };
  const spawnEditor = editorSpawnFn ?? spawn;
  // the one guarded way to start the editor app
  // (cfg.antigravityCommand, a shell:true command because it is often a .cmd
  // shim). `dir`/`args` must already be validated by shellSafePath and quoted
  // by shellArg: no request field is ever put on this command line raw. A
  // failure (sync throw, async 'error', non-zero exit) is a named miss keyed
  // per route, `spawn:<route>`; `detail` (a job id) goes in the reason text.
  const editorSpawnMiss = (key, reason) => {
    console.error(`[spawn] ${key}: ${reason}`);
    reportMiss(key, reason);
  };
  // a refusal here must be distinguishable from an
  // ordinary async spawn failure (a sync throw/async error/non-zero exit,
  // reported only as a named miss - the HTTP response already went out by
  // the time those are known). `refusal` is non-null for the two
  // synchronous, known-before-spawning cases below; every caller checks it
  // and answers accordingly instead of unconditionally claiming success.
  const runAsync = gitRunner ?? defaultRunAsync;
  const runRecipe = (recipe, opts) => runAsync(recipe.file, recipe.args, opts);

  // The editor the Open buttons use, read fresh each call so a picker change
  // applies on the next Open. A hand-set antigravityCommand wins; else the IDE
  // "Open files in" names (openTarget, not the board's session picker), else the
  // first installed. The operator's home is the parent of claudeDir because a
  // service kernel's os.homedir() is not theirs.
  // A test process without the editorDetect seam never reads the machine's Program Files.
  const editorProbe = () => ({ home: path.dirname(P.claudeDir), programFiles: isTestProcess({ env }) && !editorDetect ? [] : defaultProgramFiles(env), ...editorDetect });
  function resolveOpenEditor() {
    if (cfg.antigravityCommand) return { command: cfg.antigravityCommand };
    return resolveEditor({ lastTarget: runnerStore.loadConfig(P.stateDir).openTarget, ...editorProbe() });
  }
  function spawnEditorApp(route, { args = [], cwd = undefined, detail = null, command = cfg.antigravityCommand } = {}) {
    const label = detail ? `${route} ${detail}` : route;
    const failClosed = (refusal, reason) => {
      editorSpawnMiss(`spawn:${route}`, reason);
      appendEvent(P.stateDir, { kind: 'launch.failed', lane: route, label, path: cwd ?? null, ts: Date.now(), sessionId: null });
      return { child: null, refusal, reason };
    };
    // A service-mode kernel runs in session 0 and cannot put ANY desktop
    // app on the operator's screen, the same reason launchNative cannot
    // open a terminal there. Checked unconditionally (no editorSpawnFn
    // exception), same as launchNative's own service-mode branch.
    if (isServiceMode(env)) return failClosed('service-mode', 'service mode cannot open a desktop app from session 0');
    // The same test-process backstop launchNative's own I5 guard carries
    //  - a test process reaching this far with no injected
    // spawn seam must refuse, never open a real editor window.
    if (isTestProcess({ env }) && !editorSpawnFn) return failClosed('test-process', 'refused: test process, no injected spawn seam (editorSpawnFn)');
    // Detached on purpose: the GUI editor must outlive this server process.
    const child = guardedSpawn({
      spawnFn: spawnEditor, file: quoteCommand(command), args,
      options: { detached: true, stdio: 'ignore', shell: true, windowsHide: true, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }, ...(cwd ? { cwd } : {}) },
      key: `spawn:${route}`, label, onMiss: editorSpawnMiss,
    });
    return { child, refusal: null, reason: null };
  }
  // D20: when a session is not hosted by the Antigravity companion
  // (openSession below, glmps-2-0-30), POST /api/resume, POST /api/terminal,
  // the learning memory-promote dispatch AND the runner's own job launches
  // launchSession below shares this instead of duplicating
  // it) all open a native terminal through this one guarded spawn, shell:false
  // (nativeTerminalRecipe), reusing the same per-route miss keys
  // (spawn:resume, spawn:terminal, spawn:learning-apply, spawn:launch-terminal)
  // and the same dry-run seam (editorSpawnFn) the editor-app launches above
  // already use, so a test can drive every failure mode (sync throw, async
  // error, non-zero exit) with no real process. Under GLMPS_RUNNER_DRYRUN with
  // no injected editorSpawnFn, nothing opens; the launch is recorded on
  // dryRunLaunches for a deterministic test to inspect. A failed launch is
  // also a durable launch.failed row in the event log (fix round 1, M2: not
  // just a health-panel miss) - the operator clicked a button and nothing
  // opened, which must be visible as a real event, not only in adapter
  // health; `origin` names the lane (`resume`, `terminal`, `learning`,
  // `runner`) so that event does not lie about which launch it was.
  //
  // Task 12b: a service-mode kernel (a Windows service, GLMPS_SERVICE=1)
  // runs in session 0 and has no desktop of its own - it cannot open a
  // terminal no matter how it is spawned. Checked AFTER the dry-run branch
  // (so every pre-existing test, none of which sets GLMPS_SERVICE, is
  // unaffected) and BEFORE the real spawn: the launch is queued on the
  // broker instead, and the desktop shell (running in the operator's own
  // session) claims and opens it. Return shape is always
  // { pid, launchId } now - pid is the real OS pid once something actually
  // spawned (dry-run or a real launch), null when only queued; launchId is
  // the broker's record id once queued, null otherwise. Exactly one of the
  // two is ever non-null.
  // Fix round 1, m7: the service's own working directory (WinSW's
  // default, typically C:\Windows\System32) is meaningless as a
  // terminal's cwd - a fallback to it must land in a real, useful
  // directory instead. Shared by launchNative (what actually gets
  // queued/spawned) and the /api/resume route's own response field, so
  // the two never disagree about where a launch actually went.
  function fallbackCwd(e) { return isServiceMode(e) ? REPO_ROOT : process.cwd(); }
  const dryRunLaunches = [];
  function launchNative({ command, cwd, key, label = key, origin = 'runner' }) {
    const dir = cwd ?? fallbackCwd(env);
    if (env.GLMPS_RUNNER_DRYRUN && !editorSpawnFn) { dryRunLaunches.push({ command, cwd: dir }); return { pid: process.pid, launchId: null }; }
    if (isServiceMode(env)) {
      const { id } = launchBroker.enqueue({ command, cwd: dir, origin });
      broadcastLaunch(id, 'pending');
      return { pid: null, launchId: id };
    }
    // the one real-world incident this review caught - a
    // test process reaching this far with no injected spawn seam
    // (editorSpawnFn) and neither dry-run nor service mode active would
    // open a REAL terminal (five of them did, during this task's own red
    // phase, before this guard existed). This is the last gate before
    // nativeTerminalRecipe/guardedSpawn ever run, so a future test missing
    // GLMPS_RUNNER_DRYRUN or GLMPS_SERVICE can never reach a real spawn again.
    if (isTestProcess({ env }) && !editorSpawnFn) {
      const reason = 'refused: test process, no injected spawn seam (editorSpawnFn)';
      editorSpawnMiss(key, reason);
      appendEvent(P.stateDir, { kind: 'launch.failed', lane: origin, label: String(command).slice(0, 120), path: dir, ts: Date.now(), sessionId: null });
      return { pid: null, launchId: null };
    }
    const recipe = nativeTerminalRecipe({ platform: process.platform, seededCmd: command, cwd: dir });
    const child = guardedSpawn({
      spawnFn: spawnEditor, file: recipe.file, args: recipe.args, options: recipe.options,
      key, label,
      onMiss: (k, reason) => {
        editorSpawnMiss(k, reason);
        // appendEvent/appendEvents already fail open internally (event-log.js)
        // and never throw - fix round 1, M3 removed the dead try/catch here.
        appendEvent(P.stateDir, { kind: 'launch.failed', lane: origin, label: String(command).slice(0, 120), path: dir, ts: Date.now(), sessionId: null });
      },
    });
    return { pid: child?.pid ?? null, launchId: null };
  }
  // glmps-2-0-30 (D20 reopened by the operator): a session opens in an
  // Antigravity editor terminal, as in 1.0, whenever Antigravity can host it:
  // the record goes to the companion's request file and the companion runs it.
  // Otherwise, or if that file cannot be written, it opens natively. A service
  // (session 0) can write the file but cannot start the IDE, so there only a
  // live Antigravity counts. A test process without the seam never sees the
  // real file.
  const companionFile = companionRequestsFileOpt ?? (isTestProcess({ env }) ? null : companionRequestsFile());
  // One request file per IDE (the companion in each IDE drains only its own).
  const companionFileFor = (target) => path.join(path.dirname(companionFile), companionFileName(target) ?? 'resume.jsonl');
  // The command that starts an IDE: antigravityCommand when hand-set, else the detected install.
  const ideCommand = (target) => (target === 'antigravity' && cfg.antigravityCommand ? cfg.antigravityCommand : editorCommand(target, editorProbe()));
  // Whether the desktop shell would start this IDE: it opens the project in the
  // editor the kernel advertises, so only the picked Open-files IDE qualifies.
  const shellStartsIde = (target) => !!editorCommand(target, editorProbe()) && resolveOpenEditor()?.id === target;
  // IDEs that are closed now but that a launch can start: a desktop kernel
  // spawns them itself, a service kernel (session 0) hands the start to the shell.
  function launchableIdes() {
    return IDE_TARGETS.filter((t) => (isServiceMode(env) ? shellStartsIde(t) : !!ideCommand(t)));
  }
  // A request file only opens a session if a companion drains it, so a VS Code
  // family IDE without the GLMPS companion falls back (card glmps-2-0-223).
  // Antigravity is exempt: it hosted sessions before that check existed.
  const hasCompanion = (target) => target === 'antigravity' || companionInstalled(target, editorProbe());
  function sessionTarget(preferred) {
    if (!companionFile) return 'native-terminal';
    if (!hasCompanion(preferred)) return 'native-terminal';
    return launchTargetFor(preferred, { live: liveIdes, launchable: launchableIdes() });
  }
  // Why a chosen IDE cannot host a session, for the fallback devlog line.
  function ideFallbackReason(target) {
    if (!editorCommand(target, editorProbe()) && !(target === 'antigravity' && cfg.antigravityCommand)) return 'not installed';
    return hasCompanion(target) ? 'could not be started' : 'missing the GLMPS companion';
  }
  // Antigravity counts as "running" for the default choice when it is live
  // OR can be started, so a closed IDE does not quietly send every session to
  // a native terminal; an explicit card target or lastTarget still wins. Other
  // IDEs are never the default: whether their companion is installed is unknown here.
  function editorsForDefault() {
    return liveIdes.includes('antigravity') || launchableIdes().includes('antigravity') ? ['antigravity'] : [];
  }
  function preferredTarget(item = {}) {
    return resolveTarget({ item, lastTarget: runnerStore.loadConfig(P.stateDir).lastTarget, running: editorsForDefault() });
  }
  function startIde(target, { cwd, label }) {
    const v = cwd ? shellSafePath(cwd, { kind: 'dir' }) : null;
    if (isServiceMode(env)) {
      if (!shellStartsIde(target) || !v?.ok) return;
      try { const { id } = launchBroker.enqueue({ command: 'open-in-editor', cwd: v.path, origin: 'editor', path: v.path }); broadcastLaunch(id, 'pending'); }
      catch (e) { editorSpawnMiss('spawn:launch-companion', `${label}: editor start not queued: ${e.message}`); }
      return;
    }
    const command = ideCommand(target);
    if (!command) return;
    if (v && !v.ok) editorSpawnMiss('spawn:launch-companion', `${label}: editor not started, cwd refused: ${v.reason}`);
    else spawnEditorApp('launch-companion', { args: v ? [shellArg(v.path)] : [], cwd: v?.path, detail: label, command });
  }
  function queueForCompanion({ command, cwd, label, name = null, target = 'antigravity' }) {
    const file = companionFileFor(target);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(companionRecord({ command, cwd, now: Date.now(), name, target })) + '\n');
    } catch (e) {
      editorSpawnMiss('spawn:companion', `${label}: companion request not written, opening natively: ${e.message}`);
      return false;
    }
    // Once queued the launch is committed: the companion finds it whenever
    // the IDE comes up, so starting the IDE here is a convenience and a
    // failure is reported by name, never turned into a second launch.
    if (!liveIdes.includes(target)) startIde(target, { cwd, label });
    return true;
  }
  // The one trust write for every interactive launch. It sits here, not in each
  // worktree creator, so a directory the harness has never seen cannot stall a
  // session on the trust modal. Never throws and never blocks a launch; a missing
  // config file is the normal no-harness case and stays silent.
  function trustLaunchDir(cwd) {
    if (!cwd) return;
    try {
      const r = markTrusted({ dirs: [cwd], privateDirs: loadPrivateDirs({ env }), env, file: P.claudeDir + '.json' });
      if (!r.ok && !/ENOENT/.test(r.reason ?? '')) reportMiss('launch-trust', `${cwd}: ${r.reason}`);
    } catch (e) { reportMiss('launch-trust', `${cwd}: ${e?.message ?? e}`); }
  }
  // Returns launchNative's { pid, launchId } plus `target`, the one that
  // actually opened: a companion launch has neither a pid nor a launchId.
  function openSession({ command, cwd, key, label = key, origin, target, name = null }) {
    trustLaunchDir(cwd ?? fallbackCwd(env));
    if (IDE_TARGETS.includes(target) && queueForCompanion({ command, cwd: cwd ?? fallbackCwd(env), label, name, target })) {
      return { pid: null, launchId: null, target };
    }
    return { ...launchNative({ command, cwd, key, label, origin }), target: 'native-terminal' };
  }
  // Fresh signal-producer registry per server instance - matters for tests,
  // which call startServer() many times within one process (ESM modules are
  // process-wide singletons, so without this the registry would grow
  // unboundedly across repeated startServer() calls).
  _resetProducers();
  const cfg = Object.assign(configDefaults(), readJsonSafe(configFile));
  if (port !== undefined) cfg.port = port;
  // decided before any store, timer or socket exists, so a refusal leaks nothing.
  {
    const bp = remoteBindPolicy({ bindHost: cfg.host || '127.0.0.1', tls: tlsConfigured(cfg.tls) });
    if (!bp.allow) throw new Error(bp.reason);
  }
  // Loaded once at boot (config.json only changes on restart). Empty list =
  // solo mode: every gateCheck below is then a permanent no-op.
  // loaded after the state dir is known, below: tokens come from
  // <stateDir>/actor-tokens.json, never from config.json.)
  // Deep-merge graphRebuild so a config.json that sets only
  // `{ minIntervalMs: N }` still keeps the enabled/checkMs defaults
  // (Object.assign above is shallow and would otherwise replace the whole
  // sub-object).
  cfg.graphRebuild = { enabled: true, checkMs: 30 * 60 * 1000, minIntervalMs: 24 * 60 * 60 * 1000, ...(cfg.graphRebuild || {}) };
  // Same partial-override protection as graphRebuild above, one level deeper
  // (ship and machine are sub-blocks).
  cfg.graph = mergeGraphConfig(cfg.graph);
  // The actor that writes the merged machine graph; a no-op until the scan is
  // on and a repo is opted in. Listed in the shadow-instance EXCLUDED_ACTORS.
  cfg.graphMachineScan = { ...MACHINE_SCAN_DEFAULTS, ...(cfg.graphMachineScan || {}) };
  // Nightly state backups (glmps-2-0-runtime-42): off until a target dir is named.
  cfg.backup = { targetDir: null, hour: 3, keepDaily: 14, keepWeekly: 8, checkMs: 60 * 60 * 1000, ...(cfg.backup || {}) };
  cfg.graphIntegrity = { enabled: true, sampleMs: 10 * 60 * 1000, minRatio: 0.5, ...(cfg.graphIntegrity || {}) };
  // Same partial-override protection as graphRebuild above (a config.json that
  // sets only `{ wikiLoop: { keepBuilds: 5 } }` still keeps enabled/everyMs/
  // the rest of WIKI_LOOP_DEFAULTS).
  cfg.wikiLoop = { ...WIKI_LOOP_DEFAULTS, ...(cfg.wikiLoop || {}) };
  // Same partial-override protection as graphRebuild above (a config.json that
  // sets only `{ autoUpgrade: false }` still keeps the rest of the defaults).
  cfg.graphifyUpdate = {
    enabled: true, autoUpgrade: true, tickMs: 24 * 60 * 60 * 1000, minRatio: 0.8, pinned: '0.9.95',
    requiredCommands: ['query', 'explain', 'path', 'update', 'watch', 'affected', 'install'],
    ...(cfg.graphifyUpdate || {}),
  };
  // Same partial-override protection as graphRebuild above (a config.json that
  // sets only `{ enabled: false }` still keeps the checkMs default).
  cfg.qaTrends = { enabled: true, checkMs: 30 * 60 * 1000, ...(cfg.qaTrends || {}) };
  // GitHub Actions minutes (glmps-2-0-73). allowance is the free plan's 2000
  // included minutes; repos null means every repo of this checkout's owner.
  cfg.actionsMinutes = { enabled: true, everyMs: 60 * 60_000, allowance: 2000, thresholds: [75, 90], repos: null, ...(cfg.actionsMinutes || {}) };
  // hour is local to the operator's timezone setting (card glmps-2-0-219).
  cfg.alertDigest = { enabled: true, everyMs: 15 * 60_000, hour: 8, ...(cfg.alertDigest || {}) };
  // Same partial-override protection as qaTrends above (a config.json that
  // sets only `{ enabled: false }` still keeps the tickMs default).
  cfg.vitalsTrends = { enabled: true, tickMs: 30_000, ...(cfg.vitalsTrends || {}) };
  // Same partial-override protection as graphRebuild above (a config.json
  // that sets only `{ scut: { rejoinReopens: true } }` still keeps
  // enabled/ticketChannels/channelMessages at their defaults).
  cfg.scut = { ...SCUT_DEFAULTS, ...(cfg.scut || {}) };
  // Same partial-override protection (a config.json that sets only
  // `{ huddle: { effort: 'medium' } }` keeps every other huddle default).
  cfg.huddle = { ...HUDDLE_DEFAULTS, ...(cfg.huddle || {}) };
  // Same partial-override protection as graphRebuild above, one level deeper
  // (a config.json that sets only `{ kernel: { diagnosis: { maxPerDay: N } } }`
  // still keeps gitRemoteFeedMs/obligationSweepMs/diagnosis.enabled at their
  // defaults).
  cfg.kernel = {
    gitRemoteFeedMs: 15 * 60_000, obligationSweepMs: 60_000,
    ...(cfg.kernel || {}),
    diagnosis: { enabled: true, maxPerDay: 10, project: null, ...(cfg.kernel?.diagnosis || {}) },
  };
  // The canonical-project table (card glmps-2-0-runtime-151), read once: every
  // intake path, the Slack router, the runner's checkout lookup and the shared
  // auto-filer below use this same object, so one config flip moves them all.
  cfg.canonicalProject = canonicalTable(cfg.canonicalProject);
  const projectTable = cfg.canonicalProject;
  const resolveProjectName = (p) => resolveCanonicalProject(p, projectTable);
  if (!cfg.kernel.diagnosis.project) cfg.kernel.diagnosis.project = projectTable.target;
  // Finalize sweep (GLMPS 2.0 shadow-instance plan, Task 1): default OFF.
  // Production's Stop hook already pings its own instance's
  // POST /api/outcomes/finalize on every turn, so only an isolated instance
  // with no Stop hook wired to it (the 2.0 shadow) needs this periodic
  // sweep instead. Same partial-override protection as graphRebuild above,
  // one level deeper (a config.json that sets only `{ enabled: true }`
  // still keeps the tickMs/maxAgeMs defaults).
  // maxAgeMs: a fresh shadow state dir
  // otherwise finalizes and queues a judge model call for every historical
  // session already sitting in the index, not just ones that recently went
  // idle. 24h default caps the sweep to genuinely live sessions.
  cfg.outcomes = mergeFinalizeSweepConfig(cfg.outcomes);
  // Worktree sweep: default ON in production (the
  // orchestrator's normal job-worktree/session-worktree housekeeping), but the
  // GLMPS 2.0 shadow instance must never run `git worktree prune` / `git
  // branch -d` against a repo it merely observes (that write belongs to
  // production alone). shadowConfig() sets this false; GLMPS_UNMERGED_SCAN=off
  // in the shadow launcher's child env is the second, independent gate (see
  // sweepWorktrees below), so a bug in one does not silently re-enable git
  // writes on its own.
  cfg.worktreeSweep = { enabled: true, ...(cfg.worktreeSweep || {}) };
  // Session memory distiller: resolve its config once at boot (config.json only
  // changes on restart). Defaults to enabled; clean facts are distilled straight
  // to the L3 pool, only poison-flagged facts are proposed for human review.
  const mdCfg = getMemoryDistillConfig(cfg);
  // Skill capability-lifecycle (glmps-88): archive-scan defaults ON (cheap,
  // local, no network); checkUpdates defaults OFF (new network egress - 
  // explicit opt-in). skillDiscovery (glmps-87's registry-scan producer) has
  // no dedicated config module - a single small, off-by-default inline
  // deep-merge, not a whole subsystem's config. registries is an explicit ALLOWLIST: the
  // ONLY sources skill-registry-scan.js ever fetches from.
  const skCfg = getSkillLifecycleConfig(cfg);
  cfg.skillDiscovery = { enabled: false, registries: [], simThreshold: DEFAULT_GAP_MATCH_THRESHOLD, starFloor: 100, freshnessMonths: 12, ...(cfg.skillDiscovery || {}) };
  // D23 loop-plugins: the one model every plugin (Mem0, judge, GEPA) calls
  // through, an in-process OpenAI-chat.completions-shaped wrapper around
  // `claude -p` on the operator's own Claude Code plan. No API key, no paid
  // service; config comes from `plugins.model` in config.json.
  const modelCfg = getModelConfig(cfg);
  const chatCompletion = createChatCompletion({ ...modelCfg, env });
  // judge on quiescence - resolved once at
  // boot (config.json only changes on restart), same convention as mdCfg
  // above. `enabled: false` means the finalize route never even upserts a
  // judge.session job.
  const judgeCfg = getJudgeConfig(cfg);
  // Staleness-based retire thresholds (glmps-138 Task 4 / I5 fix): shared by
  // computeGuardStaleCandidates/computeSkillStaleCandidates below, which
  // previously hardcoded `{}` at every call site (no operator override path
  // at all). Same partial-override-safe merge shape as graphRebuild/qaTrends
  // above; no dedicated config module (two small numeric fields mirrors the
  // skillDiscovery inline-block precedent, not a whole subsystem).
  const retireStalenessCfg = { staleDays: DEFAULT_STALE_DAYS, retireDays: DEFAULT_RETIRE_DAYS, ...(cfg.retireStaleness || {}) };
  const engagementProfilePath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'lib', 'evaluation', 'engagement-profiles', 'glmps.json');
  const engagementProfileResult = loadEngagementProfileFromFile(engagementProfilePath);

  const profile = loadProfile({ cwd: process.cwd(), env, home: os.homedir(), stateDir: getPaths(env).stateDir });
  const P = getPaths(env, profile);
  P.zoneConfig = { ...P.zoneConfig, tierRoots: deriveTierRoots(P, adapters) };
  ensureStateDirs(P);
  // Server prose (Slack, alerts) formats in the operator's zone from boot on.
  setDisplayTimeZone(loadOperatorSettings(P.stateDir).timeZone);
  try {
    const seed = seedShipGraph({ bundleDir: REPO_ROOT, stateDir: P.stateDir });
    if (seed.seeded) console.log(`ship graph seeded from the bundle (${seed.reason})`);
    else if (seed.reason !== 'no bundled ship graph' && seed.reason !== 'local ship graph is current') console.warn(`ship graph not seeded: ${seed.reason}`);
  } catch (e) { console.warn('ship graph seed failed: ' + (e?.message ?? e)); }
  try {
    const memSeed = seedMemoryStore({ bundleDir: REPO_ROOT, stateDir: P.stateDir });
    if (memSeed.seeded) console.log(`memory store seeded from the bundle (${memSeed.count} item(s))`);
  } catch (e) { console.warn('memory seed failed: ' + (e?.message ?? e)); }
  try {
    const wikiSeed = seedWikiSnapshot({ bundleDir: REPO_ROOT, stateDir: P.stateDir });
    if (wikiSeed.seeded) console.log(`wiki seeded from the bundle (${wikiSeed.reason})`);
    else if (wikiSeed.reason !== 'no bundled wiki' && wikiSeed.reason !== 'local wiki is current') console.warn(`wiki not seeded: ${wikiSeed.reason}`);
  } catch (e) { console.warn('wiki seed failed: ' + (e?.message ?? e)); }
  // I1 (scan F1): secrets must not live in config.json, which GET /api/file can
  // read. The remote access token comes from env or <stateDir>/access-token and
  // per-actor tokens from <stateDir>/actor-tokens.json ({ "<actorId>": "<token>" }).
  // Token fields left in config.json are IGNORED and raise a named health alert.
  const accessTokenFile = path.join(P.stateDir, 'access-token');
  const actorTokensFile = path.join(P.stateDir, 'actor-tokens.json');
  const ignoredConfigTokens = [];
  if (cfg.accessToken) ignoredConfigTokens.push(`accessToken is ignored in config.json; put the remote token in ${accessTokenFile}`);
  const actorTokenMap = readJsonSafe(actorTokensFile);
  const actors = loadActors(cfg).map((a) => {
    if (a.token) ignoredConfigTokens.push(`actors[${a.id}].token is ignored in config.json; put it in ${actorTokensFile}`);
    const t = actorTokenMap && typeof actorTokenMap === 'object' ? actorTokenMap[a.id] : '';
    return { ...a, token: typeof t === 'string' ? t.trim() : '' };
  });
  delete cfg.accessToken;
  // Non-local bind guard (see the spec): fail closed with no token, never auto-generate.
  const bindHost = cfg.host || '127.0.0.1';
  const nonLocal = !isLoopbackHost(bindHost);
  const accessToken = env.GLMPS_ACCESS_TOKEN
    || (fs.existsSync(accessTokenFile) ? fs.readFileSync(accessTokenFile, 'utf8').trim() : '');
  if (nonLocal && !accessToken) {
    throw new Error(`Refusing to bind ${bindHost}: no remote access token. Put one in ${accessTokenFile} (or set GLMPS_ACCESS_TOKEN). A token in config.json is ignored.`);
  }
  // Spec 2026-11-10-glmps-2-0-171: a private bind serves HTTPS only, from the
  // server-trust certificate, and asks each caller for a client certificate
  // signed by the client-issuing CA. A missing file refuses to start.
  const serverTls = nonLocal ? loadServerTls({ tls: cfg.tls, stateDir: P.stateDir, host: bindHost }) : null;
  // Task 12b: launches the kernel cannot open itself (a Windows service runs
  // in session 0, with no desktop) are queued here instead of spawned, and
  // the desktop shell - running in the operator's session - claims and opens
  // them. Created unconditionally, not only in service mode, so the broker's
  // own routes and loop always have a real queue to read, and a mode flip
  // mid-run (or a stray queued record left from a previous service run)
  // finds the same file either way.
  const launchBroker = createLaunchBroker({
    file: path.join(P.stateDir, 'launches', 'queue.json'),
    // a malformed row dropped on load is a named miss,
    // same registry every other adapter/route failure reports through.
    reportMiss: (key, reason) => reportMiss(key, reason),
  });
  // The huddle's agy seats in service mode: the service cannot load the
  // operator's agy sign-in, so each call is queued here for the desktop shell.
  const agyBroker = createAgyBroker({ launchBroker });
  // The merge queue's git, gh and test runs in service mode: the service has no
  // GitHub sign-in (D33), so each is a 'gitops' record the desktop shell runs
  // against its own allowlist. The roots are the checkouts the queue works in
  // (configured paths plus those it has resolved) and the worktrees dir.
  const gitopsViaShell = isServiceMode(env);
  // The server's own mirror clones of client repos (card glmps-2-0-runtime-40). In service mode the shell makes them,
  // so each of that loop's calls names this directory as an extra root the shell may clone into (merge-queue calls do not).
  const gitClonesDir = path.join(P.stateDir, 'git-clones');
  const gitopsCheckouts = new Map();
  const gitopsClaimWaitMs = Number(cfg.mergeQueue?.shellClaimWaitMs) > 0 ? Number(cfg.mergeQueue.shellClaimWaitMs) : DEFAULT_CLAIM_WAIT_MS;
  // The desktop app's pickup times, for /healthz and the slow-pickup alert.
  const shellPickups = [];
  const gitopsBroker = createGitopsBroker({
    launchBroker,
    claimWaitMs: gitopsClaimWaitMs,
    onPickup: ({ kind, ms }) => { shellPickups.push({ kind, ms, at: Date.now() }); if (shellPickups.length > PICKUP_SAMPLES) shellPickups.shift(); },
    roots: () => ({
      repos: [...new Set([
        ...Object.values(cfg.mergeQueue?.repos ?? {}).map((r) => r?.path).filter((x) => typeof x === 'string' && x),
        ...gitopsCheckouts.values(),
      ])],
      worktrees: P.worktreesDir,
    }),
  });
  const shellSeams = createShellSeams(gitopsBroker);
  // the
  // shell trusts whatever answers on the loopback kernel URL - another
  // local account binding the same port while the real service is down
  // could serve launch records (and the allowlist from its own
  // /api/config) just as convincingly as the real kernel. Created once, at
  // boot, unconditionally (not only in service mode, for the same reason
  // launchBroker above is): GET /api/launches, claim and result all
  // require proving knowledge of it.
  //
  // a throw here (e.g. an unwritable state dir) used to
  // crash the WHOLE kernel at boot, over a feature most installs never
  // touch. Guarded the same way obligationStore above is: launches are
  // disabled (every launch route answers 401, same as a bad proof) and the
  // miss is named, but the kernel still boots.
  let launchToken = null;
  // glmps-2-0-61: the shell's heartbeat as the kernel sees it, set on each
  // authenticated GET /api/launches (only the shell holds the token), read by
  // the launch-queue loop to name how long the shell has been gone.
  let shellPolledAt = null;
  const launchesBootedAt = Date.now();
  try { launchToken = readOrCreateLaunchToken(P.stateDir); }
  catch (e) { console.error('[kernel] launch token could not be created/read - launches are disabled:', e?.message || e); reportMiss('launch-token-boot', e?.message || String(e)); }
  // Scan 2026-10-15 F2: file, terminal, resume, editor and restart routes need proof
  // of this owner-only key from loopback clients too. A failure leaves those routes
  // refusing (401), named, rather than open.
  let localSessionExpected = null;
  try { localSessionExpected = localSessionValue(readOrCreateLaunchToken(P.stateDir, { fileName: LOCAL_SESSION_KEY_FILE })); }
  catch (e) { console.error('[kernel] local session key could not be created/read - file, terminal and restart routes will refuse:', e?.message || e); reportMiss('local-session-key-boot', e?.message || String(e)); }
  // Fix round 3, I-1 (corrects the round 2 design above, controller
  // the raw token itself must never leave either process - an
  // impostor on this loopback port could otherwise ignore it entirely and
  // forge its own records/allowlist. Both directions instead exchange a
  // proof of KNOWLEDGE of the token: see server/lib/governance/launch-auth.js
  // for the exact scheme. `rawBody` is the exact bytes this request
  // carried (hashed into the proof) - '' for the GET route, which has none.
  //
  // the proof is bound to direction 'req', the method and
  // the target (req.url) this request actually arrived on, so a proof
  // captured from one route, id or direction verifies nowhere else; and,
  // once the proof verifies (never before, so only a token holder can add
  // entries), launchNonces refuses a nonce outside its freshness window or
  // one already accepted.
  const launchNonces = createNonceGuard();
  // A paired client's token, resolved even on loopback (the access guard skips
  // the token check there), or null.
  const launchClient = (req) => { const c = authenticateClient(presentedTokenFrom(req.headers)); return c && c.paired ? c : null; };
  function verifyLaunchProof(req, rawBody) {
    if (!launchToken) return false;
    const nonce = req.headers['x-launch-nonce'];
    const proof = req.headers['x-launch-proof'];
    if (typeof nonce !== 'string' || !nonce || typeof proof !== 'string' || !proof) return false;
    const expected = computeProof(launchToken, { direction: 'req', method: req.method, path: req.url, nonce, bodyHash: sha256Hex(rawBody) });
    if (!proofsMatch(proof, expected)) return false;
    // Post-breaker residual N2: a verified proof whose nonce is refused
    // (replayed, stale, cache full) is worth seeing - a replay against the
    // real kernel is exactly that. Reported only after the proof verified,
    // so an unauthenticated caller cannot drive this alert.
    const verdict = launchNonces.accept(nonce);
    if (!verdict.ok) reportMiss('launch-nonce', `${req.method} ${req.url}: ${verdict.reason}`);
    return verdict.ok;
  }
  function launchResponseProof(req, body) {
    const nonce = req.headers['x-launch-nonce'];
    if (!launchToken || typeof nonce !== 'string' || !nonce) return null;
    return computeProof(launchToken, { direction: 'res', method: req.method, path: req.url, nonce, bodyHash: sha256Hex(body) });
  }
  // Signs a launch-route JSON response so the shell can verify it actually
  // came from the kernel holding the real token, over the EXACT bytes
  // sent - reusing the SAME nonce the caller's own request carried. A
  // caller with no nonce (a malformed request, or launches disabled) just
  // gets an unsigned response; there is nothing for it to verify anyway.
  function sendLaunchAuthed(req, res, code, obj) {
    const body = JSON.stringify(obj);
    const headers = { 'content-type': 'application/json' };
    const proof = launchResponseProof(req, body);
    if (proof) headers['x-launch-response-proof'] = proof;
    res.writeHead(code, headers);
    res.end(body);
  }
  // Same as sendLaunchAuthed, for the result route's empty 204 body.
  function sendLaunchAuthedEmpty(req, res, code) {
    const headers = {};
    const proof = launchResponseProof(req, '');
    if (proof) headers['x-launch-response-proof'] = proof;
    res.writeHead(code, headers);
    res.end();
  }
  // the obligations store, opened once at boot, BEFORE the
  // loop registry (so the registry's own onRegister/onOk adapter below can
  // wrap it). node:sqlite is unavailable throws a named error rather than
  // crashing boot - obligationStore stays null, /api/obligations answers
  // 503, /healthz's open_obligations stays null, and the obligation-sweeper
  // loop (registered below) fails every run with the reason, which is a
  // visible `loop` alert, never silence.
  // db/kernel.db for a fresh state folder; an existing root kernel.db keeps
  // being the one opened so the live database is never split (state-dir.js).
  const kernelDbFile = dbFileFor(P.stateDir);
  let obligationStore = null;
  try { obligationStore = openObligationStore({ dbFile: kernelDbFile, stateDir: P.stateDir }); }
  catch (e) { console.error('[kernel] obligations store failed to open:', e?.message || e); }
  // Paired client taps (server-and-client-tap task 3). A store that fails to
  // open leaves every client token at 401: fail closed, never open.
  let clientStore = null;
  try { clientStore = openClientStore({ dbFile: kernelDbFile }); }
  catch (e) { console.error('[kernel] clients store failed to open:', e?.message || e); }
  // Card glmps-2-0-152: every pairing and rotation signs the tap's own public
  // key with the client-issuing CA, created on first use.
  const issueTapCert = ({ clientId, publicKeyPem }) => {
    const ca = ensureClientCa(P.stateDir);
    return issueClientCert({ caCertPem: ca.certPem, caKeyPem: ca.keyPem, publicKeyPem, clientId });
  };
  const pairing = clientStore ? createPairing({ clientStore, issueCert: issueTapCert }) : null;
  // The cert-expiry loop's last reading, rendered by the alert center.
  let certExpiry = [];
  const readCertExpiry = () => certExpiryFindings({ serverNotAfter: serverTls?.serverNotAfter ?? null, serverHost: bindHost, serverHostCovered: serverTls?.serverHostCovered ?? null, clients: clientStore ? clientStore.list() : [] });
  const tapRelease = createTapRelease({ stateDir: P.stateDir });
  // What a tap compares against its installed bundle (card glmps-2-0-runtime-67).
  // null when nothing is published or the release fails its own hash check.
  const tapUpdateAdvert = async () => {
    try {
      const r = await tapRelease.load();
      if (!r.ok) return null;
      const f = r.files.update;
      return { version: r.release.version, commit: typeof r.release.commit === 'string' ? r.release.commit : null, sha256: f.sha256, size: f.size };
    } catch (e) {
      console.error('[kernel] tap update advert failed', e?.message || e);
      return null;
    }
  };
  // Tap ingest inbox (task 9). A store that fails to open answers 503 on ingest.
  let tapIngest = null;
  try { tapIngest = openTapIngest({ dbFile: kernelDbFile }); }
  catch (e) { console.error('[kernel] tap ingest store failed to open:', e?.message || e); }
  // The server box's own budget plus each live client's (derived on the client, shipped as 'budget' records).
  const readCombinedBudget = async () => {
    const local = await readBudget({ credentialsFile: P.credentialsFile, statuslineFile: P.cmStatuslineFile });
    let rows = [];
    try { rows = tapIngest?.latestByKind('budget') ?? []; } catch { /* fail open: local value only */ }
    const clientName = (id) => { const c = clientStore?.get(id); return c && !c.revokedTs ? c.name : null; };
    return combineBudget(local, rows, { clientName });
  };
  // File mirror (task 10): per-client copies of session files under <stateDir>/clients/<id>/mirror.
  let tapMirror = null;
  try {
    const q = cfg.tap?.mirrorQuotaBytes;
    tapMirror = openTapMirror({ dbFile: kernelDbFile, stateDir: P.stateDir, ...(Number.isSafeInteger(q) && q > 0 ? { quotaBytes: q } : {}) });
  } catch (e) { console.error('[kernel] tap mirror store failed to open:', e?.message || e); }
  // Git summaries (card glmps-2-0-runtime-40): the latest per-repo set each client reported.
  let tapGit = null;
  try { tapGit = openTapGit({ dbFile: kernelDbFile }); }
  catch (e) { console.error('[kernel] tap git store failed to open:', e?.message || e); }
  const authenticateClient = (t) => {
    try { return clientStore ? clientStore.authenticate(t) : null; }
    catch (e) { console.error('[kernel] client token check failed:', e?.message || e); return null; }
  };
  // Shared with onLoopStreak below (D6a's failure-streak card) and the
  // obligation-sweeper's own expiry diagnosis (K4): one closure, one place
  // backlog cards from either path land.
  // makeAutoFiler is the one project rule for server-side filers: an old 2.0
  // name resolves to the canonical project, and no auto-filed card can land in
  // `default` or the frozen 1.0 `glmps` project.
  const fileCard = makeAutoFiler((input) => backlogStore.addItemTo(P.stateDir, input, { trust: 'operator' }), projectTable);
  // K4/D6a-style operator post, reused by the obligation-sweeper's escalation
  // ladder (K4) below. `mention` prefixes the first SCUT allowed-user id.
  // `scut` is assigned later (startScut(), near the bottom of this
  // function) - safe to reference here because this function's BODY only
  // runs on an actual post, well after boot finishes. SCUT not configured
  // (scut still null, or its own postToOperator absent) is a named no-op,
  // never a crash: the dashboard alert and the diagnosis card are the
  // always-on channels; Slack is the bonus one.
  function postToOperator(text, opts) {
    return scut?.postToOperator ? scut.postToOperator(text, opts) : Promise.resolve();
  }
  // K4/D6a: fired once per failure streak, at exactly the third consecutive
  // failure (loop-registry.js record()). The actual logic (the Slack post,
  // the maxPerDay-capped diagnosis card, the on-disk budget counter so a
  // restart never resets the ceiling) is auto-diagnosis.js's own
  // handleLoopStreak, unit-tested there; this is only
  // the I/O adapter, wiring the server's own chatCompletion/backlogStore/scut
  // into it. Never awaited by the registry (onStreak is called synchronously
  // and only catches a synchronous throw - see registry.js record()), so any
  // rejection here is logged instead of becoming an unhandled rejection.
  function onLoopStreak({ name, record }) {
    handleLoopStreak({
      name, record, stateDir: P.stateDir, cfg: cfg.kernel.diagnosis,
      chatCompletion,
      fileCard,
      postToOperator: scut?.postToOperator ? (text) => scut.postToOperator(text) : undefined,
      log: (m) => console.error('[loops]', name, m),
    }).catch((e) => console.error('[loops] streak handling crashed', name, e?.message || e));
  }
  // the loop registry, the program's section 0 loop contract made real.
  // Every scheduled job the kernel owns registers here (Task 2 only wires the
  // registry itself, its health-alert rendering and its HTTP surface; onStreak
  // is wired in Task 4, obligations in Task 11, and the loops themselves land
  // in the tasks that own each job).
  const loopRegistry = createLoopRegistry({
    stateDir: P.stateDir,
    onRun: (r) => broadcastLoop(r),
    onStreak: onLoopStreak,
    obligations: obligationStore ? loopObligations(obligationStore) : null,
    log: (m) => console.error('[loops]', m),
  });
  // the nightly autonomous run (scripts/nightly-run.mjs) is driven
  // by an external trigger (a Windows Scheduled Task), never by a setInterval
  // in this process, so it is registered as an external loop: its maker is
  // never called (report() is the only way an external loop's outcome is
  // recorded), and its checker never runs (an external loop's success comes
  // only from a caller reporting it, never from a checker verifying it here).
  // The SLA is the loop contract's only real enforcement for this one: a
  // maxAgeMs of 36h catches a scheduled task that silently stopped firing.
  loopRegistry.registerLoop({
    name: 'nightly-run',
    trigger: { external: 'Windows Scheduled Task (scripts/register-nightly-task.ps1)' },
    maker: async () => { throw new Error('external loop: reported by scripts/nightly-run.mjs'); },
    checker: async () => ({ ok: false, reason: 'external' }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 1 },
    // Phase K final review I2: a loop that cannot run must not open a
    // freshness promise. The Scheduled Task only fires nightly-run while
    // cfg.nightly.enabled is true (false by default, forced false in the 2.0
    // shadow); otherwise its obligation expired into a false alert 36h
    // after every boot.
    sla: cfg.nightly?.enabled === true ? { maxAgeMs: 36 * 3_600_000 } : { maxAgeMs: 36 * 3_600_000, obligation: false },
  });
  // the obligation sweeper itself. sla.obligation: false -
  // this loop's own freshness is not itself tracked as an obligation
  // (nothing sweeps the sweeper; its own health is the ordinary loop-health
  // failure-streak path, same as any other loop). diagnose only fires for a
  // 'loop.freshness' row whose loop still exists in this registry - a row
  // for a since-removed loop, or any other obligation kind, is left for a
  // human (decision.deferred/decision.cancelled, via POST
  // /api/obligations/:id/close) rather than guessed at.
  // glmps-2-0-64: a host sleep (no restart) is detected from this heartbeat's
  // own wall-clock gap and the sweeper checks it too before expiring
  // anything, so obligations due inside the sleep are rebased, not expired.
  // The stop record carries it, so the next start can say "N min after a wake".
  let lastWakeTs = null;
  const suspendDetector = createSuspendDetector({
    gapMs: 60_000,
    onSuspend: (s) => {
      lastWakeTs = Date.now();
      const rebased = obligationStore ? rebaseForSuspend(obligationStore, s) : [];
      console.error(`[kernel] host resumed after ${Math.round(s.gapMs / 1000)}s; rebased ${rebased.length} obligation row(s)`);
      try { emitSpineEvent(P.stateDir, { kind: SPINE_KINDS.HOST_RESUMED, actor: 'kernel', label: `host resumed after ${Math.round(s.gapMs / 60_000)}m`, payload: { ...s, rebased } }); }
      catch (e) { console.error('[kernel] host.resumed spine write failed:', e?.message || e); }
    },
  });
  suspendDetector.check();
  const suspendHeartbeat = setInterval(() => {
    try { suspendDetector.check(); } catch (e) { console.error('[kernel] suspend check failed:', e?.message || e); }
  }, 10_000);
  suspendHeartbeat.unref?.();
  loopRegistry.registerLoop({
    name: 'obligation-sweeper',
    trigger: { everyMs: cfg.kernel.obligationSweepMs },
    ...obligationSweeperLoop({
      store: obligationStore,
      suspend: suspendDetector,
      // An expired independent-review row still escalates in the ledger and on
      // the dashboard, but not in Slack (card glmps-2-0-219).
      notify: (row, level) => (row.kind === 'gate.independent-verdict'
        ? Promise.resolve()
        : postToOperator(overdueNotice(row, level, row.kind === 'loop.freshness' ? loopRegistry.get(row.subject) : null), { mention: level >= 2 })),
      // K4 fix round 1, item 1, corrected fix round 2,
      // the
      // eligibility check below (a 'loop.freshness' row whose loop still
      // exists) is what keeps ANY other row - a gate.independent-verdict
      // expiry, or a since-removed loop's freshness row - from ever
      // touching ctx.countModelCall() or the persisted daily budget at
      // all: only a row this branch actually diagnoses can ever spend
      // either ceiling. diagnosisStubReason (auto-diagnosis.js) is the one
      // shared decision for the rest, in this exact order: disabled, then
      // the persisted daily budget (PEEKED, not yet spent - handleLoopStreak's
      // own diagnosis uses the same counter), then this run's own
      // per-attempt ceiling (ctx, a CeilingError only - anything else
      // propagates, never a bare catch), and only once BOTH of those pass
      // does it actually consume the daily budget slot. The budget must be
      // peeked before the ceiling: checking the ceiling first (the
      // original order) spent a run-ceiling slot on every eligible row
      // regardless of whether the daily budget even had room, so a burst
      // of budget-exhausted rows alone could fail the run on
      // ceiling:model-calls despite making zero real model calls. Over any
      // of the three gates: diagnoseLoop still runs and still files the
      // card, fed a chatCompletion stub that throws immediately - its own
      // catch turns that into the card's body, so the breach is recorded,
      // never silent (same pattern as handleLoopStreak's own overCeiling
      // branch).
      // Phase K final review I2 and minors: the rest (dedupe against a
      // failure-streak card for the same outage, the one-real-diagnosis-per-
      // sweep cap, the card text that names the expiry) lives in
      // auto-diagnosis.js's handleFreshnessExpiry, unit-tested there.
      diagnose: (row, ctx) => {
        // glmps-2-0-39: an expired gate row gets one judge.session job so a
        // fresh verdict can still close it; no model budget is touched here.
        if (row.kind === 'gate.independent-verdict') {
          if (!judgeCfg.enabled) return Promise.resolve();
          try { reconcileGateObligation({ row, loadItems: () => backlogStore.load(P.stateDir).items, retryQueue }); }
          catch (e) { console.error('[kernel] gate reconcile failed for', row.subject, e?.message ?? String(e)); }
          return Promise.resolve();
        }
        if (row.kind !== 'loop.freshness' || !loopRegistry.get(row.subject)) return Promise.resolve();
        return handleFreshnessExpiry({
          row, record: loopRegistry.get(row.subject), ctx, stateDir: P.stateDir, cfg: cfg.kernel.diagnosis,
          chatCompletion, fileCard, log: (m) => console.error('[kernel]', m),
        });
      },
    }),
    // RULING: one real diagnosis per sweep
    // (handleFreshnessExpiry), so maxModelCalls is 1 and the timeout sits
    // above one claude -p call's own 120 s worst case plus the card write.
    // A longer timeout for five sequential calls (over 10 minutes) would
    // break this loop's own 5-minute SLA instead.
    ceiling: { maxAttempts: 1, maxModelCalls: 1, timeoutMs: 150_000 },
    sla: { maxAgeMs: 5 * 60_000, obligation: false },
  });
  // the git-remote residency feed. Per registered
  // checkout (gitRepoRoots(), the same set /api/projects and the worktree
  // sweeper already use; session-edits and the surface routes map rows per
  // checkout), five read-only git reads fold into one row
  // saying whether that checkout's work also exists somewhere else or only
  // on this machine. Reuses the shared gitLimiter/execFileAsync pair
  // (L282-323) rather than a second limiter, same as the unmerged-branch
  // scan and worktree sweeper above. execFileAsync itself resolves a bare
  // stdout string, not { stdout } - the adapter below is what gives the
  // feed's own exec contract (and its tests) a consistent { stdout } shape
  // to destructure. Real sla (no obligation: false): a stale residency
  // feed is worth a freshness obligation, unlike the sweeper above.
  loopRegistry.registerLoop({
    name: 'git-remote-feed',
    trigger: { everyMs: cfg.kernel.gitRemoteFeedMs },
    ...createGitRemoteFeedLoop({
      gitRepoRoots,
      // A call still waiting in the limiter queue when its run is aborted never
      // spawns; one already running is killed by execFile's own signal option.
      // queuedMs is the wait for a gitLimiter slot, reported on the result and
      // on a rejection alike so the run record separates it from git's own time.
      exec: (f, a, o) => {
        const enq = Date.now();
        return gitLimiter(() => {
          const queuedMs = Date.now() - enq;
          return (o?.signal?.aborted
            ? Promise.reject(Object.assign(new Error('git-remote-feed run aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
            : execFileAsync(f, a, { ...o, encoding: 'utf-8', timeout: 8000, windowsHide: true }))
            .then((stdout) => ({ stdout, queuedMs }), (e) => { if (e && typeof e === 'object') e.queuedMs = queuedMs; throw e; });
        });
      },
      // Every run's numbers, a timed-out one above all, land in last-run.json
      // and the service log, since the registry records only "timeout".
      onRun: (run) => {
        console.log(`[git-remote-feed] ${run.outcome} wall=${run.wallMs}ms checkouts=${run.checkouts} calls=${run.gitCalls} queue=${run.gitQueueMs}ms (max ${run.maxQueueMs}) exec=${run.gitExecMs}ms (max ${run.maxExecMs}) timeouts=${run.gitTimeouts} failures=${run.gitFailures} aborted=${run.gitAborted}`);
        try {
          const file = path.join(P.stateDir, 'residency', 'last-run.json');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(run));
          fs.renameSync(tmp, file);
        } catch (e) { console.warn(`[git-remote-feed] could not write last-run.json: ${e?.message || e}`); }
      },
      writeCurrent: (doc) => {
        const file = path.join(P.stateDir, 'residency', 'current.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc));
        fs.renameSync(tmp, file);
      },
    }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5 * 60_000 },
    sla: { maxAgeMs: 60 * 60_000 },
  });
  // Card glmps-2-0-runtime-40: keep a bare mirror clone of each GitHub remote a client reports, so commit history and
  // 'is the client HEAD pushed' come from this disk. In service mode the shell clones and fetches (the operator's GitHub
  // sign-in lives there, D33); otherwise git runs here with prompts off. Local reads are always direct.
  const gitClonesStateFile = path.join(gitClonesDir, 'state.json');
  const readGitClonesState = () => { try { return JSON.parse(fs.readFileSync(gitClonesStateFile, 'utf8')); } catch { return null; } };
  const runGitDirect = (args, { cwd, timeout = 8000, network = false } = {}) => new Promise((resolve) => {
    execFile('git', args, {
      cwd, encoding: 'utf-8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024,
      ...(network ? { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } : {}),
    }, (err, stdout, stderr) => resolve({
      status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr || (err ? String(err.message ?? err) : ''),
    }));
  });
  const tapGitClones = {
    hosts: Array.isArray(cfg.tap?.gitCloneHosts) && cfg.tap.gitCloneHosts.length ? cfg.tap.gitCloneHosts.filter((h) => typeof h === 'string') : ['github.com'],
    everyMs: Number.isSafeInteger(cfg.tap?.gitClonesMs) && cfg.tap.gitClonesMs > 0 ? cfg.tap.gitClonesMs : 15 * 60_000,
  };
  loopRegistry.registerLoop({
    name: 'tap-git-clones',
    trigger: { everyMs: tapGitClones.everyMs },
    ...createTapGitClonesLoop({
      remotes: () => tapGit?.remotes() ?? [],
      serverCheckouts: () => residencyRows(),
      clonesDir: gitClonesDir,
      hosts: tapGitClones.hosts,
      ...(tapGitCloneUrlFor ? { urlFor: tapGitCloneUrlFor } : {}),
      git: (args, { cwd }) => {
        if (gitopsViaShell) return shellSeams.git(args, { cwd }, { timeoutMs: 120_000, extraRepos: [gitClonesDir] });
        fs.mkdirSync(gitClonesDir, { recursive: true });
        return runGitDirect(args, { cwd, timeout: 120_000, network: true });
      },
      read: (args, { cwd }) => runGitDirect(args, { cwd }),
      readState: readGitClonesState,
      writeState: (doc) => {
        fs.mkdirSync(gitClonesDir, { recursive: true });
        const tmp = `${gitClonesStateFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc));
        fs.renameSync(tmp, gitClonesStateFile);
      },
    }),
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 10 * 60_000 },
    sla: { maxAgeMs: 2 * 60 * 60_000 },
  });
  // Task 12b: the launch queue's own freshness loop. A pending launch that
  // sits unclaimed for more than two minutes means the desktop shell is not
  // running or not claiming - the one failure mode this whole feature exists
  // to make visible rather than let a launch wait forever with nothing on
  // the operator's screen. Three consecutive failures (the loop's own
  // STREAK_AT=3, so at 1-minute intervals, three minutes) raises the
  // dashboard alert, the Slack post and the diagnosis card, same as any
  // other loop - never a silently stuck queue.
  loopRegistry.registerLoop({
    name: 'launch-queue',
    trigger: { everyMs: 60_000 },
    maker: async () => {
      // Fix round 2, m-e: a pending record (never even claimed) never
      // expired either - resume/terminal/learning are bounded by a fixed
      // 10-minute idle-too-long time; a runner record by the JOB's own
      // remaining runtime budget (maxRuntimeMs), since it would already
      // be considered overrun by the runner's own reconcile regardless of
      // whether the shell ever opens it. Run before the staleness check
      // below, same reasoning as the claimed-side sweep: once something
      // expires, the loop stops alerting about it.
      const rcForExpiry = runnerStore.loadConfig(P.stateDir);
      // loadLedger answers {} on any read error, which
      // made every pending runner launch look orphaned (below) on one
      // transient read failure. readLedger names the failure; runner-origin
      // expiry is then skipped for this sweep (named), never guessed.
      const { ledger: ledgerForExpiry, error: ledgerError } = runnerStore.readLedger(P.stateDir);
      if (ledgerError) reportMiss('launch-queue-ledger', `runner-origin launch expiry skipped: ${ledgerError}`);
      else clearMiss('launch-queue-ledger');
      const expired = launchBroker.expirePending((r, nowMs) => {
        if (r.origin !== 'runner') return (nowMs - r.ts) > 10 * 60_000;
        if (!ledgerForExpiry) return false;
        const jobId = Object.keys(ledgerForExpiry).find((k) => ledgerForExpiry[k].launchId === r.id);
        // an ORPHANED record (no ledger entry points at
        // its launchId at all - the job was relaunched under a different
        // launchId, the same scenario R2-2 covers at claim time, but this
        // is the never-claimed PENDING side R2-2 never reaches) used to
        // return false here UNCONDITIONALLY - with no jobId to look up a
        // startedAt against, it could never be judged "past its own
        // runtime budget", so it sat pending forever. An orphan has no
        // legitimate owner left to ever claim it: stale immediately,
        // not a deadline it will eventually cross.
        return jobId ? (nowMs - ledgerForExpiry[jobId].startedAt) > rcForExpiry.maxRuntimeMs : true;
      }, 'expired before the shell opened it');
      for (const r of expired) {
        broadcastLaunch(r.id, r.state);
        appendEvent(P.stateDir, { kind: 'launch.failed', lane: r.origin, label: String(r.command).slice(0, 120), path: r.cwd, ts: Date.now(), sessionId: null });
      }
      // a claimed record with no result (the shell
      // quit mid-tick, or an earlier record's result POST in the same
      // batch threw) must not keep this loop red forever by itself -
      // actively resolved (moved to failed) before the staleness check
      // below ever runs, so a claim that just timed out this instant is
      // never also reported as an alert. Deliberately NOT I6's runner
      // hold-and-delete: the terminal may genuinely be open and only the
      // result POST was lost, so the ledger entry (and the card) are left
      // exactly as they were.
      // a gitops run (a test suite) outlasts 60 s; its client times it out itself
      const timedOut = [
        ...launchBroker.failStaleClaims(60_000, 'no result from shell', (r) => r.origin === 'gitops' || !!r.targetClient),
        ...launchBroker.failStaleClaims(60_000, 'no result from the client tap', (r) => !r.targetClient),
      ];
      for (const r of timedOut) {
        broadcastLaunch(r.id, r.state);
        appendEvent(P.stateDir, { kind: 'launch.failed', lane: r.origin, label: String(r.command).slice(0, 120), path: r.cwd, ts: Date.now(), sessionId: null });
      }
      // oldestPendingAgeMs() alone only ever sees 'pending' rows - the
      // two sweeps above are what now cover the expired-pending and
      // stale-claimed sides.
      const staleness = launchQueueStaleness(launchBroker, { shellPolledAt, bootedAt: launchesBootedAt });
      if (staleness.stale) throw new Error(staleness.reason);
      return { outcome: launchBroker.pending().length ? 'done' : 'nothing-to-do', result: { pending: launchBroker.pending().length, expired: expired.length, timedOut: timedOut.length } };
    },
    checker: async () => {
      const bad = launchBroker.pending().filter((r) => !r.command || !r.cwd || !LAUNCH_ORIGINS.includes(r.origin));
      return bad.length ? { ok: false, reason: `${bad.length} malformed queued launch(es)` } : { ok: true };
    },
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5_000 },
    sla: { maxAgeMs: 10 * 60_000, obligation: false },
  });
  // GET /healthz's liveness contract. version starts at '+unknown' and is
  // corrected once readBootVersion's async git call resolves -- never a file
  // read (or a process spawn) per request. open_obligations is
  // obligationStore.countOpen() once the store is open; null when
  // it failed to open at boot.
  const bootTs = Date.now();
  let kernelVersion = `${PKG.version ?? '0.0.0'}+unknown`;
  readBootVersion({ repoRoot: REPO_ROOT, pkgVersion: PKG.version, log: (m) => console.error('[healthz]', m) }).then((v) => {
    kernelVersion = v;
    // Classified once the version is known: a changed version across a clean
    // stop is a deploy (card glmps-2-0-85).
    try {
      const s = recordStart(P.stateDir, { version: v, now: bootTs });
      console.log(`GLMPS: kernel start: ${s.reason}${s.by ? ` (asked by the ${s.by.via})` : ''}${s.overranIn ? `; the last shutdown overran in ${s.overranIn}` : ''}`);
    } catch (e) { console.error('[kernel] start record failed:', e?.message || e); }
  });
  // Set by the restart route or the first close step; one stop record per process.
  let stopRecorded = false;
  let closeStage = null;
  const noteStop = (kind, by = null) => {
    if (stopRecorded) return;
    stopRecorded = true;
    try { recordStop(P.stateDir, { kind, by, version: kernelVersion, lastWakeTs }); }
    catch (e) { console.error('[kernel] stop record failed:', e?.message || e); }
  };
  bootTrace.mark('setup');
  const eventLoopDelay = createEventLoopDelayMonitor();
  let lastEventTs = null;
  // glmps-8b: P (and P.internalSessionsFile) is not resolved yet at
  // mdCfg's own declaration above, so wire it in here instead of moving mdCfg
  // down past everything it's declared before.
  mdCfg.internalSessionsFile = P.internalSessionsFile;

  // No fallback: a plugin failure shows as a loop failure (K Task 6: the
  // registered memory-admission loop, server/lib/loops/plugin-loops.js) and
  // the work queues on retryQueue for the plugin-retry loop, rather than ever
  // running the pre-D23 pipeline (deleted at this same cutover). A missing
  // embed model is a fail-open boot (log + keep booting), per D24 -- this is
  // a local server that must still start with no model installed yet.
  const retryQueue = createRetryQueue({
    file: path.join(P.stateDir, 'plugins', 'retry.ndjson'),
    // a torn/corrupt retry-queue line must not go
    // unnoticed. K Task 6 deletes the consecutive-failure alert this used to
    // raise (no single registered loop owns a queue-file-level corruption,
    // since the file can hold both memory.admit and judge.session jobs);
    // logged fail-open instead.
    onCorrupt: (n, file) => {
      const reason = `${n} unreadable line(s) in ${file}`;
      console.error(`[loops] retry queue: ${reason}`);
      reportMiss('retry-queue', reason); // I8
    },
    onOk: () => clearMiss('retry-queue'), // a clean read ends any earlier corruption episode.
  });
  // glmps-2-0-39: backfill gate obligations orphaned before the card lookup
  // and re-judge fixes (their judge.session jobs were already acked). Fail open.
  if (obligationStore && judgeCfg.enabled) {
    try {
      const { queued } = reconcileOpenGateRows({ store: obligationStore, loadItems: () => backlogStore.load(P.stateDir).items, retryQueue });
      if (queued) console.error(`[kernel] gate reconcile queued ${queued} judge.session job(s) at boot`);
    } catch (e) { console.error('[kernel] boot gate reconcile failed:', e?.message ?? String(e)); }
  }
  // guards POST /api/memory/migrate-distilled
  // against two overlapping calls racing the same ledger file. Tested
  // deterministically at server/test/single-flight.test.js (a real HTTP
  // concurrency test proved unreliable: both undici's connection reuse and
  // the microtask-only work of an unconfigured Mem0 stub can let a
  // "concurrent" call finish before the second request is even dispatched).
  const migrateSingleFlight = createSingleFlight();
  // Guard proposer cutover, K Task 6: the guard-proposals loop's
  // own registry.isRunning('guard-proposals') (server/lib/loops/registry.js)
  // is the single-flight guard now - registerLoop's default allowOverlap:
  // false already refuses a second concurrent run at the registry level, so
  // there is no longer a separate boolean flag to keep in sync with it.
  // Set below on a missing/unreadable embed model; reported once the
  // memory-admission loop exists (registerPluginLoops, further down) via
  // loopRegistry.report - K Task 6's named replacement for the deleted
  // consecutive-failure tracker's own embed-key alert.
  let embedderMissingReason = null;
  bootTrace.mark('pre-plugin setup');
  // The plugin runs in a worker thread (glmps-197): Mem0's brute-force vector
  // scan and the onnx embed would otherwise stall this event loop. The client
  // is the memory@1 surface; a failed init is reported here, and calls then
  // reject with the text the old in-process stub gave.
  const memoryWorker = createMemoryWorker({
    modelDir: path.join(P.stateDir, 'models', 'bge-small-en-v1.5'),
    dbDir: path.join(P.stateDir, 'plugins', 'mem0'),
    // see memory-plugin.js's wrapChatCompletionForMem0 for why this wrapper
    // exists. Applied only here, not to the shared `chatCompletion` other
    // plugins call through /api/plugins/model/v1/chat/completions.
    chatCompletion: wrapChatCompletionForMem0(chatCompletion),
  });
  const memoryPlugin = memoryWorker;
  const memoryInit = await memoryWorker.ready;
  if (!memoryInit.ok) {
    if (memoryInit.stage === 'embed') {
      // Phase K final review (silent-failure): the real reason is appended,
      // never discarded.
      embedderMissingReason = `model not installed: run node scripts/fetch-embed-model.mjs (${String(memoryInit.reason).split(/\r?\n/)[0].slice(0, 300)})`;
    } else {
      console.error('[loops] mem0 plugin failed to load:', memoryInit.reason);
      embedderMissingReason = memoryInit.reason;
    }
  }

  // No fallback: a null judgePlugin (failed to load at boot) is handled the
  // same as any other judge failure - the session-judge / plugin-retry loops
  // (K Task 6, server/lib/loops/plugin-loops.js) throw and queue a retry when
  // a due job's judge is null, rather than ever silently skipping it.
  let judgePlugin = null;
  try {
    judgePlugin = await loadAdapter('judge');
    judgePlugin.configureHost({ chatCompletion });
    clearMiss('judge-load'); // a successful load ends any earlier boot-failure episode.
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    console.error('[loops] judge plugin failed to load:', reason);
    reportMiss('judge-load', reason); // I8
    judgePlugin = null;
  }
  bootTrace.waited('plugin load');
  // The judge's devlog mirror uses the SAME store call as POST
  // /api/backlog/:id/devlog, so a verdict reads exactly like an agent's own
  // devlog line. Best-effort: an append failure (e.g. the card was archived
  // between session start and finish) never throws back into the judge.
  const appendJudgeDevlog = (ticketId, text) => {
    try { backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'judge', text }); } catch { /* best-effort mirror */ }
  };
  // Moved up from its original position (just before `clients` below) so the
  // judge adapter can pass it to createJudgeAdapter
  // as a value, not just close over it inside a deferred callback - eventLog
  // has no dependencies of its own, so hoisting it here is free.
  const eventLog = new Map();                              // sessionId -> events[] (ring, cap 2000)

  // The pre-D23 consecutive-failure tracker is deleted; loopAlerts
  // (alert-sources.js) is its permanent replacement. The three adapters
  // registerPluginLoops drives now live in their own tested module
  //  -
  // server.js only supplies the real, live dependencies each one closes
  // over.
  const readGuards = () => {
    try {
      const globalMd = fs.readFileSync(path.join(P.assetsDir, 'CLAUDE.global.md'), 'utf-8');
      return sectionBodyLines(globalMd, 'Learned guards').join('\n');
    } catch (e) {
      // A CLAUDE.global.md that does not exist yet is the normal steady
      // state (no guards landed there yet) - GEPA sees an empty seed. Any
      // OTHER read failure (EACCES, EISDIR, a transient disk error) must
      // fail the run loudly, not silently propose from an empty seed as if
      // nothing were wrong.
      if (e && e.code === 'ENOENT') return '';
      throw e;
    }
  };
  const memoryAdapter = createMemoryAdapter({
    memoryPlugin, scan: scanText, stateDir: P.stateDir, retryQueue, embedderMissingReason,
    log: (...args) => console.error('[loops]', ...args),
  });
  const judgeAdapter = createJudgeAdapter({
    judgePlugin, stateDir: P.stateDir, appendDevlog: appendJudgeDevlog, eventLog, readEvents, obligationStore,
  });
  const gepaAdapter = createGepaAdapter({
    runGepa,
    runGepaArgs: () => {
      const gepaCfg = cfg.plugins?.gepa ?? {};
      return {
        repoRoot: REPO_ROOT,
        stateDir: P.stateDir,
        // modelUrl is this server's own /api/plugins/model/v1 endpoint on
        // actualPort - a const assigned once the server is listening, well
        // before this is ever actually called (guard-proposals only fires
        // on a manual POST or its own optional interval, never during
        // boot) - the CLI refuses any non-localhost URL.
        modelUrl: `http://127.0.0.1:${actualPort}/api/plugins/model/v1`,
        models: getModelConfig(cfg).models,
        maxMetricCalls: gepaCfg.maxMetricCalls ?? 40,
        maxWallSeconds: gepaCfg.maxWallSeconds ?? 2400,
        readGuards,
        loadStore: () => learningStore.load(P.stateDir),
        saveStore: (s) => learningStore.save(P.stateDir, s),
        // Injectable so a test can point at a tiny fake script instead of
        // the real CLI (which would reach the real model route, and from
        // there real `claude -p` - never allowed in a test).
        python: env.GLMPS_GEPA_PYTHON || 'python',
        ...(env.GLMPS_GEPA_SCRIPT ? { scriptPath: env.GLMPS_GEPA_SCRIPT } : {}),
        // same poison scan memory
        // admission uses, so a flagged rule is quarantined rather than
        // ingested as a pending proposal an operator could approve blind.
        scan: scanText,
      };
    },
    learningStore, stateDir: P.stateDir,
  });

  const retryDeadLetterFile = path.join(P.stateDir, 'plugins', 'retry-dead.ndjson');
  registerPluginLoops({
    registry: loopRegistry, retryQueue, memory: memoryAdapter, judge: judgeAdapter, gepa: gepaAdapter,
    gepaEveryMs: cfg.plugins?.gepa?.intervalMs ?? 0,
    // restores the dead-letter write a give-up used to make.
    deadLetterFile: retryDeadLetterFile,
  });
  // The embedderMissingReason report (K Task 6's named replacement for the
  // deleted tracker's own embed-key alert) fires further down, once `clients`
  // and broadcastLoop exist - report() calls onRun synchronously, and
  // broadcastLoop (loopRegistry's onRun hook, set up above at registry
  // creation) reads `clients`, which is not declared yet at this point in
  // startServer()'s own execution order.

  // Card <-> session bridge, same technique as routing-compliance.js's own
  // ledger-worktree-dir-vs-session-cwd comparison (server.js names a
  // worktree after the job id, so a session's cwd is the one reliable link
  // back to the ticket that launched it) - reused here rather than
  // re-derived because that file already proved it, path-separator and
  // case quirks included. No worktree isolation for a job (shared repo
  // cwd) or no live ledger entry left by finalize time both fail open to
  // null: a guessed ticket id is worse than none, since the judge would
  // then write its devlog line onto the wrong card.
  const normDirForTicket = (s) => String(s ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  function resolveTicketIdForSession(sid) {
    // The card persists its session in runSession; the ledger is usually gone
    // by judge time (glmps-2-0-39), so it is only the fallback.
    try {
      const byCard = ticketIdForSession(backlogStore.load(P.stateDir).items, sid);
      if (byCard) return byCard;
    } catch { /* fall through to the ledger match */ }
    try {
      const cwd = index.get(sid)?.cwd;
      if (!cwd) return null;
      const key = normDirForTicket(cwd);
      const ledger = runnerStore.loadLedger(P.stateDir);
      for (const [id, entry] of Object.entries(ledger)) {
        const dir = entry?.worktree?.dir;
        if (dir && normDirForTicket(dir) === key) return id;
      }
    } catch { /* fail open to null below */ }
    return null;
  }

  // See docs/superpowers/specs/2026-06-30-non-local-bind-shared-token-design.md.
  // Bind host defaults to loopback (unchanged). If a non-local host is configured
  // and no token is set, auto-generate one (fail-safe) so the LAN surface is never
  // accidentally unauthenticated. The guard itself (per-request, loopback-bypass)
  // lives in lib/governance/access-guard.js and is applied at the handler top.
  // (bindHost, nonLocal and accessToken are resolved right after the state dir
  // is known, near the top of startServer: I1.)
  // per-process key for the wiki iframe's read-only tickets (a restart
  // simply invalidates outstanding tickets; the lens fetches a fresh one).
  const wikiTicketKey = crypto.randomBytes(32).toString('hex');

  const index = new IndexStore(P.indexFile);
  // Project roots the dashboard / map / navigator surface files from must be
  // openable in the in-app editor. This is a localhost tool over the user's own
  // repos, so allow REPO_ROOT + the synced additionalDirectories (the same repo
  // set the navigator lists), on top of the configured editableRoots.
  const _projectRoots = [REPO_ROOT];
  try {
    const dirs = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'))?.permissions?.additionalDirectories;
    if (Array.isArray(dirs)) _projectRoots.push(...dirs.filter((d) => typeof d === 'string'));
  } catch {}
  // F15/F16: the roots a launch cwd may sit in. Read fresh per request, like
  // collectGraphRoots, so an additionalDirectories edit applies without a restart.
  function launchRoots() {
    const roots = [REPO_ROOT, ...cfg.editableRoots, ...(Array.isArray(cfg.launchRoots) ? cfg.launchRoots : []), P.worktreesDir];
    try {
      const dirs = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'))?.permissions?.additionalDirectories;
      if (Array.isArray(dirs)) roots.push(...dirs.filter((d) => typeof d === 'string'));
    } catch {}
    return roots;
  }
  const fileApi = new FileApi([P.claudeDir, ...P.antigravityDirs, ...cfg.editableRoots, ..._projectRoots, ...(configFile ? [configFile] : [])], P.undoDir);
  // The Personality page links to a few Gemini files that sit outside every
  // editing root. These are open-in-editor targets only: nothing here reaches
  // the read or save routes, so no write path widens.
  const geminiDir = env.GLMPS_GEMINI_DIR ?? path.join(os.homedir(), '.gemini');
  const openOnlyApi = new FileApi(openOnlyRoots({ geminiDir }), P.undoDir);
  const offsets = readJsonSafe(P.offsetsFile) ?? {};      // { key: {offset, carry} }
  // sqlite-steps ids whose post-restart rehydrate has already been attempted
  // (glmps-71). The rehydrate branch is deliberately NOT mtime-gated,
  // so without this it re-runs every poll for any source that yields no events:
  // `eventLog` never gains an entry, so its `!eventLog.has(id)` guard can never
  // become false. On the live box that was 223 agy DBs re-read once per second
  // forever. Attempted, not succeeded: a source that legitimately has nothing
  // to give must not be retried every tick either.
  const sqlRehydrated = new Set();
  const clients = new Set();                               // SSE responses
  const buildId = String(Date.now());                     // per-process id; lets the UI detect a restart and reload
  let sessions = [];                                       // last discovery result
  const discoverClaudeForPoll = createClaudeDiscovery();
  let inventory = { skills: [], agents: [], memory: [], contextFiles: [] };
  let agAlive = false;
  let liveIdes = [];                                       // IDE target ids with a running process
  let agLabels = new Map();                                // uuid -> {title, workspace}
  let agLabelsMtimes = new Map();                          // pbPath -> mtimeMs (for refresh detection)
  const tokenStats = new Map();                            // sessionId -> { totalInput, totalOutput, totalCached, contextWindow, lastTurnTokens, ts }
  const workspaceSignals = [];                             // recorded high-divergence signals, read by the registered signal-producer below
  const workspaceSignalSeen = new Set();                   // dedup gate for workspaceSignal() - sessionId::detail already raised
  // C1 Phase-0: the ONE signal-producer seam (Coordination Contract sec 3,
  // docs/superpowers/specs/2026-07-11-c1-c2-b-aligned-design.md). This
  // REPLACES Build A's Task-8 attestation piggyback in collectCurrentAlerts()
  // below - same in-memory array, now read through the registry instead of
  // a hardcoded splice.
  registerProducer(() => workspaceSignals);

  // A pending approval gate is an agent frozen mid-run waiting on a human
  // (glmps-29). Slack is the primary way it asks, so this seam is the
  // answer to "what if Slack is down or the operator is at the desk": the gate
  // still surfaces on the board instead of being an unexplained 9-minute stall.
  // Reads the control records for gates this process opened; a restart clears
  // gateSessions, which is correct, because a gate the hook is no longer
  // blocking on cannot be answered anyway.
  registerProducer(() => {
    const out = [];
    for (const [id, sessionId] of gateSessions) {
      let gate = null;
      try { gate = ctlReadControl(P.stateDir, sessionId)?.gate ?? null; } catch { continue; }
      if (gate?.id !== id || gate.decision !== 'pending') continue;
      out.push({
        source: 'control-gate',
        severity: 'warn',
        title: `A session is waiting for approval: ${String(gate.summary || gate.tool || 'an action').slice(0, 80)}`,
        detail: `Gate ${id} (session ${String(sessionId).slice(0, 8)}). Approve or deny in Slack, or POST /api/control/gate/${id}/decision. It denies itself after 9 minutes.`,
        target: null,
        ts: gate.requestedTs || Date.now(),
      });
    }
    return out;
  });

  // 2.0 down alert: a death the watchdog recorded stays visible after restart.
  registerProducer(() => kernelCrashAlerts(P.stateDir));
  // Card glmps-2-0-85: an unclean exit, a run of restarts, a slow desktop app.
  registerProducer(() => [...kernelStartAlerts(readStarts(P.stateDir)), ...pickupSummary(shellPickups, { claimWaitMs: gitopsClaimWaitMs }).alerts]);

  // guard/skill retire-candidates also ride this seam (info severity - 
  // propose-only, not action-required). Recomputed fresh per call, matching
  // the "never cached" convention the dedicated routes below already use.
  registerProducer(() => {
    try {
      return retireCandidatesFromTemplates(appliedGuardCatalog().guards, shadowRates(P.stateDir), {}).map(c => ({
        source: 'guard-retire-candidate', severity: 'info',
        title: `Guard retire candidate: ${c.code}`, detail: c.reason,
        target: { view: 'substrate-loop' }, ts: 0,
      }));
    } catch { return []; }
  });
  registerProducer(() => {
    try {
      const skillEvents = readEvents(P.stateDir, {}).filter(e => e.kind === 'skill');
      const view = buildSkillsView(inventory, skillEvents);
      return archiveCandidates(view.skills, getObservedSince(P.stateDir), skCfg.exempt, { minObservationDays: skCfg.minObservationDays }).map(c => ({
        source: 'skill-retire-candidate', severity: 'info',
        title: `Skill archive candidate: ${c.name}`, detail: c.reason,
        target: { view: 'skills' }, ts: 0,
      }));
    } catch { return []; }
  });


  function applyMetaEvents(sessionId, metaEvents) {
    for (const e of metaEvents) {
      if (e.label === 'cwd' && e.path) index.upsert(sessionId, { cwd: e.path });
      else if (e.label === 'model' && e.model) index.upsert(sessionId, { model: e.model });
    }
    applyWorkspaceMeta(P.stateDir, sessionId, metaEvents);
  }

  // Track cumulative token totals from adapters that embed them in tokens events
  // (codex-cli today). Feeds status synthesis and the usage-store bridge.
  function trackTokens(sessionId, events) {
    for (const e of events) {
      if (e.kind !== 'tokens' || typeof e.change?.totalInput !== 'number') continue;
      const prev = tokenStats.get(sessionId);
      tokenStats.set(sessionId, {
        totalInput: e.change.totalInput,
        totalOutput: e.change.totalOutput ?? 0,
        totalCached: e.change.totalCached ?? 0,
        contextWindow: e.change.contextWindow ?? prev?.contextWindow ?? null,
        lastTurnTokens: e.change.lastTurnTokens ?? prev?.lastTurnTokens ?? null,
        ts: e.ts ?? prev?.ts ?? null,
      });
    }
  }

  function ctxPctOf(tk) {
    return tk?.contextWindow > 0 && tk?.lastTurnTokens > 0
      ? Math.min(100, Math.max(0, Math.round(100 * tk.lastTurnTokens / tk.contextWindow)))
      : null;
  }

  // Bridge cumulative token events into the usage store (Analytics). Only
  // adapters that embed cumulative totals emit these (codex-cli jsonl,
  // gemini-cli snapshots); tap-backed tools (Claude Code) never do, so there
  // is no double counting. `afterTotal` is a high-water mark: snapshot
  // adapters re-parse the whole file each change, so already-bridged levels
  // (totalInput+totalOutput <= mark) are skipped.
  function bridgeTokenEvents(sessionId, logEvents, { afterTotal = -Infinity } = {}) {
    for (const e of logEvents) {
      if (e.kind !== 'tokens' || typeof e.change?.totalInput !== 'number') continue;
      if (e.change.totalInput + (e.change.totalOutput ?? 0) <= afterTotal) continue;
      const rec = index.get(sessionId) ?? {};
      const tk = tokenStats.get(sessionId);
      const parsed = typeof e.ts === 'string' ? Date.parse(e.ts) : (typeof e.ts === 'number' ? e.ts : NaN);
      const capturedAt = Number.isFinite(parsed) ? parsed : Date.now();
      try {
        appendSnapshot(P.stateDir, {
          sid: sessionId, ts: capturedAt, capturedAt,
          model: rec.model ?? null, costUsd: null,
          input: e.change.totalInput, output: e.change.totalOutput ?? null,
          cacheRead: e.change.totalCached ?? null, cacheCreate: null,
          ctxUsedPct: ctxPctOf(tk), cwd: rec.cwd ?? null,
        });
      } catch {}
    }
  }

  // Local-capture attribution default (glmps-72 B1): every event ingested
  // through this process's capture pipeline (adapters, tap-drain, OTEL) is
  // stamped with a cheap actor identity here - the ONE place sessionId-keyed
  // events enter the log, so every adapter inherits it without being touched.
  // Purely a diagnostics covariate: nothing here enforces or branches on it
  // (see lib/governance/actors.js for the gate checks, which stay no-ops
  // while cfg.actors is empty).
  const localActor = env.GLMPS_ACTOR || cfg.actor || 'operator';

  function pushEvents(sessionId, events) {
    if (!events.length) return;
    // Handle meta events (e.g. kind:'meta' label:'cwd'): upsert index, never log or stream.
    const metaEvents = events.filter(e => e.kind === 'meta');
    const logEvents = events.filter(e => e.kind !== 'meta');
    applyMetaEvents(sessionId, metaEvents);
    if (!logEvents.length) return;
    for (const e of logEvents) { if (e.actor == null) e.actor = localActor; }
    // GET /healthz's last_event_ts, the freshest event seen this boot.
    for (const e of logEvents) { const ms = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts); if (Number.isFinite(ms) && (lastEventTs == null || ms > lastEventTs)) lastEventTs = ms; }
    trackTokens(sessionId, logEvents);
    bridgeTokenEvents(sessionId, logEvents);
    // Durable twin of the in-memory ring below (glmps substrate refactor phase 0):
    // append each event to the on-disk NDJSON log so the memory distiller, replay,
    // and any future reader don't have to re-parse transcripts. Fail-open - a
    // durability hiccup must never block the SSE/dashboard hot path.
    appendEvents(P.stateDir, logEvents);
    const log = eventLog.get(sessionId) ?? [];
    log.push(...logEvents);
    if (log.length > 2000) log.splice(0, log.length - 2000);
    eventLog.set(sessionId, log);
    index.applyEvents(sessionId, logEvents);
    const payload = `data: ${JSON.stringify({ type: 'events', sessionId, events: logEvents })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // The event names what changed (ids, or null when it cannot be named) and
  // the board version, so a client fetches those cards instead of the whole
  // board. prev is the version of the previous event: a client that missed one
  // sees a gap and refetches everything.
  // glmps-2-0-171 D3: every close path ends in a broadcast, so the notice is written here, before the change set is taken.
  function noteReadyHosts() {
    try {
      for (const n of hostsReadyToClose(backlogStore.load(P.stateDir).items)) {
        backlogStore.appendDevLogIn(P.stateDir, n.id, { by: 'runner', text: n.text });
      }
    } catch (e) { reportMiss('host-notice', e?.message ?? String(e)); }
  }
  function broadcastBacklog() {
    noteReadyHosts();
    const ch = backlogStore.takeChanges(P.stateDir);
    const payload = `data: ${JSON.stringify({ type: 'backlog', epoch: ch.epoch, version: ch.version, prev: ch.prev, ids: ch.ids })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // Task 12b: one SSE event per launch-queue transition (pending, claimed,
  // done or failed), same framing as broadcastBacklog above - the desktop
  // shell and the dashboard both want to know the instant a launch is queued
  // or drained, not on the next poll.
  function broadcastLaunch(id, state) {
    const payload = `data: ${JSON.stringify({ type: 'launch', id, state })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // one SSE event per loop run (done, nothing-to-do or failed), same
  // framing as broadcastBacklog above.
  function broadcastLoop({ name, outcome, reason, consecutiveFailures }) {
    const payload = `data: ${JSON.stringify({ type: 'loop', name, outcome, reason, consecutiveFailures })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  function broadcastWorkspace(sessionId, workspace) {
    const payload = `data: ${JSON.stringify({ type: 'workspace', sessionId, workspace })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // Huddle payloads ride the same SSE bus; the dock reads them with its own
  // EventSource while a huddle is open (web/shared/huddle.js).
  function broadcastHuddle(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(data);
  }
  // id -> { h, pool, touched, saying }. One claude -p pool per huddle, owned by
  // its record; `saying` is the say() in flight (serialized per huddle).
  const huddles = new Map();
  // Ended huddles stay reachable for decide, kickoff and metric (the dock offers
  // them after End); the last few only, their pools are closed.
  const endedHuddles = new Map();
  const ENDED_HUDDLES_KEPT = 8;
  let huddleShuttingDown = false;
  // Howard's lookup: one per kernel, so one request at a time across every
  // huddle. Spawned in this process like the huddle's claude seats. Off with
  // cfg.huddle.researcher=false (or huddleResearcher=false in a test), and then
  // he is not on the roster at all.
  const huddleResearch = cfg.huddle.researcher === false || huddleResearcher === false ? null
    : (huddleResearcher ?? createResearcher({
      repoDir: cfg.huddle.researchRepoDir ?? REPO_ROOT, model: cfg.huddle.researchModel ?? 'sonnet',
      ...(cfg.huddle.researchStepTimeoutMs > 0 ? { timeoutMs: cfg.huddle.researchStepTimeoutMs } : {}), env,
    }));
  const huddleTheme = () => scutResolveTheme(scutGetBobMode({ file: env.SCUT_SETTINGS_FILE || path.join(P.stateDir, 'scut-settings.json') }));
  // The CLI probe runs once and is re-run only after a 503, so a CLI installed
  // after boot is picked up on the next attempt. Under a test process with no
  // probe injected claudeCliAvailable() answers false without spawning.
  let huddleCliOk = null;
  const huddleCliCheckFn = huddleCliCheck ?? (() => claudeCliAvailable({ env }));
  // The summary relay (D16). It calls scut.postToOperator DIRECTLY, not the
  // top-level postToOperator() wrapper, which resolves silently when SCUT is
  // absent: that would turn "Slack is off" into "posted". `scut` is a `let`
  // assigned later in startServer; this body only runs on a request, after boot.
  const postHuddleSummary = huddlePostSummary ?? (async (text) => {
    if (!scut?.postToOperator) throw new Error('Slack is not connected');
    await scut.postToOperator(`:speech_balloon: Huddle summary\n${text}`);
  });
  // A huddle card's own Slack thread (H3): posted in the operator's channel as
  // the Lead, then bound exactly like a Slack mention's thread, so the runner's
  // devlog, gate and park relay for that card land there.
  const cardThreads = huddleCardThreads ?? {
    available: () => Boolean(scut?.openCardThread),
    open: (text) => scut.openCardThread(text),
    bind: (room) => scut.bindCardThread(room),
  };
  // What the kickoff verb and a work command file. Returns { status, body }.
  // A Slack failure never stops the filing: the card is filed without a thread
  // and the reason rides on it.
  async function huddleKickoff(rec, { mode, state, picks: rawPicks, project: rawProject, slack = true, actor }) {
    const { h } = rec;
    const id = h.id;
    if (mode !== 'plan' && mode !== 'actions' && mode !== 'record') return { status: 400, body: { error: 'mode must be plan, actions or record' } };
    if (state !== 'queued' && state !== 'backlog') return { status: 400, body: { error: 'state must be queued or backlog' } };
    const extracted = h.snapshot().extracted;
    if (!extracted) return { status: 409, body: { error: 'decide first' } };
    const picks = Array.isArray(rawPicks) ? rawPicks.filter(Number.isInteger).sort((a, b) => a - b) : [];
    const project = typeof rawProject === 'string' && rawProject.trim() ? rawProject.trim() : undefined;
    // Pressed twice, or once per tab: the same kickoff returns the cards it filed.
    const key = `${mode}|${state}|${project ?? ''}|${mode === 'actions' ? picks.join(',') : ''}`;
    const earlier = rec.kickoffs?.get(key);
    if (earlier) return { status: 200, body: { cards: earlier, repeat: true } };
    const transcriptText = h.transcriptText();
    const hasContent = extracted.decisions.length || extracted.actions.length;
    const bodies = mode === 'plan'
      ? (hasContent ? [huddlePlanCard({ huddleId: id, extracted, transcriptText, project })] : [])
      : mode === 'record'
        ? (hasContent ? [huddleRecordCard({ record: huddleBuildRecord({ id, startedAt: h.snapshot().startedAt, extracted }), project })] : [])
        : huddleActionCards({ huddleId: id, extracted, picks, project });
    if (!bodies.length) return { status: 409, body: { error: 'nothing to file' } };
    // The queue runner only claims 'queued'; the store's parking state is 'held'.
    const storeState = state === 'queued' ? 'queued' : 'held';
    const threads = slack !== false && cardThreads.available();
    const cards = [];
    for (const b of bodies) {
      // The thread is opened before the card is filed, so a queued card the
      // runner claims at once already carries its thread as its origin.
      let thread = null;
      let slackError = slack === false ? null : threads ? null : 'Slack is not connected';
      if (threads) {
        try { thread = await cardThreads.open(`:clipboard: From huddle ${id}: ${b.title}`); }
        catch (e) { slackError = e?.message ?? String(e); }
      }
      const origin = thread ? { via: 'slack', channel: thread.channel, thread_ts: thread.thread_ts, ts: thread.thread_ts, user: null, agentId: 'riker', huddleId: id } : b.origin;
      const { item } = backlogStore.addItemTo(P.stateDir, { ...b, origin, state: storeState, actor }, { resolveProject: resolveProjectName });
      if (thread) {
        try { await cardThreads.bind({ channel: thread.channel, thread_ts: thread.thread_ts, ticketId: item.id, project: item.project }); }
        catch (e) { slackError = `the thread was opened but not bound: ${e?.message ?? e}`; }
      }
      try {
        let files = item.relevantFiles;
        if (!files.length) files = await relevantFilesFor({ repo: repoForProject(item.project), title: item.title, description: item.description });
        const refs = item.deferredRefs.length ? item.deferredRefs : deferredRefsFor(backlogStore.load(P.stateDir).items, { ...item, relevantFiles: files });
        if (files.length || refs.length) backlogStore.updateItemIn(P.stateDir, item.id, { relevantFiles: files, deferredRefs: refs });
      } catch { /* enrichment must never block filing */ }
      cards.push({ id: item.id, title: item.title, state: item.state, ...(item.quarantined ? { quarantined: true } : {}), ...(thread ? { thread: thread.thread_ts } : {}), ...(slackError ? { slackError } : {}) });
    }
    rec.kickoffs?.set(key, cards);
    h.recordKickoff({ mode, state: storeState, cards: cards.map((c) => c.id) });
    broadcastBacklog();
    return { status: 200, body: { cards, repeat: false } };
  }
  // decide() on a live huddle uses its pool; on an ended one (pool closed) it
  // gets a stream of its own for the one call.
  async function huddleDecide(id, rec) {
    const ended = !huddles.has(id);
    const own = ended ? (huddleStream ? null : createClaudeStreamPool({ env, idleKillMs: cfg.huddle.idleKillMs })) : null;
    try {
      return await rec.h.decide(ended ? { via: own ? own.streamMessage : huddleStream } : undefined);
    } finally { own?.close(); }
  }
  // End and save: decide if needed, then keep the four-part record in the state dir.
  async function huddleSaveRecordFor(id, rec) {
    const snap = rec.h.snapshot();
    const extracted = snap.extracted ?? await huddleDecide(id, rec);
    const record = huddleBuildRecord({ id, startedAt: snap.startedAt, extracted, summary: snap.summary ?? '' });
    huddleSaveRecord(P.stateDir, record);
    return record;
  }
  // A work command's turn: Decide, then a plan Kick-off into the runner, then
  // the Lead says what it filed (spoken by the dock like any line).
  async function huddleWorkTurn(rec, { project, actor }) {
    const { h } = rec;
    if (!project) { h.announce('Pick a project in the dock first, then say it again: the card runs in that project.'); return { speakers: [], via: 'work', cards: [] }; }
    let extracted;
    try { extracted = await h.decide(); } catch (e) {
      h.announce(`I could not read the decisions: ${e?.message ?? e}`);
      return { speakers: [], via: 'work', cards: [], error: 'decide failed' };
    }
    if (!extracted.decisions.length && !extracted.actions.length) {
      h.announce('Nothing has been decided yet, so there is nothing to file. Agree on something first.');
      return { speakers: [], via: 'work', cards: [] };
    }
    const out = await huddleKickoff(rec, { mode: 'plan', state: 'queued', project, actor });
    const cards = out.body.cards ?? [];
    if (out.status !== 200) h.announce(`Nothing was filed: ${out.body.error}.`);
    else {
      const ids = cards.map((c) => c.id).join(', ');
      const withThread = cards.filter((c) => c.thread).length;
      const where = withThread === cards.length ? ', each with its own Slack thread' : cards.some((c) => c.slackError) ? `, without a Slack thread (${cards.find((c) => c.slackError).slackError})` : '';
      h.announce(out.body.repeat ? `Already filed: ${ids}.` : `Queued ${ids} for the runner${where}.`);
    }
    return { speakers: [], via: 'work', cards, repeat: Boolean(out.body.repeat) };
  }
  // Every end path (POST /end, the stale prune, server close) goes through
  // here. The pool is closed only AFTER end() settles: the summary is written
  // through it. end() waits at most SEAT_END_GRACE_MS for an in-flight Gemini
  // turn, then aborts it.
  async function endHuddleRecord(id, rec) {
    try {
      return await rec.h.end();
    } finally {
      rec.pool?.close();
      if (huddles.get(id) === rec) huddles.delete(id);
      endedHuddles.set(id, rec);
      while (endedHuddles.size > ENDED_HUDDLES_KEPT) endedHuddles.delete(endedHuddles.keys().next().value);
    }
  }
  // A huddle nobody ended (a closed tab) is ended, with its summary, when the
  // next one starts; its claude processes are closed either way.
  async function pruneStaleHuddles() {
    const cutoff = Date.now() - cfg.huddle.staleMs;
    for (const [id, rec] of [...huddles]) {
      if (rec.touched > cutoff) continue;
      try { await endHuddleRecord(id, rec); } catch (e) { console.error(`[huddle] ending stale huddle ${id} failed: ${e?.message ?? e}`); }
    }
  }

  // Agent workspace (observatory): infer the observed side of a session's
  // workspace from its event feed, compare against the declared side, and
  // persist both. Pure + out-of-process - no agent cost. Fail-open: a
  // workspace glitch must never break the caller.
  //
  // glmps-98: extracted from the compute-on-read GET /api/state?session=
  // handler into a function pollCore() can call for every LIVE session on
  // every poll tick, so divergence is raised fleet-wide even with no
  // dashboard open (the headline scenario this fixes: an unattended
  // overnight queue-runner job editing a FROZEN file must still raise a
  // workspace-divergence Signal). GET /api/state?session= now just reads the
  // already-computed workspace via readWorkspace() instead of recomputing it.
  function computeWorkspaceForSession(sid, feedLog, { loop, scope } = {}) {
    let workspace = readWorkspace(P.stateDir, sid);
    let observed = null, divergence = null;
    // glmps-100: only write + broadcast when observed/divergence/seed actually
    // changed. This runs for EVERY live session EVERY tick (glmps-98), so
    // unconditional writeObserved/writeDivergence + broadcastWorkspace here are
    // per-tick disk-write + client-refresh amplification across the whole fleet
    // (cf. the lqDirty guard on the learning-loop poll block).
    let dirty = false;
    const wsEq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    try {
      const lastTs = feedLog.length ? (feedLog[feedLog.length - 1].ts ?? 0) : 0;
      // feedLog carries ISO-string ts; coerce to ms so store updatedTs and
      // divergence.ts (both Math.max over ts) stay numeric instead of NaN->null.
      const nowTs = typeof lastTs === 'string' ? (Date.parse(lastTs) || 0) : lastTs;
      observed = inferObserved(feedLog, { zone: scopeZone(scope), stage: loop?.stage ?? null, ts: nowTs });
      if (observed && !wsEq(observed, workspace?.observed)) { writeObserved(P.stateDir, sid, observed); dirty = true; }
      let declared = workspace?.declared ?? null;
      if (!declared) {
        // Declared side (spec sec 4): seed goal from the session title / first user
        // turn when nothing has declared one yet, so divergence has a left-hand
        // side at runtime for observed sessions (interactive + runner). One-time:
        // once declared is set, later meta/steer updates own it.
        const seedGoal = index.get(sid)?.title;
        if (seedGoal) {
          writeDeclared(P.stateDir, sid, { goal: seedGoal, ts: nowTs });
          declared = readWorkspace(P.stateDir, sid)?.declared ?? null;
          dirty = true;
        }
      }
      divergence = computeDivergence(declared, observed);
      if (divergence && !wsEq(divergence, workspace?.divergence)) { writeDivergence(P.stateDir, sid, divergence); dirty = true; }
      if (dirty) workspace = readWorkspace(P.stateDir, sid);
    } catch { /* fail-open: keep the pre-write workspace snapshot */ }
    if (dirty) broadcastWorkspace(sid, workspace);
    const wsSig = workspaceSignal(divergence, { sessionId: sid, seen: workspaceSignalSeen });
    if (wsSig) {
      // Record through the same sink the Signals view reads. Fail-open - 
      // a Signal is a nice-to-have, never worth sinking the poll tick.
      try { recordWorkspaceSignal(wsSig); } catch {}
      // also persist it as a durable measurable (Build A only ever
      // raised an ephemeral alert; this is the fitness-function record).
      try { upsertMeasurable(P.stateDir, measurableFromWorkspaceSignal(wsSig)); } catch {}
    }
    return workspace;
  }

  // Live-session check for the fleet-wide workspace-divergence compute
  // (glmps-98). Mirrors sessionSummaries()'s own `alive` branch (kept in sync
  // deliberately rather than shared - sessionSummaries re-stats each session's
  // file for freshness on every call, which is appropriate for an on-demand
  // HTTP read; this runs once per session per poll tick, so it reuses
  // `s.mtimeMs`, already fresh from this tick's discovery/pollDesc pass,
  // instead of a second stat call). Remote (cloud-only) sessions are never
  // live, matching sessionSummaries.
  function isWorkspaceLive(s, now) {
    if (s.format === 'remote') return false;
    if (s.tool === 'claude-code') return ccLive(s, now, s.mtimeMs);
    if (s.clientId) return (now - s.mtimeMs) <= cfg.idleThresholdMs * 10;
    if (s.tool === 'antigravity') return agAlive && (now - s.mtimeMs) <= cfg.idleThresholdMs * 5;
    const hbMs = heartbeatCache.get(s.tool);
    return hbMs !== undefined
      ? genericLive(hbMs, s.mtimeMs, now, cfg)
      : (s.live === true) || (now - s.mtimeMs) <= cfg.idleThresholdMs * 10;
  }


  const heartbeatCache = new Map(); // adapterId -> ms (refreshed each poll)
  const replayed = new Set();

  function loadHistoryEvents(antigravityDirs) {
    const bySession = new Map();
    for (const root of antigravityDirs) {
      const historyFile = path.join(root, 'history.jsonl');
      try {
        if (!fs.existsSync(historyFile)) continue;
        const lines = fs.readFileSync(historyFile, 'utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.conversationId && obj.display) {
              const sid = obj.conversationId;
              const list = bySession.get(sid) ?? [];
              list.push({
                kind: 'tool',
                lane: 'feed',
                tool: obj.type === 'shell' ? 'command' : 'user',
                path: null,
                ts: obj.timestamp,
                sessionId: sid,
                label: (obj.type === 'shell' ? 'Shell: ' : 'User: ') + obj.display.slice(0, 120),
              });
              bySession.set(sid, list);
            }
          } catch {}
        }
      } catch {}
    }
    return bySession;
  }

  function loadAgMessageEvents(brainSessionDir, sessionId) {
    const events = [];
    const msgDir = path.join(brainSessionDir, '.system_generated', 'messages');
    let files = [];
    try { files = fs.readdirSync(msgDir); } catch { return events; }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'cursor.json' || f === 'read.json') continue;
      try {
        const filepath = path.join(msgDir, f);
        const msg = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        const ts = msg.timestamp ? Date.parse(msg.timestamp) : null;
        if (msg.renderDetails && msg.renderDetails.messageTitle) {
          let kind = 'tool';
          let lane = 'feed';
          let tool = 'task';
          let label = msg.renderDetails.messageTitle;
          let p = null;
          const toolCall = msg.sourceMetadata?.tool?.toolCall;
          if (toolCall) {
            tool = toolCall.name;
            let args = {};
            try { args = JSON.parse(toolCall.argumentsJson ?? '{}'); } catch {}
            p = args.AbsolutePath ?? args.TargetFile ?? '';
            if (typeof p === 'string' && p.startsWith('"')) {
              try { p = JSON.parse(p); } catch {}
            }
            if (toolCall.name === 'run_command') {
              kind = 'command';
              label = args.toolSummary ?? args.CommandLine ?? 'command';
            } else if (/^(write_to_file|replace_file_content|multi_replace_file_content)$/.test(toolCall.name)) {
              kind = 'file-edit';
              label = p || toolCall.name;
            } else if (toolCall.name === 'view_file') {
              const isSkill = args.IsSkillFile === 'true' || args.IsSkillFile === true;
              if (isSkill) {
                kind = 'skill';
                lane = 'context';
                label = p;
              } else if (p && /(CLAUDE|AGENTS|GEMINI)\.md$/i.test(p)) {
                kind = 'context-file';
                lane = 'context';
                label = p;
              }
            }
          }
          events.push({ kind, lane, tool, path: p || null, ts, sessionId, label });
        }
      } catch {}
    }
    return events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  }

  // Per-source failure isolation (glmps-47): a locked file / throwing read on
  // one source must never stop extraction of the others. Failures back off and
  // warn (debounced) instead of crashing the poll tick.
  const srcGuard = createSourceGuard();

  // Extract one line, skipping (with a debounced warning) records that make an
  // extractor throw - a malformed record must not kill the tail of its source.
  function safeExtract(extractor, line, sessionId, warnKey) {
    try { return extractor(line, sessionId); }
    catch (e) { srcGuard.warn(warnKey, `skipped an unparseable record: ${e?.message ?? e}`); return []; }
  }

  function replayIfEmpty(sessionId, file, extractor) {
    if (replayed.has(sessionId) || (eventLog.get(sessionId) ?? []).length > 0) return;
    replayed.add(sessionId);
    let events = [];
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > 0) {
      const start = Math.max(0, size - cfg.backfillBytes);
      const r = readNewLines(file, start, '', { discardFirstPartial: start > 0 });
      events = r.lines.flatMap(l => safeExtract(extractor, l, sessionId, `extract:replay:${sessionId}`));
      // Meta events carry session facts (cwd/model), not feed entries: upsert + strip.
      applyMetaEvents(sessionId, events.filter(e => e.kind === 'meta'));
      events = events.filter(e => e.kind !== 'meta');
      trackTokens(sessionId, events);
    }

    // Fallback for empty/missing log files: load from history.jsonl and messages folder
    if (events.length === 0 && extractor === extractAgEvents) {
      const s = sessions.find(x => x.id === sessionId);
      if (s) {
        const historyMap = loadHistoryEvents(P.antigravityDirs);
        const hEvents = historyMap.get(sessionId) ?? [];
        const mEvents = loadAgMessageEvents(s.dir, sessionId);
        events = [...hEvents, ...mEvents].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      }
    }

    if (events.length) eventLog.set(sessionId, events.slice(-2000));
    // NOTE: deliberately does not touch offsets, index, or SSE - pure in-memory rehydration
  }

  function tailOne(key, file, extractor, sessionId) {
    const st = offsets[key] ?? { offset: 0, carry: '' };
    const first = !(key in offsets);
    let start = st.offset;
    let discard = false;
    if (first) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch {}
      if (size > cfg.backfillBytes) { start = size - cfg.backfillBytes; discard = true; }
    }
    const r = readNewLines(file, start, st.carry, { discardFirstPartial: discard });
    offsets[key] = { offset: r.offset, carry: r.carry };
    const events = r.lines.flatMap(l => safeExtract(extractor, l, sessionId, `extract:${key}`));
    // first user line of a Claude transcript becomes the session title
    if (extractor === extractClaudeEvents && !index.get(sessionId)?.title) {
      for (const l of r.lines) {
        try {
          const o = JSON.parse(l);
          const c = o?.type === 'user' ? o.message?.content : null;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.find(x => x.type === 'text')?.text : null;
          if (text) { const t = cleanFirstPrompt(text, 120) ?? text.slice(0, 120); index.upsert(sessionId, { title: t }); break; }
        } catch {}
      }
    }
    pushEvents(sessionId, events);
  }

  function findSubagentFiles(transcriptPath) {
    const dir = transcriptPath.replace(/\.jsonl$/, '');
    const out = [];
    const stack = [path.join(dir, 'subagents')];
    while (stack.length) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/^agent-.*\.jsonl$/.test(e.name)) out.push(full);
      }
    }
    return out;
  }

  const ACTIVE_WINDOW = cfg.idleThresholdMs * 10; // treat as live if any signal within this window
  const readStatus = createStatusReader(P.statusDir);
  // knownMtimeMs: the transcript mtime a caller already stat'd this tick, so the
  // per-tick liveness pass over every session does not stat each file twice.
  function ccLive(s, now, knownMtimeMs = 0) {
    if (s.live) return true; // registry ppid alive
    let m = knownMtimeMs > 0 ? knownMtimeMs : 0;
    if (!m) { try { m = fs.statSync(s.transcriptPath).mtimeMs; } catch {} }
    if (now - m <= ACTIVE_WINDOW) return true;
    const cap = readStatus(s.id)?.capturedAt ?? 0;
    return now - cap <= ACTIVE_WINDOW;
  }

  function refreshAgLabelsIfNeeded() {
    // Check mtime of each root's summaries pb; reload if any changed
    let changed = false;
    for (const dir of P.antigravityDirs) {
      const pbPath = path.join(dir, 'agyhub_summaries_proto.pb');
      let mtime = 0;
      try { mtime = fs.statSync(pbPath).mtimeMs; } catch {}
      if (mtime !== (agLabelsMtimes.get(pbPath) ?? -1)) {
        agLabelsMtimes.set(pbPath, mtime);
        changed = true;
      }
    }
    if (changed) agLabels = loadAgLabels(P.antigravityDirs);
  }

  function pollSnapshot(desc, adapter) {
    // json-snapshot: on mtime change, reload entire file and replace event log
    const snapKey = `snap:${desc.id}`;
    const prev = offsets[snapKey];
    if (prev?.snapMtime === desc.mtimeMs) return; // unchanged

    let text;
    try {
      const stat = fs.statSync(desc.file);
      if (stat.size > 5 * 1024 * 1024) return; // cap 5MB
      text = fs.readFileSync(desc.file, 'utf-8');
    } catch { return; }

    let result;
    try { result = adapter.extractSnapshot(text, desc.id, desc); } catch { return; }

    const { events = [], title, cwd } = result;
    // Apply meta events (cwd, model, etc.) so they land on the index record.
    applyMetaEvents(desc.id, events.filter(e => e.kind === 'meta'));
    // Cumulative token parity (glmps-51): snapshot adapters replace the log
    // instead of pushing, so feed status synthesis + the usage bridge here.
    // Watermark = totals already absorbed, so re-parses don't re-append.
    const prevTk = tokenStats.get(desc.id);
    const watermark = prevTk ? prevTk.totalInput + (prevTk.totalOutput ?? 0) : -Infinity;
    const nonMeta = events.filter(e => e.kind !== 'meta');
    trackTokens(desc.id, nonMeta);
    bridgeTokenEvents(desc.id, nonMeta, { afterTotal: watermark });
    // Replace event log entirely (even when empty, to clear stale events from a previous parse)
    if (eventLog.has(desc.id) || events.length > 0) {
      eventLog.set(desc.id, events.slice(-2000));
    }
    index.upsert(desc.id, {
      tool: adapter.id,
      cwd: desc.cwd ?? cwd ?? index.get(desc.id)?.cwd ?? null,
      lastTs: desc.mtimeMs,
      ...(title ? { title } : {}),
    });
    offsets[snapKey] = { snapMtime: desc.mtimeMs };

    // Emit SSE refresh so the UI coalesced-refresh picks it up
    const payload = `data: ${JSON.stringify({ type: 'refresh', sessionId: desc.id })}\n\n`;
    for (const res of clients) res.write(payload);
  }

  // Helper: collect all candidate repo roots from settings additionalDirectories
  // + known session CWDs + this server's own repo root. Used by the request
  // handler (graph status/rebuild, wiki-ext) AND the background worktree-sweep
  // timer below, so it lives at this outer scope rather than nested in the
  // HTTP handler closure.
  function isGraphRootCandidate(p, privateDirs = loadPrivateDirs({ env })) {
    if (!p) return false;
    // Drop agent-internal scratch cwds (Antigravity brain/<uuid>, bare
    // UUID basenames) before they ever become a candidate -- see
    // lib/project-roots.js for why the downstream .git-existence check
    // alone isn't enough (agy-cli auto-git-inits its scratch dirs). This
    // filter is the difference between a real repo count (~20s) and a
    // scratch-dir-inflated one (100+) - the latter used to turn the
    // worktree sweep into a many-second git-cherry storm on every tick.
    if (!isProjectRootCandidate(p, { antigravityDirs: P.antigravityDirs, claudeDir: P.claudeDir })) return false;
    // Private dirs (server/lib/private-dirs.js): usable as a job cwd via
    // repoForProject(), but never listed and never indexable. This function is
    // the single source for /api/projects AND for the graph/wiki rebuild
    // allowlist, so one exclusion here closes both. repoForProject() builds
    // its own root list and deliberately does NOT apply this filter - that
    // asymmetry IS the "targeted-only" design.
    return !isPrivateDir(p, privateDirs);
  }
  // The two discovery sources apart, so the graph scope classifier can name
  // which one a root came from.
  function graphRootSources() {
    // A client session's cwd is a path on the client, never a repo root on this disk.
    // Deduped before filtering and the private-dir list read once: ~2,200
    // sessions share a few dozen cwds, and a file read per session was a
    // 330-450 ms stall on every worktree sweep (glmps-2-0-runtime-68 AC-4).
    const privateDirs = loadPrivateDirs({ env });
    const candidate = (p) => isGraphRootCandidate(p, privateDirs);
    const sessionCwds = [...new Set(index.list({}).filter(r => !r.clientId).map(r => r.cwd))].filter(candidate);
    let additionalDirectories = [];
    try {
      const settings = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'));
      const dirs = settings?.permissions?.additionalDirectories;
      if (Array.isArray(dirs)) additionalDirectories = dirs.filter(candidate);
    } catch {}
    return { sessionCwds, additionalDirectories };
  }
  function collectGraphRoots() {
    // Dedup by a normalized key (forward slashes, no trailing slash,
    // lowercased for case-insensitive Windows paths) but keep the first
    // original spelling. Otherwise D:/x, d:/x and D:/x/ list the same repo 3x.
    const seen = new Map();
    const add = (p) => {
      const root = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
      const key = root.toLowerCase();
      if (!seen.has(key)) seen.set(key, root);
    };
    if (isGraphRootCandidate(REPO_ROOT)) add(REPO_ROOT);
    const { sessionCwds, additionalDirectories } = graphRootSources();
    sessionCwds.forEach(add);
    additionalDirectories.forEach(add);
    return [...seen.values()];
  }

  // F7/F9/F12/F13: the ONE way a request-supplied project path reaches a
  // file read, graphPathFor or git's cwd. UNC/device/relative/metacharacter
  // values are refused by shellSafePathSyntax with no filesystem access at
  // all (no outbound SMB); everything else must be one of collectGraphRoots(),
  // the same allowlist /api/graph/rebuild, /api/wiki/rebuild and /wiki-ext use.
  const normProjectKey = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  function resolveProjectParam(raw) {
    if (raw == null || raw === '') return { ok: true, root: null };
    const syn = shellSafePathSyntax(String(raw));
    if (!syn.ok) return { ok: false, status: 400, error: `project refused: ${syn.reason}` };
    const key = normProjectKey(syn.path);
    if (!collectGraphRoots().some((r) => normProjectKey(r) === key)) return { ok: false, status: 403, error: 'project refused: not a known project root' };
    return { ok: true, root: syn.path };
  }

  // The graph roots that are real git repos, as { project, path } pairs - 
  // the scan set for the unmerged-branch guard and the worktree sweeper (same
  // filter as /api/projects). Worktree dirs ARE git dirs (a .git file), so
  // exclude them explicitly or every isolated session becomes its own bogus
  // project/scan root.
  function gitRepoRoots() {
    return collectGraphRoots().filter((root) => {
      if (normRoot(root) === normRoot(REPO_ROOT)) return true;
      if (worktreeParent(root, { worktreesDir: P.worktreesDir })) return false;
      try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
    }).map((root) => ({ project: path.basename(root), path: root }));
  }
  // The unmerged-branch scan reads one checkout per repository (glmps-192):
  // every other linked worktree (.claude/worktrees/*, <repo>-wt-*, this
  // deployed checkout) repeats the same branch list on the shared 3-slot
  // gitLimiter. gitRepoRoots() itself stays per checkout, because distinct
  // board projects (glmps, glmps-2.0-runtime) can be worktrees of
  // one repository; the residency feed shares its repo-wide reads per common
  // dir instead (collectResidency).
  function gitScanRoots() {
    const roots = gitRepoRoots();
    const kept = new Set(dedupeByCommonDir(roots.map((r) => r.path)));
    return roots.filter((r) => kept.has(r.path));
  }

  function poll() {
    // Last-resort guard: a poll tick must never throw into setInterval (that
    // would kill the entire capture process). Per-source guards below keep one
    // bad source from stopping the others; this catches anything they miss.
    const __PERF = !!env.GLMPS_PERF_TRACE;
    const __t0 = __PERF ? Date.now() : 0;
    readStatus.indexDir();
    try { pollCore(); }
    catch (e) { srcGuard.warn('poll:tick', `poll tick failed: ${e?.message ?? e}`); }
    summariesTick++;
    if (__PERF) {
      const dt = Date.now() - __t0;
      if (dt > 20) console.log(`[perf] poll() tick took ${dt}ms (sessions=${sessions.length})`);
    }
  }

  // Copilot CLI has no on-disk token accounting; its OTel file exporter does.
  // Tail every *.jsonl the exporter writes under P.copilotOtelDir, fold the
  // `chat` spans into cumulative per-session usage, and bridge that into the
  // usage store (Analytics) + the live feed. Keyed by copilot-cli:<conversationId>
  // so it joins the copilot-cli capture-adapter session. mtime-gated; a
  // high-water mark per sid stops re-appending an unchanged cumulative row.
  const copilotOtelMark = new Map(); // sid -> last cumulative (input+output) appended
  function pollCopilotOtel() {
    const dir = P.copilotOtelDir;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } // dir absent = OTel not enabled
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      let st; try { st = fs.statSync(file); } catch { continue; }
      const key = `copilot-otel:${file}`;
      const prev = offsets[key] ?? { mtime: 0 };
      if (prev.mtime === st.mtimeMs) continue; // unchanged since last poll
      let text; try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const usage = extractCopilotOtelUsage(text);
      const now = Date.now();
      const feedBySid = new Map(copilotOtelFeed(usage).map(ev => [ev.sessionId, ev]));
      for (const snap of copilotOtelSnapshots(usage, { capturedAt: now })) {
        const total = (snap.input ?? 0) + (snap.output ?? 0);
        if (total <= (copilotOtelMark.get(snap.sid) ?? -Infinity)) continue; // no advance
        copilotOtelMark.set(snap.sid, total);
        try { appendSnapshot(P.stateDir, { ...snap, ts: now }); } catch {}
        const ev = feedBySid.get(snap.sid);
        if (ev) pushEvents(snap.sid, [ev]);
      }
      offsets[key] = { mtime: st.mtimeMs };
    }
  }

  const GENERIC_TOOL_IDS = new Set(['gemini-cli', 'copilot-chat', 'copilot-cli', 'codex-cli', 'openclaw', 'hermes', 'agy-cli', 'opencode', 'cline', 'cursor-cli', 'grok', 'pi', 'droid']);
  function pollCore() {
    srcGuard.run('ag:labels', () => refreshAgLabelsIfNeeded());
    sessions = [
      ...(srcGuard.run('discover:claude', () => discoverClaudeForPoll(procStarts ? { ...P, procStarts } : P)).value ?? []),
      ...(srcGuard.run('discover:antigravity', () => discoverAgSessions({ antigravityDirs: P.antigravityDirs })).value ?? []),
    ];
    for (const s of sessions) {
      if (s.tool === 'claude-code') {
        index.upsert(s.id, { tool: s.tool, cwd: s.cwd ?? index.get(s.id)?.cwd ?? null,
          lastTs: s.mtimeMs, transcriptPath: s.transcriptPath });
        if (ccLive(s, Date.now(), s.mtimeMs) || eventLog.has(s.id)) {
          srcGuard.run(`source:cc:${s.id}`, () => {
            replayIfEmpty(s.id, s.transcriptPath, extractClaudeEvents);
            tailOne(`cc:${s.id}`, s.transcriptPath, extractClaudeEvents, s.id);
            for (const f of findSubagentFiles(s.transcriptPath))
              tailOne(`sub:${f}`, f, extractClaudeEvents, s.id);
          });
        }
      } else {
        // pb-only sessions: store workspace from labels if available; no tailing
        const labelCwd = agLabels.get(s.id)?.workspace ?? null;
        const labelTitle = agLabels.get(s.id)?.title ?? null;
        index.upsert(s.id, {
          tool: s.tool,
          cwd: s.format === 'log' ? s.dir : (labelCwd ?? s.dir),
          lastTs: s.mtimeMs,
          logPath: s.logPath ?? null,
          ...(labelTitle ? { title: labelTitle } : {}),
        });
        if (s.format === 'log') {
          const agKey = `ag:${s.id}`;
          if (agKey in offsets || (Date.now() - s.mtimeMs) <= cfg.idleThresholdMs * 50) {
            srcGuard.run(`source:${agKey}`, () => {
              replayIfEmpty(s.id, s.logPath, extractAgEvents);
              tailOne(agKey, s.logPath, extractAgEvents, s.id);
            });
          }
        }
        // pb-only: no tailing - mtime is the only signal
      }
    }
    // Append label-only (cloud/remote) AG sessions - ids in agLabels not already in sessions
    const sessionIds = new Set(sessions.map(s => s.id));
    for (const [id, { title, workspace }] of agLabels) {
      if (sessionIds.has(id)) continue;
      // Push a remote-only sentinel entry into sessions
      sessions.push({ id, tool: 'antigravity', dir: workspace ?? null,
        logPath: null, pbPath: null, mtimeMs: 0, format: 'remote' });
      // Upsert into index - only set lastTs if not already present (use 0 so they sort last)
      const existing = index.get(id);
      index.upsert(id, {
        tool: 'antigravity',
        cwd: workspace ?? null,
        title: title ?? null,
        ...(existing?.lastTs ? {} : { lastTs: 0 }),
      });
    }

    // Generic adapters (gemini-cli, copilot-chat, future tools)
    // claude-code and antigravity have bespoke handling above; skip them here.
    // Refresh heartbeat cache for adapters that export processAliveMs
    for (const adapter of adapters) {
      if (!GENERIC_TOOL_IDS.has(adapter.id)) continue;
      // Refresh heartbeat once per poll per adapter
      if (typeof adapter.processAliveMs === 'function') {
        try { heartbeatCache.set(adapter.id, adapter.processAliveMs(P)); } catch { heartbeatCache.set(adapter.id, 0); }
      }
      if (typeof adapter.discover !== 'function') continue;
      let descs;
      try { descs = adapter.discover(P); } catch { continue; }
      for (const desc of descs) {
        srcGuard.run(`source:${desc.tool}:${desc.id}`, () => pollDesc(desc, adapter, sessionIds));
      }
    }

    srcGuard.run('source:tap-mirror', () => pollClientMirrors(sessionIds));

    srcGuard.run('source:copilot-otel', () => pollCopilotOtel());

    // Agent workspace (observatory), glmps-98: compute observe+divergence for
    // every LIVE session, every tick - see computeWorkspaceForSession's
    // docstring for why this moved out of the compute-on-read /api/state?session=
    // handler. O(events-in-ring) per live session; negligible next to the
    // discovery/tailing work already done above in this same tick.
    //
    // glmps-100 item 2: the __PERF trace that used to cover this compute lived
    // in the /api/state?session= handler (a per-request timer); glmps-98 moved
    // the actual fs I/O (writeObserved/writeDivergence, now dirty-checked) out
    // of that request path into this poll tick, which had no timing
    // instrumentation of its own. Add one here, gated the same way
    // (GLMPS_PERF_TRACE), so the new I/O is still visible in the perf trace
    // instead of silently disappearing from it.
    const __WS_PERF = !!env.GLMPS_PERF_TRACE;
    const __wsT = {}; const __wsMark = (k) => { if (__WS_PERF) __wsT[k] = Date.now(); };
    __wsMark('start');
    const __wsNow = Date.now();
    let __wsLiveCount = 0;
    for (const s of sessions) {
      if (!isWorkspaceLive(s, __wsNow)) continue;
      __wsLiveCount++;
      const sid = s.id;
      const log = eventLog.get(sid) ?? [];
      let dgEvents = [];
      try { dgEvents = doneGateEvents(fs.readFileSync(path.join(P.doneGateDir, `${sid}.jsonl`), 'utf8'), sid); } catch {}
      // Claude events carry ISO-string ts and done-gate rows epoch ms; subtracting
      // the raw values is NaN and left a mixed feed unsorted.
      const feedLog = dgEvents.length ? [...log, ...dgEvents].sort((a, b) => tsMs(a.ts) - tsMs(b.ts)) : log;
      const sessionCwd = s.cwd ?? index.get(sid)?.cwd ?? null;
      const scope = sessionScope(
        feedLog.filter(e => e.kind === 'file-edit').map(e => e.path),
        { projectRoot: sessionCwd, config: P.zoneConfig });
      // loopStage()'s numeric .stage never depends on its guiding/gaps args - 
      // only .detail text does (see loop-stage.js's rule table) - so calling
      // it with just feedLog still yields the identical .stage
      // computeWorkspaceForSession needs, without recomputing the
      // capability-guidance/learning-loop machinery that's otherwise only
      // meaningful for a single per-request /api/state?session= response.
      const loop = loopStage(feedLog);
      computeWorkspaceForSession(sid, feedLog, { loop, scope });
    }
    __wsMark('afterWorkspace');
    if (__WS_PERF) {
      console.log(`[perf] pollCore workspace liveSessions=${__wsLiveCount} afterWorkspace=${__wsT.afterWorkspace - __wsT.start}ms`);
    }


    writeJsonSafe(P.offsetsFile, offsets);
    index.flush();
  }

  // File mirror (task 10): the same discovery and tailing the local machine gets,
  // run over each client's mirror dir. Every session id is namespaced
  // <clientId>:<sessionId> before it reaches the index, offsets, event log or SSE.
  // Mirrored sessions never use a process probe (it would look at the server's own
  // processes), so liveness is the mtime rule.
  function pollClientMirrors(sessionIds) {
    if (!clientStore) return;
    let list;
    try { list = clientStore.list(); } catch { return; }
    for (const c of list) {
      if (!validClientId(c.id)) continue;
      const mirrorDir = clientMirrorDir(P.stateDir, c.id);
      if (!fs.existsSync(mirrorDir)) continue;
      srcGuard.run(`source:mirror:${c.id}`, () => pollClientMirror(c.id, mirrorDir, sessionIds));
    }
  }
  const insideDir = (dir, file) => {
    const rel = path.relative(path.resolve(dir), path.resolve(String(file ?? '')));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  function pollClientMirror(clientId, mirrorDir, sessionIds) {
    const PC = serverPathsFor(P, mirrorDir);
    const ns = (id) => namespaceSessionId(clientId, id);
    const first = sessions.length;
    for (const s0 of discoverClaudeSessions(PC)) {
      // The registry file is client-supplied, so its transcript path is too.
      if (!insideDir(PC.claudeDir, s0.transcriptPath)) continue;
      const s = { ...s0, id: ns(s0.id), live: false };
      sessions.push(s);
      sessionIds.add(s.id);
      index.upsert(s.id, { tool: s.tool, cwd: s.cwd ?? index.get(s.id)?.cwd ?? null, lastTs: s.mtimeMs, transcriptPath: s.transcriptPath });
      if (ccLive(s, Date.now()) || eventLog.has(s.id)) {
        srcGuard.run(`source:cc:${s.id}`, () => {
          replayIfEmpty(s.id, s.transcriptPath, extractClaudeEvents);
          tailOne(`cc:${s.id}`, s.transcriptPath, extractClaudeEvents, s.id);
          for (const f of findSubagentFiles(s.transcriptPath)) tailOne(`sub:${f}`, f, extractClaudeEvents, s.id);
        });
      }
    }
    for (const a of discoverAgSessions({ antigravityDirs: PC.antigravityDirs })) {
      if (a.format !== 'log' || !insideDir(mirrorDir, a.logPath)) continue;
      const s = { ...a, id: ns(a.id), tool: 'antigravity' };
      sessions.push(s);
      sessionIds.add(s.id);
      index.upsert(s.id, { tool: s.tool, cwd: s.dir, lastTs: s.mtimeMs, logPath: s.logPath });
      srcGuard.run(`source:ag:${s.id}`, () => {
        replayIfEmpty(s.id, s.logPath, extractAgEvents);
        tailOne(`ag:${s.id}`, s.logPath, extractAgEvents, s.id);
      });
    }
    for (const adapter of adapters) {
      if (adapter.id === 'claude-code' || adapter.id === 'antigravity' || !GENERIC_TOOL_IDS.has(adapter.id) || typeof adapter.discover !== 'function') continue;
      let descs;
      try { descs = adapter.discover(PC); } catch { continue; }
      for (const desc of descs) {
        if (desc.file && !insideDir(mirrorDir, desc.file)) continue;
        const d = { ...desc, id: ns(desc.id) };
        srcGuard.run(`source:${d.tool}:${d.id}`, () => pollDesc(d, adapter, sessionIds));
      }
    }
    for (const s of sessions.slice(first)) {
      s.clientId = clientId;
      index.upsert(s.id, { clientId });
    }
  }

  // One generic-adapter source's unit of work (isolated per desc by srcGuard).
  function pollDesc(desc, adapter, sessionIds) {
        if (desc.kind === 'json-snapshot' && typeof adapter.extractSnapshot === 'function') {
          pollSnapshot(desc, adapter);
          // Register in sessions list for /api/state coverage
          if (!sessionIds.has(desc.id)) {
            sessionIds.add(desc.id);
            const now = Date.now();
            const fakeLive = (now - desc.mtimeMs) <= cfg.idleThresholdMs * 10;
            sessions.push({
              id: desc.id, tool: desc.tool, format: 'snapshot',
              cwd: desc.cwd ?? null, mtimeMs: desc.mtimeMs, live: fakeLive,
            });
          }
        } else if (desc.kind === 'jsonl-tail' && typeof adapter.extractLine === 'function') {
          const tailKey = `${desc.tool}:${desc.id}`;
          index.upsert(desc.id, { tool: desc.tool, cwd: desc.cwd ?? index.get(desc.id)?.cwd ?? null, lastTs: desc.mtimeMs });
          replayIfEmpty(desc.id, desc.file, adapter.extractLine);
          tailOne(tailKey, desc.file, adapter.extractLine, desc.id);
          if (!sessionIds.has(desc.id)) {
            sessionIds.add(desc.id);
            sessions.push({ id: desc.id, tool: desc.tool, format: 'jsonl',
              cwd: desc.cwd ?? null, mtimeMs: desc.mtimeMs, live: false });
          }
        } else if (desc.kind === 'sqlite-steps' && typeof adapter.extractSteps === 'function') {
          const sqlKey = `sql:${desc.id}`;
          const prev = offsets[sqlKey] ?? { lastIdx: -1, mtime: 0 };

          // extractSteps is capped per call (LIMIT 500); loop to drain all steps after `from`.
          const drain = (from, sink) => {
            let cursor = from, title = null, guard = 0;
            for (;;) {
              const ex = adapter.extractSteps(desc.file, cursor, desc);
              if (ex.title && !title) title = ex.title;
              if (ex.events.length) sink(ex.events);
              if (ex.lastIdx <= cursor || ++guard > 100) break; // no progress / safety cap (~50k steps)
              cursor = ex.lastIdx;
            }
            return { lastIdx: cursor, title };
          };

          // Rehydrate in-memory log after a restart (offsets exist, log empty): re-read all, replace.
          // Once per process per id: see sqlRehydrated above (glmps-71).
          if (!eventLog.has(desc.id) && prev.lastIdx > -1 && !sqlRehydrated.has(desc.id)) {
            sqlRehydrated.add(desc.id);
            const buf = [];
            const r = drain(-1, evs => buf.push(...evs));
            if (buf.length) eventLog.set(desc.id, buf.slice(-2000));
            if (r.title && !index.get(desc.id)?.title) index.upsert(desc.id, { title: r.title });
          }

          // Incremental (or first-ever) read on mtime change, draining past the per-call LIMIT.
          if (prev.mtime !== desc.mtimeMs) {
            const r = drain(prev.lastIdx, evs => pushEvents(desc.id, evs));
            if (r.title && !index.get(desc.id)?.title) index.upsert(desc.id, { title: r.title });
            offsets[sqlKey] = { lastIdx: r.lastIdx, mtime: desc.mtimeMs };
            index.upsert(desc.id, { tool: desc.tool, cwd: desc.cwd ?? index.get(desc.id)?.cwd ?? null, lastTs: desc.mtimeMs });
          }

          if (!sessionIds.has(desc.id)) {
            sessionIds.add(desc.id);
            const now = Date.now();
            const hbMs = heartbeatCache.get(adapter.id);
            const isLive = hbMs !== undefined
              ? genericLive(hbMs, desc.mtimeMs, now, cfg)
              : (now - desc.mtimeMs) <= cfg.idleThresholdMs * 10;
            sessions.push({
              id: desc.id, tool: desc.tool, format: 'sqlite',
              cwd: desc.cwd ?? null, mtimeMs: desc.mtimeMs, live: isLive,
            });
          }
        }
  }

  function checkAgAlive() {
    if (agAliveProbe || liveIdesProbe) {
      liveIdes = liveIdesProbe ? [...liveIdesProbe()] : (agAliveProbe() ? ['antigravity'] : []);
      agAlive = liveIdes.includes('antigravity');
      return;
    }
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      liveIdes = err ? [] : liveIdeTargets(stdout);
      agAlive = liveIdes.includes('antigravity');
    });
  }

  // Last write per Claude session, counting its helper (subagent) transcripts:
  // a session waiting on background helpers is busy though its own transcript
  // is quiet (card glmps-2-0-runtime-89). A session with no readable
  // transcript is left out, which both callers treat as not idle.
  function claudeActivity() {
    const out = new Map();
    for (const s of sessions) {
      if (s.tool !== 'claude-code') continue;
      const t = lastWriteWithHelpers(s.transcriptPath);
      if (t !== null) out.set(String(s.id).toLowerCase(), t);
    }
    return out;
  }

  // glmps-2-0-runtime-86 AC-2: a computation stats every transcript (~2,200 on
  // the live box, ~430 ms) and about twenty callers ask for it (the board, the
  // runner tick, the worktree sweep, liveness checks, GET handlers). It is
  // computed once per poll tick and shared; poll() drops it, so a caller sees
  // data at most one poll old. Callers get their own copy of the array.
  let summariesTick = 0;
  let summariesMemo = null;
  function sessionSummaries() {
    if (summariesMemo?.tick !== summariesTick) summariesMemo = { tick: summariesTick, rows: computeSessionSummaries() };
    return summariesMemo.rows.slice();
  }

  function computeSessionSummaries() {
    const now = Date.now();
    // glmps-8b: loaded fresh per call (compute-on-read, same
    // convention as loadAlertSeen elsewhere in this file); a small sorted-id
    // JSON file, cheap to re-read. `internal` is stamped on every row (tag,
    // don't hide: internal sessions still appear in the list, only the live
    // COUNT excludes them, at composeBoard below).
    const internalIds = loadInternal(P.internalSessionsFile);
    return sessions.map(s => {
      const rec = index.get(s.id) ?? {};
      const internal = isInternalSession(s, internalIds);

      // Remote (cloud-only) sessions: no local files, never live, sorted last
      if (s.format === 'remote') {
        const label = agLabels.get(s.id);
        const cwd = label?.workspace ?? null;
        const title = label?.title ?? pickTitle(rec, [], { worktreesDir: P.worktreesDir });
        return {
          id: s.id, tool: s.tool, format: 'remote', cwd, title, live: false,
          state: 'ended', lastTs: 0,
          skillsUsed: rec.skillsUsed ?? [], status: null,
          recentContext: [],
          counts: { skills: 0, memory: 0, agents: 0, contextFiles: 0, mcp: 0, git: 0 },
          loop: null,
          worktree: worktreeInfo(cwd, { worktreesDir: P.worktreesDir }),
          internal,
        };
      }

      let mtimeMs = s.mtimeMs;
      if (s.tool === 'claude-code') {
        try { mtimeMs = fs.statSync(s.transcriptPath).mtimeMs; } catch {}
      } else if (s.format === 'log' && s.logPath) {
        try { mtimeMs = fs.statSync(s.logPath).mtimeMs; } catch {}
      } else if (s.format === 'pb' && s.pbPath) {
        try { mtimeMs = fs.statSync(s.pbPath).mtimeMs; } catch {}
      }
      const hbMs = heartbeatCache.get(s.tool);
      const alive = s.tool === 'claude-code'
        ? ccLive(s, now, mtimeMs)
        : s.clientId
          ? (now - mtimeMs) <= cfg.idleThresholdMs * 10
        : s.tool === 'antigravity'
          ? agAlive && (now - mtimeMs) <= cfg.idleThresholdMs * 5
          : hbMs !== undefined
            ? genericLive(hbMs, mtimeMs, now, cfg)
            : (s.live === true) || (now - mtimeMs) <= cfg.idleThresholdMs * 10;
      let status = normalizeStatus(readStatus(s.id));
      if (!status && s.tool === 'antigravity') {
        let modelName = newestGeminiModel(AGY_MODELS, 'Medium');
        try {
          const settings = JSON.parse(fs.readFileSync(path.join(P.agyCliDir, 'settings.json'), 'utf-8'));
          if (settings.model) modelName = settings.model;
        } catch {}

        const events = eventLog.get(s.id) ?? [];
        const eventCount = events.length;
        const usedPercent = Math.min(100, Math.max(1, Math.round(1 + eventCount * 0.15)));
        const totalUsd = Number((0.002 + eventCount * 0.0003).toFixed(4));

        status = {
          model: {
            id: modelName.toLowerCase().replace(/ /g, '-'),
            displayName: modelName,
          },
          context: {
            usedPercent: usedPercent,
          },
          cost: {
            totalUsd: totalUsd,
          },
          rateLimits: null,
          sessionName: null,
          capturedAt: now,
        };
      }
      // Generic synthesis for tapless tools (codex-cli, future gemini-cli):
      // model captured via meta events, context % from cumulative token events.
      if (!status) {
        const tk = tokenStats.get(s.id);
        if (rec.model || tk) {
          status = {
            model: { id: rec.model ?? null, displayName: rec.model ? rec.model.replace(/^gpt-/, 'GPT-') : null },
            context: { usedPercent: ctxPctOf(tk) },
            cost: { totalUsd: null },
            rateLimits: null, sessionName: null, capturedAt: tk?.ts ?? null,
          };
        }
      }
      const events = eventLog.get(s.id) ?? [];
      const ctxNow = contextNow(events);
      const counts = { skills: 0, memory: 0, agents: 0, contextFiles: 0, mcp: 0, git: 0 };
      for (const e of ctxNow) {
        if (e.kind === 'skill') counts.skills++;
        else if (e.kind === 'memory') counts.memory++;
        else if (e.kind === 'agent') counts.agents++;
        else if (e.kind === 'context-file') counts.contextFiles++;
        else if (e.kind === 'mcp') counts.mcp++;
        else if (e.kind === 'git') counts.git++;
      }
      const label = agLabels.get(s.id);
      // For pb sessions: prefer workspace label over the conversations dir
      const cwd = rec.cwd ?? (s.tool === 'antigravity' ? (label?.workspace ?? null) : null);
      const title = status?.sessionName ?? label?.title ?? pickTitle(rec, events, { worktreesDir: P.worktreesDir });
      return {
        id: s.id, tool: s.tool, format: s.format ?? null, cwd, title, live: alive,
        ...(s.clientId ? { clientId: s.clientId } : {}),
        state: livenessOf(alive, mtimeMs, now, cfg), lastTs: mtimeMs,
        skillsUsed: rec.skillsUsed ?? [], status: status ?? null,
        recentContext: events.filter(e => e.lane === 'context').slice(-3),
        counts,
        gapCount: filterDispatchedWorktreeGaps(detectGaps(events, rec.skillsUsed ?? []), cwd).length,
        worktree: worktreeInfo(rec.cwd ?? cwd, { worktreesDir: P.worktreesDir }),
        loop: alive ? loopStage(events) : null,
        scope: alive ? sessionScope(
          events.filter(e => e.kind === 'file-edit').map(e => e.path),
          { projectRoot: rec.cwd ?? cwd ?? null, config: P.zoneConfig }) : null,
        internal,
      };
    });
  }


  // Finished-but-unmerged branch guard (glmps-66). The git scan is subprocess-
  // heavy (one `git cherry` per local branch, across every known repo root),
  // so it is refreshed on its own background timer (unmergedRefreshTimer,
  // below) rather than inline in the request path. /api/alerts and
  // /api/report/baseline just read the last-computed repo shapes here - the
  // pure detector still runs fresh per request so a newly filed ticket
  // suppresses its alert immediately. GLMPS_UNMERGED_SCAN=off disables the scan.
  // The scan must stay off the request path: a synchronous git call per branch
  // across every known repo root blocks every concurrent request.
  // Operator-tuned alert noise rules (config.json `alertRules`) - see the
  // 2026-07-05 alert review: injection allow-domains, machine-generated branch
  // globs, ticketed capture gaps. Absent keys fall back to detector defaults.
  const alertRules = cfg.alertRules ?? {};

  // Single-flight status of the current/last headless replay run (glmps-68).
  let replayRunStatus = null;

  let unmergedRepoCache = { ts: 0, repos: [] };
  // glmps-2-0-191: prUrl -> state of the PRs still open on GitHub, refreshed by
  // the same background scan, so the synchronous alert collector never waits on gh.
  let openPrStateCache = new Map();
  // Session control (mc-28 / mc-29). gateSeq mints ids server-side; gateSessions
  // maps a gate id back to its session so a decision does not have to scan every
  // control record. The map is a CACHE, not the truth: it is empty after a
  // restart, and both consumers fall back to the on-disk records.
  let gateSeq = 0;
  const gateSessions = new Map();
  /**
   * A gate just opened: tell the operator, wherever they are.
   *
   * The agent is BLOCKED inside its hook while this runs, so a room post that
   * throws must never propagate; an unreachable Slack has to degrade to "the
   * gate times out and the agent is told to retry", never to a wedged request.
   */
  function onGateOpened(gate) {
    try { scut?.gateOpened?.(gate); } catch { /* never block the gate on chat */ }
  }
  let unmergedRefreshInFlight = false;
  // Shared by the unmerged-branch scan and the worktree sweep, and kept across
  // restarts so a deploy does not relaunch every cherry (card glmps-2-0-runtime-86).
  const cherryCacheFile = stateFile(P.stateDir, 'cache', 'cherry-cache.json').path;
  const cherryCache = loadCherryCache(readPathFor(P.stateDir, 'cache', 'cherry-cache.json'));
  let cherryCacheSavedSize = cherryCache.size;
  // A scan still in flight at close() finishes later and would write into
  // stateDir after shutdown, racing whoever removes it (EPERM on Windows), so
  // close() stops further saves, waits a bounded time for the one already
  // writing, and a save still waiting on git results past that bound skips its
  // write. The scan's git calls are refused after close so no new child spawns.
  let cherryCacheClosed = false;
  let cherryCacheSaving = Promise.resolve();
  function persistCherryCache() {
    if (cherryCacheClosed || cherryCache.size === cherryCacheSavedSize) return cherryCacheSaving;
    cherryCacheSavedSize = cherryCache.size;
    cherryCacheSaving = saveCherryCache(cherryCacheFile, cherryCache, { shouldWrite: () => !cherryCacheClosed }).catch((e) => srcGuard.warn('cherry:save', `cherry cache save failed: ${e?.message ?? e}`));
    return cherryCacheSaving;
  }
  // Recompute unmergedRepoCache off the request path. Fire-and-forget from a
  // timer/boot call (never awaited there) - in-flight guarded so a slow scan
  // can never stack a second one on top of itself.
  let unmergedRefreshSettled = Promise.resolve();
  function refreshUnmergedCache() {
    if (env.GLMPS_UNMERGED_SCAN === 'off' || env.GLMPS_UNMERGED_SCAN === '0') return Promise.resolve();
    if (unmergedRefreshInFlight) return unmergedRefreshSettled;
    unmergedRefreshInFlight = true;
    unmergedRefreshSettled = runUnmergedRefresh();
    return unmergedRefreshSettled;
  }
  async function runUnmergedRefresh() {
    try {
      const exec = closableExec(() => cherryCacheClosed, gitExecAsync);
      const repos = await scanUnmergedRepos({ roots: gitScanRoots(), exec, cherryCache });
      unmergedRepoCache = { ts: Date.now(), repos };
      // Awaited so unmergedScanSettled() covers the save too.
      await persistCherryCache();
    } catch (e) { srcGuard.warn('unmerged:refresh', `unmerged-branch scan failed: ${e?.message ?? e}`); }
    finally { unmergedRefreshInFlight = false; }
  }
  // glmps-2-0-197: the open-PR lookup is a read-only gh call, so it is not gated
  // by GLMPS_UNMERGED_SCAN (which keeps an observing instance's git off repos it
  // does not own); riding that scan silently turned the alert off.
  let openPrStatesTs = 0;
  let openPrStatesInFlight = null;
  let openPrStatesSettled = Promise.resolve();
  function refreshOpenPrStates() {
    if (openPrStatesInFlight) return openPrStatesInFlight;
    openPrStatesTs = Date.now();
    openPrStatesInFlight = (async () => {
      // Only worth a gh call when a closed card names a PR; a failed lookup is an
      // empty map (nothing flagged), never a throw.
      const needsLookup = backlogStore.load(P.stateDir).items.some((i) => backlogStore.CLOSED_STATES.has(i.state) && backlogStore.cardPrUrls(i).length);
      if (!needsLookup) { openPrStateCache = new Map(); return; }
      const r = await openPrs.get();
      if (!r?.ok) srcGuard.warn('closed-open-pr:lookup', `open-PR lookup failed, closed-card PR alert is blind: ${r?.error ?? 'unknown'}`);
      openPrStateCache = openPrStates(r);
    })().catch((e) => {
      openPrStateCache = new Map();
      srcGuard.warn('closed-open-pr:lookup', `open-PR lookup failed, closed-card PR alert is blind: ${e?.message ?? e}`);
    }).finally(() => { openPrStatesInFlight = null; });
    openPrStatesSettled = openPrStatesInFlight;
    return openPrStatesInFlight;
  }
  function gatherClosedOpenPr(items) {
    // Quiet until asked, like the unmerged scan: the first alert read kicks it.
    if (openPrStatesTs === 0) refreshOpenPrStates();
    const ids = new Set(backlogStore.closedWithOpenPrIds(items, openPrStateCache));
    return items.filter((i) => ids.has(i.id)).map((i) => ({
      id: i.id, title: i.title, project: i.project, state: i.state,
      prUrl: backlogStore.cardPrUrls(i).find((u) => openPrStateCache.has(u.trim().toLowerCase())),
    }));
  }
  function gatherUnmergedFindings(tickets) {
    if (env.GLMPS_UNMERGED_SCAN === 'off' || env.GLMPS_UNMERGED_SCAN === '0') return [];
    // Lazy first kick: only start scanning once something actually asks (same
    // "quiet until asked" behavior as before this was cached on a timer) - a
    // server instance that never serves /api/alerts or /api/report/baseline
    // (most test files, short-lived CLI invocations) never pays this cost.
    // The very first call after boot/restart may see repos:[] (findings: [])
    // while the kicked-off scan is still in flight; the periodic timer keeps
    // it warm for every call after that.
    if (unmergedRepoCache.ts === 0) refreshUnmergedCache().catch(() => {});
    return detectUnmergedBranches({
      repos: unmergedRepoCache.repos, tickets,
      ignoreBranches: alertRules.unmerged?.ignoreBranches ?? [],
      ignoreProjects: alertRules.unmerged?.ignoreProjects ?? [],
    });
  }

  // Last-known ALERT COUNT cache (docs/superpowers/specs/2026-07-22-vitals-
  // trends-design.md, Step 2): shared between GET /api/alerts (writer, on
  // every call) and the vitals-trends sampler tick (reader, via
  // decideAlertsSource, vitals-trends-store.js). collectCurrentAlerts()
  // below is a ~1.3-1.8s synchronous scan; the tick must never call it on its
  // own 30s cadence (see decideAlertsSource's header comment for the full
  // rationale). `value` is the current UNACKNOWLEDGED count (same definition
  // GET /api/alerts uses without ?all=1) so the tick's `alerts` field means
  // the same thing whichever source produced it.
  let alertCountCache = { value: null, ts: 0 };
  // The unacknowledged list behind that count, so the alert-digest loop can
  // reuse a dashboard poll's scan instead of running its own.
  let alertListCache = { alerts: null, ts: 0 };
  // When the TICK itself last attempted a recompute (success or failure),
  // deliberately a separate clock from alertCountCache.ts; see
  // decideAlertsSource's header comment for why the two must not be merged.
  let alertRecomputeGate = { ts: 0 };

  // every other health signal feeding
  // collectAlerts already fails open on its own read (see memoryFindings'
  // own try/catch just below) - obligationStore.listOpen() did not. A
  // genuine read error (disk, a corrupt page) must degrade the OBLIGATIONS
  // slice of the alert center to empty, never take the WHOLE thing down
  // with a 500, since every other alert source in the same call is
  // otherwise healthy and still worth showing.
  function openObligationsOrEmpty() {
    if (!obligationStore) return [];
    try { return obligationStore.listOpen(); }
    catch (e) { console.error('[kernel] obligations listOpen failed:', e?.message || e); return []; }
  }

  // the last 24h of a guard hook's own fail-open log
  // (<stateDir>/guards/fail-open.ndjson, written locally by hooks/plan-gate.js
  // itself). A missing file or a corrupt line is "nothing to show", never a
  // 500 - this is a read of another process's append-only log, so it must be
  // exactly as fail-open as every other alert-center producer above. Phase K
  // final review (silent-failure): an UNREADABLE file is not "nothing to
  // show" - it becomes one synthetic entry naming the read failure, so the
  // alert center says the log itself is broken.
  function guardFailOpenRecent(windowMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    // readCapped already skips a torn/corrupt line (M2); this just adds the
    // 24h window on top. limit is generous (the file itself is capped at
    // ~1000 lines by appendCapped's own rotation).
    try {
      return readCapped(path.join(P.stateDir, 'guards', 'fail-open.ndjson'), { limit: 1000 })
        .filter((e) => (e.ts ?? 0) >= cutoff);
    } catch (e) {
      console.error('[kernel] guard fail-open log unreadable:', e?.message || e);
      return [{ ts: Date.now(), hook: 'guards', cardId: null, reason: `the guard fail-open log is unreadable: ${e?.message || e}` }];
    }
  }

  // the mem0/gepa quarantine counts and the
  // plugin-retry dead-letter gave-up count, recomputed fresh from their own
  // ndjson files on every call via the SAME refresh functions memory-
  // plugin.js/gepa-plugin.js already export - a tiny array-collecting
  // stand-in for the deleted pluginHealth tracker's own `.set`/`.ok` shape,
  // scoped to just this one call (never persisted, never shared state).
  function computeKernelHealth() {
    const map = new Map();
    const tracker = {
      ok(name) { map.delete(name); },
      set(name, { level, reason } = {}) { map.set(name, { consecutive: 1, level, lastReason: String(reason || 'failed'), ts: Date.now() }); },
    };
    if (ignoredConfigTokens.length) tracker.set('config-token-ignored', { level: 'critical', reason: ignoredConfigTokens.join('; ') });
    refreshQuarantineHealth(P.stateDir, tracker);
    refreshGepaQuarantineHealth(P.stateDir, tracker);
    try {
      const n = fs.readFileSync(retryDeadLetterFile, 'utf8').split('\n').filter(Boolean).length;
      if (n > 0) tracker.set('plugin-retry-gaveup', { level: 'critical', reason: `${n} job(s) gave up; see ${retryDeadLetterFile}` });
      // its own id - a successful read ends only ITS OWN
      // earlier read-failure episode, never the separate queue-file
      // ('retry-queue') or upsert-write ('retry-queue-write') ids, which a
      // dead-letter read happening to succeed has no bearing on.
      clearMiss('retry-queue-deadletter');
    } catch (e) {
      // Minor: only ENOENT means "no dead-letter file yet",
      // the normal steady state - any OTHER read error (EACCES, a locked
      // file, a transient disk error) is a real problem reading a file this
      // health check depends on, and must be a named miss, not silently
      // swallowed by a bare catch.
      if (e && e.code === 'ENOENT') {
        clearMiss('retry-queue-deadletter'); // no file yet is also a healthy state, not a miss.
      } else {
        const reason = `dead-letter read failed: ${e.message || String(e)}`;
        console.error('[kernel] dead-letter read failed', reason);
        reportMiss('retry-queue-deadletter', reason);
      }
    }
    return Object.fromEntries(map);
  }

  // Raw (pre-ack) ranked+deduped Alert[], the same computation GET /api/alerts
  // and POST /api/alerts/prime both need, factored out so the two never drift.
  function collectCurrentAlerts() {
    const items = backlogStore.load(P.stateDir).items;
    const quarantined = items.filter(i => i.quarantined).map(i => ({
      id: i.id, title: i.title, flags: i.provenance?.flags ?? [], critical: false,
      ts: i.updatedTs ?? i.createdTs ?? i.ts ?? 0,
    }));
    const byTool = {};
    for (const t of TOOL_REGISTRY) if (!t.adapter && t.popularityWeight >= 3) byTool[t.id] = 0;
    const allEvents = [...eventLog.values()].flat();
    const injections = scanEventsForInjection(allEvents, { allowDomains: alertRules.injection?.allowDomains ?? [] });
    const egress = detectEgress(allEvents, { projectRoot: REPO_ROOT });
    // Attestation findings + every registered signal-producer (Coordination
    // Contract: signal-producer.js is the ONE seam other builds' signals ride
    // through - see server/lib/evaluation/signal-producer.js). This replaces
    // Build A's Task-8 hardcoded workspaceSignals splice.
    // glmps-145: memory attestation was computed by its own route and by the
    // trial tick, but never reached the alert center, so a tampered or deleted
    // memory managed block produced NO operator alert. With every item
    // 'approved' rather than 'trialing' the tick had nothing to check either,
    // making drift completely silent. Relabelled so it does not masquerade as
    // guardrail drift (memoryAttestationAlerts).
    let memoryFindings = [];
    try {
      memoryFindings = memoryAttestationAlerts(
        computeMemoryAttestation({ baselinePath: path.join(P.stateDir, 'cross-agent-memory', 'baseline.json') }).findings ?? [],
      );
    } catch { /* fail-open: a missing/malformed memory baseline must not blank the alert center */ }
    const attestation = [...memoryFindings, ...collectSignals()];
    const unmerged = gatherUnmergedFindings(items);
    const closedOpenPr = gatherClosedOpenPr(items);
    const sessions = index.list({});
    let usageCapture = [];
    try {
      usageCapture = usageCaptureFindings({ ...readUsageCaptureInputs({ settingsFile: P.settingsFile, stateDir: P.stateDir }),
        sessions, nowMs: Date.now(), silentHours: alertRules.usageCapture?.silentHours });
    } catch { /* fail-open: a usage-capture probe error must not blank the alert center */ }
    let actionsMinutes = [];
    try {
      actionsMinutes = actionsMinutesFindings(readActionsMinutes(P.stateDir, { allowance: cfg.actionsMinutes.allowance }), { thresholds: cfg.actionsMinutes.thresholds });
    } catch { /* fail-open */ }
    let tapMirrorQuota = [];
    try {
      tapMirrorQuota = (tapMirror?.quotaExceeded() ?? []).map((f) => ({ ...f, name: clientStore?.get(f.clientId)?.name ?? null }));
    } catch { /* fail-open */ }
    let tapSpoolFull = [];
    try {
      tapSpoolFull = (tapIngest?.spoolFull() ?? []).map((f) => ({ ...f, name: clientStore?.get(f.clientId)?.name ?? null }));
    } catch { /* fail-open */ }
    return collectAlerts({ quarantined, coverage: { byTool }, injections, egress, attestation, unmerged, captureIgnore: alertRules.capture?.ignoreTools ?? [],
      concurrentWriters: detectConcurrentWriters({ sessions, worktreesDir: P.worktreesDir, nowMs: Date.now() }), integrity: recentIntegrity(), adapterHealth: adapterHealth(),
      scutChannelHealth: scutChannelHealth(P.scutChannelHealthDir), graphSyncHealth: currentGraphSyncHealth(), graphIntegrity: currentGraphIntegrity(), loopHealth: loopRegistry.snapshot(), obligations: openObligationsOrEmpty(), guardFailOpen: guardFailOpenRecent(),
      kernelHealth: computeKernelHealth(), usageCapture, actionsMinutes, tapSpoolFull, tapMirrorQuota, certExpiry, closedOpenPr });
  }

  // Records a workspaceSignal() result so the NEXT collectCurrentAlerts() call
  // (GET /api/alerts, POST /api/alerts/prime) picks it up - same "computed
  // fresh per request" model every other producer above uses, just backed by
  // an in-memory list instead of a rescan of some other on-disk/event source
  // (there's no such durable source for workspace divergence yet). Capped so a
  // long-running server can't grow this unboundedly.
  function recordWorkspaceSignal(wsSig) {
    workspaceSignals.push({
      source: 'workspace-divergence',
      severity: 'warn',
      title: 'Workspace divergence: declared goal diverging from observed work',
      detail: wsSig.detail,
      target: { view: 'sessions', id: wsSig.sessionId },
      ts: wsSig.ts,
    });
    if (workspaceSignals.length > 500) workspaceSignals.shift();
  }


  // Feeds the LEARNABLE subset of alerts (alert-learn.js's ALERT_CODE_MAP - 
  // today just egress -> egress) through the SAME learning-store/applyGuard
  // pipeline gaps use (gap-pipeline.js's upsertGapAndApply), so an alert can
  // become a proposed (or auto-applied) guard exactly like a capability gap.
  //
  // Shadow-arm measurement is handled SEPARATELY from that upsert (recordShadowForNew:
  // false above) because nearly every alert-derived gap dedups to the SAME
  // learning-store row (project is always '' for alert-derived gaps - see
  // alert-learn.js), so upsertGapInto's isNew only fires once, ever. Alert
  // RECURRENCE is exactly what shadow-arm should be measuring here (this is
  // Phase 3 - reusing shadow-arm.js, not a parallel store): a persisted
  // per-alert-id seen-set (alert-seen.js) records exactly one shadow
  // occurrence per DISTINCT alert id, regardless of whether the learning item
  // itself was "new". Fail-open throughout: never let alert-learning break
  // GET /api/alerts or POST /api/alerts/prime.
  function primeAlertsIntoLearning(alerts) {
    try {
      const learnable = alertsToGaps(alerts);
      if (!learnable.length) return { primed: 0 };

      let lq = learningStore.load(P.stateDir);
      let lqDirty = false;
      const seen = loadAlertSeen(P.alertSeenFile);
      let seenDirty = false;
      let primed = 0;

      for (const { alertId, gap, ctx } of learnable) {
        const result = upsertGapAndApply(lq, gap, ctx, {
          stateDir: P.stateDir,
          recordShadowForNew: false, // this function's seen-set below is the sole shadow recorder for alerts
        });
        lq = result.lq;
        if (result.dirty) lqDirty = true;

        if (typeof alertId === 'string' && alertId && !seen.has(alertId)) {
          try {
            const fired = result.item?.status === 'applied';
            recordShadow(P.stateDir, { taskClass: gap.code, fired, sid: ctx.sessionId || null });
          } catch { /* fail-open: never let shadow-recording break alert priming */ }
          seen.add(alertId);
          seenDirty = true;
          primed++;
        }
      }

      if (lqDirty) learningStore.save(P.stateDir, lq);
      if (seenDirty) saveAlertSeen(P.alertSeenFile, seen);
      return { primed };
    } catch {
      return { primed: 0 }; // fail-open: alert priming must never block /api/alerts
    }
  }

  // Actor identity for the current request (glmps-72 B3): a presented token
  // that maps to a configured actor wins; otherwise the request is treated as
  // this server's own default local identity (the loopback/operator case).
  // Used ONLY at the specific gate choke points below - never for dispatch,
  // personalization, or per-actor learning.
  function resolveActor(req) {
    const token = presentedTokenFrom(req.headers || {});
    const byToken = token ? actorForToken(actors, token) : null;
    return byToken ? byToken.id : (cfg.actor ?? 'operator');
  }

  // Single-flight guard for POST /api/wiki/ask (glmps-44) - one live question
  // at a time, like the replay runner: LLM calls cost real quota, and the agy
  // backend is serial-only (newest-DB correlation).
  let wikiAskRunning = false;
  // F8 (Default, operator may overrule): wiki questions are built from repo
  // text, so an agentic CLI with auto-approved tools is never chosen unless
  // config.json sets wikiAsk.allowAgentBackend. Order: the plain Gemini API,
  // then claude -p with --tools= (runClaude strips every tool), then agy on
  // opt-in. runClaude's own refusals (GLMPS_MODEL_RUNNER=off, a test process)
  // are mirrored so the route answers 503, not a 500 from a refusing backend.
  function pickWikiAskModel({ agyConvDir }) {
    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (apiKey) return (prompt) => defaultCallModel(prompt, { apiKey });
    const runnerOff = env.GLMPS_MODEL_RUNNER === 'off' || process.env.GLMPS_MODEL_RUNNER === 'off' || isTestProcess({ env });
    if (!runnerOff) return (prompt) => runClaude({ model: getModelConfig(cfg).models.fast, system: WIKI_ASK_SYSTEM, prompt, timeoutMs: 180000, env });
    if (cfg.wikiAsk?.allowAgentBackend === true && fs.existsSync(agyConvDir)) return (prompt) => agyGenerate(prompt, { convDir: agyConvDir });
    return null;
  }
  // The kernel's own repo reads its wiki from the published state-dir build
  // (D-W4); every other project keeps its graphify-out/wiki, served by /wiki-ext.
  const isRepoRoot = (r) => path.resolve(String(r)).toLowerCase() === path.resolve(REPO_ROOT).toLowerCase();
  function resolveWikiSource(root) {
    if (isRepoRoot(root)) {
      const current = readCurrentWiki(P.stateDir);
      if (!current) return { manifestPath: null, wikiDir: null, base: null };
      const wikiDir = path.join(wikiPaths(P.stateDir).builds, current.build);
      return { manifestPath: path.join(wikiDir, 'manifest.json'), wikiDir, base: '/wiki' };
    }
    const wikiDir = path.join(root, 'graphify-out', 'wiki');
    return { manifestPath: path.join(wikiDir, 'manifest.json'), wikiDir, base: `/wiki-ext/${encodeURIComponent(path.basename(root))}` };
  }
  // Freshness compares the graph a build recorded with the graph on disk now;
  // cached per file by mtime and size so a 20 MB graph is not re-parsed on
  // every GET /api/wiki.
  const readGraphFingerprint = createGraphFingerprintReader();
  // Read the generated manifest for a root and derive staleness vs HEAD.
  // Hoisted out of the request handler (glmps-42) so other consumers (the
  // wiki loop's checker, GET /api/wiki) can reuse it without duplicating the
  // manifest/HEAD read.
  async function readWikiState(root) {
    const src = resolveWikiSource(root);
    let manifest = null;
    let manifestError = null;
    if (src.manifestPath) {
      try { manifest = JSON.parse(fs.readFileSync(src.manifestPath, 'utf-8')); }
      catch (e) { if (e.code !== 'ENOENT') manifestError = `unreadable manifest ${src.manifestPath}: ${e.message}`; }
    }
    let headCommit = null;
    try {
      headCommit = await new Promise(res =>
        execFile('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }, (e, out) => res(e ? null : out.trim())));
    } catch { headCommit = null; } // a root that is not a git checkout: freshness is reported 'unknown'
    const builtFromGraph = typeof manifest?.graphFingerprint === 'string' ? manifest.graphFingerprint : null;
    const currentGraph = await readGraphFingerprint(root);
    const status = computeWikiStatus({ builtAtCommit: manifest?.builtAtCommit ?? null, headCommit, builtFromGraph, currentGraph, sections: manifest?.sections });
    const sections = (manifest?.sections ?? []).map((s, i) => ({ ...s, stale: status.sections[i]?.stale ?? false }));
    // wikiDir is resolved HERE, once, and
    // reused by any caller that needs it (POST /api/wiki/ask) instead of
    // calling resolveWikiSource(root) a second time. A second call is a
    // TOCTOU window -- current.json valid at the first read, malformed by
    // the second -- that used to escape straight to the client as a raw,
    // path-leaking 500. Internal-only: every route that forwards this object
    // to an HTTP response must strip wikiDir first (it is an absolute
    // server-filesystem path).
    return { project: path.basename(root), root: root.replace(/\\/g, '/'), manifest, manifestError, headCommit,
      needsUpdate: status.needsUpdate, freshness: status.freshness, staleReason: status.staleReason, builtFromGraph, currentGraph,
      base: manifest ? src.base : null, sections,
      wikiDir: src.wikiDir };
  }
  // Strip the internal-only wikiDir field before a readWikiState() result
  // reaches an HTTP response (GET /api/wiki, POST /api/wiki/rebuild): it is
  // an absolute path on the server's own filesystem, never client-facing.
  function publicWikiState(state) {
    const { wikiDir, ...pub } = state;
    return pub;
  }

  // the one per-root single-flight guard every
  // `graphify update <root>` caller goes through (graphRebuildTick,
  // refreshGraphForWiki, POST /api/graph/rebuild, and runGraphify's own
  // update branch for graphifyVersionTick). A second caller for the SAME
  // root while the first is still running is refused (GraphifyBusyError),
  // never allowed to run as a second writer; a different root is unaffected.
  const graphifySingleFlight = createGraphifySingleFlight();
  function graphifyUpdate(root, { reservation, ...opts } = {}) {
    return graphifySingleFlight.run(root, () => spawnGraphifyUpdate(root, opts), { reservation });
  }

  // The repair path for a silently collapsed knowledge graph (see
  // lib/observability/graph-refresh.js for the 2026-07-28 incident it exists
  // for). Runs `graphify update <root>` for every in-scope project that already
  // has a graphify-out/, sequentially so a many-repo box never fans out into a
  // CPU storm. Neither counter is persisted: a restart re-arms with a clean
  // slate, worst case one extra rebuild sooner than minIntervalMs would have
  // allowed.
  const hasGraphDir = (r) => { try { return fs.existsSync(path.join(r, 'graphify-out')); } catch { return false; } };
  // Shared by graphRebuildTick, graphShapeTick and graphifyVersionTick (card
  // glmps-2-0-93): a root that merely has a graphify-out/ is not enough; it
  // must be a ship root or an opted-in machine root. Before this, 24 roots ran
  // daily, 17 of them worktree copies of one repo, one a trading repo.
  // The panel's opt-ins (card glmps-2-0-101) layer over config.json's graph
  // block; read per call so a toggle reaches the next tick with no restart.
  const currentGraphConfig = () => effectiveGraphConfig(cfg.graph, loadMachineState(P.graphMachineFile));
  let lastGraphRoots = [];
  // Card glmps-2-0-runtime-73: the session index keeps every cwd ever seen
  // (1,350 on the live box), so without this every tick re-spawned git for all
  // of them and the graph-integrity loop ran into its 2-minute ceiling.
  const cachedGraphProbe = cachedProbeAsync({ probeAsync: graphProbeAsync });
  async function classifyKnownGraphRoots({ signal } = {}) {
    const { sessionCwds, additionalDirectories } = graphRootSources();
    const { roots } = await classifyGraphRootsAsync({
      kernelRoot: REPO_ROOT, sessionCwds, additionalDirectories, graph: currentGraphConfig(),
      privateDirs: loadPrivateDirs({ env }), probeAsync: cachedGraphProbe, signal,
    });
    lastGraphRoots = roots;
    return roots;
  }
  // Inputs for the merged machine graph: opted-in machine roots with a graph.
  const machineGraphInputs = (roots) => roots
    .filter(r => r.scope === 'machine' && r.optedIn === true)
    .map(r => ({ root: r.root, graphPath: graphPathFor(r.root) }))
    .filter(i => i.graphPath);
  let graphMachineRunning = false;
  async function graphMachineScanTick({ force = false } = {}) {
    if (graphMachineRunning) return { built: false, reason: 'busy' };
    if (!currentGraphConfig().machine.enabled) return { built: false, reason: 'machine scan is off' };
    graphMachineRunning = true;
    try {
      const inputs = machineGraphInputs(await classifyKnownGraphRoots());
      if (!inputs.length) return { built: false, reason: 'no opted-in repo has a graph' };
      if (!force && !machineGraphStale(P.stateDir, inputs)) return { built: false, reason: 'up to date' };
      return { built: true, manifest: await buildMachineGraph({ stateDir: P.stateDir, inputs, merge: mergeGraphs }) };
    } finally { graphMachineRunning = false; }
  }
  async function scopedGraphRoots({ signal } = {}) {
    return selectRebuildRoots(inScopeRoots(await classifyKnownGraphRoots({ signal })).map(r => r.root), { hasGraphDir });
  }
  // The rebuild tick also builds the first graph of every in-scope root: a
  // ship root needs one for the ship graph (the corpus had none until card
  // glmps-2-0-103), and a machine root's opt-in is the operator's consent to
  // index it. The shape sampler and the version audit keep scopedGraphRoots,
  // which compare existing graphs only.
  async function rebuildGraphRoots() {
    return inScopeRoots(await classifyKnownGraphRoots()).map(r => r.root);
  }
  let graphRebuildLastRunAt = null;
  let graphRebuildRunning = false;
  let graphSyncHealthStore = loadSyncHealth(P.graphSyncHealthFile);
  function currentGraphSyncHealth() { return graphSyncHealth(graphSyncHealthStore); }

  // Upgrade-plan items 7 and 7b step 3: per-root node/edge counts against a
  // baseline, and the commit a full no-op re-extraction verified. See
  // graph-integrity.js for why the baseline never moves to a collapsed shape.
  let graphIntegrityStore = loadGraphIntegrity(P.graphIntegrityFile);
  function currentGraphIntegrity() { return graphIntegrity(graphIntegrityStore); }
  function readHeadCommit(root) {
    return new Promise(res => {
      try { execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true }, (e, out) => res(e ? null : out.trim())); }
      catch { res(null); }
    });
  }
  // mtime per root, so the sampler re-parses a multi-MB graph.json only when
  // something (often graphify's own post-commit hook, which the server never
  // sees) has rewritten it.
  const graphShapeMtimes = new Map();
  function observeRootShape(root, { force = false } = {}) {
    const gp = graphPathFor(root);
    if (!gp) return;
    let mtimeMs;
    try { mtimeMs = fs.statSync(gp).mtimeMs; } catch { return; }
    if (!force && graphShapeMtimes.get(root) === mtimeMs) return;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(gp, 'utf-8')); } catch { return; }
    graphShapeMtimes.set(root, mtimeMs);
    graphIntegrityStore = observeGraphShape(graphIntegrityStore, root, graphShape(raw), { now: Date.now(), minRatio: cfg.graphIntegrity.minRatio });
  }
  // Every server-run `graphify update <root>` ends here: record the sync
  // verdict, re-read the shape, and stamp a verified no-op. A no-op is only
  // verified when HEAD did not move during the run, otherwise the stamp would
  // vouch for a commit the extraction never saw.
  async function recordGraphifyRun(root, run, headBefore) {
    const result = classifyGraphifyRun(run);
    // One sync-health key per root: the rebuild endpoint names roots with
    // backslashes, the tick with forward slashes.
    graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, String(root).replace(/\\/g, '/'), result, { now: Date.now() });
    observeRootShape(root, { force: true });
    if (result.outcome === 'noop' && headBefore && (await readHeadCommit(root)) === headBefore) {
      graphIntegrityStore = stampVerifiedNoop(graphIntegrityStore, root, { commit: headBefore, now: Date.now() });
    }
    persistGraphIntegrity(P.graphIntegrityFile, graphIntegrityStore);
    return result;
  }
  async function graphShapeTick({ signal } = {}) {
    const roots = (await scopedGraphRoots({ signal })).filter(r => graphPathFor(r));
    for (const root of roots) {
      if (signal?.aborted) break;
      observeRootShape(root);
    }
    persistGraphIntegrity(P.graphIntegrityFile, graphIntegrityStore);
    return roots;
  }
  // One-shot store cleanup for the scoping above: merge slash/case variants of
  // a root's key and move every out-of-scope entry into the task-1 snapshot
  // (<stateDir>/migrations/graphify-settings.json). Runs inside the server
  // because both stores live in memory here and the next persist would
  // overwrite an outside edit. Writes nothing when there is nothing to move.
  async function migrateGraphScopeState() {
    const roots = await classifyKnownGraphRoots();
    const kernelKey = String(REPO_ROOT).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    // A failed git probe classifies every root as "not a git repo"; archiving
    // on that would strip the ship roots' baselines too.
    if (!roots.some(r => r.scope === 'ship' && r.root.toLowerCase() === kernelKey)) {
      return { skipped: 'kernel root did not classify as ship' };
    }
    if (closingPromise) return { skipped: 'server closing' };
    const inScope = inScopeRoots(roots).map(r => r.root);
    const plan = planScopeMigration({ syncHealth: graphSyncHealthStore, integrity: graphIntegrityStore, inScope });
    if (!plan.changed) return { changed: false, inScope };
    appendScopeArchive(path.join(P.stateDir, 'migrations', 'graphify-settings.json'), plan, { inScope });
    graphSyncHealthStore = plan.syncHealth;
    graphIntegrityStore = plan.integrity;
    persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
    persistGraphIntegrity(P.graphIntegrityFile, graphIntegrityStore);
    return {
      changed: true, inScope,
      archived: { syncHealth: Object.keys(plan.archive.syncHealth).length, integrity: Object.keys(plan.archive.integrity).length },
      merged: plan.merged,
    };
  }
  // Decision 1's "refreshed locally" (card glmps-2-0-103): the task-6 build
  // was a script nothing ran, so this machine never had a ship graph. Merge
  // and prune only: the rebuild tick has already updated each root inside
  // the single-flight guard.
  let graphShipBuildRunning = false;
  async function graphShipBuildTick({ shipUpdated = false } = {}) {
    if (graphShipBuildRunning) return { built: false, reason: 'busy' };
    if (closingPromise) return { built: false, reason: 'server closing' };
    const sp = shipGraphPaths(P.stateDir);
    if (!shipUpdated && fs.existsSync(sp.manifest)) return { built: false, reason: 'up to date' };
    const ship = lastGraphRoots.filter(r => r.scope === 'ship').map(r => r.root);
    const kernelRoot = ship.find(isRepoRoot);
    const corpusRoot = ship.find(r => !isRepoRoot(r));
    if (!kernelRoot || !corpusRoot) return { built: false, reason: 'no corpus root in scope' };
    graphShipBuildRunning = true;
    try {
      const manifest = await buildShipGraphFn({
        kernelRoot, corpusRoot, shipDir: sp.dir, skipUpdate: true, merge: mergeGraphs, commitOf: readHeadCommit,
        version: async () => { try { return await graphifyVersionCheck(); } catch { return null; } },
      });
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, 'graphify-ship@build',
        { outcome: 'updated', nodes: manifest.nodes, existingNodes: null, reason: `ship graph built from ${kernelRoot} and ${corpusRoot}` },
        { now: Date.now() });
      return { built: true, manifest };
    } catch (e) {
      console.error('ship graph build failed:', e?.message ?? e);
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, 'graphify-ship@build',
        { outcome: 'failed', nodes: null, existingNodes: null, reason: String(e?.message ?? e) },
        { now: Date.now() });
      return { built: false, reason: String(e?.message ?? e) };
    } finally {
      persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
      graphShipBuildRunning = false;
    }
  }
  async function graphRebuildTick() {
    const due = planGraphRebuildTick({
      enabled: cfg.graphRebuild.enabled, running: graphRebuildRunning,
      lastRunAt: graphRebuildLastRunAt, now: Date.now(),
      minIntervalMs: cfg.graphRebuild.minIntervalMs,
    });
    if (!due) return;
    graphRebuildRunning = true;
    try {
      try { await installOptedInIntegrations(); }
      catch (e) { console.error('graphify integrations failed:', e?.message ?? e); }
      const roots = await rebuildGraphRoots();
      let shipUpdated = false;
      for (const root of roots) {
        // refused (not run) if refreshGraphForWiki or POST
        // /api/graph/rebuild is already updating this SAME root; skip it
        // this tick rather than queue a second writer behind it -- the next
        // tick (or the other caller's own completion) picks it up again.
        let spawned;
        const headBefore = await readHeadCommit(root);
        try {
          spawned = await graphifyUpdate(root, { timeout: GRAPHIFY_UPDATE_TIMEOUT_MS });
        } catch (e) {
          if (e instanceof GraphifyBusyError) { console.error(`graph auto-rebuild: ${root} skipped - ${e.message}`); continue; }
          throw e;
        }
        const { code, stdout, stderr } = spawned;
        // glmps-113 / glmps-86: a background timer has no HTTP caller
        // to report to, so console.error was the whole reporting story here --
        // and it goes to the server's stderr file, which nobody reads. A
        // refusal DID exit 1 and DID get logged; harbor-app sat frozen for 16
        // days anyway, with the evidence in .server-8123.err the entire time.
        // The exit code also cannot separate `updated` from `noop`, which both
        // exit 0. So: classify from the output, and persist the verdict so a
        // frozen graph reaches the alert center instead of a log file.
        const result = await recordGraphifyRun(root, { code, stdout, stderr }, headBefore);
        if (result.outcome === 'refused' || result.outcome === 'failed') {
          console.error(`graph auto-rebuild: ${root} ${result.outcome} - ${result.reason}`);
        }
        // Graph-refresh event (D-W5): a rebuilt graph for our own repo is a
        // wiki trigger. Builds only if HEAD moved; the loop decides.
        if (result.outcome === 'updated' && isRepoRoot(root)) runWikiLoop({ reason: 'graph.refreshed' });
        if (result.outcome === 'updated' && lastGraphRoots.some(r => r.scope === 'ship' && r.root === root)) shipUpdated = true;
      }
      await graphShipBuildTick({ shipUpdated });
    } finally {
      persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
      graphRebuildLastRunAt = Date.now();
      graphRebuildRunning = false;
    }
  }

  // glmps-2.0 repo upgrade-plan item 7b step 1: audit a candidate graphify version before
  // adopting it, and roll back if adopting it regresses a graph. The upstream
  // CHANGELOG.md stops at 0.1.8 while the package ships past 0.9.51, so a
  // changelog read cannot gate this; see graphify-version.js for why the audit
  // is behavioural (CLI surface + rebuild node counts) instead.
  //
  // `runCmd` is the same spawn shape as graphRebuildTick above: windowsHide,
  // no shell unless the binary could not be resolved, no detached (Windows'
  // DETACHED_PROCESS would make every descendant console-less and pop windows).
  function runCmd(bin, args, { cwd } = {}) {
    return new Promise(res => {
      const opts = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, ...(cwd ? { cwd } : {}) };
      const child = spawn(bin, args, opts);
      let stdout = ''; let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('close', (code) => res({ code, stdout, stderr }));
      child.on('error', (err) => res({ code: 1, stdout: '', stderr: String(err?.message ?? err) }));
    });
  }
  function runGraphify(args) {
    // an 'update <root>' call goes through the SAME per-root single-
    // flight guard as graphRebuildTick and POST /api/graph/rebuild (this is
    // graphifyVersionTick's own post-upgrade rebuild loop, a fourth real
    // caller that would otherwise be unguarded). Every other invocation
    // (--version, --help via runCmd elsewhere) never touches graph.json, so
    // it is never gated.
    if (args[0] === 'update' && args[1]) return graphifyUpdate(args[1], { timeout: GRAPHIFY_UPDATE_TIMEOUT_MS });
    return runGraphifyWith({ resolveBin: resolveGraphifyBin, runCmd }, args);
  }
  // PyPI's JSON API, not a changelog: the version number is the one fact that
  // stays reliable across releases. Fails open (returns null) on any network
  // or parse error so a flaky lookup can never break the tick.
  async function latestGraphifyVersion() {
    try {
      const res = await fetch('https://pypi.org/pypi/graphifyy/json');
      if (!res.ok) return null;
      const body = await res.json();
      return body?.info?.version ?? null;
    } catch { return null; }
  }
  // Same graph.json read graphStatusForRoot uses below, over the in-scope
  // roots the version tick resolved once, so before and after compare the
  // same set.
  function graphNodeCounts(roots) {
    const out = {};
    for (const root of roots) {
      const gp = graphPathFor(root);
      if (!gp) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(gp, 'utf-8'));
        out[root] = Array.isArray(raw.nodes) ? raw.nodes.length : 0;
      } catch { out[root] = 0; }
    }
    return out;
  }

  let graphifyVersionLastRunAt = null;
  let graphifyVersionRunning = false;
  // graphifyVersionTick's own three
  // real-process/network seams, each defaulting to a refusal under
  // isTestProcess({ env }) when no override was given (mirrors
  // spawnGraphifyUpdate's own guard, M2, exactly). Resolved here (not as a
  // startServer parameter default) because the real implementations they
  // fall back to -- runCmd, latestGraphifyVersion, runGraphify -- are
  // defined above, in this same function body.
  const graphifyVersionRunCmd = graphifyVersionOverrides.runCmd
    ?? (isTestProcess({ env }) ? testRefusingGraphifyVersionRunCmd : runCmd);
  const graphifyVersionLatest = graphifyVersionOverrides.latestGraphifyVersion
    ?? (isTestProcess({ env }) ? testRefusingLatestGraphifyVersion : latestGraphifyVersion);
  const graphifyVersionCheck = graphifyVersionOverrides.graphifyVersion
    ?? (isTestProcess({ env })
      ? testRefusingGraphifyVersionCheck
      : (async () => (await runGraphify(['--version'])).stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null));
  // waitForGraphifyUpdate's own bounds
  // ({ maxWaitMs, pollMs, sleep }), injectable so a test can hold a root busy
  // past a short wait. Empty in production: the lib's own defaults apply.
  const graphifyVersionWaitOpts = graphifyVersionOverrides.waitOpts ?? {};
  // Graphify plan task 9: the app owns the claude and agents skill copies and
  // the integrations of opted-in machine repos. Both write outside the state
  // dir (the user's home, the user's repos), so under isTestProcess() they are
  // off unless a test names the home (skillHome) or the runner
  // (integrationRunCmd) explicitly.
  const graphifySkillHome = graphifyVersionOverrides.skillHome
    ?? (isTestProcess({ env }) ? null : os.homedir());
  const graphifyIntegrationRunCmd = graphifyVersionOverrides.integrationRunCmd
    ?? (isTestProcess({ env }) ? null : runCmd);
  let graphifyRolledBack = false;
  // One sync-health key per skill copy, so a failed install reaches the alert
  // center and the next success clears it.
  async function syncGraphifySkills({ allowDowngrade = false } = {}) {
    if (!graphifySkillHome || closingPromise) return [];
    const plan = skillRefreshPlan({ installed: await graphifyVersionCheck(), home: graphifySkillHome, env, allowDowngrade });
    if (!plan.length) return [];
    const results = await refreshGraphifySkills({ runCmd: graphifyVersionRunCmd, plan });
    for (const r of results) {
      if (!r.ok) console.error(`graphify skill refresh: --platform ${r.platform} failed: ${r.detail}`);
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify-skill@${r.platform}`,
        { outcome: r.ok ? 'updated' : 'failed', nodes: null, existingNodes: null,
          reason: r.ok ? `skill copy refreshed (was ${r.from ?? 'missing'})` : `graphify install --platform ${r.platform} failed: ${r.detail}` },
        { now: Date.now() });
    }
    persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
    return results;
  }
  // Ship repos carry their integrations in source; only opted-in machine
  // repos are ever written, and only for a section that is missing.
  async function installOptedInIntegrations() {
    if (!graphifyIntegrationRunCmd || closingPromise) return [];
    const roots = (await classifyKnownGraphRoots())
      .filter(r => r.scope === 'machine' && r.optedIn === true).map(r => r.root);
    if (!roots.length) return [];
    const { results, touchedSkills } = await installRepoIntegrations({ roots, runCmd: graphifyIntegrationRunCmd });
    for (const row of results) {
      for (const f of row.failed) console.error(`graphify integrations: ${row.root} ${f.id} failed: ${f.detail}`);
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify-integrations@${row.root}`,
        { outcome: row.failed.length ? 'failed' : 'updated', nodes: null, existingNodes: null,
          reason: [row.installed.length ? `installed ${row.installed.join(', ')}` : '',
            row.failed.length ? `failed ${row.failed.map(f => `${f.id} (${f.detail})`).join(', ')}` : ''].filter(Boolean).join('; ') },
        { now: Date.now() });
    }
    if (results.length) persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
    // gemini install overwrites ~/.agents/skills with its own variant.
    if (touchedSkills) await syncGraphifySkills();
    return results;
  }
  // uv must not replace the tool while a graphify launcher holds it (the
  // 2026-10-23 os error 32). The list goes through graphifyVersionRunCmd, so
  // it inherits that seam's test refusal; listGraphifyProcesses and
  // processWaitOpts ({ maxWaitMs, pollMs, sleep, now }) let a test drive it
  // on any platform.
  const graphifyProcessList = graphifyVersionOverrides.listGraphifyProcesses
    ?? (() => listGraphifyProcesses({ runCmd: graphifyVersionRunCmd }));
  const graphifyProcessWaitOpts = graphifyVersionOverrides.processWaitOpts ?? {};
  const waitForGraphifyIdle = () => waitForNoGraphifyProcess({ list: graphifyProcessList, ...graphifyProcessWaitOpts });
  // `uv tool install` for a rollback, run only once no graphify launcher is
  // running. Still busy after the wait reads as a failed install, so each
  // caller's existing failure path keeps the marker and the next tick retries.
  async function uvToolInstallWhenIdle(spec) {
    const idle = await waitForGraphifyIdle();
    if (!idle.idle) return { code: 1, stdout: '', stderr: `deferred, graphify still running: ${describeGraphifyProcesses(idle.processes)}` };
    return graphifyVersionRunCmd('uv', ['tool', 'install', spec]);
  }

  // the "pending rollback" marker. Written
  // (atomically) BEFORE the upgrade install, and cleared only after a passing
  // rebuild audit or a verified (exit 0) rollback. A shutdown anywhere in
  // between -- the post-upgrade rebuild loop runs for minutes -- leaves it
  // on disk, and the next tick acts on it BEFORE the installed === latest
  // early return, which would otherwise keep an unaudited (or known-
  // regressing) version installed forever with nothing in health.
  const graphifyPendingRollbackFile = path.join(path.dirname(P.graphSyncHealthFile), 'graphify-pending-rollback.json');
  function readPendingGraphifyRollback() {
    let raw;
    try { raw = fs.readFileSync(graphifyPendingRollbackFile, 'utf8'); }
    catch (e) {
      // only ENOENT means "no marker". Anything else (EACCES,
      // EISDIR, EBUSY, ...) means a marker may be there that we cannot see;
      // the caller must not treat that as a clean slate.
      if (e?.code === 'ENOENT') return null;
      return { unreadable: `${e?.code ?? 'error'}: ${e?.message ?? e}` };
    }
    try {
      const m = JSON.parse(raw);
      if (m && typeof m.prior === 'string' && typeof m.candidate === 'string') return m;
    } catch { /* malformed: handled below */ }
    // Names no version to roll back to, so there is nothing it can drive;
    // cleared (and said so) rather than re-logged on every tick.
    console.error('graphify version tick: malformed pending-rollback marker discarded');
    clearPendingGraphifyRollback();
    return null;
  }
  function clearPendingGraphifyRollback() {
    try { fs.rmSync(graphifyPendingRollbackFile, { force: true }); }
    catch (e) { console.error('graphify version tick: could not clear the pending-rollback marker:', e?.message ?? e); }
  }
  // Versions a rebuild audit rejected, each with the version it was rolled back
  // to. The setup wizard's `uv tool install graphifyy@latest` reinstalls such a
  // version outside the tick, and with installed equal to latest and no marker
  // the tick used to keep it unchecked.
  const graphifyRejectedFile = path.join(path.dirname(P.graphSyncHealthFile), 'graphify-rejected.json');
  function readRejectedGraphify() {
    try { const r = JSON.parse(fs.readFileSync(graphifyRejectedFile, 'utf8')); return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; }
    catch { return {}; }
  }
  function writeRejectedGraphify(next) {
    try { writeJsonAtomic(graphifyRejectedFile, next); }
    catch (e) { console.error('graphify version tick: could not record the rejected versions:', e?.message ?? e); }
  }
  function recordGraphifyVersionFailure(candidate, reason) {
    graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify@${candidate}`,
      { outcome: 'failed', nodes: null, existingNodes: null, reason },
      { now: Date.now() });
    persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
  }
  // No tick ever retries a version older than the one installed or offered, so
  // its failure can no longer be acted on: 'upgrade to 0.9.100 did not land'
  // stayed a critical alert through 0.9.101 and 0.9.102. 'noop' keeps the
  // history without raising; the newest version's own failure is untouched.
  function clearSupersededGraphifyFailures(newest) {
    let changed = false;
    for (const [key, h] of Object.entries(graphSyncHealthStore)) {
      const v = key.match(/^graphify@(\d+\.\d+\.\d+)$/)?.[1];
      if (!v || (h?.outcome !== 'failed' && h?.outcome !== 'refused') || compareVersions(v, newest) >= 0) continue;
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, key,
        { outcome: 'noop', nodes: null, existingNodes: null, reason: `superseded by ${newest}; was: ${h.reason ?? h.outcome}` },
        { now: Date.now() });
      changed = true;
    }
    if (changed) persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
  }
  // Roll an unverified graphify version back to `prior` and record why under
  // graphify@<candidate>. Shared by the rebuild-audit failure and R1 (an
  // upgrade that landed a version other than the audited candidate).
  // N4/F1(2): never started once close() has begun; the skip is recorded and
  // the marker stays for the next boot. N3: the rollback's own exit code
  // decides the wording, so a failed uv install is never reported as a
  // rollback. F1(1): the marker is cleared only on a verified (exit 0)
  // rollback; a failed one keeps it so the next tick retries.
  async function rollBackUnverifiedGraphify(prior, candidate, why, detail, detailLabel) {
    if (closingPromise) {
      console.error('graphify version tick: server is closing, skipping the rollback');
      recordGraphifyVersionFailure(candidate, `${why}; rollback SKIPPED (server closing): ${detail}`);
      return;
    }
    const rollback = await uvToolInstallWhenIdle(`graphifyy==${prior}`);
    if (rollback.code === 0) {
      clearPendingGraphifyRollback(); graphifyRolledBack = true;
      if (why === 'rebuild audit failed') writeRejectedGraphify({ ...readRejectedGraphify(), [candidate]: { prior, ts: Date.now() } });
    }
    recordGraphifyVersionFailure(candidate, rollback.code === 0
      ? `${why}, rolled back to ${prior}: ${detail}`
      : `${why} AND rollback to ${prior} failed (exit ${rollback.code}): ${String(rollback.stderr || '').trim().slice(-500)}; ${detailLabel}: ${detail}`);
  }
  // Raised (never thrown past the rebuild loop) when close() has begun, so
  // waitForGraphifyUpdate rethrows it at once instead of treating it as a
  // busy root to retry.
  const GRAPHIFY_UPDATE_SKIPPED_CLOSING = 'skipped: server closing';

  // The rebuild audit of an installed candidate against the node counts
  // taken before its upgrade. Also run on a later boot from the pending
  // marker, so a restart mid-audit (a deploy, 2026-11-03 3:15 PM PT) resumes
  // it instead of rolling back a candidate that may be fine.
  // The OS process list cannot see a rebuild whose launcher was killed at its
  // timeout while the rebuild itself ran on (11-03: the kernel root, held
  // 4:27-4:50 PM PT), so the version tick also waits on the in-process
  // single-flight for its roots, after reserving them so nothing new starts.
  // Up to an hour (the lib default): the kernel rebuild has taken over 20 minutes.
  const waitForAuditRootsFree = (roots) => graphifySingleFlight.waitIdle(roots, { ...graphifyVersionWaitOpts, stop: () => !!closingPromise });

  async function auditUpgradedGraphify({ prior, candidate, auditRoots, before, reservation, resumed = false }) {
    // a root already held by another
    // caller (graphRebuildTick, refreshGraphForWiki, POST /api/graph/
    // rebuild) used to escape as an unrecoverable GraphifyBusyError,
    // skipping the audit/rollback decision entirely for this whole tick
    // -- and the NEXT tick sees installed === latest and never retries,
    // so the upgrade stays permanently unaudited. Waits for the root
    // (bounded) instead; a root still busy past the wait is folded into
    // the same regressions list as a genuine node-count collapse, so it
    // forces the same rollback decision rather than a silent pass.
    const updateFailures = [];
    // never spawn a graphify update once close() has begun -- not
    // at the top of a root's turn, and not on a busy-wait retry either
    // (a plain Error, not GraphifyBusyError, so waitForGraphifyUpdate
    // rethrows it at once). A root skipped this way is folded into
    // updateFailures like any other unverified root, so the audit fails
    // and the rollback-skip below records it and keeps the marker.
    const updateUnlessClosing = (r, o) => (closingPromise
      ? Promise.reject(new Error(GRAPHIFY_UPDATE_SKIPPED_CLOSING))
      : graphifyUpdate(r, { ...o, reservation }));
    for (const root of auditRoots) {
      if (closingPromise) { updateFailures.push({ root, reason: GRAPHIFY_UPDATE_SKIPPED_CLOSING }); continue; }
      try {
        // the RESOLVED result can
        // still name a refusal or failure -- graphify's own collapse
        // guard refuses (exit 1) and RESOLVES rather than throwing
        // (graphify-outcome.js), so only reacting to a thrown error let a
        // refused/failed update present as a clean pass with an
        // unchanged graph.json, auditRebuild's ratio check included.
        // Classified the same way graphRebuildTick/refreshGraphForWiki
        // already do.
        // Waits as long as one update may run (its timeout): the lib's
        // 60 s default lost to the post-deploy kernel rebuild on 2026-11-03
        // and rolled back an upgrade that had landed.
        const run = await waitForGraphifyUpdate(root, updateUnlessClosing, { maxWaitMs: GRAPHIFY_UPDATE_TIMEOUT_MS, ...graphifyVersionWaitOpts, timeout: GRAPHIFY_UPDATE_TIMEOUT_MS });
        const result = classifyGraphifyRun(run);
        if (result.outcome === 'refused' || result.outcome === 'failed') {
          updateFailures.push({ root, reason: `${result.outcome}: ${result.reason}` });
        }
      } catch (e) { updateFailures.push({ root, reason: e.message }); }
    }
    const rebuild = auditRebuildWithFailures(before, graphNodeCounts(auditRoots), updateFailures, { minRatio: cfg.graphifyUpdate.minRatio });
    if (rebuild.ok) {
      // The wiki is BUILT FROM the graph, and its freshness marker is copied
      // from the graph's built_at_commit -- which an upgrade leaves untouched
      // because HEAD did not move. So without this the wiki would keep
      // reporting itself fresh while describing the superseded graph. A
      // producer that changes state owes its consumer a refresh; shipping the
      // rebuild without this line would have been a new instance of exactly
      // the gap this ticket set out to close.
      clearPendingGraphifyRollback();
      const rejected = readRejectedGraphify();
      if (rejected[candidate]) { delete rejected[candidate]; writeRejectedGraphify(rejected); }
      // A 'failed' entry left for this same candidate by an earlier
      // interrupted or rolled-back attempt must not stay a standing alert
      // once the candidate is genuinely audited and adopted.
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify@${candidate}`,
        { outcome: 'updated', nodes: null, existingNodes: null, reason: `rebuild audit passed; adopted ${candidate} (was ${prior})${resumed ? '; audit resumed after a restart' : ''}` },
        { now: Date.now() });
      persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
      clearSupersededGraphifyFailures(candidate);
      runWikiLoop({ reason: 'graph.upgraded', force: true });
    } else {
      const regressionText = rebuild.regressions.map(r => `${r.root} ${r.before}->${r.after}`).join('; ');
      // An audit that reached a verdict drops the audit fields from the
      // marker, so a rollback that fails here is retried as a rollback on
      // the next tick rather than paying another rebuild of every root. One
      // cut short by shutdown keeps them and is resumed: an update killed by
      // the stop reads as an ordinary failure, so closing at all means no verdict.
      if (!closingPromise && !updateFailures.some((f) => f.reason === GRAPHIFY_UPDATE_SKIPPED_CLOSING)) {
        try { writeJsonAtomic(graphifyPendingRollbackFile, { prior, candidate, ts: Date.now(), auditFailed: regressionText }); }
        catch (e) { console.error('graphify version tick: could not mark the audit verdict on the pending-rollback marker:', e?.message ?? e); }
      }
      // same shutdown check as before the upgrade above -- do not
      // start a rollback install after close() has already begun. F1(2):
      // the skip itself goes to health (persisted, so it reaches the alert
      // center), and the pending-rollback marker stays on disk so the next
      // boot's first tick carries the rollback out.
      // Roll back to the version we know worked, then alert. A regression we
      // silently keep is the exact failure this whole ticket is about.
      await rollBackUnverifiedGraphify(prior, candidate, 'rebuild audit failed', regressionText, 'original regressions');
    }
  }

  async function graphifyVersionTick() {
    if (!planVersionTick({
      enabled: cfg.graphifyUpdate.enabled, running: graphifyVersionRunning,
      lastRunAt: graphifyVersionLastRunAt, now: Date.now(),
      minIntervalMs: cfg.graphifyUpdate.tickMs,
    })) return;
    graphifyVersionRunning = true;
    graphifyRolledBack = false;
    try {
      const installed = await graphifyVersionCheck();
      // an earlier tick's upgrade whose audit never finished (or
      // whose rollback was skipped or failed). Acted on before anything else,
      // in particular before the compareVersions early return below.
      const pending = readPendingGraphifyRollback();
      if (pending?.unreadable) {
        // halt here (logged and in health) rather than run on
        // into the installed === latest early return, which would silently
        // keep a possibly unaudited version installed.
        console.error(`graphify version tick: pending-rollback marker is unreadable (${pending.unreadable}); version audit paused`);
        graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, 'graphify@pending-rollback',
          { outcome: 'failed', nodes: null, existingNodes: null,
            reason: `pending-rollback marker unreadable (${pending.unreadable}); version audit paused until ${graphifyPendingRollbackFile} is readable or removed` },
          { now: Date.now() });
        persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
        return;
      }
      // R2 (post-breaker residual): the marker read cleanly (present or
      // absent), so a standing 'failed' for it is over. 'noop' is the
      // non-alerting outcome (alert-sources.js raises only refused/failed):
      // nothing changed, the marker just stopped being unreadable. Written
      // only when that key's last outcome was 'failed', so a healthy tick
      // never creates it.
      if (graphSyncHealthStore['graphify@pending-rollback']?.outcome === 'failed') {
        graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, 'graphify@pending-rollback',
          { outcome: 'noop', nodes: null, existingNodes: null, reason: 'pending-rollback marker readable again; version audit resumed' },
          { now: Date.now() });
        persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
      }
      if (pending) {
        if (!installed) return; // cannot tell what is installed: keep the marker, try next tick
        const pinned = cfg.graphifyUpdate.pinned;
        if (compareVersions(installed, pending.prior) === 0) {
          // Already back on the version we knew worked (the upgrade never
          // took, or a rollback landed after the marker was written): stale.
          clearPendingGraphifyRollback();
        } else if (pinned && compareVersions(installed, pending.candidate) === 0 && compareVersions(installed, pinned) === 0) {
          // The unverified candidate is the version config records as known
          // good (the 2026-10-23 half-landed 0.9.95 upgrade): rolling it back
          // would undo a verified version, so the marker is stale.
          clearPendingGraphifyRollback();
          graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify@${pending.candidate}`,
            { outcome: 'updated', nodes: null, existingNodes: null,
              reason: `installed ${installed} is the known-good version pinned in config; pending rollback to ${pending.prior} cleared` },
            { now: Date.now() });
          persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
        } else if (compareVersions(installed, pending.candidate) !== 0) {
          // neither the prior nor the unverified candidate
          // (e.g. the operator installed another version by hand). Not ours
          // to undo: clear the marker, record what was found, and let the
          // normal audit flow below take it from here.
          clearPendingGraphifyRollback();
          recordGraphifyVersionFailure(pending.candidate,
            `pending rollback to ${pending.prior} abandoned: installed is ${installed}, neither the prior nor the unverified candidate ${pending.candidate}; left as found`);
        } else {
          if (closingPromise) { console.error('graphify version tick: server is closing, skipping the pending rollback'); return; }
          // A marker that carries the pre-upgrade counts resumes the audit;
          // an older marker without them can only be rolled back.
          if (Array.isArray(pending.roots) && pending.before && typeof pending.before === 'object') {
            const reservation = graphifySingleFlight.reserve(pending.roots);
            try {
              // Busy is not a regression: keep the marker (and whatever health
              // already says about the candidate) for the next boot.
              const free = await waitForAuditRootsFree(pending.roots);
              if (closingPromise) { console.error('graphify version tick: server is closing, skipping the resumed audit'); return; }
              if (!free.idle) { console.error(`graphify version tick: resumed audit of ${pending.candidate} deferred, still updating: ${free.busy.join(', ')}`); return; }
              await auditUpgradedGraphify({ prior: pending.prior, candidate: pending.candidate, auditRoots: pending.roots, before: pending.before, reservation: reservation.token, resumed: true });
            } finally { reservation.release(); }
            return;
          }
          const rollback = await uvToolInstallWhenIdle(`graphifyy==${pending.prior}`);
          if (rollback.code === 0) {
            clearPendingGraphifyRollback();
            graphifyRolledBack = true;
            recordGraphifyVersionFailure(pending.candidate,
              `upgrade to ${pending.candidate} was never verified (rebuild audit interrupted or its rollback not completed); rolled back to ${pending.prior} on a later tick; the candidate is re-audited from scratch next time`);
          } else {
            recordGraphifyVersionFailure(pending.candidate,
              `pending rollback to ${pending.prior} failed (exit ${rollback.code}): ${String(rollback.stderr || '').trim().slice(-500)}; ${installed} stays installed unverified, retried next tick`);
          }
          return;
        }
      }
      const rejectedAs = installed && !pending ? readRejectedGraphify()[installed] : null;
      if (rejectedAs && typeof rejectedAs.prior === 'string' && compareVersions(rejectedAs.prior, installed) !== 0) {
        if (closingPromise) { console.error('graphify version tick: server is closing, skipping the rejected-version rollback'); return; }
        const rollback = await uvToolInstallWhenIdle(`graphifyy==${rejectedAs.prior}`);
        if (rollback.code === 0) graphifyRolledBack = true;
        recordGraphifyVersionFailure(installed, rollback.code === 0
          ? `${installed} was reinstalled outside the version tick (the setup wizard installs @latest) after its rebuild audit rejected it; rolled back to ${rejectedAs.prior}; the next tick audits it again from scratch`
          : `${installed} was reinstalled outside the version tick after its rebuild audit rejected it, and the rollback to ${rejectedAs.prior} failed (exit ${rollback.code}): ${String(rollback.stderr || '').trim().slice(-500)}; retried next tick`);
        return;
      }
      const latest = await graphifyVersionLatest();
      // Not on a tick that read a marker: what it just recorded stays visible.
      if (installed && !pending) clearSupersededGraphifyFailures(latest && compareVersions(latest, installed) > 0 ? latest : installed);
      if (!installed || !latest || compareVersions(installed, latest) >= 0) return;

      // Audit the CANDIDATE without installing it: uvx runs it in a throwaway env.
      const help = (await graphifyVersionRunCmd('uvx', ['--from', `graphifyy==${latest}`, 'graphify', '--help'])).stdout;
      const surface = auditSurface(help, cfg.graphifyUpdate.requiredCommands);
      if (!surface.ok) {
        graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify@${latest}`,
          { outcome: 'failed', nodes: null, existingNodes: null, reason: `surface audit failed, missing: ${surface.missing.join(', ')}` },
          { now: Date.now() });
        persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
        return;
      }
      if (!cfg.graphifyUpdate.autoUpgrade) {
        console.error(`graphify ${latest} available (surface audit passed); autoUpgrade is off`);
        return;
      }
      // close() can land while this
      // tick is mid-audit; an upgrade (or, below, a rollback) started AFTER
      // shutdown has already begun can keep the process alive past close()
      // and mutate the operator's installed graphify version during exit.
      // closingPromise is truthy from the exact moment close() is called
      // (before its own async body even starts), so this is the same
      // "are we shutting down" signal close() itself uses.
      if (closingPromise) { console.error('graphify version tick: server is closing, skipping the upgrade'); return; }
      const auditRoots = await scopedGraphRoots();
      const reservation = graphifySingleFlight.reserve(auditRoots);
      try {
        await upgradeAndAuditGraphify({ installed, latest, auditRoots, reservation: reservation.token });
      } finally { reservation.release(); }
    } catch (err) {
      console.error('graphify version tick failed:', err?.message ?? err);
    } finally {
      // Every exit path, so an upgrade, a rollback or a hand install all
      // bring the skill copies in step within one tick.
      try { await syncGraphifySkills({ allowDowngrade: graphifyRolledBack }); }
      catch (err) { console.error('graphify skill refresh failed:', err?.message ?? err); }
      graphifyVersionLastRunAt = Date.now();
      graphifyVersionRunning = false;
    }
  }

  async function upgradeAndAuditGraphify({ installed, latest, auditRoots, reservation }) {
    // Deferred, not failed: nothing was touched, so no marker is written
    // and the next tick tries again. 'noop' keeps it out of the alert
    // center; `consecutive` shows a launcher that never exits. A standing
    // failure for the same version is not overwritten by a mere deferral.
    const deferUpgrade = (why) => {
      console.error(`graphify version tick: upgrade to ${latest} deferred, ${why}`);
      const prev = graphSyncHealthStore[`graphify@${latest}`]?.outcome;
      if (prev === 'failed' || prev === 'refused') return;
      graphSyncHealthStore = recordSyncOutcome(graphSyncHealthStore, `graphify@${latest}`,
        { outcome: 'noop', nodes: null, existingNodes: null, reason: `upgrade to ${latest} deferred to the next tick: ${why}` },
        { now: Date.now() });
      persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
    };
    const free = await waitForAuditRootsFree(auditRoots);
    if (closingPromise) { console.error('graphify version tick: server is closing, skipping the upgrade'); return; }
    if (!free.idle) { deferUpgrade(`graph update still running on ${free.busy.join(', ')}`); return; }
    const idle = await waitForGraphifyIdle();
    if (!idle.idle) { deferUpgrade(`graphify still running (${describeGraphifyProcesses(idle.processes)})`); return; }
    if (closingPromise) { console.error('graphify version tick: server is closing, skipping the upgrade'); return; }

    const before = graphNodeCounts(auditRoots);
    // on disk before the upgrade, so no interruption from here on
    // can leave the candidate installed without a record of what to roll
    // back to. A marker that cannot be written throws to the outer catch:
    // the upgrade is skipped rather than run unrecoverable.
    writeJsonAtomic(graphifyPendingRollbackFile, { prior: installed, candidate: latest, ts: Date.now(), roots: auditRoots, before });
    // Installs the audited candidate by exact pin. `uv tool upgrade` honours
    // the pin a rollback (`uv tool install graphifyy==<prior>`) leaves in the
    // tool receipt, so after one rollback it exited 0 and changed nothing on
    // every tick (0.9.99 stuck from 2026-10-31 to 11-03, 23 ticks).
    const upgrade = await graphifyVersionRunCmd('uv', ['tool', 'install', '--upgrade', `graphifyy==${latest}`]);
    // the upgrade's result used to be unchecked. On
    // Windows a running graphify locks the tool exe, uv exits 1, and the
    // rebuild below then ran on the OLD version, passed its audit, and
    // recorded "adopted <latest>" over a real 'failed' alert. Require exit
    // 0 AND a re-read installed version equal to the candidate.
    const upgraded = upgrade.code === 0 ? await graphifyVersionCheck() : null;
    if (upgrade.code !== 0 || !upgraded || compareVersions(upgraded, latest) !== 0) {
      const detail = upgrade.code !== 0
        ? `exit ${upgrade.code} ${String(upgrade.stderr || '').trim().slice(-500)}`
        : `exit 0, installed is ${upgraded ?? 'unknown'}`;
      const nowInstalled = upgrade.code === 0 ? upgraded : await graphifyVersionCheck();
      // R1 (post-breaker residual): an outside install racing this tick can
      // land a THIRD version the surface audit never saw. Roll it back now
      // (same command, shutdown check and recording as the audit-failure rollback) so the next tick
      // audits the true latest normally, rather than leaving it to a marker
      // the next tick would abandon unaudited.
      if (upgrade.code === 0 && nowInstalled
          && compareVersions(nowInstalled, installed) !== 0 && compareVersions(nowInstalled, latest) !== 0) {
        await rollBackUnverifiedGraphify(installed, latest, `upgrade to ${latest} did not land`,
          `exit 0, installed is ${nowInstalled} (never audited)`, 'found');
        return;
      }
      recordGraphifyVersionFailure(latest, `upgrade to ${latest} did not land: ${detail}`);
      // Still on the prior version: nothing to roll back, so the marker
      // goes. If the version cannot be read, the marker stays and the next
      // tick decides from it, so a version that changed is never left
      // unrecorded.
      if (nowInstalled && compareVersions(nowInstalled, installed) === 0) clearPendingGraphifyRollback();
      return;
    }
    await auditUpgradedGraphify({ prior: installed, candidate: latest, auditRoots, before, reservation });
  }

  // Registered with K3; builds into <stateDir>/wiki, never the repo. Runs in
  // the kernel service by default (cfg.wikiLoop.enabled null -> isServiceMode,
  // server/lib/kernel/service-mode.js, K Task 7). The 2.0 shadow instance is
  // never the service, so for it wikiLoop stays off unless config.json sets
  // `wikiLoop.enabled: true` explicitly.
  // An installed bundle (a readable bundle.json at the kernel root) carries the
  // shipped wiki snapshot and has nothing for the loop to build from, so the
  // loop stays off there unless config.json turns it on.
  const wikiLoopEnabled = wikiLoopDefault({ configured: cfg.wikiLoop.enabled, serviceMode: isServiceMode(env), installedBundle: isInstalledBundle(REPO_ROOT) });
  async function refreshGraphForWiki(root) {
    const headBefore = await readHeadCommit(root);
    const run = await runGraphify(['update', root]);
    const result = await recordGraphifyRun(root, run, headBefore);
    persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
    if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(`graph-refresh ${result.outcome}: ${result.reason}`);
  }
  // a mistyped wikiLoop.modelTier used to index
  // getModelConfig(cfg).models at an unknown key, resolving wikiModel to
  // undefined -- which spawnWikiBuild then omits as --model entirely, so
  // wiki-build-cli.mjs silently falls back to ITS OWN hard-coded 'haiku'.
  // No error, no log, just a quietly different model than configured.
  // Validate against the known tiers and fall back to 'fast' VISIBLY
  // (a logged warning) instead, so the misconfiguration is never silent.
  const wikiModelTiers = getModelConfig(cfg).models;
  let wikiModelTier = cfg.wikiLoop.modelTier;
  if (!Object.hasOwn(wikiModelTiers, wikiModelTier)) {
    console.error(`[wiki-loop] unknown wikiLoop.modelTier ${JSON.stringify(wikiModelTier)}; falling back to 'fast' (known tiers: ${Object.keys(wikiModelTiers).join(', ')})`);
    wikiModelTier = 'fast';
  }
  const wikiModel = cfg.wikiLoop.model ?? wikiModelTiers[wikiModelTier];
  // a retention error (an old build
  // directory that failed to delete) is non-fatal -- the run still records
  // 'done' -- so it must reach the same place an operator already looks (GET
  // /api/wiki's loop view), for a scheduled run exactly as much as a
  // manually queued one, AND it must clear once a later prune succeeds --
  // otherwise a resolved problem is reported forever. wiki-loop.js's
  // `onRetention` dep fires after every prune attempt (pre-build and
  // post-publish), always with the array pruneWikiBuilds/publishWikiBuild
  // produced, empty when nothing failed -- a structured signal, not a parse
  // of `log`'s message text, so a wording change there cannot silently break
  // this.
  let wikiLoopLastRetentionWarning = null;
  const wikiLoopHandle = wikiLoopEnabled
    ? registerWikiLoop(loopRegistry, {
      repoRoot: REPO_ROOT, stateDir: P.stateDir, webDir: WEB_DIR,
      cfg: { ...cfg.wikiLoop, model: wikiModel },
      // The real obligations store (K4, server/lib/kernel/obligations.js),
      // the SAME instance the loop registry's own onRegister/onOk adapter and
      // the obligation-sweeper use -- opened once at boot, above. A null
      // store (node:sqlite unavailable, or open failed) is passed through
      // as-is: wiki-loop.js already fails open on it (it logs once and skips
      // the freshness obligation).
      obligations: obligationStore,
      readHead: wikiLoopOverrides.readHead ?? readHeadAsync,
      readGraph: wikiLoopOverrides.readGraph ?? readGraphCommit,
      refreshGraph: wikiLoopOverrides.refreshGraph ?? refreshGraphForWiki,
      // defense in depth, belt-and-suspenders
      // on top of every test already injecting its own runBuild override --
      // the DEFAULT itself refuses to spawn a real build while isTestProcess()
      // is true, with a named reason, rather than relying solely on every
      // caller (including a future one) remembering to override it. A real
      // service-mode test booted exactly this default once with no override
      // at all and it spawned a genuine child build.
      runBuild: wikiLoopOverrides.runBuild
        ?? (isTestProcess({ env })
          ? async () => { throw new Error('wiki build refused: isTestProcess() is true and no runBuild override was given'); }
          : ((o) => spawnWikiBuild({ cliPath: path.join(REPO_ROOT, 'scripts', 'wiki-build-cli.mjs'), ...o }))),
      // Test-only: lets api-wiki-loop.test.js force a retention error
      // deterministically. Production never sets these, so pruneWikiBuilds/
      // publishWikiBuild keep using their own fs.rmSync/fs.readdirSync defaults.
      ...(wikiLoopOverrides.rm ? { rm: wikiLoopOverrides.rm } : {}),
      ...(wikiLoopOverrides.readdir ? { readdir: wikiLoopOverrides.readdir } : {}),
      log: (m) => console.error('[wiki-loop]', m),
      onRetention: (errors) => {
        wikiLoopLastRetentionWarning = errors.length
          ? { ts: Date.now(), message: `${errors.length} old build(s) not removed: ${errors[0]}`, errors }
          : null;
      },
    })
    : null;
  if (!wikiLoopHandle) console.log('wiki loop: not registered here (it runs in the kernel service; set config.json wikiLoop.enabled to run it in this server)');
  function runWikiLoop(payload) {
    if (!wikiLoopHandle) return false;
    Promise.resolve(wikiLoopHandle.runNow(payload)).then(null, (e) => {
      try { loopRegistry.report('wiki', { outcome: 'failed', reason: `run-now: ${e?.message ?? e}` }); }
      catch (e2) { console.error(`wiki loop: runNow failed (${e?.message ?? e}) and report failed (${e2.message})`); }
    });
    return true;
  }
  function wikiLoopView() {
    if (!wikiLoopHandle) return null;
    const r = loopRegistry.get('wiki');
    if (!r) return null;
    const { lastOutcome, lastReason, lastRunTs, lastOkTs, consecutiveFailures, nextRunTs } = r;
    // S2/S3 surfacing: modelErrors and degraded reach
    // last-verify.json (wiki-loop.js's checker), but had no path from there
    // to the one place an operator actually looks, GET /api/wiki's loop
    // field. Best-effort read of the loop's own file: a missing or
    // unreadable last-verify.json is a display-only no-op (nothing has run
    // yet, or the file predates this field), never a reason to fail the
    // whole GET /api/wiki response.
    let modelErrors = [];
    let degraded = [];
    try {
      const lastVerify = JSON.parse(fs.readFileSync(wikiPaths(P.stateDir).lastVerify, 'utf8'));
      modelErrors = Array.isArray(lastVerify.modelErrors) ? lastVerify.modelErrors : [];
      degraded = Array.isArray(lastVerify.degraded) ? lastVerify.degraded : [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`wiki-loop view: last-verify.json unreadable: ${e.message}`);
    }
    return { lastOutcome, lastReason, lastRunTs, lastOkTs, consecutiveFailures, nextRunTs, retentionWarning: wikiLoopLastRetentionWarning, modelErrors, degraded };
  }

  // Operator opt-out (config.json `qaTrends.enabled`, default true - see the
  // cfg defaults above). While enabled, a timer (armed further below, after the
  // server is listening) calls qaTrendsTick every `checkMs`: backfills the
  // store from the last ~30 completed CI runs the first time it's empty, then
  // records the latest run if it's new (deduped by runId). `qaTrendsTickRunning`
  // is a single-flight guard so a slow backfill is never stacked by the next
  // tick. qaTrendsTick itself is already fully fail-open (see qa-trends-store.js)
  // - this wrapper's own try/catch is redundant-but-cheap insurance so a bug in
  // that module can never take the interval down.
  let qaTrendsTickRunning = false;
  // glmps-2-0-155: the sampler's gh reads go through runGh (the desktop shell
  // in service mode, where the service account has no gh sign-in), so each
  // names the repo, read once from the checkout's origin remote.
  let qaTrendsRepo;
  async function qaGhOpts() {
    if (!qaTrendsRepo) {
      const r = await runAsync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, timeout: 5000 });
      qaTrendsRepo = r.status === 0 ? repoFromRemote(r.stdout) : null;
    }
    return { cwd: REPO_ROOT, repo: qaTrendsRepo, gh: runGh };
  }
  async function qaTrendsTickFn() {
    if (qaTrendsTickRunning) return;
    qaTrendsTickRunning = true;
    try { await qaTrendsTick(P.stateDir, await qaGhOpts()); }
    catch { /* fail-open */ }
    finally { qaTrendsTickRunning = false; }
  }

  // glmps-152: the vitals sampler tick and the GET /api/state handler both need
  // the same board + vitals, and each used to rebuild the whole input chain
  // (sessionSummaries + workPhase + gitStatusFor + countFollowups + adapterHealth
  // + buildBoard + buildVitals) independently. Two copies of one input pipeline
  // is a drift risk with no upside: a change to how phase or git status is
  // gathered had to be made twice, or the sampler's numbers would quietly stop
  // matching what the Stage Board row shows.
  //
  // This is composition, not caching: it recomputes per call, exactly as both
  // call sites did before. /api/state deliberately stays compute-on-read.
  function composeBoard(now) {
    const summaries = sessionSummaries();
    const phaseBySession = new Map();
    const gitBySession = new Map();
    for (const s of summaries) {
      if (!s.live) continue;
      try { phaseBySession.set(s.id, workPhase(eventLog.get(s.id) ?? [])); } catch {}
      if (s.cwd) {
        // A client session's cwd is a path on the client: its git status is the client's own summary, never git on this disk.
        const g = s.clientId ? tapGit?.statusForCwd(s.clientId, s.cwd) : gitStatusFor(s.cwd);
        if (g) gitBySession.set(s.id, g);
      }
    }
    let followupsBySession = new Map();
    try { followupsBySession = countFollowups(backlogStore.listFrom(P.stateDir)); } catch {}
    // Board rows are the live sessions only (the "who's working right now"
    // surface); historical sessions live in /api/state history, not the
    // board. glmps-8b: also excludes internal (GLMPS's
    // own worker spawns, e.g. the memory distiller's headless claude -p
    // calls) from the live COUNT this feeds (board.rows / board.vitals.active)
    // -- those are not "who's working right now" in any user-facing sense.
    // Tag, don't hide: `summaries` itself (returned in /api/state's own
    // `sessions` field) still carries every internal row, just stamped.
    const liveSummaries = summaries.filter(s => s.live && !s.internal);
    const board = buildBoard(liveSummaries, { now, phaseBySession, gitBySession, followupsBySession });
    const health = adapterHealth();
    // buildVitals gets ALL summaries, not just the live ones: it applies its own
    // liveness filter, and the stalled vital reads lastTs off the raw rows.
    board.vitals = buildVitals({ rows: board.rows, sessions: summaries, adapterHealth: health, now });
    return { summaries, board, health };
  }

  // docs/superpowers/specs/2026-07-22-vitals-trends-design.md, Step 2. Every
  // `vitalsTrends.tickMs` (armed further below, after the server is
  // listening), composes one point and appends it via appendVitalsPoint.
  // Every producer below is wrapped in its OWN try/catch so one failing
  // producer contributes `null` for its field only, never nulls out the
  // others or aborts the tick (the null-discipline rule this whole feature
  // exists to enforce -- see vitals-trends-store.js's header comment).
  // Async only, no execFileSync anywhere in this path, per this repo's
  // node-event-loop-git-subprocess-guard lesson. vitalsTrendsTickRunning is
  // the same single-flight guard as qaTrendsTickRunning immediately above.
  let vitalsTrendsTickRunning = false;
  // `now` is injectable (default Date.now(), same convention as readBudget's
  // own `now` param) so tests can drive decideAlertsSource's freshness/floor
  // boundaries deterministically instead of waiting out ALERTS_MAX_STALE_MS
  // in real time.
  async function vitalsTrendsTickFn(now = Date.now()) {
    if (vitalsTrendsTickRunning) return;
    vitalsTrendsTickRunning = true;
    try {
      // board.vitals inputs come from composeBoard(), the SAME composition the
      // GET /api/state handler uses, so these counts stay byte-identical to what
      // the Stage Board row shows (glmps-152 -- this used to be a second copy of
      // the whole input chain here).
      let active = null, uncommitted = null, dirtyFiles = null, followups = null;
      let atGate = null, stalled = null, degradedAdapters = null;
      try {
        const { board } = composeBoard(now);
        const vitals = board.vitals;
        active = vitals.active.count;
        uncommitted = vitals.uncommitted.count;
        dirtyFiles = vitals.uncommitted.dirtyFiles;
        followups = vitals.followups.count;
        atGate = vitals.gate.count;
        stalled = vitals.stalled.count;
        degradedAdapters = vitals.capture.degraded;
      } catch { /* fail-open: these seven fields stay null */ }

      // Same 60s-cached read /api/budget serves; a failed/unauthed read
      // already resolves to usage:null rather than throwing, so `?? null`
      // covers that without needing its own try/catch, but one is kept for
      // defense against a future change to readBudget's own contract.
      let budgetPct = null;
      try {
        const b = await readCombinedBudget();
        budgetPct = b?.usage?.fiveHour?.usedPercent ?? null;
      } catch { /* fail-open */ }

      // alerts: NEVER call collectCurrentAlerts() directly on this cadence
      // (measured 1.3-1.8s of synchronous event-loop-blocking scan on the
      // live server -- the node-event-loop-git-subprocess-guard lesson,
      // applied to a sync scan instead of execFileSync). decideAlertsSource
      // (pure, vitals-trends-store.js) decides reuse/recompute/null from the
      // shared alertCountCache (fed by GET /api/alerts on every poll) and
      // alertRecomputeGate (this tick's own recompute throttle, at most once
      // per ALERTS_MAX_STALE_MS). Only the 'recompute' branch ever calls
      // collectCurrentAlerts(); the gate is consumed BEFORE the call so a
      // throwing recompute still throttles the next retry.
      let alerts = null;
      const alertsDecision = decideAlertsSource(alertCountCache, alertRecomputeGate, now, ALERTS_MAX_STALE_MS);
      if (alertsDecision.action === 'reuse') {
        alerts = alertsDecision.value;
      } else if (alertsDecision.action === 'recompute') {
        alertRecomputeGate = { ts: now };
        try {
          const stamped = applyAcks(collectCurrentAlerts(), loadAcks(P.alertAcksFile));
          const count = stamped.filter(a => !a.acknowledged).length;
          alertCountCache = { value: count, ts: now };
          alerts = count;
        } catch { /* fail-open: alerts stays null for this point; gate is already consumed above */ }
      } // action === 'null': neither fresh nor time to refresh -- alerts stays null, never a stale carry-forward or a substituted 0

      // Same status filter GET /api/backlog?status=queued applies.
      let queued = null;
      try {
        queued = backlogStore.listFrom(P.stateDir, { status: 'queued' }).length;
      } catch { /* fail-open */ }

      const point = sampleVitals({
        ts: now, active, uncommitted, dirtyFiles, followups, atGate,
        stalled, degradedAdapters, budgetPct, alerts, queued,
      });
      appendVitalsPoint(P.stateDir, point);
    } catch {
      // fail-open -- a scheduled tick must never crash the server
    } finally {
      vitalsTrendsTickRunning = false;
    }
  }

  // glmps-106 item 1 (registration-cost fix): these used to run INSIDE the
  // per-request http.createServer callback, immediately before the
  // matchRoute dispatcher, so the (idempotent) re-registration always
  // preceded dispatch on every single request - 11 registerRoute() calls
  // (a Map .set() each) on every request, including ones that never even
  // matched a registered route. That per-request cost is why the ordering
  // comment used to live down there; it no longer applies because
  // registration now happens exactly ONCE, here, at server startup, before
  // the server ever accepts a request - so the registry is populated before
  // the very first request (including a fresh cold start) without needing
  // per-request re-registration to guarantee it.
  //
  // The blocker that kept this inline before: every handler called the
  // per-request `send` closure (defined inside the http.createServer
  // callback, closed over that request's `res`). Handlers now receive
  // `send` as part of the dispatch context object instead (matchRoute's
  // call site below builds it fresh per request from that request's `res`
  // and passes it through) - same `send(code, obj)` call shape inside every
  // handler body, just sourced from the third param instead of an outer
  // closure. req/res are still passed positionally too, for handlers (like
  // the steer route) that need `req` directly (e.g. readBody(req)).
  // P/index/sessionSummaries/readBody etc. stay closed over startServer's
  // own scope exactly as before - none of those are per-request.
  // Learning integrity, reviews and autonomy telemetry.
  // Registered through the route registry rather than the legacy if-chain.

  // The commit state a lesson was derived from. Null-safe: a repo we cannot
  // resolve yields no refs, which honestly means "outside the revert sweep's
  // reach" rather than a guessed sha that could invalidate the wrong lesson.
  function refsForRepoPath(repoPath) {
    const sha = headRef(repoPath);
    return sha ? [sha] : [];
  }

  // Everything the reconciliation checks need, assembled from the live stores.
  function reconciliationContext(now = Date.now()) {
    const allSpine = readSpineEvents(P.stateDir, {});
    return {
      stateDir: P.stateDir,
      now,
      gateRuns: gateRunsFromSpine(allSpine),
      orphanedArtifacts: orphanedArtifactsFromSpine(allSpine, now),
      lessons: lessonsForIntegrity(
        lessonsCurrent(readLessonRows(P.stateDir, {})).values(), allSpine, (id) => isPromoted(P.stateDir, id),
      ),
      config: reconciliationConfig(cfg),
    };
  }

  // Read-only integrity: a GET must never emit integrity events, or every dashboard
  // poll would append to the spine. runReconciliation only emits when it is
  // handed a stateDir, so this deliberately withholds it. The nightly timer
  // below is the one caller that does emit.
  // The drift findings the alert center shows (handoff B5). Deliberately reads
  // the EMITTED reconciliation.integrity_finding events rather than re-running the
  // checks: the nightly tick is the single writer of those events, so alerts
  // should reflect what it recorded, and /api/alerts is polled - re-running
  // every check (which reads the whole spine) on each poll would put that scan
  // on the request path, the exact shape a previous perf fix removed here.
  //
  // Windowed, because an alert for a drift finding from two months ago is
  // noise, and the panel dedupes by title so an unresolved finding re-emitted
  // each night stays one ackable alert rather than thirty.
  // The merged agent-authored changes autonomy telemetry counts. Today that is
  // nightly-run PRs and nothing else, which is a real limitation and is stated
  // as one in docs/platform-autonomy.md: ordinary queue-runner delivery has no
  // durable "this was merged" record to read, and a denominator built from a
  // proxy would be worse than an empty one, because an empty one is visibly
  // empty while a wrong one looks like data.
  //
  // Factored out of GET /api/autonomy so the nightly graduation sweep and the
  // route cannot drift apart on what a "merge" is.
  function nightlyMerges() {
    return readSpineEvents(P.stateDir, { kind: SPINE_KINDS.RUN_COMPLETED })
      .flatMap((e) => (e.payload?.prs ?? []).map((url) => ({ ref: url, taskClass: 'nightly', ts: e.ts })));
  }

  function recentIntegrity(now = Date.now(), windowDays = 14) {
    try {
      const since = now - windowDays * 86400000;
      const seen = new Set();
      const out = [];
      for (const e of readSpineEvents(P.stateDir, { kind: SPINE_KINDS.RECONCILIATION_INTEGRITY, since })) {
        const p = e?.payload;
        if (!p || !p.check_name) continue;
        const key = `${p.check_name}::${p.desk ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
      return out;
    } catch { return []; /* fail-open: integrity is a diagnostic, never a gate */ }
  }

  function integrityReadOnly(now) {
    try {
      return runReconciliation({ ...reconciliationContext(now), stateDir: null });
    } catch {
      return [];
    }
  }

  registerLoopsRoutes(registerRoute, { loopRegistry, GRAPH_CATALOG, readBody });
  // Card glmps-2-0-162: every recorded card run, to compare models across cards.
  registerRoute({
    method: 'GET', pattern: '/api/model-runs',
    handle: (req, res, { send }) => {
      const project = new URL(req.url, 'http://127.0.0.1').searchParams.get('project') || null;
      const rows = modelRunRows(backlogStore.load(P.stateDir).items, { project });
      return send(200, { rows, byVendor: modelRunSummary(rows) });
    },
  });

  // Task 12b: the launch broker's HTTP surface. A service-mode kernel has no
  // desktop of its own; the desktop shell (running in the operator's own
  // session - the only process this review allows to execute a queued
  // command) polls GET for pending work, claims one each with POST
  // .../claim (losing the race answers 409, never a silent double-open),
  // and reports back with POST .../result. These routes pass through the
  // server's existing checkAccess guard exactly like every other route (it
  // runs once, before the registered-route dispatcher, at the top of the
  // request handler) - nothing here is a separate, unguarded surface.
  //
  // SECURITY: every field read back from a claim/result body is untrusted
  // input, same as any other request body. It is never used to build the
  // NEXT command/cwd (those came from this server's own validated recipes
  // at enqueue time, never from a request) - only pid/error bookkeeping on
  // a record that is ALREADY pending or claimed.
  registerRoute({
    method: 'GET', pattern: '/api/launches',
    handle: (req, res, { send }) => {
      // A paired client's tap polls with its own token and sees only the records
      // aimed at it; the shell's proof and its records are a separate world.
      const client = launchClient(req);
      // claudeCmd joins the list because a client resume is built from it, and it
      // need not be one of the configured terminal commands.
      if (client) return send(200, { pending: launchBroker.pending({ client: client.id }), allowedCommands: [...new Set([...(cfg.terminals || []).map((t) => t?.command), claudeCmd])].filter((c) => typeof c === 'string' && c) });
      // proves this is actually talking to ITS OWN
      // kernel, not another local account's process that happens to be
      // listening on the same loopback port while the real service is
      // down - checkAccess's own loopback trust is not enough here. GET
      // carries no body, so the proof is over the empty string.
      if (!verifyLaunchProof(req, '')) return send(401, { error: 'unauthorized' });
      shellPolledAt = Date.now();
      // The one defined contract today (the shell runner's own poll):
      // ?state=pending. launchBroker exposes no other list method, so any
      // other or missing query answers the same thing; GET .../:id (via
      // claim/result's own response, or a future route) is how a caller
      // reads a single claimed/done record.
      //
      // the terminal-command allowlist is folded into
      // this SAME authenticated response (it used to be a separate,
      // unauthenticated /api/config fetch) - an impostor serving a forged
      // allowlist alongside forged records is exactly the attack a
      // separate, unauthenticated source for either half would still
      // allow.
      const allowedCommands = (cfg.terminals || []).map((t) => t?.command).filter((c) => typeof c === 'string' && c);
      const openEditor = resolveOpenEditor();
      const editor = openEditor ? { command: openEditor.command, args: cfg.openInEditorArgs } : null;
      return sendLaunchAuthed(req, res, 200, { pending: launchBroker.pending(), allowedCommands, cancel: launchBroker.cancelRequested(), editor });
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/launches/:id/claim',
    handle: async (req, res, { params, send }) => {
      const client = launchClient(req);
      const rawBody = (await readBody(req, { maxBytes: 4096 })) || '';
      if (!client && !verifyLaunchProof(req, rawBody)) return send(401, { error: 'unauthorized' });
      let body = {};
      try { body = JSON.parse(rawBody || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const by = typeof body.by === 'string' && body.by ? body.by.slice(0, 200) : client ? `tap:${client.id}` : 'shell';
      if (client) {
        const got = launchBroker.claim(params.id, by, { client: client.id });
        if (!got) return send(409, { error: 'already claimed, done, failed, unknown, or not aimed at this client' });
        broadcastLaunch(got.id, got.state);
        return send(200, got);
      }
      // Fix round 1, I4(B): a pending record never expires on its own. A
      // runner job relaunched under a NEW launchId (the operator retried
      // it, or the runner's own reconcile requeued it) orphans this OLD
      // one - the ledger entry for its job no longer points at it. Opening
      // it now would put a second terminal into whatever that job's
      // worktree holds today. Checked BEFORE claiming (never consumes the
      // record): only origin 'runner' has a ledger concept to go stale
      // against at all.
      const pre = launchBroker.get(params.id);
      // Fix round 2, R2-2 correction: only a still-PENDING record can be
      // stale in this sense - once fail() (below) has already moved it to
      // 'failed', a repeat claim attempt must fall through to the
      // ordinary launchBroker.claim() (-> null -> the generic 409), not
      // re-run the ledger lookup and report 'stale' a second time for a
      // record that is already resolved.
      if (pre?.origin === 'runner' && pre.state === 'pending') {
        try {
          // Post-breaker residual N1: loadLedger's {} on a read error made
          // a LIVE launch look stale here. A read error is named and the
          // ordinary claim below proceeds; staleness is only judged on a
          // ledger that was actually read.
          const { ledger, error: ledgerError } = runnerStore.readLedger(P.stateDir);
          if (ledgerError) reportMiss('launch-claim-stale-check', `${params.id}: stale check skipped, runner ledger unreadable (${ledgerError})`);
          const stillLive = !ledger || Object.values(ledger).some((e) => e.launchId === params.id);
          if (!stillLive) {
            const staleReason = 'stale: runner job relaunched under a different launchId';
            // a pending record never expires on its
            // own - left pending here, the shell would retry the SAME
            // claim every poll and, after 120s, the launch-queue loop
            // would falsely report "the desktop shell is not running".
            // Moved to failed instead, so the next staleness check is
            // clean.
            const failed = launchBroker.fail(params.id, staleReason);
            if (failed) {
              broadcastLaunch(failed.id, failed.state);
              appendEvent(P.stateDir, { kind: 'launch.failed', lane: failed.origin, label: String(failed.command).slice(0, 120), path: failed.cwd, ts: Date.now(), sessionId: null });
            }
            return send(409, { error: 'stale', reason: 'runner job relaunched under a different launchId' });
          }
        } catch (e) { reportMiss('launch-claim-stale-check', `${params.id}: ${e?.message ?? e}`); }
      }
      const rec = launchBroker.claim(params.id, by);
      if (!rec) return send(409, { error: 'already claimed, done, failed, or unknown' });
      broadcastLaunch(rec.id, rec.state);
      return sendLaunchAuthed(req, res, 200, rec);
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/launches/:id/result',
    handle: async (req, res, { params, send }) => {
      // An agy result carries up to AGY_RESULT_MAX chars of text; every other
      // origin keeps the 4096-byte body.
      // A gitops result carries stdout and stderr tails of up to 200 KB each.
      const client = launchClient(req);
      const existing = launchBroker.get(params.id);
      const origin = existing?.origin;
      const isAgy = origin === 'agy';
      const isGitops = origin === 'gitops';
      const isFile = origin === 'file';
      if (client && (existing?.targetClient ?? null) !== client.id) return send(404, { error: 'no such launch for this client' });
      const rawBody = (await readBody(req, { maxBytes: isGitops || isFile ? 4_000_000 : isAgy ? 20000 : 4096 })) || '';
      if (!client && !verifyLaunchProof(req, rawBody)) return send(401, { error: 'unauthorized' });
      if (!client && existing?.targetClient) return send(404, { error: 'no such launch for the shell' });
      let body = {};
      try { body = JSON.parse(rawBody || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      // Untrusted: capped and typed before it ever lands in queue.json or a
      // ledger entry.
      const pid = Number.isInteger(body.pid) ? body.pid : null;
      const error = typeof body.error === 'string' ? body.error.slice(0, 500) : null;
      let text = null;
      if (isAgy && body.text !== undefined) {
        if (typeof body.text !== 'string' || body.text.length > AGY_RESULT_MAX) return send(400, { error: `agy result text must be a string of at most ${AGY_RESULT_MAX} chars` });
        text = body.text;
      }
      let result = null;
      if (isGitops && body.result !== undefined) {
        const r = body.result;
        const shaped = r && typeof r === 'object' && !Array.isArray(r) && Number.isInteger(r.status) && typeof r.stdout === 'string' && typeof r.stderr === 'string';
        if (!shaped) return send(400, { error: 'gitops result must be { status: integer, stdout: string, stderr: string }' });
        result = { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut === true, ...(r.cancelled === true ? { cancelled: true } : {}) };
      }
      if (isFile && body.result !== undefined) {
        const r = body.result;
        if (!(r && typeof r === 'object' && !Array.isArray(r) && Number.isInteger(r.status) && r.body && typeof r.body === 'object')) return send(400, { error: 'file result must be { status: integer, body: object }' });
        result = { status: r.status, body: r.body };
      }
      const rec = launchBroker.complete(params.id, { pid, error, text, result });
      if (!rec) return send(400, { error: 'launch is not claimed' });
      broadcastLaunch(rec.id, rec.state);
      // a shell-reported failure must be durable and
      // visible, the same as every OTHER launch failure this server
      // already records - a launch that silently queued and
      // then silently failed to open is the exact invisible-failure shape
      // this whole feature exists to rule out.
      // An agy failure is the seat's own error line in the huddle, not a terminal that failed to open.
      if (rec.state === 'failed' && rec.origin !== 'agy' && rec.origin !== 'gitops' && rec.origin !== 'file') {
        appendEvent(P.stateDir, { kind: 'launch.failed', lane: rec.origin, label: String(rec.command).slice(0, 120), path: rec.cwd, ts: Date.now(), sessionId: null });
        // A runner launch's failure must not sit with a null pid until the
        // ordinary runtime timeout eventually notices (maxRuntimeMs can be
        // many minutes) - hold the card now, with the reported reason, and
        // drop the ledger entry so a human reviews it instead of it being
        // silently retried into the same worktree.
        if (rec.origin === 'runner') {
          try {
            // Post-breaker residual N1: read errors are named, never a
            // silent "no matching job" (and the ledger is not rewritten).
            const { ledger, error: ledgerError } = runnerStore.readLedger(P.stateDir);
            if (ledgerError) throw new Error(`card hold skipped, runner ledger unreadable (${ledgerError})`);
            const jobId = Object.keys(ledger).find((k) => ledger[k].launchId === rec.id);
            if (jobId) {
              const entry = ledger[jobId];
              const holdText = `runner: held - the desktop shell could not open the terminal (${rec.error})`;
              delete ledger[jobId];
              runnerStore.saveLedger(P.stateDir, ledger);
              backlogStore.updateItemIn(P.stateDir, jobId, { state: 'held' });
              backlogStore.appendDevLogIn(P.stateDir, jobId, { by: 'runner', text: holdText });
              broadcastBacklog();
              // Fix round 2, m-d: this job just left the live ledger the
              // same way any OTHER departed job does inside reconcileNow -
              // but reconcileNow never sees it happen here, so neither of
              // its two departed-job signals (worktree reclaim, the Slack
              // notifier) ever fired on their own. Run the SAME check
              // reconcileNow's own departed-job loop runs (fix round 3,
              // M-5: via the one shared helper both now call), rather than
              // leaving this job's worktree reclaim unverified and SCUT
              // silent about why the room's job just stopped.
              reclaimDepartedJobWorktree(jobId, entry, {
                retainedIds: retainedWorktreeJobs(),
                liveDirs: sessionSummaries().filter((s) => s.state !== 'ended').map((s) => s.cwd).filter(Boolean),
              });
              scut?.jobFinished({ ticketId: jobId, ok: false, detail: holdText, verdict: null });
            }
          } catch (e) { reportMiss('launch-result-runner-failed', `${rec.id}: ${e?.message ?? e}`); }
        }
      }
      // Fix round 1, I4(A) ruling (overrides the brief's own Step 3.4):
      // NEVER write the transient launcher's pid (cmd /c start, which
      // exits immediately once the real window is open) onto the
      // card-governed ledger pid - reconcileLedger's own
      // `entry.pid != null && !isAlive(entry.pid)` probe would see it
      // dead on the very next tick and requeue a SECOND terminal into the
      // SAME worktree. The reported pid is recorded under its own field,
      // launcherPid, diagnostic only - the ledger entry whose launchId
      // matches is otherwise exactly as the runner tick wrote it.
      if (rec.origin === 'runner' && rec.pid != null) {
        try {
          const { ledger, error: ledgerError } = runnerStore.readLedger(P.stateDir);
          if (ledgerError) throw new Error(`launcherPid patch skipped, runner ledger unreadable (${ledgerError})`);
          const jobId = Object.keys(ledger).find((k) => ledger[k].launchId === rec.id);
          if (jobId) {
            ledger[jobId] = { ...ledger[jobId], launcherPid: rec.pid };
            runnerStore.saveLedger(P.stateDir, ledger);
            broadcastBacklog();
          }
        } catch (e) { reportMiss('launch-result-ledger-patch', `${rec.id}: ${e?.message ?? e}`); }
      }
      if (client) { res.writeHead(204); return res.end(); }
      return sendLaunchAuthedEmpty(req, res, 204);
    },
  });

  // Client-targeted actions (card glmps-2-0-runtime-45): who owns a session or
  // path, and the file call that waits on a client's tap.
  const clientActionMs = (name, dflt) => { const n = Number(env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
  const clientFileCall = createClientFileCall({
    launchBroker, claimWaitMs: clientActionMs('GLMPS_CLIENT_ACTION_CLAIM_MS', 10_000), totalMs: clientActionMs('GLMPS_CLIENT_ACTION_TIMEOUT_MS', 20_000),
  });
  // With no paired client and nothing naming one, every request is the server's own, as before.
  function clientTarget({ sessionId = null, paths = [], clientId = null } = {}) {
    const clients = clientStore ? clientStore.list() : [];
    if (!clientId && !ownerOfSession(sessionId) && !clients.some((c) => c.paired && !c.revokedTs)) return { target: 'local' };
    const localRoots = [...fileApi.roots, ...openOnlyApi.roots, ...launchRoots()];
    return resolveClientTarget({ clients, sessionId, paths, clientId, localRoots });
  }
  const sendRefusal = (send, tgt) => send(tgt.refuse, { error: tgt.reason });
  const clientFile = (tgt, action) => clientFileCall({ clientId: tgt.clientId, clientName: tgt.client.name, action });

  // the card's intent/spec/plan chain, read by hooks/plan-gate.js
  // over one GET so the hook carries no state-store knowledge of its own.
  registerRoute({
    method: 'GET', pattern: '/api/backlog/:id/chain',
    handle: (req, res, { params, send }) => {
      const item = backlogStore.load(P.stateDir).items.find((i) => i.id === params.id);
      if (!item) return send(404, { error: 'item not found' });
      return send(200, cardChain({ item, progress: scutReadProgress(P.stateDir), classify: classifyTask }));
    },
  });
  // glmps-2-0-42: merge-request intake for the GLMPS 2.0 merge queue
  // (docs/specs/2026-10-17-glmps2-merge-queue.md). Files the request only; the
  // tick that advances requested -> testing is a later ticket.
  const runGh = ghRun ?? (gitopsViaShell
    ? shellSeams.gh
    : async (file, args) => (isTestProcess({ env })
      ? { status: 1, stderr: 'gh refused: test process, no ghRun override' }
      : runAsync(file, args, { timeout: 20000 })));
  // glmps-2-0-73: GitHub Actions billed minutes, refreshed hourly through the
  // same gh seam (the service account has no gh sign-in of its own). A test
  // process registers it only when it injects ghRun, so no test reaches GitHub.
  if (cfg.actionsMinutes.enabled && (ghRun || !isTestProcess({ env }))) {
    loopRegistry.registerLoop({
      name: 'actions-minutes',
      trigger: { everyMs: cfg.actionsMinutes.everyMs },
      maker: async () => {
        let repos = Array.isArray(cfg.actionsMinutes.repos) ? cfg.actionsMinutes.repos : null;
        if (!repos) {
          const r = await runGh('gh', actionsGhArgs.repos());
          if (r?.status !== 0) throw new Error(`gh repo listing failed: ${String(r?.stderr || '').trim().slice(0, 200)}`);
          repos = String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean);
        }
        const doc = await refreshActionsMinutes({ prev: readActionsMinutesDoc(P.stateDir), repos, gh: runGh });
        return { outcome: 'done', result: doc };
      },
      checker: async (doc) => {
        const failedRepos = new Set(doc.errors.filter((e) => e.run == null).map((e) => e.repo));
        if (doc.repos.length && failedRepos.size === doc.repos.length) return { ok: false, reason: `run list failed for all ${doc.repos.length} repo(s): ${doc.errors[0]?.error}` };
        return { ok: true, verifierRef: `actions-minutes@${Object.keys(doc.runs).length}` };
      },
      onVerified: async (doc) => {
        writeActionsMinutesDoc(P.stateDir, doc);
        const fresh = readActionsMinutes(P.stateDir, { allowance: cfg.actionsMinutes.allowance });
        const posts = pendingPosts(doc, actionsMinutesFindings(fresh, { thresholds: cfg.actionsMinutes.thresholds }));
        if (!posts.length) return;
        // Recorded before posting: a Slack outage loses one post rather than
        // repeating it every hour.
        writeActionsMinutesDoc(P.stateDir, { ...doc, posted: [...doc.posted, ...posts.map((p) => p.key)] });
        for (const p of posts) await postToOperator(p.text).catch((e) => console.error('[actions-minutes] post failed:', e?.message || e));
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 15 * 60_000 },
      sla: { maxAgeMs: 6 * cfg.actionsMinutes.everyMs },
    });
  }
  // The dashboard's alert rows in Slack, once a morning and only the new ones
  // (card glmps-2-0-219: the every-change repost was noise the operator
  // stopped reading).
  if (cfg.alertDigest.enabled) {
    const digestFile = path.join(P.stateDir, 'alert-digest.json');
    loopRegistry.registerLoop({
      name: 'alert-digest',
      trigger: { everyMs: cfg.alertDigest.everyMs },
      maker: async () => {
        const fresh = alertListCache.alerts && Date.now() - alertListCache.ts < cfg.alertDigest.everyMs;
        const alerts = fresh ? alertListCache.alerts : applyAcks(collectCurrentAlerts(), loadAcks(P.alertAcksFile)).filter((a) => !a.acknowledged);
        const r = morningDigest({
          alerts, prev: readJsonSafe(digestFile), nowMs: Date.now(),
          timeZone: loadOperatorSettings(P.stateDir).timeZone, hour: cfg.alertDigest.hour,
        });
        if (!r.due) return { outcome: 'nothing-to-do' };
        return { outcome: 'done', result: r };
      },
      checker: async (r) => (typeof r?.day === 'string' && Array.isArray(r.ids) && (r.text === null || (typeof r.text === 'string' && r.text.length > 0))
        ? { ok: true, verifierRef: `alert-digest@${r.day}:${r.ids.length}` }
        : { ok: false, reason: 'digest result is malformed' }),
      onVerified: async (r) => {
        // Recorded before posting: a Slack outage loses one post rather than
        // repeating it every interval.
        fs.writeFileSync(digestFile, JSON.stringify({ day: r.day, ids: r.ids, ts: Date.now(), posted: r.text }));
        if (r.text) await postToOperator(r.text).catch((e) => console.error('[alert-digest] post failed:', e?.message || e));
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 60_000 },
      sla: { maxAgeMs: 6 * cfg.alertDigest.everyMs },
    });
  }
  // glmps-2-0-runtime-68 AC-4: the kernel profiles itself for a window and
  // reports every busy run over thresholdMs. The caller repeats windows until
  // one catches a stall; nothing here schedules anything.
  let cpuProfiling = false;
  registerRoute({
    method: 'POST', pattern: '/api/diagnostics/cpu-profile',
    handle: async (req, res, { send }) => {
      let body; try { body = JSON.parse((await readBody(req, { maxBytes: 4096 })) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const seconds = Number(body?.seconds ?? 60);
      const thresholdMs = Number(body?.thresholdMs ?? 1000);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120) return send(400, { error: 'seconds must be 1 to 120' });
      if (!Number.isFinite(thresholdMs) || thresholdMs < 1) return send(400, { error: 'thresholdMs must be a positive number' });
      if (cpuProfiling) return send(409, { error: 'a profile is already running' });
      cpuProfiling = true;
      try {
        const stopSpawns = trackSpawns();
        let profile; let spawns;
        try { profile = await captureCpuProfile({ seconds }); } finally { spawns = stopSpawns(); }
        const summary = analyzeProfile(profile, { thresholdMs });
        const kept = summary.runs.length || body?.keep === true ? keepProfile(P.stateDir, profile) : null;
        return send(200, { ...summary, spawns, kept });
      } catch (e) {
        return send(500, { error: e?.message ?? 'profile failed' });
      } finally {
        cpuProfiling = false;
      }
    },
  });
  // A gate verdict and what follows it: the independent-verdict obligation on a
  // PASS, the board refresh and the Slack relay. The route and the vendor runner
  // both record through here.
  function recordGate(id, gate) {
    const r = backlogStore.setGateIn(P.stateDir, id, gate);
    if (r.error || !r.item) return r;
    // a PASS is a claim that needs its own independent verification, tracked as
    // a standing obligation until a judge (or an operator, decision.deferred /
    // decision.cancelled via POST /api/obligations/:id/close) closes it - a gate
    // that passes and is never independently checked again is exactly the
    // silent gap this obligation exists to catch.
    if (obligationStore && r.item.gate?.status === 'PASS') {
      try {
        obligationStore.open({ kind: 'gate.independent-verdict', subject: id, openedBy: `agent:${gate.by || id}` });
        clearMiss('gate-obligation-open'); // a successful open ends any earlier failure episode.
      }
      catch (e) {
        // a gate-obligation-open failure has no registered
        // loop of its own to attribute to, so it goes through reportMiss
        // (rendered as "Kernel health: gate-obligation-open", not a
        // capture-tool alert) - the operator-action text the deleted
        // pluginHealth tracker used to carry for this key is kept
        // verbatim, since the fix really is a manual one.
        const reason = `${id}: ${e?.message || e}; operator action needed: check the ticket's gate manually, the independent-verification obligation may be missing`;
        console.error('[kernel] gate obligation open failed', reason);
        reportMiss('gate-obligation-open', reason);
      }
    }
    broadcastBacklog();
    // Same relay as /devlog: the verdict is the single most useful thing an
    // operator watching from a phone can see, so it goes to the room too.
    scut?.agentSaid({
      ticketId: id,
      kind: 'gate',
      text: backlogStore.gateRelayText(r.item.gate ?? { status: gate.status }, gate.risk),
      by: gate.by,
    });
    return r;
  }

  // The merge-request intake, shared by the route and the vendor runner (card
  // glmps-2-0-162), which files a vendor agent's PR itself.
  async function fileMergeRequest(id, body, filer) {
    const reply = (status, payload) => ({ status, body: payload });
    try {
      const pr = mergeQueue.parsePrUrl(body?.prUrl);
      if (!pr) return reply(400, { error: 'prUrl must be https://github.com/<owner>/<repo>/pull/<n>' });
      if (mergeQueue.isPublicRepo(pr.repo)) return reply(400, { error: `${pr.repo} is a public repo; the merge queue does not handle it` });
      const findItem = () => backlogStore.load(P.stateDir).items.find((i) => i.id === id);
      const live = (i) => i?.mergeRequest && !mergeQueue.isTerminal(i.mergeRequest);
      const before = findItem();
      if (!before) return reply(404, { error: 'item not found' });
      if (live(before)) return reply(409, { error: `card already has a merge request (${before.mergeRequest.stage})` });

      const recipe = mergeQueue.prViewRecipe(pr);
      let out; let ghError = null;
      try { out = await runGh(recipe.file, recipe.args); } catch (e) { ghError = e; out = { status: 1, stderr: e?.message }; }
      const info = out?.status === 0 ? mergeQueue.parsePrView(out.stdout?.toString?.() ?? '') : null;
      if (!info && isGitopsInfraError(ghError)) return reply(503, { error: `could not read the PR: ${ghError.message}` });
      if (!info) return reply(502, { error: 'could not read the PR from gh', detail: String(out?.stderr ?? '').slice(0, 300) });
      if (info.state !== 'OPEN') return reply(400, { error: `PR is not open (${info.state})` });
      if (info.crossRepo) return reply(400, { error: 'cross-repository PRs are not supported' });
      if (!mergeQueue.prNamesCard({ id, head: info.head, title: info.title })) {
        return reply(403, { error: 'forbidden', reason: `the PR head branch (${info.head}) and title must contain the card id ${id}` });
      }

      // gh is awaited-around slow I/O: re-read so a racing filing cannot be overwritten.
      const card = findItem();
      if (!card) return reply(404, { error: 'item not found' });
      if (live(card)) return reply(409, { error: `card already has a merge request (${card.mergeRequest.stage})` });
      const scope = mergeQueue.parseScope(body, card.acceptanceCriteria);
      if (scope.error) return reply(400, { error: scope.error });
      // The filer is who the server knows the caller to be; a body `by` is a
      // claim anyone can make, so it is ignored (glmps-2-0-runtime-78).
      const by = filer;
      const mr = mergeQueue.createMergeRequest({
        prUrl: body.prUrl.trim(), repo: pr.repo, number: pr.number,
        base: info.base, head: info.head, headSha: info.headSha, filedBy: by, interim: body.interim === true,
        covers: scope.covers, final: scope.final,
      }, { now: new Date().toISOString(), prev: card.mergeRequest ?? null });
      backlogStore.setMergeRequestIn(P.stateDir, id, mr);
      const text = mr.stage === 'held'
        ? `merge request for ${pr.repo}#${pr.number} held: ${mr.history.at(-1).reason}`
        : `merge request filed for ${pr.repo}#${pr.number} into ${info.base} (round ${mr.round}, head ${info.headSha.slice(0, 7)}${mr.interim ? ', interim: the card stays open after the merge' : ''}${mr.covers ? `, covers ${mr.covers.map((n) => `AC-${n}`).join(', ')}` : ''}${mr.final ? ', final' : ''})`;
      const logged = backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text });
      broadcastBacklog();
      // by:'agent' because the room relay drops any other author as runner noise.
      scut?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
      return reply(200, logged.item ?? findItem());
    } catch (e) {
      return reply(500, { error: e?.message ?? 'merge request failed' });
    }
  }
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/merge-request', clientOwnsCard: true,
    handle: async (req, res, { params, send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      // The filer is who the server knows the caller to be; a body `by` is a
      // claim anyone can make, so it is ignored (glmps-2-0-runtime-78).
      const out = await fileMergeRequest(params.id, body, resolveActor(req));
      return send(out.status, out.body);
    },
  });
  // AC-6: a vendor card's Antigravity tab says the agent is done (it wrote its
  // summary) or its CLI exited. The nonce is the tab session's own. Each done
  // file is one hand-off round (card glmps-2-0-172, F4): a signal after an
  // earlier finish starts a later round, and one that arrives while a finish
  // runs is held and run after it, so work done in the tab after the first
  // hand-off is still committed and reported.
  const vendorFollowUps = new Map();
  function startVendorFinish(id, session, body, { laterRound = false } = {}) {
    vendorFinishing.add(id);
    try { fs.writeFileSync(vendorSessionFile(id), JSON.stringify({ ...session, finishedAt: Date.now(), finishEvent: body.event, rounds: (session.rounds ?? 0) + 1 }, null, 2)); }
    catch (e) { reportMiss('vendor-tab-finish', `${id}: session file not updated: ${e?.message ?? e}`); }
    const p = finishVendorTab(id, session, body, { laterRound })
      .catch((e) => reportMiss('vendor-tab-finish', `${id}: ${e?.message ?? String(e)}`))
      .finally(() => {
        vendorFinishing.delete(id);
        const next = vendorFollowUps.get(id);
        vendorFollowUps.delete(id);
        const fresh = next ? readJsonSafe(vendorSessionFile(id)) : null;
        // Started before p leaves the set, so headlessCardsIdle waits for it too.
        if (fresh) startVendorFinish(id, fresh, next, { laterRound: true });
        headlessCardRuns.delete(p);
      });
    headlessCardRuns.add(p);
  }
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/vendor-session',
    handle: async (req, res, { params, send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const id = params.id;
      const session = readJsonSafe(vendorSessionFile(id));
      const check = vendorSignalCheck({ session, body, finishing: vendorFinishing.has(id) });
      if (!check.ok) return send(check.status, { error: check.error });
      if (check.queued) {
        // A done outranks an exit: it carries a summary the finish reads.
        const held = vendorFollowUps.get(id);
        if (!held || body.event === 'done') vendorFollowUps.set(id, body);
        return send(202, { ok: true, queued: true });
      }
      startVendorFinish(id, session, body, { laterRound: !!check.laterRound });
      return send(202, { ok: true, ...(check.laterRound ? { laterRound: true } : {}) });
    },
  });
  // glmps-2-0-runtime-11: a Slack ticket channel for a card that already
  // exists, so any card can be reviewed in its own channel. The channel is
  // made exactly the way a huddle card's is (openCardThread, then
  // bindCardThread), so the card's devlog, gate and park relay land in it the
  // same as for a Slack-filed ticket. Two calls racing for one card share the
  // first one's work rather than creating two channels.
  const channelOpens = new Map();
  // Resolves to the doorway thread the channel was opened from.
  function openCardChannel(item, text) {
    let pending = channelOpens.get(item.id);
    if (!pending) {
      pending = (async () => {
        const thread = await scut.openCardThread(text);
        await scut.bindCardThread({ ...thread, ticketId: item.id, project: item.project, strict: true });
        return thread;
      })().finally(() => channelOpens.delete(item.id));
      channelOpens.set(item.id, pending);
    }
    return pending;
  }
  // glmps-2-0-163: a card that opens interactively gets its own channel, and
  // that channel becomes its origin so the launch header gives the session the
  // park loop. Never throws: { entry, origin } on success, { error } when
  // Slack is off or refuses (the card still launches, Q4).
  async function ensureCardChannel(item, text) {
    if (!scut?.openCardThread || !scut.ticketChannelsEnabled?.()) return { error: scut ? 'Slack ticket channels are turned off' : 'Slack is not connected' };
    const have = scut.ticketChannelFor(item.id);
    if (have) return { entry: have, origin: null };
    try {
      const thread = await openCardChannel(item, text);
      const entry = scut.ticketChannelFor(item.id);
      if (!entry) return { error: 'Slack created no channel' };
      backlogStore.appendDevLogIn(P.stateDir, item.id, { by: 'scut', text: `Slack channel opened: #${entry.name}` });
      return { entry, origin: { via: 'slack', channel: thread.channel, thread_ts: thread.thread_ts } };
    } catch (e) {
      return { error: `Slack failed: ${e?.code ?? e?.message ?? String(e)}` };
    }
  }
  // glmps-2-0-163 AC-3: an interactive launch is the operator's to manage, so
  // the card opens in its own channel. With no Slack configured at all there is
  // nothing to say; Slack down or refusing is said on the card, and it launches anyway.
  async function withOwnChannel(job) {
    if (!scut) return job;
    const slackOrigin = (o) => o?.via === 'slack' && o.channel && o.thread_ts;
    const ch = await ensureCardChannel(job, `*${job.id}* opens interactively; its channel follows.`);
    if (ch.error) {
      backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `opening interactively with no Slack channel of its own: ${ch.error}` });
      return job;
    }
    const origin = ch.origin ?? (slackOrigin(job.origin) ? null : (slackOrigin(ch.entry?.origin) ? { via: 'slack', channel: ch.entry.origin.channel, thread_ts: ch.entry.origin.thread_ts } : null));
    if (!origin) return job;
    backlogStore.setChannelOriginIn(P.stateDir, job.id, origin);
    return { ...job, origin };
  }
  // A spawned card whose host closed: its own channel, interactive from now on.
  // The close path and the close-sync backstop can both reach one card.
  const promoting = new Set();
  async function promoteSpawnedCard(id, { host, why, requeue = false }) {
    const item = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    if (!item || backlogStore.CLOSED_STATES.has(item.state) || item.promoted || item.mode === 'headless' || promoting.has(id)) return null;
    promoting.add(id);
    let ch;
    try {
      ch = await ensureCardChannel(item, `*${id}* promoted: its host card ${host} closed, so it gets its own channel; it follows.`);
      backlogStore.promoteItemIn(P.stateDir, id, { from: host, origin: ch.origin, requeue });
    } finally { promoting.delete(id); }
    const where = ch.entry ? `in its own Slack channel #${ch.entry.name}` : `with no Slack channel (${ch.error})`;
    const next = requeue ? ' It was being worked, so it is requeued.' : '';
    backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `${PROMOTED_NOTE} its host card ${host} ${why}, so it now opens interactively ${where}.${next}` });
    return { id, channel: ch.entry?.name ?? null, error: ch.error ?? null };
  }
  async function promoteOpenChildren(hostId, why) {
    const out = [];
    for (const c of openChildren(hostId, backlogStore.load(P.stateDir).items)) {
      try { const r = await promoteSpawnedCard(c.id, { host: hostId, why, requeue: c.state === 'in_progress' && !runnerStore.loadLedger(P.stateDir)[c.id] }); if (r) out.push(r); }
      catch (e) { reportMiss('promote-child', `${c.id}: ${e?.message ?? e}`); }
    }
    return out;
  }
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/channel',
    handle: async (req, res, { params, send }) => {
      try {
        const id = params.id;
        if (actors.length) {
          const gate = gateCheck({ actors, actorId: resolveActor(req), role: 'promote' });
          if (!gate.allowed) return send(403, { error: 'forbidden', reason: gate.reason });
        }
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const item = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
        if (!item) return send(404, { error: 'item not found' });
        if (!scut?.openCardThread || !scut.ticketChannelsEnabled?.()) {
          return send(503, { error: scut ? 'Slack ticket channels are turned off' : 'Slack is not connected' });
        }
        const view = (entry, extra) => ({ ticketId: id, channelId: entry.channelId, name: entry.name, hidden: Boolean(entry.hiddenTs || entry.archivedTs), ...extra });
        const entry = scut.ticketChannelFor(id);
        const plan = scutOpenChannelPlan({ item, entry, reopen: body?.reopen === true });
        if (plan.action === 'existing') return send(200, view(entry, { created: false }));
        if (plan.action === 'refuse') return send(409, { error: plan.reason, ...view(entry, { created: false }) });
        if (plan.action === 'unhide') {
          const r = await scut.ticketStateChanged({ item });
          if (!r?.ok) return send(502, { error: 'Slack refused to unhide the channel; see the adapter-health alert for the reason', ...view(entry, { created: false }) });
          return send(200, view(scut.ticketChannelFor(id), { created: false, reopened: true }));
        }
        const owner = !channelOpens.has(id);
        try {
          await openCardChannel(item, `*${id}* opened for review from the board; its channel follows.`);
        } catch (e) {
          const reason = e?.code ?? e?.message ?? String(e);
          if (/no SCUT channel/.test(String(e?.message))) return send(503, { error: 'Slack is not connected: no operator channel resolved' });
          return send(502, { error: `Slack failed: ${reason}` });
        }
        const opened = scut.ticketChannelFor(id);
        if (!opened) return send(502, { error: 'Slack failed: the channel was not recorded' });
        if (!owner) return send(200, view(opened, { created: false }));
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: `Slack channel opened: #${opened.name}` });
        broadcastBacklog();
        return send(201, view(opened, { created: true }));
      } catch (e) {
        return send(500, { error: e?.message ?? 'opening the channel failed' });
      }
    },
  });
  // glmps-2-0-171 D1: a card that files or re-cuts cards hosts them, so no card is left unowned.
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/adopt',
    handle: async (req, res, { params, send }) => {
      try {
        if (actors.length) {
          const gate = gateCheck({ actors, actorId: resolveActor(req), role: 'promote' });
          if (!gate.allowed) return send(403, { error: 'forbidden', reason: gate.reason });
        }
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (!Array.isArray(body?.ids) || !body.ids.length || !body.ids.every((x) => typeof x === 'string')) return send(400, { error: 'ids must be a non-empty array of card ids' });
        const r = backlogStore.adoptItemIn(P.stateDir, params.id, body.ids);
        if (r.error) return send(404, { error: r.error });
        if (r.adopted.length) broadcastBacklog();
        return send(200, { adopted: r.adopted, refused: r.refused });
      } catch (e) {
        return send(500, { error: e?.message ?? 'adopt failed' });
      }
    },
  });
  // The operator's way out of a hold (including the pause hold): held -> requested.
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/merge-request/release',
    handle: async (req, res, { params, send }) => {
      try {
        const id = params.id;
        if (actors.length) {
          const actorId = resolveActor(req);
          const gate = gateCheck({ actors, actorId, role: 'promote' });
          if (!gate.allowed) return send(403, { error: 'forbidden', reason: gate.reason });
        }
        const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
        if (!card) return send(404, { error: 'item not found' });
        const mr = card.mergeRequest;
        if (!mr || mr.stage !== 'held') return send(409, { error: `merge request is ${mr ? mr.stage : 'absent'}, not held` });
        const t = mergeQueue.transition(mr, 'requested', { now: new Date().toISOString(), reason: 'released by the operator' });
        if (t.error) return send(409, { error: t.error });
        saveMergeRequest(id, t.mergeRequest, `merge request for ${mr.repo}#${mr.number} released by the operator; requeued`);
        return send(200, backlogStore.load(P.stateDir).items.find((i) => i.id === id));
      } catch (e) {
        return send(500, { error: e?.message ?? 'release failed' });
      }
    },
  });
  // glmps-2-0-113: every open PR on the account, for the Surface Open PRs
  // layer, marked with the merge-queue stage of the card that filed it.
  const openPrs = createOpenPrsSource({ gh: runGh });
  registerGuardsRoutes(registerRoute, { P, readBody });

  // the obligations table's own HTTP surface. Synchronous
  // (no await) - nothing here can leave an unhandled rejection past the
  // matchRoute dispatcher. `state` only ever means 'open' (the default) or
  // 'all': a typo'd or unsupported value
  // used to fall back to 'open' silently, which reads to a caller as "there
  // are no closed rows" rather than "your query was wrong".
  registerRoute({
    method: 'GET', pattern: '/api/obligations',
    handle: (req, res, { send }) => {
      if (!obligationStore) return send(503, { error: 'obligations store unavailable' });
      const u = new URL(req.url, 'http://x');
      const state = u.searchParams.get('state');
      if (state !== null && state !== 'open' && state !== 'all') return send(400, { error: 'state must be open or all' });
      return send(200, state === 'all' ? obligationStore.listAll() : obligationStore.listOpen());
    },
  });
  // Phase K final review I2: the operator's own close. The sweeper and the
  // gate opener leave a row the kernel cannot verify for "a human" to close
  // with decision.deferred or decision.cancelled; this is that route. Only
  // those two closers (verified.done needs a real verifier, never an HTTP
  // caller); closedBy is always 'operator'; the note lands in verifierRef.
  // Async, so every line is inside one try (the matchRoute dispatcher does
  // not await a handler: see /api/guards/refusal). Behind checkAccess like
  // every route, plus operator proof in the handler.
  const OPERATOR_CLOSERS = ['decision.deferred', 'decision.cancelled'];
  registerRoute({
    method: 'POST', pattern: '/api/obligations/:id/close',
    handle: async (req, res, { params, send }) => {
      try {
        // The row is closed as the operator, and every agent session reaches
        // this route on loopback, so loopback alone is no proof (scan F11).
        const operator = tokenMatches(req.headers[LOCAL_SESSION_HEADER], localSessionExpected)
          || tokenMatches(presentedTokenFrom(req.headers), accessToken);
        if (!operator) return send(403, { error: 'operator-only' });
        if (!obligationStore) return send(503, { error: 'obligations store unavailable' });
        let raw;
        try { raw = await readBody(req, { maxBytes: 16 * 1024 }); }
        catch (e) {
          if (e?.message === 'body too large') return send(413, { error: 'body too large' });
          return send(400, { error: 'invalid body' });
        }
        let b;
        try { b = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (typeof b !== 'object' || b === null || Array.isArray(b)) return send(400, { error: 'body must be an object' });
        if (!OPERATOR_CLOSERS.includes(b.closer)) return send(400, { error: `closer must be one of ${OPERATOR_CLOSERS.join(', ')}` });
        if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return send(400, { error: 'note must be a string' });
        if (typeof b.note === 'string' && b.note.length > 2000) return send(400, { error: 'note is too long (max 2000)' });
        const row = obligationStore.get(params.id);
        if (!row) return send(404, { error: 'unknown obligation' });
        if (row.closedTs != null) return send(409, { error: `already closed (${row.closer})` });
        if (!OBLIGATION_KINDS[row.kind]?.closers.includes(b.closer)) return send(400, { error: `${row.kind} cannot be closed by ${b.closer}` });
        const out = obligationStore.close(row.id, { closer: b.closer, closedBy: 'operator', verifierRef: b.note || null });
        return send(200, out);
      } catch (e) {
        console.error('[kernel] obligation close failed', params?.id, e?.message || e);
        return send(500, { error: 'internal error' });
      }
    },
  });

  // Pairing and client management (server-and-client-tap task 4). The guard
  // refuses a client token on all four; only /api/tap/pair is open to a remote
  // caller with no token, because the pairing code is its credential.
  const NO_STORE = { 'cache-control': 'no-store' };
  async function readPairBody(req, send) {
    let raw;
    try { raw = await readBody(req, { maxBytes: 16 * 1024 }); }
    catch (e) { send(e?.message === 'body too large' ? 413 : 400, { error: e?.message === 'body too large' ? 'body too large' : 'invalid body' }); return null; }
    let b;
    try { b = JSON.parse(raw || '{}'); } catch { send(400, { error: 'invalid json' }); return null; }
    if (typeof b !== 'object' || b === null || Array.isArray(b)) { send(400, { error: 'body must be an object' }); return null; }
    return b;
  }
  const clientRoute = (name, fn) => async (req, res, ctx) => {
    const send = (code, obj, headers) => writeJson(req, res, code, obj, headers);
    try {
      if (!clientStore || !pairing) return send(503, { error: 'clients store unavailable' });
      const b = await readPairBody(req, send);
      if (b) return await fn(req, b, { ...ctx, send });
    } catch (e) {
      if (e?.name === 'PairingRefusal') return send(e.status, { error: e.reason });
      if (/^no client /.test(e?.message || '')) return send(404, { error: 'unknown client' });
      if (/is revoked/.test(e?.message || '')) return send(409, { error: 'client is revoked; pair it again' });
      console.error(`[kernel] ${name} failed`, e?.message || e);
      return send(500, { error: 'internal error' });
    }
  };
  // The Clients panel's list (task 8). The store never returns a token or hash.
  registerRoute({
    method: 'GET', pattern: '/api/clients',
    handle: (req, res, { send }) => {
      if (!clientStore) return send(503, { error: 'clients store unavailable' });
      try {
        return send(200, { clients: clientStore.list().sort((a, b) => b.createdTs - a.createdTs) });
      } catch (e) {
        console.error('[kernel] client list failed', e?.message || e);
        return send(500, { error: 'internal error' });
      }
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/clients/:id/rotate',
    handle: clientRoute('client rotate', (req, b, { params, send }) => {
      // Card glmps-2-0-152: a rotation is a new token AND a new certificate over the tap's new key.
      if (!validTapPublicKey(b.publicKey)) return send(400, { error: 'public-key-required' });
      const r = clientStore.rotate(params.id, { actor: resolveActor(req), source: req.socket?.remoteAddress ?? null,
        issueCert: (clientId) => issueTapCert({ clientId, publicKeyPem: b.publicKey }) });
      return send(200, { clientId: r.clientId, token: r.token, certificate: r.certificate.certPem, certificateExpiresAt: r.certificate.notAfter }, NO_STORE);
    }),
  });
  registerRoute({
    method: 'POST', pattern: '/api/clients/:id/revoke',
    handle: clientRoute('client revoke', (req, b, { params, send }) => {
      if (b.reason != null && typeof b.reason !== 'string') return send(400, { error: 'reason must be a string' });
      return send(200, clientStore.revoke(params.id, { actor: resolveActor(req), source: req.socket?.remoteAddress ?? null, reason: b.reason || null }));
    }),
  });

  // Card glmps-2-0-runtime-40: a client's repo summaries joined with the server's own copy of each remote.
  // Operator only: /api/clients/* is refused to a client token by the access guard.
  const clientForGit = (id) => { try { return clientStore ? clientStore.get(id) : null; } catch { return null; } };
  const tapGitRemotes = () => (readGitClonesState()?.remotes ?? {});
  registerRoute({
    method: 'GET', pattern: '/api/clients/:id/git',
    handle: (req, res, { send, params }) => {
      if (!clientStore || !tapGit) return send(503, { error: 'git summaries unavailable' });
      if (!clientForGit(params.id)) return send(404, { error: 'unknown client' });
      const remotes = tapGitRemotes();
      const repos = tapGit.list(params.id).map((r) => {
        const canon = canonicalRemote(r.remote);
        const st = canon ? remotes[canon.key] : null;
        const history = { source: st?.source ?? null, lastFetchTs: st?.lastFetchTs ?? null, error: st ? (st.skipped ?? st.error ?? null) : null };
        const pushed = r.head && st?.heads && typeof st.heads[r.head] === 'boolean' ? st.heads[r.head] : null;
        return { ...r, history, pushed };
      });
      return send(200, { clientId: params.id, repos });
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/clients/:id/git/log',
    handle: async (req, res, { send, params }) => {
      try {
        if (!clientStore || !tapGit) return send(503, { error: 'git summaries unavailable' });
        if (!clientForGit(params.id)) return send(404, { error: 'unknown client' });
        const q = new URL(req.url, 'http://127.0.0.1').searchParams;
        const wantPath = q.get('path');
        const row = wantPath ? tapGit.list(params.id).find((r) => r.path === wantPath) : null;
        if (!row) return send(404, { error: 'the client did not report that path' });
        const nRaw = q.get('n');
        const n = nRaw === null ? 20 : (/^\d{1,4}$/.test(nRaw) ? Number(nRaw) : 0);
        if (n < 1 || n > 100) return send(400, { error: 'n must be 1 to 100' });
        const canon = canonicalRemote(row.remote);
        if (!canon) return send(409, { error: 'no server copy: the repo has no usable remote' });
        const st = tapGitRemotes()[canon.key];
        // The directory is rebuilt here, never read from the state file: the file only says which kind of copy exists.
        let dir = null; let ref = null;
        const branchOk = typeof row.branch === 'string' && /^[A-Za-z0-9._/-]{1,255}$/.test(row.branch) && !row.branch.startsWith('-') && !row.branch.includes('..');
        if (st?.source === 'clone') dir = cloneDirFor(gitClonesDir, canon);
        else if (st?.source === 'checkout') dir = residencyRows().find((c) => canonicalRemote(c?.remote)?.key === canon.key && typeof c.path === 'string')?.path ?? null;
        if (!dir || !fs.existsSync(dir)) return send(409, { error: `no server copy for ${canon.key}` });
        if (row.detached || !branchOk) return send(409, { error: 'the client is detached or on a branch the server cannot read' });
        ref = st.source === 'clone' ? `refs/heads/${row.branch}` : `refs/remotes/origin/${row.branch}`;
        const out = await gitLimiter(() => runGitDirect(['-c', `safe.directory=${dir}`, '--no-optional-locks', '-C', dir, 'log', `-n${n}`, '--format=%H%x1f%an%x1f%at%x1f%s', ref, '--'], { cwd: dir, timeout: 8000 }));
        if (out.status !== 0) return send(409, { error: `branch ${row.branch} is not on the server copy of ${canon.key}` });
        const commits = out.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          const [sha, author, at, ...subject] = line.split('\u001f');
          return { sha, author, ts: Number(at) * 1000, subject: subject.join('\u001f') };
        });
        return send(200, { path: row.path, remote: canon.url, source: st.source, ref, commits });
      } catch (e) {
        console.error('[kernel] client git log failed', e?.message || e);
        return send(500, { error: 'internal error' });
      }
    },
  });
  registerTapRoutes(registerRoute, { clientRoute, pairing, resolveActor, NO_STORE, tapRelease, trustFingerprint: serverTls?.trustFingerprint ?? null });

  // the git-remote residency feed's own HTTP surface.
  // Synchronous (no await) so matchRoute's own try/catch around handle()
  // is enough - never leaves an unhandled rejection past the dispatcher.
  // ENOENT (no run yet) is honestly 404, not empty data; anything else
  // (a corrupt file, an unreadable dir) is a named 500 reason, never the
  // raw fs error text, which on Windows carries the stateDir path.
  registerRoute({
    method: 'GET', pattern: '/api/residency',
    handle: (req, res, { send }) => {
      const file = path.join(P.stateDir, 'residency', 'current.json');
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if (e?.code === 'ENOENT') return send(404, { error: 'no residency yet' });
        console.error('[residency] read failed', e?.message || e);
        return send(500, { error: 'residency read failed' });
      }
      let doc;
      try {
        doc = JSON.parse(raw);
      } catch (e) {
        console.error('[residency] parse failed', e?.message || e);
        return send(500, { error: 'residency file corrupt' });
      }
      // Scan F5: a file published before the feed stripped userinfo can still
      // hold a credential until the next run rewrites it, so redact on read too.
      if (Array.isArray(doc?.rows)) {
        doc.rows = doc.rows.map((r) => (r && typeof r.remote === 'string' ? { ...r, remote: stripRemoteUserinfo(r.remote) } : r));
      }
      return send(200, doc);
    },
  });

  registerRoute({
    method: 'GET', pattern: '/api/brief',
    handle: (req, res, { send }) => {
      const now = Date.now();
      const allSpine = readSpineEvents(P.stateDir, {});
      return send(200, buildBrief({
        runEvents: allSpine.filter((e) => e.kind === SPINE_KINDS.RUN_COMPLETED || e.kind === SPINE_KINDS.RUN_FAILED),
        reviews: allSpine.filter((e) => e.kind === SPINE_KINDS.REVIEW_COMPLETED),
        integrity: integrityReadOnly(now),
        now,
      }));
    },
  });

  registerLessonsRoutes(registerRoute, { P, cfg, readBody, resolveActor });

  registerLearningIntegrityRoutes(registerRoute, { P, cfg, readBody });

  registerRoute({
    method: 'GET', pattern: '/api/reviews',
    handle: (req, res, { send }) => send(200, {
      reviews: readSpineEvents(P.stateDir, { kind: SPINE_KINDS.REVIEW_COMPLETED })
        .map((e) => ({ ts: e.ts, actor: e.actor, ...e.payload })),
    }),
  });


  registerRoute({
    method: 'POST', pattern: '/api/touch',
    handle: async (req, res, { send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      try {
        return send(201, recordTouch(P.stateDir, { ...body, actor: resolveActor(req) }));
      } catch (e) { return send(400, { error: e.message, types: TOUCH_TYPES }); }
    },
  });

  registerRoute({
    method: 'GET', pattern: '/api/autonomy',
    handle: (req, res, { send }) => {
      const windowDays = Number(new URL(req.url, 'http://x').searchParams.get('windowDays')) || 7;
      return send(200, {
        ...autonomyMetrics(readTouches(P.stateDir), nightlyMerges(), { windowDays, now: Date.now() }),
        // The ladder's actual state, so a graduation is visible and not merely
        // recorded. Derived from the spine by currentTiers; a class absent here
        // has never graduated and is at tier 0.
        tiers: currentTiers(P.stateDir),
      });
    },
  });

  registerWorkspaceRoutes(registerRoute, { P, index, sessionSummaries, readBody });
  // Cross-repo "what changed and why". The unit is a merge to the default
  // branch, not a path heuristic: measured 2026-07-22, the heuristic proposed
  // in glmps-4 kept 51% of this repo's commits (server/lib/ IS the
  // codebase), which is a changelog. runGit is execFileAsync, never
  // execFileSync, and the sweep caps its own in-flight count.
  const decisionRunGit = (cwd, args) =>
    execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });

  function decisionRepos() {
    return normalizeRepoList(_projectRoots);
  }

  registerRoute({
    method: 'GET', pattern: '/api/decisions',
    handle: (req, res, { send }) => {
      // Routes are registered ONCE at startup, so the request-scoped `u` from
      // the handler callback is not in scope here. Parse per request.
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      const sinceRaw = q.get('since');
      const limitRaw = q.get('limit');
      const rows = decisionStore.readAll(P.stateDir, {
        repo: q.get('repo') ?? undefined,
        since: sinceRaw ? Number(sinceRaw) : undefined,
        q: q.get('q') ?? undefined,
        limit: limitRaw ? Number(limitRaw) : 500,
      });
      return send(200, { entries: decisionStore.joinEnrichment(rows), repos: decisionRepos() });
    },
  });

  // The globe's file-tree layer (D17). Repository by residency name only: a
  // path never comes from the client directly, so `..`/absolute/symlink
  // escapes and secret basenames are refused inside repo-tree.js itself,
  // ahead of anything reaching the filesystem. The dispatcher (matchRoute ->
  // handle) does not await an async handler's promise inside its own
  // try/catch, so a rejection here would otherwise reach neither a response
  // nor a logged error: each handler catches its own.
  const treeMemo = new Map();
  // repo-tree.js normalizes every error it throws to a status plus a fixed,
  // path-free message, but this is the last
  // line of defense too: anything that reaches here WITHOUT a status was not
  // one of those normalized throws, so its message is untrusted and gets
  // logged, never sent.
  const sendSurfaceError = (send, e) => {
    if (e.status) return send(e.status, { error: e.message });
    console.error(`[surface] unexpected error: ${e.stack ?? e.message}`);
    return send(500, { error: 'repository read failed' });
  };
  const residencyRows = () => {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(P.stateDir, 'residency', 'current.json'), 'utf8'));
      return Array.isArray(doc?.rows) ? doc.rows : [];
    } catch { return []; }
  };
  let editsMemo = null;
  registerRoute({
    method: 'GET', pattern: '/api/surface/edits',
    handle: (req, res, { send }) => {
      try {
        if (editsMemo && Date.now() - editsMemo.ts < 2000) return send(200, editsMemo.body);
        const body = collectSessionEdits({
          sessions: sessionSummaries(),
          eventsOf: (id) => eventLog.get(id) ?? [],
          rows: residencyRows(),
          statOf: (abs) => { try { const st = fs.statSync(abs); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } },
          allowed: (abs) => { try { fileApi.assertAllowed(abs); return true; } catch { return false; } },
          now: Date.now(),
        });
        editsMemo = { ts: Date.now(), body };
        return send(200, body);
      } catch (e) { return sendSurfaceError(send, e); }
    },
  });
  let timelineMemo = null;
  registerRoute({
    method: 'GET', pattern: '/api/timeline',
    handle: (req, res, { send }) => {
      try {
        const hours = clampHours(new URL(req.url, 'http://127.0.0.1').searchParams.get('hours'));
        if (timelineMemo && timelineMemo.hours === hours && Date.now() - timelineMemo.ts < 5000) return send(200, timelineMemo.body);
        const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
        const body = buildTimeline({
          now: Date.now(),
          hours,
          eventsBySession: eventLog,
          cardOf: (id) => sessionCards().get(id),
          cards: safe(() => backlogStore.load(P.stateDir).items ?? [], []),
          alerts: safe(() => collectCurrentAlerts(), []),
          loops: safe(() => loopRegistry.snapshot(), {}),
        });
        timelineMemo = { ts: Date.now(), hours, body };
        return send(200, body);
      } catch (e) { return sendSurfaceError(send, e); }
    },
  });
  let lsMemo = null;
  const ledgerMemo = createSwrMemo(async () => {
    const rows = residencyRows();
    if (!lsMemo || Date.now() - lsMemo.ts > 600000) lsMemo = { ts: Date.now(), files: await lsFilesByRepo(rows) };
    const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
    const toolCounts = {};
    for (const s of sessions) toolCounts[s.tool] = (toolCounts[s.tool] ?? 0) + 1;
    return ledgerModel({
      rows,
      filesByRepo: lsMemo.files,
      cards: safe(() => backlogStore.load(P.stateDir).items ?? [], []),
      tools: Object.entries(toolCounts).map(([id, sessionsFound]) => ({ id, sessionsFound })),
      learningCount: safe(() => (learningStore.load(P.stateDir).items ?? []).length, 0),
      alertCount: safe(() => applyAcks(collectCurrentAlerts(), loadAcks(P.alertAcksFile)).filter((a) => !a.acknowledged).length, 0),
    });
  }, { maxAgeMs: 30000 });
  registerSurfaceRoutes(registerRoute, { P, openPrs, treeMemo, sendSurfaceError, fileApi, ledgerMemo });

  // Learning lens headline (D6 borrow b). Computed on request, memoised 60 s
  // per window, so a dashboard left open does not re-read the event log on
  // every render. No background job (the loop contract does not apply).
  // The dispatcher (matchRoute -> handle) does not await an async handler's
  // promise inside its own try/catch, so a rejection here would otherwise
  // reach neither a 500 response nor the 500 path: catch it ourselves.
  const outcomeMetricsMemo = new Map();
  registerRoute({
    method: 'GET', pattern: '/api/learning/outcome-metrics',
    handle: async (req, res, { send }) => {
      try {
        const q = new URL(req.url, 'http://127.0.0.1').searchParams;
        const days = q.has('days') ? Number(q.get('days')) : 30;
        if (!Number.isInteger(days) || days < 1 || days > 365) return send(400, { error: 'days must be an integer from 1 to 365' });
        const hit = outcomeMetricsMemo.get(days);
        if (hit && Date.now() - hit.ts < 60000) return send(200, hit.body);
        const body = await computeOutcomeMetrics({
          stateDir: P.stateDir, now: Date.now(), windowDays: days,
          deps: { readOutcomes, loadBacklog: backlogStore.load, readEvents, readVerdicts },
        });
        outcomeMetricsMemo.set(days, { ts: Date.now(), body });
        return send(200, body);
      } catch (e) { return send(...bodyErrorReply(e, req)); }
    },
  });

  const camBaselinePath = path.join(P.stateDir, 'cross-agent-memory', 'baseline.json');

  // Through the judge adapter (core never imports a vendor tree), so the card
  // shows the exact text the judge sends; a missing plugin leaves the card's fallback note.
  let judgeVendorCache = null;
  const judgeVendorPrompts = async () => {
    judgeVendorCache ??= import('../plugins/judge/adapter.js').then((m) => ({ ...m.PROMPTS }), () => ({}));
    return judgeVendorCache;
  };
  registerRoute({
    method: 'GET', pattern: '/api/personality',
    handle: async (req, res, { send }) => {
      try {
        return send(200, buildPersonality({
          homeDir: os.homedir(), claudeDir: P.claudeDir, geminiDir, repoRoot: REPO_ROOT, assetsDir: P.assetsDir,
          agentsDir: P.agentsDir, memoryDir: P.memoryDir, configFile,
          crossAgentMemoryCount: () => camLoad(P.stateDir).items.length,
          judgeVendorPrompts: await judgeVendorPrompts(),
          loopSteers: loopRegistry.describe().flatMap(({ name, about }) => (about?.steers ?? []).map((s) => ({ loop: name, ...s }))),
          graphSteers: GRAPH_CATALOG.flatMap((g) => g.steers.map((s) => ({ graph: g.name, ...s }))),
        }));
      } catch (e) { return send(...bodyErrorReply(e, req)); }
    },
  });
  registerCrossAgentMemoryRoutes(registerRoute, { P, REPO_ROOT, cfg, readBody, camBaselinePath });

  registerPluginsRoutes(registerRoute, { readBody, chatCompletion, modelCfg, loopRegistry, cfg });

  // glmps-140: guard/skill retire-candidate compute+persist helpers, moved
  // here (out of the per-request handler below) so they are declared ONCE
  // and can be driven by a scheduled tick (measurablesTick, set up near the
  // other sweeper/tick timers below) instead of on every GET /api/measurables
  // request. GET /api/guards/retire-candidates and GET /api/skills/lifecycle
  // still call these directly, per-request, with their own request-scoped
  // options (e.g. ?minObservations=) - that per-request persist behavior for
  // those two dedicated routes is UNCHANGED by glmps-140, only the
  // self-populate side effect that used to live inside GET /api/measurables
  // moved to the tick. Both counterfactual computations are evidence-gated
  // in the underlying lib (guard-retire.js/skill-retire.js skip anything
  // with no recorded observation), so calling them from a tick can never
  // invent a candidate out of an empty state dir.
  //
  // Guard proposer cutover: the static gap-code -> guard TEMPLATES
  // map is deleted. The live guard catalog these two retire-candidate rules
  // read is now the SAME data the queue already tracks: every learning-store
  // item that has actually been applied carries a code and a
  // proposedGuard.rule (GEPA-derived, or an operator's own 'alternative'
  // rule). This is more accurate than the old static list too: a guard that
  // was never actually applied can no longer show up as a retire-candidate
  // for having "never fired" - it was never live in the first place.
  //
  // a 'gepa' item's `code` is always the literal
  // string 'gepa-proposal' (learning-store.js's upsertProposal), which is
  // not a real shadow-arm taskClass - nothing ever records a shadow
  // observation under it. Keying by code would collapse every applied GEPA
  // guard onto that one fake entry, and a sound per-guard join would instead
  // need to look at the shadow-arm buckets of the several DIFFERENT gap
  // codes a GEPA guard was derived from (item.derivedFrom) - aggregating
  // several independent codes' fire/counterfactual evidence into one
  // retire-or-keep verdict for a single guard is not a 1:1 statistical join
  // (a guard might target three codes; one going quiet while the others
  // still fire is not "never fires"). Rather than invent that aggregation or
  // silently collapse guards onto a meaningless bucket, GEPA-sourced applied
  // guards are excluded from retire/stale evaluation entirely; the excluded
  // count is returned alongside the candidates by the one route that surfaces
  // them directly (GET /api/guards/retire-candidates), so an operator can see
  // that guards exist which this feature does not yet evaluate, rather than
  // the feature looking complete while quietly skipping a whole source.
  function appliedGuardCatalog() {
    const guards = new Map();
    let excludedGepaCount = 0;
    try {
      for (const it of learningStore.load(P.stateDir).items ?? []) {
        if (!it || it.status !== 'applied' || !it.proposedGuard || typeof it.proposedGuard.rule !== 'string') continue;
        if (it.source === 'gepa') { excludedGepaCount++; continue; }
        if (typeof it.code === 'string') guards.set(it.code, { rule: it.proposedGuard.rule });
      }
    } catch { /* fail-open: no store yet */ }
    return { guards, excludedGepaCount };
  }
  function computeGuardRetireCandidates(opts) {
    try { return retireCandidatesFromTemplates(appliedGuardCatalog().guards, shadowRates(P.stateDir), opts); }
    catch { return []; } // fail-open: no shadow log yet, or a malformed entry - report none
  }
  function persistGuardRetireCandidates(candidates) {
    // Idempotent upsert keyed by code - repeated calls just refresh
    // detail/metric, never duplicate.
    for (const c of candidates) {
      try { upsertMeasurable(P.stateDir, measurableFromGuardCandidate(c, Date.now())); } catch { /* fail-open per row */ }
    }
  }
  function computeSkillArchiveCandidates() {
    try {
      const skillEvents = readEvents(P.stateDir, {}).filter(e => e.kind === 'skill');
      const view = buildSkillsView(inventory, skillEvents);
      return archiveCandidates(view.skills, getObservedSince(P.stateDir), skCfg.exempt, { minObservationDays: skCfg.minObservationDays });
    } catch { return []; }
  }
  function persistSkillArchiveCandidates(candidates) {
    for (const c of candidates) {
      try { upsertMeasurable(P.stateDir, measurableFromSkillCandidate(c, Date.now())); } catch { /* fail-open per row */ }
    }
  }
  // Which plugins the operator actually has switched on. scanFleet uses this to
  // stop advertising agents from disabled plugins, which the Task tool cannot
  // dispatch. Returns undefined on any read or parse failure, which scanFleet
  // treats as "include everything" (fail open: an unreadable settings file must
  // never empty the roster).
  function readEnabledPlugins() {
    try { return JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8')).enabledPlugins; } catch { return undefined; }
  }
  // glmps-166 Task 9: agent capability-lifecycle, same shape as the skill
  // pair above. dispatchCount from /api/agents is ALL-TIME cumulative and
  // capture accrues forward-only (no backfill), so recordAgentFirstSeen MUST
  // run before agentRetireCandidates - otherwise every agent reads as dead
  // the day this ships.
  function computeAgentRetireCandidates() {
    try {
      const agCfg = cfg.agentLifecycle ?? {};
      const fleet = scanFleet({ agentsDir: P.agentsDir, pluginsCacheDir: P.pluginsCacheDir, enabledPlugins: readEnabledPlugins() });
      const usage = aggregateAgentUsage(index.list({}));
      const rows = fleet.agents.map(a => ({
        name: a.name,
        source: a.source ?? null,
        dispatchCount: usage.get((a.name ?? '').toLowerCase())?.dispatches ?? 0,
        lastUsed: usage.get((a.name ?? '').toLowerCase())?.lastUsed ?? null,
      }));
      // Start the observation clock for any agent we are seeing for the first
      // time. This MUST happen before the candidate check, or an agent
      // installed today would be judged against a window it never entered.
      recordAgentFirstSeen(P.stateDir, rows.map(r => r.name), Date.now());
      return agentRetireCandidates(rows, getAgentObservedSince(P.stateDir), agCfg.exempt ?? [], {
        minObservationDays: agCfg.minObservationDays ?? AGENT_MIN_OBS_DAYS,
      });
    } catch { return []; }
  }
  function persistAgentRetireCandidates(candidates) {
    for (const c of candidates) {
      try { upsertMeasurable(P.stateDir, { ...c, ts: Date.now() }); } catch { /* fail-open per row */ }
    }
  }
  // glmps-138 Task 4: a second, complementary "gone quiet" rule alongside
  // the counterfactual-based computeGuardRetireCandidates/
  // computeSkillArchiveCandidates above (staleGuardCandidates /
  // staleArchiveCandidates in guard-retire.js / skill-retire.js - see
  // those modules' doc comments for the full rationale). Persisted under
  // a DISTINCT measurable id (`*-retire-stale:` vs `*-retire:`/
  // `skill-retire:`) so a stale candidate never collides with or
  // overwrites an existing counterfactual candidate for the same
  // guard/skill - same `kind` value, though, so the Registry's
  // kind-filter still groups them together. Never modifies
  // computeGuardRetireCandidates/computeSkillArchiveCandidates or their
  // persisted rows.
  function computeGuardStaleCandidates() {
    try {
      const items = learningStore.load(P.stateDir).items ?? [];
      // Adoption time (fallback only): when a gap item was committed to
      // CLAUDE.md. This is NOT "last used" - updatedTs on an 'applied'
      // item is set exactly once, at adoption, and never touched again
      // (see learning-store.js's upsertGapInto: "an applied one is left
      // alone, no churn, no resurrection").
      const adoptedByCode = {};
      for (const it of items) {
        if (it && it.status === 'applied' && typeof it.code === 'string' && typeof it.updatedTs === 'number') {
          adoptedByCode[it.code] = it.updatedTs;
        }
      }
      // Real "last used" signal (glmps-138 C1 fix): shadow-arm's per-
      // observation log records fired:true with a real timestamp every
      // time a guard's condition actually matched - gap.code IS the
      // taskClass shadow-arm records under (same join key guard-retire.js
      // already uses for its counterfactual rule above). A guard that
      // fired recently is NOT stale regardless of how long ago it was
      // adopted; a guard that has NEVER fired since adoption falls back
      // to its adoption ts, so an old, never-fired guard IS stale.
      const firedByCode = lastFiredByClass(P.stateDir);
      const lastUsedByCode = { ...firedByCode };
      for (const [code, ts] of Object.entries(adoptedByCode)) {
        if (!(code in lastUsedByCode)) lastUsedByCode[code] = ts;
      }
      return staleGuardCandidatesFromTemplates(appliedGuardCatalog().guards, lastUsedByCode, retireStalenessCfg);
    } catch { return []; } // fail-open: malformed learning-store, report none
  }
  function persistGuardStaleCandidates(candidates) {
    for (const c of candidates) {
      try {
        upsertMeasurable(P.stateDir, {
          id: `guard-retire-stale:${c.code}`,
          kind: 'guard-retire',
          title: `Guard retire candidate: ${c.code}`,
          detail: `stale: unused for ${Math.floor(c.lastUsedDays)} days`,
          evidence: { sessionId: null, ref: c.code },
          metric: { reason: c.reason, lastUsedDays: c.lastUsedDays },
          ts: Date.now(),
        });
      } catch { /* fail-open per row */ }
    }
  }
  function computeSkillStaleCandidates() {
    try {
      const skillEvents = readEvents(P.stateDir, {}).filter(e => e.kind === 'skill');
      const view = buildSkillsView(inventory, skillEvents);
      // a young/sparse skill-event history cannot
      // tell "genuinely unused for retireDays" apart from "we have not been
      // watching long enough to know" - a fresh instance that reads the real
      // ~/.claude inventory by design (this shadow is observe-only) would
      // otherwise flag every used-at-least-once skill as stale the moment it
      // boots. Only trust staleness once the observed window itself is at
      // least as old as retireDays. Named reason via reportMiss (round 2,
      // item 2: this fires every measurablesTick while the window stays
      // young, not just once - reportMiss's own count/rate aggregation on
      // this key is the noise control, the same convention every other
      // reportMiss call site in this file already relies on).
      const earliestObservedTs = skillEvents.reduce((min, e) => {
        const ms = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts);
        return Number.isFinite(ms) && (min === null || ms < min) ? ms : min;
      }, null);
      if (earliestObservedTs !== null) {
        const observedDays = (Date.now() - earliestObservedTs) / 86_400_000;
        if (observedDays < retireStalenessCfg.retireDays) {
          reportMiss('skill-retire-young-history',
            `skill-event history only spans ${Math.floor(observedDays)} day(s), short of the ${retireStalenessCfg.retireDays}-day staleness window - skipping stale-skill candidates to avoid false positives`);
          return [];
        }
      }
      return staleArchiveCandidates(view.skills, skCfg.exempt, { ...retireStalenessCfg, earliestObservedTs });
    } catch { return []; }
  }
  function persistSkillStaleCandidates(candidates) {
    for (const c of candidates) {
      try {
        upsertMeasurable(P.stateDir, {
          id: `skill-retire-stale:${c.id}`,
          kind: 'skill-retire',
          title: `Skill archive candidate: ${c.name}`,
          detail: `stale: unused for ${Math.floor(c.lastUsedDays)} days`,
          evidence: { sessionId: null, ref: c.id },
          metric: { reason: c.reason, lastUsedDays: c.lastUsedDays },
          ts: Date.now(),
        });
      } catch { /* fail-open per row */ }
    }
  }
  // glmps-166 Task 11: agent routing compliance - did a routed card's
  // session actually dispatch the agent the queue runner named for it
  // (Task 8's computeRoutingCompliance, server/lib/evaluation/routing-
  // compliance.js). Same compute/persist split as the pairs above, fail-
  // open at both layers so a bad ledger or index read can never crash the
  // tick. persistRoutingCompliance additionally refuses to write when
  // `routed` is 0 - with no routed cards yet there must be NO
  // routing-compliance measurable at all, never a fabricated 0%/0 result
  // (see routing-compliance.test.js's anti-fabrication test and the
  // Experiments panel's matching "No routed cards yet." empty state).
  function computeRoutingComplianceMetric() {
    try {
      // UNION of the live ledger and the durable routing log (routing-log.js),
      // de-duplicated by card id. The live ledger ALONE only ever holds
      // in-flight jobs - reconcileLedger prunes a card the moment it finishes -
      // so reading it alone capped `routed` at maxConcurrent and made the
      // pre-registered n=20 decision point unreachable. See mergeRoutingLedger
      // for why the live entry wins a collision.
      const ledger = mergeRoutingLedger(runnerStore.loadLedger(P.stateDir), loadRoutingLog(P.stateDir));
      const notes = {};
      try {
        for (const it of backlogStore.load(P.stateDir).items ?? []) {
          if (!Object.hasOwn(ledger, it.id)) continue;
          notes[it.id] = (it.devLog ?? []).filter(e => e?.by === 'agent').map(e => e.text);
        }
      } catch { /* notes are optional; a board read failure only drops `explained` */ }
      return computeRoutingCompliance({
        ledger,
        notes,
        sessions: index.list({}),
        threshold: 0.6,
        decisionDate: '2026-09-15',
      });
    } catch { return null; }
  }
  function persistRoutingCompliance(metric) {
    if (!metric || !(metric.routed > 0)) return; // no fabricated measurable with zero routed cards
    try {
      upsertMeasurable(P.stateDir, {
        id: 'routing-compliance:current',
        kind: 'routing-compliance',
        title: 'Agent routing compliance',
        detail: `${metric.complied}/${metric.routed - metric.unmeasurable} routed cards dispatched the named agent; ${metric.explained ?? 0} more worked inline with a stated routing note`,
        evidence: { sessionId: null, ref: null },
        metric,
        ts: Date.now(),
      });
    } catch { /* fail-open per row */ }
  }
  // glmps-140: runs the compute+persist pairs above - the tick that
  // replaces GET /api/measurables's old per-request self-populate side
  // effect. Called once synchronously below (before startServer() returns)
  // so the store is never empty before the first interval elapses, then
  // again on every measurablesTickMs interval.
  function measurablesTick() {
    persistGuardRetireCandidates(computeGuardRetireCandidates({}));
    persistSkillArchiveCandidates(computeSkillArchiveCandidates());
    persistGuardStaleCandidates(computeGuardStaleCandidates());
    persistSkillStaleCandidates(computeSkillStaleCandidates());
    persistAgentRetireCandidates(computeAgentRetireCandidates());
    persistRoutingCompliance(computeRoutingComplianceMetric());
  }

  // Finalize one session into an outcome row (idempotent) and queue its judge
  // job. Extracted (GLMPS 2.0 shadow-instance plan, Task 1) so the Stop-hook
  // route below and the finalize sweep tick (defined after the server starts
  // listening, near the other periodic ticks) share one code path - the only
  // difference between them is `notBefore`: the route always pushes it
  // `idleMs` into the future (another ping may still come), the sweep passes
  // one already in the past (the session is, by construction, already idle
  // idleMs or more).
  //
  // judge on quiescence. A finalize ping
  // fires on every Stop, not just the session's true end, so judging inline
  // on the first (and only ever-appended) ping judged an almost-empty
  // trajectory and never revisited it. Every ping for this session upserts
  // ONE durable judge.session job, pushing notBefore forward each time - a
  // later ping means the session is still active, so the judge waits idleMs
  // past the LAST ping before ever running. The retry tick is the only place
  // a judge call is ever made, first attempt or retry alike; it already
  // skips a job whose notBefore has not arrived (retry-queue.js's take())
  // and never double-judges a row with an existing verdict.
  //
  // loadDurableEventsIfMissing (fix round 1, Important; sweep-only - the
  // route below never sets it, so its behaviour is unchanged): the in-memory
  // eventLog Map is rehydrated only by live traffic (pushEvents), so after a
  // restart it is empty for every session idle beyond ACTIVE_WINDOW - exactly
  // the sessions the sweep exists to catch, since they never get another
  // Stop ping to repopulate it. Reading `eventLog.get(sid) || []` alone would
  // silently finalize those with zero events, an empty row that hasOutcomeRow
  // then locks in forever. When set, an empty in-memory result falls back to
  // the durable event-log (server/lib/observability/event-log.js), matching
  // runRetryTick's own judge.session rebuild; if that is ALSO empty, this
  // returns null instead of finalizing, so the sweep just retries the
  // session on a later tick rather than writing a permanently empty row.
  function finalizeAndQueueJudge(sid, { notBefore, loadDurableEventsIfMissing = false } = {}) {
    let events = eventLog.get(sid) || [];
    if (loadDurableEventsIfMissing && events.length === 0) {
      events = readEvents(P.stateDir, { sessionId: sid });
      if (events.length === 0) return null;
    }
    const usageRow = (readUsage(P.stateDir).perSession || []).find(s => s.sid === sid) || null;
    const usage = usageRow ? { input: usageRow.input, output: usageRow.output, ctxUsedPct: usageRow.ctxUsedPct } : null;
    // model attribution: prefer the statusline tap's per-session usage row (it
    // records the model live); when absent, buildSessionOutcome derives it from
    // events instead - so only pass the key through when the usage row has it.
    const modelOpt = usageRow && Object.prototype.hasOwnProperty.call(usageRow, 'model')
      ? { model: usageRow.model ?? null } : {};
    const firstPrompt = (events.find(isPromptEvent) || {}).label || '';
    const filesTouched = [...new Set(events.filter(e => e.path).map(e => e.path))];
    // A client session's cwd is client-written and names the client's disk:
    // reading acceptance.md or CLAUDE.md under it would probe server paths (or
    // dial a UNC share), and the returned counts and hash would be an oracle for
    // them. This box's CLAUDE.md never guided it either, as in computeGuiding.
    const fromClient = !!(index.get(sid)?.clientId ?? splitNamespacedId(sid));
    const cwd = fromClient ? null : (index.get(sid)?.cwd ?? null);
    // P.claudeDir (not a bare os.homedir() read): already redirected off the
    // real home in a test process, and
    // honors GLMPS_CLAUDE_DIR/profile overrides the old os.homedir() read never did.
    const unit = fromClient ? promptVersionFor({}) : promptVersionFor({ cwd, claudeDir: P.claudeDir });
    let doneGateRecords = [];
    try {
      const raw = fs.readFileSync(path.join(P.doneGateDir, `${sid}.jsonl`), 'utf8');
      doneGateRecords = raw.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { /* no done-gate file for this session yet */ }
    let acceptanceText = '';
    try { acceptanceText = cwd ? fs.readFileSync(path.join(cwd, 'acceptance.md'), 'utf8') : ''; } catch { /* no acceptance.md */ }
    const { row, appended } = finalizeSession(P.stateDir, { sessionId: sid, events, usage, firstPrompt, filesTouched, acceptanceText, doneGateRecords, unit, ...modelOpt });
    if (judgeCfg.enabled) {
      try {
        retryQueue.upsert(
          (j) => j.kind === 'judge.session' && j.sessionId === sid,
          {
            kind: 'judge.session', sessionId: sid, rowId: row.id, firstPrompt,
            ticketId: resolveTicketIdForSession(sid), notBefore,
          },
        );
        clearMiss('retry-queue-write'); // its own id - a successful write ends only its own earlier failure episode.
      } catch (e) {
        // K Task 6: the session-judge / plugin-retry loops report their own
        // failures (loopAlerts) once a judge.session job is actually
        // attempted; a failure to even QUEUE one here (a retryQueue write
        // failure) has no registered loop of its own to attribute to. I5
        // : its own 'retry-queue-write' id, distinct from the
        // queue FILE's own read/corruption health ('retry-queue') and the
        // dead-letter read's ('retry-queue-deadletter') - an unrelated
        // clean queue READ (very frequent, every plugin-retry tick) must
        // never mask a persistent write failure by clearing the wrong id.
        const reason = e && e.message ? e.message : String(e);
        console.error('[loops] judge.session upsert failed for session', sid, reason);
        reportMiss('retry-queue-write', `judge.session upsert failed for session ${sid}: ${reason}`);
      }
    }
    return { row, appended };
  }

  // K Task 6's named replacement for the deleted tracker's own embed-key
  // alert: a missing/unreadable embed model means the memory subsystem
  // cannot admit anything at all, so it is reported once, immediately,
  // rather than waiting for the first real session.condensed event to
  // surface it. Deferred to here (past `clients`/broadcastLoop's own
  // declarations above) rather than right after registerPluginLoops - see
  // the comment there.
  if (embedderMissingReason) {
    loopRegistry.report('memory-admission', { outcome: 'failed', reason: embedderMissingReason });
  }

  const sessionCards = createSessionCardLookup(P.stateDir);
  const sessionOutcomes = createSessionOutcomeLookup(P.stateDir);
  const sessionLearningFor = createSessionLearningLookup(P.stateDir);
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => writeJson(req, res, code, obj);
    // parse outside the handler's try used to crash the kernel on a raw
    // 'GET //['. Only an origin-form target (exactly one leading '/') is
    // accepted; '//host/...' would otherwise be read as a protocol-relative
    // URL whose pathname differs from the literal target.
    const rawTarget = typeof req.url === 'string' ? req.url : '';
    // A second-character backslash ('/\api') parses through new URL as host 'api'.
    if (!rawTarget.startsWith('/') || rawTarget.startsWith('//') || rawTarget[1] === '\\') return send(400, { error: 'non-canonical-path' });
    let u;
    try { u = new URL(rawTarget, 'http://x'); } catch { return send(400, { error: 'invalid request target' }); }
    // a loopback socket relaying for a same-host proxy is judged as remote.
    const peer = peerAddress(req.socket?.remoteAddress, req.headers);
    // Access guard: loopback clients (the host-native executor + local dev) bypass;
    // remote clients must present the shared token on mutating/secret routes.
    const _acc = checkAccess({
      remoteAddress: peer, method: req.method, pathname: u.pathname,
      presentedToken: presentedTokenFrom(req.headers), token: accessToken,
      // Review focus 1: GET/HEAD only (checkAccess ignores it otherwise).
      queryToken: u.searchParams.get('access_token') || '',
      // the wiki iframe's read-only ticket (never the master token).
      wikiTicket: u.searchParams.get('wiki_ticket') || '', ticketKey: wikiTicketKey,
      host: req.headers.host, origin: req.headers.origin,
      // Task 15, K-2: the port this socket is actually bound to (port 0 in
      // tests resolves here) turns on the Host allowlist for every loopback
      // request; bindHost adds the configured remote host when non-local.
      localPort: req.socket?.localPort, bindHost,
      // Task 15, K-1: the browser context of a request to a state-changing
      // GET (SIDE_EFFECT_GET_ROUTES); page script cannot set these.
      secFetchSite: req.headers['sec-fetch-site'], secFetchMode: req.headers['sec-fetch-mode'],
      // Scan 2026-10-15 F2: the shell's or dashboard's proof of the local session key.
      localSession: req.headers[LOCAL_SESSION_HEADER], localSessionExpected,
      authenticateClient,
      // Card glmps-2-0-152: the private HTTPS listener's peer certificate, checked against the token's client.
      clientCert: peerClientCert(req.socket),
    });
    // Task 15 residual 3: the K-1/K-2 refusals name their own reason; the
    // pre-existing Origin/Host and token refusals keep their bodies.
    if (!_acc.allow) return send(_acc.status, { error: _acc.reason ?? (_acc.status === 403 ? 'forbidden origin/host' : 'unauthorized') });
    // Tap protocol (agent skeleton card): any request carrying a paired client's
    // token must state a current protocol. Loopback skips the guard's token
    // check, so the tap's own routes resolve their client from the token here too.
    const isHeartbeat = req.method === 'POST' && u.pathname === '/api/tap/heartbeat';
    const isTapIngest = req.method === 'POST' && u.pathname === '/api/tap/ingest';
    const isMirrorAppend = req.method === 'POST' && u.pathname === '/api/tap/mirror/append';
    const isMirrorSnapshot = req.method === 'POST' && u.pathname === '/api/tap/mirror/snapshot';
    const isMirrorManifest = req.method === 'GET' && u.pathname === '/api/tap/mirror';
    const isTapGit = req.method === 'POST' && u.pathname === '/api/tap/git';
    const isLaunchRoute = /^\/api\/launches(?:\/[^/]+\/(?:claim|result))?$/.test(u.pathname);
    const tapClient = isHeartbeat || isTapIngest || isMirrorAppend || isMirrorSnapshot || isMirrorManifest || isTapGit || isLaunchRoute ? authenticateClient(presentedTokenFrom(req.headers)) : null;
    // Card glmps-2-0-runtime-67: a tap too old for the protocol must still be
    // able to fetch the signed release that fixes it, so that one read skips the check.
    const isTapUpdateRead = (req.method === 'GET' || req.method === 'HEAD') && u.pathname === TAP_UPDATE_PATH;
    if ((_acc.clientId || tapClient) && !isTapUpdateRead) {
      const { status, ...refusal } = tapProtocolRefusal(req.headers[TAP_PROTOCOL_HEADER]) ?? {};
      if (status) return send(status, { ...refusal, update: await tapUpdateAdvert() });
    }
    // Card glmps-2-0-runtime-146: a client's write to one card (PATCH, devlog,
    // gate, progress, merge request) reaches only a card it filed. No card is
    // launched on a client, so its worker owns nothing else, and a merge
    // request on any other card would have the queue merge a PR and close it.
    // Which routes those are is the route's own `clientOwnsCard` flag (card
    // glmps-2-0-220), so a new card-write route cannot be left off a list here.
    const clientCardRoute = _acc.clientId && req.method !== 'GET' && req.method !== 'HEAD'
      ? matchRoute(req.method, u.pathname)
      : null;
    if (clientCardRoute?.route.clientOwnsCard) {
      const card = backlogStore.load(P.stateDir).items.find((i) => i.id === clientCardRoute.params.id);
      if (!card) return send(404, { error: 'item not found' });
      if (!clientOwnsCard(card, _acc.clientId)) return send(403, { error: 'client-scope', field: 'owner' });
    }
    try {
      if (isHeartbeat) {
        if (!tapClient) return send(401, { error: 'unauthorized' });
        let body; try { body = JSON.parse((await readBody(req, { maxBytes: 64 * 1024 })) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'body must be an object' });
        let row;
        try { row = clientStore.heartbeat(tapClient.id, { tapVersion: body.tapVersion, spoolDepth: body.spoolDepth, dataRoots: body.dataRoots, tools: body.tools, projectRoots: body.projectRoots }); }
        catch (e) { return send(400, { error: e?.message || 'invalid heartbeat' }); }
        if (!row) return send(401, { error: 'unauthorized' });
        return send(200, { ok: true, clientId: row.id, protocol: { current: TAP_PROTOCOL, min: TAP_PROTOCOL_MIN }, serverTime: Date.now(), update: await tapUpdateAdvert() });
      }
      // Spool shipper (task 9): the client id is the token's, never the body's;
      // records at or below the client's high-water mark are dropped as replays.
      if (isTapIngest) {
        if (!tapClient) return send(401, { error: 'unauthorized' });
        if (!tapIngest) return send(503, { error: 'tap ingest store unavailable' });
        let raw;
        try { raw = await readBody(req, { maxBytes: TAP_INGEST_MAX_BYTES }); } catch { return send(413, { error: 'batch too large', maxBytes: TAP_INGEST_MAX_BYTES }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const bad = validateBatch(body);
        if (bad) return send(400, { error: bad });
        const priorHighWater = tapIngest.highWater(tapClient.id);
        const out = tapIngest.ingest(tapClient.id, body);
        // The batch is committed; mapping spans is best effort and never fails it.
        for (const r of body.records) {
          if (r.kind !== 'otel' || r.seq <= priorHighWater) continue;
          try { for (const [sid, evs] of groupBySession(otelToEvents(r.payload, { clientId: tapClient.id }))) pushEvents(sid, evs); }
          catch (e) { console.error(`[kernel] tap otel record ${r.seq} from ${tapClient.id} not mapped:`, e?.message || e); }
        }
        if (body.spool?.depth !== undefined) {
          try { clientStore.heartbeat(tapClient.id, { spoolDepth: body.spool.depth }); }
          catch (e) { console.error('[kernel] tap ingest depth update failed:', e?.message || e); }
        }
        return send(200, { ok: true, ...out });
      }
      // File mirror (task 10): the client id is the token's, never the body's.
      if (isMirrorAppend || isMirrorSnapshot || isMirrorManifest) {
        if (!tapClient) return send(401, { error: 'unauthorized' });
        if (!tapMirror) return send(503, { error: 'tap mirror store unavailable' });
        if (isMirrorManifest) return send(200, tapMirror.manifest(tapClient.id));
        let raw;
        try { raw = await readBody(req, { maxBytes: TAP_INGEST_MAX_BYTES }); } catch { return send(413, { error: 'body too large', maxBytes: TAP_INGEST_MAX_BYTES }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const out = isMirrorAppend ? tapMirror.append(tapClient.id, body) : tapMirror.snapshot(tapClient.id, body);
        return send(out.status, out.body);
      }
      // Git summaries: the client id is the token's, never the body's.
      if (isTapGit) {
        if (!tapClient) return send(401, { error: 'unauthorized' });
        if (!tapGit) return send(503, { error: 'tap git store unavailable' });
        let raw;
        try { raw = await readBody(req, { maxBytes: TAP_GIT_MAX_BYTES }); } catch { return send(413, { error: 'body too large', maxBytes: TAP_GIT_MAX_BYTES }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const out = tapGit.replace(tapClient.id, body);
        return send(out.status, out.body);
      }
      if (u.pathname === '/api/health') return send(200, { ok: true });
      // the kernel's liveness contract, in-memory only (no file read, no
      // subprocess) so it can never itself be the thing that is unhealthy.
      // open_obligations is a live countOpen(); null only if the
      // obligations store failed to open at boot.
      if (u.pathname === '/healthz' && req.method === 'GET') {
        // Scan 2026-10-15 F7: failure detail for loopback or token holders only.
        const detailed = isLoopback(peer) || tokenMatches(presentedTokenFrom(req.headers), accessToken);
        const kernel = detailed ? {
          ...startsSummary(readStarts(P.stateDir)),
          shell: { last_poll_s: shellPolledAt === null ? null : Math.round((Date.now() - shellPolledAt) / 1000), pickup: pickupSummary(shellPickups, { claimWaitMs: gitopsClaimWaitMs }).stats },
        } : null;
        return send(200, buildHealthz({ version: kernelVersion, bootTs, loops: loopRegistry.snapshot(), openObligations: obligationStore ? obligationStore.countOpen() : null, lastEventTs, eventLoopDelay: eventLoopDelay.read(), detailed, kernel }));
      }
      // A registered handler gets first refusal before the flat if-chain
      // below. Routes were registered once above, at server startup
      // (glmps-106 item 1), so this per-request block only dispatches.
      // `send` is built fresh per request (same shape the old closed-over
      // one had) and passed through the context object so handlers defined
      // outside this callback can still call send(code, obj).
      {
        const rmatch = matchRoute(req.method, u.pathname);
        if (rmatch) {
          // Awaited so a handler that throws after an await answers through
          // this handler's catch instead of becoming an unhandled rejection.
          return await rmatch.route.handle(req, res, { params: rmatch.params, send, url: u, access: _acc });
        }
      }
      const iconMatch = u.pathname.match(/^\/api\/icon\/([^/]+)$/);
      if (iconMatch) {
        const tool = iconMatch[1];
        const iconPath = ICON_PATHS[tool];
        if (!iconPath) return send(404, { error: 'icon not found' });
        const ext = path.extname(iconPath).toLowerCase();
        const contentType = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': contentType, 'cache-control': 'max-age=3600' });
        return res.end(fs.readFileSync(iconPath));
      }
      // Deliberately tiny sibling of /api/state, for hooks that only need to know
      // who else is alive. /api/state is ~1.35 MB and grows with all-time session
      // history; concurrency-warn budgeted 900ms for it, lost the race
      // intermittently, and its catch turned every timeout into "all clear"
      // (glmps-149). This response is bounded by the live window, not history.
      if (u.pathname === '/api/sessions/live') {
        const nowMs = Date.now();
        const list = index.list({ sinceTs: nowMs - DEFAULT_STALE_MS })
          .map(r => ({ id: r.id, cwd: r.cwd ?? null, lastTs: r.lastTs ?? 0 }));
        return send(200, { sessions: list, now: nowMs, staleMs: DEFAULT_STALE_MS });
      }
      if (u.pathname === '/api/state') {
        const sid = u.searchParams.get('session');
        // Read out here: the block below shadows `u` with its usage split.
        const feedPaging = { limit: u.searchParams.get('limit'), before: u.searchParams.get('before') };
        if (sid) {
          const __PERF = !!env.GLMPS_PERF_TRACE;
          const __t = {};
          const __mark = (k) => { __t[k] = Date.now(); };
          __mark('start');
          const s = sessions.find(x => x.id === sid);
          if (s) {
            if (s.tool === 'antigravity' && s.format === 'log' && s.logPath)
              replayIfEmpty(sid, s.logPath, extractAgEvents);
            else if (s.tool === 'claude-code' && s.transcriptPath)
              replayIfEmpty(sid, s.transcriptPath, extractClaudeEvents);
            // pb-only: no replay (binary format - no parseable events)
          }
          __mark('afterReplay');
          const log = eventLog.get(sid) ?? [];
          const sessionCwd = (s ?? sessions.find(x => x.id === sid))?.cwd ?? index.get(sid)?.cwd ?? null;
          const sessionProjectKey = s?.transcriptPath ? path.basename(path.dirname(s.transcriptPath)) : null;
          const projectMemoryDir  = s?.transcriptPath ? path.join(path.dirname(s.transcriptPath), 'memory') : null;
          // A client session's cwd is client-written and names the client's disk, not
          // this one: walking it would probe server paths (or dial a UNC share with the
          // service's credentials), and this box's CLAUDE.md files never guided it.
          const sessionClientId = s?.clientId ?? index.get(sid)?.clientId ?? null;
          const fromClient = !!sessionClientId;
          const guiding = fromClient ? computeGuiding(null, null, projectMemoryDir) : computeGuiding(sessionCwd, P.claudeDir, projectMemoryDir);
          __mark('afterGuiding');
          // Full skill list from the persisted index (the event-log window can age out early skills).
          const skillsUsed = index.get(sid)?.skillsUsed ?? [];
          const u = splitUsage(inventory, log);
          const usage = { used: u.used, unused: annotateUnused(u.unused, sessionProjectKey, sessionCwd) };
          __mark('afterUsage');
          // Learning loop: fold detected gaps into the persisted queue (dedup).
          // Enrich each gap with its queue item id + status so the per-session
          // callout can act. Guard proposer cutover: there is no
          // auto-apply path any more - every new gap just records the
          // counterfactual shadow observation (gap-pipeline.js), and proposing
          // + landing a guard for it happens later, off the poll path
          // entirely (the GEPA plugin, then an operator's approval).
          //
          // Substrate refactor Phase 1 (glmps-81): gap-detect reads raw events by
          // design, never the memory distiller's condensed facts (see the
          // boundary comment in gap-detect.js). Prefer the durable Phase-0
          // event-log spine for this session as the PRIMARY source, falling back
          // to the existing in-memory/replay-derived `log` unchanged when the
          // spine has nothing for this session yet - e.g. a session that
          // predates Phase 0, or one only ever populated via replayIfEmpty's
          // pure in-memory rehydration (which deliberately never appends to the
          // durable spine, see its own comment above). This keeps old-session
          // behavior byte-identical: readEvents() === [] falls through to
          // exactly the same `log` detectGaps saw before this change.
          const spineEvents = readEvents(P.stateDir, { sessionId: sid });
          const gapDetectEvents = spineEvents.length > 0 ? spineEvents : log;
          // glmps-97: suppress the four skill-gated codes for dispatched
          // Agent(isolation:"worktree") sessions - this child transcript has
          // no visibility into skills the orchestrator already invoked before
          // dispatch (see capability-feed-core.js block comment).
          const rawGaps = filterDispatchedWorktreeGaps(detectGaps(gapDetectEvents, skillsUsed), sessionCwd);
          __mark('afterDetectGaps');
          let lq = learningStore.load(P.stateDir);
          __mark('afterLearningLoad');
          let lqDirty = false;
          const coveredCodes = coveredCodesFromFile(path.join(P.assetsDir, 'CLAUDE.global.md'));
          for (const g of rawGaps) {
            const result = upsertGapAndApply(lq, g, { project: sessionCwd ?? '', sessionId: sid, coveredCodes, clientId: sessionClientId },
              { stateDir: P.stateDir });
            lq = result.lq;
            if (result.dirty) lqDirty = true;
          }
          const reconciled = learningStore.reconcileCoverage(lq, coveredCodes);
          if (reconciled.changed) { lq = reconciled.state; lqDirty = true; }
          __mark('afterUpsertLoop');
          if (lqDirty) learningStore.save(P.stateDir, lq);   // only write when something changed (no per-poll churn)
          __mark('afterLearningSave');
          // Enrich gaps with their queue item id + status for the actionable callout.
          // INVARIANT: this key must match upsertGapInto's. Both run `project` through
          // normalizeProject() inside learning-store.js, so passing the raw sessionCwd
          // here stays in lockstep with the upsert above (raw cwd -> canonical slug).
          // A client session's row is keyed on its client-namespaced slug (card
          // glmps-2-0-runtime-101), so the lookup uses that slug, never the raw cwd.
          // proposedGuard is also passed through (guard proposer cutover, Task 10, fix
          // round 1) so the dashboard's inline Approve action can tell whether this
          // item has a rule to land before offering it - a gap item's own proposedGuard
          // is null until an operator sets one or a GEPA proposal is separately approved.
          const gaps = rawGaps.map(g => {
            const project = sessionClientId ? learningStore.projectKey(sessionCwd ?? '', { clientId: sessionClientId }) : sessionCwd ?? '';
            const key = learningStore.dedupKey({ source: 'gap', code: g.code, project });
            const it = lq.items.find(i => i.id === key);
            return { ...g, id: it ? it.id : null, status: it ? it.status : 'pending', proposedGuard: it ? it.proposedGuard : null };
          });
          __mark('afterGapsEnrich');
          // Done-gate results (Stop-hook acceptance gate): merge this session's gate
          // results into the feed/context as shared-shape events, bound by session id.
          let dgEvents = [];
          try { dgEvents = doneGateEvents(fs.readFileSync(path.join(P.doneGateDir, `${sid}.jsonl`), 'utf8'), sid); } catch {}
          __mark('afterDoneGate');
          // Same mixed ts shapes as the workspace tick; paging relies on this order.
          const feedLog = dgEvents.length ? [...log, ...dgEvents].sort((a, b) => tsMs(a.ts) - tsMs(b.ts)) : log;
          const loop = loopStage(feedLog, guiding, gaps);
          __mark('afterLoopStage');
          const scope = sessionScope(
            feedLog.filter(e => e.kind === 'file-edit').map(e => e.path),
            { projectRoot: sessionCwd, config: P.zoneConfig });
          __mark('afterScope');
          // Agent workspace (observatory), glmps-98: the observe+divergence
          // compute now runs inside pollCore() for every live session, every
          // tick (see computeWorkspaceForSession) - fleet-wide, even with no
          // dashboard open. This handler just reads the already-computed
          // snapshot; it no longer computes or persists anything itself.
          const workspace = readWorkspace(P.stateDir, sid);
          // per-session fitness rollup - measurables whose evidence names
          // this session. Sibling fail-open block per the Coordination
          // Contract's additive-field rule (A=`workspace`, C1=`fitness`).
          let fitness = null;
          try {
            const sessionMeasurables = listMeasurables(P.stateDir).filter(m => m.evidence?.sessionId === sid);
            fitness = buildMeasurablesScoreboard(sessionMeasurables);
          } catch { /* fail-open: fitness is non-critical */ }
          if (__PERF) {
            const keys = ['start','afterReplay','afterGuiding','afterUsage','afterDetectGaps','afterLearningLoad','afterUpsertLoop','afterLearningSave','afterGapsEnrich','afterDoneGate','afterLoopStage','afterScope'];
            const parts = [];
            for (let i = 1; i < keys.length; i++) parts.push(`${keys[i]}=${__t[keys[i]] - __t[keys[i-1]]}ms`);
            console.log(`[perf] /api/state?session=${sid} logLen=${log.length} total=${Date.now() - __t.start}ms ${parts.join(' ')}`);
          }
          let card = null;
          try { card = sessionCards.detail(sid); } catch { /* fail-open: the card is additive */ }
          let outcome = null;
          try { outcome = sessionOutcomes(sid); } catch { /* fail-open: the outcome is additive */ }
          let learning = null;
          try { learning = sessionLearningFor(sid, { items: lq.items, fitness }); } catch { /* fail-open: learning is additive */ }
          let refusals = null;
          try { refusals = sessionRefusals(readCapped(path.join(P.stateDir, 'guards', 'refusals.ndjson'), { limit: Infinity }), sid, card?.id ?? null); } catch { /* fail-open: refusals are additive */ }
          let touch = null;
          try { touch = sessionTouch(feedLog); } catch { /* fail-open: the rollup is additive */ }
          // Only the returned events are paged; every rollup above read the whole log.
          const { events, page } = pageFeed(feedLog, feedPaging);
          return send(200, { events, page, contextNow: contextNow(feedLog), usage, guiding, skillsUsed, gaps, loop, scope, workspace, fitness, card, outcome, learning, refusals, touch });
        }
        // ?slim=1 (the shell's periodic refresh) and ?fields=a,b (one-time lens
        // loads) skip the ~2 MB of history and inventory the tick never reads.
        const slim = u.searchParams.get('slim') === '1';
        const wanted = (u.searchParams.get('fields') ?? '').split(',').map(x => x.trim()).filter(Boolean);
        const toolDetection = detectAll(P);
        // Per-tool session counts from current sessions list
        const toolCounts = {};
        for (const s of sessions) toolCounts[s.tool] = (toolCounts[s.tool] ?? 0) + 1;
        const tools = toolDetection.map(t => ({ ...t, sessionsFound: toolCounts[t.id] ?? 0 }));
        // Stage-board model: per-session work-phase (from events), git working-tree
        // status (non-blocking, TTL-cached), follow-up counts (backlog), and the
        // server-side vitals derivation. All composed by composeBoard(), shared
        // with the vitals sampler tick so the two cannot drift (glmps-152).
        // Still compute-on-read: composeBoard recomputes per call, no cache.
        const { summaries, board, health } = composeBoard(Date.now());
        const cards = sessionCards();
        if (slim) {
          return send(200, buildSlimState({ sessions: withCards(summaries, cards), history: withCards(index.list({}).slice(0, SLIM_HISTORY), cards), tools, adapterHealth: health, board }, { include: u.searchParams.get('include') }));
        }
        const full = { sessions: withCards(summaries, cards), inventory,
          usage: (!wanted.length || wanted.includes('usage')) ? splitUsage(inventory, [...eventLog.values()].flat()) : undefined,
          history: withCards(index.list({}), cards), tools, adapterHealth: health, board };
        return send(200, wanted.length ? pickFields(full, wanted) : full);
      }

      // route-registry.js registrations, before the matchRoute dispatcher).
      // The dispatcher gives these first refusal; nothing to match inline here.

      if (u.pathname === '/api/graph') {
        // Card glmps-2-0-101: ship is the default scope. machine serves only the
        // merged machine graph; ship serves a project's own graph, or with no
        // project the merged ship graph. graphLabel tells the Map which it is.
        const sc = parseGraphScope(u.searchParams.get('scope'));
        if (!sc.ok) return send(400, { error: sc.error });
        if (sc.scope === 'machine') {
          const mp = machineGraphPaths(P.stateDir);
          const manifest = readJsonSafe(mp.manifest);
          const graph = fs.existsSync(mp.graph) ? loadGraph(mp.graph, { config: P.zoneConfig, focus: u.searchParams.get('focus') ?? '' }) : null;
          return send(200, {
            scope: 'machine', project: null, graph, graphRoot: null, zoneConfig: P.zoneConfig,
            graphLabel: graphLabel({ scope: 'machine', repoCount: Array.isArray(manifest?.roots) ? manifest.roots.length : undefined }),
            enabled: currentGraphConfig().machine.enabled, builtAt: manifest?.builtAt ?? null,
          });
        }
        const explicit = u.searchParams.get('project');
        const sessionCwd = explicit ? null : (sessions.find(s => s.id === u.searchParams.get('session'))?.cwd ?? null);
        const pr = resolveProjectParam(explicit || sessionCwd);
        // An explicit ?project= that is refused is an error; a session cwd that
        // is not a graph root (a private dir, a scratch dir) just has no graph.
        if (!pr.ok && explicit) return send(pr.status, { error: pr.error });
        const root = pr.ok ? pr.root : null;
        const project = explicit || sessionCwd || null;
        const gp = graphPathFor(root);
        let headCommit = null;
        if (root) {
          try { headCommit = await new Promise(res =>
            execFile('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true }, (e, out) => res(e ? null : out.trim()))); } catch {}
        }
        // Upgrade-plan item 3: rank toward what the conversation names. An
        // explicit ?focus= wins; else the requesting session's prompts and
        // touched paths.
        const sessionId = u.searchParams.get('session');
        const focus = u.searchParams.get('focus') ?? (sessionId ? focusFromEvents(eventLog.get(sessionId)) : '');
        if (!root && !project) {
          const sp = shipGraphPaths(P.stateDir).graph;
          const graph = fs.existsSync(sp) ? loadGraph(sp, { config: P.zoneConfig, focus }) : null;
          return send(200, { scope: 'ship', project: null, graph, graphRoot: null, zoneConfig: P.zoneConfig,
            graphLabel: graphLabel({ scope: 'ship', merged: !!graph }) });
        }
        const graph = gp ? loadGraph(gp, { config: P.zoneConfig, headCommit, verifiedAtCommit: root ? verifiedCommitFor(graphIntegrityStore, root) : null, focus }) : null;
        const graphRoot = gp ? path.dirname(path.dirname(gp)).replace(/\\/g, '/') : null;
        // Last classification the timers or the panel ran; no git probe per request.
        const rootScope = root ? lastGraphRoots.find(r => normProjectKey(r.root) === normProjectKey(root))?.scope
          ?? (normProjectKey(root) === normProjectKey(REPO_ROOT) ? 'ship' : null) : null;
        return send(200, { scope: 'ship', project, graph, graphRoot, zoneConfig: P.zoneConfig,
          graphLabel: graphLabel({ scope: 'ship', project: project ?? root, rootScope }) });
      }
      if (u.pathname === '/api/agents') {
        const fleet = scanFleet({ agentsDir: P.agentsDir, pluginsCacheDir: P.pluginsCacheDir, enabledPlugins: readEnabledPlugins() });
        // Usage comes from the PERSISTED index, not the in-memory eventLog:
        // that log is a per-session ring (cap 2000) rebuilt on restart, so it
        // only ever showed the live window.
        const usage = aggregateAgentUsage(index.list({}));
        const known = new Set();
        const agents = fleet.agents.map(a => {
          const key = (a.name ?? '').toLowerCase();
          known.add(key);
          const u2 = usage.get(key);
          return { ...a,
            dispatchCount: u2?.dispatches ?? 0,
            modelSplit: u2?.modelSplit ?? { sonnet: 0, haiku: 0, opus: 0, none: 0 },
            lastUsed: u2?.lastUsed ?? null };
        });
        // An agent seen in history but no longer installed is surfaced, not dropped.
        for (const [name, u2] of usage) {
          if (known.has(name)) continue;
          agents.push({ name, source: 'unknown', model: null,
            dispatchCount: u2.dispatches, modelSplit: u2.modelSplit, lastUsed: u2.lastUsed });
        }
        return send(200, { agents });
      }
      if (u.pathname === '/api/usage') {
        return send(200, readUsage(P.stateDir));
      }
      if (u.pathname === '/api/usage/providers' && req.method === 'GET') {
        const hours = Number(u.searchParams.get('hours'));
        return send(200, {
          ...readProviderSpend(P.stateDir, { hours: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 90) : 168 }),
          actions: readActionsMinutes(P.stateDir, { allowance: cfg.actionsMinutes.allowance }),
        });
      }
      if (u.pathname === '/api/usage/actions' && req.method === 'GET') {
        return send(200, { ...readActionsMinutes(P.stateDir, { allowance: cfg.actionsMinutes.allowance }), thresholds: cfg.actionsMinutes.thresholds });
      }
      // QA Trends panel: reads the qa-trends-store; ?refresh=1 samples the
      // latest completed CI run once (bounded, fail-open) before responding.
      // Plain GET just reads the store - no gh call, always fast.
      if (u.pathname === '/api/qa-trends' && req.method === 'GET') {
        if (u.searchParams.get('refresh')) {
          try { await sampleLatestRun(P.stateDir, await qaGhOpts()); } catch { /* fail-open */ }
        }
        return send(200, qaTrendsView(readQaTrends(P.stateDir)));
      }
      // Vitals Trends panel (docs/superpowers/specs/2026-07-22-vitals-trends-
      // design.md, Step 2): reads the vitals-trends-store, trailing-window
      // read. ?window accepts '<n>h' or '<n>m' (default 2h, clamped to the
      // store's 24h retention); unparseable falls back to the default rather
      // than erroring. No sampling here, plain GET just reads the store.
      if (u.pathname === '/api/vitals-trends' && req.method === 'GET') {
        const windowMs = parseWindowMs(u.searchParams.get('window'));
        const points = readVitalsTrends(P.stateDir, { sinceMs: Date.now() - windowMs });
        return send(200, { points });
      }
      // Capture-parity: which agent tools we target + whether an adapter exists.
      if (u.pathname === '/api/coverage' && req.method === 'GET') {
        const tools = TOOL_REGISTRY.map(t => ({
          id: t.id, displayName: t.displayName, popularityWeight: t.popularityWeight,
          captureSurface: t.captureSurface, hasAdapter: !!t.adapter, speculative: !!t.speculative, reference: t.id === REFERENCE_TOOL,
        }));
        return send(200, {
          reference: REFERENCE_TOOL, tools,
          covered: tools.filter(t => t.hasAdapter).length,
          uncovered: tools.filter(t => !t.hasAdapter).map(t => t.id),
        });
      }
      // Dashboard alert center: flags GLMPS already raises (poison-quarantine + capture gaps).
      if (u.pathname === '/api/alerts' && req.method === 'GET') {
        const __PERF = !!env.GLMPS_PERF_TRACE;
        const __t = {}; const __mark = (k) => { __t[k] = Date.now(); };
        __mark('start');
        const alerts = collectCurrentAlerts();
        __mark('afterCollect');
        // Alert -> Evaluation-loop adapter (glmps alerts-into-evaluation-loop):
        // feed the learnable subset through the learning-store/shadow-arm
        // pipeline on every poll, gated by the persisted seen-set so this is
        // cheap (a no-op) once an occurrence has already been recorded.
        // Fail-open - primeAlertsIntoLearning never throws.
        primeAlertsIntoLearning(alerts);
        __mark('afterPrime');
        if (__PERF) {
          const keys = ['start','afterCollect','afterPrime'];
          const parts = [];
          for (let i = 1; i < keys.length; i++) parts.push(`${keys[i]}=${__t[keys[i]] - __t[keys[i-1]]}ms`);
          console.log(`[perf] /api/alerts cachedRepos=${unmergedRepoCache.repos.length} total=${Date.now() - __t.start}ms ${parts.join(' ')}`);
        }
        // Stamp operator acks (glmps-70), then drop acked alerts from the default
        // response so a reviewed alert stays cleared without config-allowlisting
        // it - ?all=1 brings them back (still stamped acknowledged:true) for the
        // Alerts page's "Show dismissed" toggle. Re-firing with new evidence
        // (new session/path) derives a new dedup id, so it is never suppressed.
        const stamped = applyAcks(alerts, loadAcks(P.alertAcksFile));
        const unacked = stamped.filter(a => !a.acknowledged);
        // Vitals Trends sampler (Step 2): feed the shared last-known
        // alert-count cache on every call, so a browser polling this route
        // keeps the tick's own alerts field fresh "for free" and the tick
        // never has to run collectCurrentAlerts() itself. See
        // decideAlertsSource's header comment (vitals-trends-store.js).
        alertCountCache = { value: unacked.length, ts: Date.now() };
        alertListCache = { alerts: unacked, ts: Date.now() };
        const visible = u.searchParams.get('all') ? stamped : unacked;
        // Topbar poll stays lean; the Alerts page asks for ?evidence=1 to get the
        // flagged file(s) + diffs per alert.
        const allEvents = u.searchParams.get('evidence') ? [...eventLog.values()].flat() : null;
        const out = allEvents ? attachEvidence(visible, allEvents) : visible;
        return send(200, { alerts: out, summary: summarizeAlerts(visible), attention: groupAlerts(visible) });
      }
      // Operator acknowledge/dismiss for a single alert id (glmps-70). Persisted
      // (survives restarts); { id, undo:true } reverses a previous ack.
      if (u.pathname === '/api/alerts/ack' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return send(400, { error: 'id required' });
        if (body.undo) { unackAlertId(P.alertAcksFile, id); return send(200, { acknowledged: false, id }); }
        ackAlertId(P.alertAcksFile, id);
        return send(200, { acknowledged: true, id });
      }
      // Priming hook (glmps alerts-into-evaluation-loop): run the alert -> gap
      // adapter over the CURRENT alerts once, on demand - e.g. right after
      // deploying this feature, to seed the learning loop from alerts that
      // already exist instead of waiting for the next dashboard poll to do it
      // implicitly. Idempotent: backed by the same semantic-dedup + alert-seen
      // seen-set GET /api/alerts already uses, so running it twice in a row
      // (or after GET /api/alerts already primed the same alerts) is a no-op.
      if (u.pathname === '/api/alerts/prime' && req.method === 'POST') {
        const alerts = collectCurrentAlerts();
        const result = primeAlertsIntoLearning(alerts);
        return send(200, { ok: true, ...result });
      }
      // The server is the ONLY writer of the control record. The PreToolUse
      // hook that consumes it runs inside the agent's process, so routing every
      // mutation through here is what keeps it free of a cross-process
      // read-modify-write race. See server/lib/orchestration/control-store.js.
      const stopMatch = u.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (stopMatch && (req.method === 'POST' || req.method === 'DELETE')) {
        const sessionId = decodeURIComponent(stopMatch[1]);
        if (req.method === 'DELETE') { ctlClearStop(P.stateDir, sessionId); return send(200, { ok: true, stopped: false }); }
        let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        ctlSetStop(P.stateDir, sessionId, {
          reason: (typeof body.reason === 'string' && body.reason.trim()) ? body.reason.trim() : 'stopped by the operator',
          from: typeof body.from === 'string' ? body.from : 'operator',
          ts: Date.now(),
        });
        return send(200, { ok: true, stopped: true });
      }
      // Open a gate. The id is minted HERE and any client-supplied id is
      // ignored: otherwise one session could open a gate under an id another
      // session is polling and have that session released by the wrong answer.
      if (u.pathname === '/api/control/gate' && req.method === 'POST') {
        let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (!sessionId) return send(400, { error: 'sessionId required' });
        const id = `g-${++gateSeq}-${Date.now().toString(36)}`;
        ctlOpenGate(P.stateDir, sessionId, { id, tool: body.tool ?? null, summary: body.summary ?? '', ts: Date.now() });
        gateSessions.set(id, sessionId);
        onGateOpened({ id, sessionId, tool: body.tool ?? null, summary: body.summary ?? '' });
        return send(200, { id });
      }
      const gatePollMatch = u.pathname.match(/^\/api\/control\/gate\/([^/]+)$/);
      if (gatePollMatch && req.method === 'GET') {
        const id = decodeURIComponent(gatePollMatch[1]);
        const sessionId = u.searchParams.get('session') || gateSessions.get(id) || '';
        const rec = sessionId ? ctlReadControl(P.stateDir, sessionId) : null;
        if (rec?.gate?.id !== id) return send(404, { error: 'unknown gate' });
        return send(200, { decision: rec.gate.decision, by: rec.gate.decidedBy, reason: rec.gate.reason });
      }
      const gateDecideMatch = u.pathname.match(/^\/api\/control\/gate\/([^/]+)\/decision$/);
      if (gateDecideMatch && req.method === 'POST') {
        const id = decodeURIComponent(gateDecideMatch[1]);
        let body = {}; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const sessionId = gateSessions.get(id)
          ?? ctlFindGate(P.stateDir, sessionSummaries().map(s => s.id), id)?.sessionId
          ?? null;
        if (!sessionId) return send(404, { error: 'unknown gate' });
        const r = ctlDecideGate(P.stateDir, sessionId, id, {
          decision: body.decision === 'approved' ? 'approved' : 'denied',
          by: body.by ?? 'operator', reason: body.reason ?? null, ts: Date.now(),
        });
        // null = already decided. Reported as a conflict rather than swallowed,
        // so a double-click cannot silently look like it flipped the verdict.
        if (!r) return send(409, { error: 'gate already decided' });
        return send(200, { ok: true, decision: r.gate.decision });
      }
      if (u.pathname === '/api/report/baseline' && req.method === 'GET') {
        const items = backlogStore.load(P.stateDir).items;
        const quarantined = items.filter(i => i.quarantined).map(i => ({
          id: i.id, title: i.title, flags: i.provenance?.flags ?? [], critical: false,
          ts: i.updatedTs ?? i.createdTs ?? i.ts ?? 0,
        }));
        const byTool = {};
        for (const t of TOOL_REGISTRY) if (!t.adapter && t.popularityWeight >= 3) byTool[t.id] = 0;
        const allEvents = [...eventLog.values()].flat();
        const injections = scanEventsForInjection(allEvents, { allowDomains: alertRules.injection?.allowDomains ?? [] });
        const egress = detectEgress(allEvents, { projectRoot: REPO_ROOT });
        const rawAlerts = collectAlerts({ quarantined, coverage: { byTool }, injections, egress, attestation: [], unmerged: gatherUnmergedFindings(items), captureIgnore: alertRules.capture?.ignoreTools ?? [],
          concurrentWriters: detectConcurrentWriters({ sessions: index.list({}), worktreesDir: P.worktreesDir, nowMs: Date.now() }), integrity: recentIntegrity(), adapterHealth: adapterHealth(),
          scutChannelHealth: scutChannelHealth(P.scutChannelHealthDir), graphSyncHealth: currentGraphSyncHealth(), graphIntegrity: currentGraphIntegrity(), loopHealth: loopRegistry.snapshot(), obligations: openObligationsOrEmpty(), guardFailOpen: guardFailOpenRecent(),
          kernelHealth: computeKernelHealth() });
        // Same ack-filtering as GET /api/alerts (glmps-70): a reviewed/dismissed
        // alert stays out of the baseline report by default; ?all=1 restores it.
        const stampedAlerts = applyAcks(rawAlerts, loadAcks(P.alertAcksFile));
        const alerts = u.searchParams.get('all') ? stampedAlerts : stampedAlerts.filter(a => !a.acknowledged);
        const coverageTools = TOOL_REGISTRY.map(t => ({
          id: t.id, displayName: t.displayName, popularityWeight: t.popularityWeight,
          captureSurface: t.captureSurface, hasAdapter: !!t.adapter, speculative: !!t.speculative, reference: t.id === REFERENCE_TOOL,
        }));
        const coverage = {
          reference: REFERENCE_TOOL,
          tools: coverageTools,
          covered: coverageTools.filter(t => t.hasAdapter).length,
          uncovered: coverageTools.filter(t => !t.hasAdapter).map(t => t.id),
        };
        const byTool2 = {};
        for (const s of sessions) byTool2[s.tool] = (byTool2[s.tool] ?? 0) + 1;
        const sessionSummary = { total: sessions.length, byTool: byTool2 };
        const clientName = u.searchParams.get('client') || '';
        const data = {
          generatedAt: new Date().toISOString(),
          client: clientName ? { name: clientName } : undefined,
          coverage,
          sessions: sessionSummary,
          egress,
          injection: injections,
          alerts,
          roadmap: [],
        };
        const html = renderBaselineReport(data);
        const download = u.searchParams.get('download') === '1';
        const headers = { 'content-type': 'text/html; charset=utf-8' };
        if (download) headers['content-disposition'] = 'attachment; filename="ai-usage-risk-baseline.html"';
        res.writeHead(200, headers);
        return res.end(html);
      }
      // GET  /api/governance/policy - read current policy (or defaults when unconfigured)
      // PUT  /api/governance/policy - save policy + targets (mutating; token-guarded)
      // POST /api/governance/policy/preview - per-target diff preview, no writes
      // POST /api/governance/policy/push - write managed sections to vendor files (mutating)

      // Shared push orchestration - used by POST .../push and by PUT when autoPush is on.
      // Writes managed sections to the selected vendor targets (guarded), records each
      // managed-body hash into requiredFiles (managed:true), and persists the baseline.
      const runPush = (baseline, bp, filterVendors) => {
        const policy  = Array.isArray(baseline.policy)  ? baseline.policy  : [];
        const targets = Array.isArray(baseline.targets) ? baseline.targets : [];
        const selectedTargets = filterVendors ? targets.filter(t => filterVendors.has(t.vendor)) : targets;
        const pushGuard = makeWritePathGuard({ repoRoot: REPO_ROOT, liveInstallPaths: cfg.liveInstallPaths });
        const pushResults = applyPush({
          targets: selectedTargets,
          policy,
          readFile: p => fs.readFileSync(path.resolve(REPO_ROOT, p), 'utf-8'),
          exists:   p => { try { fs.accessSync(path.resolve(REPO_ROOT, p)); return true; } catch { return false; } },
          guard:    pushGuard,
        });
        const requiredFiles = Array.isArray(baseline.requiredFiles) ? [...baseline.requiredFiles] : [];
        const coveredTools  = new Set(Array.isArray(baseline.coveredTools) ? baseline.coveredTools : []);
        for (const r of pushResults) {
          if (r.action === 'skipped' || r.action === 'unchanged' || !r.content) continue;
          const abs = path.resolve(REPO_ROOT, r.path);
          try {
            const prev = fs.readFileSync(abs, 'utf-8');
            fs.mkdirSync(fileApi.undoDir, { recursive: true });
            fs.writeFileSync(
              path.join(fileApi.undoDir, crypto.createHash('sha256').update(abs.toLowerCase()).digest('hex') + '.undo'),
              prev,
            );
          } catch { /* file did not exist; no undo needed */ }
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, r.content);
          const managedSha256 = crypto.createHash('sha256').update(normalizeManagedBody(r.managedBody)).digest('hex');
          const vendorInfo = SUPPORTED_VENDORS.find(v => v.id === r.vendor) ?? { label: r.vendor };
          const idx = requiredFiles.findIndex(e => e.path === r.path);
          const entry = { label: vendorInfo.label, path: r.path, tool: r.vendor, sha256: managedSha256, managed: true };
          if (idx !== -1) requiredFiles[idx] = entry;
          else requiredFiles.push(entry);
          coveredTools.add(r.vendor);
        }
        writeBaseline(bp, { ...baseline, requiredFiles, coveredTools: [...coveredTools] });
        return pushResults.map(r => ({ vendor: r.vendor, path: r.path, action: r.action, reason: r.reason }));
      };

      if (u.pathname === '/api/governance/policy/library' && req.method === 'GET') {
        // Serve the Guardrail Policy Library (docs/offering) so the editor's picker can load it.
        try {
          const libPath = path.join(REPO_ROOT, 'docs', 'offering', 'guardrail-policy-library.json');
          return send(200, JSON.parse(fs.readFileSync(libPath, 'utf-8')));
        } catch {
          return send(200, { version: 1, title: 'Guardrail Policy Library', directives: [], packs: [], categories: [], error: 'library not found' });
        }
      }

      if (u.pathname === '/api/governance/policy' && req.method === 'GET') {
        const bp = resolveBaselinePath(REPO_ROOT, cfg);
        const baseline = readBaseline(bp);
        if (!baseline) {
          return send(200, {
            configured: false,
            path: bp,
            policy: [],
            targets: [
              { vendor: 'claude-code', path: 'CLAUDE.md' },
              { vendor: 'agents',      path: 'AGENTS.md' },
              { vendor: 'cursor',      path: '.cursor/rules/glmps-guardrails.mdc' },
              { vendor: 'copilot',     path: '.github/copilot-instructions.md' },
              { vendor: 'gemini',      path: 'GEMINI.md' },
            ],
            autoPush: false,
            vendors: SUPPORTED_VENDORS,
          });
        }
        return send(200, {
          configured: true,
          path: bp,
          policy:  Array.isArray(baseline.policy)  ? baseline.policy  : [],
          targets: Array.isArray(baseline.targets) ? baseline.targets : [],
          autoPush: baseline.autoPush === true,
          vendors: SUPPORTED_VENDORS,
        });
      }

      if (u.pathname === '/api/governance/policy' && req.method === 'PUT') {
        let body; try { body = JSON.parse(await readBody(req)); } catch { return send(400, { error: 'invalid JSON' }); }
        const { ok, errors } = validatePolicyUpdate(body, { repoRoot: REPO_ROOT });
        if (!ok) return send(400, { error: 'Validation failed', errors });

        const bp = resolveBaselinePath(REPO_ROOT, cfg);
        const existing = readBaseline(bp) ?? {};
        // Merge into the existing baseline; preserve client/requiredHooks/coveredTools/requiredFiles
        const updated = {
          ...existing,
          policy:  body.policy  ?? [],
          targets: body.targets ?? [],
          autoPush: body.autoPush === true,
        };
        writeBaseline(bp, updated);
        // Auto-push: when enabled, propagate to the vendor files immediately ("on the fly").
        if (updated.autoPush) {
          const pushed = runPush(updated, bp, null);
          return send(200, { ...updated, pushed });
        }
        return send(200, { ...updated, pushed: null });
      }

      if (u.pathname === '/api/governance/policy/preview' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
        const bp = resolveBaselinePath(REPO_ROOT, cfg);
        const baseline = readBaseline(bp);
        if (!baseline) return send(200, { configured: false, previews: [] });

        const policy  = Array.isArray(baseline.policy)  ? baseline.policy  : [];
        const targets = Array.isArray(baseline.targets) ? baseline.targets : [];
        const filterVendors = Array.isArray(body.vendors) ? new Set(body.vendors) : null;

        const previews = [];
        for (const target of targets) {
          if (filterVendors && !filterVendors.has(target.vendor)) continue;
          const abs = path.resolve(REPO_ROOT, target.path);
          let currentContent = '';
          let exists = false;
          try { currentContent = fs.readFileSync(abs, 'utf-8'); exists = true; } catch {}
          const before = extractManagedSection(currentContent) ?? '';
          const after  = renderPolicyBody(policy, { vendor: target.vendor });
          const action = !exists ? 'created' : (before === after ? 'unchanged' : 'updated');
          previews.push({ vendor: target.vendor, path: target.path, exists, action, before, after });
        }
        return send(200, { configured: true, previews });
      }

      if (u.pathname === '/api/governance/policy/push' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
        const bp = resolveBaselinePath(REPO_ROOT, cfg);
        const baseline = readBaseline(bp);
        if (!baseline) return send(400, { error: 'No governance baseline configured' });

        const filterVendors = Array.isArray(body.vendors) ? new Set(body.vendors) : null;
        return send(200, { results: runPush(baseline, bp, filterVendors) });
      }

      // OpenTelemetry GenAI receiver (hybrid capture): point a harness's OTLP/HTTP exporter
      // (e.g. Claude Code's OTEL_EXPORTER_OTLP_ENDPOINT) here; spans are mapped to events and
      // fed through the same pushEvents pipeline as adapter capture. Accepts the native
      // /api/otel path and the standard OTLP /v1/traces path.
      if ((u.pathname === '/api/otel' || u.pathname === '/v1/traces') && req.method === 'POST') {
        // answer 413 with connection: close BEFORE reading when the declared
        // length is over the cap; on a streamed overflow readBody stops buffering
        // and drains, and the 413 goes out on the still-open socket.
        const tooLarge = () => { if (!res.headersSent) { res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ error: 'otlp body too large (max 1 MiB)' })); } };
        // Closing while the upload is still arriving makes Windows send a RST,
        // and the client sees a reset instead of the 413. So drain (unbuffered)
        // up to OTLP_DRAIN_MAX first; past that, answer at once and accept it.
        const afterDrain = () => {
          if (req.readableEnded || Number(req.headers['content-length']) > OTLP_DRAIN_MAX) return tooLarge();
          let drained = 0;
          req.on('data', (c) => { drained += c.length; if (drained > OTLP_DRAIN_MAX) tooLarge(); });
          req.once('end', tooLarge); req.once('error', () => {}); req.resume();
        };
        if (Number(req.headers['content-length']) > OTLP_MAX_BYTES) return afterDrain();
        let rawOtlp;
        try { rawOtlp = await readBody(req, { maxBytes: OTLP_MAX_BYTES }); }
        catch (e) { if (e.message === 'body too large') return afterDrain(); return send(400, { error: 'otlp body unreadable' }); }
        let payload; try { payload = JSON.parse(rawOtlp || '{}'); } catch { return send(400, { error: 'invalid otlp json' }); }
        const groups = groupBySession(otelToEvents(payload, { clientId: _acc.clientId ?? null }));
        let received = 0;
        for (const [sid, evs] of groups) { pushEvents(sid, evs); received += evs.length; }
        return send(200, { received, sessions: [...groups.keys()] });
      }
      if (u.pathname === '/api/engagement' && req.method === 'GET') {
        return send(200, engagementView(P, adapters));
      }
      // Top-end self-improvement loop: per-session outcome records + per-task-class summary.
      if (u.pathname === '/api/outcomes' && req.method === 'GET') {
        const unit = u.searchParams.get('unit') || undefined;
        const taskClass = u.searchParams.get('taskClass') || undefined;
        return send(200, { outcomes: readOutcomes(P.stateDir, { unit, taskClass }) });
      }
      if (u.pathname === '/api/outcomes/summary' && req.method === 'GET') {
        const rows = readOutcomes(P.stateDir);
        // Diagnostic per-actor split (glmps-72 B2): same rows, grouped by actor
        // first. The default response is byClass plus the gap-14 'other' share.
        if (u.searchParams.get('by') === 'actor') return send(200, summarizeByActor(rows));
        return send(200, { ...summarizeOutcomes(rows), otherShare: otherShare(rows) });
      }
      // Top-end eval/replay set: the fixed task suite a challenger is scored against.
      if (u.pathname === '/api/replay' && req.method === 'GET') {
        return send(200, { tasks: listReplayTasks(P.stateDir), run: replayRunStatus });
      }
      // Rows filter shared by /score, /history, and /baseline-refresh below:
      // every produced OutcomeRow tagged as a run of this replay task,
      // excluding the seed/baseline row itself (unit === 'replay-baseline').
      function replayTaskRuns(id) {
        return readOutcomes(P.stateDir).filter(
          (r) => r?.extra?.replayTask === id && r.unit !== 'replay-baseline'
        );
      }
      // Per-task replay SCORECARD (glmps-24): "did THIS frozen task
      // regress on which metric, vs its OWN baseline" - usable before enough
      // samples accumulate for the population-level mSPRT/CUPED comparison in
      // promotionView() below. Deliberately NOT routed through promotion-view
      // (that's cohort-vs-cohort by `unit`; this is one task vs its own history).
      const replayScoreMatch = u.pathname.match(/^\/api\/replay\/([^/]+)\/score$/);
      if (replayScoreMatch && req.method === 'GET') {
        const id = decodeURIComponent(replayScoreMatch[1]);
        const task = listReplayTasks(P.stateDir).find((t) => String(t.id) === id);
        if (!task) return send(404, { error: 'no replay task with that id' });
        const rows = replayTaskRuns(id);
        let produced = null;
        for (const r of rows) {
          if (!produced || (Number(r.ts) || 0) > (Number(produced.ts) || 0)) produced = r;
        }
        const score = task.baseline && produced ? scoreReplay(task.baseline, produced) : null;
        return send(200, {
          taskId: id,
          hasBaseline: !!task.baseline,
          hasRun: !!produced,
          produced: produced ?? null,
          score,
        });
      }
      // Per-task run HISTORY/trend (glmps-26): /score above only
      // ever surfaces the single most-recent produced run - every earlier
      // run's scorecard was computed and discarded, so there was no way to
      // see whether a task has been trending better or worse across repeated
      // runs, only its current state. Scores EVERY produced run against the
      // same frozen baseline, oldest to newest.
      const replayHistoryMatch = u.pathname.match(/^\/api\/replay\/([^/]+)\/history$/);
      if (replayHistoryMatch && req.method === 'GET') {
        const id = decodeURIComponent(replayHistoryMatch[1]);
        const task = listReplayTasks(P.stateDir).find((t) => String(t.id) === id);
        if (!task) return send(404, { error: 'no replay task with that id' });
        const history = scoreReplayHistory(task.baseline, replayTaskRuns(id));
        return send(200, { taskId: id, hasBaseline: !!task.baseline, history });
      }
      // Re-freeze a task's baseline from a later known-good run (mission-
      // control-26): addReplayTask only ever sets a baseline once (a no-op
      // re-call on an existing id), so a legitimately improved state could
      // never become the new comparison point - every future run stayed
      // scored against a stale baseline forever. Picks FROM the task's own
      // already-recorded runs, never an arbitrary caller-supplied object
      // (same "don't trust an unvalidated POST body as ground truth" posture
      // as the rest of this codebase's write gates). Optional body { ts }
      // selects a SPECIFIC run - the operator has reviewed it and knows it's
      // good, which "later known-good run" implies is not always just
      // "whatever ran most recently"; omitted defaults to the most recent.
      const replayBaselineRefreshMatch = u.pathname.match(/^\/api\/replay\/([^/]+)\/baseline-refresh$/);
      if (replayBaselineRefreshMatch && req.method === 'POST') {
        const id = decodeURIComponent(replayBaselineRefreshMatch[1]);
        const task = listReplayTasks(P.stateDir).find((t) => String(t.id) === id);
        if (!task) return send(404, { error: 'no replay task with that id' });
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const rows = replayTaskRuns(id);
        let chosen = null;
        if (body.ts !== undefined) {
          chosen = rows.find((r) => String(r.ts) === String(body.ts)) ?? null;
          if (!chosen) return send(404, { error: 'no run with that ts for this task' });
        } else {
          for (const r of rows) {
            if (!chosen || (Number(r.ts) || 0) > (Number(chosen.ts) || 0)) chosen = r;
          }
        }
        if (!chosen) return send(400, { error: 'no run to freeze as the new baseline yet \u2014 run this task at least once first' });
        const { task: updated } = refreshReplayBaseline(P.stateDir, id, chosen);
        return send(200, { ok: true, task: updated });
      }
      // Populate the replay/eval set from real OutcomeRows (glmps-82, Phase 2
      // prerequisite): seedFromOutcomes existed but had zero callers, so the
      // set - and therefore the mSPRT/CUPED sequential test - stayed empty.
      // Optional body { n }: target total sample count, default 16 (Open
      // Question 4's ~10-20 paired-samples-per-unit range). Idempotent - 
      // re-running only tops up toward n, never duplicates.
      if (u.pathname === '/api/replay/seed' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const n = Number.isFinite(body.n) ? Math.max(1, Math.floor(body.n)) : undefined;
        return send(200, seedReplaySet(P.stateDir, { n }));
      }
      // Model-migration harness (glmps-68): re-run the frozen replay set
      // headlessly under a model override; each run appends a model-tagged
      // OutcomeRow (unit model-<id>) that /api/promotion can compare. Serial +
      // single-flight - replay runs are real agent runs and cost real quota.
      if (u.pathname === '/api/replay/run' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const model = body.model ?? null;
        if (model !== null && !validModel(model)) return send(400, { error: 'invalid model id' });
        if (replayRunStatus?.running) return send(409, { error: 'a replay run is already in flight', run: replayRunStatus });
        let tasks = listReplayTasks(P.stateDir);
        if (Array.isArray(body.taskIds) && body.taskIds.length) {
          const want = new Set(body.taskIds.map(String));
          tasks = tasks.filter(t => want.has(String(t.id)));
        }
        if (!tasks.length) return send(400, { error: 'no replay tasks (seed the set first)' });
        replayRunStatus = { running: true, model, total: tasks.length, done: 0, startedAt: Date.now(), results: [] };
        (async () => {
          for (const task of tasks) {
            const repo = task.project ? repoForProject(task.project) : null;
            let entry;
            try {
              const r = await runReplayTask({
                stateDir: P.stateDir, task, repo, model, worktreesDir: P.worktreesDir,
                // the server's own injected env joins
                // the test-process signals, same as every other guarded path.
                // Phase C final review, M4: onResolveError reaches reportMiss,
                // so an EPERM/ELOOP realpath failure (never ENOENT, the
                // expected case) surfaces on the health registry, not just
                // console.error.
                gitWriteRefused: (target) => testRealGitWriteRefused(target, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) }),
              });
              entry = { task: task.id, ok: !!r.row, error: r.error ?? null };
            } catch (e) { entry = { task: task.id, ok: false, error: String(e?.message ?? e) }; }
            replayRunStatus.results.push(entry);
            replayRunStatus.done++;
          }
          replayRunStatus = { ...replayRunStatus, running: false, finishedAt: Date.now() };
        })().catch(() => { replayRunStatus = { ...replayRunStatus, running: false, error: true }; });
        return send(200, { started: true, model, tasks: tasks.length });
      }
      // Champion/challenger promotion verdict over per-unit outcome aggregates.
      // ?champion=<unit>&challenger=<unit> override the defaults (incumbent vs next).
      if (u.pathname === '/api/promotion' && req.method === 'GET') {
        const champion = u.searchParams.get('champion') || undefined;
        const challenger = u.searchParams.get('challenger') || undefined;
        return send(200, promotionView(readOutcomes(P.stateDir), { champion, challenger }));
      }
      // Shadow/control arm rates (glmps champion-challenger floor, Phase 2):
      // fire-rate vs counterfactual-rate per taskClass, recorded above (the
      // /api/state gap-detect loop) and inside applyGuard (learning-apply.js).
      if (u.pathname === '/api/promotion/shadow' && req.method === 'GET') {
        return send(200, shadowRates(P.stateDir));
      }
      // Substrate Loop: the unified changes ledger - maps memory-distill
      // proposals, learning-store guard items, and promotion champion/challenger
      // comparisons into one SystemChange[] + scoreboard (system-changes.js).
      // Each store read is independently fail-open here too (belt-and-suspenders
      // with system-changes.js's own per-source try/catch): a broken store never
      // 500s the whole ledger, it just contributes zero rows for that loop.
      if (u.pathname === '/api/changes' && req.method === 'GET') {
        let outcomeRows = [], learningItems = [], memoryProposals = [], shadow = { byClass: {} };
        try { outcomeRows = readOutcomes(P.stateDir); } catch { /* fail-open */ }
        try { learningItems = learningStore.load(P.stateDir).items ?? []; } catch { /* fail-open */ }
        try { memoryProposals = mdListProposals(P.stateDir); } catch { /* fail-open */ }
        try { shadow = shadowRates(P.stateDir); } catch { /* fail-open */ }
        // Skill capability-lifecycle (glmps-87/88): same fail-open-per-source
        // belt-and-suspenders style as the reads above. Archive candidates are
        // pure and recomputed on demand here (no persisted state machine - 
        // same precedent as /api/guards/retire-candidates), never cached.
        let skillAdoptItems = [], skillArchiveCandidates = [], skillUpdateCandidates = [];
        try { skillAdoptItems = skillAdoptStore.load(P.stateDir).items ?? []; } catch { /* fail-open */ }
        try {
          const skillEvents = readEvents(P.stateDir, {}).filter(e => e.kind === 'skill');
          const view = buildSkillsView(inventory, skillEvents);
          skillArchiveCandidates = archiveCandidates(view.skills, getObservedSince(P.stateDir), skCfg.exempt, { minObservationDays: skCfg.minObservationDays });
        } catch { /* fail-open */ }
        try { skillUpdateCandidates = updateCandidates(loadProvenance(P.stateDir)); } catch { /* fail-open */ }
        // fold durable measurables into the same unified ledger (registers
        // the 'measurable' SystemChange type - Coordination Contract sec 3).
        let measurables = [];
        try { measurables = listMeasurables(P.stateDir); } catch { /* fail-open */ }
        const changesResult = buildSystemChanges({ outcomeRows, learningItems, memoryProposals, shadow, skillAdoptItems, skillArchiveCandidates, skillUpdateCandidates, measurables });
        // glmps-138 Task 2: paired, denominator-visible Loop metrics over a
        // rolling 30-day window, additive alongside the existing `scoreboard`
        // field (buildLoopMetrics is pure and fail-open on its own, but wrap
        // anyway so a future bug in it can never 500 the whole ledger route).
        // guardFires (glmps-138 I1 fix): the real windowed shadow-arm fire
        // count, over the SAME window buildLoopMetrics uses by default (`now`
        // is pinned here so both computations agree on one instant) - passed
        // in because buildLoopMetrics is pure/I-O-free and cannot read the
        // shadow log itself.
        let loopMetrics = null;
        try {
          const loopNow = Date.now();
          const loopWindowStart = loopNow - LOOP_DEFAULT_WINDOW_DAYS * LOOP_MS_PER_DAY;
          let guardFires = 0;
          try { guardFires = firedCountInWindow(P.stateDir, { windowStart: loopWindowStart, now: loopNow }); } catch { /* fail-open */ }
          loopMetrics = buildLoopMetrics(changesResult.changes, { now: loopNow, guardFires });
        } catch { /* fail-open */ }
        // glmps-138 Task 8 (loop-measurement-honesty): per-type liveness over
        // the same unified ledger - when a capability kind last actually
        // changed state, red past DEFAULT_LIVENESS_STALE_DAYS. Wrapped the
        // same fail-open way as loopMetrics above: buildLiveness is pure, but
        // a future bug in it must never 500 the whole ledger route.
        let liveness = {};
        try { liveness = buildLiveness(changesResult.changes, { now: Date.now() }); } catch { /* fail-open */ }
        return send(200, { ...changesResult, loopMetrics, liveness });
      }
      // Skills observability (v1, read-only): installed-skill inventory joined
      // against durable skill-invocation events for per-skill use counts +
      // last-seen + a never-used seed list. No adopt/retire actions here - 
      // those are separate future tickets.
      if (u.pathname === '/api/skills' && req.method === 'GET') {
        let view = { skills: [], neverUsed: [], installedAvailable: false };
        try {
          const skillEvents = readEvents(P.stateDir, {}).filter(e => e.kind === 'skill');
          view = buildSkillsView(inventory, skillEvents);
        } catch { /* fail-open */ }
        return send(200, view);
      }
      // Gate choke point 3/3 (glmps-72 B3, future seam): a promotion "apply"
      // route (glmps-33 advisory -> apply) does not exist yet - do not build
      // one here. When it lands, gate it exactly like the two choke points
      // above: `if (actors.length) { const gate = gateCheck({ actors, actorId:
      // resolveActor(req), role: 'promote' }); if (!gate.allowed) return
      // send(403, { error: 'forbidden', reason: gate.reason }); }`. Covered by
      // the 'gateCheck seam reserved for a future promotion-apply endpoint'
      // test in server/test/actors.test.js.
      // Finalize one session into an outcome row (idempotent). Driven on demand by a
      // Stop feeder or manual trigger; pulls events from the in-memory log + latest usage.
      // See finalizeAndQueueJudge (defined above, near measurablesTick) for the shared
      // body - the sweep tick below calls the exact same function with an already-due
      // notBefore instead of pushing it idleMs into the future.
      if (u.pathname === '/api/outcomes/finalize' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const sid = body.session;
        if (!sid) return send(400, { error: 'session required' });
        const { row, appended } = finalizeAndQueueJudge(sid, { notBefore: Date.now() + judgeCfg.idleMs });
        return send(200, { row, appended });
      }
      // Card glmps-2-0-runtime-36: the hooks' store writes, as routes, so a hook on a
      // remote client reaches the server's stores. Each calls the same store function
      // the hook called directly. The client id is the access guard's (from the
      // token), never the body's.
      const ingestKind = (
        (u.pathname === '/api/ingest/learning-gaps' && req.method === 'POST')
        || (u.pathname === '/api/ingest/backlog-ticket' && req.method === 'POST')
        || (u.pathname === '/api/ingest/decision-log' && req.method === 'POST')
        || (u.pathname === '/api/ingest/qa-trends' && req.method === 'POST')
      ) ? INGEST_ROUTES[u.pathname] : undefined;
      if (ingestKind) {
        let raw;
        try { raw = await readBody(req, { maxBytes: INGEST_MAX_BODY_BYTES }); } catch { return send(413, { error: 'body too large', maxBytes: INGEST_MAX_BODY_BYTES }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const bad = ingestKind.validate(body);
        if (bad) return send(400, { error: bad });
        try { ingestKind.apply(body, { stateDir: P.stateDir, assetsDir: P.assetsDir, clientId: _acc.clientId ?? null, resolveProject: resolveProjectName }); }
        catch (e) { return send(500, { error: e?.message || 'ingest failed' }); }
        return send(200, { ok: true });
      }
      // D23/D24 judge cutover (glmps-159 task 8): the judge's own ledger,
      // independent of the outcome rows it annotates - readVerdicts/
      // judgeSummary are the SAME reads judge-plugin.test.js exercises
      // directly, just surfaced over the wire.
      if (u.pathname === '/api/judge/verdicts' && req.method === 'GET') {
        return send(200, { verdicts: readVerdicts(P.stateDir) });
      }
      if (u.pathname === '/api/judge/summary' && req.method === 'GET') {
        return send(200, judgeSummary(P.stateDir));
      }
      if (u.pathname === '/api/budget' && req.method === 'GET') {
        // Usage/quota meter: the real Claude.ai plan utilization (5h / weekly /
        // weekly-Sonnet) from /api/oauth/usage - the same data the Claude Code
        // extension shows. Cached ~60s; falls back to claude-manager statusline.json.
        return send(200, await readCombinedBudget());
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(':ok\n\n');
        // Send the build id on connect. EventSource auto-reconnects after a restart,
        // so the client compares this against the first one it saw and reloads on change.
        res.write(`data: ${JSON.stringify({ type: 'hello', buildId })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (u.pathname === '/api/search') {
        const q = u.searchParams.get('q') ?? '';
        const sp = u.searchParams;
        const dr = { from: sp.get('from') || null, to: sp.get('to') || null };
        const filters = {
          messageType: sp.get('messageType') || null,
          hasErrors: sp.get('hasErrors') === '1' || sp.get('hasErrors') === 'true',
          hasToolCalls: sp.get('hasToolCalls') === '1' || sp.get('hasToolCalls') === 'true',
          hasFileChanges: sp.get('hasFileChanges') === '1' || sp.get('hasFileChanges') === 'true',
          dateRange: (dr.from || dr.to) ? dr : null,
          project: sp.get('project') || null,
        };
        const targets = index.list({}).filter(r => r.transcriptPath)
          .map(r => ({ id: r.id, transcriptPath: r.transcriptPath, cwd: r.cwd ?? null }));
        const results = await searchTranscripts(targets, q, { cap: cfg.searchResultCap, filters });
        return send(200, { results: [...results], capped: results.capped === true });
      }
      if (u.pathname === '/api/file' && req.method === 'GET') {
        const filePath = u.searchParams.get('path');
        const tgt = clientTarget({ paths: [filePath], clientId: u.searchParams.get('client') });
        if (tgt.refuse) return sendRefusal(send, tgt);
        if (tgt.target === 'client') { const r = await clientFile(tgt, { op: 'read', path: filePath }); return send(r.status, r.body); }
        return send(200, fileApi.read(filePath));
      }
      if (u.pathname === '/api/file' && req.method === 'PUT') {
        const body = parseRequiredBody(await readBody(req));
        const tgt = clientTarget({ paths: [body.path], clientId: body.clientId });
        if (tgt.refuse) return sendRefusal(send, tgt);
        if (tgt.target === 'client') {
          if (typeof body.content !== 'string') return send(400, { error: 'content must be a string' });
          const r = await clientFile(tgt, { op: 'save', path: body.path, content: body.content, hash: body.hash ?? null, force: body.force === true });
          return send(r.status, r.body);
        }
        try { return send(200, fileApi.save(body.path, body.content, body.hash, { force: body.force === true })); }
        catch (e) { return send(/conflict/i.test(e.message) ? 409 : 403, { error: e.message }); }
      }
      if (u.pathname === '/api/file/undo' && req.method === 'POST') {
        const body = parseRequiredBody(await readBody(req));
        const tgt = clientTarget({ paths: [body.path], clientId: body.clientId });
        if (tgt.refuse) return sendRefusal(send, tgt);
        if (tgt.target === 'client') { const r = await clientFile(tgt, { op: 'undo', path: body.path }); return send(r.status, r.body); }
        return send(200, fileApi.undo(body.path));
      }
      if (u.pathname === '/api/resume' && req.method === 'POST') {
        const body = parseRequiredBody(await readBody(req));
        const tgt = clientTarget({ sessionId: body.sessionId, paths: [body.cwd === '' ? null : body.cwd], clientId: body.clientId });
        if (tgt.refuse) return sendRefusal(send, tgt);
        if (tgt.target === 'client') {
          const cwd = body.cwd ? String(body.cwd) : null;
          if (body.location === 'workspace') {
            if (!cwd) return send(400, { error: 'cwd required to open a workspace on a client' });
            const { id } = launchBroker.enqueue({ origin: 'editor', command: 'open-in-editor', cwd, targetClient: tgt.clientId, action: { kind: 'open', path: cwd } });
            broadcastLaunch(id, 'pending');
            return send(200, { opened: 'queued', launchId: id, client: tgt.clientId, clientName: tgt.client.name });
          }
          if (body.sessionId == null || body.sessionId === '') return send(400, { error: 'sessionId required' });
          const command = resumeCommand(splitNamespacedId(body.sessionId)?.sessionId ?? body.sessionId, claudeCmd);
          if (!command) return send(400, { error: 'sessionId must be a session UUID' });
          const effective = cwd ?? tgt.client.projectRoots?.[0] ?? '.';
          const { id } = launchBroker.enqueue({ origin: 'resume', command, cwd: effective, targetClient: tgt.clientId });
          broadcastLaunch(id, 'pending');
          return send(200, { launched: 'queued', launchId: id, pid: null, cwd: effective, client: tgt.clientId, clientName: tgt.client.name });
        }
        // SECURITY: body.cwd must never reach a
        // shell line unvalidated - a UNC/device path or a shell metacharacter
        // is refused by name, with no stat ever attempted (shellSafePathSyntax).
        // A syntactically safe cwd that just does not exist (or is not a
        // directory) is NOT refused here: Resume falls back to the server's
        // own cwd instead of blocking the whole resume over a stale path -
        // but only for THAT reason: any other stat failure
        // (permissions, a transient I/O error) is a real, unexplained
        // problem and must surface by name, not vanish into the same
        // silent fallback.
        let cwd = null;
        const requestedCwd = body.cwd != null && body.cwd !== '';
        if (requestedCwd) {
          const syn = shellSafePathSyntax(body.cwd);
          if (!syn.ok) return send(400, { error: `cwd refused: ${syn.reason}` });
          const lc = launchCwdCheck(syn.path, launchRoots());
          if (!lc.ok) return send(403, { error: `cwd refused: ${lc.reason}` });
          let st = null;
          try { st = fs.statSync(syn.path); }
          catch (e) {
            if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') return send(500, { error: `cwd check failed: ${e.message}` });
          }
          if (st && st.isDirectory()) cwd = syn.path;
        }
        if (body.location === 'workspace') {
          // Antigravity sessions cannot be resumed; open their folder in the IDE.
          if (!cfg.antigravityCommand) return send(400, { error: 'antigravityCommand not configured' });
          const spawned = spawnEditorApp('resume-workspace', { args: cwd ? [shellArg(cwd)] : [], cwd: cwd ?? undefined });
          // a refusal known BEFORE spawning (service
          // mode, or the I5 test-process backstop) must answer by name -
          // this route used to discard spawnEditorApp's return value and
          // always claim opened: true regardless.
          if (spawned.refusal) return send(spawned.refusal === 'service-mode' ? 409 : 500, { error: spawned.reason });
          // Pre-step (a), Task 12b review: same cwdFallback contract as the
          // resume-a-terminal branch below - a REQUESTED cwd that could not
          // be used must say so (and name the effective cwd it opened
          // instead), rather than reporting an ordinary-looking success.
          const effectiveCwd = cwd ?? fallbackCwd(env);
          return send(200, { opened: true, cwd: effectiveCwd, ...(requestedCwd && cwd === null ? { cwdFallback: true } : {}) });
        }
        // glmps-2-0-30: Resume opens `<cmd> --resume <id>` in Antigravity when
        // it can host it, else in a native terminal (openSession).
        if (body.sessionId == null || body.sessionId === '') return send(400, { error: 'sessionId required' });
        const command = resumeCommand(body.sessionId, claudeCmd);
        // M-iface: a PRESENT but invalid id gets a more
        // specific message than a missing one - the brief's own Interfaces
        // line names both separately.
        if (!command) return send(400, { error: 'sessionId must be a session UUID' });
        const { pid, launchId, target: openedIn } = openSession({ command, cwd, key: 'spawn:resume', origin: 'resume', target: sessionTarget(preferredTarget()) });
        if (!IDE_TARGETS.includes(openedIn) && pid == null && launchId == null) return send(500, { error: 'terminal did not start' });
        // the effective cwd (never null - launchNative
        // itself always falls back to something, fallbackCwd below), with
        // cwdFallback: true when a REQUESTED cwd could not be used, so the
        // caller can say so rather than looking like an ordinary success.
        const effectiveCwd = cwd ?? fallbackCwd(env);
        // Task 12b: a service-mode kernel queued this instead of opening it -
        // `launched: 'queued'` names that so the caller does not show the
        // same "opened" toast for a launch that has not actually happened
        // yet. `'antigravity'` likewise names a launch the companion opens.
        const launched = IDE_TARGETS.includes(openedIn) ? openedIn : launchId ? 'queued' : true;
        return send(200, { launched, pid, cwd: effectiveCwd, launchId, ...(requestedCwd && cwd === null ? { cwdFallback: true } : {}) });
      }
      if (u.pathname === '/api/settings/timezone' && req.method === 'GET') {
        const o = loadOperatorSettings(P.stateDir);
        return send(200, { ...o, label: zoneName(o.timeZone) });
      }
      if (u.pathname === '/api/settings/timezone' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = saveOperatorTimeZone(P.stateDir, body.timeZone);
        if (!r.ok) return send(400, { error: r.error });
        setDisplayTimeZone(r.timeZone);
        return send(200, { timeZone: r.timeZone, source: r.source, label: zoneName(r.timeZone) });
      }
      if (u.pathname === '/api/settings/guard-auto-approve' && req.method === 'GET') {
        return send(200, loadGuardAutoApprove(P.stateDir));
      }
      if (u.pathname === '/api/settings/guard-auto-approve' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const r = saveGuardAutoApprove(P.stateDir, body.enabled);
        if (!r.ok) return send(400, { error: r.error });
        return send(200, { enabled: r.enabled, source: r.source });
      }
      if (u.pathname === '/api/config') {
        const projectRoots = [...new Set(index.list({}).filter(r => !r.clientId).map(r => r.cwd).filter(Boolean))];
        const canLaunch = launchCwdChecker(launchRoots());
        const launchableRoots = projectRoots.filter((r) => canLaunch(r).ok);
        return send(200, { terminals: cfg.terminals, projectRoots, launchableRoots, repoRoot: REPO_ROOT,
          configPath: configFile ?? null, version: PKG.version ?? null, port: actualPort,
          host: bindHost, nonLocal, surface: surfaceConfig(cfg, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      }
      if (u.pathname === '/api/restart' && req.method === 'POST') {
        const service = isServiceMode(env);
        noteStop('restart-requested', requesterOf(req.headers, req.socket?.remoteAddress ?? null));
        send(service ? 202 : 200, { restarting: true, mode: service ? 'service' : (SUPERVISED_AT_BOOT || env.GLMPS_SUPERVISED === '1' ? 'supervised' : 'self-respawn') });
        setTimeout(() => { Promise.resolve().then(() => triggerRestart()).catch((e) => console.error('GLMPS: restart failed', e?.message || e)); }, 200);
        return;
      }
      if (u.pathname === '/api/terminal' && req.method === 'POST') {
        const body = parseRequiredBody(await readBody(req));
        const tgt = clientTarget({ paths: [body.cwd === '' ? null : body.cwd], clientId: body.clientId });
        if (tgt.refuse) return sendRefusal(send, tgt);
        if (tgt.target === 'client') {
          if (body.isolate === true) return send(409, { error: 'isolate is not supported on a client target' });
          const term = (cfg.terminals || []).find((x) => x && x.label === body.terminal);
          if (!term) return send(400, { error: 'unknown terminal' });
          if (typeof term.command !== 'string' || !term.command) return send(400, { error: 'that terminal has no command to run on a client' });
          const effective = body.cwd ? String(body.cwd) : tgt.client.projectRoots?.[0] ?? '.';
          const { id } = launchBroker.enqueue({ origin: 'terminal', command: term.command, cwd: effective, targetClient: tgt.clientId });
          broadcastLaunch(id, 'pending');
          return send(200, { launched: 'queued', launchId: id, pid: null, cwd: effective, worktree: null, client: tgt.clientId, clientName: tgt.client.name });
        }
        // SECURITY: buildTerminalRequest
        // below runs its own fs.statSync as a plain existence check, with no
        // character validation - a shell-metacharacter cwd that also happens to
        // be an illegal filename on this filesystem (a bare double quote, say)
        // would otherwise come back as a generic "cwd not found" instead of
        // being refused BY NAME, masking exactly the hazard this route exists
        // to name. The character/absolute check must run first, with no stat.
        if (body.cwd != null && body.cwd !== '') {
          const syn = shellSafePathSyntax(body.cwd);
          if (!syn.ok) return send(400, { error: `cwd refused: ${syn.reason}` });
          const lc = launchCwdCheck(syn.path, launchRoots());
          if (!lc.ok) return send(403, { error: `cwd refused: ${lc.reason}` });
        }
        const { record, error } = buildTerminalRequest(body, cfg.terminals);
        if (error) return send(400, { error });
        // SECURITY: same rule as /api/resume. buildTerminalRequest
        // only checks that the directory exists, and a directory can be named
        // "a & calc"; refuse any shell metacharacter by name.
        if (record.cwd) {
          const v = shellSafePath(record.cwd, { kind: 'dir' });
          if (!v.ok) return send(400, { error: `cwd refused: ${v.reason}` });
          record.cwd = v.path;
        }
        // Opt-in isolation (glmps-71 A2): provision a private git worktree so this
        // interactive session never shares a checkout with another concurrent one.
        // FAIL-OPEN - any git hiccup falls back to the shared cwd; a launch must
        // never be blocked by isolation.
        // in a test process a real (non-temp) target
        // is refused by name before the .git check and any `git worktree add`
        // (production is unchanged: the predicate is false there).
        if (record.isolate && record.cwd && testRealGitWriteRefused(record.cwd, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) {
          const reason = 'isolate refused: this is a test process and the target repo is not a temp fixture';
          reportMiss('terminal-isolate-test-guard', reason);
          return send(409, { error: reason });
        }
        if (record.isolate && record.cwd) {
          try {
            const repo = record.cwd;
            if (fs.existsSync(path.join(repo, '.git'))) {
              const sessionId = crypto.randomBytes(6).toString('hex');
              const plan = sessionWorktreePlan({ baseDir: P.worktreesDir, project: path.basename(repo), sessionId });
              fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
              const add = worktreeAddRecipe({ repo, dir: plan.dir, branch: plan.branch, startPoint: await freshStartPoint(repo) });
              const added = await runRecipe(add);
              if (added.status !== 0) throw new Error(`git worktree add exited ${added.status}: ${added.stderr.trim().slice(0, 200)}`);
              record.cwd = plan.dir;
              record.worktree = { branch: plan.branch, parent: repo };
            }
          } catch (e) {
            // fail-open: launch in the original cwd unchanged, but say why
            reportMiss('terminal-isolate', `${record.cwd}: ${e?.message ?? e}`);
          }
        }
        // glmps-2-0-218: the preferred IDE when it is live or launchable, else native.
        const { pid, launchId, target: openedIn } = openSession({ command: record.command, cwd: record.cwd, key: 'spawn:terminal', origin: 'terminal', target: sessionTarget(preferredTarget()) });
        if (!IDE_TARGETS.includes(openedIn) && pid == null && launchId == null) return send(500, { error: 'terminal did not start' });
        const launched = IDE_TARGETS.includes(openedIn) ? openedIn : launchId ? 'queued' : true;
        return send(200, { launched, pid, cwd: record.cwd, launchId, worktree: record.worktree ?? null });
      }
      if (u.pathname === '/api/open-in-editor' && req.method === 'POST') {
        const body = parseRequiredBody(await readBody(req));
        const tgt = clientTarget({ paths: [body.path], clientId: body.clientId });
        if (tgt.refuse) return sendRefusal(send, tgt);
        if (tgt.target === 'client') {
          if (typeof body.path !== 'string' || !body.path) return send(400, { error: 'path required' });
          const { id } = launchBroker.enqueue({ origin: 'editor', command: 'open-in-editor', cwd: body.path, targetClient: tgt.clientId, action: { kind: 'open', path: body.path } });
          broadcastLaunch(id, 'pending');
          return send(200, { ok: true, queued: true, launchId: id, client: tgt.clientId, clientName: tgt.client.name });
        }
        // SECURITY: body.path used to be substituted raw into the
        // shell:true argv. The allowlist below says WHERE the file may be, not
        // what its name contains, so validate it first (a named 400) and
        // substitute it quoted.
        //
        // SECURITY: the character/absolute
        // check and FileApi's allowlist check must BOTH run before any stat.
        // The old order called shellSafePath (which stats the path) before
        // fileApi's allowlist check, so an unallowlisted path - a
        // \\host\share UNC path, for instance - still triggered an outbound
        // stat: over SMB that is a real network call, and its
        // success/failure is an existence oracle for a host the allowlist
        // was never meant to let this route touch at all.
        // the allowlist check alone (no file read) - so a
        // refused path answers 403 by name instead of an uncaught
        // readFileSync throw, and an ALLOWED-but-missing/wrong-kind path
        // falls through to shellSafePath's own named 400 below instead of
        // reading (and discarding) the file just to validate permission.
        const syn = shellSafePathSyntax(body.path);
        if (!syn.ok) return send(400, { error: `path refused: ${syn.reason}` });
        const allowed = fileApi.allows(syn.path);
        if (!allowed.ok && !openOnlyApi.allows(syn.path).ok) return send(403, { error: allowed.reason });
        const openKind = body.kind === 'dir' ? 'dir' : 'file';
        const v = shellSafePath(syn.path, { kind: openKind });
        if (!v.ok) return send(400, { error: `path refused: ${v.reason}` });
        const openEditor = resolveOpenEditor();
        if (!openEditor) return send(400, { error: 'no supported IDE found; install one or set antigravityCommand' });
        if (isServiceMode(env)) {
          // Session 0 has no desktop: the shell claims this and opens the editor.
          const { id } = launchBroker.enqueue({ command: 'open-in-editor', cwd: openKind === 'dir' ? v.path : path.dirname(v.path), origin: 'editor', path: v.path });
          broadcastLaunch(id, 'pending');
          return send(200, { ok: true, queued: true, launchId: id });
        }
        const args = cfg.openInEditorArgs.map(a => a.replace('{path}', () => shellArg(v.path)));
        const spawned = spawnEditorApp('open-in-editor', { args, command: openEditor.command });
        if (spawned.refusal) return send(spawned.refusal === 'service-mode' ? 409 : 500, { error: spawned.reason });
        return send(200, { ok: true });
      }
      if (u.pathname === '/api/learning' && req.method === 'GET') {
        const results = ingestResults(P.stateDir);
        if (results.length) {
          let st = learningStore.load(P.stateDir);
          for (const r of results) {
            if (!st.items.find(i => i.id === r.id)) continue;
            if (r.status === 'failed') st = learningStore.markFailed(st, r.id, r.error ?? 'apply failed').state;
            else if (r.status === 'skipped-duplicate') st = learningStore.markSkipped(st, r.id, r.reason ?? 'semantic duplicate of an existing guard').state;
            else st = learningStore.markApplied(st, r.id, r.commit ?? null).state;
          }
          learningStore.save(P.stateDir, st);
        }
        return send(200, learningStore.load(P.stateDir));
      }
      // glmps-140: the four compute*/persist* helper pairs (guard-retire,
      // skill-archive, guard-stale, skill-stale) used to be declared HERE,
      // redeclared on every single request, so GET /api/measurables could
      // call all four as a per-request self-populate side effect (glmps-102,
      // glmps-138). That made the Scoreboard's read route do 4 fs-read plus
      // N fs-write passes on every hit. They're now declared ONCE, in the
      // outer startServer() scope above `const server = http.createServer`
      // (search computeGuardRetireCandidates there), where a scheduled
      // measurablesTick() calls all four instead. This request handler and
      // the two routes below still close over those outer-scope functions
      // by name - only their declaration site moved, not their behavior.
      // Propose-only: guards whose Phase 2 shadow-arm counterfactual has
      // NEVER fired across enough observed sessions. Returns candidates for
      // a human to review - never deletes a guard line itself.
      if (u.pathname === '/api/guards/retire-candidates' && req.method === 'GET') {
        const minObservations = Number(u.searchParams.get('minObservations')) || undefined;
        const candidates = computeGuardRetireCandidates({ minObservations });
        persistGuardRetireCandidates(candidates);
        // excludedGepaGuards: applied GEPA-sourced guards this route does not
        // (yet) evaluate for retirement - see appliedGuardCatalog()'s doc
        // comment for why. Surfaced rather than silently dropped.
        let excludedGepaGuards = 0;
        try { excludedGepaGuards = appliedGuardCatalog().excludedGepaCount; } catch { /* fail-open */ }
        return send(200, { candidates, excludedGepaGuards });
      }
      // Propose-only, read-only skill-lifecycle candidates (glmps-88): long-
      // unused installed skills flagged for archival (never deleted - a human
      // reviews and acts by hand), and - only when the operator has opted
      // into network egress via skillLifecycle.checkUpdates - skills with a
      // known-upstream version bump available. Independent of /api/changes
      // (same dual-surface reasoning as /api/guards/retire-candidates above:
      // a dedicated route for a future focused panel), AND the same
      // candidates flow into /api/changes via skillChanges() for the unified
      // ledger/scoreboard view.
      if (u.pathname === '/api/skills/lifecycle' && req.method === 'GET') {
        const archiveCands = computeSkillArchiveCandidates();
        // persist each archive candidate as a durable measurable (same
        // idempotent-upsert reasoning as the guard-retire route above).
        persistSkillArchiveCandidates(archiveCands);
        let updateCands = [];
        try { updateCands = updateCandidates(loadProvenance(P.stateDir)); } catch { /* fail-open */ }
        return send(200, { archiveCandidates: archiveCands, updateCandidates: updateCands });
      }
      // glmps-138 Task 3 / glmps-115: a dedicated read-only route returning
      // skill-adopt-store's items with their TRUE native 7-status vocab
      // (discovered|quarantined|pending-approval|approved|trialing|kept|
      // rejected) verbatim. /api/changes's skillChanges() intentionally
      // collapses several of those into the shared 5-state SystemChange
      // status axis (approved/trialing -> 'measuring') for the unified
      // ledger - accurate for a ledger row, but it loses the exact native
      // status the Registry view needs to show. Exact-string match on the
      // path, registered here (distinct from, and never shadowing, the
      // exact-match /api/skills/lifecycle route above or the
      // /api/skills/lifecycle/:id/:action regexes below - neither pattern
      // can match the literal string 'lifecycle-candidates').
      if (u.pathname === '/api/skills/lifecycle-candidates' && req.method === 'GET') {
        let adoptItems = [];
        try { adoptItems = skillAdoptStore.load(P.stateDir).items ?? []; } catch { /* fail-open */ }
        const items = adoptItems
          .filter((i) => i && typeof i === 'object' && i.id)
          .map((i) => ({
            id: i.id,
            skill: i.candidate?.name ?? i.gapCode ?? null,
            status: i.status,
            source: i.candidate?.sourceRepo ?? null,
            provenance: i.provenance ?? null,
            ts: i.updatedTs ?? i.createdTs ?? null,
          }));
        return send(200, { items });
      }
      // Skill capability-lifecycle HUMAN-DRIVEN advance path (glmps-13):
      // skill-adopt-store.js's releaseQuarantine/approveCandidate/startTrial/
      // resolveTrial (+ their *In(stateDir) wrappers) were built and unit-tested
      // but had ZERO production callers - a discovered external-skill candidate
      // was structurally stuck at quarantined/pending-approval forever. Each
      // transition below is its OWN explicit POST route (same deliberately-
      // non-generic-PATCH precedent as /api/backlog/:id/approve +
      // backlogStore.approveItemIn) -
      // external-skill instructions are executable
      // content (a poisoning vector), so there is intentionally no generic
      // PATCH and no automated tick that advances a candidate on its own; only
      // an explicit human POST ever changes status. resolve-trial takes the
      // human-measured trial stats (n/counterfactualRate/fireRate) and lets
      // the store's EXISTING resolveTrial() compute the kept/rejected verdict
      // from them (same minObservations/counterfactualRate==0 threshold
      // skill-adopt-store.js already enforces) - the simplest contract that
      // reaches a terminal verdict without inventing new store internals; a
      // human still decides to run the trial and submit its measured result.
      const findSkillAdoptItem = (id) => (skillAdoptStore.load(P.stateDir).items ?? []).find((i) => i.id === id);
      const skAdoptReleaseMatch = u.pathname.match(/^\/api\/skills\/lifecycle\/([^/]+)\/release-quarantine$/);
      if (skAdoptReleaseMatch && req.method === 'POST') {
        const id = decodeURIComponent(skAdoptReleaseMatch[1]);
        if (!findSkillAdoptItem(id)) return send(404, { error: 'no skill-adopt candidate with that id' });
        try {
          const r = skillAdoptStore.releaseQuarantineIn(P.stateDir, id);
          return send(200, { ok: true, item: r.item });
        } catch (e) { return send(400, { error: String(e?.message ?? e) }); }
      }
      const skAdoptApproveMatch = u.pathname.match(/^\/api\/skills\/lifecycle\/([^/]+)\/approve$/);
      if (skAdoptApproveMatch && req.method === 'POST') {
        const id = decodeURIComponent(skAdoptApproveMatch[1]);
        if (!findSkillAdoptItem(id)) return send(404, { error: 'no skill-adopt candidate with that id' });
        try {
          const r = skillAdoptStore.approveCandidateIn(P.stateDir, id);
          return send(200, { ok: true, item: r.item });
        } catch (e) { return send(400, { error: String(e?.message ?? e) }); }
      }
      const skAdoptTrialMatch = u.pathname.match(/^\/api\/skills\/lifecycle\/([^/]+)\/start-trial$/);
      if (skAdoptTrialMatch && req.method === 'POST') {
        const id = decodeURIComponent(skAdoptTrialMatch[1]);
        if (!findSkillAdoptItem(id)) return send(404, { error: 'no skill-adopt candidate with that id' });
        try {
          const r = skillAdoptStore.startTrialIn(P.stateDir, id);
          return send(200, { ok: true, item: r.item });
        } catch (e) { return send(400, { error: String(e?.message ?? e) }); }
      }
      const skAdoptResolveMatch = u.pathname.match(/^\/api\/skills\/lifecycle\/([^/]+)\/resolve-trial$/);
      if (skAdoptResolveMatch && req.method === 'POST') {
        const id = decodeURIComponent(skAdoptResolveMatch[1]);
        if (!findSkillAdoptItem(id)) return send(404, { error: 'no skill-adopt candidate with that id' });
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const measured = { n: body.n, counterfactualRate: body.counterfactualRate, fireRate: body.fireRate };
        const opts = typeof body.minObservations === 'number' ? { minObservations: body.minObservations } : undefined;
        try {
          const r = skillAdoptStore.resolveTrialIn(P.stateDir, id, measured, opts);
          return send(200, { ok: true, item: r.item });
        } catch (e) { return send(400, { error: String(e?.message ?? e) }); }
      }
      // glmps-19: reject was the one lifecycle transition left
      // unwired by mc-13 - rejectCandidate(In) was already built and unit-
      // tested (server/test/skill-adopt-store.test.js) but had no route, so
      // an operator could not reject a candidate sitting at quarantined/
      // pending-approval/approved (only resolve-trial's system verdict could
      // reach 'rejected', and only from 'trialing'). Same explicit-POST,
      // non-generic-PATCH shape as the other four transitions above; reject
      // is reachable from any non-terminal status per the store's own rule.
      const skAdoptRejectMatch = u.pathname.match(/^\/api\/skills\/lifecycle\/([^/]+)\/reject$/);
      if (skAdoptRejectMatch && req.method === 'POST') {
        const id = decodeURIComponent(skAdoptRejectMatch[1]);
        if (!findSkillAdoptItem(id)) return send(404, { error: 'no skill-adopt candidate with that id' });
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        try {
          const r = skillAdoptStore.rejectCandidateIn(P.stateDir, id, body.reason ?? null);
          return send(200, { ok: true, item: r.item });
        } catch (e) { return send(400, { error: String(e?.message ?? e) }); }
      }
      // the workspace-divergence signal, persisted (measurables-store.js) so
      // C2 has something durable to optimize against. Human approve/reject/
      // prune decisions roll up as labels. See docs/superpowers/specs/
      // 2026-07-11-c1-c2-b-aligned-design.md sec 2.
      if (u.pathname === '/api/measurables' && req.method === 'GET') {
        const kind = u.searchParams.get('kind') || undefined;
        // glmps-140: pure read. This route used to self-populate by running
        // all four compute+persist passes (guard-retire, skill-archive,
        // guard-stale, skill-stale - see the glmps-102/glmps-138 history in
        // measurablesTick's own comment above `const server = http.
        // createServer`) on every single GET, which meant the Scoreboard's
        // read path paid 4 fs-read + N fs-write passes per hit. That compute
        // now runs on a scheduled tick (measurablesTick) instead, with an
        // immediate synchronous call at startup so the store is never empty
        // before the first interval elapses - this handler is now a plain
        // read of whatever the tick (or the two dedicated retire-candidate
        // routes below, which still persist per-request) already wrote.
        let measurables = [];
        try { measurables = listMeasurables(P.stateDir, { kind }); } catch { /* fail-open */ }
        return send(200, { measurables, scoreboard: buildMeasurablesScoreboard(measurables) });
      }
      const measMatch = u.pathname.match(/^\/api\/measurables\/([^/]+)$/);
      if (measMatch && req.method === 'GET') {
        const m = getMeasurable(P.stateDir, decodeURIComponent(measMatch[1]));
        if (!m) return send(404, { error: 'no measurable with that id' });
        return send(200, m);
      }
      const measLabelMatch = u.pathname.match(/^\/api\/measurables\/([^/]+)\/label$/);
      if (measLabelMatch && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        try {
          const m = addLabel(P.stateDir, decodeURIComponent(measLabelMatch[1]), {
            decision: body?.decision, by: body?.by ?? null, note: body?.note ?? null, ts: Date.now(),
          });
          if (!m) return send(404, { error: 'no measurable with that id' });
          return send(200, { ok: true, measurable: m });
        } catch (e) { return send(400, { error: e?.message ?? 'invalid label' }); }
      }
      // Propose-only: near-duplicate memory facts and guard lines, clustered
      // by semantic-dedup.js's char-trigram cosine similarity (the same
      // metric the distiller's ingest-time dedup gate uses). Each proposal
      // names a canonicalId to keep and the full members list to collapse
      // into it - nothing is ever written or deleted here; a human reviews
      // every proposal (mirrors /api/guards/retire-candidates above).
      if (u.pathname === '/api/memory/consolidate-candidates' && req.method === 'GET') {
        const threshold = Number(u.searchParams.get('threshold')) || undefined;
        const minClusterSize = Number(u.searchParams.get('minClusterSize')) || undefined;
        const opts = {};
        if (threshold) opts.threshold = threshold;
        if (minClusterSize) opts.minClusterSize = minClusterSize;
        let candidates = [];
        try {
          const memoryCandidates = consolidateCandidates(memoryEntriesFromDir(P.memoryDir), opts)
            .map((c) => ({ domain: 'memory', ...c }));
          let globalMd = '';
          try { globalMd = fs.readFileSync(path.join(P.assetsDir, 'CLAUDE.global.md'), 'utf-8'); }
          catch { /* no CLAUDE.global.md yet - no guard candidates */ }
          const guardCandidates = consolidateCandidates(guardEntriesFromClaudeMd(globalMd), opts)
            .map((c) => ({ domain: 'guards', ...c }));
          candidates = [...memoryCandidates, ...guardCandidates];
        } catch { /* fail-open: no memory dir yet, or a malformed entry - report none */ }
        return send(200, { candidates });
      }
      if (u.pathname === '/api/learning/idea' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const text = (body.text ?? '').trim();
        if (!text) return send(400, { error: 'empty idea' });
        return send(200, learningStore.addIdeaTo(P.stateDir, text).item);
      }
      // POST /api/learning/config (the autoApplyGaps toggle) is retired
      // : the switch has been
      // inert since Task 10 deleted the auto-apply-with-template branch it
      // gated, and the operator's approval is the only landing path now.
      // Card glmps-2-0-201: what the auto-approver landed, and the operator's
      // way to take any of it back.
      if (u.pathname === '/api/learning/auto-approvals' && req.method === 'GET') {
        const st = readAutoApproveState(P.stateDir);
        return send(200, { ...loadGuardAutoApprove(P.stateDir), policy: AUTO_APPROVE_POLICY, records: st.records, lastDigestTs: st.lastDigestTs });
      }
      const autoRevertMatch = u.pathname.match(/^\/api\/learning\/auto-approvals\/([^/]+)\/revert$/);
      if (autoRevertMatch && req.method === 'POST') {
        if (!(env.GLMPS_ALLOW_ACT === '1' || assertCanAct(P, adapters).ok)) {
          const gate = assertCanAct(P, adapters);
          return send(gate.status, gate.body);
        }
        const code = decodeURIComponent(autoRevertMatch[1]);
        const st = readAutoApproveState(P.stateDir);
        try {
          const rec = revertRecord({ state: st, code, reason: 'reverted by the operator', actor: resolveActor(req), now: Date.now(),
            unland: autoUnland, loadStore: () => learningStore.load(P.stateDir), saveStore: (s) => learningStore.save(P.stateDir, s) });
          writeAutoApproveState(P.stateDir, st);
          return send(200, rec);
        } catch (e) {
          return send(/no live auto-approved/.test(e.message) ? 404 : 500, { error: e.message });
        }
      }
      const learnMatch = u.pathname.match(/^\/api\/learning\/item\/([^/]+)\/(approve|discard|alternative|promote)$/);
      if (learnMatch && req.method === 'POST') {
        const id = decodeURIComponent(learnMatch[1]);
        const action = learnMatch[2];
        const body = JSON.parse((await readBody(req)) || '{}');
        let st = learningStore.load(P.stateDir);
        const item = st.items.find(i => i.id === id);
        if (!item) return send(404, { error: 'item not found' });
        if (action === 'discard' || action === 'alternative') {
          const r = learningStore.applyAction(st, id, action, { rule: body.rule });
          learningStore.save(P.stateDir, r.state);
          return send(200, r.item);
        }
        // Gate: approve and promote write governance rules or launch harness actions (discard/alternative already returned above).
        if (!(env.GLMPS_RUNNER_DRYRUN || env.GLMPS_ALLOW_ACT === '1')) {
          const gate = assertCanAct(P, adapters);
          if (!gate.ok) return send(gate.status, gate.body);
        }
        // Review Focus 5: a GEPA
        // proposal with no traceable provenance must never land, however it
        // is approved or promoted. runGepa already refuses to ingest a CLI
        // output with an empty or foreign sourceItemIds
        // (gepa-plugin.js), so a legitimately-created 'gepa' item can never
        // have an empty derivedFrom - this is the defense-in-depth check at
        // the LANDING boundary, before landItemGuard is even defined below,
        // for a hand-edited store, a bug, or corruption that produced one
        // anyway.
        if (item.source === 'gepa' && (!Array.isArray(item.derivedFrom) || item.derivedFrom.length === 0)) {
          return send(400, { error: 'gepa proposal has no provenance (derivedFrom is empty); refusing to land it' });
        }
        // Every guard branch below lands through the SAME chokepoint:
        // landGuard (server/lib/evaluation/guard-lesson.js). It is the ONLY
        // landing path (guard proposer cutover, Task 10, deleted the
        // automatic auto-apply loop that used to also reach it with no
        // operator in this turn's flow). Before ADR-0001 these routes called
        // applyGuard directly, which wrote into the reflex layer with no
        // ledger row, no provenance and no gate decision - the hole
        // glmps-74 found, invisible to the ungated_reflex drift
        // check because that check reads the ledger.
        //
        // humanApproval:true says what is true: an operator POSTed this route
        // right now, and that click IS the human confirmation A0.4's reflex
        // gate requires. landGuard records it as a real, auditable, revocable
        // promotion instead of bypassing the gate (ADR-0001 s4). Writing into
        // the reflex layer as a non-reflex lesson would have made the ledger
        // lie about what is live.
        //
        // Provenance mirrors lesson-migrate.js's policy exactly, so a guard
        // landed today and the same guard migrated in 2026-08 are described
        // the same way: the queue row is the traceable origin, the session is
        // added when the item carries one, and derivedFromRefs is the project
        // repo's HEAD so the A0.3 revert sweep can reach the lesson. A repo we
        // cannot resolve yields no refs, which honestly means "outside the
        // sweep's reach" rather than a guessed sha.
        const landItemGuard = (target, { file, section, rule, message }) => landGuard(P.stateDir, {
          itemId: target.id,
          kind: 'guard',
          title: target.title || target.code || target.id,
          provenance: {
            scope: String(file).toLowerCase() === 'claude.global.md' ? 'global' : 'repo',
            // Guard proposer cutover: a 'gepa' proposal's provenance
            // also names the recurring gap items it reflected on
            // (item.derivedFrom, set by learning-store.js's upsertProposal),
            // so the ledger row traces back to the failures GEPA actually saw
            // - not just the proposal row itself.
            sourceEventIds: [
              `learning-store:${target.id}`,
              ...(target.sessionId ? [`session:${target.sessionId}`] : []),
              ...(target.source === 'gepa' ? (target.derivedFrom || []).map((d) => `learning-store:${d}`) : []),
            ],
            derivedFromRefs: refsForRepoPath(repoForProject(target.project)),
          },
          actor: resolveActor(req),
          humanApproval: true,
          config: learningIntegrityConfig(cfg),
          guard: { assetsDir: P.assetsWriteDir ?? P.assetsDir, publish: P.assetsWriteDir != null, file, section, rule, message, simThreshold: DEFAULT_SIM_THRESHOLD },
        });

        // promote: lift a learning to a broader scope so all agents see it.
        //  target 'global' (default) -> deterministic guard commit into CLAUDE.global.md.
        //  target 'memory' -> agent-composed memory file via the headless hand.
        if (action === 'promote') {
          if ((body.target ?? 'global') === 'global') {
            const rule = (item.proposedGuard && item.proposedGuard.rule)
              || `- ${(item.title || item.body || '').trim()}`;
            try {
              const { result } = landItemGuard(item, {
                file: 'CLAUDE.global.md', section: 'Learned guards',
                rule, message: `learning: promote ${item.code ?? item.id} to global`,
              });
              const r = learningStore.markApplied(st, id, result.commit, result.pushed);
              learningStore.save(P.stateDir, r.state);
              return send(200, r.item);
            } catch (e) {
              const r = learningStore.markFailed(st, id, e.message);
              learningStore.save(P.stateDir, r.state);
              return send(200, r.item);
            }
          }
          // target memory -> agent-composed memory file in the item's project memory dir.
          const reqDir = path.join(P.stateDir, 'learning', 'requests');
          const resDir = path.join(P.stateDir, 'learning', 'results');
          const requestPath = path.join(reqDir, id + '.json');
          const resultPath = path.join(resDir, id + '.json');
          const munged = item.project ? claudeProjectDirName(item.project) : '';
          const memoryDir = munged ? path.join(P.projectsDir, munged, 'memory') : path.join(P.projectsDir);
          // Validate the id and every derived path before anything touches disk,
          // so a rejected id leaves no stray request file behind.
          let command;
          try {
            command = buildMemoryApplyCommand(id, { requestPath, resultPath, memoryDir });
          } catch (e) {
            return send(400, { error: e.message });
          }
          fs.mkdirSync(reqDir, { recursive: true });
          fs.mkdirSync(resDir, { recursive: true });
          fs.writeFileSync(requestPath, JSON.stringify({ id, learning: item.body ?? item.title ?? '',
            project: item.project ?? null, memoryDir, resultPath }));
          // No request field reaches the command line (no args). glmps-2-0-30:
          // Antigravity when it can host it, else native. Task 12b: a
          // service-mode kernel queues this instead - outside a companion
          // launch, neither a real pid nor a launchId means it genuinely failed.
          const { pid: learningPid, launchId: learningLaunchId, target: learningIn } = openSession({ command, cwd: P.assetsDir, key: 'spawn:learning-apply', origin: 'learning', target: sessionTarget(preferredTarget()) });
          if (!IDE_TARGETS.includes(learningIn) && learningPid == null && learningLaunchId == null) {
            const f = learningStore.markFailed(st, id, 'terminal did not start');
            learningStore.save(P.stateDir, f.state);
            return send(200, f.item);
          }
          const r = learningStore.markDispatched(st, id);
          learningStore.save(P.stateDir, r.state);
          return send(200, r.item);
        }
        // approve: deterministic apply when a guard rule exists; else dispatch the hand
        if (item.proposedGuard && item.proposedGuard.rule) {
          try {
            const { result } = landItemGuard(item, {
              file: item.proposedGuard.file ?? 'CLAUDE.global.md',
              section: item.proposedGuard.section ?? 'Learned guards',
              rule: item.proposedGuard.rule,
              message: `learning: apply ${item.code ?? item.id}`,
            });
            const r = learningStore.markApplied(st, id, result.commit, result.pushed);
            learningStore.save(P.stateDir, r.state);
            return send(200, r.item);
          } catch (e) {
            const r = learningStore.markFailed(st, id, e.message);
            learningStore.save(P.stateDir, r.state);
            return send(200, r.item);
          }
        }
        // Guard proposer cutover: the free-form headless composer
        // (buildIdeaApplyCommand, which used to invent a guard line from the
        // item's free text with no operator-specified rule) is deleted.
        // There is no rule to land - the operator sets one first (the
        // 'alternative' action above), or approves a GEPA proposal, which
        // always carries one. Fail closed and say why, rather than silently
        // doing nothing or inventing a rule this route was never asked for.
        return send(400, { error: 'no guard rule to apply: set one via the alternative action first' });
      }

      // collectGraphRoots / gitRepoRoots moved to the outer startServer scope
      // (see near `poll()`) so the background worktree-sweep timer can reuse
      // the exact same properly-filtered root set as this handler - see the
      // isProjectRootCandidate comment there for why the filter matters.

      // Resolve a URL-facing project key (a repo basename) to its full
      // allowlisted root -- used by GET /wiki-ext/<projectKey>/... (glmps-43).
      // Same source-of-truth allowlist as /api/wiki/rebuild's body.root guard;
      // the URL segment is never trusted as a filesystem path itself.
      function resolveGraphRootByKey(projectKey) {
        return collectGraphRoots().find(r => path.basename(r) === projectKey) ?? null;
      }

      // Helper: build a graph status object for one root (fails soft -> null).
      async function graphStatusForRoot(root) {
        const gp = graphPathFor(root);
        if (!gp) return null;
        let nodes = 0, builtAtCommit = null, mtimeMs = null;
        try {
          const raw = JSON.parse(fs.readFileSync(gp, 'utf-8'));
          nodes = Array.isArray(raw.nodes) ? raw.nodes.length : 0;
          builtAtCommit = raw.built_at_commit ?? null;
        } catch {}
        try { mtimeMs = fs.statSync(gp).mtimeMs; } catch {}
        let headCommit = null;
        try {
          headCommit = await new Promise(res =>
            execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true }, (e, out) => res(e ? null : out.trim())));
        } catch {}
        const project = path.basename(root);
        return computeGraphStatus({ project, root, nodes, builtAtCommit, headCommit, mtimeMs, verifiedAtCommit: verifiedCommitFor(graphIntegrityStore, root) });
      }

      // Sort: glmps first, then alpha.
      function sortGraphs(graphs) {
        return graphs.sort((a, b) => {
          const aIsMC = a.project === 'glmps' ? 0 : 1;
          const bIsMC = b.project === 'glmps' ? 0 : 1;
          if (aIsMC !== bIsMC) return aIsMC - bIsMC;
          return a.project.localeCompare(b.project);
        });
      }

      // Secondary (machine) scan panel, card glmps-2-0-101. Every root the app
      // knows with its scope and reason; opt-ins persist to graphMachineFile.
      if (u.pathname === '/api/graph/machine') {
        const view = async () => {
          const roots = await classifyKnownGraphRoots();
          return {
            enabled: currentGraphConfig().machine.enabled,
            configEnabled: cfg.graph.machine.enabled,
            actorEnabled: cfg.graphMachineScan.enabled,
            roots: roots.map(({ root, scope, reason, optedIn }) => ({ root, scope, reason, optedIn: optedIn === true })),
            manifest: readJsonSafe(machineGraphPaths(P.stateDir).manifest) ?? null,
          };
        };
        if (req.method === 'GET') return send(200, await view());
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid JSON' }); }
        let state = loadMachineState(P.graphMachineFile);
        if (typeof body.enabled === 'boolean') state = { ...state, enabled: body.enabled };
        if (body.root != null) {
          if (typeof body.optIn !== 'boolean') return send(400, { error: 'optIn must be true or false' });
          const want = normProjectKey(body.root);
          // Only a root the classifier calls a machine candidate can be opted
          // in; ship roots are always indexed and excluded roots never are.
          const hit = (await classifyKnownGraphRoots()).find(r => normProjectKey(r.root) === want);
          if (!hit) return send(404, { error: 'not a known root' });
          if (hit.scope !== 'machine') return send(409, { error: `root is ${hit.scope} scope (${hit.reason}), not a machine candidate` });
          state = applyOptIn(state, hit.root, body.optIn);
        } else if (typeof body.enabled !== 'boolean') {
          return send(400, { error: 'expected { enabled } or { root, optIn }' });
        }
        saveMachineState(P.graphMachineFile, state);
        return send(200, await view());
      }
      if (u.pathname === '/api/graph/machine/build' && req.method === 'POST') {
        try { return send(200, await graphMachineScanTick({ force: true })); }
        catch (e) { return send(500, { error: e.message }); }
      }

      if (u.pathname === '/api/graph/status' && req.method === 'GET') {
        try {
          const roots = collectGraphRoots();
          const results = await Promise.all(roots.map(graphStatusForRoot));
          const graphs = sortGraphs(results.filter(Boolean));
          return send(200, { graphs, running: graphifySingleFlight.running() });
        } catch { return send(200, { graphs: [], running: graphifySingleFlight.running() }); }
      }

      if (u.pathname === '/api/graph/rebuild' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          let targets;
          if (body.root) {
            // Only ever rebuild a root the server already knows about. Without this,
            // body.root flows into spawn(..., { shell: true }) and an attacker-
            // controlled string ("x && calc.exe") becomes shell command execution.
            const allow = collectGraphRoots().map(r => path.resolve(r));
            const want = path.resolve(String(body.root));
            const match = allow.find(r => r.toLowerCase() === want.toLowerCase());
            if (!match) return send(400, { error: 'root not in graph allowlist' });
            targets = [match];
          } else {
            // Build current status, then target known-stale graphs PLUS graphs
            // whose freshness is unknown. Rebuilding an unknown graph is how its
            // missing built_at_commit marker gets restored, so skipping it would
            // leave it permanently blind. Falls back to every root when nothing
            // needs it (see selectRebuildTargets).
            const roots = collectGraphRoots();
            const statuses = (await Promise.all(roots.map(graphStatusForRoot))).filter(Boolean);
            targets = selectRebuildTargets(statuses);
          }
          // Run graphify update for each target sequentially, fail-soft per repo.
          // refused (not run), not queued, if graphRebuildTick or
          // refreshGraphForWiki is already updating this SAME root -- skip
          // it and move on to the next target rather than wait behind it.
          // a busy-skipped root used to
          // vanish silently into a 200 with no sign it was skipped. `root`
          // here is the same value graphs[].root already exposes below, so
          // this is not a new leak.
          const skipped = [];
          const job = (async () => {
            for (const root of targets) {
              const headBefore = await readHeadCommit(root);
              try { await recordGraphifyRun(root, await graphifyUpdate(root, { timeout: GRAPHIFY_UPDATE_TIMEOUT_MS }), headBefore); }
              catch (e) {
                if (e instanceof GraphifyBusyError) {
                  console.error(`POST /api/graph/rebuild: ${root} skipped - ${e.message}`);
                  skipped.push({ root, reason: 'graphify-busy' });
                  continue;
                }
                throw e;
              }
            }
            persistSyncHealth(P.graphSyncHealthFile, graphSyncHealthStore);
          })();
          // One rebuild can run 45 minutes, so the reply waits at most the
          // budget; past it the job carries on and graph status lists it as
          // running (card glmps-2-0-runtime-148).
          let budgetTimer;
          const overBudget = Symbol('over-budget');
          const outcome = await Promise.race([job, new Promise((r) => { budgetTimer = setTimeout(() => r(overBudget), graphRebuildReplyMs); budgetTimer.unref?.(); })]);
          clearTimeout(budgetTimer);
          if (outcome === overBudget) job.catch((e) => console.error(`POST /api/graph/rebuild: background rebuild failed - ${e?.message || e}`));
          const roots = collectGraphRoots();
          const results = await Promise.all(roots.map(graphStatusForRoot));
          const graphs = sortGraphs(results.filter(Boolean));
          return send(outcome === overBudget ? 202 : 200, { graphs, skipped: [...skipped], running: graphifySingleFlight.running() });
        } catch (e) { return send(...bodyErrorReply(e, req)); }
      }

      // readWikiState is hoisted above startServer's http.createServer call
      // (glmps-42) so other consumers can share it.
      // mint a 10-minute read-only wiki ticket for the lens's sandboxed
      // iframe. An /api route, so a remote caller needs the token to get one.
      if (u.pathname === '/api/wiki/ticket' && req.method === 'GET') {
        // Scan 2026-10-15 F4: minted for one wiki, ?base=/wiki (default) or /wiki-ext/<key>.
        const scope = wikiTicketScope(u.searchParams.get('base') || '/wiki');
        if (!scope) return send(400, { error: 'base must be /wiki or /wiki-ext/<project>' });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(mintWikiTicket({ key: wikiTicketKey, scope })));
      }
      if (u.pathname === '/api/wiki' && req.method === 'GET') {
        const explicit = u.searchParams.get('project');
        const sessionCwd = explicit ? null : (sessions.find(s => s.id === u.searchParams.get('session'))?.cwd ?? null);
        const pr = resolveProjectParam(explicit || sessionCwd || REPO_ROOT);
        if (!pr.ok && explicit) return send(pr.status, { error: pr.error });
        const project = pr.ok ? pr.root : REPO_ROOT;
        let state;
        try { state = await readWikiState(project); }
        catch (e) {
          // readWikiState throws when resolveWikiSource's
          // repo-root branch hits a malformed current.json (readCurrentWiki,
          // Task 3) -- the same leak class fixed in wiki-serve.js's
          // resolveWikiRequest, at this route's own entry point instead. Same
          // fix: log the real reason server-side, answer with the same
          // manifestError-carrying shape this route already uses for an
          // unreadable manifest, never the raw error message or path.
          console.error(`GET /api/wiki: readWikiState(${project}) failed: ${e.message}`);
          state = { project: path.basename(project), root: String(project).replace(/\\/g, '/'), manifest: null,
            manifestError: 'wiki build unavailable', headCommit: null, needsUpdate: false, freshness: 'unknown',
            base: null, sections: [] };
        }
        return send(200, { ...publicWikiState(state), loop: isRepoRoot(project) ? wikiLoopView() : null });
      }

      if (u.pathname === '/api/wiki/rebuild' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          let target = REPO_ROOT;
          if (body.root) {
            // Same allowlist guard as /api/graph/rebuild: body.root flows into a
            // spawned child, so only ever act on a root the server already knows.
            const allow = collectGraphRoots().map(r => path.resolve(r));
            const want = path.resolve(String(body.root));
            const match = allow.find(r => r.toLowerCase() === want.toLowerCase());
            if (!match) return send(400, { error: 'root not in graph allowlist' });
            target = match;
          }
          // The kernel's own repo is built only by the wiki loop (D-W5): queue a
          // run and answer 202; the dashboard polls GET /api/wiki for the result.
          if (isRepoRoot(target)) {
            if (!runWikiLoop({ reason: 'operator', force: body.force === true, fresh: body.fresh === true })) {
              return send(409, { error: 'the wiki loop is not running in this server: it runs in the kernel service (GLMPS_SERVICE=1) or with config.json wikiLoop.enabled: true' });
            }
            return send(202, { queued: true, loop: 'wiki' });
          }
          // the LLM-backed spawn below
          // had no isTestProcess guard at all -- body.llm: true in a test
          // process would start a real model build attempt (the CLI's own
          // backend auto-detection: agy/gemini/none). Refused here, named,
          // unless a spawnWikiRebuildCli override was actually injected.
          // The no-LLM, structural-only case is untouched: useLlm:false
          // never reaches any backend selection inside the CLI at all, and
          // the existing api-wiki.test.js rebuild-failure test relies on
          // that real (but harmless) spawn still running under isTestProcess.
          if (body.llm && isTestProcess({ env }) && spawnWikiRebuildCli === defaultSpawnWikiRebuildCli) {
            return send(503, { error: 'wiki rebuild with llm refused: isTestProcess() is true and no spawnWikiRebuildCli override was given' });
          }
          const cli = path.join(REPO_ROOT, 'scripts', 'wiki-build-cli.mjs');
          const cliArgs = wikiRebuildArgs({ cliPath: cli, target, llm: !!body.llm });
          // glmps-113: this used to resolve on 'close' regardless of exit code
          // and always return 200 + readWikiState(target) -- so a manual
          // Refresh click on a BROKEN build silently served the stale
          // last-good wiki back as if the rebuild had succeeded. Capture
          // stderr (piped, not ignored) and check the exit code so a failure
          // surfaces as a real non-200 with the reason, instead of quietly
          // serving stale state.
          let code, stderr;
          try { ({ code, stderr } = await spawnWikiRebuildCli(cliArgs, { cwd: REPO_ROOT, timeout: 300000 })); }
          catch (err) { code = 1; stderr = String(err?.message ?? err); }
          if (code !== 0) {
            return send(500, { error: `wiki rebuild failed (exit ${code})`, stderr: stderr.trim().slice(-4000) || undefined });
          }
          let rebuiltState;
          try { rebuiltState = await readWikiState(target); }
          catch (e) {
            // same leak as GET /api/wiki and
            // POST /api/wiki/ask -- readWikiState throws when
            // resolveWikiSource's repo-root branch hits a malformed
            // current.json (readCurrentWiki, Task 3). The outer catch below
            // would otherwise forward e.message (with the state-dir path)
            // straight to the client, same as it does for any other error
            // in this route. Log the real reason server-side, answer with a
            // generic error instead.
            console.error(`POST /api/wiki/rebuild: readWikiState(${target}) failed: ${e.message}`);
            return send(500, { error: 'wiki build unavailable' });
          }
          return send(200, publicWikiState(rebuiltState));
        } catch (e) { return send(...bodyErrorReply(e, req)); }
      }

      // DeepWiki-style grounded Q&A over the generated wiki: pure lexical
      // retrieval picks the top sections, their generated HTML is stripped to
      // text and fed to the LLM with an excerpt-only + [slug]-citation prompt.
      // Backend selection mirrors scripts/wiki-build-cli.mjs: prefer agy (the
      // user's authenticated account, no per-minute quota), else the direct
      // Gemini API. Both probes are env-gated (P.agyCliDir / env.GEMINI_API_KEY)
      // so isolated test servers always land on 503 - never a real LLM call.
      if (u.pathname === '/api/wiki/ask' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question) return send(400, { error: 'question must be a non-empty string' });
        if (question.length > 2000) return send(400, { error: 'question too long (max 2000 chars)' });
        if (wikiAskRunning) return send(409, { error: 'a question is already running' });

        const pr = resolveProjectParam(body.project ? String(body.project) : REPO_ROOT);
        if (!pr.ok) return send(pr.status, { error: pr.error });
        const project = pr.root;

        const agyConvDir = path.join(P.agyCliDir, 'conversations');
        const callModel = pickWikiAskModel({ agyConvDir });
        if (!callModel) return send(503, { error: 'no llm backend' });

        let state;
        try { state = await readWikiState(project); }
        catch (e) {
          // same leak as GET /api/wiki -- readWikiState
          // throws when resolveWikiSource's repo-root branch hits a malformed
          // current.json (readCurrentWiki, Task 3). Log the real reason
          // server-side, answer with a generic error, never the raw pointer
          // message or the state-dir path.
          console.error(`POST /api/wiki/ask: readWikiState(${project}) failed: ${e.message}`);
          return send(500, { error: 'wiki build unavailable' });
        }
        if (!state.manifest || !state.sections.length || !state.base) {
          return send(404, { error: 'no wiki for this project' });
        }
        // Section HTML lives wherever resolveWikiSource located the manifest:
        // the state-dir build for the kernel's own repo, else graphify-out/wiki
        // for every other project. S1 fix: reuse the wikiDir readWikiState
        // already resolved above -- a second resolveWikiSource(project) call
        // here used to re-read current.json, a TOCTOU window that could leak
        // the absolute state-dir path if it changed between the two reads.
        const wikiDir = state.wikiDir;
        if (!wikiDir) return send(404, { error: 'no wiki for this project' });

        wikiAskRunning = true;
        try {
          const result = await askWiki({
            question,
            sections: state.sections.map(s => ({ slug: s.slug, title: s.title, body: s.searchText ?? '' })),
            readSectionHtml: async (slug) => {
              // Slugs come from the manifest (generated), but stay defensive:
              // bare-filename slugs only, resolved path pinned inside wikiDir.
              if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
              const file = path.join(wikiDir, `${slug}.html`);
              if (!path.resolve(file).startsWith(path.resolve(wikiDir) + path.sep)) return null;
              // the check above is a
              // path-STRING comparison only, which a single safe slug always
              // passes syntactically even when the FILE it names is itself a
              // symlink whose target lives outside wikiDir -- readFileSync
              // follows it, and the content would be fed straight to the
              // model. Same realpathSync.native containment as /wiki/* (R-M5).
              try {
                if (!realpathContained(file, wikiDir)) return null;
                return fs.readFileSync(file, 'utf-8');
              } catch (e) {
                // this used to be a
                // bare `catch {}` around both realpathContained's own
                // realpath() throw and the readFileSync call -- a non-
                // ENOENT failure (EPERM, EACCES) vanished with no trace.
                // Same posture as resolveWikiRequest's equivalent catch
                // : the expected ENOENT case (the file
                // genuinely is not there) stays silent; anything else is
                // logged server-side, never surfaced to the client.
                if (e.code !== 'ENOENT') console.error(`POST /api/wiki/ask: readSectionHtml(${slug}) failed: ${e.code || e.message}`);
                return null;
              }
            },
            callModel,
          });
          const titleBySlug = new Map(state.sections.map(s => [s.slug, s.title]));
          return send(200, {
            answer: result.answer,
            citations: result.citations.map(slug => ({ slug, title: titleBySlug.get(slug) ?? slug })),
            retrieved: result.retrieved,
          });
        } catch (e) {
          return send(500, { error: e.message });
        } finally {
          wikiAskRunning = false;
        }
      }

      // GET scans every project memory dir for injected/poisoned entries and
      // reports drift against a persisted baseline manifest; POST re-baselines
      // (operator acknowledges the current memory state as trusted).
      if (u.pathname === '/api/memory/scan' && (req.method === 'GET' || req.method === 'POST')) {
        let subs = [];
        try {
          subs = fs.readdirSync(P.projectsDir, { withFileTypes: true })
            .filter(d => d.isDirectory()).map(d => d.name);
        } catch { /* no projects dir */ }
        const dirs = [];
        const flagged = [];
        const manifest = {};
        let severity = 'none';
        for (const proj of subs) {
          const r = memoryScan.scanMemoryDir(path.join(P.projectsDir, proj, 'memory'));
          if (!r.files.length) continue;
          dirs.push({ project: proj, severity: r.severity, files: r.files });
          for (const [name, h] of Object.entries(r.manifest)) manifest[`${proj}/${name}`] = h;
          for (const f of r.flagged) flagged.push({ project: proj, ...f });
          if (POISON_SEVERITY[r.severity] > POISON_SEVERITY[severity]) severity = r.severity;
        }
        const baseFile = path.join(P.stateDir, 'memory-baseline.json');
        let baseline = {};
        try { baseline = JSON.parse(fs.readFileSync(baseFile, 'utf-8')); } catch { /* no baseline yet */ }
        const integrity = memoryScan.diffManifest(baseline, manifest);
        if (req.method === 'POST' || Object.keys(baseline).length === 0) {
          try { fs.mkdirSync(P.stateDir, { recursive: true }); fs.writeFileSync(baseFile, JSON.stringify(manifest, null, 2)); } catch {}
        }
        return send(200, { severity, dirs, flagged, integrity, acknowledged: req.method === 'POST' });
      }

      // POST /api/memory/distill enqueues a session for distillation (the Stop
      // hook pings this); the drain runs in the background and never blocks the
      // response. The proposals routes are the human-in-the-loop review surface
      // for the uncertain/flagged tail. All mutations are already behind the
      // loopback Origin/Host guard above.
      if (u.pathname === '/api/memory/distill' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (!body.sessionId || !body.transcriptPath) return send(400, { error: 'sessionId and transcriptPath required' });
        // this route sits behind only the
        // loopback Origin/Host guard, not full authentication - an
        // unconstrained transcriptPath would let any loopback caller make
        // the distiller read (and, via Mem0 admission, potentially surface
        // back out through memory lookup) an arbitrary file on disk.
        if (!path.resolve(String(body.transcriptPath)).startsWith(path.resolve(P.projectsDir) + path.sep)
          || !isInsideReal(body.transcriptPath, P.projectsDir)) {
          return send(400, { error: `transcriptPath must be under ${P.projectsDir}` });
        }
        if (!mdCfg.enabled) return send(200, { queued: false, disabled: true });
        mdEnqueue(P.stateDir, { sessionId: body.sessionId, transcriptPath: body.transcriptPath, cwd: body.cwd });
        // D23/D24 (glmps-159 task 6): the promotion chain that used to follow
        // the drain is retired along with the L3 pool it promoted from - the
        // Mem0 plugin now admits directly (via the memory-admission loop, K
        // Task 6), with its own failure handled inside processRequest
        // (emit + markDone either way, no fallback).
        // this is a last-resort net for a
        // truly unexpected throw escaping drainQueue itself (every per-item
        // outcome inside it is already caught and routed to its own alert) -
        // must still surface, never swallow silently.
        mdDrainQueue({ stateDir: P.stateDir, cfg: mdCfg, emit: (kind, payload) => loopRegistry.emit(kind, payload) })
          .catch((e) => console.error('[loops] memory distill drain failed', e && e.message ? e.message : String(e)));
        return send(202, { queued: true });
      }
      if (u.pathname === '/api/memory/proposals' && req.method === 'GET') {
        return send(200, { proposals: mdListProposals(P.stateDir) });
      }
      // glmps-155: memory usage telemetry. Reads are already captured as
      // kind:'memory' events, so this only aggregates. `exposureSessions` is
      // the term that keeps a fact written yesterday from looking identical
      // to one ignored for months.
      if (u.pathname === '/api/memory/usage' && req.method === 'GET') {
        const usage = memReadUsage(P.stateDir);
        const facts = Object.entries(usage.facts).map(([target, f]) => ({ target, ...f }));
        facts.sort((a, b) => a.reads - b.reads || b.exposureSessions - a.exposureSessions);
        return send(200, { facts, watermark: usage.watermark });
      }
      // glmps-157 / D23-D24 (task 6): the page-fault handler. Searches every
      // curated memory body, INCLUDING facts whose index line was evicted,
      // fused with Mem0's own admitted memories by reciprocal rank.
      //
      // `cwd` (the CALLING session's own working
      // directory, e.g. from hooks/memory-working-set.js or
      // scripts/memory-lookup.mjs --cwd) scopes the Mem0 half to THAT
      // project, via the same slug convention admission uses
      // (memory-distill-sweeper.js's sanitizeRoot -- admission reads the
      // directory Claude Code already wrote with this convention;
      // deriving it from a bare cwd string here needs the actual function).
      // With no cwd, this falls back to this server's own project
      // (P.memoryDir's slug), the original behavior, still useful for a
      // direct API call with no session context.
      //
      // the curated tier is NOT
      // a fallback (D24 keeps it) - a Mem0 failure no longer 503s the whole
      // route. It responds 200 with the curated hits plus `mem0Error`. K Task
      // 6: this read-path failure is distinct from an admission failure (no
      // session.condensed event fires here, so the memory-admission loop
      // never sees it) and has no registered loop of its own; logged
      // fail-open instead of the deleted consecutive-failure tracker's own
      // mem0-key alert.
      if (u.pathname === '/api/memory/lookup' && req.method === 'GET') {
        const q = u.searchParams.get('q') || '';
        if (!q.trim()) return send(400, { error: 'q required' });
        const k = Number(u.searchParams.get('k')) || 5;
        const cwd = u.searchParams.get('cwd');
        const project = cwd ? mdSanitizeRoot(cwd) : projectSlugFor(P.memoryDir);
        const { hits, mem0Skipped, mem0Error } = await memPluginLookup({
          memory: memoryPlugin, memoryDir: P.memoryDir, query: q, k, project, curatedLookup: memLookupFacts, scan: scanText,
        });
        if (mem0Error) {
          console.error('[loops] memory lookup: mem0 search failed', mem0Error);
          // an unconfigured mem0 (embedderMissingReason already
          // set at boot, a known condition) is not a fresh lookup failure -
          // memory-admission's own boot-failure report already covers it;
          // reporting it again here on every single lookup would just be
          // noise for a condition the operator already sees.
          if (!embedderMissingReason) reportMiss('mem0-lookup', mem0Error); // I8
        } else {
          clearMiss('mem0-lookup'); // a successful lookup ends any earlier outage episode.
        }
        return send(200, { query: q, hits, mem0Skipped, mem0Error });
      }
      // D23/D24 (task 6): one-time migration of the pre-D23 distilled pool
      // into Mem0, verbatim (infer: false). Runs at deploy after this build
      // lands.
      //
      // finding 3, readAllDistilledFacts scans every
      // `<claudeDir>/projects/*/memory/distilled/*.md`, not just this
      // server's own memoryDir. Finding 2, a ledger under
      // <stateDir>/plugins/mem0 makes re-running this idempotent (Mem0's
      // own infer:false add is NOT idempotent - confirmed by probe and by
      // memory-plugin-mem0-real.test.js). Finding 8, `failed > 0` is a
      // one-shot migration run, not a registered loop's own failure; logged
      // fail-open (K Task 6 deletes the tracker's own mem0-key alert here,
      // same reasoning as the lookup route above). Also guards against two
      // overlapping calls (a double-click, or a script re-run while the
      // first is still going): a concurrent call gets 409 rather than racing
      // the same ledger file.
      if (u.pathname === '/api/memory/migrate-distilled' && req.method === 'POST') {
        const { busy, result: counts } = await migrateSingleFlight(() => migrateDistilled({
          memory: memoryPlugin, scan: scanText,
          readFacts: () => readAllDistilledFacts(P.claudeDir),
          ledgerFile: path.join(P.stateDir, 'plugins', 'mem0', 'migrated.ndjson'),
        }));
        if (busy) return send(409, { error: 'a migration is already running' });
        if (counts.failed > 0) {
          const reason = counts.firstError || 'migration had failures';
          console.error('[loops] migrate-distilled had failures', reason);
          reportMiss('mem0-migrate', reason); // I8
        } else {
          clearMiss('mem0-migrate'); // a clean migration run ends any earlier failure episode.
        }
        return send(200, counts);
      }
      // Page a fact's index line back in, verbatim. A resolved fault is
      // evidence the eviction was wrong, so the target is pinned afterwards.
      if (u.pathname === '/api/memory/fault-in' && req.method === 'POST') {
        let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (!body.target) return send(400, { error: 'target required' });
        return send(200, memFaultIn({ memoryDir: P.memoryDir, stateDir: P.stateDir, target: body.target }));
      }
      // The plan the next tick WOULD apply. Empty whenever the index fits,
      // which is the expected steady state; this endpoint is for inspecting
      // why a fact is or is not a candidate, not for triggering anything.
      if (u.pathname === '/api/memory/eviction-plan' && req.method === 'GET') {
        let content = '';
        try { content = fs.readFileSync(path.join(P.memoryDir, 'MEMORY.md'), 'utf8'); } catch { /* fail open */ }
        const entries = memParseIndex(content);
        const budgetBytes = memBudget();
        return send(200, {
          budgetBytes,
          indexBytes: Buffer.byteLength(content, 'utf8'),
          entryCount: entries.length,
          plan: memEvictionPlan({
            entries,
            usage: memReadUsage(P.stateDir).facts,
            budgetBytes,
            pinned: memPinned(P.memoryDir, entries),
          }),
        });
      }
      // Measured recall of the fault path against a fixed probe set. Backs
      // the eviction gate in memory-evict-runner.js and is the number a
      // human checks before trusting curated demotion.
      if (u.pathname === '/api/memory/probe-report' && req.method === 'GET') {
        const report = memScoreProbes(P.memoryDir, memReadProbes(P.stateDir), { k: 5 });
        return send(200, { ...report, gate: memDemotionAllowed(report) });
      }
      // Read-only digest across the curated memory tier plus the demotion
      // gate and quarantined proposals - the operator's at-a-glance memory
      // view. D23/D24 (task 6): the L3 distilled-pool count and
      // promotion-candidate count are retired along with the pipeline that
      // produced them (Mem0 has no "list everything" op to replace them with).
      if (u.pathname === '/api/memory/digest' && req.method === 'GET') {
        const report = memScoreProbes(P.memoryDir, memReadProbes(P.stateDir), { k: 5 });
        let indexRaw = '';
        try { indexRaw = fs.readFileSync(path.join(P.memoryDir, 'MEMORY.md'), 'utf8'); } catch { /* none yet */ }
        return send(200, {
          curated: { lines: memParseIndex(indexRaw).length, bytes: Buffer.byteLength(indexRaw, 'utf8'), budgetBytes: memBudget() },
          gate: memDemotionAllowed(report),
          recall: { recallAtK: report.recallAtK, mrr: report.mrr, total: report.total },
          quarantined: mdListProposals(P.stateDir).filter((p) => p.poison?.clean === false).map((p) => ({ id: p.id, flags: p.poison.flags || [] })),
        });
      }
      const mdApproveMatch = u.pathname.match(/^\/api\/memory\/proposals\/([^/]+)\/approve$/);
      if (mdApproveMatch && req.method === 'POST') {
        return send(200, mdApproveProposal(P.stateDir, decodeURIComponent(mdApproveMatch[1])));
      }
      const mdRejectMatch = u.pathname.match(/^\/api\/memory\/proposals\/([^/]+)\/reject$/);
      if (mdRejectMatch && req.method === 'POST') {
        mdRejectProposal(P.stateDir, decodeURIComponent(mdRejectMatch[1]));
        return send(200, { ok: true });
      }

      // Create or adopt a project: createProject owns the whole sequence (mkdir,
      // git init, additionalDirectories, harness trust). A test process may only
      // git init under a temp fixture (testRealGitWriteRefused).
      if (u.pathname === '/api/projects' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return send(400, { error: 'body is not valid JSON' }); }
        const syn = shellSafePathSyntax(body?.path);
        if (!syn.ok) return send(400, { error: `path refused: ${syn.reason}` });
        if (testRealGitWriteRefused(syn.path, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) {
          return send(403, { error: 'path refused: this is a test process and the path is not a temp fixture' });
        }
        const r = createProject({
          settingsFile: P.settingsFile, dir: syn.path, privateDirs: loadPrivateDirs({ env }),
          claudeConfigFile: P.claudeDir + '.json', env,
        });
        if (r.private) return send(403, { error: `path refused: ${r.reason}` });
        if (!r.ok) return send(500, { error: `project not created: ${r.reason}` });
        return send(200, r);
      }

      if (u.pathname === '/api/projects' && req.method === 'GET') {
        try {
          // Only surface real repositories: this server's own root, plus any
          // candidate root that is an actual git repo (.git dir or worktree file).
          // Drops transient session cwds (UUID/temp dirs) that pollute the list,
          // and session/runner worktree dirs (they belong to their parent project).
          // gitRepoRoots() (K5 Task 12) is this exact filter; reused here
          // instead of duplicating it.
          const roots = gitRepoRoots().map((r) => r.path);
          const sums = sessionSummaries();
          const history = index.list({});
          const projects = await Promise.all(roots.map(async (root) => {
            const k = normRoot(root);
            const hist = history.filter(r => normRoot(r.cwd) === k);
            const live = sums.filter(s => normRoot(s.cwd) === k && s.live);
            const lastTs = hist.reduce((m, r) => Math.max(m, r.lastTs || 0), 0) || null;
            const gs = await graphStatusForRoot(root).catch(() => null);
            const key = path.basename(root);
            // idle (D27) is deliberately NOT in CLOSED_STATES: it is reopenable,
            // so it still counts as open backlog here.
            const open = backlogStore.listFrom(P.stateDir, { project: key })
              .filter(i => !backlogStore.CLOSED_STATES.has(i.state)).length;
            return {
              name: key, key, path: root,
              sessionCount: hist.length, liveCount: live.length, lastTs,
              branch: await branchFor(root),
              // No graph at all is honestly 'unknown' freshness, not fresh.
              graph: gs
                ? { nodes: gs.nodes, needsUpdate: gs.needsUpdate, freshness: gs.freshness }
                : { nodes: 0, needsUpdate: false, freshness: 'unknown' },
              backlogOpen: open,
            };
          }));
          const sorted = projects.sort((a, b) => {
            const aMC = a.key === 'glmps' ? 0 : 1, bMC = b.key === 'glmps' ? 0 : 1;
            return aMC !== bMC ? aMC - bMC : a.key.localeCompare(b.key);
          });
          return send(200, { projects: sorted });
        } catch { return send(200, { projects: [] }); }
      }

      if (u.pathname === '/api/learning/status' && req.method === 'GET') {
        try {
          // Read watermark
          let lastRunMs = null;
          try {
            const wmPath = path.join(P.stateDir, 'learning', 'synth-watermark.json');
            const wm = JSON.parse(fs.readFileSync(wmPath, 'utf-8'));
            if (typeof wm.lastRunMs === 'number') lastRunMs = wm.lastRunMs;
          } catch {}
          const st = learningStore.load(P.stateDir);
          const pending = st.items.filter(i => i.status === 'pending').length;
          return send(200, { lastRunMs, pending, total: st.items.length });
        } catch (e) { return send(...bodyErrorReply(e, req)); }
      }

      if (u.pathname === '/api/learning/synth' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const scriptPath = path.join(REPO_ROOT, 'scripts', 'capability-synth.mjs');
          const args = ['days' in body && body.days != null
            ? `--days ${Number(body.days)}`
            : '--all'];
          const { stdout, stderr, code } = await new Promise(res => {
            let stdout = '', stderr = '';
            const child = spawn(
              'node',
              [scriptPath, ...args[0].split(' ')],
              { cwd: REPO_ROOT, shell: false, windowsHide: true, timeout: 180000 }
            );
            child.stdout?.on('data', d => { stdout += d; });
            child.stderr?.on('data', d => { stderr += d; });
            child.on('close', code => res({ stdout, stderr, code }));
            child.on('error', err => res({ stdout, stderr: err.message, code: 1 }));
          });
          if (code !== 0) {
            return send(200, { ok: false, scanned: null, upserted: null, message: (stderr || stdout).trim() });
          }
          // Parse "scanned X transcript(s), Y gap(s) upserted" from stdout
          const all = stdout + '\n' + stderr;
          const m = all.match(/scanned\s+(\d+)\s+transcript[^,]*,\s*(\d+)\s+gap/i);
          const scanned = m ? Number(m[1]) : null;
          const upserted = m ? Number(m[2]) : null;
          return send(200, { ok: true, scanned, upserted, message: stdout.trim() });
        } catch (e) { return send(...bodyErrorReply(e, req)); }
      }

      if (u.pathname === '/api/runner' && req.method === 'GET') {
        return send(200, {
          config: runnerStore.loadConfig(P.stateDir),
          ledger: runnerStore.loadLedger(P.stateDir),
          targets: TARGET_IDS,
          openTargets: installedEditors(editorProbe()).map((id) => ({ id, label: TARGET_LABELS[id] ?? id })),
        });
      }
      // Huddle (GLMPS 2.0 phase C / H1, D28): a moderated conversation with the
      // SCUT roster through the operator's Claude Code plan, plus a Gemini seat.
      // Fail-open: claude CLI unavailable -> 503 and nothing else changes;
      // disabled -> 404. Behind the same access guard as every route above.
      if (u.pathname === '/api/huddle' && req.method === 'POST') {
        if (cfg.huddle.enabled === false) return send(404, { error: 'huddle disabled' });
        if (huddleShuttingDown) return send(503, { error: 'server shutting down' });
        if (huddleCliOk !== true) huddleCliOk = Boolean(await huddleCliCheckFn());
        if (!huddleCliOk) return send(503, { error: 'claude CLI unavailable; the huddle has no minds' });
        let body;
        try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        await pruneStaleHuddles();
        const seatsCfg = huddleMergeSeats(HUDDLE_DEFAULT_SEATS, cfg.huddle.seats);
        const all = huddleLoadPersonas({ agentsDir: P.agentsDir, theme: huddleTheme(), rosterMap: cfg.huddle.rosterMap ?? undefined, seats: seatsCfg });
        const notes = huddleValidateSeats(seatsCfg);
        const wanted = Array.isArray(body.personas) && body.personas.length ? new Set(body.personas.map(String)) : null;
        // The agy seats are the different views and are kept whatever subset is
        // invited; a seat that cannot run leaves the roster with a note saying why.
        const agyConvDir = path.join(P.agyCliDir, 'conversations');
        const agyOff = cfg.huddle.agySeats === false || cfg.huddle.geminiSeat === false || huddleSeats === false;
        // In service mode agy runs in the shell's session, so this machine's
        // conversations dir says nothing; a missing shell fails the call, named.
        const serviceMode = isServiceMode(env);
        const agyAvailable = Array.isArray(huddleSeats) || serviceMode || fs.existsSync(agyConvDir);
        if (!agyOff && !agyAvailable) notes.push(`No agy seats this huddle: agy has no conversations directory for this account (${agyConvDir}).`);
        const personas = [];
        const seats = [];
        for (const p of all) {
          // Howard, like the agy seats, stays whatever subset is invited.
          if (p.researcher) {
            if (huddleResearch) personas.push({ ...p, model: huddleResearch.model ?? p.model });
            continue;
          }
          if (!p.seat) {
            if (p.lead || !wanted || wanted.has(p.id)) personas.push(p);
            continue;
          }
          if (agyOff || !agyAvailable) continue;
          const injected = Array.isArray(huddleSeats) ? huddleSeats.find((x) => x?.persona?.id === p.id) : null;
          if (Array.isArray(huddleSeats) && !injected) continue;
          personas.push(p);
          const avoidModels = () => seats.filter((x) => x.persona.id !== p.id).map((x) => x.model);
          seats.push(injected ? { ...injected, persona: p } : createAgySeat({ persona: p, convDir: agyConvDir, env, avoidModels, generate: serviceMode ? agyBroker.generate : null }));
        }
        // An injected huddleStream stands in for the whole pool: its optional
        // close() is called wherever a real pool's would be (tests spy on it).
        const pool = huddleStream
          ? { streamMessage: huddleStream, prewarm: huddleStream.prewarm ? (t) => huddleStream.prewarm(t) : null, close: () => huddleStream.close?.() }
          : createClaudeStreamPool({ env, idleKillMs: cfg.huddle.idleKillMs });
        let brief = '';
        try {
          const glossary = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'wiki', 'glossary.json'), 'utf8'));
          brief = buildHuddleBrief({ glossary, cards: backlogStore.load(P.stateDir).items, projects: ['glmps-2.0', 'glmps-2.0-runtime'] });
        } catch (e) { notes.push(`The seats have no project brief this huddle: ${e.message}`); }
        let h;
        try {
          h = createHuddle({
            personas, stateDir: P.stateDir, stream: pool.streamMessage, broadcast: broadcastHuddle, seats, notes, brief, researcher: huddleResearch,
            postSummary: postHuddleSummary, actor: localActor,
            models: { floor: cfg.huddle.floorModel, floorEffort: cfg.huddle.floorEffort, mind: cfg.huddle.mindModel, decide: cfg.huddle.decideModel, effort: cfg.huddle.effort, maxTokens: cfg.huddle.maxTokens },
          });
        } catch (e) { pool.close(); throw e; }
        huddles.set(h.id, { h, pool, touched: Date.now(), saying: null, kickoffs: new Map() });
        // Pre-warm (operator limit: a reply in under 5 s; a cold Lead plus a
        // cold mind made the first reply 8-14 s). Each Claude process the
        // huddle will use is started now, in the background, without a turn;
        // the start response does not wait. A failed warm-up never fails the
        // huddle: the pool keeps it and it surfaces only if a later turn on
        // that mind fails too.
        if (pool.prewarm) {
          for (const t of h.warmTargets()) {
            setImmediate(() => {
              let warm;
              try { warm = pool.prewarm(t); } catch (e) { warm = Promise.reject(e); }
              Promise.resolve(warm).catch((e) => console.error(`[huddle ${h.id}] pre-warm failed (shown only if a turn on that mind fails): ${e?.message ?? e}`));
            });
          }
        }
        return send(200, h.snapshot());
      }
      const huddleMatch = u.pathname.match(/^\/api\/huddle\/([^/]+)(?:\/(say|interrupt|end|decide|kickoff|metric|mute|agenda|record|spec))?$/);
      if (huddleMatch) {
        const id = huddleMatch[1];
        const verb = huddleMatch[2] ?? null;
        const afterEnd = new Set(['decide', 'kickoff', 'metric', 'record', 'spec']);
        const rec = huddles.get(id) ?? (afterEnd.has(verb) ? endedHuddles.get(id) : undefined);
        if (!rec) return send(404, { error: 'no such huddle' });
        rec.touched = Date.now();
        const { h } = rec;
        if (!verb && req.method === 'GET') return send(200, h.snapshot());
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        if (verb === 'interrupt') { h.interrupt(); return send(200, { ok: true }); }
        if (verb === 'end') return send(200, await endHuddleRecord(id, rec));
        if (verb === 'metric') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
          return h.metric(body) ? send(200, { ok: true }) : send(400, { error: 'invalid metric' });
        }
        if (verb === 'decide') {
          try {
            return send(200, await huddleDecide(id, rec));
          } catch (e) {
            return send(502, { error: `could not read the decisions: ${e?.message ?? e}` });
          }
        }
        if (verb === 'mute') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
          if (!h.mute(String(body.seat ?? ''), body.muted !== false)) return send(400, { error: 'that seat cannot be muted' });
          return send(200, { muted: h.snapshot().muted });
        }
        if (verb === 'agenda') {
          try { return send(200, await h.agenda()); } catch (e) { return send(502, { error: `could not read the agenda: ${e?.message ?? e}` }); }
        }
        if (verb === 'record') {
          try { return send(200, { record: await huddleSaveRecordFor(id, rec) }); } catch (e) { return send(502, { error: `could not save the record: ${e?.message ?? e}` }); }
        }
        if (verb === 'spec') {
          const record = huddleLoadRecord(P.stateDir, id);
          if (!record) return send(409, { error: 'save the record first' });
          const markdown = huddleDraftSpec(record);
          const filename = `huddle-${id}-spec.md`;
          fs.writeFileSync(path.join(P.stateDir, 'huddle-records', filename), markdown);
          return send(200, { filename, markdown });
        }
        if (verb === 'kickoff') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
          const out = await huddleKickoff(rec, { mode: body.mode, state: body.state, picks: body.picks, project: body.project, slack: body.slack, actor: resolveActor(req) });
          return send(out.status, out.body);
        }
        if (verb === 'say') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
          // Serialized per huddle: two Lead calls never run at once. A newer
          // operator line supersedes the turn in flight (the session's own
          // rule), so it is interrupted, then this line waits for it to settle.
          // The line itself is recorded and broadcast now (hear), so a
          // superseding line shows at once; only its turn waits.
          const prev = rec.saying;
          if (prev) h.interrupt();
          let line;
          try { line = h.hear(String(body.text ?? '')); } catch (e) {
            if (/huddle ended/.test(e?.message ?? '')) return send(409, { error: 'huddle ended' });
            throw e;
          }
          const work = huddleIsWorkCommand(line.clean);
          const actor = resolveActor(req);
          const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : undefined;
          const run = (prev ?? Promise.resolve()).then(() => (work ? huddleWorkTurn(rec, { project, actor }) : h.respond(line)));
          const settled = run.catch(() => {});
          rec.saying = settled;
          settled.then(() => { if (rec.saying === settled) rec.saying = null; });
          try {
            return send(200, await run);
          } catch (e) {
            if (/huddle ended/.test(e?.message ?? '')) return send(409, { error: 'huddle ended' });
            throw e;
          }
        }
        return send(404, { error: 'no such huddle verb' });
      }
      // Parked-session long poll: the launched agent's between-phases channel.
      // Loopback trust, same as /devlog and /gate; the facade validates the
      // ticket against the live ledger. 503 when SCUT is not running so the
      // agent's first-poll fallback (close the card as usual) kicks in.
      if (u.pathname === '/api/scut/park' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!scut?.parkPoll) return send(503, { error: 'scut not running' });
        return send(200, await scut.parkPoll(String(body.ticket ?? '')));
      }
      // Operator-approved actions: an agent asks, the operator's phrase in the
      // ticket's Slack thread approves. Loopback trust, same as the park poll;
      // only a registered action name is accepted and the body carries no command.
      if (u.pathname === '/api/approvals/request' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!scut?.requestApproval) return send(503, { error: 'scut not running' });
        const r = await scut.requestApproval({ action: body.action, ticketId: body.ticket });
        return send(r.ok ? 200 : 409, r);
      }
      // glmps-2-0-124: an agent starts a registered action whose definition allows
      // agents (restart, deploy, app rebuild). The server runs it; the body names
      // an action and a ticket and carries nothing that reaches a command.
      if (u.pathname === '/api/approvals/run' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (!scut?.runRegisteredAction) return send(503, { error: 'scut not running' });
        const ticket = String(body.ticket ?? '').trim();
        if (!ticket) return send(400, { error: 'ticket is required' });
        const r = await scut.runRegisteredAction({ action: body.action, ticketId: ticket, trigger: 'agent', requireAgent: true });
        return send(r.ok ? 200 : 409, r);
      }
      // glmps-2-0-140: the Settings > Server "Rebuild desktop app" row. The
      // same registered action agents start, so the cooldown and outcome log
      // are shared; the local-session guard keeps it to the operator.
      // glmps-2-0-170: the Settings > Server "Restart" row: update if a tested
      // commit waits, rebuild the app if stale, restart, verify. Progress is read
      // from GET /api/approvals (the run's steps are in its ledger).
      if (u.pathname === '/api/actions/restart-all' && req.method === 'POST') {
        if (!scut?.runRegisteredAction) return send(503, { ok: false, reason: 'scut-not-running' });
        const r = await scut.runRegisteredAction({ action: 'restart-all', ticketId: null, trigger: 'operator' });
        return send(r.ok ? 200 : 409, r);
      }
      if (u.pathname === '/api/actions/rebuild-app' && req.method === 'POST') {
        if (!scut?.runRegisteredAction) return send(503, { ok: false, reason: 'scut-not-running' });
        const r = await scut.runRegisteredAction({ action: 'rebuild-app', ticketId: null, trigger: 'operator' });
        return send(r.ok ? 200 : 409, r);
      }
      if (u.pathname === '/api/approvals' && req.method === 'GET') {
        if (!scut?.approvalsView) return send(503, { error: 'scut not running' });
        return send(200, scut.approvalsView());
      }
      if (u.pathname === '/api/runner/config' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const allowed = ['enabled', 'maxConcurrent', 'operatorSlots', 'maxRuntimeMs', 'maxRetries', 'lastTarget', 'openTarget', 'useWorktrees'];
        const patch = {};
        for (const k of allowed) if (k in body) patch[k] = body[k];
        // Card glmps-2-0-162: which non-Claude vendors may run cards, merged per vendor.
        if ('vendors' in body) {
          const v = mergeVendorsConfig(runnerStore.loadConfig(P.stateDir).vendors, body.vendors);
          if (v.error) return send(400, { error: v.error });
          patch.vendors = v.value;
        }
        const saved = runnerStore.saveConfig(P.stateDir, patch);
        if (!mergeQueueMayRun()) haltMergeQueue();
        return send(200, saved);
      }
      const runMatch = u.pathname.match(/^\/api\/runner\/run\/([^/]+)$/);
      if (runMatch && req.method === 'POST') {
        if (!(env.GLMPS_RUNNER_DRYRUN || env.GLMPS_ALLOW_ACT === '1')) {
          const gate = assertCanAct(P, adapters);
          if (!gate.ok) return send(gate.status, gate.body);
        }
        const { status, body } = await runJobNow(decodeURIComponent(runMatch[1]));
        return send(status, body);
      }

      // Static-asset responses (web/ files + generated wiki pages) carry
      // Cache-Control: no-cache + Last-Modified so browsers ALWAYS revalidate:
      // a rebuilt wiki page or edited asset shows on the next refresh (the
      // "web/ is live on refresh" promise), while unchanged files return a
      // cheap 304. Without these headers browsers heuristically cached assets,
      // serving a stale wiki page AND a stale wiki.js (so the client-side
      // cache-bust never even ran). Data lives on /api/* and is unaffected.
      const serveStatic = (filePath, typeOverride, extraHeaders = {}) => {
        const st = fs.statSync(filePath);
        const modMs = Math.floor(st.mtimeMs / 1000) * 1000; // HTTP dates are 1s-resolution
        const lastMod = new Date(modMs).toUTCString();
        const ims = req.headers['if-modified-since'];
        if (ims && !Number.isNaN(Date.parse(ims)) && modMs <= Date.parse(ims)) {
          res.writeHead(304, { 'cache-control': 'no-cache', 'last-modified': lastMod, ...extraHeaders });
          return res.end();
        }
        res.writeHead(200, {
          'content-type': typeOverride || MIME[path.extname(filePath)] || 'application/octet-stream',
          'cache-control': 'no-cache',
          'last-modified': lastMod,
          ...extraHeaders,
        });
        return res.end(fs.readFileSync(filePath));
      };

      // published build in <stateDir>/wiki. Decided on the RAW url, so a ".."
      // segment is refused before URL normalization could hide it. Extensionless
      // /wiki and /wiki/<slug> fall through to the SPA wiki view below.
      if (req.method === 'GET' && isWikiAssetRequest(req.url)) {
        const r = resolveWikiRequest({ rawUrl: req.url, stateDir: P.stateDir });
        if (r.status !== 200) return send(r.status, { error: r.error });
        return serveStatic(r.file, undefined, UNTRUSTED_HTML_HEADERS);
      }

      // Non-MC projects generate their wiki under <root>/graphify-out/wiki/
      // (scripts/wiki-build-cli.mjs), which the static handler below can't
      // reach (it's rooted at WEB_DIR). Serve those pages here instead --
      // strictly for a root already in the same collectGraphRoots() allowlist
      // /api/wiki/rebuild uses, keyed by basename (the URL never carries a
      // filesystem path). The generated doc's <head> references
      // /observability/wiki-doc.css and /vendor/* as absolute paths
      // (wiki-render.js renderDoc defaults), which this same server already
      // serves -- so they resolve correctly from a /wiki-ext/ request too.
      const wikiExtMatch = u.pathname.match(/^\/wiki-ext\/([^/]+)\/([^/]+)$/);
      if (wikiExtMatch && req.method === 'GET') {
        const projectKey = decodeURIComponent(wikiExtMatch[1]);
        const fileName = decodeURIComponent(wikiExtMatch[2]);
        // Slug must be a bare filename -- no separators, no traversal segments.
        const slugMatch = fileName.match(/^([A-Za-z0-9._-]+)\.html$/);
        if (!slugMatch) return send(400, { error: 'invalid wiki slug' });
        const root = resolveGraphRootByKey(projectKey);
        if (!root) return send(404, { error: 'project not found' });
        const wikiDir = path.join(root, 'graphify-out', 'wiki');
        const filePath = path.join(wikiDir, `${slugMatch[1]}.html`);
        // Belt-and-suspenders: the regex above already rules out traversal,
        // but confirm the resolved path never leaves the project's wiki dir.
        const resolvedWikiDir = path.resolve(wikiDir) + path.sep;
        if (!path.resolve(filePath).startsWith(resolvedWikiDir)) return send(400, { error: 'invalid wiki path' });
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(404, { error: 'not found' });
        // the string check above cannot see a symlink or junction; the
        // REAL path must stay inside the wiki dir too (same rule as /wiki/*).
        let contained = false;
        try { contained = realpathContained(filePath, wikiDir); } catch { contained = false; }
        if (!contained) return send(404, { error: 'not found' });
        return serveStatic(filePath, undefined, UNTRUSTED_HTML_HEADERS);
      }

      // wiki pages built before D21 (another project's
      // graphify-out/wiki via /wiki-ext/, or a page carried forward) still
      // load the retired /vendor/mermaid.min.js; answer it with the
      // wiki-assets file rather than putting mermaid back in web/vendor.
      if (u.pathname === '/vendor/mermaid.min.js' && req.method === 'GET')
        return serveStatic(path.join(WEB_DIR, 'wiki-assets', 'mermaid.min.js'));

      // static files
      const file = path.join(WEB_DIR, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
      if (path.resolve(file).startsWith(path.resolve(WEB_DIR)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        // A font request is CORS-mode, and the sandboxed wiki iframe is an
        // opaque origin, so its fetch of /fonts/* is cross-origin.
        return serveStatic(file, undefined, path.extname(file) === '.woff2' ? { 'access-control-allow-origin': '*' } : {});
      }
      // SPA route fallback: GET with no file extension and not /api/* -> serve the
      // app shell so client-side routes (/history, /detail/<id>, ...) load + refresh.
      if (req.method === 'GET' && !u.pathname.startsWith('/api/') && !path.extname(u.pathname)) {
        const indexFile = path.join(WEB_DIR, 'index.html');
        if (fs.existsSync(indexFile)) return serveStatic(indexFile, 'text/html');
      }
      send(404, { error: 'not found' });
    } catch (e) {
      if (res.headersSent) console.error('[http] handler failed after answering', req.method, u.pathname, e?.message ?? e);
      else send(...bodyErrorReply(e, req));
    }
  });

  // glmps-75: Node's http.Server default keepAliveTimeout (5000ms)
  // destroys an IDLE keep-alive socket that long after its last response, so
  // it can race a client that reuses that same socket for its next request.
  // Ordinarily that race window is a few milliseconds wide and never fires.
  // But any multi-second stall of this process's event loop (a busy desktop,
  // several server-booting test files under load) is long enough to blow
  // straight through the 5s window. The runner's git and process work is async
  // and no longer stalls the loop itself, so this is defence in depth. When the loop finally frees up, Node processes
  // the overdue keepAliveTimeout and destroy()s a socket a client has *already* written
  // its next request onto, which the client observes as ECONNRESET -- with
  // no server-side exception, since a timed-out idle-socket destroy is
  // normal Node behavior, not an error.
  //
  // Proven causal (not just correlated): a throwaway harness running the
  // exact runner-worktree.test.js request sequence against 4 concurrent
  // server instances (same load shape, cfg.runnerTickMs's production
  // default of 5000ms) reproduced this at 51/60 (85%) with the stock 5000ms
  // keepAliveTimeout, and 0/60 with keepAliveTimeout raised -- toggled back
  // and forth, same load, same code, only this one value changed. See
  // glmps-75.
  //
  // 65s matches the long-standing convention for exactly this Node.js class
  // of bug (comfortably above the 60s idle timeout of common reverse
  // proxies/load balancers, which is where this race was first widely
  // documented). headersTimeout is bumped alongside it, keeping Node's own
  // default ordering (headersTimeout > keepAliveTimeout) intact.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // `closeRef` is read here by defaultRestart but only assigned far
  // below, where the returned object's `close` property is built (that
  // property is this function's one and only implementation of "shut this
  // server down"; see the K2 fix-round-1 comment there for why it is safe to
  // call more than once). That ordering is safe because nothing in this
  // function body ever awaits between `server.listen()` succeeding (a few
  // lines below) and `closeRef` being assigned at the return statement: this
  // whole stretch runs as one synchronous-relative-to-the-event-loop chain,
  // so no incoming request -- and therefore no call to defaultRestart, which
  // only ever runs from an HTTP handler or an injected restartFn -- can be
  // dispatched in between. `closeRef` is always populated before it is ever
  // read.
  let closeRef;
  // the private bind's HTTPS listener (null on a loopback bind).
  let privateServer = null;
  // the shared idempotency guard for closeRef -- see the
  // comment at its assignment, below, for why.
  let closingPromise = null;
  // close() returns after a bounded loop drain, but the sqlite stores stay open
  // until a slow loop run settles. A caller that deletes the state dir (a test's
  // temp dir on Windows) has to wait for this, or the open handle fails it EPERM.
  let resolveStoresClosed;
  const storesClosed = new Promise((r) => { resolveStoresClosed = r; });

  // Restart: release the port, respawn the same entry detached, then exit.
  // Injectable so it can be unit-tested without killing the test runner.
  const defaultRestart = async () => {
    // Service mode (K2): WinSW supervises this process and restarts it on a
    // non-zero exit. Spawning a detached respawn AND exiting under the
    // service would leave two servers running -- the supervised one WinSW
    // brings back, and the unsupervised one this process just spawned. So a
    // service-mode restart only closes and exits; it never spawns. `exit` is
    // threaded through as restartExitFn so a test can prove
    // this without ending the test process; closeServer reuses the same
    // `closeRef` the SIGINT/SIGTERM handler calls, and that shared guard is
    // what keeps a restart racing a service stop from running close() twice.
    // The shadow supervisor (2.0 down alert) is the same shape: it respawns on
    // exit 75, so a supervised restart must not spawn an unsupervised copy
    // whose output is discarded.
    if (isServiceMode(env) || SUPERVISED_AT_BOOT || env.GLMPS_SUPERVISED === '1') {
      return serviceRestart({
        closeServer: () => closeRef(), exit: restartExitFn,
        stage: () => closeStage,
        onOverrun: (s) => { try { noteStopOverrun(P.stateDir, s); } catch { /* exit(75) still runs */ } },
      });
    }
    // Drain our timers and SSE clients first. Otherwise server.close() never fires its
    // callback (open /api/events streams keep it pending), the await hangs, process.exit
    // is never reached, and the old process leaks -- still polling tasklist every tick.
    try { clearInterval(pollTimer); clearInterval(agTimer); clearInterval(invTimer); clearInterval(unmergedRefreshTimer); } catch {}
    try { for (const c of clients) c.end(); } catch {}
    try { server.close(); privateServer?.close(); } catch {}
    try {
      const entry = process.argv[1];
      // Detached on purpose: the replacement server must outlive this process, which exits next.
      if (entry) restartSpawnFn(process.execPath, [entry], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {}
    restartExitFn(0);
  };
  const triggerRestart = restartFn ?? defaultRestart;

  // Bind with retry: the respawned process may briefly race the old one for the port.
  // A private bind keeps plain HTTP on loopback only; the network gets HTTPS below.
  const listenHost = nonLocal ? '127.0.0.1' : bindHost;
  bootTrace.mark('routes and loops');
  await new Promise((resolve, reject) => {
    let attempts = 0;
    const onErr = (e) => {
      if (e && e.code === 'EADDRINUSE' && attempts < 20) {
        attempts++;
        setTimeout(() => server.listen(cfg.port, listenHost), 250);
      } else {
        server.removeListener('error', onErr);
        reject(e);
      }
    };
    server.on('error', onErr);
    server.once('listening', () => { server.removeListener('error', onErr); resolve(); });
    server.listen(cfg.port, listenHost);
  });
  const actualPort = server.address().port;
  // The private bind's HTTPS listener, at the same port as loopback. Client
  // certificates are requested, not required, so a browser without one still
  // completes the handshake and the access guard decides.
  if (nonLocal) {
    privateServer = https.createServer({
      cert: serverTls.cert, key: serverTls.key, ca: serverTls.ca,
      requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2',
    }, (req, res) => server.emit('request', req, res));
    privateServer.keepAliveTimeout = server.keepAliveTimeout;
    privateServer.headersTimeout = server.headersTimeout;
    try {
      await new Promise((resolve, reject) => {
        privateServer.once('error', reject);
        privateServer.listen(actualPort, listenHostOverride ?? bindHost, () => { privateServer.removeListener('error', reject); resolve(); });
      });
    } catch (e) {
      await new Promise((r) => server.close(r));
      throw e;
    }
  }

  bootTrace.waited('listen');

  agLabels = loadAgLabels(P.antigravityDirs);
  // The first poll and the boot inventory scan run in the boot stages at the
  // end of this function, after closeRef is assigned (card
  // glmps-2-0-runtime-93).
  const invOpts = () => ({ pluginsCacheDir: P.pluginsCacheDir, projectsDir: P.projectsDir,
    claudeDir: P.claudeDir,
    projectRoots: [...new Set(index.list({}).filter(r => !r.clientId).map(r => r.cwd).filter(Boolean))] });
  let scanInvInFlight = null;
  const scanInv = () => {
    if (scanInvInFlight) return scanInvInFlight;
    scanInvInFlight = scanInventoryAsync(invOpts())
      .then((inv) => { inventory = inv; })
      .catch((e) => reportMiss('inventory-scan', e?.message ?? String(e)))
      .finally(() => { scanInvInFlight = null; });
    return scanInvInFlight;
  };
  // Session memory distiller sweeper: the safety net for sessions that never
  // reached the Stop hook (crash/kill/terminal-close). On boot it either does
  // the first-run backfill (mark history processed) or one sweep, then repeats
  // on `sweepIntervalMs`. Restricted to real git-repo roots, which also keeps
  // the extractor's throwaway-cwd session from ever being distilled.
  const mdKnownRoots = () => {
    try { return collectGraphRoots().filter(r => { try { return fs.existsSync(path.join(r, '.git')); } catch { return false; } }); }
    catch { return []; }
  };
  const memoryDistillSweep = () => {
    if (!mdCfg.enabled) return;
    try {
      mdRunSweep({ stateDir: P.stateDir, paths: P, cfg: mdCfg, knownRoots: mdKnownRoots() });
      // same last-resort net as the
      // manual-enqueue call site above - must surface, never swallow.
      mdDrainQueue({ stateDir: P.stateDir, cfg: mdCfg, emit: (kind, payload) => loopRegistry.emit(kind, payload) })
        .catch((e) => console.error('[loops] memory distill sweep drain failed', e && e.message ? e.message : String(e)));
    } catch { /* fail-open */ }
  };
  // Captured (not fire-and-forget) so close() below can clearInterval it -
  // every startServer() call in the 39-odd test files that boot one leaked
  // this handle otherwise (glmps-8).
  let memoryDistillTimer = null;
  if (mdCfg.enabled) {
    // Interval-only (no synchronous boot sweep): the first sweep fires after
    // sweepIntervalMs (default 15m), so booting never blocks on scanning history
    // and the test suite - which boots + closes the server in seconds - pays
    // nothing. Immediate capture on a clean exit is the Stop-hook ping's job;
    // the sweeper is the delayed net for sessions that never reached Stop.
    memoryDistillTimer = setInterval(memoryDistillSweep, mdCfg.sweepIntervalMs);
    memoryDistillTimer.unref?.();
  }
  // D23/D24: the memory plugin retry tick (glmps-159 task 6), extended for
  // the judge cutover (task 8) to the SAME tick. K Task 6 replaces this
  // whole setInterval + runRetryTick wiring with the registered plugin-retry
  // loop (server/lib/loops/plugin-loops.js, registered earlier by
  // registerPluginLoops): it already self-schedules every 5 minutes through
  // the loop registry, drains both memory.admit and judge.session jobs from
  // the SAME retryQueue, and reports its own failures through loopAlerts -
  // there is nothing left here to wire.
  // Finalize sweep (GLMPS 2.0 shadow-instance plan, Task 1): default OFF (see
  // cfg.outcomes.finalizeSweep above) - production's Stop hook already pings
  // POST /api/outcomes/finalize on every turn, so only an isolated instance
  // with no Stop hook wired to it (the 2.0 shadow) turns this on. On each
  // tick, every known session is checked against the pure
  // pickSessionsToFinalize rule (finalize-sweep.js, including its maxAgeMs
  // cap - see cfg.outcomes.finalizeSweep above - so a fresh shadow state dir
  // does not finalize and queue judge model calls for every historical
  // session already sitting in the index) and each one it returns is
  // finalized via the SAME finalizeAndQueueJudge the route above calls, just
  // with notBefore already due (lastActivityTs + idleMs is, by construction,
  // <= now) instead of pushed idleMs into the future - a sweep never delays a
  // job the way the route's own `Date.now() + idleMs` would.
  // hasOutcomeRow/hasJudgeJob are snapshotted once per tick (not re-read per
  // session) to avoid an O(sessions) re-parse of the outcome/retry-queue
  // files. retryQueue has no "list every job regardless of due date" method
  // of its own; `take(n, { now: Infinity })` is take()'s own due-filter
  // (`!j.notBefore || j.notBefore <= now`) made a no-op by passing a `now`
  // no real notBefore can exceed, which is exactly "all jobs, due or not".
  //
  // runFinalizeSweep isolates each session's
  // finalizeAndQueueJudge call in its own try/catch (matching runRetryTick's
  // per-job isolation in memory-plugin.js) - one throwing session is reported
  // by sessionId under 'judge' and never skips or starves any other due
  // session in the same tick. The outer try/catch below is now only for a
  // failure in the setup above (listing sessions, reading outcomes/queue
  // state), a single-shot risk shared by the whole tick, not per-session.
  // finalizeAndQueueJudge is passed the sweep-only loadDurableEventsIfMissing
  // flag (see its own comment) so a session whose in-memory eventLog is empty
  // after a restart is rebuilt from the durable event log instead of being
  // finalized empty.
  //
  // Non-overlapping and fail-open: a bug here must never crash the server or
  // silently stop finalizing sessions. This sweep is not one of K Task 6's
  // four plugin loops (allowlist.js: "becomes a registered loop when its
  // owner migrates it onto the registry" - a later phase's job), so its own
  // failures go through reportMiss under the 'finalize-sweep' kernel-health
  // id instead of a registered loop's own failure streak.
  let finalizeSweepRunning = false;
  function finalizeSweepTick() {
    if (finalizeSweepRunning) return;
    finalizeSweepRunning = true;
    try {
      const now = Date.now();
      const sessions = index.list({}).map((r) => ({
        sessionId: r.id,
        lastActivityTs: r.lastTs ?? 0,
        eventCount: r.eventCount ?? 0,
      }));
      const outcomeIds = new Set(readOutcomes(P.stateDir).map((r) => r.id));
      const judgeSessionIds = new Set(
        retryQueue.take(Number.MAX_SAFE_INTEGER, { now: Infinity })
          .filter((j) => j.kind === 'judge.session')
          .map((j) => j.sessionId)
      );
      let sweepHadError = false;
      runFinalizeSweep({
        sessions, now, idleMs: judgeCfg.idleMs, maxAgeMs: cfg.outcomes.finalizeSweep.maxAgeMs,
        hasOutcomeRow: (sid) => outcomeIds.has(`session-${sid}`),
        hasJudgeJob: (sid) => judgeSessionIds.has(sid),
        finalizeAndQueueJudge: (sid, opts) => finalizeAndQueueJudge(sid, { ...opts, loadDurableEventsIfMissing: true }),
        onError: (sid, e) => {
          sweepHadError = true;
          const reason = `session ${sid}: ${e && e.message ? e.message : String(e)}`;
          console.error('[loops] finalize sweep failed for', reason);
          reportMiss('finalize-sweep', reason); // I8
        },
      });
      if (!sweepHadError) clearMiss('finalize-sweep'); // a clean tick ends any earlier failure episode.
    } catch (e) {
      const reason = e && e.message ? e.message : String(e);
      console.error('[loops] finalize sweep tick failed', reason);
      reportMiss('finalize-sweep', reason); // I8
    } finally {
      finalizeSweepRunning = false;
    }
  }
  const finalizeSweepTimer = cfg.outcomes.finalizeSweep.enabled
    ? setInterval(finalizeSweepTick, cfg.outcomes.finalizeSweep.tickMs) : null;
  finalizeSweepTimer?.unref?.();
  // glmps-155: memory usage telemetry + pressure-driven index eviction.
  //
  // Interval-only and deliberately slow (30m): this is an accumulator, not a
  // hot loop, and the longer it runs before evicting anything the better the
  // evidence behind each decision. runEviction is a no-op whenever the index
  // fits its budget, which is the expected steady state - so on a normal box
  // this tick only ever folds new read events into usage.json.
  //
  // Fail-open like every other lifecycle tick here: memory telemetry must
  // never throw into setInterval.
  const memoryUsageTick = () => {
    try {
      memRefreshUsage(P.stateDir);
      memRunEviction({
        memoryDir: P.memoryDir,
        stateDir: P.stateDir,
        budgetBytes: memBudget(),
        usage: memReadUsage(P.stateDir).facts,
      });
    } catch { /* fail open */ }
  };
  const memoryUsageTimer = setInterval(memoryUsageTick, 30 * 60 * 1000);
  memoryUsageTimer.unref?.();
  // glmps-140: measurablesTick (defined above `const server = http.
  // createServer`) replaces GET /api/measurables's old per-request
  // self-populate side effect. Unlike memoryDistillSweep just above (interval-
  // only, first sweep after sweepIntervalMs), this one DOES run once at boot,
  // in the boot stages before startServer resolves, specifically so the store
  // is never empty before the first interval elapses (the exact behavior GET
  // /api/measurables used to guarantee by computing fresh on every hit). Every
  // compute*/persist* pair it calls is already fail-open per row/kind, so a
  // malformed state dir at boot can never throw out of this call.
  const measurablesTickMs = 5 * 60 * 1000; // 5 min: candidate freshness, not a hot loop
  const measurablesTimer = setInterval(measurablesTick, measurablesTickMs);
  measurablesTimer.unref?.();
  // Skill capability-lifecycle (glmps-87/88), same fail-open/unref discipline
  // as memoryDistillSweep above. Archive-scan (no network) runs whenever
  // skCfg.enabled (default true); the update-check sub-step only fires when
  // the operator opted into skCfg.checkUpdates (default false - new network
  // egress); the discovery sub-step (glmps-87's registry-scan producer) only
  // fires when cfg.skillDiscovery.enabled (default false) AND a non-empty
  // registries allowlist is configured. Every candidate list here is pure and
  // recomputed fresh - nothing about this tick mutates a skill's real files;
  // see skill-retire.js / skill-adopt-store.js's own propose-only guarantees.
  //
  // fetchLatestVersionFn: a real (not fabricated) upstream check, built on
  // the SAME git binary + async-limited exec this server already uses for
  // worktree/unmerged-branch scanning (gitExecAsync) - treats sourceRepo as a
  // git remote and resolves sourceRef (default HEAD) to its current commit
  // SHA via `git ls-remote`. Never guesses a registry-specific HTTP API.
  async function realFetchLatestVersion({ sourceRepo, sourceRef }) {
    if (!sourceRepo) return null;
    // gitExecAsync (via execFileAsync) resolves directly with stdout (a
    // string), not an {stdout,stderr} object - same shape every other
    // gitExecAsync caller in this file already relies on.
    const stdout = await gitExecAsync('git', ['ls-remote', sourceRepo, sourceRef || 'HEAD']);
    const sha = String(stdout ?? '').split(/\r?\n/)[0]?.split(/\s+/)[0];
    return sha || null;
  }
  function runSkillDiscoveryPass() {
    if (!cfg.skillDiscovery.enabled || !cfg.skillDiscovery.registries?.length) return;
    (async () => {
      const lq = learningStore.load(P.stateDir);
      const shadow = shadowRates(P.stateDir);
      // "recurring gaps with no effective remediation" (design doc Part
      // B.1): no guard was ever proposed for the gap, or one was but its
      // shadow-arm counterfactual never fires (guard-retire.js's own "would
      // this have helped" signal) - a gap already well-handled by a guard is
      // not a discovery candidate.
      const needsRemediation = (lq.items ?? []).filter((it) => {
        if (!it || it.source !== 'gap' || !it.code) return false;
        if (it.status === 'discarded' || it.status === 'applied') return false;
        const hasGuard = !!it.proposedGuard?.rule;
        if (!hasGuard) return true;
        const bucket = shadow.byClass?.[it.code];
        return !bucket || bucket.counterfactualRate === 0;
      });
      if (!needsRemediation.length) return;
      const registrySkills = await listRegistrySkills(cfg.skillDiscovery.registries, {});
      // Adoption pre-filter (glmps-87): a NECESSARY-not-sufficient trust
      // gate on executable third-party skill content, fail-closed (the
      // opposite of listRegistrySkills' own fail-open discipline above) - 
      // see skill-adopt-prefilter.js's header comment. Only candidates that
      // affirmatively pass (star floor + freshness + not-archived, or an
      // operator-marked trusted/official registry) are eligible to match
      // against a gap at all.
      const { eligible } = await filterEligibleAdoptCandidates(registrySkills, {
        registries: cfg.skillDiscovery.registries,
        starFloor: cfg.skillDiscovery.starFloor,
        freshnessMonths: cfg.skillDiscovery.freshnessMonths,
        nowMs: Date.now(),
      });
      for (const gapItem of needsRemediation) {
        const match = matchGapToCandidate({ code: gapItem.code, message: gapItem.body }, eligible, cfg.skillDiscovery.simThreshold);
        if (match) skillAdoptStore.upsertCandidate(P.stateDir, match.candidate, gapItem.code);
      }
    })().catch(() => { /* fail-open - a broken registry/network never breaks the tick */ });
  }
  const skillLifecycleTick = () => {
    if (!skCfg.enabled) return;
    try {
      const skillEvents = readEvents(P.stateDir, {}).filter(e => e.kind === 'skill');
      const view = buildSkillsView(inventory, skillEvents);
      recordFirstSeen(P.stateDir, view.skills.filter(s => s.installed).map(s => s.id));
      // archiveCandidates itself is recomputed fresh per-request too (the
      // /api/changes and /api/skills/lifecycle routes above) - this tick's
      // own call only drives recordFirstSeen's idempotent bookkeeping.
      if (skCfg.checkUpdates) {
        checkForUpdates(loadProvenance(P.stateDir), realFetchLatestVersion)
          .then((m) => saveProvenance(P.stateDir, m)).catch(() => {});
      }
      runSkillDiscoveryPass();
    } catch { /* fail-open, matches memoryDistillSweep's own try/catch */ }
  };
  // Captured (see memoryDistillTimer above) so close() can clearInterval it.
  const skillLifecycleTimer = skCfg.enabled ? setInterval(skillLifecycleTick, skCfg.tickMs) : null;
  skillLifecycleTimer?.unref?.();
  // Cross-agent-memory trial lifecycle: one tick every 15 minutes,
  // mirroring the existing skill-lifecycle tick cadence. Same baseline path
  // as the request-scoped registerRoute handlers above (server.js Task 13) - 
  // recomputed here because this tick runs outside the per-request scope.
  // No dedicated enabled-flag exists for this feature in a config module:
  // unlike mdCfg/skCfg, cross-agent-memory.js has no
  // config-resolution function of its own. Left unconditional here, matching
  // its pre-existing behavior. See glmps-8 FINDINGS.
  let crossAgentMemoryTrialTimer = null;
  {
    const camTickBaselinePath = path.join(P.stateDir, 'cross-agent-memory', 'baseline.json');
    const camObservationCounts = new Map();
    crossAgentMemoryTrialTimer = setInterval(() => {
      try {
        const findings = computeMemoryAttestation({ baselinePath: camTickBaselinePath }).findings ?? [];
        runTrialTick(P.stateDir, { attestationFindings: findings, observationCounts: camObservationCounts }, { minObservations: 4 });
      } catch { /* fail-open - never crash the server on a tick */ }
    }, 15 * 60 * 1000);
    crossAgentMemoryTrialTimer.unref?.();
  }

  // Decision-log sweep (glmps-143). Hourly is deliberate: the unit is a merge
  // to main, which happens a couple of times a day, so a tighter interval just
  // spawns git across every repo for nothing. Skips and backfill caps are
  // logged by sweepRepos itself, never swallowed.
  function decisionSweepTickFn() {
    sweepDecisionRepos({
      repos: decisionRepos(),
      stateDir: P.stateDir,
      runGit: decisionRunGit,
      now: Date.now(),
      backfillDays: Number(env.GLMPS_DECISION_BACKFILL_DAYS) || undefined,
      log: (m) => console.log('[decision-log]', m),
    }).catch((e) => console.error('[decision-log]', e?.message ?? e));
  }
  const decisionSweepTimer = setInterval(decisionSweepTickFn, 60 * 60 * 1000);
  decisionSweepTimer.unref?.();
  // Kick one sweep shortly after boot so a fresh install is not empty until the
  // first hour elapses. Delayed, not immediate, to stay off the startup path.
  const decisionSweepKick = setTimeout(decisionSweepTickFn, 15_000);
  decisionSweepKick.unref?.();
  // Session-worktree sweeper (glmps-71 A4): on the inventory cadence, remove
  // worktrees whose session ended with nothing unmerged; keep dirty/unmerged
  // ones (they surface via the unmerged-branch alert instead). Live protection
  // uses the scrubbed 12-char shortid that sessionWorktreePlan bakes into the
  // branch, for every session that is not 'ended' (never sweep under a runner).
  //
  // Async + in-flight-guarded (glmps perf fix): this used to run execFileSync
  // per branch per repo, synchronously, at boot AND on every inventory-scan
  // tick (default every 60s) - measured at 17+ seconds of blocked event loop
  // on this workstation's real repo set, because the root list here also
  // used to skip the isProjectRootCandidate filter (now reused via
  // gitRepoRoots()) and counted 100+ agent-scratch-cwd "repos" instead of the
  // ~20 real ones. Every concurrent HTTP request queues behind a blocked
  // event loop, so this alone was the dominant cause of multi-second-to-tens-
  // of-seconds dashboard hangs. Now: properly filtered roots, non-blocking
  // execFile, concurrent across repos, and fire-and-forget from the timer/boot
  // call (never awaited there) so a slow sweep can't hold up anything else.
  let sweepWorktreesInFlight = false;
  // named per call site ("under a named
  // key per path" - sweep, createWorktree and removeWorktree each get their
  // own flag and their own reportMiss key), and per SERVER INSTANCE, not per
  // process (round 2's comment said "once per process", which overclaimed -
  // more than one startServer() can share a process, e.g. two boots in one
  // test file, and each gets to report its own refusal once).
  let sweepTestGuardLoggedThisInstance = false;
  // the test-write guard is applied PER ROOT. Round 3
  // checked REPO_ROOT alone as a stand-in for "the whole sweep", but the sweep
  // writes to every root gitRepoRoots() returns - so a checkout that itself
  // sits under os.tmpdir() (agent scratchpads do on this machine) passed the
  // single check and let the whole sweep run against real repos. Now every
  // root is checked with testRealGitWriteRefused (four independent
  // test-process signals; refuses only a root that is not a test's own temp
  // fixture), a refused root is skipped, and the refusal is reported once per
  // server instance. Only a root list that cannot be computed refuses the
  // whole sweep. Applied to an injected sweeper too, so the per-root filter
  // itself is observable in a test; it is a no-op in production (the
  // predicate is false outside a test process).
  // Accepted limit: a real checkout that itself
  // lives under os.tmpdir() is swept by its own test run - the guard cannot
  // tell it apart from a test's own temp fixture.
  function sweepableRoots() {
    let roots;
    try {
      roots = (gitRepoRootsFn ?? gitRepoRoots)().map(r => r.path);
    } catch (e) {
      reportMiss('sweep-worktrees-roots', `refused: the git repo root list could not be computed, so no root is swept: ${e?.message ?? e}`);
      return [];
    }
    // One sweep per repository (glmps-2-0-runtime-68 AC-4): every checkout of
    // a repo lists the same worktrees and branches, and sweeping each copy
    // repeated the per-branch `git cherry` pass, ~1,500 launches a minute.
    roots = dedupeByCommonDir(roots);
    const allowed = roots.filter(repo => !testRealGitWriteRefused(repo, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) }));
    if (allowed.length < roots.length && !sweepTestGuardLoggedThisInstance) {
      sweepTestGuardLoggedThisInstance = true;
      reportMiss('sweep-worktrees-test-guard', `refused ${roots.length - allowed.length} root(s): this is a test process and the root is not a temp fixture - a test process must never run the worktree sweeper against real repos`);
    }
    return allowed;
  }
  // A swept runner worktree that is a board card's checkout goes through the
  // same outcome-record gate as the runner's own reclaim. Any other worktree
  // (session/*, harness dirs, a card's reviewer checkout) is not gated here.
  const unreadableReported = new Set(); // card ids already reported once
  function sweepCardFor(dir, branch) {
    const jobId = jobIdFromRunnerBranch(branch);
    if (!jobId) return null;
    const card = backlogStore.load(P.stateDir).items.find((i) => i.id === jobId);
    return card?.runSession?.worktree?.dir && pathsEqual(card.runSession.worktree.dir, dir) ? card : null;
  }
  function sweepRemovalGate(repo, dir, branch) {
    // glmps-87: the sweeper's own occupancy is session liveness, which
    // an idle open session can fail; the OS is asked last, right before git.
    const occ = dirInUse(dir);
    if (occ.inUse) return { remove: false, reason: `in-use:${occ.reason}` };
    const card = sweepCardFor(dir, branch);
    if (!card) return { remove: true, reason: 'ungated' };
    return worktreeRemovalGate(card.id, { dir: card.runSession.worktree.dir, repo, branch });
  }
  function sweepMarkRemoved(repo, dir, branch) {
    const card = sweepCardFor(dir, branch);
    if (card) markWorktreeRemoved(card.id, { dir: card.runSession.worktree.dir, repo, branch });
  }
  const sweepWorktrees = async () => {
    // cfg.worktreeSweep.enabled is the explicit,
    // deep-merged config switch (defaults true in production; shadowConfig()
    // sets it false for the GLMPS 2.0 shadow instance). GLMPS_UNMERGED_SCAN=off
    // is the separate, pre-existing environment gate the shadow launcher
    // ALSO sets - two independent switches, either one alone keeps 2.0 from
    // ever running `git worktree prune` / `git branch -d` against a repo it
    // only observes.
    if (!cfg.worktreeSweep.enabled) return;
    if (env.GLMPS_UNMERGED_SCAN === 'off' || env.GLMPS_UNMERGED_SCAN === '0') return;
    if (sweepWorktreesInFlight) return;
    sweepWorktreesInFlight = true;
    const __PERF = !!env.GLMPS_PERF_TRACE;
    const __t0 = __PERF ? Date.now() : 0;
    try {
      const activeSessions = sessionSummaries().filter(s => s.state !== 'ended');
      const liveIds = activeSessions.map(s => wtSafeSeg(String(s.id).slice(0, 12)));
      // cwd-based occupancy is the protection that actually covers terminal
      // launches (their worktree shortid is a random launch-time id).
      const liveDirs = activeSessions.map(s => s.cwd).filter(Boolean);
      // glmps-162: a runner job's worktree is protected by its LEDGER ENTRY, not
      // by cwd occupancy. A just-launched agent is not in sessionSummaries() yet,
      // so liveDirs cannot see it, and its branch carries no session id for
      // liveIds to match. Read the ledger fresh on every sweep (never cache it):
      // this is the lease, and a stale lease list is how a checkout gets deleted
      // out from under a live agent.
      //
      // Known residual: loadLedger is readJson, which swallows a parse error and
      // returns {}, so a CORRUPT ledger reads as "no jobs running" and protects
      // nothing. That is the same assumption runnerTick already makes (it would
      // relaunch everything), so it is not made worse here, but it is the one
      // way this guard can silently be absent.
      // D27 C2: a hidden or idle ticket's worktree is leased by the
      // retention rule too, not just a live ledger entry - the same set
      // reconcileNow's departed loop already checks before ever reclaiming.
      const liveJobIds = [...new Set([...Object.keys(runnerStore.loadLedger(P.stateDir)), ...retainedWorktreeJobs()])];
      const roots = sweepableRoots();
      await Promise.all(roots.map(async (repo) => {
        try {
          await sweepSessionWorktreesFn({
            repo, worktreesDir: P.worktreesDir, liveSessionIds: liveIds, liveDirs, liveJobIds,
            exec: gitExecAsync, cherryCache,
            guard: ({ dir, branch }) => sweepRemovalGate(repo, dir, branch),
            // glmps-53: "log every sweeper removal with the reason (no
            // lease / not occupied / 0 unmerged)". The sweeper only reports WHAT
            // it removed; this durable event is the record of that decision.
            onRemove: ({ dir, branch, kind }) => {
              if (kind === 'worktree') {
                sweepMarkRemoved(repo, dir, branch);
                try { writeReclaimMarker(dir, { branch, by: 'sweeper', outcome: 'removed' }); } catch { /* fail-open */ }
              }
              try {
                appendEvent(P.stateDir, {
                  kind: 'worktree.swept', lane: 'runner', label: branch ?? '', path: dir ?? null,
                  op: kind, ts: Date.now(), sessionId: null,
                });
              } catch { /* fail-open */ }
            },
          });
        }
        catch { /* per-repo fail-open, never break the scan loop */ }
      }));
      persistCherryCache();
      if (__PERF) console.log(`[perf] sweepWorktrees took ${Date.now() - __t0}ms (roots=${roots.length})`);
    } catch { /* never break startup/interval */ }
    finally { sweepWorktreesInFlight = false; }
  };
  // Claims the top queued card and launches an interactive, agent-self-reporting
  // session seeded with the card's prompt (via a file the agent reads). Opt-in
  // (config.enabled), honors board pause, reconciles dead/overrunning sessions.
  const claudeCmd = (cfg.terminals.find(t => t.label === 'Claude')?.command) || 'claude';
  // glmps-40: single source of truth for the park-loop hold. Read
  // once here so launchJob's launchHeader call and startScut's scutParkPoll
  // (below) always agree; scutParkPoll no longer redeclares this locally.
  const parkHoldMs = Number(env.SCUT_PARK_HOLD_MS ?? 540_000);

  function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }


  // An old 2.0 project name finds the canonical project's checkout (card
  // glmps-2-0-runtime-151); checkoutForProject keeps the basename-then-slug order.
  function repoForProject(project) {
    return checkoutForProject(projectRoots(), project, projectTable);
  }

  function projectRoots() {
    // Mirror the /api/projects root set (collectGraphRoots is request-scoped):
    // REPO_ROOT + known session cwds + settings additionalDirectories, deduped,
    // then keep only real git repos and match basename === project (the card key).
    const seen = new Map();
    const add = (p) => {
      if (!p) return;
      // Same agent-scratch-cwd guard as collectGraphRoots() -- see lib/project-roots.js.
      if (!isProjectRootCandidate(p, { antigravityDirs: P.antigravityDirs, claudeDir: P.claudeDir })) return;
      const root = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); const k = root.toLowerCase(); if (!seen.has(k)) seen.set(k, root);
    };
    add(REPO_ROOT);
    for (const r of index.list({})) { if (!r.clientId) add(r.cwd); }
    try { const dirs = JSON.parse(fs.readFileSync(P.settingsFile, 'utf-8'))?.permissions?.additionalDirectories; if (Array.isArray(dirs)) dirs.forEach(add); } catch {}
    const roots = [...seen.values()].filter(root => {
      if (normRoot(root) === normRoot(REPO_ROOT)) return true;
      try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
    });
    return roots;
  }

  // glmps-2-0-43: the merge queue's testing stage (docs/specs/2026-10-17-glmps2-merge-queue.md).
  // In-flight test jobs live in memory only: a request found in 'testing' with
  // no job here was orphaned by a restart and is started again.
  const mergeJobs = new Map();
  const runMergeJobImpl = mergeTestsRun ?? mergeTests.runMergeTests;
  // A test process must not spawn a process lister per queue job.
  const countQueueTestProcs = countTestProcs ?? (env.GLMPS_TEST === '1' ? async () => null : mergeQueueRuns.defaultCountTestProcs);

  // The one place that decides whether the queue may act; later stages extend it.
  function mergeQueueMayRun() {
    try { return !!runnerStore.loadConfig(P.stateDir).enabled && !backlogStore.load(P.stateDir).paused; }
    catch { return false; }
  }

  // A Restart run is quiescing the box: nothing new may start. Unlike
  // mergeQueueMayRun this never transitions an in-flight request to held.
  // A hold no process can finish is released here (card glmps-2-0-173); until
  // startScut has returned, an open run is presumed resumable.
  function maintenanceHold() {
    try {
      if (readMaintenance(P.stateDir) == null) return false;
      // A failed release must not drop a real hold, so it keeps its own catch.
      try { releaseOrphanedMaintenance(P.stateDir, { entries: scutApprovalsLog(P.stateDir), resumer: !scutBooted || scut != null, bootTs: processBootTs }); } catch { /* keep the hold */ }
      return readMaintenance(P.stateDir) != null;
    } catch { return false; }
  }

  async function gitOriginOf(root) {
    const r = await runAsync('git', ['-C', root, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    if (r.status !== 0) throw new Error(r.stderr.trim() || `git exited ${r.status}`);
    return r.stdout.trim();
  }

  async function checkoutFor(mr) {
    const repos = cfg.mergeQueue?.repos ?? {};
    const key = Object.keys(repos).find((k) => k.toLowerCase() === String(mr.repo).toLowerCase());
    const override = key ? repos[key] : null;
    // findCheckout takes a synchronous remoteOf, so the origins are read first
    // (concurrently, behind the git limiter). A root whose origin cannot be read is skipped.
    const roots = projectRoots();
    const remotes = new Map();
    if (!override?.path) await Promise.all(roots.map(async (root) => { try { remotes.set(root, await gitOriginOf(root)); } catch { /* not a checkout with an origin */ } }));
    const repoPath = mergeUtil.findCheckout({ repo: mr.repo, roots, remoteOf: (root) => remotes.get(root) ?? null, override });
    if (repoPath) gitopsCheckouts.set(String(mr.repo).toLowerCase(), repoPath);
    return { override, repoPath };
  }

  function saveMergeRequest(id, mr, text) {
    backlogStore.setMergeRequestIn(P.stateDir, id, mr);
    if (text) {
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text });
      // by:'agent' because the room relay drops any other author as runner noise.
      scut?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
    }
    broadcastBacklog();
  }


  // glmps-2-0-runtime-98 F6: the queue tests each PR with only its affected
  // tests, so the full suite runs here, batched on each base the queue merged
  // into. Off in a test process unless a test injects the test command, so a
  // fixture checkout never runs a real suite.
  const mainSuiteFile = path.join(P.stateDir, 'merge-queue-main-suite.json');
  const readMainSuite = () => { try { return JSON.parse(fs.readFileSync(mainSuiteFile, 'utf8')); } catch { return {}; } };
  // glmps-2-0-runtime-125: a branch whose last full run is red takes no merge but a proven fix.
  function mainSuiteReds() {
    const out = {};
    for (const [key, rec] of Object.entries(readMainSuite() ?? {})) if (rec?.red) out[key] = rec.red;
    return out;
  }
  const redFor = (mr) => mainSuiteReds()[mergeQueue.integrationKey(mr)] ?? null;
  // Every integration branch the queue merged into, with its local checkout.
  async function mergedIntegrationTargets() {
    if (!mergeQueueMayRun()) return [];
    const byKey = new Map();
    for (const c of backlogStore.load(P.stateDir).items) {
      const m = c.mergeRequest;
      if (m?.stage !== 'merged') continue;
      const key = mergeQueue.integrationKey(m);
      if (!byKey.has(key)) byKey.set(key, { key, repo: m.repo, base: m.base, project: c.project, mr: m });
    }
    const out = [];
    for (const t of byKey.values()) {
      const { repoPath } = await checkoutFor(t.mr);
      if (!repoPath || testRealGitWriteRefused(repoPath, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) continue;
      out.push({ key: t.key, repo: t.repo, base: t.base, project: t.project, repoPath });
    }
    return out;
  }
  // Card glmps-2-0-173: a queue merge kicks the full run, so main is certified for promotion soon after.
  let mainSuiteLoop = null;
  if (cfg.mergeQueue?.mainSuite !== false && (env.GLMPS_TEST !== '1' || mainSuiteRunTest)) {
    mainSuiteLoop = loopRegistry.registerLoop({
      name: 'merge-queue-main-suite',
      trigger: { everyMs: 30 * 60_000 },
      ...mainSuite.createMainSuiteLoop({
        targets: mergedIntegrationTargets,
        git: (args, { cwd }) => (gitopsViaShell ? shellSeams.git(args, { cwd }) : mergeUtil.defaultGit(args, { cwd })),
        runTest: mainSuiteRunTest ?? (gitopsViaShell ? shellSeams.runTest : mergeUtil.defaultRunTest),
        readPkg: (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } },
        readState: readMainSuite,
        writeState: (doc) => { const tmp = `${mainSuiteFile}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(doc, null, 2)); fs.renameSync(tmp, mainSuiteFile); },
        queueBusy: () => !mergeQueueMayRun() || maintenanceHold() || mergeJobs.size > 0
          || backlogStore.load(P.stateDir).items.some((c) => c.mergeRequest?.stage === 'testing'),
        fileCard: (c) => { const r = fileCard({ ...c, source: 'merge-queue' }); broadcastBacklog(); return r; },
        workDirFor: (key) => mergeUtil.workDirFor(P.worktreesDir, `main-suite-${key}`),
        recordTree: (r) => testedTrees.recordTestedTree(P.stateDir, r),
        // glmps-2-0-186: an open card with a merge in the batch holds the count trigger.
        openCardsFor: mainSuite.openCardsForBacklog({
          loadItems: () => backlogStore.load(P.stateDir).items,
          keyOf: mergeQueue.integrationKey, closedStates: backlogStore.CLOSED_STATES,
        }),
        // Not the per-PR ceiling (that stays 30 minutes): the whole suite took
        // 42 minutes on an idle box on 2026-10-29, and this run is off the PR path.
        timeoutMs: Number.isFinite(cfg.mergeQueue?.mainSuiteTimeoutMs) && cfg.mergeQueue.mainSuiteTimeoutMs > 0 ? cfg.mergeQueue.mainSuiteTimeoutMs : 90 * 60_000,
      }),
      // One full run plus up to 5 bisect probes, each held to the run's own ceiling.
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 6 * 60 * 60_000 },
      sla: { maxAgeMs: 12 * 60 * 60_000 },
    });
  }
  registerProducer(() => {
    try { return [...mergeQueueRuns.headroomAlerts(mergeQueueRuns.loadRuns(P.stateDir)), ...mainSuite.mainSuiteAlerts(readMainSuite())]; }
    catch { return []; }
  });

  const reviewShellMaxOutput = () => Math.max(200 * 1024, 2 * (Number(cfg.mergeQueue?.reviewDiffMaxChars) || 0));
  const runReviewGit = reviewGit ?? (gitopsViaShell
    ? (args, { cwd } = {}) => shellSeams.git(args, { cwd }, { maxOutput: reviewShellMaxOutput() })
    : mergeUtil.defaultGit);
  const reviewRuns = new Set();
  function haltMergeQueue() {}

  // glmps-2-0-runtime-126: the independent reviewer runs once per batch of
  // merges on each integration branch (operator decision 2026-11-01), headless
  // through the desktop shell's review recipe like the retired per-PR reviewer.
  // It waits past the triggering card's live session and a full-suite run.
  async function removeBatchReviewWorktree(dir, repoPath) {
    let viaShell = false;
    try {
      const rm = await runReviewGit(['worktree', 'remove', '--force', dir], { cwd: repoPath });
      viaShell = rm.status === 0;
      await runReviewGit(['worktree', 'prune'], { cwd: repoPath });
    } catch (e) {
      if (!isGitopsInfraError(e)) reportMiss('batch-review-cleanup', `${dir}: ${e?.message ?? String(e)}`);
    }
    try { if (!viaShell || fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const batchReviewTimeoutMs = () => {
    const v = cfg.mergeQueue?.batchReviewTimeoutMs;
    return Number.isFinite(v) && v > 0 ? v : batchReview.DEFAULT_REVIEW_TIMEOUT_MS;
  };

  async function launchBatchReviewer({ target, jobId, seed, model, toSha }) {
    if (!gitopsViaShell) return { ok: false, reason: 'the batched reviewer runs headless through the desktop shell, which only service mode uses' };
    const plan = worktreePlan({ baseDir: P.worktreesDir, project: target.project, jobId });
    await removeBatchReviewWorktree(plan.dir, target.repoPath);
    fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
    let added;
    try { added = await runReviewGit(['worktree', 'add', '--detach', plan.dir, toSha], { cwd: target.repoPath }); } catch (e) { added = { status: 1, stderr: e?.message ?? String(e) }; }
    if (added.status !== 0) return { ok: false, reason: `git worktree add failed: ${String(added.stderr || added.stdout || '').trim().slice(0, 200)}` };
    let settings; let promptFile;
    try {
      // No reviewHead: the role guard then refuses every push from this session.
      settings = writeRoleSettings(P.stateDir, { role: 'reviewer', integrationBranches: cfg.integrationBranches, key: jobId });
      promptFile = runnerStore.writePrompt(P.stateDir, jobId, seed);
    } catch (e) {
      await removeBatchReviewWorktree(plan.dir, target.repoPath);
      return { ok: false, reason: `role settings or prompt not written: ${e?.message ?? e}` };
    }
    const timeoutMs = batchReviewTimeoutMs();
    const p = gitopsBroker.run({ kind: 'review', cwd: plan.dir, settings, promptFile, model, timeoutMs })
      .then((result) => ({ result }), (error) => ({ error }))
      .then(async (outcome) => {
        await removeBatchReviewWorktree(plan.dir, target.repoPath);
        for (const file of [settings, promptFile]) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } }
        const r = outcome.result;
        const why = outcome.error ? `the reviewer could not run: ${outcome.error.message}`
          : r?.timedOut ? `reviewer timed out after ${Math.round(timeoutMs / 60000)} min`
            : `reviewer exited (code ${r?.status}) without posting findings`;
        // A findings call already cleared the run, so this only lands when none arrived.
        batchReview.saveState(P.stateDir, batchReview.abandonRun(batchReview.loadState(P.stateDir), target.key, jobId, why));
      })
      .catch((e) => reportMiss('batch-review-finish', `${jobId}: ${e?.message ?? String(e)}`))
      .finally(() => reviewRuns.delete(p));
    reviewRuns.add(p);
    return { ok: true };
  }

  let batchReviewLoop = null;
  if (cfg.mergeQueue?.batchReview !== false && (env.GLMPS_TEST !== '1' || batchReviewInTest)) {
    batchReviewLoop = loopRegistry.registerLoop({
      name: 'merge-queue-batch-review',
      trigger: { everyMs: 10 * 60_000 },
      ...batchReview.createBatchReviewLoop({
        targets: mergedIntegrationTargets,
        git: (args, { cwd }) => runReviewGit(args, { cwd }),
        readState: () => batchReview.loadState(P.stateDir),
        writeState: (doc) => batchReview.saveState(P.stateDir, doc),
        cardsForShas: (shas) => {
          const want = new Set(shas);
          return backlogStore.load(P.stateDir).items
            .filter((c) => c.mergeRequest?.mergeSha && want.has(c.mergeRequest.mergeSha))
            .map((c) => ({ id: c.id, title: c.title, number: c.mergeRequest.number, mergeSha: c.mergeRequest.mergeSha, acceptanceCriteria: c.acceptanceCriteria ?? [] }));
        },
        sessionLive: (id) => !!runnerStore.loadLedger(P.stateDir)[id],
        suiteActive: () => loopRegistry.isRunning('merge-queue-main-suite'),
        postNote: (id, text) => {
          backlogStore.appendDevLogIn(P.stateDir, id, { by: 'merge-queue', text });
          scut?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
          broadcastBacklog();
        },
        launch: launchBatchReviewer,
        reviewerModel: () => batchReview.pickReviewerModel({
          defaultModel: cfg.mergeQueue?.authorDefaultModel ?? readJsonSafe(P.settingsFile)?.model ?? null,
          models: cfg.mergeQueue?.reviewerModels,
        }),
        port: actualPort,
        newNonce: () => crypto.randomUUID(),
        timeoutMs: batchReviewTimeoutMs(),
        diffMaxChars: Number(cfg.mergeQueue?.reviewDiffMaxChars) > 0 ? Number(cfg.mergeQueue.reviewDiffMaxChars) : batchReview.DEFAULT_DIFF_MAX_CHARS,
      }),
      // The reviewer is an out-of-process headless session, so model calls are advisory.
      ceiling: { maxAttempts: 1, maxModelCalls: null, timeoutMs: 15 * 60_000 },
      sla: { maxAgeMs: 2 * 60 * 60_000 },
    });
  }

  registerMergeQueueRoutes(registerRoute, { P, mainSuiteReds, readBody, fileCard, broadcastBacklog });
  registerBacklogRoutes(registerRoute, {
    P, cfg, actors, accessToken, readBody, CLIENT_BACKLOG_STATES, clientPatchRefusal,
    broadcastBacklog, haltMergeQueue, promoteAfterClose, recordGate, removeWorktree, repoForProject,
    resolveActor, resolveProjectName, runJobNow, runRecipe, sessionSummaries,
    getScut: () => scut, getLocalSessionExpected: () => localSessionExpected,
  });

  // The worktree backfill script records through here instead of writing the
  // backlog file under a running server. Same writers the runner and the
  // sweeper use (worktree-outcome.js).
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/worktree-outcome',
    handle: async (req, res, { params, send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const id = params.id;
      const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
      if (!card) return send(404, { error: 'item not found' });
      const action = body?.action;
      if (action === 'record') {
        const rec = body.record;
        if (typeof body.dir !== 'string' || !body.dir || !rec || typeof rec !== 'object' || typeof rec.branch !== 'string') {
          return send(400, { error: 'record needs dir and a record with a branch' });
        }
        const recorded = card.runSession?.worktree?.dir;
        if (recorded && !pathsEqual(recorded, body.dir)) return send(409, { error: 'that is not the recorded worktree of this card' });
        const ok = writeOutcome({ stateDir: P.stateDir, card, worktree: { dir: body.dir, repo: body.repo ?? null }, record: { ...rec, dir: body.dir } });
        if (!ok) return send(500, { error: 'the outcome record could not be written' });
      } else if (action === 'kept') {
        if (typeof body.reason !== 'string' || !body.reason) return send(400, { error: 'kept needs a reason' });
        flagKept({ stateDir: P.stateDir, id, reason: body.reason });
      } else if (action === 'removed') {
        markRemoved({ stateDir: P.stateDir, id });
      } else {
        return send(400, { error: 'action must be record, kept or removed' });
      }
      broadcastBacklog();
      return send(200, { ok: true });
    },
  });


  // glmps-2-0-163: a close that cannot be refused (the PR merged; the operator
  // closed it) hands each open spawned card its own channel and an interactive
  // session, and names them on the host. Async, so the close itself never waits on Slack.
  function promoteAfterClose(id, why, by) {
    const kids = openChildren(id, backlogStore.load(P.stateDir).items).filter((c) => c.mode !== 'headless').map((c) => c.id);
    if (!kids.length) return Promise.resolve([]);
    backlogStore.appendDevLogIn(P.stateDir, id, { by, text: `closed with open spawned cards ${kids.join(', ')}: each is promoted to its own Slack channel and an interactive session` });
    return promoteOpenChildren(id, why)
      .then((out) => { broadcastBacklog(); return out; })
      .catch((e) => { reportMiss('promote-child', `${id}: ${e?.message ?? e}`); return []; });
  }

  // The merge queue's engine (card glmps-2-0-220): the tick, the test and
  // merge jobs, bounces, closes, the PR re-check and the release hand-off.
  // What the rest of the server shares with it (the job map, the may-run and
  // maintenance gates, checkouts, saving a request) stays here and is passed in.
  const mergeQueueDriver = createMergeQueueDriver({
    P, env, cfg, mergeJobs, runGh, runReviewGit, runMergeJobImpl, countQueueTestProcs, releaseRun,
    gitopsViaShell, gitopsBroker, shellSeams, mergeTestsRun, mainSuiteLoop, batchReviewLoop,
    checkoutFor, saveMergeRequest, mergeQueueMayRun, maintenanceHold, redFor, haltMergeQueue,
    broadcastBacklog, autoDeployTick, resumeStrandedTick, getScut: () => scut,
  });
  // Resolves when the jobs it started finish (the timer ignores that; tests await it).
  const mergeQueueTick = () => mergeQueueDriver.tick();

  // glmps-2-0-66 F3 (spec docs/specs/2026-10-20-glmps2-auto-deploy-after-merge.md):
  // a queue merge into a configured base runs its registered deploy action.
  // The server runs it; no session does. Paused means off (the caller checked).
  let autoDeployNoScut = false;
  function autoDeployTick() {
    const autoDeploy = cfg.mergeQueue?.autoDeploy;
    if (!autoDeploy || !Object.keys(autoDeploy).length) return;
    if (!scut?.runRegisteredAction) {
      if (!autoDeployNoScut) reportMiss('auto-deploy', 'mergeQueue.autoDeploy is set but SCUT is not running, so no deploy runs');
      autoDeployNoScut = true;
      return;
    }
    const d = autoDeployDue({
      items: backlogStore.load(P.stateDir).items,
      lessons: learningStore.load(P.stateDir).items,
      greens: mainSuiteGreens(),
      liveSha: runningSha(),
      entries: scutApprovalsLog(P.stateDir),
      autoDeploy,
      registry: scutApprovalsConfig(cfg.approvals || {}).registry,
      now: Date.now(),
    });
    if (!d.due) return;
    const text = `deploying ${d.mergeSha ? d.mergeSha.slice(0, 7) : 'the merge'} to the live server (auto-deploy, \`${d.action}\`)`;
    // A lesson push has no card, so there is no devlog to write.
    if (d.ticketId) backlogStore.appendDevLogIn(P.stateDir, d.ticketId, { by: 'merge-queue', text });
    scut.runRegisteredAction({ action: d.action, ticketId: d.ticketId, trigger: d.source === 'lesson' ? 'learning-loop' : 'merge-queue' })
      .catch((e) => reportMiss('auto-deploy', `${d.ticketId ?? d.lessonId}: ${e?.message ?? String(e)}`));
  }

  // The running build's commit, from the /healthz version ("x.y.z+<sha>").
  function runningSha() {
    const m = /\+([0-9a-f]{7,40})$/.exec(String(kernelVersion));
    return m ? m[1] : null;
  }
  // The newest green full run per integration key, while it is the last run.
  function mainSuiteGreens() {
    const out = {};
    for (const [key, rec] of Object.entries(readMainSuite() ?? {})) {
      const ts = Date.parse(rec?.lastRunTs ?? '');
      if (rec?.lastResult === 'pass' && rec.lastGreenSha && rec.lastGreenSha === rec.lastTestedSha && Number.isFinite(ts)) out[key] = { sha: rec.lastGreenSha, ts };
    }
    return out;
  }

  // Card glmps-2-0-173: each queue merge says once when it runs live, and once
  // when a deploy finished without it, so a merged change is never stranded
  // silently. A registered loop since card glmps-2-0-176: git runs only when
  // the running build changed, not on every 5 s queue tick.
  const liveNoticeFile = path.join(P.stateDir, 'live-notices.json');
  let kernelRepoSlug;
  const liveGit = liveNoticeGit ?? createLiveNoticeGit({
    viaShell: gitopsViaShell, shellGit: shellSeams.git, runLocal: runAsync, repoRoot: REPO_ROOT, refuseFetch: isTestProcess({ env }),
  });
  const liveNoticeLoop = createLiveNoticeLoop({
    enabled: mergeQueueMayRun,
    loadItems: () => backlogStore.load(P.stateDir).items,
    liveSha: runningSha,
    // Read once: null (origin unreadable) checks every merge by ancestry, as before.
    kernelRepo: async () => {
      if (kernelRepoSlug === undefined) { try { kernelRepoSlug = repoSlug(await gitOriginOf(REPO_ROOT)); } catch { kernelRepoSlug = null; } }
      return kernelRepoSlug;
    },
    autoDeploy: () => cfg.mergeQueue?.autoDeploy,
    git: liveGit,
    entries: () => scutApprovalsLog(P.stateDir),
    mainSuite: readMainSuite,
    markerExists: () => fs.existsSync(liveNoticeFile),
    writeMarker: () => fs.writeFileSync(liveNoticeFile, JSON.stringify({ since: new Date().toISOString() }) + '\n'),
    save: (n) => {
      backlogStore.setMergeRequestIn(P.stateDir, n.id, n.mr);
      if (n.text) backlogStore.appendDevLogIn(P.stateDir, n.id, { by: 'merge-queue', text: n.text });
      broadcastBacklog();
    },
  });
  loopRegistry.registerLoop({ ...LIVE_NOTICE_LOOP, ...liveNoticeLoop });

  // glmps-2-0-107: a covers merge leaves its card open for the remaining
  // criteria, but a headless author has already exited by then. Once the
  // merge is live, put the card back in the queue with the open criteria.
  function resumeStrandedTick() {
    const entries = scutApprovalsLog(P.stateDir);
    const stranded = mergeExec.strandedAfterMerge({
      items: backlogStore.load(P.stateDir).items,
      ledger: runnerStore.loadLedger(P.stateDir),
      // The live mark (the live-notice loop), not a finished deploy run: a deploy can finish without the merge.
      deployed: (mr) => mergeIsLive(mr, { entries, autoDeploy: cfg.mergeQueue?.autoDeploy }),
    });
    for (const s of stranded) {
      const open = s.open.map((n) => `AC-${n}`).join(', ');
      const note = `Your pull request ${s.mr.repo}#${s.mr.number} merged${s.mr.mergeSha ? ` (${s.mr.mergeSha.slice(0, 7)})` : ''} and is live, after this session had ended. Still open: ${open}. Finish them (for a live check, check the live server now), record the gate, and file the merge request for anything left.`;
      const text = `merge-queue: requeued so a session finishes ${open}; ${s.mr.repo}#${s.mr.number} merged and went live after the last run ended`;
      backlogStore.setPendingReopenIn(P.stateDir, s.id, { note, source: 'merge-queue', reason: 'a pull request covering part of the card merged after the session ended' });
      backlogStore.applyLabelDeltaIn(P.stateDir, s.id, { labels: ['agent:backlog'], comment: text });
      scut?.agentSaid({ ticketId: s.id, kind: 'devlog', text, by: 'agent' });
    }
    if (stranded.length) broadcastBacklog();
  }

  // Impure worktree edge: give a job its own git worktree so two same-project
  // agents never share one checkout (cwd) and clobber each other's files.
  // Returns { dir, branch }, { failure: { reason, ownerDir } } when git failed
  // (the caller holds the card; it never launches into the shared repo), or null
  // when the test-process guard refused. Never throws - the runner must not crash on git hiccups.
  // Every git call below is async, so a slow fetch or worktree add never stalls requests.
  // `onReuse(branch)` is called when a leftover branch holding unmerged commits was
  // reused instead of being reset to the start point.
  let createWorktreeTestGuardLoggedThisInstance = false;
  async function createWorktree({ repo, project, jobId, onReuse = null }) {
    // refuses a real, non-temp repo
    // while running as a test process (test-write-guard.js) - a test's OWN
    // temp repo (runner-worktree.test.js's makeRepo()) still isolates
    // normally, since testRealGitWriteRefused only refuses a repo that is
    // NOT already a throwaway fixture. Same failure contract as a git
    // hiccup below: null, and the caller falls back to the shared repo cwd.
    if (testRealGitWriteRefused(repo, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) {
      if (!createWorktreeTestGuardLoggedThisInstance) {
        createWorktreeTestGuardLoggedThisInstance = true;
        reportMiss('create-worktree-test-guard', 'refused: this is a test process and the target repo is not a temp fixture');
      }
      return null;
    }
    const plan = worktreePlan({ baseDir: P.worktreesDir, project, jobId });
    try {
      fs.mkdirSync(path.dirname(plan.dir), { recursive: true });
      const pruned = await runRecipe(worktreePruneRecipe({ repo }));
      if (pruned.status !== 0) reportMiss('create-worktree-prune', `${repo}: git worktree prune exited ${pruned.status}: ${pruned.stderr.trim().slice(0, 200)}`);
      if (fs.existsSync(plan.dir)) {
        // Leftover checkout from a crashed run. Removed WITHOUT --force: if the
        // leftover is dirty (or a previous agent is somehow still in it), git
        // refuses, the worktree add below fails, and launchJob falls back to the
        // repo cwd - the same path a failed create already took. Forcing here
        // would delete uncommitted work belonging to whoever left it.
        // A clean one a previous agent still sits in is not refused by git on
        // Windows: it is emptied (glmps-87). Ask the OS first.
        const occ = dirInUse(plan.dir);
        if (occ.inUse) {
          reportMiss('create-worktree-leftover-in-use', `${plan.dir}: not removed, a process is still in it (${occ.reason})`);
        } else {
          const removed = await runRecipe(worktreeRemoveSafeRecipe({ repo, dir: plan.dir }));
          if (removed.status !== 0) reportMiss('create-worktree-remove-leftover', `${plan.dir}: git worktree remove exited ${removed.status}: ${removed.stderr.trim().slice(0, 200)}`);
        }
      }
      const added = await addWorktree({ repo, dir: plan.dir, branch: plan.branch, startPoint: await freshStartPoint(repo), run: runRecipe });
      if (added.ok) { try { clearReclaimMarker(plan.dir); } catch { /* stale marker only */ } }
      if (!added.ok) {
        const reason = `git worktree add exited ${added.result.status}: ${added.result.stderr.trim().slice(0, 200)}`;
        reportMiss('create-worktree-add', `${plan.dir}: ${reason}`);
        return { failure: { reason, ownerDir: branchOwnerFromStderr(added.result.stderr) } };
      }
      if (added.reusedBranch) { try { onReuse?.(plan.branch); } catch (e) { reportMiss('create-worktree-reuse-note', e?.message ?? String(e)); } }
      return plan;
    } catch (e) {
      reportMiss('create-worktree', `${plan.dir}: ${e?.message ?? e}`);
      return { failure: { reason: String(e?.message ?? e), ownerDir: null } };
    }
  }

  // The upstream ref to branch a new worktree from, freshly fetched, so a card
  // starts from what is actually merged rather than whatever the repo checkout
  // last pulled (glmps-2-0-41: a stale <repo> main kept PR #22's settings
  // out of every runner worktree). Fail-open: no remote, no upstream or a
  // failed fetch returns null and the caller branches from local HEAD, exactly
  // as before.
  //
  // In service mode the fetch is the desktop shell's (it has the credentials):
  // see shellStartPending, which the runner tick waits on before launching.
  async function freshStartPoint(repo) {
    if (gitopsViaShell) {
      const hit = shellStarts.get(repo);
      return hit?.ref && Date.now() - hit.at < 10 * 60_000 ? hit.ref : null;
    }
    try {
      let up = await runRecipe(upstreamRefRecipe({ repo }), { timeout: 15_000 });
      if (up.status !== 0 || !up.stdout.trim()) up = await runRecipe(remoteDefaultRefRecipe({ repo }), { timeout: 15_000 });
      if (up.status !== 0) throw new Error(up.stderr.trim() || `git exited ${up.status}`);
      const ref = up.stdout.trim();
      if (!ref) return null;
      const fetched = await runRecipe(worktreeFetchRecipe({ repo }), { timeout: 30_000 });
      if (fetched.status !== 0) throw new Error(fetched.stderr.trim() || `git fetch exited ${fetched.status}`);
      return ref;
    } catch (e) {
      console.error(`[runner] worktree start point: falling back to local HEAD for ${repo}: ${e?.message?.split('\n')[0] || e}`);
      return null;
    }
  }

  // The shell-side half of freshStartPoint. true means "a fetch is in flight or
  // was just started, launch on a later tick"; false means launch now (the ref
  // is fresh, or the shell is down or there is no upstream, which falls back to
  // the local HEAD exactly as before). A fetch that fails any way is recorded
  // too, so one bad repo never blocks its own launch.
  const shellStarts = new Map(); // repo -> { ref|null, at }
  const shellStartsInflight = new Set();
  let shellStartDownUntil = 0;
  function shellStartPending(repo) {
    const hit = shellStarts.get(repo);
    if (hit && Date.now() - hit.at < 20_000) return false;
    if (shellStartsInflight.has(repo)) return true;
    if (Date.now() < shellStartDownUntil) return false;
    shellStartsInflight.add(repo);
    gitopsCheckouts.set(`runner:${repo.toLowerCase()}`, repo);
    void (async () => {
      let ref = null;
      try {
        const claim = { claimWaitMs: Math.min(3000, gitopsClaimWaitMs) };
        const up = await shellSeams.git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: repo }, claim);
        let name = up.status === 0 ? up.stdout.trim() : '';
        if (!name) {
          const def = await shellSeams.git([...REMOTE_DEFAULT_REF_ARGS], { cwd: repo }, claim);
          name = def.status === 0 ? def.stdout.trim() : '';
        }
        if (name) {
          const fetched = await shellSeams.git(['fetch', '-q', 'origin'], { cwd: repo }, { timeoutMs: 30_000 });
          if (fetched.status === 0) ref = name;
        }
      } catch (e) {
        if (e?.code === 'NO_SHELL') shellStartDownUntil = Date.now() + 60_000;
        console.error(`[runner] worktree start point: falling back to local HEAD for ${repo}: ${e?.message ?? e}`);
      } finally {
        shellStarts.set(repo, { ref, at: Date.now() });
        shellStartsInflight.delete(repo);
      }
    })();
    return true;
  }

  // Reclaim a departed job's worktree checkout. The branch is kept so any work
  // the agent committed stays recoverable.
  //
  // NOT forcing is deliberate (same rule as worktree-sweeper.js): a dirty tree
  // makes git refuse, so uncommitted work survives and the sweeper reclaims the
  // checkout on a later pass once it is clean. The caller must ALSO have
  // checked reclaimVerdict - a job leaving the ledger does not mean its
  // detached agent stopped, or that nobody is sitting in its checkout.
  let removeWorktreeTestGuardLoggedThisInstance = false;
  async function removeWorktree(worktree, { by = 'remove-worktree' } = {}) {
    if (!worktree?.repo || !worktree?.dir) return false;
    // same predicate as sweepWorktrees
    // and createWorktree - reconcileNow's automatic reclaim (and the purge
    // route, which already has its own extensive checks) both call this
    // one function, so guarding it here covers both without duplicating
    // the check at each caller. A test's own temp repo (every existing
    // caller in this suite) is unaffected.
    if (testRealGitWriteRefused(worktree.repo, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) {
      if (!removeWorktreeTestGuardLoggedThisInstance) {
        removeWorktreeTestGuardLoggedThisInstance = true;
        reportMiss('remove-worktree-test-guard', 'refused: this is a test process and the target repo is not a temp fixture');
      }
      return false;
    }
    // glmps-87: on Windows git's non-forced remove empties a clean
    // checkout a live process sits in and only then fails, so it cannot be the
    // occupancy check. Every caller (reclaim, purge, rollbacks) gets this one.
    const occ = dirInUse(worktree.dir);
    if (occ.inUse) {
      reportMiss('remove-worktree-in-use', `${worktree.dir}: not removed, a process is still in it (${occ.reason})`);
      return false;
    }
    const removed = await runRecipe(worktreeRemoveSafeRecipe({ repo: worktree.repo, dir: worktree.dir }));
    const ok = removed.status === 0;
    if (!ok) reportMiss('remove-worktree', `${worktree.dir}: git worktree remove exited ${removed.status}: ${removed.stderr.trim().slice(0, 200)}`);
    try { writeReclaimMarker(worktree.dir, { branch: worktree.branch ?? null, by, outcome: ok ? 'removed' : 'failed' }); } catch { /* fail-open */ }
    const pruned = await runRecipe(worktreePruneRecipe({ repo: worktree.repo }));
    if (pruned.status !== 0) reportMiss('remove-worktree-prune', `${worktree.repo}: git worktree prune exited ${pruned.status}: ${pruned.stderr.trim().slice(0, 200)}`);
    return ok;
  }

  // glmps-53: every reclaim decision leaves a durable record naming
  // its reason, so the next occurrence is provable instead of reconstructed
  // from card-activity timestamps. 'no-worktree' is not logged: there is no
  // directory and nothing happened.
  function logReclaim(id, entry, op) {
    if (op === 'no-worktree') return;
    try {
      appendEvent(P.stateDir, {
        kind: 'worktree.reclaim', lane: 'runner', label: String(id),
        path: entry?.worktree?.dir ?? null, op, ts: Date.now(), sessionId: null,
      });
    } catch { /* fail-open: instrumentation must never break the runner */ }
  }

  // the one decision "has this departed job's worktree
  // checkout been retained, or should it be reclaimed" - reconcileNow's
  // own departed-job loop and the launch-result route's runner-failure
  // hold path used to each carry their own copy of
  // this exact sequence (retained check, reclaimVerdict, removeWorktree,
  // logReclaim). `retainedIds`/`liveDirs` are passed in rather than
  // computed here because the two callers need them on different
  // schedules: reconcileNow memoizes both ONCE per tick across every
  // departed id in the loop, while the single-job result-route caller
  // only ever needs them for the one job it just finished.
  // Reopen-by-reply for a card whose worktree was cleaned up after its outcome
  // was recorded: put the checkout back at the same directory so the resumed
  // session finds its cwd. The branch is reused when it still exists; else the
  // remote copy; else the recorded head commit. Returns the worktree or null.
  async function recreateRecordedWorktree(job) {
    const rs = job.runSession;
    const wt = rs?.worktree;
    const o = rs?.outcome;
    if (!wt?.dir || !wt.repo || !o?.branch || !o?.head || fs.existsSync(wt.dir)) return null;
    if (testRealGitWriteRefused(wt.repo, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) return null;
    const run = async (recipe) => (await runRecipe(recipe)).status === 0;
    try { fs.mkdirSync(path.dirname(wt.dir), { recursive: true }); } catch { /* the add reports it */ }
    await run(worktreePruneRecipe({ repo: wt.repo }));
    const ok = await run(worktreeCheckoutRecipe({ repo: wt.repo, dir: wt.dir, branch: o.branch })) ||
      await run(worktreeAddRecipe({ repo: wt.repo, dir: wt.dir, branch: o.branch, startPoint: `origin/${o.branch}` })) ||
      await run(worktreeAddRecipe({ repo: wt.repo, dir: wt.dir, branch: o.branch, startPoint: o.head }));
    if (!ok) return null;
    try { backlogStore.setRunSessionIn(P.stateDir, job.id, { purgedTs: null, keptReason: null }); } catch { /* the launch record clears it too */ }
    return { dir: wt.dir, branch: o.branch, repo: wt.repo };
  }

  // The git behind the reclaim is async, so it settles after the caller returns.
  // The promises are tracked so the runner tick can wait for them before it ends,
  // and none is ever left floating.
  const reclaimsInFlight = new Set();
  function reclaimDepartedJobWorktree(id, entry, opts) {
    const p = reclaimDeparted(id, entry, opts)
      .catch((e) => reportMiss('worktree-outcome', `${id}: ${e?.message ?? e}`))
      .finally(() => reclaimsInFlight.delete(p));
    reclaimsInFlight.add(p);
    return p;
  }
  async function reclaimDeparted(id, entry, { retainedIds, liveDirs }) {
    if (retainedIds.has(id)) {
      // The record is what shortens the retention lease, so write it now.
      const recorded = Promise.resolve(recordWorktreeOutcome(id, entry?.worktree)).catch(() => {});
      logReclaim(id, entry, 'retained');
      await recorded;
      return;
    }
    const verdict = reclaimVerdict({ entry, isAlive: pidAlive, liveDirs });
    if (!verdict.reclaim) { logReclaim(id, entry, verdict.reason); return; }
    const g = await worktreeRemovalGate(id, entry.worktree);
    if (!g.remove) { logReclaim(id, entry, `kept-${g.reason}`); return; }
    // The git above answered later: a relaunch may have claimed the card again.
    if (id in runnerStore.loadLedger(P.stateDir)) { logReclaim(id, entry, 'relaunched'); return; }
    // glmps-87: reclaimVerdict's occupancy is session liveness, which
    // read an idle open window as ended. The OS answer is the last word.
    if (dirInUse(entry.worktree.dir).inUse) { logReclaim(id, entry, 'in-use'); return; }
    const ok = await removeWorktree(entry.worktree, { by: 'runner-reclaim' });
    if (ok) markWorktreeRemoved(id, entry.worktree);
    logReclaim(id, entry, ok ? 'removed' : 'failed');
  }

  // Git for the outcome facts. In service mode the server runs as LocalSystem,
  // where git can refuse the operator's repos (dubious ownership), so it goes
  // through the desktop shell exactly as the merge reviewer's git does
  // (runReviewGit). Never throws.
  // A function declaration, not a const: the boot-time sweep can reach it before
  // the rest of this scope has been initialised.
  const execGit = (args, cwd) => runAsync('git', ['-C', cwd, ...args], { timeout: 15_000 });
  function outcomeGit(args, cwd) {
    if (!(reviewGit || gitopsViaShell)) return execGit(args, cwd);
    // A desktop app that has not polled in 30 s is not running (the same rule
    // launchQueueStaleness uses): queueing a read for it would only wait out a
    // claim and leave a record behind before falling back anyway.
    if (!reviewGit && (shellPolledAt === null || Date.now() - shellPolledAt > 30_000)) return execGit(args, cwd);
    return (async () => {
      try {
        const r = await runReviewGit(args, { cwd });
        return { status: r?.status ?? 1, stdout: String(r?.stdout ?? ''), stderr: String(r?.stderr ?? '') };
      } catch (e) {
        // The shell itself is unavailable (not git refusing): try the server's
        // own git. As LocalSystem that may still be refused, which reads as
        // unreadable and is reported; as the operator it simply works.
        if (isGitopsInfraError(e)) return execGit(args, cwd);
        return { status: 1, stdout: '', stderr: e?.message ?? String(e) };
      }
    })();
  }

  // The outcome-before-removal rule (worktree-outcome.js). Applies to a worktree
  // that is a board card's own checkout; anything else (a merge reviewer's
  // detached checkout, a card since deleted) has nowhere to record to and is
  // left to the existing rules, fail-open.
  function cardWorktreeOf(id, worktree) {
    const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    if (!card || !worktree?.dir || !worktree?.repo) return null;
    const recorded = card.runSession?.worktree?.dir;
    if (recorded && !pathsEqual(recorded, worktree.dir)) return null;
    return card;
  }
  // Gathers the facts, writes the record to the card when it is new or changed,
  // returns { card, facts, written }. Never throws.
  function recordWorktreeOutcome(id, worktree) {
    try {
      const card = cardWorktreeOf(id, worktree);
      if (!card) return null;
      const branch = worktree.branch ?? card.runSession?.worktree?.branch ?? null;
      const finish = (facts) => {
        const record = { ...outcomeRecord(facts, card), dir: worktree.dir };
        const written = writeOutcome({ stateDir: P.stateDir, card, worktree, record });
        if (!written) reportMiss('worktree-outcome', `${id}: the outcome record could not be written`);
        else broadcastBacklog();
        if (facts.why && !unreadableReported.has(id)) {
          unreadableReported.add(id);
          reportMiss('worktree-outcome-unreadable', `${id}: git could not read ${worktree.dir}, so it is kept: ${facts.why}`);
        }
        return { facts, written };
      };
      // Direct git answers synchronously; in service mode (or with an injected
      // reviewGit) the shell's git answers with a promise and so does this.
      const refs = integrationRefsFor({ git: outcomeGit, repo: worktree.repo });
      const gather = (integrationRefs) => gatherWorktreeFacts({ dir: worktree.dir, branch, git: outcomeGit, integrationRefs });
      return whenSettled(refs, (ir) => whenSettled(gather(ir), finish));
    } catch (e) { reportMiss('worktree-outcome', `${id}: ${e?.message ?? e}`); return null; }
  }
  function worktreeRemovalGate(id, worktree) {
    return whenSettled(recordWorktreeOutcome(id, worktree), (rec) => {
      if (!rec) return { remove: true, reason: 'ungated' };
      const v = removalVerdict({ facts: rec.facts, written: rec.written });
      if (!v.remove) flagWorktreeKept(id, v.reason);
      return v;
    });
  }
  function flagWorktreeKept(id, reason) {
    try {
      if (flagKept({ stateDir: P.stateDir, id, reason })) broadcastBacklog();
    } catch (e) { reportMiss('worktree-outcome', `${id}: ${e?.message ?? e}`); }
  }
  function markWorktreeRemoved(id, worktree) {
    try {
      if (!cardWorktreeOf(id, worktree)) return;
      markRemoved({ stateDir: P.stateDir, id });
      broadcastBacklog();
    } catch (e) { reportMiss('worktree-outcome', `${id}: ${e?.message ?? e}`); }
  }

  // what the most recent dry-run launch WOULD have run,
  // exposed on the server facade below (`lastDryRunLaunch`) for a deterministic
  // test to inspect without ever spawning it. Always null outside dry-run.
  let lastDryRunLaunch = null;

  // `actor` dropped: it only ever fed the deleted
  // companion record, and the one call site passes it as part of an object
  // literal, so dropping it from the destructure needs no call-site change.
  // `target` is sessionTarget()'s answer ('antigravity' or 'native-terminal');
  // the result's `target` is where the session actually opened.
  function launchSession({ target, seeded, cwd, jobId = null }) {
    const detail = jobId ?? 'unknown job';
    if (env.GLMPS_RUNNER_DRYRUN && !editorSpawnFn) {
      // the injectable launch seam a test asserts the
      // argv through - dry-run mode never reaches spawn() below, so without
      // this, what `seeded` actually contained (including --session-id) was
      // never observable to a test. Never populated outside dry-run.
      lastDryRunLaunch = { target, seeded, cwd };
      trustLaunchDir(cwd);
      return { pid: process.pid, launchId: null, target }; // tests: no real window, pid looks alive
    }
    // share launchNative (through openSession) with
    // resume/terminal/learning-apply instead of duplicating guardedSpawn +
    // nativeTerminalRecipe here, so a runner launch failure also lands a
    // launch.failed event (lane 'runner'), not just the spawn:launch-terminal
    // health miss. `seeded` is built by the runner (command + a state-dir
    // prompt path), never from a request field. A companion-hosted session has no pid: reconcileLedger
    // then governs it by card state and the runtime budget alone.
    const name = jobId ? vendorTabName('claude', jobId) : null;
    return openSession({ command: seeded, cwd, key: 'spawn:launch-terminal', label: `launch-terminal ${detail}`, origin: 'runner', target, name });
  }

  // mirrors ledgerPatchFor's "card write must land
  // first" invariant to the SYNCHRONOUS launch path - every
  // launch mints its own session
  // id and must land on the CARD (setRunSessionIn) before it is ever mirrored
  // onto the ledger. Shared by both call sites (runnerTick's dispatch,
  // runJobNow) so they cannot independently drift.
  //
  // this runs AFTER launchJob has already spawned the
  // session - a throw here must never escape to the CALLER's ledger write.
  // Unguarded, a save throw on the dispatch path fell into runnerTick's outer
  // bare catch, which skipped writing the ledger entry ENTIRELY: the just-
  // launched job would have no ledger entry at all (no reconcile, no reclaim,
  // an orphaned session with nobody tracking it), and on runJobNow's path it
  // surfaced as a 500 to the caller after the launch had already happened.
  // recordLaunchSessionSafe (lib/scut/reopen.js) is the actual guard, tested
  // directly there with an injected throwing write() - returns `{}` on
  // either "nothing to record" (no id) or a failed write, so the ledger entry
  // is always written (job.id, pid, worktree, etc. - just without a sessionId
  // yet on failure), and the next tick's now-strict fallback inference
  // (planRunSessionRecords) can still heal it later.
  function recordLaunchSession(jobId, sessionId, launcher, worktree) {
    return recordLaunchSessionSafe(
      { sessionId, launcher },
      () => backlogStore.setRunSessionIn(P.stateDir, jobId, { sessionId, launcher, worktree: worktree ?? null, recordedTs: Date.now(), purgedTs: null }),
      // keyed per route (runner-session-record), the job id in the reason.
      (reason) => reportMiss('runner-session-record', `${jobId}: ${reason}`),
    );
  }

  // Headless cards (unattended reliability T6). A secondary card runs as
  // `claude -p` in the desktop app (a 'card' gitops record), the same path the
  // merge reviewer takes: the run holds its runner slot only while the broker
  // call lives, and exits on its own. Service mode only, like the reviewer.
  // `shellLacksCardKindAt` is set when a desktop app built before this refuses
  // the kind; later cards launch interactively for `headlessReprobeMs`, then the
  // next one tries headless again, so a rebuilt app is picked up without a
  // kernel restart (on 2026-10-24 the first refusal pinned every card to
  // interactive while the rebuilt app was being installed).
  const headlessCards = new Map(); // job id -> run, from queueing the record until its exit is handled
  const headlessCardRuns = new Set();
  let shellLacksCardKindAt = null;
  const headlessReprobeMs = Number.isFinite(Number(cfg.headlessReprobeMs)) && Number(cfg.headlessReprobeMs) >= 0 ? Number(cfg.headlessReprobeMs) : 10 * 60_000;
  const shellLacksCardKind = () => shellLacksCardKindAt !== null && Date.now() - shellLacksCardKindAt < headlessReprobeMs;
  const wantsHeadlessLaunch = (job) => gitopsViaShell && !shellLacksCardKind() && launchMode(job, backlogStore.load(P.stateDir).items) === 'headless';
  // A run this server started, or one a previous server instance started that
  // the desktop app is still working on (its record is still claimed).
  const headlessLive = (id, entry) => headlessCards.has(id)
    || (!!entry?.recordId && launchBroker.get(entry.recordId)?.state === 'claimed');
  const headlessLedgerFields = (launched) => (launched?.headless ? { headless: true, recordId: launched.recordId ?? null } : {});
  // glmps-2-0-107: a launch awaits (session guard, worktree, spawn) between
  // reading the ledger and recording its entry, while other launches and reaps
  // write it. Saving the snapshot read before the await erased their entries:
  // a card left in_progress that the runner no longer tracked, or a reaped
  // entry brought back as a dead slot. Re-read and touch only this id.
  function writeLedgerEntry(id, entry) {
    const ledger = runnerStore.loadLedger(P.stateDir);
    if (entry == null) delete ledger[id];
    else ledger[id] = entry;
    runnerStore.saveLedger(P.stateDir, ledger);
  }

  function startHeadlessCard(job, { cwd, settings, promptFile, sessionId, resume, reopen }) {
    const timeoutMs = runnerStore.loadConfig(P.stateDir).maxRuntimeMs;
    const run = { jobId: job.id, sessionId, resume, reopen, recordId: null, startedAt: Date.now() };
    headlessCards.set(job.id, run);
    const p = gitopsBroker.run({ kind: 'card', cwd, settings, promptFile, sessionId, resume, timeoutMs, onEnqueued: (rid) => { run.recordId = rid; } })
      .then((result) => ({ result }), (error) => ({ error }))
      .then((outcome) => finishHeadlessCard(job.id, run, outcome, timeoutMs))
      .catch((e) => reportMiss('headless-card-finish', `${job.id}: ${e?.message ?? String(e)}`))
      .finally(() => headlessCardRuns.delete(p));
    headlessCardRuns.add(p);
    return { pid: null, launchId: null, target: 'headless', recordId: run.recordId };
  }

  let shellLacksVendorKindAt = null;
  const shellLacksVendorKind = () => shellLacksVendorKindAt !== null && Date.now() - shellLacksVendorKindAt < headlessReprobeMs;
  const vendorSay = (id, text) => {
    backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text });
    // by:'agent' because the room relay drops any other author as runner noise;
    // a vendor agent cannot post, so the runner speaks for it (Q5).
    scut?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
  };
  function integrationBase(repo) {
    const ref = shellStarts.get(repo)?.ref;
    return typeof ref === 'string' && ref.startsWith('origin/') ? ref.slice('origin/'.length) : 'main';
  }

  // AC-6 tab runs. The session file is the run's record on disk, so a finish
  // signal that arrives after a server restart still finds its run.
  const vendorSessionFile = (id) => path.join(P.stateDir, 'runner', `${id}.vendor-session.json`);
  const vendorFinishing = new Set();
  const VENDOR_TAB_WRAPPER = path.join(REPO_ROOT, 'apps', 'shell', 'scripts', 'vendor-session.mjs');

  // The done file lives in the worktree (a vendor sandbox may not write outside
  // it), kept out of `git status` through info/exclude, which is never committed.
  async function excludeFromGit(cwd, name) {
    const r = await runAsync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], { timeout: 15_000 });
    if (r.status !== 0) throw new Error(r.stderr.trim() || `git exited ${r.status}`);
    const rel = r.stdout.trim();
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    if (cur.split(/\r?\n/).includes(name)) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}${name}\n`);
  }

  // Returns the launch result, or null when the tab could not be queued (the
  // caller then runs the card headless).
  async function launchVendorTab(job, { v, model, worktree, cwd, repo, route, guardFreshWorktree, pending, seed, reopen }) {
    const doneFile = path.join(cwd, VENDOR_DONE_FILE);
    await guardFreshWorktree(async () => {
      fs.rmSync(doneFile, { force: true });
      await excludeFromGit(cwd, VENDOR_DONE_FILE);
    });
    const promptFile = await guardFreshWorktree(() => runnerStore.writePrompt(P.stateDir, job.id, buildVendorPrompt({ card: job, vendor: v.id, seed, doneFile })));
    const startedAt = Date.now();
    const session = {
      cardId: job.id, vendor: v.id, model, cwd, promptFile, doneFile, port: actualPort, nonce: crypto.randomBytes(16).toString('hex'),
      branch: worktree.branch, base: integrationBase(repo), title: String(job.title ?? job.id).replace(/[^ -~]/g, ' ').slice(0, 200),
      startedAt, finishedAt: null,
    };
    const sessionFile = vendorSessionFile(job.id);
    await guardFreshWorktree(() => {
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
    });
    const command = vendorTabCommand({ wrapper: VENDOR_TAB_WRAPPER, sessionFile, promptFile });
    const name = vendorTabName(v.id, job.id);
    // target 'antigravity' implies a resolved request file (sessionTarget).
    const queued = queueForCompanion({ command, cwd, label: `vendor-tab ${job.id}`, name });
    if (!queued) {
      fs.rmSync(sessionFile, { force: true });
      backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `${v.label} card runs headless instead of in a tab: the Antigravity tab request could not be written` });
      return null;
    }
    const run = { jobId: job.id, vendor: v.id, model, recordId: null, startedAt, cwd, vendorRun: true, tab: true };
    headlessCards.set(job.id, run);
    const actor = actorForJob({ job, cfgActor: cfg.actor });
    const result = { target: 'antigravity', pid: null, launchId: null, worktree, actor, route, sessionId: null, headless: true, recordId: null };
    try {
      backlogStore.applyLabelDeltaIn(P.stateDir, job.id, { labels: ['agent:in-progress'], comment: `runner: opened ${v.label} in an Antigravity tab (worktree)` });
      if (pending) backlogStore.setPendingReopenIn(P.stateDir, job.id, null);
      if (!job.assignee) backlogStore.updateItemIn(P.stateDir, job.id, { assignee: `tab:${v.id}` });
      vendorSay(job.id, `Started this card on ${v.label}${model ? ` (${model})` : ''} in its own Antigravity tab, "${name}". You can watch it and type to it there. When it writes its summary, the runner checks the fence, runs the tests, opens the PR and records the gate; ${v.label} cannot push or merge.\n\nDetails: ${v.cli} interactive in ${cwd}, branch ${worktree.branch}${reopen ? ', rerun with the operator reply attached' : ''}. Tokens are not reported in tab runs.`);
    } catch (e) {
      const err = new Error(`launchJob: post-spawn bookkeeping failed for ${job.id} after the ${v.label} tab was queued: ${e?.message ?? e}`);
      err.code = 'LAUNCH_POST_SPAWN_FAILED';
      err.launched = result;
      throw err;
    }
    return result;
  }

  async function finishVendorTab(id, session, body, { laterRound = false } = {}) {
    let agentText = '';
    try { agentText = vendorSummaryText(fs.readFileSync(session.doneFile, 'utf8')); } catch { /* no summary written */ }
    try { fs.rmSync(session.doneFile, { force: true }); } catch { /* the executor would refuse nothing over it: it is excluded */ }
    const live = headlessCards.get(id);
    const run = live?.tab ? live : { jobId: id, vendor: session.vendor, model: session.model, recordId: null, startedAt: session.startedAt, cwd: session.cwd, vendorRun: true, tab: true };
    run.laterRound = laterRound;
    const v = vendorById(session.vendor);
    if (!agentText && !laterRound) vendorSay(id, `${v?.label ?? session.vendor} ended its tab session without writing a summary (${body.event}${Number.isInteger(body.exitCode) ? `, exit ${body.exitCode}` : ''}); the runner is checking what it changed anyway.`);
    const timeoutMs = runnerStore.loadConfig(P.stateDir).maxRuntimeMs;
    const outcome = await gitopsBroker.run({
      kind: 'vendor-card', vendor: session.vendor, model: session.model, cwd: session.cwd, promptFile: session.promptFile,
      branch: session.branch, base: session.base, cardId: id, title: session.title, timeoutMs, finishOnly: true, agentText,
      onEnqueued: (rid) => { run.recordId = rid; },
    }).then((result) => ({ result }), (error) => ({ error }));
    await finishVendorCard(id, run, outcome);
  }

  async function launchVendorCard(job, { vendorRun, worktree, cwd, repo, route, reopen, guardFreshWorktree, pending, target = null, interactive = false }) {
    const v = vendorById(vendorRun.vendor);
    const model = vendorRun.model ?? v.defaultModel ?? null;
    if (!worktree?.branch) {
      const e = new Error(`${v.label} card ${job.id} has no worktree of its own, so it was not launched`);
      e.code = 'WORKTREE_REFUSED';
      throw e;
    }
    // AC-6: the same launch-mode rule as a Claude card. A child card under an
    // open host stays headless; any other card opens in its own Antigravity
    // tab, in its own channel (glmps-2-0-163).
    const wantsTab = interactive || launchMode(job, backlogStore.load(P.stateDir).items) === 'interactive';
    if (wantsTab) job = await withOwnChannel(job);
    // No vendor session is resumed: a reply reruns the card with the reply attached.
    const seed = `${buildSeedDoc(job, { port: actualPort })}${reopen ? `\n\n${reopenSeedSection({ note: reopen.note, branch: 'c', reason: reopen.reason ?? 'an operator reply', source: reopen.source })}` : ''}`;
    if (wantsTab) {
      const whyNot = !TAB_VENDORS.includes(v.id) ? `${v.label}'s interactive mode is not verified yet`
        : target !== 'antigravity' ? 'no Antigravity window is open to host its tab' : null;
      if (!whyNot) {
        const tab = await launchVendorTab(job, { v, model, worktree, cwd, repo, route, guardFreshWorktree, pending, seed, reopen });
        if (tab) return tab;
      } else {
        backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `${v.label} card runs headless instead of in a tab: ${whyNot}` });
      }
    }
    const promptFile = await guardFreshWorktree(() => runnerStore.writePrompt(P.stateDir, job.id, buildVendorPrompt({ card: job, vendor: v.id, seed })));
    const timeoutMs = runnerStore.loadConfig(P.stateDir).maxRuntimeMs;
    const run = { jobId: job.id, vendor: v.id, model, recordId: null, startedAt: Date.now(), cwd, vendorRun: true };
    headlessCards.set(job.id, run);
    const p = gitopsBroker.run({
      kind: 'vendor-card', vendor: v.id, model, cwd, promptFile, branch: worktree.branch, base: integrationBase(repo),
      cardId: job.id, title: String(job.title ?? job.id).replace(/[^ -~]/g, ' ').slice(0, 200), timeoutMs,
      onEnqueued: (rid) => { run.recordId = rid; },
    })
      .then((result) => ({ result }), (error) => ({ error }))
      .then((outcome) => finishVendorCard(job.id, run, outcome))
      .catch((e) => reportMiss('vendor-card-finish', `${job.id}: ${e?.message ?? String(e)}`))
      .finally(() => headlessCardRuns.delete(p));
    headlessCardRuns.add(p);
    const actor = actorForJob({ job, cfgActor: cfg.actor });
    const result = { target: 'headless', pid: null, launchId: null, worktree, actor, route, sessionId: null, headless: true, recordId: run.recordId };
    try {
      backlogStore.applyLabelDeltaIn(P.stateDir, job.id, { labels: ['agent:in-progress'], comment: `runner: launched ${v.label} headless in the desktop app (worktree)` });
      if (pending) backlogStore.setPendingReopenIn(P.stateDir, job.id, null);
      if (!job.assignee) backlogStore.updateItemIn(P.stateDir, job.id, { assignee: `headless:${v.id}` });
      vendorSay(job.id, `Started this card on ${v.label}${model ? ` (${model})` : ''} in its own worktree. The runner will post the result, run the tests, open the PR and record the gate; ${v.label} cannot push or merge.\n\nDetails: ${v.cli} in ${cwd}, branch ${worktree.branch}${reopen ? ', rerun with the operator reply attached' : ''}.`);
    } catch (e) {
      const err = new Error(`launchJob: post-spawn bookkeeping failed for ${job.id} after the ${v.label} run was queued: ${e?.message ?? e}`);
      err.code = 'LAUNCH_POST_SPAWN_FAILED';
      err.launched = result;
      throw err;
    }
    return result;
  }

  async function finishVendorCard(id, run, outcome) {
    if (headlessCards.get(id) === run) headlessCards.delete(id);
    const err = outcome.error;
    if (err?.code === 'REFUSED' && /unknown gitops kind/i.test(err.message ?? '')) shellLacksVendorKindAt = Date.now();
    const endedAt = Date.now();
    const parsed = parseVendorResult(outcome);
    // A later tab round that found nothing new leaves the earlier gate standing.
    if (run.laterRound && parsed.doc && !parsed.doc.error && !(parsed.doc.changed ?? []).length) {
      vendorSay(id, `${vendorById(run.vendor)?.label ?? run.vendor}'s tab session ended with nothing new since the last hand-off, so the earlier result stands.`);
      broadcastBacklog();
      return;
    }
    const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    // A card with no model runs on whatever the desktop app picked from the
    // CLI's live list (card glmps-2-0-164), so record the model it reports.
    const reported = parsed.doc?.agent?.model;
    const model = typeof reported === 'string' && normalizeModelField(`${run.vendor}:${reported}`).ok ? reported : run.model;
    const verdict = vendorRunVerdict({ vendor: run.vendor, model, card, parsed, wallMs: endedAt - run.startedAt, acceptanceCount: card?.acceptanceCriteria?.length ?? 0 });
    backlogStore.appendRunIn(P.stateDir, id, runRecord({ vendor: run.vendor, model, startedAt: run.startedAt, endedAt, exit: parsed.doc?.agent?.status ?? outcome.result?.status ?? null, doc: parsed.doc ?? null }));
    const doc = parsed.doc;
    let mrNote = '';
    if (verdict.pushed && doc?.prUrl) {
      const mr = await fileMergeRequest(id, { prUrl: doc.prUrl }, `runner:${run.vendor}`);
      if (mr.status !== 200) mrNote = ` The merge request was not filed: ${mr.body?.error ?? mr.status}${mr.body?.reason ? ` (${mr.body.reason})` : ''}.`;
    }
    vendorSay(id, `${verdict.finishText}${mrNote}${doc?.agent?.text ? `\n\nDetails: ${run.vendor} summary: ${String(doc.agent.text).slice(0, 900)}` : ''}`);
    recordGate(id, mrNote ? { ...verdict.gate, status: 'CONCERNS', evidence: [...verdict.gate.evidence, mrNote.trim()] } : verdict.gate);
    feedVendorLearning(id, run, doc);
    reconcileNow();
    broadcastBacklog();
  }

  // A vendor session feeds the learning loop the way a Claude session's Stop
  // hook does: its captured events (the capture adapters write them to the
  // event spine) run through gap detection into the learning-gaps ingest.
  function feedVendorLearning(id, run, doc) {
    try {
      const since = readEvents(P.stateDir, { since: new Date(run.startedAt - 60_000).toISOString() });
      const match = doc?.agent?.sessionId ? adapterSessionMatcher(run.vendor, doc.agent.sessionId) : tabSessionMatcher(run.vendor, since, run.cwd);
      const events = since.filter((e) => match(e.sessionId));
      if (!events.length) {
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `learning feed: no captured ${run.vendor} events for session ${doc?.agent?.sessionId ?? '(none)'} yet` });
        return;
      }
      const sid = events[0].sessionId;
      const gaps = filterDispatchedWorktreeGaps(detectGaps(events, []), run.cwd);
      if (gaps.length) {
        INGEST_ROUTES['/api/ingest/learning-gaps'].apply(
          { project: run.cwd, sessionId: sid, gaps: gaps.map((g) => ({ code: g.code, severity: g.severity, message: typeof g.message === 'string' ? g.message.slice(0, 2000) : undefined })) },
          { stateDir: P.stateDir, assetsDir: P.assetsDir, clientId: null, resolveProject: resolveProjectName },
        );
      }
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `learning feed: ${events.length} ${run.vendor} event(s) from ${sid}, ${gaps.length} gap(s) recorded` });
    } catch (e) {
      reportMiss('vendor-learning-feed', `${id}: ${e?.message ?? e}`);
    }
  }

  function headlessExitText(outcome, timeoutMs) {
    const e = outcome.error;
    if (e?.code === 'NO_SHELL') return 'headless run did not start: the desktop app did not pick it up (is the GLMPS 2.0 desktop app running?)';
    if (e) return `headless run could not run: ${e.message}`;
    const r = outcome.result;
    if (r.cancelled) return 'headless run was cancelled: the desktop app stopped it on request';
    if (r.timedOut) return `headless run timed out after ${Math.round(timeoutMs / 60000)} min and was stopped`;
    const tail = `${r.stderr || ''}${r.stdout || ''}`.trim().slice(-300);
    return `headless run exited (code ${r.status})${tail ? `: ${tail}` : ''}`;
  }

  // The exit: say how the run ended on the card, then let the ledger rules
  // (reconcileLedger) decide from the card whether it finished or is held.
  async function finishHeadlessCard(id, run, outcome, timeoutMs) {
    if (headlessCards.get(id) === run) headlessCards.delete(id);
    const err = outcome.error;
    if (err?.code === 'REFUSED' && /unknown gitops kind/i.test(err.message ?? '')) {
      shellLacksCardKindAt = Date.now();
      return launchInteractiveInstead(id, run);
    }
    backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: headlessExitText(outcome, timeoutMs) });
    backlogStore.appendRunIn(P.stateDir, id, runRecord({ vendor: DEFAULT_VENDOR, model: null, startedAt: run.startedAt, endedAt: Date.now(), exit: outcome.result?.status ?? null }));
    const before = runnerStore.loadLedger(P.stateDir)[id];
    const ours = before?.headless && before.recordId === run.recordId;
    reconcileNow();
    // A Slack reply that arrived while the run worked was queued on its ledger
    // entry; nothing reads that queue once the run has ended, so it resumes it.
    const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    if (ours && before.parkNote && card && REOPENABLE_STATES.has(card.state)) {
      const r = await relaunchJobNow(id, { resume: { sessionId: run.sessionId }, note: before.parkNote, reason: 'a reply arrived while the headless run was working', source: 'operator' });
      if (!r.ok) backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `a reply queued during the headless run was not delivered: ${r.reason}` });
    }
    broadcastBacklog();
  }

  // The desktop app was built before headless cards existed. Tonight's work
  // must not stop for that: this card opens interactively, as before.
  async function launchInteractiveInstead(id, run) {
    const why = 'the desktop app refused the headless run because it does not know the card kind yet; rebuild the desktop app for headless launches';
    reportMiss('headless-card-shell', why);
    backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `${why}. Launching this card interactively instead.` });
    const entry = runnerStore.loadLedger(P.stateDir)[id];
    if (!entry?.headless || entry.recordId !== run.recordId) return;
    const card = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    const drop = () => { writeLedgerEntry(id, null); broadcastBacklog(); };
    if (!card || backlogStore.CLOSED_STATES.has(card.state)) return drop();
    let launched;
    try {
      launched = await launchJob(card, { resume: run.resume ? { sessionId: run.sessionId } : null, reopen: run.reopen, interactive: true });
    } catch (e) {
      if (e?.code === 'LAUNCH_POST_SPAWN_FAILED' && e.launched) launched = e.launched;
      else {
        drop();
        backlogStore.updateItemIn(P.stateDir, id, { state: 'held' });
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `interactive launch failed too: ${e?.message ?? e}; held` });
        return;
      }
    }
    const { headless: _h, recordId: _r, ...rest } = entry;
    writeLedgerEntry(id, {
      ...rest, pid: launched.pid ?? null, launchId: launched.launchId ?? null, startedAt: Date.now(), target: launched.target,
      worktree: launched.worktree ?? null, actor: launched.actor, route: launched.route,
      ...recordLaunchSession(id, launched.sessionId, launched.target, launched.worktree),
    });
    broadcastBacklog();
  }

  // One card -> a launched session. Writes the prompt to a file (never on a
  // command line) and opens it in the resolved editor target; the agent then
  // self-reports the card to done. Returns { target, pid, sessionId }.
  //
  // `resume`/`reopen`: only relaunchJobNow ever passes these.
  // `resume` is `{ sessionId }` for a reopen-by-reply that continues the
  // ticket's own Claude Code session (reopenBranch's branch b); `reopen` is
  // `{ note, reason }`, carried into the seeded prompt for either branch
  // (reason is only used on branch c, a fresh session).
  //
  // `role`/`reviewHead` (merge queue T6): every runner session is a 'worker'
  // unless a reviewer launch says otherwise; see lib/governance/role-permissions.js.
  // `reviewer` (glmps-2-0-44): { prompt, model, worktree } for a merge-queue
  // reviewer. The job is synthetic (no board card), runs in the worktree the
  // caller already made, and gets the caller's prompt verbatim.
  // `interactive` forces today's interactive launch: the fallback when the
  // desktop app cannot run a headless card.
  // Ids with a launch in flight. launchJob awaits git, so the ledger entry is only
  // written after it returns; this set keeps a second path from launching the same
  // card, or overshooting maxConcurrent, in the gap.
  const launching = new Set();

  // Card glmps-2-0-85: one session per card. Every path that starts or resumes
  // a card's session asks this first (planSessionGuard, lib/scut/close-sync.js).
  // A live session active in the last 30 minutes is adopted: it gets a ledger
  // entry again and the note this launch carried waits for its next park poll.
  // An idle one is closed so the launch replaces it. On where the close loop is.
  const cardSessionsOn = cfg.closeSync?.enabled ?? (isServiceMode(env) && !isTestProcess({ env }));
  const cardSessions = sessionCloser ?? createSessionCloser();
  // Read fresh at decision time: a window's idle|busy can flip between polls.
  const claudeWindows = () => readClaudeSessionRegistry(P.claudeSessionsDir, procStarts ? { procStarts } : undefined);
  // -> false (launch), 'adopted' (a live session took the card), or 'blocked'
  // (an idle session would not close, so nothing may launch beside it).
  async function liveSessionTakesIt(card, { note = null, source = null } = {}) {
    if (!cardSessionsOn || !card?.id) return false;
    launching.add(card.id);
    try {
      let sessions;
      try { sessions = await cardSessions.list(); }
      catch (e) { reportMiss('session-guard', `${card.id}: could not list sessions, launching anyway: ${e?.message ?? e}`); return false; }
      const activity = claudeActivity();
      let windows = new Map();
      // A window first seen now has its start-time probe in flight; wait for it
      // (async, off the event loop) rather than read the window as closed.
      try { claudeWindows(); if (!procStarts) await procStartsSettled(); windows = claudeWindows(); } catch (e) { reportMiss('session-guard', `${card.id}: could not read Claude's session registry: ${e?.message ?? e}`); }
      const plan = planSessionGuard({ card, sessions, activity, windows, now: Date.now() });
      if (plan.action === 'launch') return false;
      if (plan.action === 'replace') {
        for (const s of plan.sessions) {
          const r = await cardSessions.close(s);
          if (!r.ok) {
            // Never a second session beside one that would not close.
            reportMiss('session-guard', `${card.id}: idle session pid ${s.pid} did not close (${r.error}); not launching a second`);
            backlogStore.appendDevLogIn(P.stateDir, card.id, { by: 'runner', text: `not started: its idle Claude session (pid ${s.pid}) would not close: ${r.error}` });
            return 'blocked';
          }
        }
        backlogStore.appendDevLogIn(P.stateDir, card.id, { by: 'runner', text: `closed this card's idle Claude session (pid ${plan.sessions.map((s) => s.pid).join(', ')}) so the new launch replaces it` });
        return false;
      }
      const ledger = runnerStore.loadLedger(P.stateDir);
      if (ledger[card.id]) return 'adopted';
      let entry = { pid: plan.session.pid, launchId: null, startedAt: Date.now(), target: 'adopted', retries: 0, worktree: card.runSession?.worktree ?? null, adopted: true, sessionId: plan.session.sessionId };
      if (note) entry = parkQueueNote(entry, note, source === 'operator' ? 'operator' : 'external');
      ledger[card.id] = entry;
      runnerStore.saveLedger(P.stateDir, ledger);
      if (card.state !== 'in_progress') backlogStore.updateItemIn(P.stateDir, card.id, { state: 'in_progress' });
      if (card.pendingReopen) backlogStore.setPendingReopenIn(P.stateDir, card.id, null);
      const extra = plan.extra.length ? `; ${plan.extra.length} more copy running (pid ${plan.extra.map((s) => s.pid).join(', ')}), close it` : '';
      if (extra) reportMiss('session-guard', `${card.id}: more than one live session${extra}`);
      backlogStore.appendDevLogIn(P.stateDir, card.id, { by: 'runner', text: `a Claude session for this card is still running (pid ${plan.session.pid}), so no second one was started${note ? '; it gets the new instructions on its next park poll' : ''}${extra}` });
      broadcastBacklog();
      return 'adopted';
    } finally { launching.delete(card.id); }
  }

  // Card glmps-2-0-runtime-69: the same process list is the liveness signal for
  // a pid-less ledger entry (pidlessLiveness, queue-runner.js). Refreshed from
  // the tick without awaiting it, only while such an entry exists. ts is taken
  // before the list so the snapshot never claims to be newer than it is; a
  // failed list keeps the previous snapshot, which cannot end anything on its own.
  let pidlessSnapshot = null;
  let pidlessListInFlight = false;
  const pidlessLivenessMs = Number(cfg.pidlessLivenessMs) > 0 ? Number(cfg.pidlessLivenessMs) : 30_000;
  const PIDLESS_ACTIVE_MS = 10 * 60_000;
  function refreshPidlessSnapshot(ledger) {
    if (!cardSessionsOn || pidlessListInFlight) return;
    if (!Object.values(ledger).some((e) => e && e.pid == null && !e.headless && e.sessionId)) return;
    if (pidlessSnapshot && Date.now() - pidlessSnapshot.ts < pidlessLivenessMs) return;
    pidlessListInFlight = true;
    const ts = Date.now();
    cardSessions.list()
      .then((sessions) => {
        // Recent transcript writes count as alive (never as ended): a session
        // the operator resumed by hand carries no prompt file, so the list
        // alone would miss it while it is working.
        let recent = [];
        try {
          const active = new Set(sessionSummaries().filter((s) => s.tool === 'claude-code' && ts - s.lastTs < PIDLESS_ACTIVE_MS).map((s) => String(s.id).toLowerCase()));
          recent = Object.entries(ledger).filter(([, e]) => e?.sessionId && active.has(String(e.sessionId).toLowerCase())).map(([ticketId, e]) => ({ ticketId, sessionId: e.sessionId }));
        } catch (e) { reportMiss('pidless-liveness', `session activity unavailable: ${e?.message ?? e}`); }
        pidlessSnapshot = { ts, sessions: [...sessions, ...recent] };
      })
      .catch((e) => reportMiss('pidless-liveness', `could not list sessions: ${e?.message ?? e}`))
      .finally(() => { pidlessListInFlight = false; });
  }

  async function launchJob(job, opts) {
    launching.add(job.id);
    try { return await launchJobInner(job, opts); } finally { launching.delete(job.id); }
  }
  async function launchJobInner(job, { resume = null, reopen: reopenArg = null, role = 'worker', reviewHead = null, reviewer = null, interactive = false } = {}) {
    // Findings a merge reviewer left while the author could not be relaunched
    // ride the next ordinary launch, once.
    const pending = !reviewer && !reopenArg && job.pendingReopen?.note ? job.pendingReopen : null;
    const reopen = reopenArg ?? (pending ? { note: pending.note, reason: pending.reason ?? 'the merge reviewer asked for changes and no session was live to receive them', source: pending.source } : null);
    const rc = runnerStore.loadConfig(P.stateDir);
    const repo = repoForProject(job.project);
    let cwd = repo;
    const vendorPick = reviewer ? null : resolveCardModel(job);
    const vendorRun = vendorPick && vendorPick.vendor !== DEFAULT_VENDOR ? vendorPick : null;
    const wantHeadless = !reviewer && (vendorRun ? gitopsViaShell : !interactive && wantsHeadlessLaunch(job));
    // Reopen (D27 C2): a ticket that already has a worktree on disk reuses it,
    // never recreates it - createWorktree removes a leftover checkout first,
    // which here would be the very session history a reopen might resume
    // into. Applies to any launch that finds one, not only an explicit
    // resume/reopen: an ordinary requeue of a ticket that still has a live
    // worktree from its last run must not blow it away either.
    //
    // on an ORDINARY (non-resume) launch, reuse is gated on
    // `rc.useWorktrees` - if the operator has since turned isolation off, an
    // old tracked worktree must not be reused behind their back (a requeued
    // done ticket belongs in the shared repo at single-lane default, like any
    // other single-lane launch). A resume ignores that toggle: the session
    // being resumed lives in that exact directory regardless of the CURRENT
    // isolation policy for NEW work. Either way, `purgedTs` always skips reuse
    // - that field means some other path (the worktree sweeper) has already
    // logically retired this checkout, so `fs.existsSync` true here would be a
    // race, not a real invitation to reuse it.
    // A card that ran before the cutover recorded its worktree under the legacy
    // state folder. The junction keeps that path alive, but the desktop app
    // refuses a card cwd outside the current worktrees root by path text, so the
    // launch uses the same directory spelled under the current folder.
    const recordedDir = job.runSession?.worktree?.dir;
    const rebasedDir = rebaseLegacyStatePath(recordedDir, { stateDir: P.stateDir, legacyStateDir: P.legacyStateDir });
    if (rebasedDir !== recordedDir) {
      job = { ...job, runSession: { ...job.runSession, worktree: { ...job.runSession.worktree, dir: rebasedDir } } };
      try { backlogStore.setRunSessionIn(P.stateDir, job.id, { worktree: job.runSession.worktree }); } catch { /* the launch record rewrites it too */ }
      backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `recorded worktree moved from the legacy state folder: ${recordedDir} is now ${rebasedDir}` });
    }
    let kept = !reviewer && (resume || rc.useWorktrees || wantHeadless) && job.runSession?.worktree?.dir && !job.runSession?.purgedTs
      && fs.existsSync(job.runSession.worktree.dir) ? job.runSession.worktree : null;
    if (!kept && resume && !reviewer) kept = await recreateRecordedWorktree(job);
    let worktree = null;
    if (reviewer) {
      worktree = reviewer.worktree;
      cwd = reviewer.worktree.dir;
    } else if (kept) {
      worktree = kept;
      cwd = kept.dir;
    } else if (repo && (wantHeadless || shouldIsolate({ useWorktrees: rc.useWorktrees, maxConcurrent: slotTotal(rc) }))) {
      const wt = await createWorktree({
        repo, project: job.project, jobId: job.id,
        onReuse: (branch) => backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `worktree branch ${branch} already held commits that its start point lacks; reused as it is instead of being reset` }),
      });
      if (wt?.dir) { worktree = { ...wt, repo }; cwd = wt.dir; }
      // When createWorktree refused because this is a test process and the repo
      // is real, launching into cwd = repo would run the agent INTO that real
      // checkout - refuse the launch.
      // Accepted limit: a refused launch in a test
      // process repeats on every tick and ends that tick.
      else if (testRealGitWriteRefused(repo, { env, onResolveError: (reason) => reportMiss('test-write-guard', reason) })) {
        const reason = `launch refused for ${job.id}: this is a test process and the target repo is not a temp fixture, so it may not run in the real repo`;
        reportMiss('launch-job-test-guard', reason);
        const err = new Error(reason);
        err.code = 'TEST_GUARD_REFUSED';
        throw err;
      } else {
        // A session in the shared repo checkout can overwrite the operator's
        // live work (the 2026-10-28 incident), so a missing worktree never
        // degrades to cwd = repo. Held, not retried: the ledger slot is only
        // written after a successful launch, so nothing leaks.
        const f = wt?.failure ?? { reason: 'unknown', ownerDir: null };
        const owner = f.ownerDir ? `; its branch is checked out in ${f.ownerDir}, so another session likely owns this card` : '';
        const reason = `no worktree could be created (${f.reason})${owner}; not launched into the shared repo, held`;
        backlogStore.updateItemIn(P.stateDir, job.id, { state: 'held' });
        backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: reason });
        reportMiss('launch-job-no-worktree', `${job.id}: ${reason}`);
        broadcastBacklog();
        const err = new Error(`launch refused for ${job.id}: ${reason}`);
        err.code = 'WORKTREE_REFUSED';
        throw err;
      }
    }
    // a resume MUST run in the session's own
    // worktree - launching it into a brand-new, unrelated checkout (or the
    // bare repo) would silently lose the file history being resumed into.
    // `worktree` here can only be a freshly created one (never `kept`, which
    // is checked first), so remove it before failing (M3) rather than leaving
    // an orphan checkout for the worktree sweeper to find later. The caller
    // (relaunchJobNow) turns this into a generic `ok: false` failure (no
    // automatic retry: it does NOT itself fall back to a fresh branch-c
    // relaunch here, that stale claim is Phase C final review, M2) - the
    // reply is reported as a failed reopen, and the operator's own next
    // reply re-enters reopenBranch fresh, which then picks branch 'c' on its
    // own once the worktree is confirmed gone.
    if (resume && !kept) {
      if (worktree) await removeWorktree(worktree);
      throw new Error(`launchJob: resume requested for ${job.id} but its worktree is gone; the caller must fall back to a fresh relaunch`);
    }
    // the M1 guard above only covers ITS OWN deliberate
    // throw. writePrompt and launchSession (below) are the realistic OTHER
    // ways this function can throw (a full disk, a permissions error) - on a
    // BRANCH-C (non-resume) relaunch that just created a fresh worktree
    // (never `kept`, which is only ever reused), either one throwing must
    // not leave that checkout orphaned either.
    const freshWorktree = worktree && !kept ? worktree : null;
    const guardFreshWorktree = async (fn) => {
      try { return await fn(); }
      catch (e) { if (freshWorktree) await removeWorktree(freshWorktree); throw e; }
    };
    const preferred = resolveTarget({ item: job, lastTarget: rc.lastTarget, running: editorsForDefault() });
    // glmps-2-0-30: fresh launches and reopen-by-reply resumes alike open in
    // Antigravity when it can host them (the companion runs the same seeded
    // command verbatim), else natively.
    const target = sessionTarget(preferred);
    // A chosen IDE that cannot host the session is never silent: the card says why.
    if (!reviewer && !vendorRun && !wantHeadless && IDE_TARGETS.includes(preferred) && target === 'native-terminal') {
      backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `opened in a native terminal: ${TARGET_LABELS[preferred]} is ${ideFallbackReason(preferred)}` });
    }
    // every launch target runs the same
    // seeded claude command and can take --session-id (documented in the local CLI reference as
    // accepting "a valid UUID"). So every FRESH launch mints and records its
    // own session id synchronously here; planRunSessionRecords' inference
    // now only serves a ledger entry launched before this change existed.
    // a resume never mints - --session-id and --resume are never
    // emitted together, and the resumed session keeps the id it already has.
    const launchSessionId = resume ? null : crypto.randomUUID();
    // Agent routing (glmps-138 Task 6/7): decide once, name the specialist in
    // the launch header, and record the decision on the ledger (not the card,
    // which stays planner-authored) so Task 8's compliance metric can read it.
    const route = reviewer ? null : resolveRoute({
      job,
      routes: cfg.agentRoutes ?? {},
      minConfidence: cfg.agentRouteMinConfidence,
      minScore: cfg.agentRouteMinScore,
    });
    if (vendorRun) return launchVendorCard(job, { vendorRun, worktree, cwd, repo, route, reopen, guardFreshWorktree, pending, target, interactive });
    // A settings file, not inline JSON: the command is re-parsed by cmd.exe,
    // PowerShell and POSIX sh. Fail open: no file, no flag, the launch proceeds
    // (the push-lease hook still enforces a role if one reaches it).
    let roleFile = null;
    try {
      roleFile = writeRoleSettings(P.stateDir, {
        role, reviewHead, integrationBranches: cfg.integrationBranches, cardId: job.id, key: job.id,
      });
    } catch (e) {
      backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `role settings not applied: ${e?.message ?? e}` });
    }
    // The desktop app only runs a headless card in the card's own worktree and
    // under its worker settings; without either it opens interactively as before.
    const headlessWhyNot = !wantHeadless ? null : !worktree ? 'it has no worktree of its own' : !roleFile ? 'its worker settings could not be written' : null;
    const headless = wantHeadless && !headlessWhyNot;
    if (headlessWhyNot) backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `headless launch not possible (${headlessWhyNot}); launching interactively` });
    if (!headless && !reviewer) job = await withOwnChannel(job);
    const skills = reviewer ? null : resolveSkills({ job, route, vocab: loadSkillCues(REPO_ROOT), reply: operatorReply(reopen) });
    const header = launchHeader({ job, port: actualPort, route, skills, parkHoldMs, headless, timeZone: displayTimeZone() });
    // Reopen (D27 C2): branch b's prompt carries only the reply (the agent
    // already has the rest of the ticket in its own context); branch c
    // carries the normal seed doc plus a section explaining why the old
    // session could not be resumed. Neither is set on an ordinary launch.
    const body = resume
      ? reopenSeedSection({ note: reopen?.note, branch: 'b', source: reopen?.source, headless })
      : `${buildSeedDoc(job, { port: actualPort })}${reopen ? `\n\n${reopenSeedSection({ note: reopen.note, branch: 'c', reason: reopen.reason, source: reopen.source })}` : ''}`;
    const promptFile = await guardFreshWorktree(() => runnerStore.writePrompt(P.stateDir, job.id, reviewer ? reviewer.prompt : `${header}\n\n${body}`));
    let seeded = resume ? resumedCommand(claudeCmd, resume.sessionId, promptFile) : seededCommand(claudeCmd, promptFile, { sessionId: launchSessionId });
    if (roleFile) seeded = scutAppendArgs(seeded, ['--settings', roleFile]);
    if (reviewer?.model) seeded = scutAppendArgs(seeded, ['--model', reviewer.model]);
    // glmps-42: a slack-origin job's session owns a Slack CHANNEL, so
    // the operator's follow-ups arrive as in-band user turns over the session's
    // own MCP connection instead of being handed to whichever of park/steer/
    // relaunch the router guesses at. Purely additive - every existing delivery
    // path is untouched, and any failure here degrades to today's behaviour.
    try {
      const plan = reviewer || headless ? null : scutChannelLaunchPlan({
        job,
        stateDir: P.stateDir,
        // The launch cwd is the job's own worktree, and that is where the
        // channel has to be registered: a `server:` channel resolves against
        // the persisted MCP scopes, so the project-scope .mcp.json there is
        // what makes it findable at all.
        cwd,
        serverPath: path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'lib', 'scut', 'channel-server.js'),
        // Pin the EXACT creds file this server resolved rather than letting the
        // child re-derive it from GLMPS_STATE_DIR. The two agree today only because
        // stateDir happens to be the creds base; a profile that moves one and
        // not the other would leave the channel silently tokenless and inert.
        credsFile: scutCredsPath(env),
        // Opt-in, default OFF (glmps-49). The channel needs
        // --dangerously-load-development-channels, which makes Claude Code
        // stop at a "WARNING: Loading development channels" modal on every
        // launch, and an unattended runner job has nobody to confirm it. With
        // the channel off, the Slack relay still works through /devlog, /gate
        // and park/wake, which is what the launch header tells the session to
        // use. Turn it on with `"scut": { "channel": true }` in config.json,
        // accepting one click per launched job.
        enabled: cfg.scut?.channel === true,
      });
      if (plan) {
        // Say it on the card, not just in this comment: the operator who
        // opted in should see WHY their session is sitting on a dialog.
        backlogStore.appendDevLogIn(P.stateDir, job.id, {
          by: 'runner',
          text: 'slack channel attached (scut.channel): this launch shows Claude Code\'s development-channels confirmation and needs one click before the agent starts',
        });
        fs.mkdirSync(path.dirname(plan.configPath), { recursive: true });
        fs.writeFileSync(plan.configPath, JSON.stringify(plan.config, null, 2));
        seeded = scutAppendArgs(seeded, plan.args);
        // Pre-approve the server we just registered, or the launched session
        // stops at an interactive "use this project's MCP servers?" prompt that
        // nothing is there to answer.
        fs.mkdirSync(path.dirname(plan.approval.path), { recursive: true });
        fs.writeFileSync(
          plan.approval.path,
          JSON.stringify(scutMergeApproval(readJsonSafe(plan.approval.path), plan.approval.patch), null, 2) + '\n',
        );
        // .mcp.json now sits in a real checkout, so keep it out of the agent's
        // `git status` (and out of an accidental `git add -A`). info/exclude is
        // local-only and never committed, which is exactly the right scope for
        // a file this server generates.
        try {
          const exclRun = await runAsync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'], { timeout: 15_000 });
          if (exclRun.status !== 0) throw new Error(exclRun.stderr.trim() || `git exited ${exclRun.status}`);
          const excl = exclRun.stdout.trim();
          const abs = path.isAbsolute(excl) ? excl : path.join(cwd, excl);
          const cur = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
          if (!/^\.mcp\.json$/m.test(cur)) {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.appendFileSync(abs, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}.mcp.json\n`);
          }
        } catch { /* cosmetic only - never block a launch over an ignore rule */ }
      }
    } catch (e) {
      backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `slack channel not wired: ${e?.message ?? e}` });
    }
    // Seed the declared goal under job.id: a claude-code launch's runtime
    // session id IS now known synchronously (launchSessionId, above), but
    // writeDeclared stays keyed by job.id on purpose - it is the one stable
    // key that survives a park/release/relaunch cycle, matching the same
    // worktree-based bridge (worktreeParent() on the session's cwd, which
    // already encodes job.id as the worktree's last path segment) every other
    // job->session lookup in this file uses. Every launch target (including
    // antigravity, round 3 review re-ruling I2) now mints its runtime session
    // id synchronously too, but job.id stays the key here regardless, since it
    // is the one identity that survives a park/release/relaunch cycle intact.
    // /api/state?session=<runtime-sid> reads the card's sessionId/runSession
    // for that bridge, not this declared-goal record.
    // M-b: guarded like writePrompt/launchSession below - the
    // one other unguarded write between the M1 check and the return.
    await guardFreshWorktree(() => writeDeclared(P.stateDir, job.id, { goal: job.title ?? job.prompt?.slice(0, 120) ?? '', ts: Date.now() }));
    // Attribution (glmps-72 B1): chat-originated tickets thread the chat user
    // through to the ledger entry + companion launch record; everything else is
    // attributed to this server's configured/default local identity.
    const actor = actorForJob({ job, cfgActor: cfg.actor });
    // Task 12b: service mode queues this launch instead of spawning it -
    // launchId travels alongside pid so the ledger entry below can be
    // patched with the real pid once the shell reports it (POST
    // /api/launches/:id/result).
    const sessionId = resume ? resume.sessionId : launchSessionId;
    const { pid, launchId, target: openedIn, recordId = null } = await guardFreshWorktree(() => (headless
      ? startHeadlessCard(job, { cwd, settings: roleFile, promptFile, sessionId, resume: !!resume, reopen })
      : launchSession({ target, seeded, cwd, actor, jobId: job.id })));
    // the ledger/card session is the RESUMED id when resuming
    // (recorded, not minted); otherwise the freshly minted one, as before.
    // The ledger records where the session actually opened (a companion
    // write failure falls back to native-terminal).
    const result = { target: openedIn ?? target, pid, launchId, worktree, actor, route, sessionId, ...(headless ? { headless: true, recordId } : {}) };
    const where = headless ? 'headless in the desktop app' : `in ${target}`;
    // Phase C final review, M7 (second half): the session is ALREADY running
    // at this point (launchSession above returned) - everything from here is
    // bookkeeping, not the launch itself. A caller that rolled this card back
    // to idle on one of these throwing would leave a real, unrecorded session
    // running next to a card that claims nothing is happening, inviting a
    // second launch into the same worktree on the next retry. Name the error
    // and attach `result` so relaunchJobNow can record the ledger entry
    // anyway instead of rolling back.
    try {
      if (reviewer) return result; // no card to annotate; the caller records the launch on the author card
      backlogStore.applyLabelDeltaIn(P.stateDir, job.id, { labels: ['agent:in-progress'], comment: `runner: launched ${where}${worktree ? ' (worktree)' : ''}` });
      if (pending) backlogStore.setPendingReopenIn(P.stateDir, job.id, null);
      if (!job.assignee) backlogStore.updateItemIn(P.stateDir, job.id, { assignee: headless ? 'headless' : target });
      backlogStore.appendDevLogIn(P.stateDir, job.id, {
        by: 'runner',
        text: `launched ${where}${worktree ? ' (worktree)' : ''}${resume ? `, resuming session ${resume.sessionId.slice(0, 8)}` : ''}${reopen && !resume ? ', fresh after a failed resume' : ''}`,
      });
    } catch (e) {
      const err = new Error(`launchJob: post-spawn bookkeeping failed for ${job.id} after the session was already spawned: ${e?.message ?? e}`);
      err.code = 'LAUNCH_POST_SPAWN_FAILED';
      err.launched = result;
      throw err;
    }
    return result;
  }

  // Gate choke point 2/3 (glmps-72 B3): a ticket may name a `requiredRole`
  // (planner-set, e.g. via PATCH) that the runner's own acting identity
  // (cfg.actor ?? 'operator') must hold to claim/launch it. A permanent no-op
  // in solo mode (actors: []) or when the ticket names no role.
  function claimGate(job) {
    const v = vendorGate(job);
    if (!v.allowed) return v;
    if (!job.requiredRole) return { allowed: true };
    return gateCheck({ actors, actorId: cfg.actor ?? 'operator', role: job.requiredRole });
  }

  // Card glmps-2-0-162: a non-Claude card runs only through the desktop app, in
  // its own worktree, on a class and wording the vendor fence allows. Refused
  // here, the card is held with the reason rather than run on Claude instead.
  function vendorGate(job) {
    const { vendor } = resolveCardModel(job);
    if (vendor === DEFAULT_VENDOR) return { allowed: true };
    const label = vendorById(vendor)?.label ?? vendor;
    if (!gitopsViaShell) return { allowed: false, reason: `${label} cards run only through the GLMPS desktop app, and this server is not using it` };
    if (shellLacksVendorKind()) return { allowed: false, reason: `the desktop app does not know ${label} runs yet; rebuild the desktop app, then requeue the card` };
    if (!repoForProject(job.project)) return { allowed: false, reason: `${label} runs need a repo checkout for project ${job.project}` };
    return vendorEligibility({ vendor, card: job, cfg: runnerStore.loadConfig(P.stateDir) });
  }

  // The SCUT runtime facade, or null when the Slack layer is not configured.
  // Declared here (assigned by startScut() further down) because reconcileNow
  // reports job outcomes into Slack rooms and only ever runs after startup.
  let scut = null;
  let scutBooted = false;
  const processBootTs = Date.now();
  // The first reconcile after boot is the one that can see jobs orphaned by the
  // host going down. See the hostRestarted block in reconcileNow.
  let firstReconcile = true;

  // Reconcile the live ledger against current cards (dead/overrunning -> requeue/held),
  // persist it, and return fresh { rc, bl, ledger, hadActions }.
  /**
   * How long job `id` has spent blocked on approval gates (glmps-29),
   * so reconcileLedger can subtract it from wall clock. A job waiting on a human
   * is not a runaway job; without this every gated job trips maxRuntimeMs (30
   * min by default) and is requeued while its agent is alive and still waiting.
   *
   * The job -> session link is the runner worktree layout, the same bridge
   * bindSessions uses. Banked waits come from the control record; a gate that is
   * STILL pending is added live, because that is precisely the window in which
   * the job would otherwise be judged overrun.
   */
  // `summariesOnce`: an optional lazy, memoized sessionSummaries() getter
  // shared by the caller across one whole tick (round 1 review M3; made lazy
  // in round 2 review M1 - see runnerTick). reconcileLedger calls this once
  // per RUNNING ledger entry, every tick; without a shared value this walked
  // and stat'd the entire session corpus that many times over, for entries
  // whose worktree hardly ever matches anything. Falls back to computing its
  // own when omitted, so every other/older caller (runJobNow) is unaffected.
  function jobGateWaitMs(id, summariesOnce) {
    try {
      const list = summariesOnce ? summariesOnce() : sessionSummaries();
      const sessionId = list.find(s => s.live && s.worktree?.kind === 'runner' && s.worktree?.id === id)?.id;
      if (!sessionId) return 0;
      const rec = ctlReadControl(P.stateDir, sessionId);
      if (!rec) return 0;
      const banked = Number(rec.gateWaitMs) || 0;
      const pending = rec.gate?.decision === 'pending'
        ? Math.max(0, Date.now() - (Number(rec.gate.requestedTs) || 0))
        : 0;
      return banked + pending;
    } catch { return 0; }
  }

  // C2's own liveness proof, distinct from ticketLastActivityMs below (which
  // asks "is this session STILL active"): a claude-code session's transcript
  // file is created fresh when the session starts and never recreated, so its
  // filesystem birth time is that session's actual start time - the one
  // signal that lets planRunSessionRecords refuse a session that predates the
  // job it would otherwise get bound to forever. null for anything this can't establish (no transcript on record, or
  // the stat fails), which planRunSessionRecords treats as disqualifying, not
  // as a pass - named via reportMiss rather than swallowed silently, since a persistently-null firstTs is exactly what keeps a
  // ticket unrecorded forever.
  function sessionFirstActivityMs(sessionId) {
    const transcriptPath = index.get(sessionId)?.transcriptPath;
    if (!transcriptPath) return null;
    try {
      const ms = fs.statSync(transcriptPath).birthtimeMs;
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    } catch (e) {
      reportMiss('runner-session-firstts', `${sessionId}: ${e?.message ?? String(e)}`);
      return null;
    }
  }

  // D27 proof of life: the newest captured activity from a ticket's session
  // (the one recorded on its ledger entry, plus any session working in its
  // runner worktree). The in-memory event ring and the session summaries are
  // both already in this closure; no file is read.
  function ticketLastActivityMs(ticketId, entry, summaries) {
    return scutTicketActivityMs({
      ticketId, entry,
      // A caller sweeping many entries in one pass (the park-sweep loop)
      // builds this once and passes it in, rather than making this function
      // recompute it fresh - a full session walk with a stat() per session -
      // for every single entry.
      summaries: summaries ?? sessionSummaries(),
      tailTsOf: (sid) => eventLog.get(sid)?.at(-1)?.ts ?? null,
    });
  }

  // `summariesOnce`: an optional lazy sessionSummaries() getter (see
  // jobGateWaitMs above); runnerTick builds one memoized getter per tick and
  // passes it through so this tick's gate-wait lookups share it instead of
  // each re-walking the whole session corpus - and, being lazy, an idle tick
  // with nothing running never calls sessionSummaries() at all. runJobNow
  // (the only other caller) omits it, and jobGateWaitMs falls back to
  // computing its own - unaffected.
  // D27 C2: a hidden-or-idle ticket's worktree is leased by this
  // rule too, alongside the ledger entry and cwd occupancy reconcileNow and
  // sweepWorktrees already check. Recomputed fresh on every call (never
  // cached across reconcileNow/sweepWorktrees invocations): hiddenTs changes
  // independently of both the ledger and the sweep timer, so a cached answer
  // could keep leasing a worktree well past its 30 days, or reclaim one the
  // instant it is still within them.
  function retainedWorktreeJobs() {
    const file = scutTicketChannelsPath(P.stateDir, env);
    // loaded ONCE here (listTicketChannels reads the
    // whole store in one call) rather than once PER CARD via
    // channelForTicket - a loop over every backlog item used to re-read and
    // re-parse the whole ticket-channels file per item.
    const byTicket = new Map(scutListTicketChannels({ file }).map((e) => [e.ticketId, e]));
    return scutRetainedJobIds({
      items: backlogStore.load(P.stateDir).items,
      hiddenTsOf: (id) => byTicket.get(id)?.hiddenTs ?? null,
      // distinguishes "no channel at all" (never retained
      // by the hidden-race fallback) from "channel bound, hide not landed
      // yet" (retained from the card's own stateEnteredAt).
      channelBoundOf: (id) => byTicket.has(id),
      now: Date.now(),
    });
  }

  function reconcileNow(summariesOnce) {
    const rc = runnerStore.loadConfig(P.stateDir);
    const before = runnerStore.loadLedger(P.stateDir);
    const rec = reconcileLedger({
      ledger: before, items: backlogStore.load(P.stateDir).items, isAlive: pidAlive,
      now: Date.now(), maxRuntimeMs: rc.maxRuntimeMs, maxRetries: rc.maxRetries,
      // Parked time is banked out of the runtime clock exactly like gate
      // waits: a session idling between phases is not a runaway job.
      gateWaitMs: (id) => jobGateWaitMs(id, summariesOnce) + scutParkWaitMs(before[id], Date.now()),
      headlessLive,
      headlessSlackMs: Number(cfg.headlessKillSlackMs) >= 0 && cfg.headlessKillSlackMs != null ? Number(cfg.headlessKillSlackMs) : 5 * 60_000,
      pidlessSnapshot: cardSessionsOn ? pidlessSnapshot : null,
    });
    let ledger = rec.ledger;
    // A headless run held past its cap is still running in the desktop app: ask it to stop.
    for (const a of rec.actions) {
      const run = headlessCards.get(a.id);
      if (a.action === 'hold' && run?.recordId && !(a.id in ledger)) { try { gitopsBroker.cancel(run.recordId); } catch { /* the run still ends at the shell's own timeout */ } }
    }
    // Any job that left the live ledger (done/held) gets its worktree reclaimed.
    // Requeued jobs keep their entry, so their worktree is left in place.
    // Reclaim the worktree of any job that left the live ledger, but ONLY when
    // its agent is provably gone AND nobody is sitting in the checkout. `held`
    // after maxRetries is the common exit and it fires precisely because the
    // agent outran maxRuntimeMs, i.e. it is still working in that checkout.
    // Removing on the ledger signal alone used to run `git worktree remove
    // --force` against a live agent and destroy uncommitted work. See
    // reclaimVerdict (glmps-53).
    // Routing evidence must outlive the ledger. `ledger` below is persisted over
    // launched.json, so a departed entry's `route` is ERASED here - which is why
    // the compliance metric could only ever see in-flight jobs. Record the
    // decision durably from this same departed-set loop, BEFORE the save, so a
    // completed routed card still counts toward the pre-registered n=20
    // escalation review. Fail-open: a measurement write must never break the
    // runner (same posture as the worktree reclaim below it).
    // glmps-53: the same occupancy signal the worktree sweeper uses.
    // Computed per tick and never cached ACROSS ticks, because a stale liveDirs
    // list is how a checkout gets deleted out from under a live agent. Lazy on
    // purpose: reconcileNow runs every runnerTickMs (5s) and almost every tick
    // has nothing departed, while sessionSummaries() maps the whole session
    // corpus and re-reads a file. Today an idle tick calls it zero times (only
    // jobGateWaitMs does, and only per ledger entry); computing it eagerly here
    // would put that scan on every idle tick forever.
    let liveDirsMemo = null;
    const occupancy = () => (liveDirsMemo ??=
      sessionSummaries().filter(s => s.state !== 'ended').map(s => s.cwd).filter(Boolean));
    // D27 C2: computed lazily, once per reconcileNow call (an idle
    // tick with nothing departed never touches it), and checked BEFORE
    // reclaimVerdict - a retained id is never even asked whether its agent is
    // provably gone, since the answer would not matter either way.
    let retainedMemo = null;
    const retained = () => (retainedMemo ??= retainedWorktreeJobs());
    const departed = [];
    for (const id of Object.keys(before)) {
      if (id in ledger) continue;
      departed.push({ id, route: before[id]?.route ?? null, worktreeDir: before[id]?.worktree?.dir ?? null });
      // the one shared helper this and the launch-result
      // route's own hold path both call now.
      reclaimDepartedJobWorktree(id, before[id], { retainedIds: retained(), liveDirs: occupancy() });
    }
    if (departed.length) { try { appendRoutingLog(P.stateDir, departed); } catch { /* fail-open */ } }
    // SCUT outbound: a job that left the live ledger has finished (or was held),
    // so tell the Slack room that launched it. Jobs still in the ledger get their
    // runtime session id bound to their room as soon as one is discoverable -
    // that binding is what lets the NEXT mention in that thread steer the running
    // session instead of launching a second job. Both calls swallow their own
    // errors; the runner must never be broken by Slack.
    if (scut) {
      const acted = new Map(rec.actions.map(a => [a.id, a.action]));
      const byId = new Map(backlogStore.load(P.stateDir).items.map(i => [i.id, i]));
      for (const id of Object.keys(before)) {
        if (id in ledger) continue;
        const action = acted.get(id) ?? null;
        // `!action` only means the runner did not have to intervene. The verdict
        // the operator actually cares about is the gate the agent recorded, so
        // pass it through and let the notifier prefer it.
        scut.jobFinished({
          ticketId: id,
          ok: !action || action === 'release',
          detail: action ? `runner: ${action}` : null,
          verdict: byId.get(id)?.gate?.status ?? null,
        });
      }
      // Explain on return. On the first pass after boot, a job whose process is
      // gone did not fail in the ordinary way: the host went down under it.
      // These are REQUEUED, which means they STAY in the ledger, so the loop
      // above never sees them and the room would otherwise hear nothing at all
      // about the outage - it would just eventually see a second attempt appear.
      if (firstReconcile) {
        for (const a of rec.actions) {
          if (a.reason !== 'process exited') continue;
          scut.hostRestarted({ ticketId: a.id, action: a.action });
        }
      }
      scut.bindSessions(Object.keys(ledger));
    }
    firstReconcile = false;
    for (const a of rec.actions) {
      if (a.action === 'requeue') backlogStore.applyLabelDeltaIn(P.stateDir, a.id, { labels: ['agent:backlog'], comment: `runner: requeued (${a.reason})` });
      // A finished headless run waits on the operator as idle, so a reply reopens it.
      else if (a.action === 'release') backlogStore.releaseToIdleIn(P.stateDir, a.id, { kind: 'headless-exit', why: a.reason });
      else backlogStore.updateItemIn(P.stateDir, a.id, { state: 'held' });
      if (before[a.id]?.headless && a.action !== 'requeue') backlogStore.appendDevLogIn(P.stateDir, a.id, { by: 'runner', text: `${a.action === 'release' ? 'released to idle' : 'held'}: ${a.reason}` });
    }
    runnerStore.saveLedger(P.stateDir, ledger);
    return { rc, bl: backlogStore.load(P.stateDir), ledger, hadActions: rec.actions.length > 0 };
  }

  // how many CONSECUTIVE ticks a ledger id has been
  // diagnosed 'ambiguous' by diagnoseUnrecorded (see runnerTick). Ambiguity is
  // expected to self-resolve quickly on its own (e.g. right after a stale
  // release, an old and a new session can both be transiently live for one
  // tick), so it is only worth a report once it PERSISTS - unlike the other
  // two diagnoses, which are not expected to self-resolve and are reported
  // every tick they recur. 12 ticks at the 5s runnerTick cadence is one minute.
  const unrecordedAmbiguousStreak = new Map();
  const UNRECORDED_AMBIGUOUS_TICKS = 12;

  // Accepted limit: a refused launch in a test
  // process repeats on every tick and ends that tick.
  // One tick at a time: launching awaits git now, so a slower tick must not be
  // joined by the next interval's tick picking the same card. Callers (the
  // interval, tests) get the in-flight promise back.
  let runnerTickInFlight = null;
  function runnerTick() {
    if (runnerTickInFlight) return runnerTickInFlight;
    runnerTickInFlight = runnerTickOnce()
      .catch((e) => reportMiss('runner-tick', e?.message ?? String(e)))
      .then(() => Promise.allSettled([...reclaimsInFlight]))
      .finally(() => { runnerTickInFlight = null; });
    return runnerTickInFlight;
  }
  async function runnerTickOnce() {
    try {
      // The SCUT park sweep is its own registered loop now (scut-park-sweep,
      // Phase C Task 4): it no longer rides this 5s tick.
      void scut?.progressTick?.();
      void scut?.drainPendingReopens?.();
      // Own gate (mergeQueueMayRun) and own error handling: it never affects dispatch below.
      void mergeQueueTick();
      // Lazy and memoized: computed at most once per
      // tick, shared by reconcileNow (-> jobGateWaitMs) and the C2 block
      // below, but ONLY if something actually calls it - an idle tick with
      // nothing running, or a fully-recorded ledger, now never walks the
      // session corpus at all. Eagerly computing it here
      // put that walk inside THIS function's own try, so a throw from it
      // would have skipped reconcileNow, blocked-ticket handling AND job
      // dispatch entirely; each actual call site below (jobGateWaitMs's own
      // try, and the C2 block's) instead sees the empty-array fallback below,
      // never a throw - dispatch still runs.
      //
      // a THROWING sessionSummaries() is memoized too -
      // the failure itself, not just a successful result - so a persistently
      // broken corpus scan is attempted once per tick, not once per caller
      // (jobGateWaitMs alone is called once per running ledger entry).
      let summariesCache;
      let summariesFailed = false;
      const summariesOnce = () => {
        if (summariesFailed) return [];
        if (summariesCache) return summariesCache;
        try { return (summariesCache = sessionSummaries()); }
        catch (e) {
          summariesFailed = true;
          reportMiss('runner-session-summaries', e?.message ?? String(e));
          return [];
        }
      };
      const { rc, bl, ledger, hadActions } = reconcileNow(summariesOnce);
      refreshPidlessSnapshot(ledger);
      // an id whose job left the ledger ENTIRELY (done,
      // held, reclaimed) must drop its streak too, not only an id that is
      // still in the ledger but no longer diagnosed 'ambiguous' - otherwise a
      // ticket relaunched later (a fresh ledger entry, genuinely new
      // ambiguity) could inherit a stale count from a run that finished ticks
      // ago, and "consecutive" would no longer mean consecutive. Runs every
      // tick, unconditionally - not only while the C2 block below executes.
      for (const trackedId of unrecordedAmbiguousStreak.keys()) if (!(trackedId in ledger)) unrecordedAmbiguousStreak.delete(trackedId);
      // record the session each runner job actually runs in, the first
      // time it is visible working in the job's worktree. Only computed while
      // some entry still lacks one, so a fully-recorded ledger costs nothing
      // beyond the Object.values scan. Wrapped in its own try (round 1 review,
      // a failure here (e.g. a card write hitting EPERM) is reported by
      // name and must never fall into the bare catch below, which would also
      // swallow the blocked-ticket handling and job dispatch that follow.
      try {
        if (Object.values(ledger).some((e) => !e.sessionId)) {
          const unrecorded = new Set(Object.entries(ledger).filter(([, e]) => !e.sessionId).map(([id]) => id));
          // Only live runner-worktree sessions sitting on one of THOSE ids are
          // ever candidates, so the extra stat() this needs (sessionFirstActivityMs)
          // is bounded by the number of still-unrecorded, currently-running jobs,
          // not the whole session corpus.
          const live = summariesOnce()
            .filter((s) => s.live && s.worktree?.kind === 'runner' && unrecorded.has(s.worktree.id))
            .map((s) => ({ ...s, firstTs: sessionFirstActivityMs(s.id) }));
          const previousSessionIds = Object.fromEntries(bl.items.map((i) => [i.id, i.runSession?.sessionId ?? null]));
          const records = planRunSessionRecords({ ledger, live, previousSessionIds });
          let changed = false;
          for (const rec of records) {
            try {
              const r = backlogStore.setRunSessionIn(P.stateDir, rec.id, { sessionId: rec.sessionId, launcher: rec.launcher, worktree: rec.worktree, recordedTs: Date.now(), purgedTs: null });
              // ledgerPatchFor only mirrors once the card write
              // above has verifiably landed, so a missing/failed card write
              // never leaves the ledger claiming a session the card itself
              // never recorded.
              const patch = ledgerPatchFor(rec, r);
              if (!patch) continue;
              ledger[rec.id] = { ...ledger[rec.id], ...patch };
              changed = true;
            } catch (e) { reportMiss('runner-session-record', `${rec.id}: ${e?.message ?? String(e)}`); }
          }
          if (changed) runnerStore.saveLedger(P.stateDir, ledger);
          // name every entry still unrecorded after this
          // tick's attempt, instead of a silent null. `ledger` above has
          // already been mutated for anything just recorded, so
          // diagnoseUnrecorded naturally skips those (it only ever reads
          // `entry?.sessionId` to decide what to diagnose).
          const diagnoses = diagnoseUnrecorded({ ledger, live, previousSessionIds });
          const stillAmbiguous = new Set(diagnoses.filter((d) => d.reason === 'ambiguous').map((d) => d.id));
          for (const trackedId of unrecordedAmbiguousStreak.keys()) if (!stillAmbiguous.has(trackedId)) unrecordedAmbiguousStreak.delete(trackedId);
          for (const d of diagnoses) {
            if (d.reason !== 'ambiguous') { reportMiss('runner-session-record', `${d.id}: ${d.reason}`); continue; }
            const streak = (unrecordedAmbiguousStreak.get(d.id) ?? 0) + 1;
            unrecordedAmbiguousStreak.set(d.id, streak);
            if (streak >= UNRECORDED_AMBIGUOUS_TICKS) reportMiss('runner-session-record', `${d.id}: ambiguous session candidates for ${streak} ticks`);
          }
        }
      } catch (e) { reportMiss('runner-session-record', e?.message ?? String(e)); }
      // Cards the runner held for blockers go back to queued once every blocker
      // resolves, so a chain of cards keeps moving without the operator.
      const released = releasableHeld(bl.items);
      for (const r of released) {
        backlogStore.updateItemIn(P.stateDir, r.id, { state: 'queued' });
        backlogStore.appendDevLogIn(P.stateDir, r.id, { by: 'runner', text: `runner: released - blockers resolved: ${r.resolved.join(', ') || 'none left'}` });
      }
      const afterRelease = released.length ? backlogStore.load(P.stateDir).items : bl.items;
      // Blocked tickets never launch; surface them to the operator instead.
      const blocked = blockedQueued(afterRelease);
      for (const b of blocked) {
        if (b.forBlockers) backlogStore.holdForBlockersIn(P.stateDir, b.id);
        else backlogStore.updateItemIn(P.stateDir, b.id, { state: 'held' });
        backlogStore.applyLabelDeltaIn(P.stateDir, b.id, { comment: `runner: auto-held \u2014 blocked by ${b.blockers.join(', ')}` });
      }
      if (released.length || blocked.length) broadcastBacklog();
      const items = blocked.length ? backlogStore.load(P.stateDir).items : afterRelease;
      const usage = slotUsage({ ledger, launching, items });
      if (shouldClaim({ enabled: rc.enabled, paused: bl.paused, runningCount: usage.auto + usage.operator, maxConcurrent: slotTotal(rc), maintenance: maintenanceHold() })) {
        // glmps-53: a REQUEUED job sets its card back to `queued` while
        // deliberately keeping its ledger entry, so the ledger keys are a hard
        // exclusion here, not just a concurrency count. Without this, the very
        // next tick could re-pick that same card and launch a second agent onto
        // its worktree (worktreePlan is deterministic on the job id).
        // Only the reserved operator lane is free: automation cards wait for it.
        const autoRoom = hasCapacity({ usage, maxConcurrent: rc.maxConcurrent, operatorSlots: rc.operatorSlots });
        const job = pickNextJob(items, [...Object.keys(ledger), ...launching], { operatorOnly: !autoRoom, preferOperator: rc.operatorSlots > 0 });
        if (job) {
          const gate = claimGate(job);
          if (!gate.allowed) {
            // Same treatment as blockedQueued: demote to held so a human sees
            // why, never silently drop it or crash the tick.
            backlogStore.updateItemIn(P.stateDir, job.id, { state: 'held' });
            backlogStore.appendDevLogIn(P.stateDir, job.id, { by: 'runner', text: `runner: auto-held \u2014 ${gate.reason}` });
            broadcastBacklog();
            return;
          }
          // Service mode: the upstream fetch is the shell's, so wait for it (a later tick launches).
          const startRepo = gitopsViaShell ? repoForProject(job.project) : null;
          if (startRepo && (wantsHeadlessLaunch(job) || shouldIsolate({ useWorktrees: rc.useWorktrees, maxConcurrent: slotTotal(rc) })) && shellStartPending(startRepo)) return;
          if (await liveSessionTakesIt(job, { note: job.pendingReopen?.note ?? null, source: job.pendingReopen?.source ?? null })) return;
          let launched;
          try { launched = await launchJob(job); }
          catch (e) {
            // Phase C rejoin authorization fix round: a post-spawn
            // bookkeeping failure means the session is ALREADY running
            // (M7) - record the ledger entry anyway, same as
            // relaunchJobNow, so the next tick's pickNextJob (which
            // excludes only EXISTING ledger keys) does not launch this
            // card a second time into the same worktree. Any OTHER error
            // falls through to the outer catch below, unchanged.
            if (e?.code === 'LAUNCH_POST_SPAWN_FAILED' && e.launched) {
              reportMiss('runner-tick-post-spawn', `${job.id}: recording the ledger anyway - ${e.message}`);
              launched = e.launched;
            } else {
              throw e;
            }
          }
          const { target, pid, launchId, worktree, actor, route, sessionId } = launched;
          writeLedgerEntry(job.id, { pid: pid ?? null, launchId: launchId ?? null, startedAt: Date.now(), target, retries: ledger[job.id]?.retries ?? 0, worktree: worktree ?? null, actor, route, ...headlessLedgerFields(launched), ...recordLaunchSession(job.id, sessionId, target, worktree) });
          broadcastBacklog();
          return;
        }
      }
      if (hadActions) broadcastBacklog();
    } catch { /* the runner must never crash the server */ }
  }

  function slotTotal(rc) { return rc.maxConcurrent + Math.max(0, Number(rc.operatorSlots) || 0); }
  function roomFor(card, { rc, items, ledger, except = null }) {
    const usage = slotUsage({ ledger, launching, items, except });
    return hasCapacity({ usage, maxConcurrent: rc.maxConcurrent, operatorSlots: rc.operatorSlots, forOperator: isOperatorCard(card) });
  }

  // Manual "Run now": launch one specific card immediately, regardless of the
  // Auto-run toggle or board pause, but still honoring maxConcurrent (plus the
  // reserved operator lane for an operator card).
  async function runJobNow(id) {
    const { rc, bl, ledger } = reconcileNow();
    const job = bl.items.find(i => i.id === id);
    if (!job) return { status: 404, body: { error: 'item not found' } };
    if (ledger[id] || launching.has(id)) return { status: 409, body: { error: 'already running' } };
    if (backlogStore.CLOSED_STATES.has(job.state)) return { status: 409, body: { error: `card is ${job.state}` } };
    // Poison gate: even an explicit "Run now" cannot launch a quarantined card.
    // Force the operator to review and approve it first (POST .../approve).
    if (job.quarantined) return { status: 409, body: { error: 'card is poison-quarantined \u2014 review and approve it before running', flags: job.provenance?.flags ?? [] } };
    if (job.needsIntent) return { status: 409, body: { error: 'card was filed without acceptance criteria; add them before running' } };
    const gate = claimGate(job);
    if (!gate.allowed) {
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'runner', text: `run refused: ${gate.reason}` });
      return { status: 403, body: { error: 'forbidden', reason: gate.reason } };
    }
    if (!roomFor(job, { rc, items: bl.items, ledger })) return { status: 409, body: { error: 'runner at capacity \u2014 finish or wait for the running session' } };
    if (await liveSessionTakesIt(job)) return { status: 409, body: { error: 'a session for this card is still running, so no second one was started (the card devlog says why)' } };
    let launched;
    try { launched = await launchJob(job); }
    catch (e) {
      // Phase C rejoin authorization fix round: same as runnerTick - a
      // post-spawn bookkeeping failure means the session already spawned
      // (M7); record the ledger entry anyway instead of propagating this as
      // a failure, so a second "Run now" on the same card is refused as
      // already running rather than launching a second session.
      if (e?.code === 'LAUNCH_POST_SPAWN_FAILED' && e.launched) {
        reportMiss('runner-run-now-post-spawn', `${id}: recording the ledger anyway - ${e.message}`);
        launched = e.launched;
      } else if (e?.code === 'TEST_GUARD_REFUSED' || e?.code === 'WORKTREE_REFUSED') {
        // the test-write guard's refusal is a named
        // 409, not a 500; any other launch failure propagates as before.
        return { status: 409, body: { error: 'launch refused', reason: e.message } };
      } else {
        throw e;
      }
    }
    const { target, pid, launchId, worktree, actor, route, sessionId } = launched;
    writeLedgerEntry(id, { pid: pid ?? null, launchId: launchId ?? null, startedAt: Date.now(), target, retries: 0, worktree: worktree ?? null, actor, route, ...headlessLedgerFields(launched), ...recordLaunchSession(id, sessionId, target, worktree) });
    broadcastBacklog();
    return { status: 200, body: { id, target, state: 'in_progress' } };
  }

  // Reopen by reply (D27 C2, Task 7 - reopenBranch's branches b and c):
  // relaunch a non-running ticket now, resuming its session when `resume` is
  // given. Capacity is checked here; the Task 8 SCUT caller evicts a parked
  // job first when it can.
  //
  // the session is recorded through recordLaunchSession
  // (the same guarded recordLaunchSessionSafe path every other launch uses),
  // never a direct ledger-literal `sessionId: resume?.sessionId ?? null` -
  // that would write `null` for a fresh (branch c) relaunch and never touch
  // the card. `resumeOf` is set independent of that guard: it names what this
  // relaunch WAS attempting (or null for a fresh one), and stays correct even
  // if the card write itself fails and recordLaunchSession's patch is empty.
  async function relaunchJobNow(id, { resume = null, note = '', reason = null, source = undefined } = {}) {
    const { rc, bl, ledger } = reconcileNow();
    const job = bl.items.find((i) => i.id === id);
    if (!job) return { ok: false, reason: 'card not found' };
    // runJobNow refuses when ledger[id] exists
    // ('already running'); relaunchJobNow had no equivalent, and its capacity
    // count below deliberately excludes `id` - so a surviving ledger entry (a
    // stale liveness probe reconcileNow did not reap) let a relaunch overwrite
    // ledger[id] and start a SECOND claude session in the same worktree.
    // the parked exception round 1 carved out here is
    // dropped - reopenBranch's own branch a already handles a parked entry
    // (deliver the message directly, never relaunch), so any ledger entry
    // still present for this id, parked or not, means relaunchJobNow is not
    // the right action. Matches runJobNow's own guard exactly.
    if (ledger[id] || launching.has(id)) return { ok: false, reason: 'already running' };
    if (job.quarantined) return { ok: false, reason: 'card is poison-quarantined; approve it on the board first' };
    const gate = claimGate(job);
    if (!gate.allowed) return { ok: false, reason: gate.reason };
    // `code` is a stable, machine-checkable name for this ONE refusal -
    // scutRelaunch's eviction decision below used
    // to compare `reason` against this exact prose, which silently stops
    // evicting the moment the wording changes for any other reason (a
    // clearer message, a translation). The other refusals above are read
    // only by humans (thread replies, devlog), so they stay reason-only.
    if (!roomFor(job, { rc, items: bl.items, ledger, except: id })) return { ok: false, code: 'at-capacity', reason: 'the runner is at capacity' };
    const taken = await liveSessionTakesIt(job, { note, source });
    if (taken === 'blocked') return { ok: false, code: 'session-would-not-close', reason: 'its idle session would not close' };
    if (taken) return { ok: true, adopted: true };
    backlogStore.updateItemIn(P.stateDir, id, { state: 'in_progress' });
    const fresh = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
    let launched;
    try { launched = await launchJob(fresh, { resume, reopen: { note, reason, source } }); }
    catch (e) {
      // Phase C final review, M7 (second half): the session already spawned
      // before a bookkeeping write past it failed - record the launch
      // anyway (fall through to the ledger write below) rather than rolling
      // back to idle with a real session running unrecorded.
      if (e?.code === 'LAUNCH_POST_SPAWN_FAILED' && e.launched) {
        reportMiss('relaunch-post-spawn', `${id}: recording the ledger anyway - ${e.message}`);
        launched = e.launched;
      } else {
        // Phase C final review, M7 (first half): restore only the fields
        // THIS call's own state transition touched (state, plus whatever
        // stampDone (backlog-store.js) recomputed going into 'in_progress' -
        // idleSince/doneAt/stateEnteredAt/updatedAt), applied onto the
        // CURRENT card - never the whole stale `job` snapshot spliced back
        // in, which also discarded any OTHER
        // field that changed on the card while launchJob was running (a
        // devlog line from the slack-channel-launch-plan branch, say).
        // stampDone itself always re-stamps on ANY state-changing
        // updateItemIn call regardless of what the patch asks for (it is not
        // in PATCHABLE at all), so the rollback writes these fields directly
        // rather than going back through updateItemIn, which would re-stamp
        // AGAIN for the rollback's own transition.
        const cur = backlogStore.load(P.stateDir);
        const items = cur.items.map((i) => (i.id === id
          ? { ...i, state: job.state, idleSince: job.idleSince ?? null, doneAt: job.doneAt ?? null, stateEnteredAt: job.stateEnteredAt ?? null, updatedAt: Date.now() }
          : i));
        backlogStore.save(P.stateDir, { ...cur, items });
        return { ok: false, reason: `launch failed: ${e?.message ?? e}` };
      }
    }
    const t = Date.now();
    writeLedgerEntry(id, {
      pid: launched.pid ?? null, launchId: launched.launchId ?? null, startedAt: t, target: launched.target, retries: 0, worktree: launched.worktree ?? null,
      actor: launched.actor, route: launched.route, reopenedTs: t, resumeOf: resume?.sessionId ?? null, ...headlessLedgerFields(launched),
      ...recordLaunchSession(id, launched.sessionId, launched.target, launched.worktree),
    });
    broadcastBacklog();
    return { ok: true };
  }

  // This is the actuation edge for routing model C: an @mention in Slack becomes
  // either a launched job or a steer of the session already bound to that
  // thread, and the outcome comes back into the room it came from. Everything
  // above this point in server/lib/scut/ is inert without it.
  //
  // Opt-in and fail-soft by construction: no credentials, GLMPS_SCUT=off, or
  // config.json scut.enabled=false and it never starts. A bad token, a Slack
  // outage, or a dropped socket can never take the dashboard down - every edge
  // below swallows its own errors.
  //
  // The launch and steer seams are closures HERE on purpose: launchJob/runJobNow
  // are private to startServer() and are not exported, so a module under
  // lib/scut/ cannot reach them. Injecting them keeps the routing logic itself
  // pure and unit-tested (lib/scut/router.js) while the I/O stays in one place.
  function startScut() {
    if (String(env.GLMPS_SCUT ?? '').toLowerCase() === 'off') return null;
    if (cfg.scut?.enabled === false) return null;
    let creds = null;
    try { creds = scutLoadCreds({ env }); } catch { return null; }
    if (!creds?.botToken || !creds?.appToken) return null; // never provisioned

    const roomOpts = { file: scutRoomsPath(P.stateDir, env) };
    const channelOpts = { file: scutChannelsPath(P.stateDir, env), table: projectTable };
    // The channel-id -> ticket-id map. Separate from channelOpts on purpose:
    // that one answers "which project is this channel about", this one answers
    // "which single session owns this channel", and only the second decides
    // whether an inbound message is an instruction.
    const ticketChannelOpts = { file: scutTicketChannelsPath(P.stateDir, env) };
    const pendingReopenOpts = { file: scutPendingReopensPath(P.stateDir, env) };
    const ticketChannelsOn = cfg.scut?.ticketChannels !== false;
    // "rejoin it" is only true once the operator has
    // actually wired rejoin-reopens (member_joined_channel + cfg.scut.
    // rejoinReopens) - naming it otherwise promises something that silently
    // does nothing. Shared by the close-verb line and scutReleasePark's own
    // close post below; closingSummary takes the same flag directly.
    const scutHowToReopen = () => (cfg.scut?.rejoinReopens === true ? 'reply in it, or rejoin it,' : 'reply in it');
    const settingsOpts = { file: env.SCUT_SETTINGS_FILE || path.join(P.stateDir, 'scut-settings.json') };
    // Re-resolved per post, so flipping Bob mode OR publishing an avatar set
    // takes effect on the next message without a restart.
    const getTheme = () => scutResolveTheme(
      scutGetBobMode(settingsOpts),
      { avatarBaseUrl: scutGetAvatarBaseUrl({ ...settingsOpts, env }), projectSystems: scutGetProjectSystems(settingsOpts) },
    );
    const web = createSlackWeb({ token: creds.botToken });
    // Relayed messages go out through a per-room queue so a body split across
    // several messages arrives in order, and two devlogs seconds apart cannot
    // interleave. A failed post is LOGGED, never swallowed: the empty .catch()
    // this replaces meant a message that never reached Slack left no trace
    // anywhere, which reads exactly like the agent saying nothing at all.
    const relayQueue = scutCreateRelayQueue({
      onError: (e) => console.warn('SCUT relay post failed: ' + (e?.message ?? e)),
    });
    // apps.connections.open authenticates with the APP-level token, not the bot
    // token, so the Socket Mode client gets its own.
    const appWeb = createSlackWeb({ token: creds.appToken });
    // The canonical 2.0 project, not this checkout's folder name: a worktree
    // or the pre-cutover 1.0 folder would otherwise file mentions into a
    // column named after whichever directory happens to be running.
    const defaultProject = projectTable.target;

    // Channel id -> name, cached. Refetched once on a miss so a channel created
    // after boot is still findable without restarting the server.
    let channelNames = null;
    async function lookupChannel(match) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!channelNames) {
          const list = await web.conversationsList();
          channelNames = new Map((list.channels || []).map(c => [c.id, c.name]));
        }
        const hit = match(channelNames);
        if (hit) return hit;
        channelNames = null; // miss: drop the cache and try one fresh listing
      }
      return null;
    }
    async function rollupChannel() {
      try {
        // Either mode's radar name matches (channels are named once, never
        // renamed); the active theme's name wins if a workspace has both.
        const [preferred, alias] = scutRadarChannelNames(getTheme().bobMode);
        return await lookupChannel((names) => {
          let fallback = null;
          for (const [id, name] of names) {
            if (name === preferred) return id;
            if (name === alias && fallback === null) fallback = id;
          }
          return fallback;
        });
      } catch { return null; }
    }
    // Which project does a mention in this channel target? Channels are named
    // once and never renamed, so a channel created in professional mode keeps a
    // repo-ish name and one created in Bob mode keeps a star-system name. The
    // channel map records EVERY name a project can have at provisioning time,
    // which is what makes both route correctly whatever mode is active now.
    async function projectForChannel(channelId) {
      try {
        const name = await lookupChannel((names) => names.get(channelId) ?? null);
        if (name) {
          // A recorded binding wins, then the static star-system reverse map and
          // the glmps alias (both inside projectForChannelName). A project with
          // no resolvable repo is still returned rather than rewritten to the
          // default: attributing the ticket correctly matters even when the
          // runner cannot find a checkout for it.
          const bound = scutProjectForChannelName(name, { ...channelOpts, systems: scutGetProjectSystems(settingsOpts) });
          if (bound) return bound;
          // Fallback: a hand-made channel simply named after a repo. 1.0's
          // checkout still exists on disk, so its name must not count.
          if (!isRetiredProject(name) && repoForProject(name)) return resolveProjectName(name);
        }
      } catch { /* fall through to the default */ }
      return defaultProject;
    }

    async function scutLaunch({ title, prompt, origin }) {
      const project = await projectForChannel(origin?.channel);
      // addItem dedupes on (project, title, source) across OPEN tickets, so two
      // different threads asking for the same thing would collide onto a single
      // ticket and the second launch would 409 "already running". Give the
      // second thread its own ticket: one room owns exactly one job.
      // CLOSED_STATES is backlogStore's own export: this mirror
      // must not keep its own copy, the same class of drift that let
      // nightly-exec.js's FINISHED set fall out of sync with queue-runner.js's.
      const clash = backlogStore.load(P.stateDir).items.some(
        i => i.project === project && i.title === title && i.source === 'scut' && !backlogStore.CLOSED_STATES.has(i.state));
      const r = backlogStore.addItemTo(P.stateDir, {
        project,
        title: clash ? `${title} (thread ${origin?.thread_ts})` : title,
        prompt,
        source: 'scut',
        origin,
        actor: origin?.user ? `slack:${origin.user}` : null,
      }, {
        // A mention only reaches here after engine.onEvent ran the SCUT guard
        // (lib/scut/guard.js), a fail-closed match of the sender against the
        // operator's Slack allowlist. That is the same authorization the
        // dashboard has, over a different transport, so the text is
        // operator-authored, not external. Without this, `source:'scut'` fell
        // to external trust and every mention carrying a link or an ordinary
        // "remember that ..." was quarantined and needed a manual approve
        // before anything could run (operator-reported, glmps-49).
        // Critical flags still quarantine regardless of trust, so an
        // allowlisted sender relaying injected text is still held.
        trust: 'operator',
      });
      broadcastBacklog();
      // Poison gate: a quarantined ticket never auto-launches. The operator has
      // to review and approve it first, exactly as for the runner and Run now.
      // Exactly 'quarantined': router.js matches this token to attach the
      // approve URL. Any other string falls through to its generic
      // "filed, not started yet" reply and the operator loses the release path.
      if (r.item.quarantined) return { id: r.item.id, note: 'quarantined' };
      // Capacity path: a parked session is standby, not a lease. If every slot
      // is held and at least one is merely parked, release the oldest parked
      // one to make room (decision 3, spec 2026-07-31-scut-parked-sessions).
      try {
        const rc = runnerStore.loadConfig(P.stateDir);
        const ledger = runnerStore.loadLedger(P.stateDir);
        if (!roomFor(r.item, { rc, items: backlogStore.load(P.stateDir).items, ledger })) {
          const victim = parkPickEviction(ledger);
          if (victim) await scutReleasePark(victim, { kind: 'evict', newId: r.item.id, to: 'idle' });
        }
      } catch (e) { reportMiss('scut-evict', e?.message ?? String(e)); }
      const res = await runJobNow(r.item.id);
      // 409 = at capacity or already running: the ticket stays queued and the
      // runner tick claims it later. Not a failure from the room's point of view.
      return { id: r.item.id, note: res.status === 200 ? null : (res.body?.error ?? null) };
    }

    /**
     * Give a freshly filed ticket its own Slack channel and return the room to
     * bind for it. Returns null when ticket channels are off or anything at all
     * goes wrong - the caller then keeps the doorway thread room, so a Slack
     * hiccup costs the nicer surface, never the ticket.
     *
     * Order matters: create, bind the store, THEN post. Binding before the
     * welcome message means a crash between the two leaves a mapped, empty
     * channel (recoverable) rather than a live channel nothing knows about -
     * and a channel nothing knows about is one whose messages would read as
     * brand new requests.
     */
    async function scutOpenTicketChannel(args) {
      try {
        return await scutCreateTicketChannel(args);
      } catch (e) {
        console.warn('SCUT ticket channel: ' + (e?.message ?? e));
        return null;
      }
    }

    // The same, for a caller that has to report WHY (POST
    // /api/backlog/<id>/channel): Slack's own error is thrown, not logged.
    // Null still means ticket channels are off or Slack created nothing.
    async function scutCreateTicketChannel({ ticketId, title, project, origin }) {
      if (!ticketChannelsOn) return null;
      const permalink = origin?.channel && origin?.ts
        ? await web.chatGetPermalink({ channel: origin.channel, message_ts: origin.ts }).then(r => r?.permalink ?? null).catch(() => null)
        : null;
      const plan = scutTicketChannelPlan({ ticketId, title, project, origin, operatorUserId: origin?.user ?? null, permalink });
      // Round 1 review, M2, reworded by Task 11 review carry-in (a),
      // corrected by Task 11 fix round 1: this call is the ONLY place a
      // ticket's channel is ever created, and router.js's bindRoom calls it
      // exactly once, right after `launch` mints an id - but "mints" is not
      // a guarantee of freshness. `launch` is scutLaunch, and scutLaunch's
      // id comes from addItem, which dedups on (project, title, source) and
      // hands back an EXISTING open item instead of minting one when it
      // already has a match. scutLaunch defends against that by appending
      // `(thread ...)` to the title whenever an open match already exists -
      // but that disambiguated title is DETERMINISTIC on the thread's own
      // timestamp, and room-mapper.js prunes room bindings (500 rooms / 30
      // days). Once a thread's room mapping is pruned, router.js treats its
      // next message as fresh and reruns scutLaunch, which reproduces the
      // EXACT SAME disambiguated title it used before - matching the
      // ticket THAT title already created, so addItem's dedup hands that
      // existing (possibly already-channeled) ticket back after all. So
      // name_taken here is treated as a possible self-collision (this
      // ticket's own channel, reached a second time via the room-pruning
      // path above) as well as a genuine collision with an unrelated
      // channel - not swallowed, not retried, just reported and left for
      // the doorway thread to carry the ticket instead (see the module's
      // own doc comment above).
      const created = (await web.conversationsCreate(plan.name))?.channel;
      if (!created?.id) return null;
      channelNames = null; // a new channel invalidates the id->name cache
      scutBindTicketChannel({ channelId: created.id, name: plan.name, ticketId, project, origin }, ticketChannelOpts);
      if (plan.invite) await web.conversationsInvite({ channel: created.id, users: plan.invite }).catch(() => {});
      await scutPostAs(web, 'riker', { channel: created.id, text: plan.welcome }, getTheme()).catch(() => {});
      // The doorway keeps ONE line pointing here, posted at CHANNEL level
      // rather than inside the thread: a flat list of one line per ticket is
      // the index that was missing when several threads ran at once, and
      // putting it in the thread would just duplicate the launch reply.
      await scutPostAs(web, 'riker', { channel: origin.channel, text: plan.indexLine }, getTheme()).catch(() => {});
      return { channel: created.id, thread_ts: null, ticketId, sessionId: null, mentionTs: origin.ts, project, agentId: origin.agentId ?? 'riker' };
    }

    // The steer path is the one place SCUT still scans content itself, because
    // writeSteer has no gate of its own and a steer note is injected straight
    // into a running agent. (Launches do NOT need this: backlog intake scans and
    // quarantines them, with an operator approve route. That is why the inbound
    // guard no longer scans.) Returns a result rather than throwing so the room
    // gets a reason instead of a bare failure reaction.
    function scutSteer(sessionId, note, ctx) {
      const scan = scanText(note);
      if (quarantineDecision({ trust: 'external', severity: scan.severity })) {
        return { ok: false, reason: `flagged by poison-scan (${(scan.flags || []).join(', ') || scan.severity})` };
      }
      writeSteer(P.stateDir, sessionId, { note, from: `slack:${ctx?.user ?? 'unknown'}`, ts: Date.now() });
      return { ok: true };
    }

    const presence = makeScutPresence(web);
    const postToRoom = (agentId, ctx, text) =>
      scutPostAs(web, agentId, { channel: ctx.channel, thread_ts: ctx.thread_ts, text }, getTheme());

    // Operator-approved actions (spec docs/specs/2026-10-17-slack-approved-actions.md).
    // The phrase is read from config.json only; the operator is the same
    // allowlist that stamps a wake note's provenance 'operator'.
    const approvalCfg = scutApprovalsConfig(cfg.approvals || {});
    for (const e of approvalCfg.errors) reportMiss('approvals-registry', e);
    const runRestartAll = makeRestartAllRunner({
      stateDir: P.stateDir,
      getRegistry: () => approvalCfg.registry,
      runApproval: (def, opts) => scutRunApprovalAction(def, opts),
      mergeBusy: () => mergeJobs.size > 0,
      readTreeId: () => readAppTreeId(REPO_ROOT),
      appIsStale,
      readHead: (dir) => readRepoHead(dir),
      checkHealth: scutCheckHealth,
      verifyHealthz: verifyDeployedHealthz,
    });
    const approvals = makeScutApprovals({
      stateDir: P.stateDir,
      getConfig: () => approvalCfg,
      getAllowedUsers: () => scutGetAllowedUsers(settingsOpts),
      findRoomByTicket: (ticketId) => scutFindRoomByTicket(ticketId, roomOpts),
      ticketForChannel: (channelId) => {
        if (!ticketChannelsOn) return null;
        try { return scutTicketForChannel(channelId, ticketChannelOpts); } catch { return null; }
      },
      post: (m) => scutPostAs(web, 'riker', m, getTheme()),
      runAction: (def, opts) => (def.composite ? runRestartAll(def, opts) : scutRunApprovalAction(def, opts)),
      reportMiss,
      onFinished: (run) => {
        const notes = scutFinishedRunNotes({
          ...run,
          items: backlogStore.load(P.stateDir).items,
          hasRoom: (id) => !!scutFindRoomByTicket(id, roomOpts)?.channel,
        });
        for (const n of notes) backlogStore.appendDevLogIn(P.stateDir, n.id, { by: 'approvals', text: n.text });
      },
    });
    registerProducer(() => approvals.alerts());

    // A scut job PARKS at phase end: the agent long-polls POST /api/scut/park
    // and the poll RESPONSE is the delivery channel for the operator's next
    // mention, which is what makes this work for every launch target
    // (antigravity runs no Claude Code hooks, so a steer note would rot).
    // Function declarations on purpose: they hoist, so the router deps below
    // and scutCommands.stop can reference them regardless of ordering.
    const parkWaiters = new Map(); // ticketId -> { resolve } (resolve clears its own timer)
    // parkHoldMs is the single hoisted constant declared above (near
    // claudeCmd), not redeclared here, so this and launchHeader's copy can
    // never drift apart (glmps-40).

    async function scutParkPoll(ticketId) {
      const ledger = runnerStore.loadLedger(P.stateDir);
      const entry = ledger[ticketId];
      const item = backlogStore.load(P.stateDir).items.find((i) => i.id === ticketId) ?? null;
      if (!entry) {
        // Released while the agent was between polls: bookkeeping is done and
        // the agent only signs off. A ticket that was never launched (or is
        // not slack-origin) instead falls back to the close-the-card contract.
        return item?.state === 'done'
          ? { action: 'close', reason: 'released' }
          : { action: 'close', reason: 'not-parkable' };
      }
      if (item?.origin?.via !== 'slack') return { action: 'close', reason: 'not-parkable' };
      const stamped = parkStampPoll(entry, Date.now());
      const taken = parkTakePending(stamped.entry, Date.now());
      ledger[ticketId] = taken.entry;
      runnerStore.saveLedger(P.stateDir, ledger);
      if (taken.response) {
        backlogStore.applyLabelDeltaIn(P.stateDir, ticketId, { removeLabels: ['agent:parked'] });
        broadcastBacklog();
        return scutWakeReply(ticketId, taken.response.note, taken.response.provenance);
      }
      // TTL is enforced at poll arrival (the agent is provably alive here);
      // the tick sweep only has to catch agents that STOPPED polling.
      const parkHours = scutGetParkHours(settingsOpts);
      if (parkHours > 0 && Date.now() - taken.entry.parkedSince > parkHours * 3_600_000) {
        const to = scutReleaseTarget({ reason: 'ttl', gateStatus: item?.gate?.status ?? null });
        await scutReleasePark(ticketId, { kind: 'ttl', to });
        return { action: 'close', reason: 'ttl' };
      }
      if (stamped.firstPark) {
        backlogStore.applyLabelDeltaIn(P.stateDir, ticketId, { labels: ['agent:parked'] });
        broadcastBacklog();
        const room = scutFindRoomByTicket(ticketId, roomOpts);
        if (room) {
          const verdict = item?.gate?.status ?? 'no gate recorded';
          // Phase C final review, M6: a named miss, not a swallowed catch -
          // the operator never otherwise learns this park announcement did
          // not land.
          postToRoom(room.agentId ?? 'riker', { channel: room.channel, thread_ts: room.thread_ts },
            `phase done (gate ${verdict}) - parked for follow-ups: reply here to continue in this session, ` +
            `\`stop ${ticketId}\` to pause it, or \`close ${ticketId}\` to close it. Pauses after ${parkHours || 'no'}h idle; a reply resumes it.`,
          ).catch((e) => reportMiss('scut-park-announce', `${ticketId}: ${e?.message ?? e}`));
        }
      }
      // Hold the response until a wake/close arrives or the hold expires.
      const prev = parkWaiters.get(ticketId);
      if (prev) prev.resolve({ action: 'wait' });
      return await new Promise((resolve) => {
        const timer = setTimeout(() => { parkWaiters.delete(ticketId); resolve({ action: 'wait' }); }, parkHoldMs);
        parkWaiters.set(ticketId, {
          resolve: (v) => { clearTimeout(timer); parkWaiters.delete(ticketId); resolve(v); },
        });
      });
    }

    // Wake from the router: scan first (steer parity, this text goes straight
    // into a live agent), then deliver through the held poll or queue for the
    // next one. No steer note is EVER written for a parked session, which is
    // what keeps delivery single-consumer (the hook would double-deliver).
    function scutParkWake(ticketId, text, ctx) {
      const scan = scanText(text);
      if (quarantineDecision({ trust: 'external', severity: scan.severity })) {
        return { ok: false, reason: `flagged by poison-scan (${(scan.flags || []).join(', ') || scan.severity})` };
      }
      const note = `${text}\n\n(from ${ctx?.user ? `slack:${ctx.user}` : 'slack'}, thread ${ctx?.thread_ts ?? '?'})`;
      const provenance = scutNoteProvenance({ user: ctx?.user, allowedUsers: scutGetAllowedUsers(settingsOpts) });
      const ledger = runnerStore.loadLedger(P.stateDir);
      const entry = ledger[ticketId];
      if (!parkIsParked(entry)) return { ok: false, reason: 'not parked' };
      const waiter = parkWaiters.get(ticketId);
      if (waiter) {
        ledger[ticketId] = parkBankStretch(entry, Date.now());
        runnerStore.saveLedger(P.stateDir, ledger);
        backlogStore.applyLabelDeltaIn(P.stateDir, ticketId, { removeLabels: ['agent:parked'] });
        broadcastBacklog();
        waiter.resolve(scutWakeReply(ticketId, note, provenance));
      } else {
        ledger[ticketId] = parkQueueNote(entry, note, provenance);
        runnerStore.saveLedger(P.stateDir, ledger);
      }
      return { ok: true };
    }

    // A mention that lands while the job is STARTING (ticket bound, session not
    // yet). Same scan as wake/steer, then stash it on the ledger entry so the
    // agent's first park poll delivers it. Before glmps-42 this text
    // was simply dropped. A slack job also owns a channel now, which replays the
    // thread from its root, so this can double-deliver a message the channel
    // already carried - deliberately preferred to losing it.
    function scutQueueForTicket(ticketId, text, ctx) {
      const scan = scanText(text);
      if (quarantineDecision({ trust: 'external', severity: scan.severity })) {
        return { ok: false, reason: `flagged by poison-scan (${(scan.flags || []).join(', ') || scan.severity})` };
      }
      const ledger = runnerStore.loadLedger(P.stateDir);
      const entry = ledger[ticketId];
      if (!entry) return { ok: false, reason: 'that job is not running yet' };
      const note = `${text}\n\n(from ${ctx?.user ? `slack:${ctx.user}` : 'slack'}, thread ${ctx?.thread_ts ?? '?'})`;
      const provenance = scutNoteProvenance({ user: ctx?.user, allowedUsers: scutGetAllowedUsers(settingsOpts) });
      ledger[ticketId] = parkQueueNote(entry, note, provenance);
      runnerStore.saveLedger(P.stateDir, ledger);
      return { ok: true };
    }

    // What the park reply for a wake note is. Default is today's tool-result
    // wake. With scut.wakeHandoff on, a note the server stamped as the operator's
    // ends the park instead ({action:'handoff'}) and the session is resumed with
    // the note, so it reaches the session as a user turn, not a tool result the
    // auto-mode classifier cannot read as intent. Default OFF: see scutHandoff.
    function scutWakeReply(ticketId, note, provenance) {
      let sessionId = null;
      try {
        const item = backlogStore.load(P.stateDir).items.find((i) => i.id === ticketId);
        sessionId = item?.runSession?.sessionId ?? runnerStore.loadLedger(P.stateDir)[ticketId]?.sessionId ?? null;
      } catch { /* no session id: the decision falls back to tool-result */ }
      const handoffEnabled = cfg.scut?.wakeHandoff === true;
      if (scutDecideWakeDelivery({ provenance, handoffEnabled, sessionId }) !== 'handoff') return withWakeSkills({ action: 'wake', note, provenance }, loadSkillCues(REPO_ROOT));
      scutHandoff(ticketId, note, sessionId).catch((e) => reportMiss('scut-handoff', `${ticketId}: ${e?.message ?? e}`));
      return { action: 'handoff' };
    }

    // Finish a handoff: wait for the old session to stop being live (it was told
    // to end its turn), drop its ledger entry, then resume it with the note via
    // the same relaunch the reopen-by-reply path uses. If the old process is
    // still live after the wait, or the relaunch fails, the note goes back on
    // the ledger as an ordinary queued note and the thread is told, so it is
    // never lost silently. An interactive session ends its turn but does not
    // exit, so on those launches the wait usually times out; that is why the
    // flag defaults off.
    async function scutHandoff(ticketId, note, sessionId) {
      const waitMs = Number(env.SCUT_HANDOFF_WAIT_MS ?? 120_000);
      const stepMs = Number(env.SCUT_HANDOFF_POLL_MS ?? 1000);
      const live = () => { try { return sessionSummaries().some((s) => s.id === sessionId && s.live); } catch { return true; } };
      const deadline = Date.now() + waitMs;
      while (live() && Date.now() < deadline) await new Promise((r) => setTimeout(r, stepMs));
      const fail = async (why) => {
        const ledger = runnerStore.loadLedger(P.stateDir);
        if (ledger[ticketId]) { ledger[ticketId] = parkQueueNote(ledger[ticketId], note, 'external'); runnerStore.saveLedger(P.stateDir, ledger); }
        backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: `wake handoff did not complete: ${why}; the operator reply is queued for the session` });
        const room = scutFindRoomByTicket(ticketId, roomOpts);
        if (room) await postToRoom(room.agentId ?? 'riker', { channel: room.channel, thread_ts: room.thread_ts }, `could not hand your reply to the session (${why}). It is queued; if the session is still open, say it there too.`).catch((e) => reportMiss('scut-handoff', `${ticketId}: ${e?.message ?? e}`));
      };
      if (live()) return fail('the old session is still open after being told to stop');
      const ledger = runnerStore.loadLedger(P.stateDir);
      const prior = ledger[ticketId];
      if (!prior) return; // released while waiting: the release path owns the card now
      delete ledger[ticketId];
      runnerStore.saveLedger(P.stateDir, ledger);
      const r = await scutRelaunch(ticketId, { resume: { sessionId }, note, reason: null });
      if (!r.ok) {
        const back = runnerStore.loadLedger(P.stateDir);
        if (!back[ticketId]) { back[ticketId] = prior; runnerStore.saveLedger(P.stateDir, back); }
        return fail(`relaunch refused: ${r.reason}`);
      }
      scutClearRoomSessions(ticketId);
      backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: 'operator reply delivered as a user turn by resuming the session' });
      scut?.ticketStateChanged?.({ item: { id: ticketId, state: 'in_progress' } });
    }

    function scutClearRoomSessions(ticketId) {
      try {
        for (const room of scutListRooms(roomOpts)) {
          if (room.ticketId === ticketId) scutBindRoom({ channel: room.channel, thread_ts: room.thread_ts, sessionId: null }, roomOpts);
        }
      } catch (e) { reportMiss('scut-reopen-clear', `${ticketId}: ${e?.message ?? String(e)}`); }
    }

    // Every way a park ends funnels here: stop, eviction, TTL, stale agent,
    // gate-but-never-parked, reopen-unconfirmed, and the close verb. D27: the
    // card goes to `to` (idle unless releaseTarget said done), the thread is
    // told once, and a failed post is RETURNED so the sweep loop's checker
    // fails the run (a silent release is what D27 was filed about).
    const RELEASE_WHY = {
      stop: (o) => `paused from Slack by ${o.by ?? 'operator'}`,
      close: (o) => `closed from Slack by ${o.by ?? 'operator'}`,
      evict: (o) => `paused to make room for ${o.newId ?? 'a new job'}`,
      ttl: () => `idle for ${scutGetParkHours(settingsOpts)}h`,
      stale: () => `no poll and no activity from the session for ${scutStaleMs / 60_000} minutes`,
      'gated-unparked': () => 'gate recorded but the session never parked',
      'reopen-unconfirmed': () => 'no sign of life 15 minutes after the relaunch',
    };
    async function scutReleasePark(ticketId, { kind, by = null, newId = null, to = 'idle' } = {}) {
      const ledger = runnerStore.loadLedger(P.stateDir);
      if (!ledger[ticketId]) return { released: false, to, posted: false, error: 'not in the ledger' };
      const why = (RELEASE_WHY[kind] ?? (() => `released (${kind})`))({ by, newId });
      // The card lands in its real end state BEFORE the ledger entry is
      // dropped. idle and done are both FINISHED
      // (queue-runner.js), so if the process dies right here, the next
      // reconcileLedger pass already knows to drop a stale ledger entry for
      // a FINISHED card - the same rule that already drops an archived one
      // (see "reconcile treats archived as finished" in
      // queue-runner.test.js). Reversing this order would instead leave the
      // card stuck in_progress with no ledger entry at all and nothing left
      // to recover it: no sweep, no reconcile pass, ever looks at an id that
      // is not in the ledger.
      if (to === 'done') {
        backlogStore.updateItemIn(P.stateDir, ticketId, { state: 'done' });
        backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: `closed: ${why}` });
      } else {
        backlogStore.releaseToIdleIn(P.stateDir, ticketId, { kind, why });
        backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: `paused: ${why}` });
      }
      backlogStore.applyLabelDeltaIn(P.stateDir, ticketId, { removeLabels: ['agent:parked'] });
      delete ledger[ticketId];
      runnerStore.saveLedger(P.stateDir, ledger);
      parkWaiters.get(ticketId)?.resolve({ action: 'close', reason: kind });
      broadcastBacklog();
      let posted = false; let error = null;
      const room = scutFindRoomByTicket(ticketId, roomOpts);
      if (!room) error = 'no Slack room bound to this ticket';
      else {
        // The Slack `close` verb (kind 'close') folds the hide-and-reopen
        // hint into this SAME post - one message per close, not two - so
        // commands.close skips its own announcement for a still-parked
        // ticket entirely once this one lands (see commands.close below).
        // A ttl-with-PASS-gate auto-close also reaches `to === 'done'` here
        // but has nothing to reopen from a chat command, so it keeps the
        // plain line.
        const line = to === 'done'
          ? `Closed (${why}).${kind === 'close' ? ` Its channel is hidden next; ${scutHowToReopen()} to reopen.` : ''}`
          : `Paused (${why}). Reply here to resume this session.`;
        try { await postToRoom(room.agentId ?? 'riker', { channel: room.channel, thread_ts: room.thread_ts }, line); posted = true; }
        catch (e) { error = `thread post failed: ${e?.message ?? e}`; reportMiss('scut-release', `${ticketId}: ${error}`); }
      }
      // AFTER the post: a hide removes the operator from the channel (C3).
      try { scut?.ticketStateChanged?.({ item: { id: ticketId, state: to } }); }
      catch (e) { reportMiss('scut-visibility', `${ticketId}: channel update failed: ${e?.message ?? e}`); }
      return { released: true, to, posted, error };
    }

    // D27's one automatic close: an idle card with a PASS gate nobody
    // answered. Reloads the card fresh before acting: a stale or overlapping sweep, or an operator reopening the card
    // mid-sweep, must not re-close or double-post a card - only one still
    // idle with a PASS gate right now is actually closed. Everything below
    // the guard is unreachable unless that is true.
    async function scutCloseIdle(ticketId) {
      const card = backlogStore.load(P.stateDir).items.find((i) => i.id === ticketId);
      if (!card || card.state !== 'idle' || card.gate?.status !== 'PASS') return { closed: false, posted: false, error: null };
      backlogStore.updateItemIn(P.stateDir, ticketId, { state: 'done' });
      backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: `closed: PASS gate unanswered for ${scutGetParkHours(settingsOpts)}h` });
      broadcastBacklog();
      const room = scutFindRoomByTicket(ticketId, roomOpts);
      let posted = false; let error = room ? null : 'no Slack room bound to this ticket';
      if (room) {
        try { await postToRoom(room.agentId ?? 'riker', { channel: room.channel, thread_ts: room.thread_ts }, `Closed (PASS gate, no reply for ${scutGetParkHours(settingsOpts)}h). Reply here to reopen.`); posted = true; }
        // folded into the scut-close route (same failure class as the
        // operator-driven close below), the idle auto-close context and
        // ticket id in the reason text.
        catch (e) { error = `thread post failed: ${e?.message ?? e}`; reportMiss('scut-close', `${ticketId} (idle auto-close): ${error}`); }
      }
      // AFTER the post, mirroring scutReleasePark: a hide removes the
      // operator from the channel (C3), and must never itself break the close.
      try { scut?.ticketStateChanged?.({ item: { id: ticketId, state: 'done' } }); }
      catch (e) { reportMiss('scut-visibility', `${ticketId}: channel update failed: ${e?.message ?? e}`); }
      return { closed: true, posted, error };
    }

    const parkSweepLoop = createScutParkSweepLoop({
      loadLedger: () => runnerStore.loadLedger(P.stateDir),
      saveLedger: (l) => runnerStore.saveLedger(P.stateDir, l),
      loadItems: () => backlogStore.load(P.stateDir).items,
      // Built once per sweep/check, not once per
      // ledger entry: sessionSummaries() walks every session and stats its
      // transcript, and re-loading the whole backlog per entry was a second,
      // needless disk read every time the sweep asked about one more id.
      activityTs: (items) => {
        const summaries = sessionSummaries();
        const byId = new Map(items.map((i) => [i.id, i]));
        // activityEntryFor (lib/scut/reopen.js) is the one place that decides
        // maker-shaped (ledger entry still has sessionId) vs checker-shaped
        // (ledger entry already gone post-release, falls back to the card's
        // runSession) - both call sites below share this one function so they
        // can never independently drift.
        return (id, entry) => ticketLastActivityMs(id, activityEntryFor(entry, byId.get(id)), summaries);
      },
      parkHours: () => scutGetParkHours(settingsOpts),
      release: (id, opts) => scutReleasePark(id, opts),
      closeIdle: (id) => scutCloseIdle(id),
      now: Date.now,
    });
    const parkSweepHandle = loopRegistry.registerLoop({ ...SCUT_PARK_SWEEP_LOOP, maker: parkSweepLoop.maker, checker: parkSweepLoop.checker });

  function agentSaidFn({ ticketId, kind, text, by } = {}) {
      try {
        const body = String(text ?? '').trim();
        if (!body) return;
        if (by && by !== 'agent') return; // runner/operator noise stays out of the room
        const room = scutFindRoomByTicket(ticketId, roomOpts);
        if (!room) return;
        // Long narration is SPLIT, not cut. This used to be
        // `body.slice(0, 1500)` - a silent mid-word truncation that lost most
        // of every substantial reply (glmps-64/65): on the last
        // thread before this landed, 8 of 10 agent devlogs were over the cap.
        // Slack accepts 40,000 characters per message; the chunker keeps each
        // message well inside that, numbers them when there is more than one,
        // and states any genuine overflow instead of dropping it in silence.
        const chunks = scutSplitRelayText(body);
        // Channel-level rooms have no thread, so the key is the channel alone -
        // the same shape roomKey() uses, so one ticket has exactly one queue
        // and its chunks cannot interleave with another ticket's.
        const key = room.thread_ts ? `${room.channel}:${room.thread_ts}` : room.channel;
        chunks.forEach((chunk, i) => {
          const text = kind === 'gate' && i === 0 ? `:checkered_flag: ${chunk}` : chunk;
          relayQueue.run(key, () => scutPostAs(web, room.agentId || 'riker', {
            channel: room.channel,
            thread_ts: room.thread_ts,
            text,
          }, getTheme()));
        });
      } catch { /* never break the route that called us */ }
  }

    // Progress check-ins into the thread (glmps-74, operator ask).
    // Fires on TASK boundaries, throttled, and posts nothing at all when the
    // job declared no plan - there is no honest denominator then, and a made-up
    // percentage would just train the operator to ignore the panel.
    const scutProgressThrottleMs = Number(env.SCUT_PROGRESS_THROTTLE_MS ?? 5 * 60_000);

    function scutProgressTick() {
      try {
        const tracked = scutReadProgress(P.stateDir);
        if (!Object.keys(tracked).length) return;
        const ledger = runnerStore.loadLedger(P.stateDir);
        const now = Date.now();

        for (const [id, rec] of Object.entries(tracked)) {
          const entry = ledger[id];
          if (!entry || !rec?.plan) continue;
          const root = entry.worktree?.dir || repoForProject(entry.project) || REPO_ROOT;
          let text;
          try { text = fs.readFileSync(path.resolve(root, rec.plan), 'utf8'); }
          catch { continue; }   // a plan not written yet, or a bad path: say nothing

          const next = planProgress(text);
          const decision = progressCheckIn({ prev: rec.posted ?? null, next, now, throttleMs: scutProgressThrottleMs });
          if (!decision.due) continue;

          const startedAt = Number.isFinite(entry.startedAt) ? entry.startedAt : null;
          const line = formatCheckIn(next, { elapsedMs: startedAt ? now - startedAt : undefined });
          agentSaidFn({ ticketId: id, kind: 'progress', text: line, by: 'agent' });

          scutRecordPosted(P.stateDir, id, { currentTask: next.currentTask, complete: next.complete, postedTs: now });
        }
      } catch { /* a check-in is a courtesy; it must never break the runner tick */ }
    }

    // Reopen by reply (D27 C2, Task 8). Deps are the existing park, queue and
    // runner seams; scutRelaunch evicts the oldest parked job first when the
    // runner is full, exactly as a new Slack launch does (scutLaunch, above).
    //
    // relaunchJobNow itself already refuses (already
    // running, quarantined, gate) BEFORE its own capacity check, and neither
    // of those refusals mutates anything - so trying it once, FIRST, and only
    // evicting when the refusal is specifically capacity, means a doomed
    // reopen (any of the other refusals) never costs a parked job its slot.
    // The second call after eviction re-runs those same checks for free.
    // keyed on relaunchJobNow's `code`, not on
    // matching its `reason` prose verbatim - a reason string is written to be
    // read by an operator, not compared by a caller, and a wording edit would
    // otherwise silently turn this into "never evict" or "always evict".
    async function scutRelaunch(id, opts) {
      const first = await relaunchJobNow(id, opts);
      if (first.ok || first.code !== 'at-capacity') return first;
      try {
        const ledger = runnerStore.loadLedger(P.stateDir);
        const victim = parkPickEviction(Object.fromEntries(Object.entries(ledger).filter(([k]) => k !== id)));
        if (victim) await scutReleasePark(victim, { kind: 'evict', newId: id, to: 'idle' });
      } catch (e) { reportMiss('scut-evict', e?.message ?? String(e)); }
      return await relaunchJobNow(id, opts);
    }
    const reopenLoop = createScutReopenLoop({
      loadItem: (id) => backlogStore.load(P.stateDir).items.find((i) => i.id === id) ?? null,
      loadLedger: () => runnerStore.loadLedger(P.stateDir),
      isParked: (e) => parkIsParked(e),
      // named rather than a bare fail-false.
      isSessionLive: (sid) => { try { return sessionSummaries().some((s) => s.id === sid && s.live); } catch (e) { reportMiss('scut-reopen-live', `${sid}: ${e?.message ?? String(e)}`); return false; } },
      windowStatus: (sid) => { try { return claudeWindows().get(sid)?.status ?? null; } catch (e) { reportMiss('scut-reopen-live', `${sid}: ${e?.message ?? String(e)}`); return null; } },
      worktreeExists: (dir) => fs.existsSync(dir),
      // a successful b/c relaunch means the session changed;
      // every room bound to this ticket (the doorway thread, the ticket
      // channel, or both - glmps-92) needs its sessionId cleared so
      // the router's OWN "ticket, no session yet" branch queues a follow-up
      // instead of reading the stale id as still live (or, in a doorway
      // thread with no ticket-channel gate, launching a SECOND ticket).
      // listRooms + a per-room bindRoom (rather than a single
      // findRoomByTicket) is deliberate: a ticket-channel ticket has TWO
      // rooms, and both need clearing, not just whichever one
      // findRoomByTicket prefers.
      // scutClearRoomSessions reports under its own route name
      // (scut-reopen-clear), not folded into scut-reopen-live: a cleared-session
      // failure is a different plumbing step than a liveness check.
      clearSession: (ticketId) => scutClearRoomSessions(ticketId),
      // Keyed on BOTH the ticket id (ticketLastActivityMs's runner-worktree
      // bridge) and the card's recorded session id - a session outside the
      // runner worktree, exactly the case this feature is about, has no
      // worktree.id to bridge through. Reuses this file's ticketLastActivityMs
      // wrapper with a synthetic entry. `claude --resume <id>` keeps the
      // session id, so runSession.sessionId stays the right key across resumes.
      lastActivityTs: (ticketId, { sessionId = null } = {}) => ticketLastActivityMs(ticketId, sessionId ? { sessionId } : null),
      scan: (text) => {
        const s = scanText(text);
        return quarantineDecision({ trust: 'external', severity: s.severity })
          ? { ok: false, reason: `flagged by poison-scan (${(s.flags || []).join(', ') || s.severity})` }
          : { ok: true };
      },
      deliver: async (id, text, ctx) => {
        const entry = runnerStore.loadLedger(P.stateDir)[id];
        const waiting = parkWaiters.has(id);
        const r = parkIsParked(entry) ? scutParkWake(id, text, ctx) : scutQueueForTicket(id, text, ctx);
        if (!r.ok) return r;
        backlogStore.updateItemIn(P.stateDir, id, { state: 'in_progress' });
        broadcastBacklog();
        scut?.ticketStateChanged?.({ item: { id, state: 'in_progress' } });
        return { ok: true, via: parkIsParked(entry) && waiting ? 'waiter' : 'queued' };
      },
      relaunch: async (id, opts) => {
        const r = await scutRelaunch(id, opts);
        if (r.ok) scut?.ticketStateChanged?.({ item: { id, state: 'in_progress' } });
        return r;
      },
      reply: (ctx, text) => postToRoom('riker', ctx, text),
      devlog: (id, text) => backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text }),
      deferReopen: (id, text, ctx) => {
        scutAddPendingReopen(id, { text, ctx }, pendingReopenOpts);
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: 'reply saved: the runner is at capacity; it is delivered when a slot frees' });
      },
      hasPendingReopen: (id) => scutHasPendingReopen(id, pendingReopenOpts),
      now: Date.now,
    });
    const reopenHandle = loopRegistry.registerLoop({ ...SCUT_REOPEN_LOOP, maker: reopenLoop.maker, checker: reopenLoop.checker, onFailed: reopenLoop.onFailed });

    // Replays replies the reopen loop saved for capacity (glmps-2-0-108), one
    // ticket per tick, and reopens only when a relaunch can get a slot (a free
    // one, or a parked session scutRelaunch may evict). Waiting for that keeps
    // a still-full runner from re-saving the reply and posting "waiting" into
    // the thread every tick. Replies go back on disk unless the replay
    // consumed them; after MAX_DRAIN_ATTEMPTS failed replays the words are
    // posted back to the thread and the card devlog instead of looping.
    let drainInFlight = false;
    async function scutDrainPendingReopens() {
      if (drainInFlight) return;
      drainInFlight = true;
      try {
        const pending = scutListPendingReopens(pendingReopenOpts);
        if (!pending.length) return;
        const items = backlogStore.load(P.stateDir).items;
        const ledger = runnerStore.loadLedger(P.stateDir);
        const rc = runnerStore.loadConfig(P.stateDir);
        const next = scutNextDrainAction(pending, {
          stateOf: (id) => items.find((i) => i.id === id)?.state ?? null,
          hasLedger: (id) => Boolean(ledger[id]),
          reopenable: REOPENABLE_STATES,
          canRelaunch: (ticketId) => roomFor(items.find((i) => i.id === ticketId), { rc, items, ledger }) || Boolean(parkPickEviction(ledger)),
        });
        if (!next) return;
        const { ticketId } = next;
        const replies = scutTakePendingReopens(ticketId, pendingReopenOpts);
        if (next.action === 'drop') { reportMiss('scut-reopen-drain', `${ticketId}: card is gone, ${replies.length} saved replies dropped`); return; }
        if (next.action === 'queue') {
          const failed = replies.filter((p) => !scutQueueForTicket(ticketId, p.text, p.ctx).ok);
          scutRestorePendingReopens(ticketId, failed, pendingReopenOpts);
          return;
        }
        const text = replies.map((p) => p.text).join('\n\n---\n\n');
        const ctx = replies.at(-1)?.ctx ?? null;
        const r = await reopenHandle.runNow({ ticketId, text, ctx });
        if (scutDrainConsumed(r)) return;
        const failedRun = String(r?.outcome ?? '').startsWith('failed');
        const tried = replies.map((p) => ({ ...p, attempts: (p.attempts ?? 0) + (failedRun ? 1 : 0) }));
        if (tried.some((p) => p.attempts >= SCUT_MAX_DRAIN_ATTEMPTS)) {
          const why = r?.reason ?? r?.outcome ?? 'unknown';
          backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: `saved reply could not reopen the card after ${SCUT_MAX_DRAIN_ATTEMPTS} tries (${why}); the reply was:\n\n${text}` });
          if (ctx) await postToRoom('riker', ctx, `could not reopen ${ticketId} after ${SCUT_MAX_DRAIN_ATTEMPTS} tries (${why}). Your saved message is on the card devlog; check the board.`);
          return;
        }
        scutRestorePendingReopens(ticketId, tried, pendingReopenOpts);
      } catch (e) { reportMiss('scut-reopen-drain', e?.message ?? String(e)); }
      finally { drainInFlight = false; }
    }

    const router = makeScutRouter({
      getRoom: (channel, thread_ts) => scutGetRoom(channel, thread_ts, roomOpts),
      // Inbound isolation: a channel in the ticket-channel store IS a ticket's
      // conversation, and the router resolves it by ticket rather than by
      // thread. Fail-closed - an unknown channel answers null and keeps the
      // pre-existing thread behaviour.
      ticketForChannel: (channelId) => { try { return ticketChannelsOn ? scutTicketForChannel(channelId, ticketChannelOpts) : null; } catch { return null; } },
      roomForTicket: (ticketId) => { try { return scutFindRoomByTicket(ticketId, roomOpts); } catch { return null; } },
      // Reopen by reply (D27 C2, Task 8): the card's current state, and the
      // registered reopen loop itself. cardState fails closed (null never
      // matches REOPENABLE), and reopen answers in the thread on its own -
      // the router's own reply is only for a failure the loop could not.
      cardState: (ticketId) => { try { return backlogStore.load(P.stateDir).items.find((i) => i.id === ticketId)?.state ?? null; } catch (e) { reportMiss('scut-cardstate', `${ticketId}: ${e?.message ?? String(e)}`); return null; } },
      // whether the in_progress-queue backstop has
      // anything real to queue against. Fails open (assume a slot exists) so
      // an error here falls back to the pre-existing queue attempt rather
      // than blocking it.
      hasLedgerEntry: (ticketId) => { try { return Boolean(runnerStore.loadLedger(P.stateDir)[ticketId]); } catch (e) { reportMiss('scut-hasledger', `${ticketId}: ${e?.message ?? String(e)}`); return true; } },
      reopen: (ticketId, text, ctx) => reopenHandle.runNow({ ticketId, text, ctx }),
      // A launch binds TWO rooms. The doorway thread room is bound FIRST and
      // synchronously, so a second mention arriving while Slack is still
      // creating the channel sees "ticket, no session yet" and queues rather
      // than launching a duplicate. The ticket channel's room is bound after,
      // and findRoomByTicket prefers it, so everything downstream (relay,
      // notify, progress, park release) speaks in the ticket channel.
      bindRoom: async (room) => {
        const bound = scutBindRoom(room, roomOpts);
        if (!room.ticketId) return bound;
        const title = backlogStore.load(P.stateDir).items.find(i => i.id === room.ticketId)?.title ?? room.ticketId;
        const opened = await scutOpenTicketChannel({
          ticketId: room.ticketId,
          title,
          project: room.project,
          origin: { channel: room.channel, thread_ts: room.thread_ts, ts: room.mentionTs, user: room.user ?? null, agentId: room.agentId },
        });
        if (opened) scutBindRoom(opened, roomOpts);
        return opened ?? bound;
      },
      isSessionLive: (id) => { try { return sessionSummaries().some(s => s.id === id && s.live); } catch { return false; } },
      steer: scutSteer,
      launch: scutLaunch,
      reply: postToRoom,
      // Parked-thread wake path: outranks steer inside the router because a
      // parked session's polling reads as live, and steering it would write a
      // note the idle agent never pulls.
      isParked: (ticketId) => { try { return parkIsParked(runnerStore.loadLedger(P.stateDir)[ticketId]); } catch { return false; } },
      wake: (ticketId, text, ctx) => scutParkWake(ticketId, text, ctx),
      // Starting-window mentions are queued, never dropped (glmps-42).
      queue: (ticketId, text, ctx) => scutQueueForTicket(ticketId, text, ctx),
      // A quarantined mention becomes a real ticket the operator can release,
      // so the room gets the approve URL instead of an unexplained refusal.
      approveUrlFor: (ticketId) => `http://127.0.0.1:${actualPort}/api/backlog/${ticketId}/approve`,
      // Images and files attached to the mention. Slack sends METADATA plus an
      // authenticated url_private, never bytes, so "send the attachment along"
      // means downloading it here with the bot token and handing the session a
      // path it can open. This is the one I/O seam; the router calls it once per
      // mention and every delivery branch (launch, steer, wake, queue) reuses
      // the result. Never throws at the router - collectAttachments reports a
      // failed file in the block instead - and the router catches anyway.
      attachments: (ctx) => scutCollectAttachments(ctx.raw, {
        channel: ctx.channel, ts: ctx.ts, token: creds.botToken, env,
      }),
      project: defaultProject,
    });

    const notifier = makeScutNotifier({
      findRoomByTicket: (ticketId) => scutFindRoomByTicket(ticketId, roomOpts),
      post: (agentId, msg, theme) => scutPostAs(web, agentId, msg, theme),
      getTheme,
      getOutbound: () => scutGetOutbound(settingsOpts),
      // The reaction rides the COMPLETION wire, not the launch: presence.done
      // used to fire the moment a job was launched, which on a phone reads as
      // "finished, ignore this".
      presence,
      rollupChannel,
      permalink: async ({ channel, ts }) => {
        try { return (await web.chatGetPermalink?.({ channel, message_ts: ts }))?.permalink ?? null; }
        catch { return null; }
      },
      log: (m) => console.warn('SCUT notify: ' + m),
    });

    let sm = null;
    let stopped = false;
    let scutConnected = false;
    let heartbeat = null;
    let heartbeatTimer = null;
    let connectAttempts = 0;
    let lastConnectError = null;
    let connectSleepTimer = null;
    let connectSleepResolve = null;
    // /api/alerts rides the ONE signal-producer seam, so a deaf socket surfaces
    // on the board with no edit to alerts.js or alert-sources.js.
    registerProducer(() => (scutConnected || stopped ? [] : [{
      source: 'scut',
      severity: 'warn',
      title: 'SCUT is not connected to Slack',
      detail: 'Inbound mentions are being dropped. Outbound posting still works, so the room looks alive.'
        + (connectAttempts > 0 ? ` (connect attempt ${connectAttempts} failed: ${lastConnectError})` : ''),
      target: null,
      ts: Date.now(),
    }]));

    // Chat verbs. `status` is pure presentation over state GLMPS already
    // computes in this same closure. `stop` is deliberately NOT a kill: no
    // process-interrupt primitive exists (glmps-28), and for every
    // non-terminal launch target the pid is null by design, so there is nothing
    // to signal. Holding the card is the honest, safe stop: it blocks relaunch
    // and, unlike `cancelled`, keeps the ledger entry so the worktree is not
    // reclaimed out from under a live agent.
    // Answer an approval gate from a chat message (glmps-29). The
    // agent is BLOCKED in its hook while this runs, so every failure path still
    // has to produce a reply: an operator who typed `approve` and heard nothing
    // will type it again, and the gate is single-decision by design.
    async function decideFromChat(arg, ctx, decision) {
      const id = String(arg ?? '').trim();
      if (!id) {
        await postToRoom('riker', ctx, `which request? say "${decision === 'approved' ? 'approve' : 'deny'} <gate-id>" - the id is in the message asking for it.`);
        return;
      }
      const sessionId = gateSessions.get(id)
        ?? ctlFindGate(P.stateDir, sessionSummaries().map(s => s.id), id)?.sessionId
        ?? null;
      if (!sessionId) { await postToRoom('riker', ctx, `no open request ${id} (it may have already timed out).`); return; }
      const r = ctlDecideGate(P.stateDir, sessionId, id, {
        decision, by: `slack:${ctx?.user ?? 'unknown'}`, reason: null, ts: Date.now(),
      });
      await postToRoom('riker', ctx, r
        ? `${decision === 'approved' ? 'approved' : 'denied'} ${id}.`
        : `${id} was already answered - the first decision stands.`);
    }

    const scutCommands = {
      async status(ctx) {
        let text;
        try {
          const ledger = runnerStore.loadLedger(P.stateDir);
          const ids = Object.keys(ledger);
          const live = sessionSummaries().filter(s => s.live);
          const queued = backlogStore.load(P.stateDir).items.filter(i => i.state === 'queued').length;
          const lines = [`${ids.length} running, ${queued} queued, ${live.length} live session(s).`];
          for (const id of ids.slice(0, 10)) {
            const mins = Math.round((Date.now() - (ledger[id].startedAt ?? Date.now())) / 60000);
            lines.push(`- ${id}: ${mins}m in ${ledger[id].target ?? 'unknown'}`);
          }
          if (!ids.length && !queued) lines.push('Nothing in flight.');
          text = lines.join('\n');
        } catch (e) {
          text = `could not read status (${e?.message ?? e})`;
        }
        await postToRoom('riker', ctx, text);
      },
      async stop(arg, ctx) {
        const id = String(arg ?? '').trim();
        if (!id) { await postToRoom('riker', ctx, 'which job? say "stop <ticket-id>" - `status` lists them.'); return; }
        // A PARKED job has nothing running to halt: stop means release (close
        // the card, free the slot). Only parked-right-now takes this path; a
        // woken session working a later phase gets the normal hold below.
        try {
          const entry = runnerStore.loadLedger(P.stateDir)[id];
          if (parkIsParked(entry)) {
            const r = await scutReleasePark(id, { kind: 'stop', by: ctx?.user ?? 'unknown', to: 'idle' });
            await postToRoom('riker', ctx, r.released
              ? `paused the parked session for ${id}; reply in its channel to resume it.`
              : `could not pause ${id}.`);
            return;
          }
        } catch (e) { reportMiss('scut-stop', `${id}: ${e?.message ?? String(e)}`); }
        try {
          const r = backlogStore.updateItemIn(P.stateDir, id, { state: 'held' });
          if (!r?.item) { await postToRoom('riker', ctx, `no card ${id}.`); return; }
          backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: `held from Slack by ${ctx?.user ?? 'unknown'}` });
          broadcastBacklog();
          // glmps-28. Holding the card only blocks a RELAUNCH; it does
          // nothing to the agent already running. Halting that agent needs the
          // control record, so do both: they are different halves of one intent
          // and neither substitutes for the other. The ledger entry is left
          // alone on purpose - it is what keeps the job's worktree protected
          // (glmps-162), and dropping it here would re-open that data-loss path.
          const room = scutFindRoomByTicket(id, roomOpts);
          const sessionId = room?.sessionId ?? null;
          if (sessionId) {
            ctlSetStop(P.stateDir, sessionId, {
              reason: `stopped from Slack by ${ctx?.user ?? 'unknown'}`,
              from: `slack:${ctx?.user ?? 'unknown'}`, ts: Date.now(),
            });
          }
          await postToRoom('riker', ctx, sessionId
            ? `${id} held, and the running session was told to stop. It halts at its NEXT tool call, ` +
              `so give it a moment; it should post a summary of where it got to.`
            : `${id} held: it will not be relaunched or retried. No live session is bound to this thread, ` +
              `so there was nothing running to halt.`);
        } catch (e) {
          await postToRoom('riker', ctx, `could not hold ${id} (${e?.message ?? e})`);
        }
      },
      // D27: the operator's explicit close. Inside a ticket channel a bare
      // `close` means this channel's ticket; anywhere else it needs an id.
      async close(arg, ctx) {
        const fromChannel = ticketChannelsOn ? scutTicketForChannel(ctx.channel, ticketChannelOpts) : null;
        const id = String(arg ?? '').trim() || fromChannel || scutGetRoom(ctx.channel, ctx.thread_ts, roomOpts)?.ticketId || '';
        if (!id) { await postToRoom('riker', ctx, 'which ticket? say `close <ticket-id>`, or just `close` inside the ticket channel.'); return; }
        const item = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
        if (!item) { await postToRoom('riker', ctx, `no card ${id}.`); return; }
        if (item.state === 'done') { await postToRoom('riker', ctx, `${id} is already closed.`); return; }
        // State change FIRST, announcement second: a Slack hiccup used to
        // block the whole close (the announcement threw before either branch
        // ran) and was only console-logged, never surfaced to the card.
        // One message per close: on the still-parked path, scutReleasePark's
        // own "Closed (...)" post already folds in the hide-and-reopen hint
        // (kind 'close'), so there is nothing left to announce here - post
        // AND return, never falling into the ledger-absent branch's separate
        // announcement below.
        if (runnerStore.loadLedger(P.stateDir)[id]) {
          // scutReleasePark does its own state change, its own guarded,
          // hint-carrying "Closed (...)" post, and its own guarded
          // ticketStateChanged.
          await scutReleasePark(id, { kind: 'close', by: ctx?.user ?? 'unknown', to: 'done' });
          await promoteAfterClose(id, 'was closed from Slack', 'scut');
          return;
        }
        backlogStore.updateItemIn(P.stateDir, id, { state: 'done' });
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: `closed from Slack by ${ctx?.user ?? 'unknown'}` });
        broadcastBacklog();
        try {
          await postToRoom('riker', ctx, `closing ${id}. Its channel is hidden next; ${scutHowToReopen()} to reopen.`);
        } catch (e) {
          const msg = `announcement failed: ${e?.message ?? e}`;
          reportMiss('scut-close', `${id}: ${msg}`);
          backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: `could not notify the channel: ${msg}` });
        }
        // AFTER the post, mirroring scutReleasePark: a hide removes the
        // operator from the channel (C3), which must not swallow the
        // announcement above.
        try { scut?.ticketStateChanged?.({ item: { id, state: 'done' } }); }
        catch (e) { reportMiss('scut-visibility', `${id}: channel update failed: ${e?.message ?? e}`); }
        await promoteAfterClose(id, 'was closed from Slack', 'scut');
      },
      // glmps-2-0-171 D5: the operator's answers to the daily orphan post. A
      // headless card with no open host would run with nobody relaying its
      // questions, so `run` opens it interactively (its own channel at launch).
      async run(ids, ctx) {
        const by = ctx?.user ?? 'unknown';
        const said = [];
        for (const id of ids) {
          const items = backlogStore.load(P.stateDir).items;
          const item = items.find((i) => i.id === id);
          if (!item) { said.push(`no card ${id}.`); continue; }
          if (backlogStore.CLOSED_STATES.has(item.state)) { said.push(`${id} is closed.`); continue; }
          if (item.quarantined) { said.push(`${id} is quarantined; release it from the board first.`); continue; }
          if (runnerStore.loadLedger(P.stateDir)[id]) { said.push(`${id} is already running.`); continue; }
          const reopen = item.mode === 'headless' && !hostOpen(item, items);
          if (reopen) backlogStore.updateItemIn(P.stateDir, id, { mode: 'interactive' });
          backlogStore.applyLabelDeltaIn(P.stateDir, id, { labels: ['agent:backlog'], comment: `requeued from Slack by ${by}` });
          backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: `requeued from Slack by ${by}${reopen ? '; it has no open host, so it opens interactively with its own channel' : ''}` });
          said.push(`${id} requeued${reopen ? ' (interactive: it has no open host)' : ''}.`);
        }
        broadcastBacklog();
        await postToRoom('riker', ctx, said.join('\n'));
      },
      async drop(ids, ctx) {
        const by = ctx?.user ?? 'unknown';
        const said = [];
        for (const id of ids) {
          const item = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
          if (!item) { said.push(`no card ${id}.`); continue; }
          if (backlogStore.CLOSED_STATES.has(item.state)) { said.push(`${id} is already closed.`); continue; }
          backlogStore.updateItemIn(P.stateDir, id, { state: 'cancelled' });
          backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: 'dropped by the operator from Slack' });
          try { scut?.ticketStateChanged?.({ item: { id, state: 'cancelled' } }); }
          catch (e) { reportMiss('scut-visibility', `${id}: channel update failed: ${e?.message ?? e}`); }
          await promoteAfterClose(id, 'was dropped from Slack', 'scut');
          said.push(`${id} dropped.`);
        }
        broadcastBacklog();
        await postToRoom('riker', ctx, said.join('\n'));
      },
      async approve(arg, ctx) { await decideFromChat(arg, ctx, 'approved'); },
      async deny(arg, ctx) { await decideFromChat(arg, ctx, 'denied'); },
      // The launch mode override (unattended reliability T5). Takes effect at
      // the card's next launch or resume; a run in flight keeps its mode.
      async mode({ mode, id: given } = {}, ctx) {
        const fromChannel = ticketChannelsOn ? scutTicketForChannel(ctx.channel, ticketChannelOpts) : null;
        const id = String(given ?? '').trim() || fromChannel || scutGetRoom(ctx.channel, ctx.thread_ts, roomOpts)?.ticketId || '';
        if (mode === undefined || !id) { await postToRoom('riker', ctx, 'say `mode interactive|headless|auto [ticket-id]` (inside the ticket channel the id is optional).'); return; }
        const r = backlogStore.updateItemIn(P.stateDir, id, { mode });
        if (!r?.item) { await postToRoom('riker', ctx, `no card ${id}.`); return; }
        const said = mode ? `set to ${mode}` : `cleared: it runs ${launchMode(r.item, backlogStore.load(P.stateDir).items)} by its lineage`;
        backlogStore.appendDevLogIn(P.stateDir, id, { by: 'scut', text: `launch mode ${said}, from Slack by ${ctx?.user ?? 'unknown'}` });
        broadcastBacklog();
        await postToRoom('riker', ctx, `${id} launch mode ${said}. It applies from the next launch or resume.`);
      },
      async help(ctx) {
        await postToRoom('riker', ctx, [
          'SCUT commands:',
          '- `status` - what is running and queued',
          '- `stop <ticket-id>` - pause the card and tell its running session to halt',
          '- `close [ticket-id]` - close a ticket (inside its channel the id is optional)',
          '- `run <ticket-id>...` / `drop <ticket-id>...` - answer the daily orphan post: requeue a card, or cancel it',
          '- `approve <gate-id>` / `deny <gate-id>` - answer an approval request',
          '- `mode interactive|headless|auto [ticket-id]` - how a card launches (auto: primary cards interactive, the rest headless)',
          '- `bobmode on|off|status` - persona theme',
          'Anything else is an instruction: it launches a session, or steers the one this thread already owns.',
        ].join('\n'));
      },
    };
    // Connect asynchronously: startServer() must not block on Slack, and the bot
    // user id (needed so SCUT cannot answer its own messages) only exists after
    // auth.test answers.
    (async () => {
      // One fetch timeout here used to end the whole startup with no retry.
      // Cancellable sleep so stop() leaves no timer behind.
      const auth = await retryUntilConnected({
        attempt: () => web.authTest(),
        isStopped: () => stopped,
        sleep: (ms) => new Promise((resolve) => {
          connectSleepResolve = resolve;
          connectSleepTimer = setTimeout(() => { connectSleepTimer = null; connectSleepResolve = null; resolve(); }, ms);
          connectSleepTimer.unref?.();
        }),
        onFailure: ({ attempt, error }) => {
          connectAttempts = attempt;
          lastConnectError = error?.message ?? String(error);
          console.warn(`SCUT: connect attempt ${attempt} failed (${lastConnectError}); retrying`);
          reportMiss('scut-connect', `auth.test attempt ${attempt} failed: ${lastConnectError}`);
        },
      });
      if (auth === SCUT_CONNECT_STOPPED || stopped) return;
      connectAttempts = 0;
      clearMiss('scut-connect');
      const engine = createScutEngine({
        getTheme,
        onMention: router,
        onBobToggle: makeScutBobToggle({
          web,
          settings: { getBobMode: () => scutGetBobMode(settingsOpts), setBobMode: (v) => scutSetBobMode(v, settingsOpts) },
          getTheme,
        }),
        presence,
        // Authorization only. Content gating happens downstream at backlog
        // intake, which quarantines and offers an approve route; scanning here
        // as well used to block the ticket from ever existing.
        guard: makeScutGuard({ isAllowed: (u) => scutGetAllowedUsers(settingsOpts).includes(u) }),
        dedup: makeScutDedup(),
        commands: scutCommands,
        approvals,
        botUserId: auth.user_id ?? null,
        // Inside a ticket channel the operator can just type - no @mention.
        // Off until they add `message.channels` to the Slack app's event
        // subscriptions and reinstall; until then no message event arrives, so
        // defaulting it on would only widen a code path with nothing to feed
        // it. Fail-closed twice over: the config flag AND the store lookup.
        isTicketChannel: (channelId) => {
          if (cfg.scut?.channelMessages !== true) return false;
          try { return scutTicketForChannel(channelId, ticketChannelOpts) !== null; } catch { return false; }
        },
        // D27: rejoining a HIDDEN ticket channel reopens the ticket. Opt-in
        // until the Slack app subscribes to member_joined_channel.
        onRejoin: cfg.scut?.rejoinReopens === true ? async (channelId, userId, inviter) => {
          // Phase C final review, I2: check whoever CAUSED the
          // join - the inviter when there is one, the joining user itself
          // for a self-join. The round-1-of-this-fix version
          // (`inviter != null && ...`) skipped the allowlist check entirely
          // whenever inviter was null, so ANY workspace member could reopen
          // a hidden ticket - and launch a session - just by self-joining
          // its still-searchable closed- channel. Checking the joiner alone
          //  does nothing against the OTHER
          // bypass this fix exists for (a non-allowlisted member /inviting
          // an allowlisted operator in), so neither check alone is enough -
          // whoever actually caused the join is the one that must be
          // allowlisted, invite or not.
          if (!scutGetAllowedUsers(settingsOpts).includes(inviter ?? userId)) return;
          const ticketId = scutTicketForChannel(channelId, ticketChannelOpts);
          if (!ticketId) return;
          // a join to a VISIBLE channel reopens nothing -
          // matches the docs ("rejoining a HIDDEN ticket channel..."), and
          // without this every ordinary join to an already-open ticket
          // channel would relaunch it.
          const entry = scutChannelForTicket(ticketId, ticketChannelOpts);
          if (!entry?.hiddenTs) return;
          // an empty note reads oddly in the devlog/thread this reopen
          // produces - name what actually happened instead.
          // Phase C final review, I3: the emit result used to be discarded
          // unawaited - a second rejoin for the same ticket arriving while
          // the first is still mid-run (the loop's own overlap lock) or a
          // genuine failure both vanished silently. Chose reportMiss + a
          // devlog line over a re-emit queue: a queued retry risks firing the
          // reopen loop again after the loop's OWN schedule/dedup would
          // already have settled it, and the operator can always just rejoin
          // (or reply) again if the miss shows the attempt did not land.
          const results = await loopRegistry.emit(SCUT_REOPEN_EVENT, { ticketId, text: '(rejoined the channel)', ctx: { channel: channelId, thread_ts: null, user: userId } });
          const failure = rejoinEmitFailure(results);
          if (failure) {
            reportMiss('scut-reopen-rejoin', `${ticketId}: ${failure}`);
            backlogStore.appendDevLogIn(P.stateDir, ticketId, { by: 'scut', text: `rejoin reopen did not run: ${failure}` });
          }
        } : null,
        reportMiss,
        // glmps-2-0-29: a plain reply in a thread whose session is still open
        // reaches it without an @mention. Open means the router would wake,
        // queue or steer rather than launch: the ticket holds a runner slot
        // and is parked, still starting, or bound to a live session. A thread
        // whose job has ended needs an @ again, so chatter cannot relaunch.
        // Same flag as above: both doors ride the message.channels feed.
        isOpenThread: (channel, thread_ts) => {
          if (cfg.scut?.channelMessages !== true) return false;
          const room = scutGetRoom(channel, thread_ts, roomOpts);
          if (!room?.ticketId) return false;
          const entry = runnerStore.loadLedger(P.stateDir)[room.ticketId];
          if (!entry) return false;
          if (parkIsParked(entry) || !room.sessionId) return true;
          return sessionSummaries().some(s => s.id === room.sessionId && s.live);
        },
        log: (m) => console.warn('SCUT: ' + m),
      });
      sm = createSocketMode({
        web: appWeb,
        onEvent: engine.onEvent,
        log: (m) => console.warn('SCUT: ' + m),
        // A dead inbound socket is invisible otherwise: outbound is plain HTTP
        // and keeps working, so the operator still gets "finished" pings while
        // everything they SEND is dropped. Report it where the dashboard already
        // looks - the degraded-adapter tile and /api/alerts.
        onState: ({ connected, attempt, error }) => {
          scutConnected = connected;
          if (!connected) reportMiss('scut-socket', `slack socket down (attempt ${attempt}${error ? `: ${error}` : ''})`);
        },
      });
      await sm.start();
      console.log(`SCUT: connected as ${auth.user} (team ${auth.team})`);
      // deploy-glmps2 restarts this server mid-run; finish reporting it here.
      approvals.resume().catch((e) => reportMiss('approvals-resume', e?.message ?? String(e)));

      // Host-liveness tripwire. Nothing on a dead machine can raise an alarm
      // about itself, so the alarm is pre-booked in Slack and pushed further
      // out on every beat. Stop beating and Slack delivers it. See
      // lib/scut/heartbeat.js and the spec section on host liveness.
      const minutes = scutGetHeartbeatMinutes(settingsOpts);
      const rollupId = minutes > 0 ? await rollupChannel() : null;
      if (minutes > 0 && rollupId) {
        heartbeat = makeScutHeartbeat({
          web,
          channelId: rollupId,
          intervalMs: minutes * 60 * 1000,
          // What was in flight when the host vanished, so the alarm is
          // actionable rather than merely alarming.
          describeState: () => {
            try {
              const ids = Object.keys(runnerStore.loadLedger(P.stateDir));
              return ids.length ? `in flight: ${ids.join(', ')}` : 'nothing was in flight';
            } catch { return ''; }
          },
          log: (m) => console.warn('SCUT heartbeat: ' + m),
        });
        // Sweep any alarm left booked by a previous crash before arming a new
        // one, or it would fire against a host that is demonstrably alive.
        await heartbeat.reconcile();
        await heartbeat.tick();               // arm now, do not wait a full interval
        // Captured so stop() can clear it: every uncaptured setInterval in this
        // file used to leak one per startServer() call (glmps-8).
        heartbeatTimer = setInterval(() => { heartbeat?.tick?.(); }, minutes * 60 * 1000);
        console.log(`SCUT: host tripwire armed (${minutes}m beat)`);
      } else if (minutes > 0) {
        console.warn('SCUT: host tripwire NOT armed (roll-up channel could not be resolved)');
      }
    })().catch((e) => { console.warn(`SCUT: not connected (${e?.message ?? e})`); });

    return {
      // Fire-and-forget outbound: the runner calls this from reconcileNow and
      // must never wait on, or be broken by, a Slack round trip.
      jobFinished(input) {
        try { Promise.resolve(notifier.jobFinished(input)).catch(() => {}); } catch { /* never throw at the runner */ }
      },
      // The agent's own voice, relayed. Agents already narrate to /devlog and
      // record a verdict at /gate because buildSeedDoc tells them to; this
      // forwards that into the room the ticket came from. Deliberately NOT a
      // Slack-specific endpoint: a second reporting surface would drift from
      // the first, and the agent should speak once, natively.
      agentSaid: agentSaidFn,
      // The operator approved a poison-held ticket (POST /api/backlog/:id/approve).
      // This is the one moment with no job wire to ride - the launch it resumes
      // has produced no devlog/gate/finish traffic yet - so the room that was
      // told "held for review, Approve: <url>" hears directly whether the work
      // actually started.
      ticketReleased({ ticketId, started, note } = {}) {
        try {
          const room = scutFindRoomByTicket(ticketId, roomOpts);
          if (!room) return;
          const text = started
            ? `:white_check_mark: approved - ${ticketId} is running now.`
            : `:white_check_mark: approved ${ticketId}, not started yet: ${note ?? 'unknown'}`;
          Promise.resolve(scutPostAs(web, room.agentId || 'riker', {
            channel: room.channel,
            thread_ts: room.thread_ts,
            text,
          }, getTheme())).catch(() => {});
        } catch { /* never break the approve route */ }
      },
      // D27 close-and-hide: a closed card's channel is hidden (summary,
      // closed- rename, operators removed), an open or idle card's channel is
      // visible. The mapping survives both, so a reply in a hidden channel
      // reaches the router and reopens the ticket. A failure is reported to
      // the adapter-health alert, never swallowed; the PATCH that triggered
      // it still succeeds. Callers fire and forget; the close reconciler
      // (card glmps-2-0-85) awaits the { action, ok } it resolves to, and
      // passes summary: false to hide a long-closed card without a post.
      ticketStateChanged({ item, summary = true } = {}) {
        if (!ticketChannelsOn || !item?.id) return Promise.resolve(null);
        return Promise.resolve().then(async () => {
          const entry = scutChannelForTicket(item.id, ticketChannelOpts);
          if (!entry) return null;
          const action = scutVisibilityAction({ state: item.state, hiddenTs: entry.hiddenTs ?? null });
          if (!action) return null;
          const operatorIds = scutGetAllowedUsers(settingsOpts);
          try {
            if (action === 'hide') {
              // Drain first. A closing agent's last devlog is usually still in
              // the relay queue when the card flips to done, so the hide's own
              // closing summary must post AFTER it, not race it.
              await relayQueue.drain(entry.channelId);
              const card = backlogStore.load(P.stateDir).items.find((i) => i.id === item.id) ?? null;
              const outcome = [...(card?.devLog ?? [])].reverse().find((d) => d.by === 'agent')?.text ?? '';
              const summaryArgs = {
                ticketId: item.id, title: card?.title ?? '', gate: card?.gate ?? null, outcome,
                prUrl: card?.prUrl ?? card?.mergeRequest?.prUrl ?? null, rejoinEnabled: cfg.scut?.rejoinReopens === true,
              };
              const text = summary ? scutClosingSummary(summaryArgs) : null;
              // card glmps-2-0-104: the operators are removed from the channel
              // in this same step, so the copy they actually read goes to the
              // thread the ticket started from in the main channel.
              const origin = scutOriginThread(card?.origin) ?? entry.origin ?? null;
              const main = summary && origin && origin.channel !== entry.channelId
                ? { ...origin, text: scutClosingSummary({ ...summaryArgs, channelId: entry.channelId }) }
                : null;
              const postingWeb = { ...web, chatPostMessage: (m) => scutPostAs(web, 'riker', m, getTheme()) };
              const hid = await scutHideTicketChannel({
                web: postingWeb, entry, operatorIds, summary: text, main,
                // mark hidden as soon as the rename
                // lands, not after the whole sequence below succeeds too - a
                // kick failing afterward must never leave the store claiming
                // a visible channel that Slack already shows renamed (and
                // partially emptied) forever. Unhide is idempotent, so a
                // later reopen still heals a partial hide.
                onRenamed: () => scutMarkChannelHidden(item.id, true, ticketChannelOpts),
              });
              if (hid?.mainError) console.warn(`SCUT closing summary to the main channel failed for ${item.id}: ${hid.mainError?.code ?? hid.mainError?.message ?? hid.mainError}`);
            } else {
              await scutUnhideTicketChannel({ web, entry, operatorIds });
              scutMarkChannelHidden(item.id, false, ticketChannelOpts);
            }
            channelNames = null;
            return { action, ok: true };
          } catch (e) {
            // a legacy channel (pre-D27: archivedTs set,
            // hiddenTs null) cannot be renamed or invited into at all -
            // Slack refuses with is_archived. It is already invisible via
            // the old mechanism, so mark it hidden anyway rather than
            // retrying (and re-alerting) on every future close; Task 13's
            // migration is what actually fixes its name and membership.
            if (action === 'hide' && e?.code === 'is_archived') {
              // no bare catch - a failed mark
              // here means the NEXT close retries the rename and reports
              // is_archived all over again, which is exactly the repeat this
              // branch exists to avoid, so it gets its own named miss.
              // folded into the scut-legacy-archived route (the mark
              // failure is a sub-step of the same legacy-archived gap), id in
              // the reason text.
              try { scutMarkChannelHidden(item.id, true, ticketChannelOpts); }
              catch (e2) { reportMiss('scut-legacy-archived', `${item.id} (mark): ${e2?.message ?? String(e2)}`); }
              reportMiss('scut-legacy-archived', `${item.id}: a legacy archived ticket channel needs the Task 13 migration`);
              return { action, ok: true };
            }
            // labeled by the actual action taken
            // ('hide'/'unhide'), not by item.state - a cancelled/archived
            // close is ALSO a hide, and used to be mislabeled "update".
            reportMiss('scut-visibility', `${item.id}: ticket channel ${action} failed: ${e?.code ?? e?.message ?? e}`);
            return { action, ok: false };
          }
        }).catch((e) => { reportMiss('scut-visibility', `${item.id}: ticket channel visibility failed: ${e?.message ?? e}`); return { action: null, ok: false }; });
      },
      // The close reconciler's view of chat state (card glmps-2-0-85): the
      // ticket channels, and which tickets hold a park poll open right now.
      ticketChannels: () => (ticketChannelsOn ? scutListTicketChannels(ticketChannelOpts) : []),
      heldParks: () => [...parkWaiters.keys()],
      // A closed card's parked session is told to sign off now, instead of on
      // its next poll up to ten minutes later.
      endParkForClosedCard(ticketId) {
        const w = parkWaiters.get(ticketId);
        if (!w) return false;
        w.resolve({ action: 'close', reason: 'card-closed' });
        backlogStore.applyLabelDeltaIn(P.stateDir, ticketId, { removeLabels: ['agent:parked'] });
        return true;
      },
      // The host came back and found this job's process gone. Say so in its own
      // room: without this the outage is invisible from the thread, which is the
      // exact ambiguity the tripwire exists to remove.
      hostRestarted({ ticketId, action } = {}) {
        try {
          const room = scutFindRoomByTicket(ticketId, roomOpts);
          if (!room) return;
          const what = action === 'requeue'
            ? 'it has been queued to run again'
            : 'it has been held for you to look at';
          Promise.resolve(scutPostAs(web, room.agentId || 'riker', {
            channel: room.channel,
            thread_ts: room.thread_ts,
            text: `:electric_plug: the host went down while ${ticketId} was running, so ${what}.`,
          }, getTheme())).catch(() => {});
        } catch { /* never break the runner */ }
      },
      // An agent is blocked waiting on approval: put the request in its room
      // (glmps-29). Best effort by construction - the caller already
      // swallows throws, and a failed post degrades to the gate timing out and
      // telling the agent to retry, never to a wedged HTTP request.
      gateOpened({ id, sessionId, tool, summary }) {
        const body = `:lock: needs your approval before continuing:\n> ${String(summary || tool || 'an action').slice(0, 300)}\n` +
                     `Reply \`approve ${id}\` or \`deny ${id}\`. It waits up to ${describeWait(gateDeadlineMs(gateConfig({ stateDir: P.stateDir })))}, then gives up and asks again.`;
        try {
          const room = scutFindRoomBySession(sessionId, roomOpts);
          if (room) {
            Promise.resolve(scutPostAs(web, room.agentId || 'riker', {
              channel: room.channel, thread_ts: room.thread_ts, text: body,
            }, getTheme())).catch(() => {});
            return;
          }
          // NO ROOM. This used to return silently, which made the gate a trap:
          // most sessions are started at the desk and never bind a Slack thread,
          // so the agent would block for the full 9 minutes with nobody told,
          // then be denied. A gate nobody can see is strictly worse than no gate.
          // Fall back to the roll-up channel, which exists for exactly this
          // "something happened outside any thread" case.
          Promise.resolve(rollupChannel()).then((channel) => {
            if (!channel) return;
            return scutPostAs(web, 'riker', {
              channel,
              text: `${body}\n(session ${String(sessionId ?? 'unknown').slice(0, 8)}, no thread bound)`,
            }, getTheme());
          }).catch(() => {});
        } catch { /* never block the gate on chat */ }
      },
      // K4/D6a: a single operator-channel post outside any ticket room (a
      // loop failure streak, not a job outcome). `web` and `getTheme` are
      // this closure's own, unreachable from outside the SCUT facade, so
      // this is the seam a caller outside SCUT (e.g. the loop registry's
      // onStreak, or the obligation-sweeper's escalation ladder, K4 Task 11)
      // reaches through. Rejects (never throws) on no channel or a post
      // failure, so the caller decides how to log the miss - this never
      // swallows it itself.
      // `mention` prefixes the first id
      // of the SCUT allowed-users list - the same allowlist the router
      // already reads for command authorization - so the operator's own
      // phone actually buzzes instead of a post sitting unread in a channel
      // nobody has open. No allowed user configured -> no prefix, never a
      // throw: an @mention is a nice-to-have on top of the post, not a
      // precondition for sending it.
      postToOperator(text, { mention = false } = {}) {
        return Promise.resolve(rollupChannel()).then((channel) => {
          if (!channel) throw new Error('no SCUT channel');
          const userId = mention ? scutGetAllowedUsers(settingsOpts)[0] : null;
          return scutPostAs(web, 'riker', { channel, text: userId ? `<@${userId}> ${text}` : text }, getTheme());
        });
      },
      // H3: a huddle kick-off card's own thread. openCardThread posts the
      // thread's first message in the operator's channel as the Lead and
      // returns where it is; bindCardThread then binds it the way the router
      // binds a mention's thread (the thread room, then the ticket channel).
      async openCardThread(text) {
        const channel = await rollupChannel();
        if (!channel) throw new Error('no SCUT channel');
        const res = await scutPostAs(web, 'riker', { channel, text }, getTheme());
        if (!res?.ts) throw new Error('Slack returned no message ts');
        return { channel: res.channel ?? channel, thread_ts: res.ts };
      },
      // `strict` (POST /api/backlog/<id>/channel): the channel IS the point, so
      // a Slack failure throws with its reason instead of falling back to the
      // thread room.
      async bindCardThread({ channel, thread_ts, ticketId, project, strict = false }) {
        const user = scutGetAllowedUsers(settingsOpts)[0] ?? null;
        const room = { channel, thread_ts, ticketId, sessionId: null, mentionTs: thread_ts, project, agentId: 'riker', user };
        scutBindRoom(room, roomOpts);
        const title = backlogStore.load(P.stateDir).items.find((i) => i.id === ticketId)?.title ?? ticketId;
        const args = { ticketId, title, project, origin: { channel, thread_ts, ts: thread_ts, user, agentId: 'riker' } };
        const opened = strict ? await scutCreateTicketChannel(args) : await scutOpenTicketChannel(args);
        if (strict && !opened) throw new Error('Slack created no channel');
        if (opened) scutBindRoom(opened, roomOpts);
        return opened ?? room;
      },
      ticketChannelsEnabled: () => ticketChannelsOn,
      ticketChannelFor: (ticketId) => (ticketChannelsOn ? scutChannelForTicket(ticketId, ticketChannelOpts) : null),
      // Bridge ticket id -> runtime session id for rooms still waiting on one.
      // A runner-launched worktree lives at <worktrees>/<project>/<jobId>, so
      // worktreeInfo() over a live session's cwd yields { kind:'runner', id:jobId }
      // with nothing needing to have been stamped at launch time (see the note
      // in launchJob about why no id can be stamped there). The ticket's own
      // self-reported sessionId is used as a fallback for non-worktree runs.
      bindSessions(ticketIds) {
        try {
          const pairs = (ticketIds ?? [])
            .map(id => ({ id, room: scutFindRoomByTicket(id, roomOpts) }))
            .filter(x => x.room);
          if (!pairs.length) return;
          // planRebinds also RE-binds a room whose session is gone (host crash,
          // requeue-after-retry), not just never-bound rooms.
          const live = sessionSummaries().filter(s => s.live);
          let items = null;
          const fallbackFor = (id) => {
            items = items ?? backlogStore.load(P.stateDir).items;
            return items.find(i => i.id === id)?.sessionId ?? null;
          };
          for (const plan of scutPlanRebinds({ pairs, live, fallbackFor })) scutBindRoom(plan, roomOpts);
        } catch { /* never break the runner */ }
      },
      // Parked-session seams (spec 2026-07-31-scut-parked-sessions): the HTTP
      // route and scutCommands reach these through the facade; the bodies are
      // the named closures above so the router deps can share them.
      parkPoll: scutParkPoll,
      requestApproval: approvals.request,
      runRegisteredAction: approvals.runRegistered,
      approvalsView: approvals.view,
      approvalMessage: approvals.onMessage,
      approvalsSettled: approvals.settled,
      parkWake: scutParkWake,
      releasePark: scutReleasePark,
      parkSweepRun: () => parkSweepHandle.runNow(),
      // Reopen by reply (D27 C2, Task 8): exposed so a test (or another
      // trigger, e.g. Task 10's rejoin path) can drive it directly.
      reopen: (ticketId, text, ctx) => reopenHandle.runNow({ ticketId, text, ctx }),
      // exposed so a test can drive scutRelaunch's
      // eviction decision directly, without going through the reopen loop's
      // own REOPENABLE gate - every state that gate accepts (idle/done/
      // cancelled/archived) is also a FINISHED state (queue-runner.js), so
      // reconcileNow (called inside relaunchJobNow itself) always drops a
      // stale ledger entry for such a card before relaunchJobNow's own
      // `already running` guard ever sees it. Proving that guard still blocks
      // eviction needs a card state the ledger reconciler leaves alone
      // (e.g. 'in_progress'), which the reopen loop would never reach at all.
      relaunch: (id, opts) => scutRelaunch(id, opts),
      // Exposed so a test can drive the real reload guard directly (review
      // every path that reaches it through the sweep
      // either genuinely is eligible (idleClosures() already agreed) or is
      // filtered out before this ever runs, so nothing on the sweep path
      // alone can exercise the guard's decline branch against the real
      // function. A direct call bypasses that filter and reaches the same
      // scutCloseIdle the loop's closeIdle dependency calls.
      closeIdle: (id) => scutCloseIdle(id),
      progressTick: scutProgressTick,
      drainPendingReopens: scutDrainPendingReopens,
      // Clean shutdown. Cancelling the tripwire here is what stops it crying
      // wolf on an intentional restart, which is the difference between an
      // alarm the operator trusts and one they mute. Returns a promise so the
      // CLI signal handler can await the cancel before the process exits.
      stop() {
        stopped = true;
        // Flush held park polls so close() never hangs on a long-poll socket.
        for (const [, w] of parkWaiters) w.resolve({ action: 'wait' });
        parkWaiters.clear();
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (connectSleepTimer) { clearTimeout(connectSleepTimer); connectSleepTimer = null; }
        if (connectSleepResolve) { connectSleepResolve(); connectSleepResolve = null; }
        try { sm?.stop(); } catch { /* best effort */ }
        return Promise.resolve(heartbeat?.disarm?.()).catch(() => {});
      },
    };
  }
  scut = startScut();
  scutBooted = true;
  maintenanceHold();

  // Card glmps-2-0-85: a closed card owns nothing open. Hides the channels the
  // close paths missed, ends held parks, and closes the card's Claude sessions
  // (lib/scut/close-sync.js decides, lib/orchestration/session-closer.js finds
  // and ends). On by default only in the kernel service, and never by default
  // in a test process (some boot with GLMPS_SERVICE=1), so a test server never
  // lists or ends processes unless it injects a closer and opts in.
  if (cardSessionsOn) {
    const closer = cardSessions;
    loopRegistry.registerLoop({
      name: 'card-close-sync',
      trigger: { everyMs: 120_000 },
      maker: async () => {
        const items = backlogStore.load(P.stateDir).items;
        const failed = [];
        let sessions = [];
        try { sessions = await closer.list(); } catch (e) { failed.push(e?.message ?? String(e)); }
        // Last write per session, helpers included: a session still writing is mid-turn.
        const activity = sessions.length
          ? claudeActivity()
          : new Map();
        const plan = planCloseSync({ items, channels: scut?.ticketChannels?.() ?? [], parked: scut?.heldParks?.() ?? [], sessions, activity, running: Object.keys(runnerStore.loadLedger(P.stateDir)), now: Date.now() });
        const stateOf = new Map(items.map((i) => [i.id, i.state]));
        let hidden = 0; let parks = 0; let closedSessions = 0;
        for (const h of plan.hides) {
          const r = await scut?.ticketStateChanged?.({ item: { id: h.ticketId, state: stateOf.get(h.ticketId) }, summary: h.summary });
          if (r?.ok) hidden += 1; else if (r) failed.push(`hide ${h.ticketId}`);
        }
        for (const id of plan.parks) if (scut?.endParkForClosedCard?.(id)) parks += 1;
        // Re-read: a reply may have reopened a card while the hides ran.
        const fresh = new Map(backlogStore.load(P.stateDir).items.map((i) => [i.id, i.state]));
        for (const s of plan.sessions) {
          if (!backlogStore.CLOSED_STATES.has(fresh.get(s.ticketId))) continue;
          const r = await closer.close(s);
          if (!r.ok) { failed.push(`session ${s.ticketId} (pid ${s.pid}): ${r.error}`); continue; }
          closedSessions += 1;
          backlogStore.appendDevLogIn(P.stateDir, s.ticketId, { by: 'runner', text: `closed its Claude session (pid ${s.pid}) because the card is closed` });
        }
        // Without a session list every child would look orphaned. Channel
        // opens are Slack calls, so a run promotes a few and the next run the rest.
        const promoted = [];
        if (!failed.length) {
          for (const p of plan.promotions.slice(0, MAX_HIDES_PER_RUN)) {
            const now = fresh.get(p.id);
            if (!now || backlogStore.CLOSED_STATES.has(now)) continue;
            const r = await promoteSpawnedCard(p.id, { host: p.host, why: 'is closed and no Claude session is on this card or its host', requeue: p.requeue && now === 'in_progress' });
            if (r) promoted.push(p.id);
          }
        }
        if (parks || closedSessions || promoted.length) broadcastBacklog();
        const result = { hidden, parks, closedSessions, keptForChildren: plan.keptForChildren, promoted, pendingHides: plan.pendingHides, failed };
        // done whenever anything failed: the registry skips the checker for nothing-to-do, so the failure would go unseen.
        return { outcome: hidden || parks || closedSessions || promoted.length || failed.length ? 'done' : 'nothing-to-do', result };
      },
      checker: async ({ failed }) => (failed.length ? { ok: false, reason: failed.join('; ').slice(0, 500) } : { ok: true }),
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 90_000 },
      sla: { maxAgeMs: 10 * 60_000 },
    });
  }

  // glmps-2-0-171 D4: one daily post listing cards nobody steers. Hourly tick;
  // the loop body decides whether today's 16:00 UTC post is due.
  loopRegistry.registerLoop({
    name: 'orphan-sweep',
    trigger: { everyMs: 3_600_000 },
    ...orphanSweepLoop({
      stateDir: P.stateDir,
      readItems: () => backlogStore.load(P.stateDir).items,
      live: () => Object.keys(runnerStore.loadLedger(P.stateDir)),
      parked: () => scut?.heldParks?.() ?? [],
      canPost: () => Boolean(scut?.postToOperator),
      post: (text) => scut.postToOperator(text),
    }),
  });

  //
  // Two nightly jobs. Both are opt-in and both capture their handle so close()
  // can clear them: every uncaptured setInterval here used to leak one
  // interval per startServer() call, including in every test that boots one
  // (glmps-8).
  //
  // Ordering matters. A0.2 requires the decay sweep to run BEFORE anything
  // reads lessons, so the night starts from fresh state rather than from
  // yesterday's strengths. The sweep therefore runs first inside one tick,
  // with reconciliation after it, instead of on two independent timers that
  // could interleave.
  //
  // The decay and revert sweeps are also their own registered loops (card
  // glmps-2-0-runtime-15), on by default, because two of the four freeze-lift
  // checks are computed only from what they write. The tick still runs them
  // first so the ordering above holds when it is on. A revert run already in
  // flight is shared rather than started twice, so the two callers never race
  // on the watermark.
  function decaySweepStep(now = Date.now()) {
    return runDecaySweep(P.stateDir, { now, config: learningIntegrityConfig(cfg) });
  }
  let revertSweepInFlight = null;
  function revertSweepStep(now = Date.now()) {
    if (revertSweepInFlight) return revertSweepInFlight;
    // Scope is learningIntegrity.revertScanRepos, defaulting to this repo.
    // NOT nightly.repoAllowlist: that list is empty whenever nightly is off,
    // which is the default, so gating on it would have left this exactly as
    // dead as it was with no caller at all.
    const liCfg = learningIntegrityConfig(cfg);
    const repos = liCfg.revertScanRepos.length ? liCfg.revertScanRepos : [REPO_ROOT];
    revertSweepInFlight = runRevertSweep(P.stateDir, { repos, now, actor: 'nightly-runner' })
      .finally(() => { revertSweepInFlight = null; });
    return revertSweepInFlight;
  }

  async function platformAutonomyTick(now = Date.now()) {
    try {
      decaySweepStep(now);
    } catch { /* a decay failure must not stop the drift checks */ }
    try {
      // A0.3, the sweep that shipped without a caller (glmps-74).
      // Positioned between decay and reconciliation on purpose: decay must run
      // first (A0.2 wants fresh strengths before anything reads lessons), and
      // the sweep must run before the drift checks so ungated_reflex and
      // orphaned_artifact see tonight's invalidations rather than last night's.
      await revertSweepStep(now);
    } catch { /* fail-open: an invalidation failure must not stop the drift checks */ }
    try {
      // Unlike the read-only GET paths, this one DOES pass stateDir, so the
      // findings are emitted as reconciliation.integrity_finding events. This tick
      // is the single writer of those events.
      runReconciliation({ ...reconciliationContext(now), stateDir: P.stateDir });
    } catch { /* fail-open: integrity checks are diagnostics, not a gate */ }
    try {
      // Part C's autonomy ladder (glmps-74). graduationDecision was
      // pure, correct and never called by anything but its own test, so no
      // task class could graduate however long its zero-edit streak got.
      // Once a night, after the drift checks, so a demotion triggered by a
      // revert this evening is recorded against tonight's picture.
      runGraduationSweep(P.stateDir, {
        metrics: autonomyMetrics(readTouches(P.stateDir), nightlyMerges(), { windowDays: 7, now }),
        config: cfg.autonomy?.graduation ?? {},
        actor: 'operator',
        now,
      });
    } catch { /* fail-open: a tier change is never worth breaking the tick for */ }
    try {
      // Release any held ticket whose run quota is now met (mc-74 Stage 6).
      // glmps-60 and -61 are the reason this exists: they cannot be
      // finished until nights have elapsed, and leaving them queued with the
      // runner live meant a session would pick one up and find nothing to
      // observe. The counter is run.completed, not run.started, because a
      // failed night must not count toward an acceptance quota.
      const completedRuns = readSpineEvents(P.stateDir, { kind: SPINE_KINDS.RUN_COMPLETED }).length;
      const bl = backlogStore.load(P.stateDir);
      const due = backlogStore.releaseOnQuota(bl.items, completedRuns);
      if (due.length) {
        let st = bl;
        for (const id of due) {
          st = backlogStore.updateItem(st, id, { state: 'queued', releaseAfterRuns: null }).state;
        }
        backlogStore.save(P.stateDir, st);
        console.log(`[nightly] released ${due.length} held ticket(s) at ${completedRuns} completed run(s): ${due.join(', ')}`);
      }
    } catch { /* fail-open: a release is a convenience, never worth breaking the tick */ }
  }

  // Capture health survives a restart (glmps-72). Without this the
  // registry was a module-level Map and every miss ever recorded was lost on
  // restart, so "has capture been silently dropping records" was unanswerable
  // for any past window. Load once at boot; persist on the inventory timer
  // rather than per miss, because a drift storm is hundreds of misses a second
  // and must not become hundreds of file writes a second.
  loadAdapterHealth(P.adapterHealthFile);

  const pollTimer = setInterval(poll, pollMs);
  const agTimer = setInterval(checkAgAlive, cfg.agCheckMs);
  const invTimer = setInterval(() => {
    scanInv();
    sweepWorktrees().catch(() => {});
    persistAdapterHealth(P.adapterHealthFile);
  }, cfg.inventoryScanMs);
  const runnerTimer = setInterval(runnerTick, cfg.runnerTickMs);
  // Unmerged-branch cache refresh (glmps-66 perf fix): same 5-minute cadence
  // the inline recompute used to use, now off the request path entirely - 
  // /api/alerts and /api/report/baseline only ever read unmergedRepoCache.
  // No eager boot-time kick here on purpose: gatherUnmergedFindings() lazily
  // fires the first refresh only once something actually asks for alerts, so
  // a server instance that never serves them (most tests, short-lived CLI
  // invocations) never pays the git-scan cost at all.
  const unmergedRefreshTimer = setInterval(() => {
    refreshUnmergedCache().catch(() => {});
    if (openPrStatesTs !== 0) refreshOpenPrStates();
  }, 5 * 60 * 1000);
  // QA Trends sampler timer: guarded handle, captured and cleared in close()
  // (glmps-8: every uncaptured setInterval here used to leak one
  // interval per startServer() call, including in tests).
  const qaTrendsTimer = cfg.qaTrends.enabled ? setInterval(qaTrendsTickFn, cfg.qaTrends.checkMs) : null;
  // Vitals Trends sampler timer -- same guarded-handle pattern as qaTrendsTimer
  // immediately above (glmps-8's leaked-interval lesson).
  const vitalsTrendsTimer = cfg.vitalsTrends.enabled ? setInterval(vitalsTrendsTickFn, cfg.vitalsTrends.tickMs) : null;
  // Scheduled full graph rebuild timer -- same guarded-handle pattern as the
  // timers above (glmps-8's leaked-interval lesson). Default enabled;
  // the first tick fires one checkMs after boot, not at boot, so short-lived
  // test servers never spawn a graphify process.
  const graphRebuildTimer = cfg.graphRebuild.enabled ? setInterval(() => { graphRebuildTick().catch(() => {}); }, cfg.graphRebuild.checkMs) : null;
  // The merged machine graph (card glmps-2-0-101). The checker re-reads the
  // published manifest rather than trusting what the merge reported.
  if (cfg.graphMachineScan.enabled) {
    loopRegistry.registerLoop({
      name: 'graph-machine-merge',
      trigger: { everyMs: cfg.graphMachineScan.checkMs },
      bootDelayMs: cfg.graphMachineScan.checkMs,
      maker: async () => {
        const r = await graphMachineScanTick();
        return r.built ? { outcome: 'done', result: { builtAt: r.manifest.builtAt } } : { outcome: 'nothing-to-do', result: { reason: r.reason } };
      },
      checker: async ({ builtAt }) => {
        const m = readJsonSafe(machineGraphPaths(P.stateDir).manifest);
        return m?.builtAt === builtAt && fs.existsSync(machineGraphPaths(P.stateDir).graph)
          ? { ok: true } : { ok: false, reason: `manifest on disk is ${m?.builtAt ?? 'missing'}, not ${builtAt}` };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 15 * 60_000 },
      sla: { maxAgeMs: 4 * cfg.graphMachineScan.checkMs },
    });
  }
  if (graphScopeMigrateOnBoot) {
    migrateGraphScopeState()
      .then((r) => { if (r.changed) console.log(`graph scope migration: archived ${r.archived.syncHealth} sync-health and ${r.archived.integrity} integrity entries; in scope: ${r.inScope.join(', ')}`); })
      .catch((e) => console.error('graph scope migration failed:', e?.message ?? e));
  }
  // Upgrade-plan item 7: samples every graph's shape so a collapse written by
  // graphify's own post-commit hook, which never passes through this server,
  // still reaches the alert center. The checker re-reads the persisted store
  // rather than trusting the in-memory fold.
  if (cfg.graphIntegrity.enabled) {
    loopRegistry.registerLoop({
      name: 'graph-integrity',
      trigger: { everyMs: cfg.graphIntegrity.sampleMs },
      maker: async (ctx) => {
        const roots = await graphShapeTick({ signal: ctx.signal });
        return roots.length ? { outcome: 'done', result: { roots } } : { outcome: 'nothing-to-do', result: { roots } };
      },
      checker: async ({ roots }) => {
        const onDisk = loadGraphIntegrity(P.graphIntegrityFile);
        const missing = roots.filter(r => !hasIntegrityRecord(onDisk, r));
        return missing.length ? { ok: false, reason: `not persisted: ${missing.join(', ')}` } : { ok: true };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 2 * 60_000 },
      sla: { maxAgeMs: 60 * 60_000 },
    });
  }
  // Nightly state-dir backup (card glmps-2-0-runtime-42). Checked hourly; the
  // maker decides from the clock and the target whether today's is due, so a
  // restart or deploy never loses the night. The checker re-reads the newest
  // daily from disk and re-hashes it against its own manifest.
  if (cfg.backup.targetDir) {
    const stateBackup = createStateBackup({ stateDir: P.stateDir, ...cfg.backup });
    loopRegistry.registerLoop({
      name: 'state-backup',
      trigger: { everyMs: cfg.backup.checkMs },
      maker: () => stateBackup.maybeRun(),
      checker: async () => {
        const v = await stateBackup.verify();
        return v.ok ? { ok: true } : { ok: false, reason: v.reason };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 30 * 60_000 },
      sla: { maxAgeMs: 36 * 60 * 60_000 },
    });
  }
  // Card glmps-2-0-152: the server certificate and every client certificate,
  // daily; 30 days out each raises an alert. The checker re-reads the client
  // store rather than trusting the maker's list.
  loopRegistry.registerLoop({
    name: 'cert-expiry',
    trigger: { everyMs: 24 * 60 * 60_000 },
    maker: async () => {
      certExpiry = readCertExpiry();
      return { outcome: certExpiry.length ? 'done' : 'nothing-to-do', result: { count: certExpiry.length } };
    },
    checker: async ({ count }) => {
      const fresh = readCertExpiry().length;
      return fresh === count ? { ok: true } : { ok: false, reason: `the store now shows ${fresh} certificate(s) near expiry, the run saw ${count}` };
    },
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 60_000 },
    sla: { maxAgeMs: 36 * 60 * 60_000 },
  });
  const graphifyVersionTimer = cfg.graphifyUpdate.enabled
    ? setInterval(() => { graphifyVersionTick().catch(() => {}); }, cfg.graphifyUpdate.tickMs)
    : null;
  // The interval's first tick lands a full tickMs (24 h) after start, and a
  // deploy restarts the server sooner, so the 2026-10-23 rollback marker sat
  // unread for days (card glmps-2-0-103). One tick after boot settles; off
  // under test unless a test names the delay.
  const graphifyVersionBootDelayMs = graphifyVersionOverrides.bootDelayMs
    ?? (isTestProcess({ env }) ? null : 5 * 60_000);
  const graphifyVersionBootTimer = cfg.graphifyUpdate.enabled && graphifyVersionBootDelayMs != null
    ? setTimeout(() => { graphifyVersionTick().catch(() => {}); }, graphifyVersionBootDelayMs)
    : null;
  graphifyVersionBootTimer?.unref?.();
  // The version tick first fires a full tickMs after start, and a deploy
  // restarts the server more often than that, so the skill copies are also
  // brought in step once shortly after boot.
  if (cfg.graphifyUpdate.enabled && graphifySkillHome) {
    setTimeout(() => {
      syncGraphifySkills().catch((e) => console.error('graphify skill refresh failed:', e?.message ?? e));
    }, 60_000).unref?.();
  }
  // The A0.2 decay and A0.3 revert sweeps (card glmps-2-0-runtime-15). Each
  // checker re-reads the ledger or the watermark file rather than trusting
  // what its maker reported.
  const liSweeps = learningIntegrityConfig(cfg).sweeps;
  if (liSweeps.enabled) {
    loopRegistry.registerLoop({
      name: 'lesson-decay',
      trigger: { everyMs: liSweeps.everyMs },
      maker: async () => {
        const { decayed, evaluated } = decaySweepStep();
        return { outcome: decayed.length ? 'done' : 'nothing-to-do', result: { decayed, evaluated } };
      },
      checker: async ({ decayed }) => {
        const cur = lessonsCurrent(readLessonRows(P.stateDir, {}));
        const notDormant = decayed.filter((id) => cur.get(id)?.status !== 'dormant');
        return notDormant.length ? { ok: false, reason: `not dormant in the ledger: ${notDormant.join(', ')}` } : { ok: true };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 2 * 60_000 },
      sla: { maxAgeMs: liSweeps.maxAgeMs },
    });
    loopRegistry.registerLoop({
      name: 'revert-sweep',
      trigger: { everyMs: liSweeps.everyMs },
      maker: async () => {
        const { repos } = await revertSweepStep();
        // A repo the sweep could not read keeps its watermark, so the range is
        // retried next run; the run itself fails so the miss is visible.
        const errors = repos.filter((r) => r.error).map((r) => `${r.repo}: ${r.error}`);
        if (errors.length) throw new Error(`revert scan failed for ${errors.join('; ')}`.slice(0, 500));
        const moved = repos.filter((r) => r.head || r.invalidated.length || r.orphaned.length);
        return { outcome: moved.length ? 'done' : 'nothing-to-do', result: { repos } };
      },
      checker: async ({ repos }) => {
        const cur = lessonsCurrent(readLessonRows(P.stateDir, {}));
        const problems = [];
        for (const r of repos) {
          if (r.head && readWatermark(P.stateDir, r.repo) !== r.head) problems.push(`${r.repo}: watermark not at ${r.head}`);
          for (const id of r.invalidated) if (cur.get(id)?.status !== 'invalidated') problems.push(`${id} not invalidated`);
        }
        return problems.length ? { ok: false, reason: problems.join('; ').slice(0, 500) } : { ok: true };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5 * 60_000 },
      sla: { maxAgeMs: liSweeps.maxAgeMs },
    });
  }
  // Operator decision 5 (card glmps-2-0-runtime-127): agent sessions rename to
  // <name>.old instead of deleting, and this loop is the only actor that
  // deletes, inside the tracked git repos only. Off under a test process unless
  // a test's config turns it on, since REPO_ROOT is always a tracked root. The
  // checker re-reads the disk and the spine rather than trusting the maker.
  const oldCleanupCfg = { enabled: !isTestProcess({ env }), ...OLD_CLEANUP_DEFAULTS, ...(cfg.oldCleanup || {}) };
  if (oldCleanupCfg.enabled) {
    loopRegistry.registerLoop({
      name: 'old-cleanup',
      trigger: { everyMs: oldCleanupCfg.everyMs },
      maker: async () => {
        const startedAt = new Date(Date.now() - 1000).toISOString();
        const r = await sweepOldFiles({
          roots: oldCleanupCfg.roots ?? gitRepoRoots().map((x) => x.path),
          stateFile: path.join(P.stateDir, 'old-cleanup.json'),
          maxAgeMs: oldCleanupCfg.maxAgeMs, maxEntries: oldCleanupCfg.maxEntries, maxDeletes: oldCleanupCfg.maxDeletes,
          emit: (kind, payload) => emitSpineEvent(P.stateDir, {
            kind, actor: 'old-cleanup', label: `${kind === SPINE_KINDS.CLEANUP_OLD_DELETED ? 'deleted' : 'refused'} ${payload.path}`, payload,
          }),
        });
        const result = { startedAt, deleted: r.deleted.map((d) => d.path), refused: r.refused.length, pending: r.pending, baselined: r.baselined, scanned: r.scanned, truncated: r.truncated };
        return { outcome: r.deleted.length ? 'done' : 'nothing-to-do', result };
      },
      checker: async ({ startedAt, deleted }) => {
        const still = deleted.filter((p) => { try { fs.lstatSync(p); return true; } catch { return false; } });
        const logged = new Set(readSpineEvents(P.stateDir, { kind: SPINE_KINDS.CLEANUP_OLD_DELETED, since: startedAt }).map((e) => e.payload?.path));
        const unlogged = deleted.filter((p) => !logged.has(p));
        if (still.length) return { ok: false, reason: `still on disk: ${still.join(', ')}`.slice(0, 500) };
        if (unlogged.length) return { ok: false, reason: `deleted without a spine record: ${unlogged.join(', ')}`.slice(0, 500) };
        return { ok: true };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 15 * 60_000 },
      sla: { maxAgeMs: 4 * oldCleanupCfg.everyMs },
    });
  }
  // Card glmps-2-0-156: the companion's folder watch died in a state-folder
  // move and card 155 sat "launched" with no session for 49 minutes. A line
  // still in the request file after 2 minutes is flagged on its card, once.
  // It is never relaunched natively: the line stays queued, so a later drain
  // would open a second session in the same worktree.
  if (companionFile) {
    const flaggedCompanionLines = new Set();
    const COMPANION_STALE_MS = 2 * 60_000;
    loopRegistry.registerLoop({
      name: 'companion-launch-watch',
      trigger: { everyMs: 60_000 },
      maker: async () => {
        const stale = [];
        for (const target of IDE_TARGETS) {
          let text;
          try { text = fs.readFileSync(companionFileFor(target), 'utf8'); } catch (e) {
            if (e?.code === 'ENOENT') continue;
            throw e;
          }
          for (const r of staleCompanionRequests({ text, now: Date.now(), maxAgeMs: COMPANION_STALE_MS })) {
            if (!flaggedCompanionLines.has(`${target}|${r.sessionId}|${r.ts}`)) stale.push({ ...r, target });
          }
        }
        if (!stale.length) return { outcome: 'nothing-to-do', result: { flagged: [] } };
        const { ledger } = runnerStore.readLedger(P.stateDir);
        const flagged = [];
        for (const s of stale) {
          flaggedCompanionLines.add(`${s.target}|${s.sessionId}|${s.ts}`);
          const ide = TARGET_LABELS[s.target];
          const mins = Math.round(s.ageMs / 60_000);
          const jobId = s.sessionId ? Object.keys(ledger ?? {}).find((id) => ledger[id]?.sessionId === s.sessionId) : null;
          reportMiss('companion-unclaimed', `${jobId ?? s.cwd ?? 'unknown launch'}: ${ide} has not picked up a launch queued ${mins} min ago`);
          if (!jobId) continue;
          backlogStore.appendDevLogIn(P.stateDir, jobId, {
            by: 'runner',
            text: `${ide} has not opened this session ${mins} minutes after the launch was queued, so nothing is working this card yet. Restart ${ide} (its GLMPS extension opens queued launches when it starts); no second launch is made, to avoid two sessions in one worktree.`,
          });
          flagged.push(jobId);
        }
        return { outcome: flagged.length ? 'done' : 'nothing-to-do', result: { flagged } };
      },
      checker: async ({ flagged }) => {
        const items = new Map(backlogStore.load(P.stateDir).items.map((i) => [i.id, i]));
        const missing = flagged.filter((id) => !(items.get(id)?.devLog ?? []).some((d) => /has not opened this session/.test(d.text)));
        return missing.length ? { ok: false, reason: `no stall devlog on ${missing.join(', ')}` } : { ok: true };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 30_000 },
      sla: { maxAgeMs: 10 * 60_000 },
    });
  }
  // Runner prompt files of cards closed 14+ days ago (card
  // glmps-2-0-runtime-152). It only touches <stateDir>/runner/*.prompt.md, so
  // it runs in test servers too; the checker re-reads the disk.
  loopRegistry.registerLoop({
    name: 'runner-prompt-retention',
    trigger: { everyMs: 24 * 3_600_000 },
    bootDelayMs: 10 * 60_000,
    maker: async () => {
      const r = prunePromptFiles({ stateDir: P.stateDir, items: backlogStore.load(P.stateDir).items });
      return { outcome: r.pruned.length ? 'done' : 'nothing-to-do', result: r };
    },
    checker: async ({ pruned }) => {
      const still = pruned.filter((p) => fs.existsSync(p));
      return still.length ? { ok: false, reason: `still on disk: ${still.join(', ')}`.slice(0, 500) } : { ok: true };
    },
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5 * 60_000 },
    sla: { maxAgeMs: 3 * 24 * 3_600_000 },
  });
  // Card glmps-2-0-201, ADR 0003: age-out and evidence-based auto-approval of
  // guard proposals. Provenance mirrors the approve route's landItemGuard, so
  // an auto-landed guard and an operator-landed one are described the same
  // way apart from who approved it.
  function autoGuardTarget(rule, message) {
    return { assetsDir: P.assetsWriteDir ?? P.assetsDir, publish: P.assetsWriteDir != null,
      file: 'CLAUDE.global.md', section: 'Learned guards', rule, message, simThreshold: DEFAULT_SIM_THRESHOLD };
  }
  function autoLand(c) {
    const item = learningStore.load(P.stateDir).items.find((i) => i.id === c.itemId);
    if (!item) throw new Error(`learning item ${c.itemId} is gone`);
    return landGuard(P.stateDir, {
      itemId: item.id, kind: 'guard', title: item.title || item.code || item.id,
      provenance: {
        scope: 'global',
        sourceEventIds: [`learning-store:${item.id}`, ...(item.lastSessionId ? [`session:${item.lastSessionId}`] : [])],
        derivedFromRefs: refsForRepoPath(repoForProject(item.project)),
      },
      actor: AUTO_APPROVER,
      autoApproval: { policy: AUTO_APPROVE_POLICY.name, evidence: c.evidence },
      config: learningIntegrityConfig(cfg),
      guard: autoGuardTarget(c.rule, `learning: auto-approve ${c.code} to global`),
    });
  }
  function autoUnland(rec, { reason, actor }) {
    return unlandGuard(P.stateDir, { itemId: rec.itemId, reason, actor,
      guard: autoGuardTarget(rec.rule, `learning: revert auto-approved ${rec.code}`) });
  }
  loopRegistry.registerLoop({
    name: 'guard-auto-approve',
    trigger: { everyMs: 3_600_000 },
    bootDelayMs: 10 * 60_000,
    maker: async () => runAutoApproveTick({
      now: Date.now(),
      enabled: loadGuardAutoApprove(P.stateDir).enabled,
      canAct: env.GLMPS_ALLOW_ACT === '1' || assertCanAct(P, adapters).ok,
      templates: GUARD_TEMPLATES,
      scan: scanText,
      loadStore: () => learningStore.load(P.stateDir),
      saveStore: (s) => learningStore.save(P.stateDir, s),
      readState: () => readAutoApproveState(P.stateDir),
      writeState: (s) => writeAutoApproveState(P.stateDir, s),
      land: autoLand,
      unland: autoUnland,
    }),
    checker: async (r) => {
      if (r.errors.length) return { ok: false, reason: r.errors.join('; ').slice(0, 500) };
      const items = learningStore.load(P.stateDir).items;
      const notAged = r.aged.filter((id) => items.find((i) => i.id === id)?.status === 'pending');
      if (notAged.length) return { ok: false, reason: `aged-out rows still pending: ${notAged.join(', ')}`.slice(0, 500) };
      if (r.approved && !readAutoApproveState(P.stateDir).records.some((x) => x.code === r.approved && x.status === 'probation')) {
        return { ok: false, reason: `approved ${r.approved} but no probation record was written` };
      }
      return { ok: true, verifierRef: `guard-auto-approve@${r.aged.length}/${r.approved ? 1 : 0}/${r.reverted.length}` };
    },
    onVerified: async (r) => {
      if (!r.digest) return;
      // Recorded before posting: a Slack outage loses one digest rather than
      // repeating it every hour.
      writeAutoApproveState(P.stateDir, { ...readAutoApproveState(P.stateDir), lastDigestTs: Date.now() });
      await postToOperator(r.digest).catch((e) => console.error('[guard-auto-approve] post failed:', e?.message || e));
    },
    ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 5 * 60_000 },
    sla: { maxAgeMs: 6 * 3_600_000 },
  });
  // The rest of the nightly tick (reconciliation, graduation, held-ticket
  // release). Opt-in via config.platformAutonomy.enabled, default false, so a
  // fresh install and every test server stay inert. Its later steps fail
  // open by design; the checker holds it to the one post-condition A0.2 sets
  // for the night: no lesson still active at the tick's clock is below the
  // strength floor.
  if (cfg.platformAutonomy?.enabled) {
    loopRegistry.registerLoop({
      name: 'platform-autonomy',
      trigger: { everyMs: cfg.platformAutonomy.tickMs },
      maker: async () => {
        const now = Date.now();
        await platformAutonomyTick(now);
        return { outcome: 'done', result: { now } };
      },
      checker: async ({ now }) => {
        const config = learningIntegrityConfig(cfg);
        const active = [...lessonsCurrent(readLessonRows(P.stateDir, {})).values()].filter((l) => l.status === 'active').length;
        const fresh = activeLessons(P.stateDir, { now, config }).length;
        return active === fresh ? { ok: true } : { ok: false, reason: `${active - fresh} active lesson(s) below the strength floor after the decay step` };
      },
      ceiling: { maxAttempts: 1, maxModelCalls: 0, timeoutMs: 15 * 60_000 },
      sla: { maxAgeMs: 2 * cfg.platformAutonomy.tickMs },
    });
  }
  // Guard proposer cutover: optional scheduled GEPA run. Default 0
  // (off) - manual via POST /api/plugins/gepa/run, or a future nightly run
  // calling that same route. K Task 6 replaces this setInterval with the
  // guard-proposals loop's own trigger: registerPluginLoops (above) was
  // given gepaEveryMs = cfg.plugins.gepa.intervalMs, so when it is > 0 the
  // loop's trigger is { everyMs: gepaEveryMs } instead of onEvent
  // 'gepa.requested' (plugin-loops.js) and it already self-schedules through
  // the loop registry - there is nothing left here to wire.

  console.log(`GLMPS: http://${bindHost}:${actualPort}`);
  const srv = {
    port: actualPort,
    bootTrace: () => bootTrace.spans(),
    // glmps-75: exposed so a fast, deterministic unit test can pin
    // this configuration invariant without simulating the actual network
    // race (proven via a throwaway load harness instead -- see the comment
    // above server.keepAliveTimeout above).
    keepAliveTimeoutMs: server.keepAliveTimeout,
    headersTimeoutMs: server.headersTimeout,
    runnerTick, // exposed for deterministic tests
    mergeQueueTick, // exposed for deterministic tests
    reviewRunsIdle: async () => { while (reviewRuns.size) await Promise.all([...reviewRuns]); }, // exposed for deterministic tests (headless reviewer runs)
    headlessCardsIdle: async () => { while (headlessCardRuns.size) await Promise.all([...headlessCardRuns]); }, // exposed for deterministic tests (headless card runs)
    launchJobForTest: (id, opts) => launchJob(backlogStore.load(P.stateDir).items.find((i) => i.id === id), opts), // exposed so a test can drive a reviewer launch before the reviewer ticket exists
    relaunchJobNow, // exposed for deterministic tests (Task 7 reopen; Task 8 wires this into the SCUT reopen loop)
    lastDryRunLaunch: () => lastDryRunLaunch, // the dry-run launch seam, asserted without ever spawning
    dryRunLaunches, // exposed for deterministic tests (D20: what launchNative would have opened - resume, terminal, learning-apply)
    graphRebuildTick, // exposed for deterministic tests (scheduled graph repair)
    graphMachineScanTick, // exposed for deterministic tests (merged machine graph)
    graphShapeTick, // exposed for deterministic tests (graph collapse sampler)
    migrateGraphScopeState, // exposed for deterministic tests (graph store scope cleanup)
    graphifyVersionTick, // exposed for deterministic tests (scheduled version audit)
    graphifyUpdate, // exposed for deterministic tests (R-M6/M2: the single-flight-guarded update call, never a real spawn in a test process by default)
    measurablesTick, // exposed for deterministic tests (glmps-140)
    platformAutonomyTick, // exposed for deterministic tests (decay sweep + reconciliation)
    // K Task 6: runGepaOnce and pluginRetryTick are gone - a test now drives
    // the guard-proposals / plugin-retry loops directly through loopRegistry
    // (runNow('guard-proposals' | 'plugin-retry'), or emit('gepa.requested', {})).
    finalizeSweepTick, // exposed for deterministic tests (GLMPS 2.0 shadow-instance plan, Task 1)
    sweepWorktreesTick: sweepWorktrees, // exposed for deterministic tests
    // Test seams (Phase C final review, M10 - named as such so these read as
    // testing-only hooks, never a real API surface): exposed for
    // deterministic tests as a direct
    // way to prove testRealGitWriteRefused actually gates these two
    // functions, using a target path that is never created on disk (so even
    // a hypothetical guard failure touches nothing real - the guard fires
    // before any git call either way). Still guarded exactly like every
    // other caller of createWorktree/removeWorktree.
    createWorktreeForTest: createWorktree,
    removeWorktreeForTest: removeWorktree,
    vitalsTrendsTick: vitalsTrendsTickFn, // exposed for deterministic tests (2026-07-22 alerts-cache fix)
    scut, // the Slack layer facade, or null when it is not configured
    cfgScut: cfg.scut, // exposed for deterministic tests (D27 C3 deep-merge protection)
    loopRegistry, // exposed so tests can register/run/report loops directly
    // Scan 2026-10-15 F2: the value a test client presents on the local-session routes.
    localSession: localSessionExpected,
    launchBroker, // Task 12b: exposed so tests can read a queued record's state/error directly, not only through the HTTP surface's own status codes
    obligationStore, // exposed so tests can exercise store-failure paths directly
    unmergedScanSettled: () => unmergedRefreshSettled, // a scan kicked before close() can still be running after it
    openPrStatesSettled: () => openPrStatesSettled,
    storesClosed, // resolves once close() has closed every sqlite store, which can be after close() itself resolves
    // memoized behind `closingPromise` so this body
    // runs exactly once no matter how many of its callers fire -- the
    // SIGINT/SIGTERM handler's `srv.close()` (CLI entry, below this file's
    // closing brace) and a service-mode serviceRestart's `closeServer`
    // (defaultRestart, above) can both reach this same function around the
    // same restart. Every caller after the first gets the same in-flight (or
    // already-settled) promise back instead of re-stopping the loop
    // registry, re-clearing already-cleared timers, or calling
    // server.close() on an already-closed server.
    close: (closeRef = () => {
      if (closingPromise) return closingPromise;
      closingPromise = (async () => {
        // A close the restart route did not start is a clean stop (service
        // stop, Ctrl+C, a deploy). closeStage names the step an overrun is in.
        noteStop('stop');
        closeStage = 'loop drain';
        loopRegistry.stop();
        eventLoopDelay.stop();
        // stop() only cancels FUTURE
        // scheduled runs; close() had no way to abort the wiki loop's
        // in-flight build child (and its claude -p grandchild), which used
        // to outlive shutdown, and a late onVerified could hit the
        // obligations store closed three lines below. abort() aborts the
        // SAME ctx.signal the maker already receives -- spawnWikiBuild's
        // own abort listener already kills the child tree -- so this needs
        // no wiki-specific process-killing logic here, only naming the loop.
        loopRegistry.abort('wiki', 'server shutting down');
        // glmps-2-0-65: any loop's run still in flight (not only the sweeper
        // and wiki this used to name; plugin-retry was the one seen in the
        // log) ends in record() -> obligations onOk, which writes kernel.db.
        // Bounded so a slow run never hangs shutdown; one that outlives the
        // bound defers closeDb() below instead of having the db closed under it.
        // An abort() after stop() records nothing (M1, task-10-round2-
        // findings.md), so the aborted wiki run leaves its row untouched.
        const loopsDrained = loopRegistry.drain();
        let drainTimer;
        const drainedInTime = await Promise.race([
          loopsDrained.then(() => true),
          new Promise((r) => { drainTimer = setTimeout(() => r(false), 500); drainTimer.unref?.(); }),
        ]);
        clearTimeout(drainTimer);
        await memoryWorker.close().catch(() => {});
        clearInterval(suspendHeartbeat);
        clearInterval(pollTimer); clearInterval(agTimer); clearInterval(invTimer); clearInterval(runnerTimer);
        clearInterval(unmergedRefreshTimer);
        cherryCacheClosed = true;
        {
          let t;
          await Promise.race([cherryCacheSaving, new Promise((r) => { t = setTimeout(r, 500); t.unref?.(); })]);
          clearTimeout(t);
        }
        if (qaTrendsTimer) clearInterval(qaTrendsTimer);
        if (vitalsTrendsTimer) clearInterval(vitalsTrendsTimer);
        if (graphRebuildTimer) clearInterval(graphRebuildTimer);
        if (graphifyVersionTimer) clearInterval(graphifyVersionTimer);
        if (graphifyVersionBootTimer) clearTimeout(graphifyVersionBootTimer);
        // K Task 6: gepaIntervalTimer and pluginRetryTimer are gone - the
        // guard-proposals and plugin-retry loops are cleared by
        // loopRegistry.stop() above, along with every other registered loop.
        // glmps-8: these five were previously fire-and-forget
        // (setInterval(...).unref?.() with no captured handle), so every
        // startServer() call - including each of the 39-odd test files that
        // boot one - leaked an interval per tick that was never cleared here.
        if (memoryDistillTimer) clearInterval(memoryDistillTimer);
        if (finalizeSweepTimer) clearInterval(finalizeSweepTimer);
        clearInterval(memoryUsageTimer);
        if (skillLifecycleTimer) clearInterval(skillLifecycleTimer);
        if (crossAgentMemoryTrialTimer) clearInterval(crossAgentMemoryTrialTimer);
        if (decisionSweepTimer) clearInterval(decisionSweepTimer);
        if (decisionSweepKick) clearTimeout(decisionSweepKick);
        if (measurablesTimer) clearInterval(measurablesTimer);
        // A huddle's claude processes must not outlive the server. Unlike POST
        // /end, shutdown does NOT wait for end() in full: serviceRestart races
        // close() against SERVICE_RESTART_CLOSE_TIMEOUT_MS (8 s) and exits 75,
        // so an unbounded wait would skip the pool close (orphan claude
        // processes) and scut.stop() below. Interrupt every huddle and abort its
        // Gemini seat call (end() would otherwise give it 10 s), give each
        // end() (summary, Slack post) HUDDLE_CLOSE_DEADLINE_MS, then close
        // every pool unconditionally (pool close is idempotent; closing it
        // also fails a hung call, letting a late end() finish on its own).
        // No new huddle starts once this begins.
        closeStage = 'huddle shutdown';
        huddleShuttingDown = true;
        const openHuddles = [...huddles];
        for (const [, rec] of openHuddles) { rec.h.interrupt(); rec.h.abortSeat(); }
        await Promise.all(openHuddles.map(([id, rec]) => {
          let timer;
          const deadline = new Promise((resolve) => {
            timer = setTimeout(() => {
              console.error(`[huddle] huddle ${id} did not end within ${HUDDLE_CLOSE_DEADLINE_MS} ms at shutdown; closing its pool`);
              resolve();
            }, HUDDLE_CLOSE_DEADLINE_MS);
            timer.unref?.();
          });
          const ended = endHuddleRecord(id, rec)
            .catch((e) => console.error(`[huddle] ending huddle ${id} at shutdown failed: ${e?.message ?? e}`));
          return Promise.race([ended, deadline]).finally(() => clearTimeout(timer));
        }));
        for (const [, rec] of openHuddles) rec.pool?.close();
        // A say request still in flight unwinds now that its pool is closed
        // (the hung call fails). Let it answer before server.close() below:
        // a connection still mid-request when server.close() sweeps idle
        // connections stays open after its response and holds close() forever.
        const sayings = openHuddles.map(([, rec]) => rec.saying).filter(Boolean);
        if (sayings.length) {
          let t;
          await Promise.race([Promise.all(sayings), new Promise((r) => { t = setTimeout(r, HUDDLE_SAY_DRAIN_MS); t.unref?.(); })]);
          clearTimeout(t);
          await new Promise((r) => setImmediate(r)); // the route's send() runs after its await
        }
        huddles.clear();
        // Awaited: stop() cancels the pending host tripwire, and that Slack round
        // trip has to finish before the process exits or the alarm survives a
        // clean shutdown and fires against a host that was deliberately stopped.
        closeStage = 'Slack stop';
        await scut?.stop(); // a no-op when SCUT never started
        closeStage = 'HTTP close';
        for (const c of clients) c.end();
        await Promise.all([new Promise(r => server.close(r)), privateServer && new Promise(r => privateServer.close(r))]);
        closeStage = 'store close';
        // glmps-2-0-65: closed only after server.close() has answered every
        // request still in flight (a handler may read or write the store) and
        // after the loop drain above, so nothing uses the handle once it is
        // closed. A closeDb() failure is logged, never thrown out of close().
        const closeObligations = () => {
          try { obligationStore?.closeDb(); }
          catch (e) { console.error('[kernel] obligations store close failed:', e?.message || e); }
          try { clientStore?.closeDb(); }
          catch (e) { console.error('[kernel] clients store close failed:', e?.message || e); }
          try { tapIngest?.closeDb(); }
          catch (e) { console.error('[kernel] tap ingest store close failed:', e?.message || e); }
          try { tapMirror?.closeDb(); }
          catch (e) { console.error('[kernel] tap mirror store close failed:', e?.message || e); }
          try { tapGit?.closeDb(); }
          catch (e) { console.error('[kernel] tap git store close failed:', e?.message || e); }
          resolveStoresClosed();
        };
        if (drainedInTime) closeObligations();
        else {
          console.error('[kernel] loop runs still in flight at shutdown; obligations store closes when they settle');
          loopsDrained.then(closeObligations);
        }
      })();
      return closingPromise;
    }),
  };

  // Boot stages (card glmps-2-0-runtime-93). listen() resolves through a
  // microtask, so everything from the last plugin await to here used to run
  // as one block with the first poll, the inventory scan and the first sweep
  // stacked on top: the kernel's monitor read 2.1 to 4.1 s on every deploy
  // boot and no request could run meanwhile. Each stage now gets its own loop
  // turn, after closeRef is assigned so a request served in between can
  // close the server; a close stops the remaining stages. startServer still
  // resolves after the first poll and a full inventory, as callers expect.
  // A bare setImmediate is not a full turn: when this continuation runs
  // outside the check phase (Node 22 after listen), the immediate fires in the
  // same loop iteration with no timers phase between, so the event-loop
  // monitor saw listen and the first poll as one block (card
  // glmps-2-0-runtime-123). A timer then an immediate always crosses a timers,
  // poll and check phase.
  const nextTurn = () => new Promise((resolve) => setTimeout(() => setImmediate(resolve), 0));
  const bootStages = [
    ['first poll', () => { poll(); checkAgAlive(); }],
    ['inventory', scanInv],
    ['measurables', measurablesTick],
    ['worktree sweep start', () => { sweepWorktrees().catch(() => {}); }],
  ];
  for (const [name, run] of bootStages) {
    await nextTurn();
    bootTrace.waited(`before ${name}`);
    if (closingPromise) break;
    const pending = run();
    if (pending && typeof pending.then === 'function') { await pending; bootTrace.waited(name); }
    else bootTrace.mark(name);
  }
  console.log(`GLMPS: ${bootTrace.line()}`);
  return srv;
}

/**
 * Liveness rule for adapters that export processAliveMs (e.g. agy-cli).
 * heartbeatMs: result of adapter.processAliveMs(P) - ms since epoch of the newest heartbeat file.
 * mtimeMs: mtime of the session's data file (db/jsonl/etc).
 * Returns true when the process heartbeat is fresh AND the session has activity within 8h.
 * @param {number} heartbeatMs
 * @param {number} mtimeMs
 * @param {number} now
 * @param {object} cfg
 * @returns {boolean}
 */
export function genericLive(heartbeatMs, mtimeMs, now, cfg) {
  const heartbeatFresh = (now - heartbeatMs) <= cfg.idleThresholdMs * 10;
  if (!heartbeatFresh) return false;
  return (now - mtimeMs) <= 8 * 3600 * 1000;
}

function readBody(req, { maxBytes = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    // M1/I2: count BYTES (Buffer chunk lengths), and never destroy the request
    // on overflow: stop buffering, let the rest drain unbuffered, and reject so
    // the handler can still answer 413 on the open socket.
    const chunks = []; let n = 0; let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > maxBytes) { over = true; chunks.length = 0; reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      rememberBodyText(req, text);
      resolve(text);
    });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}
// The body text readBody returned for a request, so a SyntaxError is blamed on
// the caller only when that body is itself not JSON. A route catch also wraps
// the route's own reads, and a corrupt state file is the server's fault.
const bodyTexts = new WeakMap();
export function rememberBodyText(req, text) {
  if (req && typeof req === 'object') bodyTexts.set(req, text);
}
function bodyIsInvalidJson(req) {
  const text = req && typeof req === 'object' ? bodyTexts.get(req) : undefined;
  if (typeof text !== 'string' || !text) return false;
  try { JSON.parse(text); return false; } catch { return true; }
}
// For a route with no defaults for an empty body, where '' is the caller's bad
// body rather than {} (card glmps-2-0-228).
function parseRequiredBody(text) {
  try { return JSON.parse(text); } catch (e) { e.fromRequestBody = true; throw e; }
}
// A malformed or oversized request body is the caller's error, not the
// server's: answer it the way the routes that guard their own parse do.
export function bodyErrorReply(e, req) {
  if (e instanceof SyntaxError && (e.fromRequestBody || bodyIsInvalidJson(req))) return [400, { error: 'invalid json' }];
  if (e?.message === 'body too large') return [413, { error: 'body too large' }];
  return [500, { error: e.message }];
}
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return undefined; } }
function writeJsonSafe(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, f);
  } catch {}
}

// CLI entry: `npm start`
if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const configFile = configFileFor({ env: process.env, repoRoot: REPO_ROOT });
  startServer({ configFile }).then((srv) => {
    // Clean shutdown, registered ONLY on the CLI path. Putting this inside
    // startServer() would add a process-wide handler per call, and around forty
    // tests boot a server each (the glmps-8 leaked-handle lesson).
    //
    // This is what keeps the SCUT host tripwire honest. close() cancels the
    // pending "host unreachable" alarm, so a deliberate Ctrl+C or service stop
    // stays silent and the only thing that ever fires the alarm is an actual
    // death. An alarm that cries wolf on every restart gets muted, and a muted
    // alarm is worse than none.
    //
    // Windows caveat: SIGINT arrives for Ctrl+C, but closing the console window
    // does not deliver a catchable signal, so that path still looks like a
    // crash and will fire the alarm.
    let closing = false;
    const shutdown = (signal) => async () => {
      if (closing) return;
      closing = true;
      console.log(`GLMPS: ${signal} received, shutting down cleanly`);
      try { await srv.close(); } catch { /* best effort */ }
      process.exit(0);
    };
    process.once('SIGINT', shutdown('SIGINT'));
    process.once('SIGTERM', shutdown('SIGTERM'));
    // glmps-2-0-58: a crashed WinSW wrapper left this process holding 8123,
    // so every service restart after it died on EADDRINUSE.
    if (process.env.GLMPS_SERVICE === '1') {
      watchParent({ onGone: (pid) => { console.error(`GLMPS: service wrapper (pid ${pid}) is gone, exiting so the service can restart`);
        // A close() that hangs must not keep the port: nobody is left to kill us.
        setTimeout(() => process.exit(1), 10_000).unref();
        shutdown('parent-exit')();
      } });
    }
  });
}
