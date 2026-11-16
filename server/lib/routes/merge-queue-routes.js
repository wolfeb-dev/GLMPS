import * as mergeQueue from '../orchestration/merge-queue.js';
import * as backlogStore from '../orchestration/backlog-store.js';
import * as batchReview from '../orchestration/batch-review.js';

export function registerMergeQueueRoutes(registerRoute, deps) {
  const { P, mainSuiteReds, readBody, fileCard, broadcastBacklog } = deps;

  registerRoute({
    method: 'GET', pattern: '/api/merge-queue',
    handle: (req, res, { send }) => send(200, { branches: mergeQueue.groupQueue(backlogStore.load(P.stateDir).items, { reds: mainSuiteReds() }) }),
  });

  registerRoute({
    method: 'POST', pattern: '/api/merge-queue/batch-review',
    handle: async (req, res, { send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const r = batchReview.acceptFindings({ state: batchReview.loadState(P.stateDir), body });
      if (r.status !== 200) return send(r.status, { error: r.error });
      let cardId = null;
      if (r.card) {
        const filed = fileCard({ ...r.card, source: 'merge-queue' });
        cardId = filed?.item?.id ?? filed?.id ?? null;
        broadcastBacklog();
      }
      r.state[r.key] = { ...r.state[r.key], lastCardId: cardId };
      batchReview.saveState(P.stateDir, r.state);
      return send(200, { ok: true, key: r.key, findings: r.state[r.key].lastFindings, cardId });
    },
  });
}
