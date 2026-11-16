// apps/shell/src/lib/agy-runner.js
// Runs the agy calls the kernel queued. The kernel runs as a Windows service in
// session 0 and cannot load the operator's agy sign-in, and no service may hold
// the operator's credentials; this shell runs in the operator's own session. It
// claims each 'agy' launch record through the same authenticated protocol the
// launch runner uses (launch-client.js), runs agy, and posts the text back.
//
// The argv is built here from the record's model and prompt only; nothing from
// the record is ever run as a command string. The spawn recipe, the answer
// extraction and the environment filter are copied from
// server/lib/observability/wiki-agy.js (the shell must not import server code);
// apps/shell/test/agy-runner.test.js keeps the copies equal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createLaunchClient } from './launch-client.js';
import { defaultReadLaunchToken } from './launch-runner.js';

const require = createRequire(import.meta.url);

// Copy of server/lib/huddle/agy-models.js (agy 1.4.7, `agy models`).
export const AGY_MODELS = Object.freeze([
  'Gemini 4 Argon (Medium)',
  'Gemini 4 Argon (High)',
  'Gemini 4 Argon (Low)',
  'Gemini 3.8 Flash (High)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (Low)',
  'Claude Opus 5.5 (Low)',
  'Claude Opus 5.5 (Medium)',
  'Claude Opus 5.5 (High)',
  'Claude Sonnet 5.5 (Low)',
  'Claude Sonnet 5.5 (Medium)',
  'Claude Sonnet 5.5 (High)',
  'GPT-OSS 120B (Medium)',
]);
// Copy of newestGeminiModel in server/lib/huddle/agy-models.js.
const GEMINI_NAME = /^Gemini (\d+(?:\.\d+)*) .+ \((High|Medium|Low)\)$/;
const cmpVersion = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
export function newestGeminiModel(names, tier = 'High') {
  let best = null;
  for (const n of Array.isArray(names) ? names : []) {
    const m = typeof n === 'string' ? GEMINI_NAME.exec(n) : null;
    if (!m || m[2] !== tier) continue;
    if (!best || cmpVersion(m[1], best.v) > 0) best = { v: m[1], name: n };
  }
  return best?.name ?? null;
}
const PROMPT_MAX = 32000;
const RESULT_MAX = 4000;
// agy logs this when it has no usable sign-in and opens a browser OAuth.
export const AGY_SIGNIN_MARKER = 'triggering interactive OAuth';
const SIGNIN_ERROR = 'agy is not signed in for this Windows account (it tried to open a browser sign-in). Run agy once in a terminal to sign in.';

const TOOL_GUARD =
  'IMPORTANT: You are acting purely as a text generator. Do NOT use any tools. Do NOT read, ' +
  'write, or execute any files or shell commands. Respond with ONLY the requested Markdown content.\n\n';

// Only what agy needs to find its binary, its OAuth profile and a temp dir.
const AGY_ENV_KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'SystemDrive',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'LOGNAME', 'OS', 'LANG', 'LC_ALL',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
export function agyChildEnv(src = process.env) {
  const out = {};
  for (const k of AGY_ENV_KEEP) if (src[k] != null) out[k] = src[k];
  return out;
}

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
export function extractAgyText(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const out = [];
  walk(buf, [], out);
  const at = (a, b) => out.find(([p]) => p.length === 2 && p[0] === a && p[1] === b);
  const hit = at(20, 1) || at(20, 8); // (20,1) primary, (20,8) duplicate fallback
  if (!hit) throw new Error('answer field (20,1) not found in the agy payload');
  return hit[1];
}

const defaultConvDir = () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

function defaultReadDb(convDir, conversationId) {
  const file = path.join(convDir, `${conversationId}.db`);
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('select step_payload from steps where step_type = 15 order by idx desc limit 1').get();
    return row ? row.step_payload : null;
  } finally { db.close(); }
}

