// taps/tap-relay.js
// The tap agent's local relay (card glmps-2-0-runtime-37, server-and-tap task
// 12). Hooks and agents on a client keep calling http://127.0.0.1:8123/api/...;
// the relay forwards each call to the paired server with the client's token.
// With the server unreachable it queues the idempotent board writes, serves the
// context injectors their last answer, and answers 503 to everything else, so
// each guard hook sees the failure it handles today. Routes a client token may
// not reach are refused here and never leave the machine.
// Design: docs/specs/2026-10-26-glmps-2-0-runtime-37-local-relay.md
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tlsLib from 'node:tls';
import { clientScopeAllows, hostAllowed } from '../server/lib/governance/access-guard.js';
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';

export const QUEUE_FILE = 'relay-queue.ndjson';
export const REJECTED_FILE = 'relay-rejected.ndjson';
export const STALE_HEADER = 'x-glmps-relay-stale';
export const QUEUE_CAP_BYTES = 16 * 1024 * 1024;
export const BODY_CAP_BYTES = 4 * 1024 * 1024;
const RESPONSE_CAP_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 32;
const CACHE_ENTRY_CAP_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 2_000;
const RESPONSE_TIMEOUT_MS = 30_000;
const OFFLINE_HOLD_MS = 10_000;

// Spec row 9: the board writes an agent can safely send twice.
const QUEUE_ROUTES = [
  /^\/api\/backlog\/[^/]+\/devlog$/,
  /^\/api\/backlog\/[^/]+\/gate$/,
  /^\/api\/backlog\/[^/]+\/progress$/,
  /^\/api\/outcomes\/finalize$/,
  // The hooks' store writes (card glmps-2-0-runtime-36): gaps and tickets dedupe, so a replay is safe.
  /^\/api\/ingest\/(learning-gaps|backlog-ticket|decision-log|qa-trends)$/,
];
// The context injectors' reads. /api/sessions/live is left out: push-lease-guard
// reads it too, and a stale live list would look like a real one to that guard.
// OTLP/HTTP JSON exports: written to the spool, which ships them in order.
const SPOOL_ROUTES = new Set(['/v1/traces', '/api/otel']);
const CACHE_ROUTES = new Set(['/api/memory/lookup', '/api/brief', '/api/state']);
// Scan F6: the client token's scope covers the tap agent's own routes, which the
// agent calls directly. Relayed, they would let any local account claim launches,
// read file-save records, or rewrite heartbeats and mirrors.
const TAP_PRIVATE_ROUTE = /^\/api\/(launches(\/|$)|tap\/)/;

const DROP_REQUEST_HEADERS = new Set([
  'host', 'authorization', 'x-glmps-token', 'cookie', 'x-glmps-local-session', 'origin', 'referer',
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', TAP_PROTOCOL_HEADER,
]);
const DROP_RESPONSE_HEADERS = new Set([
  'set-cookie', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

/** False for any spelling the server's router could rewrite into another route. */
export function canonicalPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  if (pathname.includes('\\') || pathname.includes('//') || /%(2f|5c|2e)/i.test(pathname)) return false;
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  return !decoded.split('/').some((seg) => seg === '.' || seg === '..');
}

/** 'local' | 'refused' | 'spool' | 'queue' | 'cache' | 'forward' */
export function relayRoute(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' && pathname === '/tap/status') return 'local';
  if (!canonicalPath(pathname) || TAP_PRIVATE_ROUTE.test(pathname) || !clientScopeAllows(m, pathname)) return 'refused';
  if (m === 'POST' && SPOOL_ROUTES.has(pathname)) return 'spool';
  if (m === 'POST' && QUEUE_ROUTES.some((re) => re.test(pathname))) return 'queue';
  if (m === 'GET' && CACHE_ROUTES.has(pathname)) return 'cache';
  return 'forward';
}

/** The relay serves no page, so a browser has no business here (DNS rebinding, cross-site posts). */
export function browserRefusal(headers, localPort) {
  if (!hostAllowed({ host: headers.host, localPort })) return 'browser-request';
  if (headers.origin != null || headers['sec-fetch-site'] != null) return 'browser-request';
  return null;
}

/**
 * One upstream call over a fresh connection. Resolves to
 * {kind:'response', status, headers, body} | {kind:'unreachable', error} (never connected, safe to queue)
 * | {kind:'failed', error} (the request may have reached the server).
 */
// tls: { ca, cert, key } for an https server (the pinned CA and this client's certificate).
// connect: { host, localAddress } overrides only the address dialled (tests).
export function forwardOnce({ server, token, tls = null, connect = null, method, pathAndQuery, headers = {}, body, connectTimeoutMs = CONNECT_TIMEOUT_MS, responseTimeoutMs = RESPONSE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(pathAndQuery, `${server}/`); } catch (e) { resolve({ kind: 'failed', error: `bad url: ${e.message}` }); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) out[k] = v;
    out.authorization = `Bearer ${token}`;
    out[TAP_PROTOCOL_HEADER] = String(TAP_PROTOCOL);
    if (body && body.length) out['content-length'] = String(body.length);
    let connected = false;
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(connectTimer); clearTimeout(responseTimer); resolve(r); };
    let responseTimer = null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const tlsOpts = url.protocol === 'https:' && tls ? {
      ca: tls.ca, cert: tls.cert, key: tls.key, ...(net.isIP(host) ? {} : { servername: host }),
      checkServerIdentity: (_h, c) => tlsLib.checkServerIdentity(host, c),
    } : {};
    const req = lib.request({ protocol: url.protocol, hostname: connect?.host ?? url.hostname, port: url.port, path: url.pathname + url.search, method, headers: out, agent: false, ...(connect?.localAddress ? { localAddress: connect.localAddress } : {}), ...tlsOpts });
    const connectTimer = setTimeout(() => { if (!connected) { done({ kind: 'unreachable', error: 'connect timeout' }); req.destroy(); } }, connectTimeoutMs);
    req.on('socket', (sock) => {
      sock.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        responseTimer = setTimeout(() => { done({ kind: 'failed', error: 'response timeout' }); req.destroy(); }, responseTimeoutMs);
      });
    });
    req.on('error', (e) => done({ kind: connected ? 'failed' : 'unreachable', error: e.code || e.message }));
    req.on('response', (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > RESPONSE_CAP_BYTES) { done({ kind: 'failed', error: 'response too large' }); req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => done({ kind: 'response', status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => done({ kind: 'failed', error: e.code || e.message }));
    });
    req.end(body && body.length ? body : undefined);
  });
}

