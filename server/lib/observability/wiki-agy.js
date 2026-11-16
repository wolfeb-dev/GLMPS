// server/lib/observability/wiki-agy.js
// Generate text via the Antigravity CLI (`agy`) using the user's authenticated
// Google account (Cloud Code Assist), which avoids the direct Gemini API free-tier
// quota. Zero deps (node builtins only).
//
// Hard-won facts (see memory `agy-headless-usage`):
//  - `agy -p` stdout is UNRELIABLE (empty ~1/9 on cold start). The response is
//    always written to a per-conversation SQLite DB; read from there instead.
//  - DB: ~/.gemini/antigravity-cli/conversations/<uuid>.db, table `steps`,
//    step_type=15 = assistant message, step_payload = length-prefixed protobuf.
//    The final answer text is at protobuf field path (20,1) ((20,3)=chain-of-
//    thought decoy, (20,8)=duplicate). Synchronous: DB is complete on exit.
//  - agy is an AGENT with tool perms "always-proceed" in print mode. Run it in a
//    throwaway cwd and tell it to emit text only, so it can't touch the repo.
//  - Correlation: by the conversation_id agy prints with --output-format json
//    (1.3.4), else by the .db the call created. SERIAL calls only, never parallel.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isTestProcess, noRealAdapterDataDir } from '../paths.js';
import { AGY_MODELS, newestGeminiModel } from '../huddle/agy-models.js';

const require = createRequire(import.meta.url);

// Phase K final review (minors wave): this constant used to derive from
// os.homedir() directly at import time, so a test process with no explicit
// convDir override (agyAvailable(), or any future caller of agyGenerate()
// that relies on the default) scanned the operator's real agy conversation
// store. Redirected the same way paths.js's own agyCliDir is, via the
// shared noRealAdapterDataDir helper, so the two agree on where a redirected
// test run's "conversations" dir would live even though this module has no
// env/profile to hand a full getPaths() call. Production (no test signal)
// is unchanged. The real server route (server.js's /api/wiki/ask) already
// passes its own convDir derived from P.agyCliDir, so this only matters for
// callers that rely on the default.
export const AGY_CONV_DIR = isTestProcess()
  ? path.join(noRealAdapterDataDir('agy-cli'), 'conversations')
  : path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
// The newest allowlisted Gemini, so adding a model to the allowlist moves this
// default with it (card glmps-2-0-164). A retired name makes agy exit 1.
export const DEFAULT_AGY_MODEL = newestGeminiModel(AGY_MODELS);

// Schema-less protobuf walker: agy ships no .proto, so fields are found by path.
function readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos]; pos++;
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7;
  }
  throw new Error('truncated varint');
}

function walk(buf, prefix, out) {
  let pos = 0;
  const n = buf.length;
  while (pos < n) {
    let tag;
    try { [tag, pos] = readVarint(buf, pos); } catch { return; }
    const fieldNum = Math.floor(tag / 8), wire = tag & 7;
    if (fieldNum === 0) return;
    if (wire === 0) { try { [, pos] = readVarint(buf, pos); } catch { return; } }
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let len; try { [len, pos] = readVarint(buf, pos); } catch { return; }
      if (pos + len > n) return;
      const chunk = buf.subarray(pos, pos + len); pos += len;
      const p = [...prefix, fieldNum];
      const text = chunk.toString('utf8');
      if (text.length && !text.includes(String.fromCharCode(0xfffd))) {
        let printable = 0;
        for (const ch of text) { const c = ch.codePointAt(0); if (c >= 32 || ch === '\n' || ch === '\t' || ch === '\r') printable++; }
        if (printable / text.length > 0.85) out.push([p, text]);
      }
      if (chunk.length > 2) walk(chunk, p, out);
    } else return;
  }
}

/** Extract the assistant answer text from an agy `steps.step_payload` protobuf blob. */
export function extractAgyText(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const out = [];
  walk(buf, [], out);
  const at = (a, b) => out.find(([p]) => p.length === 2 && p[0] === a && p[1] === b);
  const hit = at(20, 1) || at(20, 8); // (20,1) primary, (20,8) duplicate fallback
  if (!hit) throw new Error('wiki-agy: answer field (20,1) not found in payload');
  return hit[1];
}

export function agyAvailable() {
  try { if (!fs.existsSync(AGY_CONV_DIR)) return false; } catch { return false; }
  return true;
}

// agy runs with auto-approved tools, so it must never inherit the
// server's tokens and keys. Only what it needs to find its binary, its OAuth
// profile files and a temp dir is passed through.
const AGY_ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'SystemDrive',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'LOGNAME', 'OS', 'LANG', 'LC_ALL',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
export function agyChildEnv(src = process.env) {
  const out = {};
  for (const k of AGY_ENV_KEEP) if (src[k] != null) out[k] = src[k];
  return out;
}