// Kill this call's own agy and its descendants, never anything by image name.
export function defaultKillTree(child) {
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

function isTestProcess() {
  return !!(process.env.NODE_TEST_CONTEXT || process.env.GLMPS_TEST === '1' || /\.test\.m?js$/.test(process.argv?.[1] ?? ''));
}
function refusingSpawn() {
  throw new Error('refused: test process, no injected spawnImpl');
}

export function validateAgyJob(r) {
  if (!r || r.origin !== 'agy') return { ok: false, reason: `not an agy record: ${r?.origin}` };
  if (!AGY_MODELS.includes(r.model)) return { ok: false, reason: `model is not on the allowlist: ${r.model}` };
  if (typeof r.prompt !== 'string' || !r.prompt || r.prompt.length >= PROMPT_MAX) return { ok: false, reason: `prompt must be a string under ${PROMPT_MAX} chars` };
  return { ok: true };
}

function parseAgyJson(stdout) {
  const s = String(stdout ?? '').trim();
  const tries = [s, ...s.split(/\r?\n/).reverse().filter((l) => l.trim().startsWith('{'))];
  for (const t of tries) {
    try { const j = JSON.parse(t); if (j && typeof j === 'object' && 'status' in j) return j; } catch { /* not this one */ }
  }
  return null;
}

const tail = (s, n = 300) => String(s ?? '').trim().slice(-n);

export function createAgyRunner({
  kernelUrl, fetchImpl = fetch, spawnImpl, stateDir = null, readLaunchToken = defaultReadLaunchToken, log = () => {},
  intervalMs = 500, timeoutMs = 40000, logWatchMs = 250, convDir = defaultConvDir(), readDb = defaultReadDb,
  env = agyChildEnv(), killTree = defaultKillTree, tmpRoot = os.tmpdir(),
}) {
  const realSpawn = spawnImpl ?? (isTestProcess() ? refusingSpawn : spawn);
  const { authedRequest, verifiedJson } = createLaunchClient({ kernelUrl, fetchImpl });
  let timer = null; let busy = false; let lastLogged = '';

  // One agy call. Resolves { text } or { error }; never throws.
  async function runAgy({ model, prompt }) {
    let cwd = null;
    try {
      cwd = fs.mkdtempSync(path.join(tmpRoot, 'agy-shell-'));
      const logFile = path.join(cwd, 'agy.log');
      // --model MUST come before -p, or agy ignores the prompt. Every call is a
      // fresh conversation: never --continue or --conversation.
      const args = ['--model', model, '--output-format', 'json', '--log-file', logFile, '-p', TOOL_GUARD + prompt];
      const run = await new Promise((resolve, reject) => {
        const child = realSpawn('agy', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
        let out = ''; let err = ''; let done = false; let signin = false; let timedOut = false; let watch = null;
        const finish = (fn) => { if (done) return; done = true; clearTimeout(watch); clearTimeout(limit); fn(); };
        const limit = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
        const poll = () => {
          if (done || signin) return;
          let text = '';
          try { text = fs.readFileSync(logFile, 'utf8'); } catch { /* not written yet */ }
          if (text.includes(AGY_SIGNIN_MARKER)) { signin = true; killTree(child); return; }
          watch = setTimeout(poll, logWatchMs);
        };
        watch = setTimeout(poll, logWatchMs);
        child.stdout?.on('data', (d) => { out = (out + d).slice(-20000); });
        child.stderr?.on('data', (d) => { err = (err + d).slice(-20000); });
        child.on('close', (code, sig) => finish(() => {
          if (signin) return resolve({ error: SIGNIN_ERROR });
          if (timedOut) return resolve({ error: `agy timed out after ${timeoutMs} ms` });
          resolve({ code, sig, out, err });
        }));
        child.on('error', (e) => finish(() => (signin ? resolve({ error: SIGNIN_ERROR }) : reject(e))));
      });
      if (run.error) return { error: run.error };
      const result = parseAgyJson(run.out);
      if (result && String(result.status).toUpperCase() === 'ERROR') {
        return { error: `agy reported an error: ${tail(typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? result))}` };
      }
      if (run.code !== 0) return { error: `agy exited with code ${run.code}${run.sig ? ` (${run.sig})` : ''}: ${tail(run.err) || '(no stderr)'}` };
      const conversationId = result && String(result.status).toUpperCase() === 'SUCCESS' && result.conversation_id ? String(result.conversation_id) : null;
      if (!conversationId) return { error: 'agy returned no conversation id' };
      const blob = readDb(convDir, conversationId);
      if (!blob) return { error: `no conversation DB after agy returned (conversation ${conversationId})` };
      return { text: extractAgyText(blob).slice(0, RESULT_MAX) };
    } catch (e) {
      return { error: e?.message ?? String(e) };
    } finally {
      if (cwd) { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (e) { log(`agy temp cleanup failed for ${cwd}: ${e.message}`); } }
    }
  }

  const logOnce = (key, message) => { if (key === lastLogged) return; lastLogged = key; log(message); };

  async function tick() {
    if (busy) return; busy = true;
    try {
      const { token, reason } = readLaunchToken(stateDir);
      if (!token) { logOnce(`token:${reason}`, `agy: ${reason} - refusing to run any queued agy call`); return; }
      const { res: pollRes, target: pollTarget } = await authedRequest(token, '/api/launches?state=pending');
      if (!pollRes.ok) { logOnce(`status:${pollRes.status}`, `agy: kernel answered ${pollRes.status}`); return; }
      const verifiedPoll = await verifiedJson(token, pollRes, pollTarget);
      if (!verifiedPoll.ok) { logOnce('unverified', `agy: ${verifiedPoll.reason}`); return; }
      lastLogged = '';
      const pending = Array.isArray(verifiedPoll.body?.pending) ? verifiedPoll.body.pending : [];
      for (const r of pending) {
        if (r?.origin !== 'agy' || typeof r.id !== 'string') continue;
        try {
          const { res: claimRes, target: claimTarget } = await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/claim`, { method: 'POST', body: { by: 'desktop-shell' } });
          if (!claimRes.ok) continue;
          const verifiedClaim = await verifiedJson(token, claimRes, claimTarget);
          if (!verifiedClaim.ok) { log(`agy call ${r.id} refused: ${verifiedClaim.reason}`); continue; }
          const v = validateAgyJob(r);
          const outcome = v.ok ? await runAgy(r) : { error: `refused by shell: ${v.reason}` };
          await authedRequest(token, `/api/launches/${encodeURIComponent(r.id)}/result`, { method: 'POST', body: outcome.error ? { error: String(outcome.error).slice(0, 500) } : { text: outcome.text } });
        } catch (e) {
          log(`agy call ${r.id} failed: ${e.message}`);
        }
      }
    } catch (e) { logOnce(`error:${e.message}`, `agy: ${e.message}`); } finally { busy = false; }
  }

  return { tick, start() { if (!timer) timer = setInterval(() => { void tick(); }, intervalMs); }, stop() { clearInterval(timer); timer = null; } };
}
