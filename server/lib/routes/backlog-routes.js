// The card-handling routes (card glmps-2-0-220): filing, the board read,
// pause and reorder, and per card approve, devlog, progress, gate, read,
// update, delete and worktree purge. Moved line for line from the request
// handler's inline chain; startServer registers them and passes its own
// state in `deps`. A route flagged clientOwnsCard is one a paired client may
// call only on a card it filed (checked in the request preamble).
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as backlogStore from '../orchestration/backlog-store.js';
import * as runnerStore from '../orchestration/runner-store.js';
import * as learningStore from '../evaluation/learning-store.js';
import { writeJsonBody } from '../http-json.js';
import { presentedTokenFrom, tokenMatches, LOCAL_SESSION_HEADER } from '../governance/access-guard.js';
import { gateCheck } from '../governance/actors.js';
import { normalizeModelField } from '../orchestration/vendor-agents.js';
import { relevantFilesFor, deferredRefsFor } from '../orchestration/ticket-enrich.js';
import { openChildren } from '../orchestration/queue-runner.js';
import { readWorkspace, writeDeclared } from '../orchestration/workspace-store.js';
import { reportMiss } from '../adapters/health.js';
import { scoreAltitude } from '../scut/altitude.js';
import { declarePlan as scutDeclarePlan } from '../scut/progress-store.js';
import { verdict as verifyVerdict, fromGateStatus as verifyFromGateStatus } from '../orchestration/verify.js';
import { criticDisagreement } from '../evaluation/cross-model-eval.js';
import { safeSeg as wtSafeSeg, isUnderDir, listWorktreesRecipe, parseWorktreeList, pathsEqual } from '../orchestration/worktrees.js';
import { upsertGapAndApply } from '../evaluation/gap-pipeline.js';
import { jobIdFromRunnerBranch } from '../orchestration/worktree-sweeper.js';

