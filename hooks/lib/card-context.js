// hooks/lib/card-context.js
// Shared by the K7 hooks: which card is this session working, and what is its
// chain. Every network call fails OPEN and says why - a missing board must
// never brick a tool call.
//
// Phase K final review I6: the 2.0 hooks default to the
// 2.0 kernel, not production. The board URL is GLMPS_BOARD_URL, else
// http://127.0.0.1:<GLMPS_PORT>, else the default port; the state dir is
// GLMPS_STATE_DIR, else the default state dir. D30 (cutover): the defaults are
// 8124 and ~/.glmps-2 until ~/.glmps/cutover/active.json
// exists (written by `node scripts/cutover.mjs config`, runbook C6), then 8123
// and ~/.glmps. Restoring the cold backup on rollback removes the
// marker, so the flip needs no code change in either direction.
// boardUrl()/envStateDir()/envTimeout() are called as default PARAMETER
// expressions below, which JS re-evaluates on every call that omits the
// argument - genuinely fresh per call, not a module-load-time snapshot a later
// env change (or a second call in the same process, e.g. a test) could
// silently miss.
import os from 'node:os';
import path from 'node:path';
import { appendCapped } from '../../server/lib/observability/append-log.js';
import { isCutoverActive } from '../../server/lib/kernel/cutover-marker.js';
import { envStateDirOverride, homeStateDir, shadowStateDirFor } from '../../server/lib/state-dir.js';

export const SHADOW_BOARD_PORT = 8124;
export const CUTOVER_BOARD_PORT = 8123;
// Kept for existing importers: the pre-cutover default.
export const DEFAULT_BOARD_PORT = SHADOW_BOARD_PORT;
export function defaultBoardPort(home = os.homedir()) {
  return isCutoverActive(home) ? CUTOVER_BOARD_PORT : SHADOW_BOARD_PORT;
}
export function boardUrl(env = process.env, home = os.homedir()) {
  if (env.GLMPS_BOARD_URL) return String(env.GLMPS_BOARD_URL).replace(/\/+$/, '');
  return `http://127.0.0.1:${Number(env.GLMPS_PORT) || defaultBoardPort(home)}`;
}
export function envStateDir(env = process.env, home = os.homedir()) {
  return envStateDirOverride(env) || (isCutoverActive(home) ? homeStateDir(home) : shadowStateDirFor(home));
}
function envTimeout() { return Number(process.env.GLMPS_HOOK_HTTP_TIMEOUT_MS) || 3000; }
const baseFor = (port) => (port ? `http://127.0.0.1:${port}` : boardUrl());

export function resolveCardId({ branch, env = process.env } = {}) {
  const m = String(branch || '').match(/^glmps-runner\/[^/]+\/(.+)$/);
  return m ? m[1] : (env.GLMPS_CARD_ID || null);
}

/**
 * @returns {Promise<{chain:object}|{chain:null,unknownCard:true}|{unavailable:string}>}
 * `port` (a stub on 127.0.0.1) or `baseUrl`, and `timeoutMs`, default to the
 * env-resolved values so the CLI hook needs no extra plumbing; tests override
 * them to point at a stub server without waiting out the real default timeout.
 */
export async function fetchChain(cardId, { port = null, baseUrl = baseFor(port), timeoutMs = envTimeout() } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/backlog/${encodeURIComponent(cardId)}/chain`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { unavailable: e?.name === 'TimeoutError' ? `board did not answer within ${timeoutMs}ms` : 'board unreachable' };
  }
  if (res.status === 404) return { chain: null, unknownCard: true };
  if (!res.ok) return { unavailable: `board returned HTTP ${res.status}` };
  try {
    return { chain: await res.json() };
  } catch (e) {
    return { unavailable: `board returned invalid JSON (${e.message})` };
  }
}

// The route's own field caps (server.js POST /api/guards/refusal). A field
// over its cap is a 400 there, which used to drop the whole report silently;
// capping here too means a long reason or path is truncated, never lost.
const REPORT_CAPS = { cardId: 128, sessionId: 128, tool: 64, path: 1024, reason: 2000 };
function capReport(body) {
  const out = { ...body };
  // session_id comes straight from the hook input; a non-string would 400 the
  // whole report, so it is dropped rather than losing the refusal.
  if (out.sessionId != null && typeof out.sessionId !== 'string') out.sessionId = null;
  for (const [k, max] of Object.entries(REPORT_CAPS)) {
    if (typeof out[k] === 'string' && out[k].length > max) out[k] = out[k].slice(0, max);
  }
  return out;
}

/**
 * Best-effort POST of a guard's refusal (or fail-open) so the dashboard's
 * recent-refusals feed sees it too. Never throws: the decision was already
 * made and shown to the agent by the time this runs. Phase K final review
 * (silent-failure): the response status is checked, and a report the board
 * refused or never received is logged locally
 * (<stateDir>/guards/report-failures.ndjson) with the reason, so a refusal
 * is never lost without a trace. Returns { ok, reason? }.
 */
export async function reportRefusal(body, { port = null, baseUrl = baseFor(port), timeoutMs = envTimeout(), stateDir = envStateDir() } = {}) {
  const capped = capReport(body);
  let reportError = null;
  try {
    const res = await fetch(`${baseUrl}/api/guards/refusal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(capped),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) reportError = `board returned HTTP ${res.status}`;
  } catch (e) {
    reportError = e?.name === 'TimeoutError' ? `board did not answer within ${timeoutMs}ms` : `board unreachable (${e?.cause?.code || e?.message || e})`;
  }
  if (!reportError) return { ok: true };
  try {
    appendCapped(path.join(stateDir, 'guards', 'report-failures.ndjson'), { ts: Date.now(), ...capped, reportError });
  } catch (e) {
    process.stderr.write(`${body?.hook || 'guard'}: could not report the refusal (${reportError}) and could not log it locally (${e.message})\n`);
  }
  return { ok: false, reason: reportError };
}
