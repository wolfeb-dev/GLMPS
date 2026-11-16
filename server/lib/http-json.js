// server/lib/http-json.js
// JSON responses, gzipped when the client accepts it. Baseline 2026-10-17
// (card glmps-2-0-53): no response was compressed, so every page pulled
// /api/state at 2.5 MB where gzip sends about 342 KB.
import zlib from 'node:zlib';

export const GZIP_MIN_BYTES = 1024;

export function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] ?? ''));
}

// Level 4 keeps a multi-megabyte body well under the time it saves on the wire.
export function writeJson(req, res, code, obj, headers = {}) {
  writeJsonBody(req, res, code, JSON.stringify(obj), headers);
}

// For a body already serialized (and possibly cached). `gzip` is a function
// returning the compressed buffer so a caller can share it between readers.
export function writeJsonBody(req, res, code, body, headers = {}, gzip = (b) => zlib.gzipSync(b, { level: 4 })) {
  if (body.length > GZIP_MIN_BYTES && acceptsGzip(req)) {
    res.writeHead(code, { 'content-type': 'application/json', 'content-encoding': 'gzip', vary: 'accept-encoding', ...headers });
    res.end(gzip(body));
    return;
  }
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(body);
}
