import { annotateWithQueue, sortOpenPrs } from '../observability/open-prs.js';
import * as backlogStore from '../orchestration/backlog-store.js';
import { repoTree, fileDiff, resolveResidencyRepo } from '../surface/repo-tree.js';

export function registerSurfaceRoutes(registerRoute, deps) {
  const { P, openPrs, treeMemo, sendSurfaceError, fileApi, ledgerMemo } = deps;

  // glmps-2-0-113: every open PR on the account, for the Surface Open PRs
  // layer, marked with the merge-queue stage of the card that filed it.
  registerRoute({
    method: 'GET', pattern: '/api/surface/open-prs',
    handle: async (req, res, { send }) => {
      try {
        const r = await openPrs.get();
        if (!r.ok) return send(503, { error: r.error });
        const prs = sortOpenPrs(annotateWithQueue(r.prs, backlogStore.load(P.stateDir).items));
        return send(200, { owner: r.owner, fetchedAt: r.fetchedAt, truncated: r.truncated, prs });
      } catch (e) {
        return send(500, { error: e?.message ?? 'open PR read failed' });
      }
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/surface/tree',
    handle: async (req, res, { send }) => {
      const repo = new URL(req.url, 'http://127.0.0.1').searchParams.get('repo');
      const r = resolveResidencyRepo(P.stateDir, repo);
      if (r.error) return send(r.status, { error: r.error });
      const hit = treeMemo.get(repo);
      if (hit && Date.now() - hit.ts < 30000) return send(200, hit.body);
      try {
        const body = await repoTree({ repoPath: r.row.path, repo });
        treeMemo.set(repo, { ts: Date.now(), body });
        return send(200, body);
      } catch (e) { return sendSurfaceError(send, e); }
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/surface/file-diff',
    handle: async (req, res, { send }) => {
      const q = new URL(req.url, 'http://127.0.0.1').searchParams;
      const r = resolveResidencyRepo(P.stateDir, q.get('repo'));
      if (r.error) return send(r.status, { error: r.error });
      try { return send(200, await fileDiff({ repoPath: r.row.path, repo: r.row.repo, relPath: q.get('path'), fileApi })); }
      catch (e) { return sendSurfaceError(send, e); }
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/surface/ledger',
    handle: async (req, res, { send }) => {
      try { return send(200, await ledgerMemo()); } catch (e) { return sendSurfaceError(send, e); }
    },
  });
}
