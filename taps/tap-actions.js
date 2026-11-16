// taps/tap-actions.js
// The tap's action claimer (card glmps-2-0-runtime-45). Polls the server for
// launch records aimed at this client, claims each, runs it on this machine and
// posts the outcome. The server is not trusted: every record is re-checked here
// against this client's own project roots and the terminal allowlist the server
// sent, and anything that does not pass is answered with an error, never run.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { TAP_PROTOCOL, TAP_PROTOCOL_HEADER } from '../server/lib/kernel/tap-protocol.js';
import { pathIssue, insideRoots } from '../server/lib/kernel/client-actions.js';
import { nativeTerminalRecipe } from '../server/lib/orchestration/editor-targets.js';
import { shellSafePathSyntax, shellArg } from '../server/lib/orchestration/guarded-spawn.js';
import { FileApi } from '../server/lib/governance/file-api.js';
import { isTestProcess } from '../server/lib/test-process.js';

export const LAUNCHES_PATH = '/api/launches';
export const ACTION_TICK_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PER_TICK = 10;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createActionClaimer({ getCreds, getProjectRoots, home, fetch: fetchFn = globalThis.fetch, spawn, log = console.error, platform = process.platform, env = process.env }) {
  let inFlight = false;
  let handled = 0;
  let lastTickTs = null;
  let lastError = null;
  let lastAction = null;

  const headers = (creds) => ({ 'content-type': 'application/json', authorization: `Bearer ${creds.token}`, [TAP_PROTOCOL_HEADER]: String(TAP_PROTOCOL) });
  const url = (creds, p) => `${creds.config.server}${p}`;

  // Returns an error string, or null when `p` is an acceptable absolute path under a project root.
  function placeIssue(p) {
    const bad = pathIssue(p);
    if (bad) return bad;
    return insideRoots(getProjectRoots(), p) ? null : 'path is not under this client\'s project roots';
  }
  function dirIssue(p) {
    const bad = placeIssue(p);
    if (bad) return bad;
    const syn = shellSafePathSyntax(p);
    return syn.ok ? null : syn.reason;
  }

  function openTerminal(rec, allowedCommands) {
    const bad = dirIssue(rec.cwd);
    if (bad) return { error: `cwd refused: ${bad}` };
    const cmds = (allowedCommands || []).filter((c) => typeof c === 'string' && c);
    if (!cmds.length) return { error: 'command refused: the server sent no terminal allowlist' };
    const shape = rec.origin === 'resume'
      ? new RegExp(`^(?:${cmds.map(escapeRe).join('|')}) --resume ${UUID}$`)
      : new RegExp(`^(?:${cmds.map(escapeRe).join('|')})$`);
    if (typeof rec.command !== 'string' || !shape.test(rec.command)) return { error: 'command refused: not in the terminal allowlist' };
    const spawnFn = spawn ?? (isTestProcess({ env }) ? null : nodeSpawn);
    if (!spawnFn) return { error: 'refused: test process, no injected spawn seam' };
    const recipe = nativeTerminalRecipe({ platform, seededCmd: rec.command, cwd: path.resolve(rec.cwd), env: { ...process.env, ...env } });
    return launch(spawnFn, recipe.file, recipe.args, recipe.options, 'terminal did not start');
  }

  function openEditor(rec, creds) {
    const p = rec.action?.path;
    if (rec.action?.kind !== 'open') return { error: 'editor action must be open' };
    const bad = dirIssue(p);
    if (bad) return { error: `path refused: ${bad}` };
    const spawnFn = spawn ?? (isTestProcess({ env }) ? null : nodeSpawn);
    if (!spawnFn) return { error: 'refused: test process, no injected spawn seam' };
    const cfg = creds.config;
    const command = typeof cfg.editorCommand === 'string' && cfg.editorCommand ? cfg.editorCommand : 'antigravity';
    // Editors on Windows are .cmd shims that only resolve through the shell, so
    // there the path goes quoted (shellArg refuses any metacharacter), as the
    // kernel's own editor launch does.
    const win = platform === 'win32';
    const args = (Array.isArray(cfg.editorArgs) ? cfg.editorArgs : ['-g', '{path}']).map((a) => String(a).replace('{path}', () => (win ? shellArg(p) : p)));
    return launch(spawnFn, command, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: win }, 'editor did not start');
  }

  function launch(spawnFn, file, args, options, failMsg) {
    let child;
    try { child = spawnFn(file, args, options); } catch (e) { return { error: `${failMsg}: ${e?.message || e}` }; }
    child?.on?.('error', (e) => log(`[tap-actions] spawned process error: ${e?.message || e}`));
    child?.unref?.();
    return Number.isInteger(child?.pid) ? { pid: child.pid } : { error: failMsg };
  }

  function runFile(rec) {
    const a = rec.action;
    if (!a || !['read', 'save', 'undo'].includes(a.op)) return { error: 'file action op must be read, save or undo' };
    const bad = placeIssue(a.path);
    if (bad) return { result: { status: 403, body: { error: bad } } };
    const api = new FileApi(getProjectRoots(), path.join(home, 'undo'));
    try {
      if (a.op === 'read') return { result: { status: 200, body: api.read(a.path) } };
      if (a.op === 'undo') return { result: { status: 200, body: api.undo(a.path) } };
      if (typeof a.content !== 'string') return { error: 'save needs string content' };
      return { result: { status: 200, body: api.save(a.path, a.content, a.hash, { force: a.force === true }) } };
    } catch (e) {
      const msg = e?.message || String(e);
      const status = /conflict/i.test(msg) ? 409 : /^Path not allowed/.test(msg) ? 403 : e?.code === 'ENOENT' ? 404 : 500;
      return { result: { status, body: { error: msg } } };
    }
  }

  function execute(rec, creds, allowedCommands) {
    if (rec.origin === 'terminal' || rec.origin === 'resume') return openTerminal(rec, allowedCommands);
    if (rec.origin === 'editor') return openEditor(rec, creds);
    if (rec.origin === 'file') return runFile(rec);
    return { error: `origin not supported by this client: ${rec.origin}` };
  }

  async function post(creds, p, body) {
    return fetchFn(url(creds, p), { method: 'POST', headers: headers(creds), body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  async function tick() {
    if (inFlight) return { skipped: 'in-flight' };
    const creds = getCreds();
    if (!creds) return { skipped: 'no-credentials' };
    inFlight = true;
    lastTickTs = Date.now();
    try {
      let res;
      try { res = await fetchFn(url(creds, LAUNCHES_PATH), { headers: headers(creds), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
      catch (e) { lastError = e?.cause?.code || e?.message || String(e); return { error: lastError }; }
      if (res.status !== 200) { lastError = `server answered ${res.status}`; return { error: lastError }; }
      const body = await res.json().catch(() => null);
      lastError = null;
      const pending = Array.isArray(body?.pending) ? body.pending.slice(0, MAX_PER_TICK) : [];
      let ran = 0;
      for (const rec of pending) {
        if (!rec || typeof rec.id !== 'string' || !/^[\w-]+$/.test(rec.id)) continue;
        try {
          const claim = await post(creds, `${LAUNCHES_PATH}/${rec.id}/claim`, { by: `tap:${creds.config.clientId}` });
          if (claim.status !== 200) continue;
          const out = execute(rec, creds, body.allowedCommands);
          lastAction = { id: rec.id, origin: rec.origin, ok: !out.error, ts: Date.now() };
          const sent = await post(creds, `${LAUNCHES_PATH}/${rec.id}/result`, out.error ? { error: String(out.error).slice(0, 500) } : out.result ? { result: out.result } : { pid: out.pid ?? null });
          if (sent.status !== 204 && sent.status !== 200) log(`[tap-actions] result for ${rec.id} answered ${sent.status}`);
          handled++; ran++;
        } catch (e) { lastError = e?.message || String(e); log(`[tap-actions] ${rec.id}: ${lastError}`); }
      }
      return { ran };
    } finally { inFlight = false; }
  }

  return { tick, busy: () => inFlight, status: () => ({ handled, lastTickTs, lastError, lastAction }) };
}