export function registerBacklogRoutes(registerRoute, deps) {
  const {
    P, cfg, actors, accessToken, readBody, CLIENT_BACKLOG_STATES, clientPatchRefusal,
    broadcastBacklog, haltMergeQueue, promoteAfterClose, recordGate, removeWorktree, repoForProject,
    resolveActor, resolveProjectName, runJobNow, runRecipe, sessionSummaries, getScut, getLocalSessionExpected,
  } = deps;

  registerRoute({
    method: 'GET', pattern: '/api/backlog',
    handle: async (req, res, { params, send, url, access }) => {
      // Archiving is rare; test it on the cached read and only take the
      // load-mutate-save path when a card is actually due.
      const archiveDays = cfg.backlog?.archiveDays ?? 7;
      if (backlogStore.sweepArchive(backlogStore.readView(P.stateDir), { days: archiveDays }).moved.length) {
        if (backlogStore.sweepArchiveIn(P.stateDir, { days: archiveDays }).moved.length) broadcastBacklog();
      }
      // The shell's nav badge needs only these numbers, not the 2 MB list.
      if (url.searchParams.get('counts') === '1') {
        return send(200, { counts: backlogStore.countsByState(P.stateDir) });
      }
      // The cards named by a backlog event, not the whole board.
      const idsParam = url.searchParams.get('ids');
      if (idsParam != null) {
        const ids = idsParam.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
        const got = backlogStore.itemsByIds(P.stateDir, ids);
        return send(200, { ...got, epoch: backlogStore.BOARD_EPOCH, version: backlogStore.boardVersion(P.stateDir) });
      }
      const project = url.searchParams.get('project') ?? undefined;
      const status = url.searchParams.get('status') ?? undefined;
      const fieldsParam = url.searchParams.get('fields') ?? '';
      const buildBoard = () => {
        const loaded = backlogStore.readView(P.stateDir);
        let items = backlogStore.listItems(loaded, { project, status });
        // A map needs a few fields per card, not each card's devlog and prompt
        // (the full list is megabytes).
        const fields = fieldsParam.split(',').map((f) => f.trim()).filter(Boolean);
        if (fields.length) items = items.map((i) => Object.fromEntries(fields.filter((f) => f in i).map((f) => [f, i[f]])));
        // glmps-15: surface gate-less closes (done without a PASS/WAIVED
        // gate) over the whole project set, independent of the status filter, so
        // the board can flag them even when a non-done column is selected.
        const all = loaded.items;
        const scoped = project == null ? all : all.filter((i) => i.project === project);
        // An unreadable store serves an empty board; say so, or it reads as a
        // genuinely empty one while every write is refused.
        const loadError = loaded.loadError
          ? { ...loaded.loadError, recover: 'the board is read-only until backlog/store.json reads again; restore it from backlog/store.json.bak' }
          : undefined;
        return { items, gatelessDone: backlogStore.gatelessDoneIds(scoped), epoch: backlogStore.BOARD_EPOCH, version: backlogStore.boardVersion(P.stateDir), ...(loadError ? { loadError } : {}) };
      };
      // Concurrent readers of one board version share a single serialization.
      const key = `board:${project ?? ''}:${status ?? ''}:${fieldsParam}`;
      const json = backlogStore.memoView(P.stateDir, key, () => JSON.stringify(buildBoard()));
      return writeJsonBody(req, res, 200, json, {}, () => backlogStore.memoView(P.stateDir, `${key}:gz`, () => zlib.gzipSync(json, { level: 4 })));
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/backlog',
    handle: async (req, res, { params, send, url, access }) => {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      if (!body.title || !String(body.title).trim()) return send(400, { error: 'empty title' });
      // Scan F3: a paired client's token is a remote credential the operator
      // did not type, so its card is filed the way /api/ingest/backlog-ticket
      // files one: deferred source, external trust, parked, attributed to the
      // client. Only the operator moves it to queued.
      const clientId = access.clientId ?? null;
      if (clientId && body.state != null && !CLIENT_BACKLOG_STATES.has(body.state)) {
        return send(403, { error: 'client-scope', field: 'state', allowed: [...CLIENT_BACKLOG_STATES] });
      }
      const pinned = clientId
        // operatorApproved is the operator's sign-off on a follow-up, so a
        // client never carries it past the follow-up approval gate.
        ? { source: 'deferred', state: body.state ?? 'held', mode: null, actor: `client:${clientId}`, origin: { via: 'client', clientId },
            operatorApproved: undefined, outOfScope: undefined, requiredRole: undefined, model: undefined }
        : null;
      const added = backlogStore.addItemTo(P.stateDir, {
        project: body.project, title: String(body.title).trim(), prompt: body.prompt, state: body.state,
        // Honor the caller-declared source (docs: agents POST {source:'deferred'}). It drives
        // poison-scan trust: a non-operator source => external trust => quarantine on ANY flag,
        // per docs/agent-poisoning-safeguards.md. A source-less post (e.g. the dashboard) still
        // defaults to 'manual'/operator in backlog-store. HTTP can't verify operator identity,
        // so it can't upgrade an agent post to operator trust; a lying source:'manual' is no
        // worse than the pre-fix default, and critical-severity content quarantines regardless.
        source: body.source,
        origin: body.origin, priority: body.priority,
        description: body.description, acceptanceCriteria: body.acceptanceCriteria,
        relevantFiles: body.relevantFiles, deferredRefs: body.deferredRefs,
        assignee: body.assignee, dueDate: body.dueDate, blockedBy: body.blockedBy,
        spec: body.spec,
        // Attribution (glmps-72 B1): who filed this ticket - a presented token
        // mapped to a configured actor, else this server's local default.
        actor: resolveActor(req), requiredRole: body.requiredRole,
        parentId: body.parentId, mode: body.mode, model: body.model,
        operatorApproved: body.operatorApproved, outOfScope: body.outOfScope,
        ...pinned,
      }, { requireIntent: true, requireFollowUpApproval: true, resolveProject: resolveProjectName, ...(clientId ? { trust: 'external' } : {}) });
      const { item } = added;
      if (!item) return send(added.status ?? 400, { error: added.error, ...(added.hint ? { hint: added.hint } : {}) });
      // Best-effort enrichment: graphify file hints + deferred-work cross-refs.
      try {
        let files = item.relevantFiles;
        if (!files.length) {
          files = await relevantFilesFor({ repo: repoForProject(item.project), title: item.title, description: item.description });
        }
        const all = backlogStore.load(P.stateDir).items;
        const refs = item.deferredRefs.length ? item.deferredRefs
          : deferredRefsFor(all, { ...item, relevantFiles: files });
        if (files.length || refs.length) {
          const r = backlogStore.updateItemIn(P.stateDir, item.id, { relevantFiles: files, deferredRefs: refs });
          if (r.item) Object.assign(item, r.item);
        }
      } catch { /* enrichment must never block filing */ }
      broadcastBacklog();
      return send(201, item);
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/backlog/pause',
    handle: async (req, res, { params, send, url, access }) => {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const s = backlogStore.setPausedIn(P.stateDir, !!body.paused);
      if (s.paused) haltMergeQueue();
      broadcastBacklog();
      return send(200, { paused: s.paused });
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/backlog/reorder',
    handle: async (req, res, { params, send, url, access }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      if (!Array.isArray(body.ids)) return send(400, { error: 'ids must be an array' });
      const { items } = backlogStore.reorderItemsIn(P.stateDir, { ids: body.ids, status: body.status, project: body.project });
      broadcastBacklog();
      return send(200, { items });
    },
  });
  // Operator-only release of a poison-quarantined card (human-in-the-loop).
  // Gate choke point 1/3 (glmps-72 B3): requires the 'promote' role once
  // cfg.actors is configured; a permanent no-op in solo mode (actors: []).
  // glmps-81 Phase 4 note: NOT wrapped over request-info.js's pending-request
  // primitive (unlike memory-writer.js's proposal seam) - backlogStore holds
  // quarantine state inside its single monolithic items array, not a
  // per-id file, so a byte-identical wrapper would need either a risky
  // dual-write or a rewrite of backlog-store.js's data model. Left as-is
  // per the safety-over-completeness rule; documented follow-up ticket.
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/approve',
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      if (actors.length) {
        const actorId = resolveActor(req);
        const gate = gateCheck({ actors, actorId, role: 'promote' });
        if (!gate.allowed) {
          backlogStore.appendDevLogIn(P.stateDir, id, { by: actorId ?? 'unknown', text: `poison-approve denied: ${gate.reason}` });
          return send(403, { error: 'forbidden', reason: gate.reason });
        }
      }
      const r = backlogStore.approveItemIn(P.stateDir, id);
      if (!r.item) return send(404, { error: 'item not found' });
      broadcastBacklog();
      // Approval of a scut ticket is a RELEASE, not just an un-flag: the
      // mention would have launched at intake had the poison scan not held it
      // (scutLaunch), and the queue runner is opt-in and off by default, so
      // nothing else ever claims the ticket. Resume that deferred launch here
      // with the same Run-now semantics scutLaunch uses (no act gate, honors
      // maxConcurrent). A non-200 leaves the ticket queued and reports the
      // reason instead of failing the approve; other sources keep the old
      // behavior - the board is a tracker, not a scheduler.
      if (r.item.source !== 'scut') return send(200, r.item);
      const run = await runJobNow(id);
      const launch = { started: run.status === 200, note: run.status === 200 ? null : (run.body?.error ?? null) };
      getScut()?.ticketReleased({ ticketId: id, ...launch });
      const released = backlogStore.load(P.stateDir).items.find(i => i.id === id) ?? r.item;
      return send(200, { ...released, launch });
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/devlog', clientOwnsCard: true,
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const r = backlogStore.appendDevLogIn(P.stateDir, id, { by: body.by, text: body.text });
      if (r.error) return send(400, { error: r.error });
      if (!r.item) return send(404, { error: 'item not found' });
      broadcastBacklog();
      // Relay the agent's own words into its Slack room, if it came from one.
      // This is why SCUT needs no endpoint of its own: the agent already
      // narrates here, so the room subscribes rather than the agent learning a
      // second, Slack-only way to speak.
      getScut()?.agentSaid({ ticketId: id, kind: 'devlog', text: body.text, by: body.by });
      // Reporting altitude (glmps-78). ADVISORY ONLY: the text was
      // already stored and relayed above, byte-identical, and nothing here can
      // change that. This hands the author a mirror instead - the response
      // body is the one feedback path that arrives while the writer can still
      // act on it. Attached only when the post actually reads as in-the-weeds,
      // because a field that is always present is a field nobody reads; and
      // only for the agent's own voice, since runner/operator lines are not
      // what the operator complained about.
      const altitude = body.by === 'agent' ? scoreAltitude(body.text) : null;
      if (altitude?.level === 'deep') return send(200, { ...r.item, altitude });
      return send(200, r.item);
    },
  });
  // Declare which plan file this job's progress is measured by
  // (glmps-74, operator ask). Declared ONCE by the agent; the
  // server does the rest, because a mechanism that needed the agent to
  // remember to report would fail in exactly the long heads-down stretch
  // the operator wants visibility into.
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/progress', clientOwnsCard: true,
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const plan = typeof body.plan === 'string' ? body.plan.trim() : '';
      if (!plan) return send(400, { error: 'plan (a repo-relative path to a plan file) is required' });
      if (!runnerStore.loadLedger(P.stateDir)[id]) return send(404, { error: 'no live job for that ticket' });
      // Deliberately NOT stored on the ledger entry: the runner tick does its
      // own read-modify-write of the ledger every few seconds and would clobber
      // this before the progress tick ever saw it. Its own small file has no
      // second writer.
      scutDeclarePlan(P.stateDir, id, plan);
      return send(200, { ticket: id, plan });
    },
  });

  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/gate', clientOwnsCard: true,
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const r = recordGate(id, { status: body.status, evidence: body.evidence, risk: body.risk, by: body.by, summary: body.summary });
      if (r.error) return send(400, { error: r.error });
      if (!r.item) return send(404, { error: 'item not found' });
      // Layered verification (glmps-81 Phase 3): an OPTIONAL `lens` tags
      // which verification layer this gate submission represents ('exec' |
      // 'critic' | 'panel'). Omitting it - every gate call before this
      // landed, and any caller that still doesn't care about verify.js - is
      // the existing path: response stays exactly r.item, byte-identical.
      const GATE_LENSES = new Set(['exec', 'critic', 'panel']);
      const lens = GATE_LENSES.has(body.lens) ? body.lens : null;
      if (!lens) return send(200, r.item);

      const execStatus = verifyFromGateStatus(body.status);
      const checks = [{ gate: lens, status: execStatus, name: `${lens} gate` }];

      // The execution veto is decided here, BEFORE any network call: a
      // failed 'exec' lens submission never dispatches the critic. This is
      // the real (not merely textual) enforcement of "a failed execution
      // check vetoes before any LLM critic runs" - the critic is never
      // invoked, not just outvoted afterward.
      if (lens === 'exec' && execStatus === 'pass') {
        const disagreement = await criticDisagreement({
          question: r.item.title ?? id,
          answer: (Array.isArray(body.evidence) ? body.evidence.filter(e => typeof e === 'string') : []).join('\n')
            || (r.item.description ?? ''),
          apiKey: process.env.ANTHROPIC_API_KEY,
        }).catch(() => null);
        // Fail-open (house convention, same as cross-model-eval.js itself):
        // no API key / network failure -> no critic check is added, and the
        // verdict below falls back to the exec-only result rather than
        // fabricating a critic pass.
        if (typeof disagreement === 'number') {
          const criticStatus = disagreement >= 0.66 ? 'fail' : disagreement >= 0.33 ? 'concerns' : 'pass';
          checks.push({ gate: 'critic', status: criticStatus, name: 'cross-model critic' });
        }
      }

      return send(200, { ...r.item, verify: verifyVerdict(checks) });
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/backlog/:id',
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      const item = backlogStore.load(P.stateDir).items.find(i => i.id === id);
      if (!item) return send(404, { error: 'item not found' });
      return send(200, item);
    },
  });
  registerRoute({
    method: 'PATCH', pattern: '/api/backlog/:id', clientOwnsCard: true,
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      // Scan F3: a client's worker reports its own progress and closes its
      // card, but never queues one or rewrites what the runner would launch,
      // since a PATCH skips the intake poison scan.
      if (access.clientId && body && typeof body === 'object') {
        const refusal = clientPatchRefusal(body);
        if (refusal) return send(403, { error: 'client-scope', ...refusal });
      }
      // Operator-only: this field unlocks the test-file guard, and every agent
      // session reaches this route on loopback, so loopback alone is no proof.
      if (body && typeof body === 'object' && 'testEditsApproved' in body) {
        const operator = tokenMatches(req.headers[LOCAL_SESSION_HEADER], getLocalSessionExpected())
          || tokenMatches(presentedTokenFrom(req.headers), accessToken);
        if (!operator) return send(403, { error: 'operator-only', field: 'testEditsApproved' });
        const v = body.testEditsApproved;
        const approval = v ? { by: 'operator', at: new Date().toISOString(), note: typeof v?.note === 'string' ? v.note : null } : null;
        delete body.testEditsApproved;
        const set = backlogStore.setTestEditsApprovalIn(P.stateDir, id, approval);
        if (!set.item) return send(404, { error: 'item not found' });
        if (Object.keys(body).length === 0) { broadcastBacklog(); return send(200, set.item); }
      }
      if (body && typeof body === 'object' && 'testEditsDeclared' in body) {
        const v = body.testEditsDeclared;
        let declaration = null;
        if (v !== null) {
          const reason = v && typeof v === 'object' && typeof v.reason === 'string' ? v.reason.trim() : '';
          if (!reason || reason.length > 500) return send(400, { error: 'testEditsDeclared.reason must be a non-empty string of at most 500 characters' });
          declaration = { reason, at: new Date().toISOString(), by: 'agent' };
        }
        delete body.testEditsDeclared;
        const set = backlogStore.setTestEditsDeclarationIn(P.stateDir, id, declaration);
        if (!set.item) return send(404, { error: 'item not found' });
        let out = set.item;
        if (declaration) {
          const text = `Editing existing tests on this bug-fix card. Reason given: ${declaration.reason}. No reply needed; reply in this thread if you want the existing tests left alone.`;
          const logged = backlogStore.appendDevLogIn(P.stateDir, id, { by: 'system', text });
          if (logged.item) out = logged.item;
          // The point of declaring instead of asking is that the operator sees it.
          getScut()?.agentSaid({ ticketId: id, kind: 'devlog', text, by: 'agent' });
        }
        if (Object.keys(body).length === 0) { broadcastBacklog(); return send(200, out); }
      }
      const isLabelDelta = 'labels' in body || 'removeLabels' in body || 'comment' in body;
      if (!isLabelDelta && 'mode' in body && !backlogStore.validMode(body.mode)) return send(400, { error: 'mode must be "interactive", "headless" or null' });
      if (!isLabelDelta && 'model' in body) { const m = normalizeModelField(body.model); if (!m.ok) return send(400, { error: m.error }); }
      // glmps-2-0-163: a host that closes itself while a card it spawned is
      // open leaves that card headless with nobody managing it (162 under 159).
      // Judged on the state the PATCH would produce, so a plain state change or
      // any label that derives to done closes through the same guard (173).
      // The operator's own close from the board promotes instead (Q1).
      let promoteOnClose = false;
      {
        const st = backlogStore.load(P.stateDir);
        const before = st.items.find((i) => i.id === id);
        const after = before && (isLabelDelta ? backlogStore.applyLabelDelta(st, id, body) : backlogStore.updateItem(st, id, body)).item;
        const closing = !!after && !backlogStore.CLOSED_STATES.has(before.state) && backlogStore.CLOSED_STATES.has(after.state);
        const kids = closing ? openChildren(id, st.items).map((c) => c.id) : [];
        const operator = kids.length > 0 && (tokenMatches(req.headers[LOCAL_SESSION_HEADER], getLocalSessionExpected())
          || tokenMatches(presentedTokenFrom(req.headers), accessToken));
        if (operator) promoteOnClose = true;
        else if (kids.length) {
          return send(409, {
            error: 'open-spawned-cards', openChildren: kids,
            reason: `card ${id} still has open spawned cards (${kids.join(', ')}); keep managing them until each is done or cancelled, then close`,
          });
        }
      }
      const r = isLabelDelta
        ? backlogStore.applyLabelDeltaIn(P.stateDir, id, body)
        : backlogStore.updateItemIn(P.stateDir, id, body);
      if (!r.item) return send(404, { error: 'item not found' });
      // glmps-95: bridge the job's declared goal (seeded under job.id at
      // launch - see launchJob()'s writeDeclared call) onto the runtime
      // session's own workspace the moment this PATCH sets sessionId. This
      // is the ONLY place a backlog item's sessionId is ever persisted
      // (applyLabelDelta ignores it - hence gating on !isLabelDelta, which
      // matches what actually got written above), so it's the first
      // reliable point MC can associate job.id with the runtime sid. The
      // job's goal is authoritative for a runner-launched session and
      // takes priority over workspace-observe.js's generic session-title
      // fallback (which may have already seeded something noisier from the
      // raw seed-doc/prompt-file text). Fail-open: bridging must never
      // break a self-report PATCH. Interactive sessions and label:workspace
      // meta events never go through this route, so they are unaffected.
      if (!isLabelDelta && 'sessionId' in body) {
        const runtimeSid = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (runtimeSid) {
          try {
            const jobDeclared = readWorkspace(P.stateDir, id)?.declared ?? null;
            if (jobDeclared?.goal) writeDeclared(P.stateDir, runtimeSid, { goal: jobDeclared.goal, ts: jobDeclared.ts ?? Date.now() });
          } catch { /* fail-open */ }
        }
      }
      // mc-15 loop completion: a delta that CLOSES a ticket 'done' without a
      // PASS/WAIVED gate feeds the capability learning loop as a recurring gap
      // (the seed doc's "mined by the learning loop", now real, not just the
      // gatelessDone board flag). Deduped by gap code; proposed for human
      // review (the operator's approval is the only landing path, guard
      // proposer cutover Task 10). Fail-open - never breaks the PATCH.
      const closesDone = isLabelDelta && Array.isArray(body.labels)
        && (body.labels.includes('agent:done') || body.labels.includes('merged-unverified'));
      if (closesDone && backlogStore.isGatelessDone(r.item)) {
        try {
          const lq = learningStore.load(P.stateDir);
          const result = upsertGapAndApply(lq, {
            code: 'ticket-closed-without-gate', severity: 'warn',
            message: "A ticket was closed 'done' without a PASS/WAIVED verification gate.",
          }, { project: r.item.project || '', sessionId: r.item.sessionId || '' }, { stateDir: P.stateDir });
          if (result.dirty) learningStore.save(P.stateDir, result.lq);
        } catch { /* fail-open: learning must never break a ticket update */ }
      }
      // The Slack channel a ticket owns follows the card's state: hidden
      // (D27) when it closes, unhidden when it is requeued. Fire and forget.
      try { getScut()?.ticketStateChanged?.({ item: r.item }); } catch { /* never block a ticket update on chat */ }
      if (promoteOnClose) void promoteAfterClose(id, 'was closed by the operator', 'operator');
      broadcastBacklog();
      return send(200, r.item);
    },
  });
  registerRoute({
    method: 'DELETE', pattern: '/api/backlog/:id',
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      const { removed } = backlogStore.removeItemIn(P.stateDir, id);
      if (!removed) return send(404, { error: 'item not found' });
      broadcastBacklog();
      return send(200, { removed: true });
    },
  });
  // D27 C2: the explicit purge of a closed ticket's kept
  // worktree. Safe removal only (no --force): a dirty tree answers 409
  // and survives. Deletion safety, since a wrong answer here deletes a
  // worktree: `id` (from the URL) only selects WHICH card's OWN recorded
  // `runSession.worktree` is in play - no path is ever built from the
  // request. Before anything is removed, every one of these has to hold,
  // checked against ground truth (the filesystem, the live session
  // corpus and git itself), not just the card's own record:
  //   - no live, non-ended session's cwd sits inside it, and the card's
  //     own recorded sessionId is not live either (fix round 1, Critical
  // the ledger alone is not proof the agent is gone - a card
  //     reaches done/idle, leaving the ledger, while its agent is still
  //     working in the checkout; reconcileNow's own departed loop never
  //     reclaims on the ledger signal alone for exactly this reason);
  //   - the worktree's real path (`fs.realpathSync`, so a symlink or a
  //     `..` cannot point this outside the sanctioned tree) resolves
  //     inside the configured runner worktrees directory (`isUnderDir`,
  //     the same containment check the reclaim sweep already uses -
  //     glmps-53's "one guard must not diverge from the
  //     other");
  //   - `git worktree list` for that repo actually registers it on a
  //     `glmps-runner/*` branch whose OWN job id is THIS card's id (fix
  // "some registered runner worktree" is not
  //     enough - a corrupted or copied record naming a real, registered
  //     worktree must never purge a DIFFERENT job's checkout).
  // Any mismatch is a 404 or 409: this is not the worktree we think it
  // is, or someone is still using it, so nothing is removed.
  registerRoute({
    method: 'POST', pattern: '/api/backlog/:id/purge-worktree',
    handle: async (req, res, { params, send, url, access }) => {
      const id = params.id;
      const item = backlogStore.load(P.stateDir).items.find((i) => i.id === id);
      const wt = item?.runSession?.worktree;
      if (!item || !wt?.dir || !wt?.repo) return send(404, { error: 'no worktree recorded for this card' });
      if (runnerStore.loadLedger(P.stateDir)[id]) return send(409, { error: 'the job is running' });
      let listed;
      {
        const listing = await runRecipe(listWorktreesRecipe({ repo: wt.repo }));
        if (listing.status !== 0) return send(409, { error: `git refused to list worktrees: ${(listing.stderr || `exit ${listing.status}`).trim().slice(0, 300)}` });
        listed = parseWorktreeList(listing.stdout);
      }
      // CI fix round (glmps2 Slack lifecycle): fs.realpathSync (the plain,
      // non-native JS walk) only follows symlinks/junctions - it does not
      // ask Windows to canonicalize an 8.3 short-name path component (e.g.
      // a GH-hosted runner's C:\Users\RUNNER~1\...\Temp) to its long name.
      // git-for-windows' own path reporting (git worktree list, below)
      // DOES normalize to the long name (its MSYS runtime resolves short
      // names as part of translating the path), so comparing a plain
      // realpathSync of our own recorded (short-name) dir against git's
      // (long-name) listing silently mismatched on exactly that kind of
      // host, 404-ing a perfectly real, registered worktree.
      // fs.realpathSync.native calls the OS canonicalization directly
      // (GetFinalPathNameByHandleW on win32) and resolves BOTH short names
      // and symlinks/junctions, matching scripts/shadow-instance.mjs's own
      // realpathFn default for this identical class of comparison. Safe on
      // every platform: POSIX has no short-name concept, so .native and
      // the plain version already agreed there.
      let realDir;
      try { realDir = fs.realpathSync.native(wt.dir); } catch { return send(404, { error: 'the recorded worktree no longer exists on disk' }); }
      // the ledger check above is not enough - a
      // card reaches done/idle (leaving the ledger) while its agent is
      // still working in the checkout (reconcileNow's own departed loop
      // never reclaims on the ledger signal alone either, for exactly this
      // reason - see reclaimVerdict's 'occupied'/'pid-alive' outcomes).
      // Same occupancy signal, same non-ended filter, so this can never
      // disagree with the sweep's own answer.
      //
      // reclaimVerdict itself compares a live
      // session's cwd against the UNRESOLVED wt.dir, not a realpath (see
      // isUnderDir usages in queue-runner.js) - checking only `realDir`
      // here missed a live agent whenever the worktrees directory (or the
      // worktree itself) is a junction/symlink: the agent was launched
      // with the RAW path (whatever worktreePlan handed the spawn call),
      // so its reported cwd never resolves through the link on its own.
      // Checked both ways - raw session cwd and its own realpath, against
      // both wt.dir and realDir - so a mismatch in either direction still
      // matches.
      const nonEnded = sessionSummaries().filter((s) => s.state !== 'ended');
      // Phase C final review, M5: a named reason, not a bare catch - an
      // unresolvable live-session cwd degrades to the raw path (never a
      // throw), but was silently dropping the why. I4: keyed per ROUTE
      // (purge-worktree), the ticket id and path in the reason text.
      // Same short-name hazard as realDir above: .native, not the plain
      // JS walk, so a live session's reported cwd compares correctly
      // against wt.dir/realDir regardless of which form either side's
      // TEMP happened to come back in.
      const realOrSelf = (p) => { try { return fs.realpathSync.native(p); } catch (e) { reportMiss('purge-worktree', `${id}: realpath failed for ${p}: ${e?.message ?? e}`); return p; } };
      const cwdMatchesWorktree = (cwd) => {
        if (!cwd) return false;
        const realCwd = realOrSelf(cwd);
        return isUnderDir(cwd, wt.dir) || isUnderDir(cwd, realDir)
          || isUnderDir(realCwd, wt.dir) || isUnderDir(realCwd, realDir);
      };
      if (nonEnded.some((s) => cwdMatchesWorktree(s.cwd))) {
        return send(409, { error: 'a live session is working in this worktree' });
      }
      const sid = item.runSession?.sessionId ?? null;
      if (sid && nonEnded.some((s) => s.id === sid)) {
        return send(409, { error: 'the ticket\'s recorded session is still live' });
      }
      // "some runner worktree of this repo" is
      // not enough either - it has to be THIS card's own job. Without this,
      // a corrupted or copied runSession.worktree record naming a REAL,
      // registered worktree could purge a completely different job's
      // (possibly still-open) checkout.
      // An unresolvable CANDIDATE entry (a stale git-internal record for a
      // worktree whose directory is already gone) is simply not a match -
      // not a swallowed error: the overall route still fails closed with a
      // named 404 below when nothing matches.
      // Phase C final review, M5/I4: same named-reason, same-route
      // treatment as realOrSelf above - an unresolvable candidate is
      // correctly "not a match" (the route still 404s below), but now says
      // why instead of swallowing it.
      const registered = listed.find((w) => { try { return pathsEqual(fs.realpathSync.native(w.dir), realDir); } catch (e) { reportMiss('purge-worktree', `${id}: realpath failed for candidate ${w.dir}: ${e?.message ?? e}`); return false; } });
      // compared against wtSafeSeg(id), not the raw
      // id - worktreePlan itself sanitizes the job id before building the
      // branch name, so that is the value a real registered branch can
      // ever carry.
      if (!registered || jobIdFromRunnerBranch(registered.branch) !== wtSafeSeg(id)) {
        return send(404, { error: 'the recorded worktree is not registered as a runner worktree of this repo' });
      }
      let realBase;
      try { realBase = fs.realpathSync.native(P.worktreesDir); }
      catch (e) {
        reportMiss('purge-worktree', `${id}: runner worktrees directory could not be resolved: ${e.message}`);
        return send(404, { error: 'the configured runner worktrees directory could not be resolved' });
      }
      if (!isUnderDir(realDir, realBase)) {
        return send(404, { error: 'the recorded worktree is outside the runner worktrees directory' });
      }
      if (!(await removeWorktree(wt, { by: 'operator-purge' }))) return send(409, { error: 'the worktree was not removed (a process is still in it, uncommitted changes, or not a worktree)' });
      backlogStore.setRunSessionIn(P.stateDir, id, { purgedTs: Date.now() });
      backlogStore.appendDevLogIn(P.stateDir, id, { by: 'operator', text: `worktree purged: ${wt.dir}` });
      broadcastBacklog();
      return send(200, { ok: true, removed: true });
    },
  });
}
