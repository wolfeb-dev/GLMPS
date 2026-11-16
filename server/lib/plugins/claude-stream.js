// server/lib/plugins/claude-stream.js
// Claude through the operator's Claude Code plan, streaming (D28). One
// long-lived `claude -p` process per mind, fed one user turn at a time over
// stdin (--input-format stream-json) and read line by line from stdout
// (--output-format stream-json --verbose --include-partial-messages), so no
// reply pays the process start-up after the first. A separate module from
// claude-model.js because the lifecycle differs (a process that outlives a
// call); the flags, the model-name check and the win32 kill-tree are shared.
// Verified against Claude Code 2.1.281 on 2026-09-23 (see the huddle plan,
// Task 2).
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isClaudeModelName, killProcessTree, claudeChildEnv } from './claude-model.js';
import { isTestProcess } from '../test-process.js';

// The same last-line guard runClaude carries: with the
// real spawn (no transport injected), a test process or the operator's
// GLMPS_MODEL_RUNNER=off kill switch refuses BEFORE any temp dir or process.
function realSpawnRefusal({ env, processEnv, argv }) {
  if (env?.GLMPS_MODEL_RUNNER === 'off' || processEnv?.GLMPS_MODEL_RUNNER === 'off') return 'claude stream disabled (GLMPS_MODEL_RUNNER=off)';
  if (isTestProcess({ env, processEnv, argv })) return 'claude stream refused: test process, no injected spawn (spawnImpl)';
  return null;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_INSTRUCTION = 'Speak your next line now.';

export function streamArgs({ model, sysFile, effort = null, platform = process.platform }) {
  const win = platform === 'win32';
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, '--no-session-persistence', '--tools=', '--system-prompt-file', win ? `"${sysFile}"` : sysFile,
    '--setting-sources=', '--strict-mcp-config'];
  if (effort) args.push('--effort', effort);
  return args;
}

export function userTurn(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: String(text ?? '') } }) + '\n';
}

export function parseStreamLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return { kind: 'other' }; }
  if (j?.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') {
    return { kind: 'text', text: String(j.event.delta.text ?? '') };
  }
  if (j?.type === 'result') {
    return { kind: 'result', text: String(j.result ?? ''), isError: Boolean(j.is_error), stopReason: j.stop_reason ?? null, usage: j.usage ?? null };
  }
  return { kind: 'other' };
}

