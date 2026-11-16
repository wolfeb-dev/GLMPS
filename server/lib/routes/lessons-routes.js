import { readLessonRows, lessonsCurrent } from '../evaluation/lesson-ledger.js';
import { activeLessons } from '../evaluation/lesson-decay.js';
import { requestPromotion, approvePromotion, denyPromotion, revokePromotion, isPromoted, evaluateReflexPromotion } from '../evaluation/reflex-gate.js';
import { learningIntegrityConfig } from '../evaluation/learning-integrity-config.js';

export function registerLessonsRoutes(registerRoute, deps) {
  const { P, cfg, readBody, resolveActor } = deps;

  registerRoute({
    method: 'GET', pattern: '/api/lessons',
    handle: (req, res, { send }) => {
      const cfgLi = learningIntegrityConfig(cfg);
      const all = [...lessonsCurrent(readLessonRows(P.stateDir, {})).values()]
        .map((l) => ({ ...l, promoted: isPromoted(P.stateDir, l.lessonId) }));
      return send(200, { lessons: all, active: activeLessons(P.stateDir, { config: cfgLi }).length, config: cfgLi });
    },
  });

  registerRoute({
    method: 'POST', pattern: '/api/lessons/:id/promote',
    handle: async (req, res, { params, send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      try {
        const actor = resolveActor(req);
        requestPromotion(P.stateDir, { lessonId: params.id, targetLayer: 'reflex', evidence: body.evidence ?? null, actor });

        // A0.4 is three steps, not two: requested -> EVALUATED over the frozen
        // replay set -> approved or denied. Skipping the middle step would
        // record the evidence and then ignore it, letting a human approve a
        // lesson whose own replay shows a regression. Human confirmation is
        // the LAST gate, not the only one.
        //
        // Evidence is optional because the replay harness is not wired into
        // every lesson source yet. With none supplied there is nothing to
        // evaluate, and the route must not pretend otherwise - the human
        // carries the decision alone in that case.
        if (body.evidence !== undefined && body.evidence !== null) {
          const verdict = evaluateReflexPromotion({
            evidence: body.evidence, baseline: body.baseline ?? {}, directions: body.directions,
          });
          if (verdict.verdict === 'reject') {
            denyPromotion(P.stateDir, { lessonId: params.id, reason: verdict.reasons.join('; '), actor });
            return send(409, { error: 'replay evidence rejects this promotion', verdict });
          }
        }

        // Human confirmation, required in this phase and not defaultable.
        return send(200, approvePromotion(P.stateDir, { lessonId: params.id, actor, humanApproved: body.humanApproved === true }));
      } catch (e) { return send(409, { error: e.message }); }
    },
  });

  registerRoute({
    method: 'POST', pattern: '/api/lessons/:id/revoke',
    handle: async (req, res, { params, send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { body = {}; }
      try {
        return send(200, revokePromotion(P.stateDir, {
          lessonId: params.id, reason: body.reason ?? 'operator revoked', actor: resolveActor(req),
        }));
      } catch (e) { return send(409, { error: e.message }); }
    },
  });
}
