// server/lib/observability/alert-sources.js
// Turns the signals GLMPS already produces into normalized dashboard alerts. This is the
// wiring layer between flag producers and the alert center (server/lib/observability/alerts.js).
// Seeded with the two readily-available producers; memory-scan drift, done-gate fails, and the
// storm-research security detectors (injection, data egress) plug in the same way.
import { normalizeAlert, rankAlerts, dedupAlerts } from './alerts.js';
import { loopAlerts } from '../loops/loop-health.js';
import { obligationAlerts } from '../kernel/obligation-sweeper.js';
import { KERNEL_HEALTH_IDS } from '../adapters/health.js';
import { formatTime } from '../../../web/shared/time-format.js';

/**
 * @param opts.quarantined        poison-quarantined backlog items [{ id, title, flags, critical, ts }]
 * @param opts.coverage           capture-coverage view { byTool: { id: absoluteCoverage } }
 * @param opts.coverageThreshold  below this (0..1) a tool raises a capture warn (default 0.5)
 * @returns ranked, deduped Alert[]
 */
// the lost pluginHealth
// signals stay visible, routed through the SAME reportMiss/adapterHealth
// registry every capture adapter already uses (server/lib/adapters/health.js)
// - but rendered with a non-capture title ("Kernel health: <id>" instead of
// "Capture drift"/"Capture storm"), so a one-shot kernel failure (a memory
// lookup, a migrate run, a gate-obligation-open write, a corrupt retry-queue
// line, a finalize-sweep tick, the judge plugin failing to load) never reads
// as a third-party capture-tool schema drift.
// The id list itself is KERNEL_HEALTH_IDS in adapters/health.js (Phase K
// final review I4: one list, also filtered by stage-board.js's capture vital).

