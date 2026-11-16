// server/lib/orchestration/session-closer.js
// Finds and ends the Claude sessions the runner started for a card (card
// glmps-2-0-85). An interactive claude waits for input after its last turn, so
// its console window outlives the card unless something closes it. A session
// is recognized by the card's own prompt file in its command line
// (<stateDir>/runner/<id>.prompt.md, runner-store.js), which every launch of
// the card, new or resumed, carries. GLMPS 1.0 shares that runner folder, so
// the session id the card recorded must match too (close-sync.js).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// When a session last wrote anything: its transcript, or a helper (subagent)
// transcript in <transcript without .jsonl>/subagents/. A session waiting on
// background helpers writes nothing to its own transcript (card
// glmps-2-0-runtime-89). null when the transcript cannot be read.
export function lastWriteWithHelpers(transcriptPath) {
  if (!transcriptPath) return null;
  let last;
  try { last = fs.statSync(transcriptPath).mtimeMs; } catch { return null; }
  const dir = path.join(transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return last; }
  for (const n of names) {
    try { last = Math.max(last, fs.statSync(path.join(dir, n)).mtimeMs); } catch { /* removed mid-scan */ }
  }
  return last;
}

const PROMPT_RE = /[\\/]runner[\\/]([a-z0-9][a-z0-9-]*)\.prompt\.md/i;
const SESSION_RE = /--(?:session-id|resume)[ =]"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const LAUNCHERS = new Set(['sh.exe', 'bash.exe', 'cmd.exe']);
const QUERY = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='sh.exe' OR Name='bash.exe' OR Name='cmd.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";

export function sessionIdOf(commandLine) {
  const m = SESSION_RE.exec(String(commandLine ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export function promptTicketOf(commandLine) {
  const m = PROMPT_RE.exec(String(commandLine ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// The tree is ended from the topmost launcher started for the same prompt
// file, so the console window goes with it; an ancestor that does not name
// the file (the operator's own shell, the desktop app) is never touched.
export function planSessions(procs) {
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  const out = [];
  for (const p of procs) {
    if (String(p.Name).toLowerCase() !== 'claude.exe') continue;
    const ticketId = promptTicketOf(p.CommandLine);
    if (!ticketId) continue;
    let root = p;
    for (let up = byPid.get(root.ParentProcessId), hops = 0; up && hops < 4; up = byPid.get(up.ParentProcessId), hops++) {
      if (!LAUNCHERS.has(String(up.Name).toLowerCase()) || promptTicketOf(up.CommandLine) !== ticketId) break;
      root = up;
    }
    out.push({ ticketId, sessionId: sessionIdOf(p.CommandLine), pid: p.ProcessId, rootPid: root.ProcessId });
  }
  return out;
}

const run = (execFileImpl, file, args, timeoutMs) => new Promise((resolve) => {
  execFileImpl(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout = '', stderr = '') => {
    resolve({ err, stdout: String(stdout), stderr: String(stderr) });
  });
});

export function createSessionCloser({ execFileImpl = execFile, platform = process.platform, timeoutMs = 20_000 } = {}) {
  async function list() {
    if (platform !== 'win32') return [];
    const r = await run(execFileImpl, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY], timeoutMs);
    if (r.err) throw new Error(`process list failed: ${r.err.message}${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ''}`);
    const text = r.stdout.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return planSessions(Array.isArray(parsed) ? parsed : [parsed]);
  }
  async function close({ rootPid }) {
    if (platform !== 'win32') return { ok: false, error: 'not supported on this platform' };
    if (!Number.isInteger(rootPid) || rootPid <= 0) return { ok: false, error: `bad pid: ${rootPid}` };
    const r = await run(execFileImpl, 'taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], timeoutMs);
    // 128: the process already exited between the list and the kill.
    if (r.err && r.err.code !== 128) return { ok: false, error: (r.stderr || r.err.message).trim().slice(0, 200) };
    return { ok: true };
  }
  return { list, close };
}