// What to send a mind this turn. A cold process (fedCount 0) gets the whole
// transcript; a warm one gets only the lines since it last spoke, minus its
// own (they are already in its history as its replies). With no transcript
// (the summary), the last user message goes as it is.
export function formatTurn({ body, fedCount = 0 }) {
  const tr = Array.isArray(body?.transcript) ? body.transcript : null;
  if (!tr) {
    const last = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
    return { content: typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? ''), fedCount };
  }
  const instruction = body.instruction ?? DEFAULT_INSTRUCTION;
  const line = (u) => `${u.name ?? u.speaker}: ${u.text}${u.truncated ? ' [interrupted]' : ''}`;
  if (fedCount === 0) {
    return { content: `Transcript so far:\n${tr.map(line).join('\n') || '(nothing yet)'}\n\n${instruction}`, fedCount: tr.length };
  }
  const fresh = tr.slice(fedCount).filter((u) => u.speaker !== body.speakerId);
  return { content: `Since you last spoke:\n${fresh.map(line).join('\n') || '(nothing new)'}\n\n${instruction}`, fedCount: tr.length };
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export function createClaudeStreamPool({
  spawnImpl = null, platform = process.platform, tmpDir = os.tmpdir(), killTree = killProcessTree,
  now = Date.now, turnTimeoutMs = 60_000, idleKillMs = 15 * 60_000, env = process.env,
  processEnv = process.env, argv = process.argv,
} = {}) {
  const procs = new Map();
  // key -> why its warm-up failed. Silent on its own (a failed pre-warm never
  // fails the huddle); it rides on that mind's next failed turn as
  // err.prewarmError, and a good turn clears it.
  const prewarmErrors = new Map();
  let closed = false;
  // idle reaper: a mind with no turn in flight for idleKillMs is killed, so an
  // abandoned huddle cannot hold seven claude processes on an always-on kernel.
  // Its next turn finds no process and starts cold with the whole transcript.
  function disarmIdle(p) { if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = null; } }
  function armIdle(p) {
    disarmIdle(p);
    if (!(idleKillMs > 0)) return;
    p.idleTimer = setTimeout(() => { p.idleTimer = null; if (!p.turn && !p.dead) kill(p); }, idleKillMs);
    p.idleTimer.unref?.();
  }
  const keyOf = (body) => crypto.createHash('sha1').update(`${body.model}\n${body.output_config?.effort ?? ''}\n${body.system ?? ''}`).digest('hex').slice(0, 16);

  function cleanup(p) {
    try { fs.rmSync(p.work, { recursive: true, force: true }); }
    catch (e) { console.error(`claude-stream: temp cleanup failed for ${p.work}: ${e.message}`); }
  }
  function fail(p, err) {
    const t = p.turn;
    p.turn = null;
    if (t) { clearTimeout(t.timer); t.reject(err); }
  }
  function kill(p) {
    p.dead = true;
    disarmIdle(p);
    if (procs.get(p.key) === p) procs.delete(p.key);
    const failed = (e) => console.error(`claude-stream: kill failed for pid ${p.child?.pid}: ${e.message}`);
    try { Promise.resolve(killTree(p.child, platform)).catch(failed); } catch (e) { failed(e); }
  }
  function onLine(p, line) {
    if (!line.trim()) return;
    const ev = parseStreamLine(line);
    const t = p.turn;
    if (!t) return;
    if (ev.kind === 'text') {
      if (t.ttftMs === null) t.ttftMs = now() - t.t0;
      t.text += ev.text;
      t.onText?.(ev.text, t.text);
    } else if (ev.kind === 'result') {
      p.turn = null;
      clearTimeout(t.timer);
      armIdle(p);
      if (ev.isError) t.reject(new Error(`claude error: ${ev.text.slice(0, 200)}`));
      else t.resolve({ text: t.text || ev.text, stopReason: ev.stopReason ?? 'end_turn', usage: ev.usage, refusal: ev.stopReason === 'refusal', ttftMs: t.ttftMs, totalMs: now() - t.t0, cold: t.cold });
    }
  }
  function start(key, body) {
    if (!isClaudeModelName(body.model)) throw new Error(`refusing an unsafe model name: ${String(body.model).slice(0, 40)}`);
    const effort = body.output_config?.effort ?? null;
    if (effort && !EFFORTS.has(effort)) throw new Error(`refusing an unknown effort: ${String(effort).slice(0, 20)}`);
    if (!spawnImpl) { const why = realSpawnRefusal({ env, processEnv, argv }); if (why) throw new Error(why); }
    const spawnFn = spawnImpl ?? nodeSpawn;
    const work = fs.mkdtempSync(path.join(tmpDir, 'mc-huddle-'));
    const sysFile = path.join(work, 'system.txt');
    fs.writeFileSync(sysFile, body.system || 'You are a text generator. Answer only with the requested text.');
    const child = spawnFn('claude', streamArgs({ model: body.model, sysFile, effort, platform }), {
      cwd: work, shell: platform === 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: claudeChildEnv(env),
    });
    const p = { key, child, work, fedCount: 0, buf: '', turn: null, dead: false, stderr: '', prewarmed: false, used: false };
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      p.buf += d;
      let i;
      while ((i = p.buf.indexOf('\n')) !== -1) { const line = p.buf.slice(0, i); p.buf = p.buf.slice(i + 1); onLine(p, line); }
    });
    child.stderr?.on('data', (d) => { p.stderr = (p.stderr + d).slice(-500); });
    // An early-exiting child closes its stdin; the turn is failed here and the
    // close handler below cleans up, so the error is never swallowed.
    child.stdin.on('error', (e) => fail(p, new Error(`claude stdin closed: ${e.message}`)));
    child.on('error', (e) => {
      if (p.prewarmed && !p.used) prewarmErrors.set(key, `claude spawn failed: ${e.message}`);
      kill(p); fail(p, new Error(`claude spawn failed: ${e.message}`));
    });
    child.on('close', (code) => {
      // a warming process that exits on its own (not killed by the pool) before
      // its first turn: remember why, for the next failed turn on this mind
      if (p.prewarmed && !p.used && !p.dead) prewarmErrors.set(key, `claude exited during warm-up (code ${code}): ${p.stderr.slice(0, 200)}`);
      p.dead = true;
      disarmIdle(p);
      if (procs.get(key) === p) procs.delete(key);
      cleanup(p);
      fail(p, new Error(`claude exited (code ${code}): ${p.stderr.slice(0, 200)}`));
    });
    procs.set(key, p);
    return p;
  }

  function streamMessage({ body, onText, signal } = {}) {
    return new Promise((resolveTurn, rejectTurn) => {
      if (closed) { rejectTurn(new Error('pool closed')); return; }
      if (signal?.aborted) { rejectTurn(abortError()); return; }
      const key = keyOf(body);
      const resolve = (r) => { prewarmErrors.delete(key); resolveTurn(r); };
      const reject = (e) => {
        const why = prewarmErrors.get(key);
        if (why && e && e.name !== 'AbortError') e.prewarmError = why;
        rejectTurn(e);
      };
      let p = procs.get(key);
      // A reused key with a shorter transcript is a new conversation (new huddle or
      // trimmed history): the warm process's history would be stale, so start over.
      if (p && !p.dead && !p.turn && Array.isArray(body.transcript) && p.fedCount > body.transcript.length) { kill(p); p = undefined; }
      const cold = !p || p.dead;
      try { if (cold) p = start(key, body); } catch (e) { reject(e); return; }
      if (p.turn) { reject(new Error('this mind is already answering')); return; }
      const { content, fedCount } = formatTurn({ body, fedCount: cold ? 0 : p.fedCount });
      const turn = { t0: now(), text: '', ttftMs: null, onText, resolve, reject, cold, timer: null };
      turn.timer = setTimeout(() => { if (p.turn === turn) { kill(p); fail(p, new Error(`claude turn timed out after ${turnTimeoutMs} ms`)); } }, turnTimeoutMs);
      p.turn = turn;
      p.used = true;
      disarmIdle(p);
      signal?.addEventListener('abort', () => { if (p.turn === turn) { kill(p); fail(p, abortError()); } }, { once: true });
      p.fedCount = fedCount;
      p.child.stdin.write(userTurn(content));
    });
  }
  streamMessage.stateful = true;

  // Starts a mind's process without sending a turn, keyed exactly as
  // streamMessage keys it, so the first real turn skips the process start-up.
  // That turn is warm (no restart) and, with fedCount 0, still carries the
  // whole transcript once. The idle reaper is armed as after any turn.
  // Resolves false (a no-op) when already warm or the pool is closed; rejects
  // when the process cannot be started (the error is also kept for the next
  // failed turn on this mind).
  function prewarm({ model, effort = null, system } = {}) {
    return new Promise((resolve, reject) => {
      if (closed) { resolve(false); return; }
      const body = { model, system, ...(effort ? { output_config: { effort } } : {}) };
      const key = keyOf(body);
      const cur = procs.get(key);
      if (cur && !cur.dead) { resolve(false); return; }
      let p;
      try { p = start(key, body); } catch (e) { prewarmErrors.set(key, e.message); reject(e); return; }
      p.prewarmed = true;
      armIdle(p);
      resolve(true);
    });
  }

  return {
    streamMessage,
    prewarm,
    close() { closed = true; for (const p of [...procs.values()]) kill(p); },
    size: () => procs.size,
  };
}

