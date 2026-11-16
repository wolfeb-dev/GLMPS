import { learningIntegrityConfig, a0AcceptanceStatus } from '../evaluation/learning-integrity-config.js';

export function registerLearningIntegrityRoutes(registerRoute, deps) {
  const { P, cfg, readBody } = deps;

  registerRoute({
    method: 'GET', pattern: '/api/learning-integrity',
    handle: (req, res, { send }) => {
      const liCfg = learningIntegrityConfig(cfg);
      return send(200, { config: liCfg, acceptance: a0AcceptanceStatus(P.stateDir), freeze: liCfg.freeze });
    },
  });

  registerRoute({
    method: 'POST', pattern: '/api/learning-integrity/freeze',
    handle: async (req, res, { send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      const acceptance = a0AcceptanceStatus(P.stateDir);
      // A0.6: the freeze lifts only when every acceptance item passes.
      // Re-freezing is always allowed; that is never the risky direction.
      if (body.frozen === false && !acceptance.allPassed) {
        return send(409, { error: 'A0 acceptance is incomplete, so the learning-write freeze cannot be lifted yet', acceptance });
      }
      cfg.learningIntegrity = { ...(cfg.learningIntegrity ?? {}), freeze: body.frozen !== false };
      return send(200, { freeze: cfg.learningIntegrity.freeze, acceptance });
    },
  });
}
