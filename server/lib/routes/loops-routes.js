export function registerLoopsRoutes(registerRoute, deps) {
  const { loopRegistry, GRAPH_CATALOG, readBody } = deps;

  // the loop registry's HTTP surface. GET routes read snapshot()/get()
  // directly; the two POST routes are the only way an external process
  // (the wiki refresh CLI, a future queue-runner tick) reports its own
  // outcome back into the same registry the dashboard reads.
  registerRoute({ method: 'GET', pattern: '/api/loops', handle: (req, res, { send }) => send(200, loopRegistry.snapshot()) });
  registerRoute({
    method: 'GET', pattern: '/api/loops/catalog',
    handle: (req, res, { send }) => {
      const snap = loopRegistry.snapshot();
      const loops = loopRegistry.describe().map(({ name, about }) => ({ name, ...snap[name], about }));
      return send(200, { loops, graphs: GRAPH_CATALOG, generatedAt: Date.now() });
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/loops/:name',
    handle: (req, res, { params, send }) => { const rec = loopRegistry.get(params.name); return rec ? send(200, rec) : send(404, { error: 'unknown loop' }); },
  });
  registerRoute({
    method: 'POST', pattern: '/api/loops/:name/run',
    handle: (req, res, { params, send }) => {
      const rec = loopRegistry.get(params.name);
      if (!rec) return send(404, { error: 'unknown loop' });
      if (!rec.trigger?.everyMs) return send(409, { error: `loop ${params.name} is ${rec.trigger?.external ? 'external' : 'event-triggered'}; it cannot be run on demand` });
      loopRegistry.runNow(params.name).catch((e) => console.error('[loops] manual run', params.name, e?.message || e));
      return send(202, { started: true });
    },
  });
  registerRoute({
    method: 'POST', pattern: '/api/loops/:name/report',
    // The registered-routes dispatcher does `return rmatch.route.handle(...)`
    // inside its own try/catch, but a promise returned from inside a try is
    // never awaited there, so a rejection surfacing later never re-enters
    // that catch. An async handler that throws therefore becomes an
    // unhandled rejection of the whole per-request callback, not a response
    // to the caller -- the outer try buys it nothing. Every line here (not
    // just the awaited ones) is wrapped so this handler always resolves and
    // always sends something back.
    handle: async (req, res, { params, send }) => {
      try {
        if (!loopRegistry.get(params.name)) return send(404, { error: 'unknown loop' });
        // readBody()'s own rejection is not one failure but two: the size cap
        // (MAX_BODY exceeded) is a distinct, name-worthy caller mistake (413),
        // while every other rejection (a dropped connection, a stream error)
        // is an ordinary 400. Neither echoes the raw error text to the caller
        // -- an external script or Scheduled Task hitting this route gets a
        // stable, generic reason; the actual detail goes to the server log.
        // A caller retrying "invalid json" by fixing its JSON would otherwise
        // loop forever on a payload that was never going to parse-fail.
        let raw;
        try { raw = await readBody(req); }
        catch (e) {
          if (e?.message === 'body too large') return send(413, { error: 'body too large' });
          console.error('[loops] report body read failed', params.name, e?.message || e);
          return send(400, { error: 'invalid body' });
        }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return send(400, { error: 'body must be an object' });
        // fresh is the registry's state-record field (a maker-produced object,
        // e.g. { builtAtCommit }, per Task 1), never a boolean or scalar: only
        // a plain object, null, or an absent key passes through unchanged.
        if (body.fresh !== undefined && body.fresh !== null && (typeof body.fresh !== 'object' || Array.isArray(body.fresh))) {
          return send(400, { error: 'fresh must be an object' });
        }
        try { loopRegistry.report(params.name, body); }
        catch (e) { console.error('[loops] report rejected', params.name, e?.message || e); return send(400, { error: 'invalid report' }); }
        res.writeHead(204); return res.end();
      } catch (e) {
        console.error('[loops] report handler failed', params.name, e?.message || e);
        return send(500, { error: 'internal error' });
      }
    },
  });
}
