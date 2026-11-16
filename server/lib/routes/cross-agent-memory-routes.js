import fs from 'node:fs';
import path from 'node:path';
import {
  upsertCandidate as camUpsertCandidate, approveCandidateIn as camApproveCandidateIn,
  rejectCandidateIn as camRejectCandidateIn, releaseQuarantineIn as camReleaseQuarantineIn,
  startTrialIn as camStartTrialIn,
  load as camLoad,
} from '../governance/cross-agent-memory-store.js';
import {
  captureCandidates, distributeMemory, computeMemoryAttestation, recordMemoryBaseline,
} from '../governance/cross-agent-memory.js';
import { selectPushTargets } from '../governance/vendor-writers.js';
import { makeWritePathGuard } from '../governance/write-path-guard.js';

export function registerCrossAgentMemoryRoutes(registerRoute, deps) {
  const { P, REPO_ROOT, cfg, readBody, camBaselinePath } = deps;

  registerRoute({
    method: 'GET', pattern: '/api/cross-agent-memory',
    handle: (req, res, { send }) => send(200, { items: camLoad(P.stateDir).items }),
  });
  registerRoute({
    method: 'POST', pattern: '/api/cross-agent-memory/capture',
    handle: (req, res, { send }) => {
      const facts = captureCandidates(P.memoryDir);
      let captured = 0;
      for (const fact of facts) {
        const r = camUpsertCandidate(P.stateDir, fact, REPO_ROOT);
        if (r.isNew) captured++;
      }
      return send(200, { captured, scanned: facts.length });
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/cross-agent-memory/:id/approve',
    handle: (req, res, { params, send }) => {
      try { const r = camApproveCandidateIn(P.stateDir, params.id); return send(200, { item: r.item }); }
      catch (e) { return send(409, { error: String(e.message ?? e) }); }
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/cross-agent-memory/:id/reject',
    handle: (req, res, { params, send }) => {
      try { const r = camRejectCandidateIn(P.stateDir, params.id); return send(200, { item: r.item }); }
      catch (e) { return send(409, { error: String(e.message ?? e) }); }
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/cross-agent-memory/:id/release-quarantine',
    handle: (req, res, { params, send }) => {
      try { const r = camReleaseQuarantineIn(P.stateDir, params.id); return send(200, { item: r.item }); }
      catch (e) { return send(409, { error: String(e.message ?? e) }); }
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/cross-agent-memory/:id/start-trial',
    handle: (req, res, { params, send }) => {
      try { const r = camStartTrialIn(P.stateDir, params.id); return send(200, { item: r.item }); }
      catch (e) { return send(409, { error: String(e.message ?? e) }); }
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/cross-agent-memory/push',
    handle: async (req, res, { send }) => {
      // glmps-146: optional {vendors:[...]} narrows the push. Absent, every
      // supported vendor is written, which is the shipped default.
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const { targets, unknown } = selectPushTargets(body?.vendors);
      if (unknown.length) return send(400, { error: 'unknown vendor', unknown });
      if (!targets.length) return send(400, { error: 'no vendors selected' });

      const state = camLoad(P.stateDir);
      const entries = state.items
        .filter(i => i.status === 'approved' || i.status === 'trialing' || i.status === 'kept')
        .map(i => i.fact);
      const pushGuard = makeWritePathGuard({ repoRoot: REPO_ROOT, liveInstallPaths: cfg.liveInstallPaths });
      const results = distributeMemory({
        targets, entries,
        readFile: p => fs.readFileSync(path.resolve(REPO_ROOT, p), 'utf-8'),
        exists: p => { try { fs.accessSync(path.resolve(REPO_ROOT, p)); return true; } catch { return false; } },
        guard: pushGuard,
      });
      for (const r of results) {
        if (r.action === 'skipped' || r.action === 'unchanged') continue;
        const abs = path.resolve(REPO_ROOT, r.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, r.content);
      }
      recordMemoryBaseline(camBaselinePath, results.map(r => ({ ...r, path: path.resolve(REPO_ROOT, r.path) })));
      return send(200, { results: results.map(r => ({ vendor: r.vendor, path: r.path, action: r.action })) });
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/cross-agent-memory/attestation',
    handle: (req, res, { send }) => send(200, computeMemoryAttestation({ baselinePath: camBaselinePath })),
  });
}