const TOOL_GUARD =
  'IMPORTANT: You are acting purely as a text generator. Do NOT use any tools. Do NOT read, ' +
  'write, or execute any files or shell commands. Respond with ONLY the requested Markdown content.\n\n';

// ONE call at a time in this process, whoever the caller (the wiki builder,
// the huddle's Gemini seat): the 1.0.10 fallback still correlates by which DB
// appeared. A failed call releases the chain; its error reaches its own caller.
let agyChain = Promise.resolve();

const tail = (s, n = 500) => String(s ?? '').trim().slice(-n);

// agy logs this line when it has no usable sign-in and opens a browser OAuth
// nobody sees (the server running as a service under another account).
export const AGY_SIGNIN_MARKER = 'triggering interactive OAuth';

// What does this agy take? `--output-format json` (1.3.4 does; 1.0.10 does not)
// and `--log-file`. Probed once per spawn implementation with `agy --help`, then cached.
const formatProbes = new WeakMap();
function agyCapabilities(spawnImpl, env) {
  if (!formatProbes.has(spawnImpl)) {
    formatProbes.set(spawnImpl, new Promise((resolve) => {
      let text = '';
      let child;
      const none = { json: false, logFile: false };
      try { child = spawnImpl('agy', ['--help'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, env }); }
      catch { resolve(none); return; }
      child.stdout?.on('data', (d) => { text += d; });
      child.stderr?.on('data', (d) => { text += d; });
      child.on('close', () => resolve({ json: /--output-format\b/.test(text), logFile: /--log-file\b/.test(text) }));
      child.on('error', () => resolve(none));
    }));
  }
  return formatProbes.get(spawnImpl);
}

// agy --output-format json prints one JSON object ({ status, conversation_id,
// error, ... }); tolerate log lines around it.
function parseAgyJson(stdout) {
  const s = String(stdout ?? '').trim();
  const tries = [s, ...s.split(/\r?\n/).reverse().filter((l) => l.trim().startsWith('{'))];
  for (const t of tries) {
    try { const j = JSON.parse(t); if (j && typeof j === 'object' && 'status' in j) return j; } catch { /* not this one */ }
  }
  return null;
}

// Kill this call's own agy and its descendants, never anything by image name.
// A fake child (tests) has no pid and gets child.kill().
export function defaultKillTree(child) {
  // Exited already: its pid may belong to another process by now. (A fake
  // child leaves these undefined, hence != rather than !==.)
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch { /* already gone */ } });
    } catch { try { child.kill(); } catch { /* already gone */ } }
    return;
  }
  try { child.kill?.('SIGTERM'); } catch { /* already gone */ }
}

// After an abort, how long to wait for the killed child to close before
// giving up on it, so a child that ignores the kill cannot wedge the chain.
const ABORT_CLOSE_WAIT_MS = 5000;

const abortError = () => Object.assign(new Error('wiki-agy: aborted'), { name: 'AbortError' });

