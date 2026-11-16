import { readWorkspace, writeSteer, listWorkspaces } from '../orchestration/workspace-store.js';
import { scanText, classifyTrust, quarantineDecision } from '../governance/poison-scan.js';

export function registerWorkspaceRoutes(registerRoute, deps) {
  const { P, index, sessionSummaries, readBody } = deps;

  registerRoute({
    method: 'GET', pattern: '/api/workspace',
    handle: (req, res, { send }) => {
      const ids = sessionSummaries().filter(s => s.live).map(s => s.id);
      const list = listWorkspaces(P.stateDir, ids).map(ws => ({
        sessionId: ws.sessionId,
        title: index.get(ws.sessionId)?.title ?? null,
        declared: ws.declared, observed: ws.observed, divergence: ws.divergence,
        hasPendingSteer: !!(ws.steer && ws.steer.consumedTs == null),
      }));
      return send(200, { sessions: list });
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/workspace/:id',
    handle: (req, res, { params, send }) => {
      const ws = readWorkspace(P.stateDir, params.id);
      if (!ws) return send(404, { error: 'no workspace for session' });
      return send(200, ws);
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/workspace/:id/steer',
    handle: async (req, res, { params, send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const note = String(body?.note ?? '').slice(0, 2000);
      if (!note.trim()) return send(400, { error: 'note required' });
      // glmps-99: a steer note is persisted then injected verbatim as
      // additionalContext into a running agent (hooks/workspace-steer.js's
      // nextSteerContext) - injected content -> persisted state -> executed
      // instruction, the project's stated poisoning threat class. Run it
      // through the same poison-scan.js core backlog intake uses
      // (addItem -> scanTicket) BEFORE it ever touches disk. Unlike backlog
      // tickets there's no review/approve workflow for a steer note (a
      // live-agent nudge has no standing value worth quarantining pending
      // human release), so reject outright rather than persist-and-hold.
      const from = body?.from ?? 'operator';
      const scan = scanText(note);
      if (quarantineDecision({ trust: classifyTrust(from), severity: scan.severity })) {
        return send(400, { error: 'steer note flagged by poison-scan', flags: scan.flags, severity: scan.severity });
      }
      writeSteer(P.stateDir, params.id, { note, from, ts: Date.now() });
      return send(200, { ok: true });
    },
  });
}
