import fs from 'node:fs';
import path from 'node:path';
import { appendCapped, readCapped } from '../observability/append-log.js';

export function registerGuardsRoutes(registerRoute, deps) {
  const { P, readBody } = deps;

  // Best-effort refusal/fail-open report from a guard hook (plan-gate.js and
  // test-file-guard.js, both shipped in K7). A report this route rejects or
  // never receives is logged by the hook itself (card-context.js
  // reportRefusal: <stateDir>/guards/report-failures.ndjson). The hook already decided and told the agent by the time this arrives, so a
  // failure here never changes anything the agent saw - it only feeds the
  // dashboard's recent-refusals list.
  //
  // the whole body is wrapped in one try -
  // matchRoute's dispatcher does not await this handler (see the
  // /api/loops/:name report route's own comment on the same shape a few
  // hundred lines up), so an uncaught throw anywhere in here is an unhandled
  // promise rejection with no catch above it: Node kills the process. This
  // reproduced with a literal `null` body (JSON.parse('null') -> null,
  // b.hook then threw). A small 16 KB cap (not the shared 5 MB MAX_BODY) is
  // plenty for a guard's reason text; a body over it is 413, not a generic
  // 400, matching the /api/loops/:name precedent.
  registerRoute({
    method: 'POST', pattern: '/api/guards/refusal',
    handle: async (req, res, { send }) => {
      try {
        let raw;
        try { raw = await readBody(req, { maxBytes: 16 * 1024 }); }
        catch (e) {
          if (e?.message === 'body too large') return send(413, { error: 'body too large' });
          return send(400, { error: 'invalid body' });
        }
        let b;
        try { b = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'invalid json' }); }
        if (typeof b !== 'object' || b === null || Array.isArray(b)) return send(400, { error: 'body must be an object' });
        if (typeof b.hook !== 'string' || !['plan-gate', 'test-file-guard'].includes(b.hook)) return send(400, { error: 'unknown hook' });
        const CAPS = { cardId: 128, sessionId: 128, tool: 64, path: 1024, reason: 2000 };
        for (const [field, max] of Object.entries(CAPS)) {
          const v = b[field];
          if (v === undefined || v === null) continue;
          if (typeof v !== 'string') return send(400, { error: `${field} must be a string` });
          if (v.length > max) return send(400, { error: `${field} is too long (max ${max})` });
        }
        try {
          appendCapped(path.join(P.stateDir, 'guards', 'refusals.ndjson'), {
            ts: Date.now(), hook: b.hook,
            cardId: b.cardId ?? null, sessionId: b.sessionId ?? null, tool: b.tool ?? null, path: b.path ?? null,
            reason: b.reason ?? '', failOpen: b.failOpen === true,
          });
        } catch (e) {
          console.error('[kernel] guard refusal report could not be written', e?.message || e);
        }
        res.writeHead(204);
        return res.end();
      } catch (e) {
        console.error('[kernel] guard refusal route failed unexpectedly', e?.message || e);
        return send(500, { error: 'internal error' });
      }
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/guards/refusals',
    // Phase K final review (silent-failure): a missing counters file is empty
    // counts; an unreadable, corrupt or wrong-shape one is named in
    // `countersError` (and logged), never swallowed and never a 500
    // (Object.entries(null) used to throw on a `null` file). A malformed
    // per-hook entry is skipped. An unreadable refusals log is named in
    // `recentError` rather than shown as an empty list.
    handle: (req, res, { send }) => {
      const out = { byHook: {}, recent: [] };
      let counters = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(P.stateDir, 'guards', 'counters.json'), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) out.countersError = 'counters.json is not an object';
        else counters = parsed;
      } catch (e) {
        if (e?.code !== 'ENOENT') out.countersError = `counters.json is unreadable or corrupt (${e?.code || e?.message})`;
      }
      if (out.countersError) console.error('[kernel] guard refusals:', out.countersError);
      for (const [h, c] of Object.entries(counters)) {
        if (!c || typeof c !== 'object' || !Number.isFinite(c.checks) || !Number.isFinite(c.refusals)) continue;
        out.byHook[h] = { ...c, rate: c.checks ? c.refusals / c.checks : null };
      }
      try { out.recent = readCapped(path.join(P.stateDir, 'guards', 'refusals.ndjson'), { limit: 50 }); }
      catch (e) {
        out.recentError = e?.message || String(e);
        console.error('[kernel] guard refusals:', out.recentError);
      }
      return send(200, out);
    },
  });
}