function readQueue(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail from a crash mid-append */ }
  }
  return out;
}

function writeQueue(file, records) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  fs.renameSync(tmp, file);
}

const json = (res, status, obj, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};

/**
 * getUpstream: async () => {server, token, tls} or {unavailable: 'tap-unconfigured'|'tap-unpaired'}.
 * The token is held by the caller (the agent) and never stored here beyond one call.
 */
export function createRelay({ home, getUpstream, spool = null, log = console.error, now = Date.now, forward = forwardOnce, connect = null, offlineHoldMs = OFFLINE_HOLD_MS, queueCapBytes = QUEUE_CAP_BYTES } = {}) {
  const queueFile = path.join(home, QUEUE_FILE);
  const rejectedFile = path.join(home, REJECTED_FILE);
  let queue = readQueue(queueFile);
  let nextSeq = queue.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
  const cache = new Map();
  let offlineUntil = 0;
  let lastError = null;
  let draining = null;

  const queueBytes = () => queue.reduce((n, r) => n + JSON.stringify(r).length + 1, 0);

  function enqueue({ method, pathAndQuery, contentType, body }) {
    const rec = { seq: nextSeq, ts: now(), method, path: pathAndQuery, contentType: contentType || null, body: body.toString('utf8') };
    const line = `${JSON.stringify(rec)}\n`;
    if (queueBytes() + line.length > queueCapBytes) return false;
    fs.mkdirSync(home, { recursive: true });
    fs.appendFileSync(queueFile, line);
    queue.push(rec);
    nextSeq++;
    return true;
  }

  async function send(method, pathAndQuery, headers, body) {
    const up = await getUpstream();
    if (up.unavailable) return { kind: 'unavailable', error: up.unavailable };
    if (now() < offlineUntil) return { kind: 'unreachable', error: lastError || 'offline' };
    const r = await forward({ server: up.server, token: up.token, tls: up.tls ?? null, connect, method, pathAndQuery, headers, body });
    if (r.kind === 'unreachable') { offlineUntil = now() + offlineHoldMs; lastError = `server unreachable: ${r.error}`; }
    else if (r.kind === 'failed') lastError = `forward failed: ${r.error}`;
    else { offlineUntil = 0; lastError = null; }
    return r;
  }

  /** Replays the queue in order; stops at the first record the server did not settle. */
  function drain() {
    if (draining) return draining;
    draining = (async () => {
      let sent = 0;
      while (queue.length) {
        const rec = queue[0];
        const headers = rec.contentType ? { 'content-type': rec.contentType } : {};
        const r = await send(rec.method, rec.path, headers, Buffer.from(rec.body, 'utf8'));
        if (r.kind !== 'response') break;
        const s = r.status;
        if (s === 401 || s === 408 || s === 429 || s >= 500) break;
        if (s >= 400) {
          try { fs.appendFileSync(rejectedFile, `${JSON.stringify({ ...rec, rejectedTs: now(), status: s, response: r.body.toString('utf8').slice(0, 2000) })}\n`); }
          catch (e) { log(`[tap-relay] could not log rejected record ${rec.seq}: ${e.message}`); }
          log(`[tap-relay] server refused queued ${rec.method} ${rec.path} with ${s}; logged to ${REJECTED_FILE}`);
        }
        queue.shift();
        writeQueue(queueFile, queue);
        sent++;
      }
      return sent;
    })().finally(() => { draining = null; });
    return draining;
  }

  function reply(res, r) {
    const headers = {};
    for (const [k, v] of Object.entries(r.headers || {})) if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
    res.writeHead(r.status, headers);
    res.end(r.body);
  }

  const offlineBody = (r) => (r.kind === 'unavailable'
    ? { error: r.error, relay: true }
    : { error: 'server-unreachable', relay: true, reason: r.error });

  async function handle(req, res) {
    const rawUrl = req.url || '/';
    const qi = rawUrl.indexOf('?');
    const pathname = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
    const method = String(req.method || 'GET').toUpperCase();
    const refusal = browserRefusal(req.headers, req.socket.localPort);
    if (refusal) { req.resume(); return json(res, 403, { error: 'relay-refused', reason: refusal }); }
    const cls = relayRoute(method, pathname);
    if (cls === 'refused') { req.resume(); return json(res, 403, { error: 'relay-refused', reason: 'not forwarded: outside the client scope' }); }

    const chunks = []; let size = 0; let over = false;
    // Read to the end even past the cap, so the 413 reaches a client still sending.
    for await (const c of req) { size += c.length; if (size > BODY_CAP_BYTES) over = true; else chunks.push(c); }
    if (over) return json(res, 413, { error: 'relay-body-too-large', cap: BODY_CAP_BYTES });
    const body = Buffer.concat(chunks);

    if (cls === 'spool') {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct && ct !== 'application/json') return json(res, 415, { error: 'otlp-json-only', relay: true });
      if (!spool) return json(res, 503, { error: 'spool-unavailable', relay: true });
      let otlp;
      try { otlp = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'invalid-json', relay: true }); }
      try { spool.append('otel', otlp); } catch (e) {
        if (e instanceof RangeError) return json(res, 413, { error: 'otlp-too-large', relay: true });
        log(`[tap-relay] could not spool an OTLP export: ${e.message}`);
        return json(res, 503, { error: 'spool-unavailable', relay: true });
      }
      return json(res, 200, { partialSuccess: {} });
    }

    if (cls === 'queue') {
      const queueIt = () => (enqueue({ method, pathAndQuery: rawUrl, contentType: req.headers['content-type'], body })
        ? json(res, 202, { ok: true, queued: true, relay: true })
        : json(res, 503, { error: 'relay-queue-full', relay: true, cap: queueCapBytes }));
      if (queue.length) { queueIt(); drain().catch(() => {}); return; }
      const r = await send(method, rawUrl, req.headers, body);
      if (r.kind === 'unreachable' || r.kind === 'unavailable' || (r.kind === 'response' && r.status === 401)) return queueIt();
      if (r.kind === 'failed') return json(res, 502, { error: 'relay-forward-failed', relay: true, reason: r.error });
      return reply(res, r);
    }

    const r = await send(method, rawUrl, req.headers, body);
    if (r.kind === 'response') {
      if (cls === 'cache' && r.status === 200 && r.body.length <= CACHE_ENTRY_CAP_BYTES) {
        cache.delete(rawUrl);
        cache.set(rawUrl, { cachedAt: now(), status: r.status, headers: r.headers, body: r.body });
        while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
      }
      if (queue.length) drain().catch(() => {});
      return reply(res, r);
    }
    if (r.kind === 'failed') return json(res, 502, { error: 'relay-forward-failed', relay: true, reason: r.error });
    if (cls === 'cache' && cache.has(rawUrl)) {
      const hit = cache.get(rawUrl);
      cache.delete(rawUrl); cache.set(rawUrl, hit);
      return reply(res, { ...hit, headers: { ...hit.headers, [STALE_HEADER]: String(hit.cachedAt) } });
    }
    return json(res, 503, offlineBody(r));
  }

  return {
    handle,
    drain,
    /** The heartbeat reached the server: stop answering offline and replay. */
    online() { offlineUntil = 0; lastError = null; if (queue.length) drain().catch(() => {}); },
    queueDepth: () => queue.length,
    draining: () => draining !== null,
    status: () => ({ queueDepth: queue.length, queueBytes: queueBytes(), cacheEntries: cache.size, offline: now() < offlineUntil, lastError }),
  };
}
