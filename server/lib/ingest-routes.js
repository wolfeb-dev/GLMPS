// What each /api/ingest/* route does once its body validated: the same store
// call the hook made directly before card glmps-2-0-runtime-36.
import path from 'node:path';
import * as learningStore from './evaluation/learning-store.js';
import { coveredCodesFromFile } from './evaluation/guard-coverage.js';
import * as backlogStore from './orchestration/backlog-store.js';
import * as decisionStore from './observability/decision-log-store.js';
import { appendPoint } from './observability/qa-trends-store.js';
import {
  INGEST_MAX_BODY_BYTES, validateLearningGaps, validateBacklogTicket, validateDecisionRows, validateQaPoint,
} from './ingest-validate.js';

export { INGEST_MAX_BODY_BYTES };

// clientId is the access guard's (null for loopback); a body-supplied one is
// always discarded.
const stamp = (obj, clientId) => {
  const { clientId: _forged, ...rest } = obj;
  return clientId ? { ...rest, clientId } : rest;
};

export const INGEST_ROUTES = {
  '/api/ingest/learning-gaps': {
    validate: validateLearningGaps,
    apply(b, { stateDir, assetsDir, clientId }) {
      // A client has no assets dir, so coverage is computed here, from the guard file the server owns.
      const coveredCodes = coveredCodesFromFile(path.join(assetsDir, 'CLAUDE.global.md'));
      // project is the raw cwd: upsertGap canonicalizes it, and only a raw path folds a worktree into its parent repo.
      // A client's path names its own disk, so clientId keys it on a slug the server never stats.
      for (const gap of b.gaps) {
        try { learningStore.upsertGap(stateDir, gap, { project: b.project, sessionId: b.sessionId, coveredCodes, clientId }); }
        catch { /* fail-open per gap, as the hook was */ }
      }
    },
  },
  '/api/ingest/backlog-ticket': {
    validate: validateBacklogTicket,
    // addItem runs the intake poison scan at default (external) trust and dedupes
    // on (project, title, source), exactly like POST /api/backlog.
    // A paired client owns what it files, as on POST /api/backlog, so the
    // ownership guard lets it update the card (card glmps-2-0-runtime-148).
    apply(b, { stateDir, clientId, resolveProject = null }) {
      backlogStore.addItemTo(stateDir, {
        project: b.project, title: b.title.trim(), prompt: b.prompt, source: b.source, state: b.state, sessionId: b.sessionId,
        ...(clientId ? { actor: `client:${clientId}`, origin: { via: 'client', clientId } } : {}),
      }, { resolveProject });
    },
  },
  '/api/ingest/decision-log': {
    validate: validateDecisionRows,
    apply(b, { stateDir, clientId }) { decisionStore.append(stateDir, b.rows.map((r) => stamp(r, clientId))); },
  },
  '/api/ingest/qa-trends': {
    validate: validateQaPoint,
    apply(b, { stateDir, clientId }) {
      const { ts, runId, sha, testCount, pass, fail, conclusion, openIssues, source, scope } = b.point;
      appendPoint(stateDir, stamp({ ts, runId, sha, testCount, pass, fail, conclusion, openIssues, source, ...(scope ? { scope } : {}) }, clientId));
    },
  },
};
