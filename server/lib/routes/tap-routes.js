import fs from 'node:fs';
import { installerFileName, serverUrlFromHost } from '../kernel/tap-installer-name.js';

export function registerTapRoutes(registerRoute, deps) {
  const { clientRoute, pairing, resolveActor, NO_STORE, tapRelease, trustFingerprint = null } = deps;

  registerRoute({
    method: 'POST', pattern: '/api/tap/pair-code',
    handle: clientRoute('pair-code', (req, b, { send }) => {
      if (b.clientId != null && typeof b.clientId !== 'string') return send(400, { error: 'clientId must be a string' });
      // The tap pins the server-trust CA by this fingerprint (card glmps-2-0-152); null on a loopback-only bind.
      return send(201, { ...pairing.mint({ actor: resolveActor(req), clientId: b.clientId || null }), trustFingerprint }, NO_STORE);
    }),
  });
  registerRoute({
    method: 'POST', pattern: '/api/tap/pair',
    handle: clientRoute('pair', (req, b, { send }) => {
      const out = pairing.redeem({ code: b.code, name: b.name, tapVersion: b.tapVersion, dataRoots: b.dataRoots, publicKey: b.publicKey, source: req.socket?.remoteAddress ?? null });
      return send(201, out, NO_STORE);
    }),
  });
  // The tap release and its downloads (server-and-client-tap task 7). Under
  // /api/tap/*, so the guard refuses client tokens and tokenless remote callers:
  // only the dashboard token (or loopback) reaches them. The installer's filename
  // carries the server URL this browser reached us at, which is by construction
  // reachable from the machine it will run on; the file itself is unchanged, so
  // its signature and SHA-256 hold for every server.
  const installerNameFor = (req) => {
    // The private listener is HTTPS only, so a browser that reached it there names an https server.
    const url = serverUrlFromHost(req.headers.host, { scheme: req.socket?.encrypted ? 'https' : 'http' });
    return url ? installerFileName(url) : null;
  };
  registerRoute({
    method: 'GET', pattern: '/api/tap/release',
    handle: async (req, res, { send }) => {
      // Not awaited by the dispatcher: a throw here would be an unhandled rejection.
      try {
        const r = await tapRelease.load();
        if (!r.ok) return send(r.status, { error: r.error });
        const { version, commit, builtAt, node, signing } = r.release;
        const art = (kind) => ({ size: r.files[kind].size, sha256: r.files[kind].sha256, url: `/api/tap/download/${kind}` });
        return send(200, { version, commit, builtAt, node, signing, installer: { ...art('installer'), fileName: installerNameFor(req) }, update: art('update') }, NO_STORE);
      } catch (e) {
        console.error('[kernel] tap release failed', e?.message || e);
        return send(500, { error: 'internal error' });
      }
    },
  });
  registerRoute({
    method: 'GET', pattern: '/api/tap/download/:kind',
    handle: async (req, res, { params, send }) => {
      if (params.kind !== 'installer' && params.kind !== 'update') return send(404, { error: 'unknown artifact' });
      const name = params.kind === 'installer' ? installerNameFor(req) : 'glmps-tap-update.zip';
      if (!name) return send(400, { error: 'the Host header cannot be carried in an installer filename; open the dashboard by its private address' });
      let r;
      try { r = await tapRelease.load(); } catch (e) {
        console.error('[kernel] tap download failed', e?.message || e);
        return send(500, { error: 'internal error' });
      }
      if (!r.ok) return send(r.status, { error: r.error });
      const f = r.files[params.kind];
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(f.size),
        'content-disposition': `attachment; filename="${name}"`,
        'x-content-sha256': f.sha256,
        'x-tap-version': r.release.version,
        'x-content-type-options': 'nosniff',
        ...NO_STORE,
      });
      fs.createReadStream(f.file).on('error', () => res.destroy()).pipe(res);
    },
  });
}
