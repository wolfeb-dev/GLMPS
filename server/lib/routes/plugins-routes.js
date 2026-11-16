import { restrictModelForHttp } from '../plugins/claude-model.js';

export function registerPluginsRoutes(registerRoute, deps) {
  const { readBody, chatCompletion, modelCfg, loopRegistry, cfg } = deps;

  // D23 loop-plugins: the built-in Claude model client, exposed in an
  // OpenAI chat.completions shape so every plugin (Mem0, judge, GEPA) can
  // call it the same way an upstream package would call a hosted API,
  // without any runtime dependency or API key. localhost-only (checkAccess
  // above already restricts remote callers).
  registerRoute({
    method: 'POST', pattern: '/api/plugins/model/v1/chat/completions',
    handle: async (req, res, { send }) => {
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return send(400, { error: 'invalid json' }); }
      // C7 + residual fix: an HTTP caller may
      // request haiku, sonnet, or whichever model this server is actually
      // CONFIGURED to use as models.fast/strong (e.g. GEPA's own strong
      // model) - anything else falls back to models.fast. Internal plugins
      // call chatCompletion() directly, in-process, never through this
      // handler, so they are unaffected.
      try { return send(200, await chatCompletion(restrictModelForHttp(body, modelCfg.models))); }
      catch (e) { return send(e.status || 400, { error: e.message }); }
    },
  });

  // Guard proposer cutover, now the guard-proposals loop (K Task 6:
  // registerPluginLoops above already registered it, driven by gepaAdapter).
  // This route's only job is to trigger it and answer 202/409 - the loop
  // itself does the work, checks the provenance of what it proposed, and
  // queues nothing on failure (a GEPA run is repeatable, per plugin-loops.js).
  registerRoute({
    method: 'POST', pattern: '/api/plugins/gepa/run',
    handle: async (req, res, { send }) => {
      if (loopRegistry.isRunning('guard-proposals')) return send(409, { error: 'already running' });
      // Fire-and-forget: the caller gets 202 immediately, the subprocess can
      // run for up to 45 minutes. A configured interval (cfg.plugins.gepa.
      // intervalMs > 0) makes the loop's trigger { everyMs } instead of
      // onEvent 'gepa.requested' (plugin-loops.js), so a manual run in that
      // mode goes through runNow instead of an event nothing would be
      // listening for. Every catch alerts or queues, never swallows
      // (constraints.md) - a bug escaping the loop's own failure handling
      // still only ever logs here, never an unhandled rejection.
      const gepaEveryMs = cfg.plugins?.gepa?.intervalMs ?? 0;
      const run = gepaEveryMs > 0 ? loopRegistry.runNow('guard-proposals') : loopRegistry.emit('gepa.requested', {});
      run.catch((e) => console.error('[loops] guard-proposals run failed', e?.message || e));
      return send(202, { started: true });
    },
  });
}