/** Run agy headlessly and return the model's text (read from its SQLite DB). */
export async function agyGenerate(prompt, {
  model = DEFAULT_AGY_MODEL, timeout = 300000, cwd, convDir = AGY_CONV_DIR,
  spawnImpl = spawn, readDb = defaultReadDb, env = agyChildEnv(),
  signal = null, killTree = defaultKillTree, logWatchMs = 250,
} = {}) {
  if (spawnImpl === spawn && isTestProcess()) throw new Error('wiki-agy: refused, isTestProcess with no injected spawnImpl');
  const prior = agyChain;
  let release;
  agyChain = new Promise((r) => { release = r; });
  await prior;
  let tmpCwd = null;
  try {
  if (signal?.aborted) throw abortError();
  // Run in a throwaway cwd so agy's autonomous file tools can't touch the repo.
  const runCwd = cwd || (tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-wiki-')));
  // The probe can be slow on a cold start; an abort during it must not wait.
  let onProbeAbort;
  const probeAborted = new Promise((r) => { onProbeAbort = r; signal?.addEventListener('abort', r, { once: true }); });
  const caps = await Promise.race([agyCapabilities(spawnImpl, env), probeAborted]);
  signal?.removeEventListener('abort', onProbeAbort);
  if (signal?.aborted) throw abortError();
  const json = caps?.json;
  const logPath = caps?.logFile ? path.join(runCwd, 'agy.log') : null;
  const before = listDbs(convDir);
  const t0 = Date.now();
  const { code, exitSignal, stdout, stderr } = await new Promise((resolve, reject) => {
    // stdin MUST be 'ignore': agy blocks reading stdin when it's an open pipe
    // (execFile hangs indefinitely); 'ignore' gives it EOF at once. stdout and
    // stderr are piped so a failure carries agy's own reason.
    let done = false;
    let out = '';
    let err = '';
    // Arg order matters: --model MUST come before -p. Putting it between -p and
    // the prompt makes agy ignore the prompt and emit a generic greeting. Never
    // --continue or --conversation: every call is a fresh conversation.
    const args = ['--model', model, ...(json ? ['--output-format', 'json'] : []), ...(logPath ? ['--log-file', logPath] : []), '-p', TOOL_GUARD + prompt];
    // No spawn `timeout`: on Windows it kills agy.exe alone and leaves its
    // children running. The timeout goes through killTree like an abort.
    const child = spawnImpl('agy', args,
      { cwd: runCwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let timedOut = false;
    let signinMissing = false;
    let giveUp = null;
    const signinError = () => Object.assign(new Error('wiki-agy: agy is not signed in for this account (it tried to open a browser sign-in). If the server runs as a Windows service, run the service under the operator\'s own account.'), { code: 'AGY_NOT_SIGNED_IN' });
    const failure = () => (signinMissing ? signinError() : timedOut ?new Error(`wiki-agy: agy timed out after ${timeout} ms`) : abortError());
    const kill = () => {
      if (giveUp) return;
      killTree(child);
      // the chain is held until the child has closed, or this long at most
      giveUp = setTimeout(() => finish(() => reject(failure())), ABORT_CLOSE_WAIT_MS);
      giveUp.unref?.();
    };
    const onAbort = () => kill();
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; kill(); }, timeout) : null;
    // A chained timeout rather than an interval: it stops itself on a hit or on finish.
    let watch = null;
    const poll = () => {
      if (done || signinMissing) return;
      let text = '';
      try { text = fs.readFileSync(logPath, 'utf8'); } catch { /* not written yet */ }
      if (text.includes(AGY_SIGNIN_MARKER)) { signinMissing = true; kill(); return; }
      watch = setTimeout(poll, logWatchMs);
      watch.unref?.();
    };
    if (logPath) { watch = setTimeout(poll, logWatchMs); watch.unref?.(); }
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(watch);
      clearTimeout(timer);
      clearTimeout(giveUp);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.stdout?.on('data', (d) => { out = (out + d).slice(-20000); });
    child.stderr?.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('close', (c, sig) => finish(() => (signal?.aborted || timedOut || signinMissing ? reject(failure()) : resolve({ code: c, exitSignal: sig, stdout: out, stderr: err }))));
    child.on('error', (e) => finish(() => reject(signal?.aborted || timedOut || signinMissing ? failure() : e)));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  const result = json ? parseAgyJson(stdout) : null;
  if (result && String(result.status).toUpperCase() === 'ERROR') {
    const why = typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? result);
    throw new Error(`wiki-agy: agy reported an error: ${tail(why)}`);
  }
  if (code !== 0) {
    throw new Error(`wiki-agy: agy exited with code ${code}${exitSignal ? ` (${exitSignal})` : ''}: ${tail(stderr) || '(no stderr)'}${tail(stdout) ? ` | stdout: ${tail(stdout)}` : ''}`);
  }
  const conversationId = result && String(result.status).toUpperCase() === 'SUCCESS' && result.conversation_id ? String(result.conversation_id) : null;
  const blob = readDb(convDir, { conversationId, before, sinceMs: t0 });
  if (!blob) throw new Error(`wiki-agy: no new conversation DB after agy returned${conversationId ? ` (conversation ${conversationId})` : ''}`);
  return extractAgyText(blob);
  } finally {
    if (tmpCwd) { try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch { /* best effort */ } }
    release();
  }
}

function listDbs(convDir) {
  try { return new Set(fs.readdirSync(convDir).filter((f) => f.endsWith('.db'))); } catch { return new Set(); }
}

/**
 * Which conversation DB holds this call's answer. A conversation id from
 * --output-format json names it outright. Otherwise (agy 1.0.10) it is the
 * .db the call created (set difference against the listing taken before the
 * spawn), and only if none appeared, the newest by mtime since the call began.
 */
export function pickAgyDb(convDir, { conversationId = null, before = new Set(), sinceMs = 0 } = {}) {
  if (conversationId) {
    // The id comes from agy's stdout and becomes a file name.
    if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) throw new Error('wiki-agy: invalid conversation id from agy');
    return path.join(convDir, `${conversationId}.db`);
  }
  const now = listDbs(convDir);
  const byMtime = (names) => [...names]
    .map((f) => path.join(convDir, f))
    .map((p) => { try { return { p, m: fs.statSync(p).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.m - a.m);
  const created = [...now].filter((f) => !before.has(f));
  if (created.length) return byMtime(created)[0]?.p ?? null;
  const fresh = byMtime(now).filter((x) => x.m >= sinceMs - 1500);
  return fresh[0]?.p ?? null;
}

function defaultReadDb(convDir, ctx) {
  const file = pickAgyDb(convDir, ctx);
  if (!file || !fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('select step_payload from steps where step_type = 15 order by idx desc limit 1').get();
    return row ? row.step_payload : null;
  } finally { db.close(); }
}
