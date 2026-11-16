// apps/shell/src/lib/editor-runner.js
// Opens the files the kernel queued for the editor app. The kernel runs as a
// Windows service in session 0 and cannot put a desktop app on screen; this
// shell runs in the operator's own session. It claims each 'editor' launch
// record through the authenticated protocol (launch-client.js) and spawns the
// editor detached.
//
// The argv is built here from the editor settings the kernel advertises on its
// verified poll plus the record's path; nothing in a record is ever run as a
// command. The path rule is a copy of server/lib/orchestration/guarded-spawn.js
// (the shell must not import server code); the path goes on a shell:true line
// double-quoted, exactly as the kernel's own open-in-editor builds it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLaunchClient } from './launch-client.js';
import { defaultReadLaunchToken } from './launch-runner.js';

const SAFE_PATH = /^[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\u30FC\u3005\p{N} ._\-:\\/~+,=@#]+$/u;
const SAFE_COMMAND = /^[A-Za-z0-9_.:\\/ -]+$/;
const SAFE_ARG = /^[A-Za-z0-9_.:=\\/{}-]+$/;
const MAX_ARGS = 8;

function isTestProcess() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.GLMPS_TEST === '1' || /\.test\.m?js$/.test(process.argv?.[1] ?? ''));
}
function refusingSpawn() {
  throw new Error('refused: test process, no injected spawnImpl');
}

export function validateEditorJob(r, editor, { statSync = fs.statSync } = {}) {
  if (!r || r.origin !== 'editor') return { ok: false, reason: `not an editor record: ${r?.origin}` };
  const p = r.path;
  if (typeof p !== 'string' || !p || p.length > 1000 || !path.isAbsolute(p) || !SAFE_PATH.test(p)) return { ok: false, reason: 'path is not a clean absolute path' };
  try { statSync(p); } catch (e) { return { ok: false, reason: `path not found (${e?.code ?? 'stat failed'})` }; }
  if (!editor || typeof editor.command !== 'string' || !editor.command || editor.command.length > 260 || !SAFE_COMMAND.test(editor.command)) return { ok: false, reason: 'editor command is not configured or not a plain command' };
  const args = editor.args;
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === 'string' && SAFE_ARG.test(a))) return { ok: false, reason: 'editor arguments are not plain tokens' };
  if (!args.some((a) => a.includes('{path}'))) return { ok: false, reason: 'editor arguments carry no {path}' };
  const quoted = `"${/[\\/]$/.test(p) ? `${p}.` : p}"`;
  // shell:true joins file and args unquoted. SAFE_COMMAND has no double quote, so
  // wrapping a spaced path in one pair cannot be closed early.
  const file = /\s/.test(editor.command) ? `"${editor.command}"` : editor.command;
  return { ok: true, file, args: args.map((a) => a.split('{path}').join(quoted)) };
}

export function createEditorRunner({
  kernelUrl, fetchImpl = fetch, spawnImpl, stateDir = null, readLaunchToken = defaultReadLaunchToken, log = () => {}, intervalMs = 500,
}) {
  const realSpawn = spawnImpl ?? (isTestProcess() ? refusingSpawn : spawn);
  const { authedRequest, verifiedJson } = createLaunchClient({ kernelUrl, fetchImpl });
  let timer = null; let busy = false; let lastLogged = '';
  const logOnce = (key, message) => { if (key === lastLogged) return; lastLogged = key; log(message); };

  async function tick() {
    if (busy) return; busy = true;
    try {
      const { token, reason } = readLaunchToken(stateDir);
      if (!token) { logOnce(`token:${reason}`, `editor: ${reason} - refusing to open any queued file`); return; }
      const { res: pollRes, target: pollTarget } = await authedRequest(token, '/api/launches?state=pending');
      if (!pollRes.ok) { logOnce(`status:${pollRes.status}`, `editor: kernel answered ${pollRes.status}`); return; }
      const verifiedPoll = await verifiedJson(token, pollRes, pollTarget);
      if (!verifiedPoll.ok) { logOnce('unverified', `editor: ${verifiedPoll.reason}`); return; }
      lastLogged = '';
      const pending = Array.isArray(verifiedPoll.body?.pending) ? verifiedPoll.body.pending : [];
      const editor = verifiedPoll.body?.editor ?? null;
      for (const r of pending) {
        if (r?.origin !== 'editor' || typeof r.id !== 'string') continue;
        try {
          const { res: claimRes, target: claimTarget } = await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/claim`, { method: 'POST', body: { by: 'desktop-shell' } });
          if (!claimRes.ok) continue;
          const verifiedClaim = await verifiedJson(token, claimRes, claimTarget);
          if (!verifiedClaim.ok) { log(`editor open ${r.id} refused: ${verifiedClaim.reason}`); continue; }
          const claimed = verifiedClaim.body;
          const v = claimed?.path === r.path ? validateEditorJob(claimed, editor) : { ok: false, reason: 'record changed between poll and claim' };
          let pid = null; let error = null;
          if (!v.ok) error = `refused by shell: ${v.reason}`;
          else {
            try {
              const child = realSpawn(v.file, v.args, { detached: true, stdio: 'ignore', shell: true, windowsHide: true });
              child?.on?.('error', (e) => log(`editor open ${r.id} failed: ${e.message}`));
              child?.unref?.();
              pid = Number.isInteger(child?.pid) ? child.pid : null;
            } catch (e) { error = e?.message ?? String(e); }
          }
          await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/result`, { method: 'POST', body: error ? { error: String(error).slice(0, 500) } : { pid } });
        } catch (e) { log(`editor open ${r.id} failed: ${e.message}`); }
      }
    } catch (e) { logOnce(`error:${e.message}`, `editor: ${e.message}`); } finally { busy = false; }
  }

  return { tick, start() { if (!timer) timer = setInterval(() => { void tick(); }, intervalMs); }, stop() { clearInterval(timer); timer = null; } };
}