export function collectAlerts({ quarantined = [], coverage = null, coverageThreshold = 0.5, injections = [], egress = [], attestation = [], unmerged = [], captureIgnore = [], concurrentWriters = [], integrity = [], adapterHealth = null, scutChannelHealth = null, graphSyncHealth = null, graphIntegrity = null, loopHealth = null, obligations = null, guardFailOpen = [], kernelHealth = null, usageCapture = [], actionsMinutes = [], tapSpoolFull = [], tapMirrorQuota = [], certExpiry = [], closedOpenPr = [] } = {}) {
  const raw = [];

  // Certificates of local-only mTLS near or past expiry (card glmps-2-0-152, kernel/cert-expiry.js).
  for (const f of Array.isArray(certExpiry) ? certExpiry : []) {
    if (!f || (f.kind !== 'server-host' && !Number.isFinite(f.notAfter))) continue;
    const when = `${f.expired ? 'expired' : 'expires'} ${formatTime(f.notAfter)}`;
    if (f.kind === 'server') {
      raw.push({
        source: 'cert-expiry', severity: f.expired ? 'critical' : 'warn',
        title: `GLMPS server certificate ${f.expired ? 'expired' : 'expires soon'}`,
        detail: `the certificate the private HTTPS listener presents ${when}; taps and browsers on other machines refuse it once it lapses. Rerun node scripts/provision-server-box.mjs --apply (home) or install a new enterprise certificate, then restart the server.`,
        target: { view: 'clients', notAfter: f.notAfter },
        ts: f.notAfter,
      });
    } else if (f.kind === 'server-host') {
      raw.push({
        source: 'cert-expiry', severity: 'critical',
        title: `GLMPS server certificate does not cover ${f.host}`,
        detail: `the private HTTPS listener binds ${f.host} but its certificate names another address (a DHCP change, most likely), so every tap and browser on another machine fails TLS. Rerun node scripts/provision-server-box.mjs --apply (home) or install a certificate for ${f.host}, then restart the server.`,
        target: { view: 'clients' },
        ts: 0,
      });
    } else if (f.clientId) {
      raw.push({
        source: 'cert-expiry', severity: f.expired ? 'critical' : 'warn',
        title: `Client certificate for ${f.name || f.clientId} ${f.expired ? 'expired' : 'expires soon'}`,
        detail: `the client certificate ${when}; the server refuses that tap once it lapses. Re-pair it before then: use Pair again in the Clients panel and enter the code on that machine; its tap sends a new key and gets a new certificate.`,
        target: { view: 'clients', clientId: f.clientId, notAfter: f.notAfter },
        ts: f.notAfter,
      });
    }
  }

  // Client tap spool past its cap (server-and-client-tap task 9, tap-ingest.js).
  // The tap is dropping status snapshots and heartbeats; the target carries the
  // episode start so an ack covers one episode, not the next.
  for (const f of Array.isArray(tapSpoolFull) ? tapSpoolFull : []) {
    if (!f?.clientId) continue;
    raw.push({
      source: 'tap-spool',
      severity: 'warn',
      title: `Client tap spool full on ${f.name || f.clientId}`,
      detail: `the spool holds ${Math.round((f.bytes ?? 0) / 1048576)} MiB, past its cap, since ${formatTime(f.sinceTs ?? 0)}; ${f.dropped ?? 0} status or heartbeat record(s) dropped. Transcripts and hook records are kept; check the client's connection to the server.`,
      target: { view: 'clients', clientId: f.clientId, since: f.sinceTs ?? 0 },
      ts: f.lastTs ?? f.sinceTs ?? 0,
    });
  }

  // Client file mirror at its quota (task 10, tap-mirror-store.js): new bytes
  // from that client are refused until space is freed or the quota is raised.
  const gib = (n) => Math.round(((n ?? 0) / 1024 ** 3) * 10) / 10;
  for (const f of Array.isArray(tapMirrorQuota) ? tapMirrorQuota : []) {
    if (!f?.clientId) continue;
    raw.push({
      source: 'tap-mirror',
      severity: 'warn',
      title: `Client file mirror full on ${f.name || f.clientId}`,
      detail: `the mirror holds ${gib(f.usedBytes)} GiB of its ${gib(f.quotaBytes)} GiB quota, since ${formatTime(f.sinceTs ?? 0)}; new transcript bytes from this client are being refused. Raise tap.mirrorQuotaBytes in config.json or remove old client mirror files.`,
      target: { view: 'clients', clientId: f.clientId, since: f.sinceTs ?? 0 },
      ts: f.lastTs ?? f.sinceTs ?? 0,
    });
  }

  // GitHub Actions monthly minutes (glmps-2-0-73, actions-minutes.js). The
  // target carries the month and threshold (or the refused episode's start)
  // so an ack covers one crossing, not the next month's.
  for (const f of Array.isArray(actionsMinutes) ? actionsMinutes : []) {
    if (f?.kind === 'threshold') {
      raw.push({
        source: 'actions-minutes',
        severity: f.critical ? 'critical' : 'warn',
        title: `GitHub Actions minutes past ${f.threshold}% of the monthly allowance`,
        detail: `${f.billed} of ${f.allowance} billed minutes used in ${f.month} (${f.usedPercent}%), measured from job start/end times. Jobs are refused once the allowance and spending limit run out.`,
        target: { view: 'analytics', month: f.month, threshold: f.threshold },
        ts: 0,
      });
    } else if (f?.kind === 'nightly-red') {
      raw.push({
        source: 'actions-minutes',
        severity: 'warn',
        title: `Nightly ${f.workflow} run is red on ${f.repo}`,
        detail: `the newest scheduled run (${f.runId}${f.branch ? `, ${f.branch}` : ''}) ended ${f.conclusion}. PRs run no CI checks, so this is the only Linux and Node 22/26 signal. https://github.com/${f.repo}/actions/runs/${f.runId}`,
        target: { view: 'analytics', repo: f.repo, workflow: f.workflow, runId: f.runId },
        ts: Date.parse(f.createdAt) || 0,
      });
    } else if (f?.kind === 'nightly-blind') {
      const repos = Array.isArray(f.repos) ? f.repos : [];
      raw.push({
        source: 'actions-minutes',
        severity: 'warn',
        title: 'Nightly CI results are not being read',
        detail: `the run listing fell back to the minutes-only filter for ${repos.map((r) => r.repo).join(', ')} (${repos[0]?.error ?? 'unknown error'}), so a red nightly run would raise no alert. Rebuild the desktop app if it predates card glmps-2-0-runtime-132; a one-off gh failure clears on the next refresh.`,
        target: { view: 'analytics', month: f.month, nightlyBlind: true },
        ts: 0,
      });
    } else if (f?.kind === 'refused') {
      raw.push({
        source: 'actions-minutes',
        severity: 'critical',
        title: 'GitHub Actions is refusing CI jobs',
        detail: `no job has run since ${f.since}; ${f.billed} of ${f.allowance} billed minutes used in ${f.month}. Raise the spending limit or wait for the monthly reset.`,
        target: { view: 'analytics', since: f.since },
        ts: Date.parse(f.since) || 0,
      });
    }
  }

  // Statusline usage tap (glmps-2-0-runtime-3, usage-capture-health.js). The
  // target carries the episode key (the displaced command, or the last record
  // time) so an ack covers one outage, not every later one; the title never
  // carries the live-session count, which changes tick to tick.
  for (const f of Array.isArray(usageCapture) ? usageCapture : []) {
    if (f?.kind === 'displaced') {
      raw.push({
        source: 'usage-capture',
        severity: 'critical',
        title: 'Usage capture disconnected: statusline tap not in settings.json',
        detail: `statusLine.command is ${f.command ? `"${f.command}"` : 'unset'}; no cost or token usage is being recorded. Re-run scripts/install.mjs to restore it.`,
        target: { view: 'analytics', command: f.command ?? null },
        ts: 0,
      });
    } else if (f?.kind === 'silent') {
      raw.push({
        source: 'usage-capture',
        severity: 'warn',
        title: 'Usage capture silent while Claude Code sessions are active',
        detail: `no usage record since ${f.lastRecordMs ? formatTime(f.lastRecordMs) : 'ever'} (over ${f.silentHours}h) while ${f.liveSessions} Claude Code session(s) were active; check the statusline tap.`,
        target: { view: 'analytics', since: f.lastRecordMs ?? 0 },
        ts: f.lastRecordMs ?? 0,
      });
    }
  }

  // SCUT Slack channel poll failures (glmps-44). Same shape of gap
  // as capture-health below: a channel that cannot read its own thread used
  // to log to a spawned child process's stderr and nothing else, so the
  // dashboard showed a perfectly healthy, live session that would never hear
  // the operator again. The snapshot's `critical` flag is computed by
  // server/lib/scut/channel-health.js#scutChannelHealth (auth/scope errors
  // read critical immediately; anything else only after several polls
  // straight) - this block just renders it, the same division of labor
  // adapterHealth uses.
  //
  // Title and target are built ONLY from fields that stay fixed for the life
  // of a channel (channel id, ticket) - never from `lastReason`, which
  // changes tick to tick. alerts.js derives the dedup/ack id from
  // source::title::target, so a stable title is what keeps one unresolved
  // failure as ONE ackable alert instead of minting a new one every poll.
  for (const [id, h] of Object.entries(scutChannelHealth && typeof scutChannelHealth === 'object' ? scutChannelHealth : {})) {
    if (!h || !h.degraded) continue;
    raw.push({
      source: 'scut-channel',
      severity: h.critical ? 'critical' : 'warn',
      title: `SCUT channel can't read its thread: ${h.channel ?? id}`,
      detail: `${h.lastReason ?? 'poll failed'} (${h.failures ?? 0} failure(s) since ${h.firstFailTs ? formatTime(h.firstFailTs) : 'unknown'})`,
      target: { view: 'kanban', id: h.ticket ?? null },
      ts: h.lastFailTs ?? 0,
    });
  }

  // Capture health (glmps-72). A degraded adapter used to reach the
  // UI only as a vitals field on /api/state, where it sat indefinitely without
  // raising anything anyone would notice. That is precisely how the agy-cli
  // re-drain defect (208 false misses per second) ran unnoticed: a saturated
  // alarm nobody is watching is an absent alarm.
  //
  // The rate, not the total, decides severity. An occasional miss as an
  // upstream tool shifts its schema is a warn; a sustained storm is a
  // different failure and must read differently, because the total alone
  // cannot tell them apart, which was the original defect.
  for (const [id, h] of Object.entries(adapterHealth && typeof adapterHealth === 'object' ? adapterHealth : {})) {
    if (!h || !h.degraded) continue;
    if (KERNEL_HEALTH_IDS.has(id)) {
      // a kernel signal, not a capture one - a non-"Capture drift" title
      // and a kernel-scoped severity (3+ misses is critical, matching the
      // deleted pluginHealth tracker's own consecutive threshold), never the
      // rate-based "storm" framing that only makes sense for a high-volume
      // capture adapter.
      raw.push({
        source: 'kernel-health',
        severity: (h.misses ?? 0) >= 3 ? 'critical' : 'warn',
        title: `Kernel health: ${id}`,
        detail: h.lastReason ?? 'failed',
        // firstMissTs rides in `target` (deriveId's dedup key,
        // alerts.js), not just severity/detail - health.js's clearMiss()
        // deletes the registry entry on a success, so a LATER reportMiss()
        // starts a fresh firstMissTs and therefore a fresh alert id. Without
        // this, a stable id ("kernel-health"::title::{view:'loops'}) would
        // let one old operator ack hide every future recurrence forever,
        // cleared or not (alert-acks.js's own re-alert guarantee already
        // documents this exact "target carries an episode key" convention).
        target: { view: 'loops', since: h.firstMissTs ?? 0 },
        ts: h.lastMissTs ?? 0,
      });
      continue;
    }
    const perMin = Number.isFinite(h.missesPerMin) ? h.missesPerMin : 0;
    const storm = perMin >= 60;
    raw.push({
      source: 'capture-health',
      severity: storm ? 'critical' : 'warn',
      title: storm ? `Capture storm: ${id}` : `Capture drift: ${id}`,
      detail: `${h.lastReason ?? 'record shape no longer matches'} (${perMin}/min, ${h.misses ?? 0} total)`,
      target: { view: 'analytics', tool: id },
      ts: h.lastMissTs ?? 0,
    });
  }

  // mem0/gepa quarantine and the plugin-retry dead-letter gave-up count,
  // recomputed fresh from their own ndjson files every call (via the SAME
  // refresh functions memory-plugin.js/gepa-plugin.js already export - see
  // server.js's collectCurrentAlerts) into a tiny array-collecting stand-in
  // for the deleted pluginHealth tracker's own `.set`/`.ok` shape.
  for (const [name, h] of Object.entries(kernelHealth && typeof kernelHealth === 'object' ? kernelHealth : {})) {
    if (!h) continue;
    raw.push({
      source: 'kernel-health',
      severity: h.level ?? ((h.consecutive ?? 1) >= 3 ? 'critical' : 'warn'),
      title: `Kernel health: ${name}`,
      detail: h.lastReason ?? 'failed',
      target: { view: 'loops' },
      ts: h.ts ?? 0,
    });
  }

  // Reconciliation integrity findings (handoff B5): skipped_gates,
  // orphaned_artifact and ungated_reflex. Without this they were emitted to
  // the spine and read by nothing the operator opens.
  //
  // Findings arrive in the handoff's B3 shape (check_name, desk, severity,
  // details), not this codebase's usual camelCase, because morning-brief.js
  // already reads them that way. Matching a live consumer beats a blanket
  // style rule.
  //
  // 'info' is deliberately not an alert: promoting a note would train the
  // operator to ignore the panel.
  for (const f of Array.isArray(integrity) ? integrity : []) {
    if (!f || !f.check_name) continue;
    // The checks emit 'critical'; 'error' is the handoff's older name for it.
    const critical = f.severity === 'critical' || f.severity === 'error';
    if (!critical && f.severity !== 'warn') continue;
    // The title carries check AND subject (the gate, artifact or lesson)
    // because alerts.js derives the ack id from source::title::target: two
    // findings of the same check on different subjects must not collapse into
    // one ackable alert.
    const scope = f.desk ?? f.data?.gateName ?? f.data?.ref ?? f.data?.lessonId ?? null;
    raw.push({
      source: 'integrity',
      severity: critical ? 'critical' : 'warn',
      title: scope ? `Integrity: ${f.check_name} (${scope})` : `Integrity: ${f.check_name}`,
      detail: f.details ?? 'a reconciliation check fired',
      target: { view: 'learning' },
      ts: 0,
    });
  }

  // Concurrency hygiene (2026-07-15 collision): 2+ live sessions sharing ONE
  // working tree (one .git/HEAD) with no worktree isolation can silently
  // overwrite each other's edits. One alert per shared tree; the SessionStart
  // warn hook (hooks/concurrency-warn.js) is the pre-emptive counterpart.
  for (const g of concurrentWriters) {
    const ids = ((g && g.sessions) || []).map((s) => s && s.id).filter(Boolean);
    if (ids.length < 2) continue;
    const base = String((g && g.cwd) || '').split('/').pop() || (g && g.cwd) || 'a working tree';
    raw.push({
      source: 'concurrent-writers',
      severity: 'warn',
      title: `${ids.length} sessions sharing one working tree: ${base}`,
      detail: `live sessions ${ids.slice(0, 6).join(', ')} share ${g.cwd} with no worktree isolation \u2014 ` +
        `edits can silently overwrite each other; isolate one (git worktree) or commit early`,
      target: { view: 'sessions', id: ids[0] },
      ts: 0,
    });
  }

  // Process hygiene: finished-but-unmerged branches (stale, patch-ahead of the
  // default branch, no open ticket references them). The recurring lost-work miss.
  // Repos with many findings (e.g. machine-generated run branches) collapse into
  // one summary alert so a branch-farm repo can't drown the alert center.
  const unmergedByProject = new Map();
  for (const f of unmerged) {
    if (!unmergedByProject.has(f.project)) unmergedByProject.set(f.project, []);
    unmergedByProject.get(f.project).push(f);
  }
  const idleDaysOf = (f) => f.lastCommitMs ? Math.max(0, Math.round((Date.now() - f.lastCommitMs) / 86400000)) : null;
  for (const [project, fs] of unmergedByProject) {
    if (fs.length > 3) {
      raw.push({
        source: 'unmerged-branch',
        severity: 'warn',
        title: `${fs.length} unmerged branches in ${project}`,
        detail: `stale branches with unmerged commits and no open ticket: ${fs.map(f => f.branch).slice(0, 6).join(', ')}${fs.length > 6 ? ', \u2026' : ''} \u2014 merge, file tickets, or prune`,
        target: { view: 'kanban', project },
        ts: 0,
      });
      continue;
    }
    for (const f of fs) {
      const idleDays = idleDaysOf(f);
      // A session-worktree branch (glmps-71 A4) carries the sessionId the
      // sweeper refused to touch (it had unmerged commits) - link straight to
      // the session instead of just the project's kanban, and say so.
      const isSessionWorktree = typeof f.branch === 'string' && f.branch.startsWith('session/');
      const target = f.sessionId ? { view: 'sessions', id: f.sessionId } : { view: 'kanban', project: f.project };
      const detail = isSessionWorktree
        ? `${f.unmerged} unmerged commit(s)${idleDays != null ? `, idle ~${idleDays}d` : ''} \u2014 ended session worktree \u2014 merge it or file a ticket`
        : `${f.unmerged} unmerged commit(s)${idleDays != null ? `, idle ~${idleDays}d` : ''} \u2014 no open ticket references it; merge it or file a ticket`;
      raw.push({
        source: 'unmerged-branch',
        severity: 'warn',
        title: `Unmerged branch: ${f.project}:${f.branch}`,
        detail,
        target,
        ts: 0,
      });
    }
  }

  // glmps-2-0-191: a card closed while its PR is still open. One alert per card,
  // titled by id so the ack id (source::title::target) stays stable per card.
  for (const f of closedOpenPr) {
    raw.push({
      source: 'closed-card-open-pr',
      severity: 'warn',
      title: `Card ${f.id} is ${f.state} but its PR is still open`,
      detail: `${f.title ?? f.id}: ${f.prUrl}; merge it, close it, or reopen the card`,
      target: { view: 'kanban', project: f.project },
      ts: 0,
    });
  }

  // Governance: live prompt-injection hits in captured session content.
  // Capped at 'warn' until the detector is calibrated (it over-fires on sessions whose content
  // is legitimately about injection - see injection-detect.js). Don't cry wolf at 'critical'.
  for (const f of injections) {
    raw.push({
      source: 'injection',
      severity: 'warn',
      title: `Possible prompt injection${f.code ? ` (${f.code})` : ''}`,
      detail: `in a ${f.tool || f.kind || 'session'} event${f.sample ? ` \u2014 "${f.sample}"` : ''}`,
      target: { view: 'sessions', id: f.sessionId },
      ts: 0,
    });
  }

  // Governance: sensitive-data egress - secret/prod-zone content touched by an agent.
  for (const f of egress) {
    const base = String(f.path || '').replace(/\\/g, '/').split('/').pop() || f.path;
    raw.push({
      source: 'egress',
      severity: f.severity === 'critical' ? 'critical' : 'warn',
      title: `Sensitive data touched: ${base}`,
      detail: f.reason === 'secret' ? 'a secret/credential file was accessed by an agent session' : 'protected/prod-zone content in an agent session',
      target: { view: 'sessions', id: f.sessionId, path: f.path },
      ts: 0,
    });
  }

  // Poison-quarantined backlog tickets - something the operator must review before it can run.
  for (const t of quarantined) {
    raw.push({
      source: 'poison',
      severity: t.critical ? 'critical' : 'warn',
      title: `Quarantined: ${t.title ?? t.id}`,
      detail: Array.isArray(t.flags) && t.flags.length ? `flags: ${t.flags.join(', ')}` : 'poison-scan flagged this ticket',
      target: { view: 'kanban', id: t.id },
      ts: t.ts ?? 0,
    });
  }

  // Capture-coverage below threshold - a tool whose sessions we are under-capturing.
  if (coverage && coverage.byTool) {
    for (const [tool, score] of Object.entries(coverage.byTool)) {
      if (captureIgnore.includes(tool)) continue; // known/ticketed gap - standing noise
      if (typeof score === 'number' && score < coverageThreshold) {
        const none = score <= 0;
        raw.push({
          source: 'capture',
          severity: 'warn',
          title: none ? `No capture adapter: ${tool}` : `Low capture coverage: ${tool}`,
          detail: none ? 'sessions from this tool are not captured' : `${Math.round(score * 100)}% of wanted signal captured`,
          target: { view: 'analytics', tool },
          ts: 0,
        });
      }
    }
  }

  // Guardrail attestation - findings already carry the correct severity.
  // Critically-missing/modified guardrails stay critical (NOT capped unlike injection alerts,
  // because attestation findings are precise: a guardrail is verifiably gone or modified).
  for (const f of attestation) {
    raw.push({
      source: f.source ?? 'attestation',
      severity: f.severity === 'critical' ? 'critical' : 'warn',
      title: f.title ?? 'Guardrail finding',
      detail: f.detail ?? '',
      target: f.target ?? { view: 'governance' },
      ts: 0,
    });
  }

  // Graph sync outcomes (glmps-86). graphify exits 0 whether it
  // updated, did nothing, or REFUSED to write, so a frozen graph used to look
  // exactly like a healthy one. Only refused/failed raise; a no-op is a
  // legitimate outcome. Title carries the root only - never the node counts -
  // so one standing failure stays ONE ackable alert.
  for (const [root, h] of Object.entries(graphSyncHealth && typeof graphSyncHealth === 'object' ? graphSyncHealth : {})) {
    if (!h || (h.outcome !== 'refused' && h.outcome !== 'failed')) continue;
    const name = String(root).replace(/\\/g, '/').split('/').filter(Boolean).pop() || root;
    raw.push({
      source: 'graph-sync',
      severity: (h.consecutive ?? 1) >= 5 ? 'critical' : 'warn',
      title: `Graph sync ${h.outcome}: ${name}`,
      detail: `${h.reason || h.outcome} (${h.consecutive ?? 1} consecutive; agents are told to query this graph before grepping)`,
      target: { view: 'map', project: name },
      ts: h.ts ?? 0,
    });
  }

  // Graph shape collapse (upgrade-plan item 7). A root whose node count fell
  // below the integrity store's ratio of its baseline. Distinct from
  // graph-sync: a collapse is usually written by a run that reports success,
  // and by the post-commit hook, which never passes through the sync record.
  for (const [root, g] of Object.entries(graphIntegrity && typeof graphIntegrity === 'object' ? graphIntegrity : {})) {
    if (!g || !g.collapsed || !g.last || !g.baseline) continue;
    const name = String(root).replace(/\\/g, '/').split('/').filter(Boolean).pop() || root;
    raw.push({
      source: 'graph-integrity',
      severity: 'critical',
      title: `Graph collapsed: ${name}`,
      detail: `${g.last.nodes} nodes / ${g.last.edges} edges, down from ${g.baseline.nodes} / ${g.baseline.edges} (built_at_commit ${g.last.builtAtCommit ?? 'none'}); queries against this graph miss most of the code`,
      target: { view: 'map', project: name },
      ts: g.last.ts ?? 0,
    });
  }

  // K3 loop-health: the loop registry's own failures. K Task 6
  // deleted the pre-D23 consecutive-failure block that used to live here
  // (Mem0, embed, judge, GEPA, the retry queue): those signals are now the
  // registered memory-admission / session-judge / guard-proposals /
  // plugin-retry loops (server/lib/loops/plugin-loops.js), and this is
  // their alert - one health source, one alert block, per plugin-loops.js's
  // own header comment.
  for (const a of loopAlerts(loopHealth)) raw.push(a);

  // K4 obligation expiries: a loop-freshness (or gate-verdict) row
  // that missed its due time. Rendered the same way as loopHealth just
  // above - both are the same registry's own overdue work, just tracked in
  // two different stores (in-memory failure streaks vs. the durable
  // obligations table).
  for (const a of obligationAlerts(obligations)) raw.push(a);

  // a guard hook's own fail-open log (the caller reads the last
  // 24h of <stateDir>/guards/fail-open.ndjson lines and passes them here
  // verbatim: {ts, hook, cardId, reason}). One alert per hook, using the
  // newest occurrence, so a standing board outage stays one ackable alert
  // instead of minting a fresh one on every tool call the outage touched.
  // {view:'loops'} IS a real, resolvable target: web/app.js's VIEW_REDIRECTS
  // maps the retired 'loops' name to 'substrate-loop' (K3 loop-health alerts
  // use the same redirect) - round 1 fix: an earlier version of this comment
  // wrongly claimed 'loops' does not exist and used 'guardrails' instead;
  // reverted to the brief's target.
  const newestFailOpenByHook = new Map();
  for (const f of Array.isArray(guardFailOpen) ? guardFailOpen : []) {
    if (!f || !f.hook) continue;
    const prev = newestFailOpenByHook.get(f.hook);
    if (!prev || (f.ts ?? 0) > (prev.ts ?? 0)) newestFailOpenByHook.set(f.hook, f);
  }
  for (const [hook, f] of newestFailOpenByHook) {
    raw.push({
      source: 'guard',
      severity: 'warn',
      title: `Guard failed open: ${hook}`,
      detail: f.reason ?? 'a guard could not evaluate and allowed the edit',
      target: { view: 'loops' },
      ts: f.ts ?? 0,
    });
  }

  return rankAlerts(dedupAlerts(raw.map(normalizeAlert)));
}

/**
 * Attach file-change evidence to session-linked alerts so the Alerts page can show
 * the exact file(s) + diffs. For each alert whose target is a session, collect that
 * session's file-write events (which carry a `.change` diff), preferring the flagged
 * path when the alert names one. Non-session alerts get an empty evidence list.
 * Pure over its inputs.
 */
export function attachEvidence(alerts, events, { max = 8 } = {}) {
  const evs = Array.isArray(events) ? events : [];
  return (Array.isArray(alerts) ? alerts : []).map((a) => {
    const t = a.target;
    if (!t || t.view !== 'sessions' || !t.id) return { ...a, evidence: [] };
    let writes = evs.filter((e) => e && e.sessionId === t.id && e.op === 'write' && e.change);
    if (t.path) {
      const norm = String(t.path).replace(/\\/g, '/');
      const onPath = writes.filter((e) => String(e.path || '').replace(/\\/g, '/') === norm);
      if (onPath.length) writes = onPath;
    }
    const evidence = writes.slice(0, max).map((e) => ({
      path: e.path ?? null, change: e.change ?? null, ts: e.ts ?? 0, tool: e.tool ?? null,
    }));
    return { ...a, evidence };
  });
}