// The fail-open probe for POST /api/huddle: is the CLI there at all?
// Under a test process (or GLMPS_MODEL_RUNNER=off) with no spawnSyncImpl injected it
// answers false WITHOUT spawning, so a server booted in a test cannot probe the
// operator's real CLI. Async so a request never waits on the child, and the real
// probe's answer is cached for a minute (the probe is a process spawn).
const CLI_PROBE_TTL_MS = 60_000;
let cliProbe = null;
const realProbe = (file, args, opts) => new Promise((resolve) => {
  nodeExecFile(file, args, opts, (err, stdout) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '' }));
});
export async function claudeCliAvailable({ probeImpl = null, platform = process.platform, env = process.env, processEnv = process.env, argv = process.argv, now = Date.now } = {}) {
  if (!probeImpl && realSpawnRefusal({ env, processEnv, argv })) return false;
  if (!probeImpl && cliProbe && now() - cliProbe.at < CLI_PROBE_TTL_MS) return cliProbe.ok;
  const r = await (probeImpl ?? realProbe)('claude', ['--version'], { shell: platform === 'win32', windowsHide: true, timeout: 15_000, encoding: 'utf8', env: claudeChildEnv(env) });
  const ok = r?.status === 0 && /Claude Code/.test(String(r?.stdout ?? ''));
  if (!probeImpl) cliProbe = { ok, at: now() };
  return ok;
}
