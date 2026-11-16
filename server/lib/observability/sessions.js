// server/lib/observability/sessions.js
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { claudeProjectDirName } from '../paths.js';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

// Windows FILETIME of each pid's process creation, the format Claude Code
// writes as procStart. Reads only ever touch the cache: the PowerShell probe
// takes ~0.7 s, and this is reached from the 1 s poll tick and from decision
// paths, so it runs as an async execFile in the background and a pid not yet
// probed reads as unvouched (never live) until it lands, one tick later. A
// creation time never changes while the pid lives, so a value is kept until
// the pid is seen dead, and past its 10 minute TTL it is still served while
// the refresh runs so an open window never blinks dead. A failed probe is kept
// for a minute so a broken shell is not respawned on every poll.
const PROC_START_TTL_MS = 10 * 60_000;
const PROC_START_FAIL_TTL_MS = 60_000;
const procStartCache = new Map();
let procStartProbe = null;
export function procStartsOf(pids, { platform = process.platform, execFileImpl = execFile, now = Date.now() } = {}) {
  const out = new Map();
  if (platform !== 'win32') return out; // unverifiable elsewhere, so never live
  const want = new Set(pids);
  for (const pid of procStartCache.keys()) if (!want.has(pid)) procStartCache.delete(pid);
  const due = [];
  for (const pid of want) {
    const c = procStartCache.get(pid);
    if (c?.start != null) out.set(pid, c.start);
    if (!c || now - c.at >= (c.start == null ? PROC_START_FAIL_TTL_MS : PROC_START_TTL_MS)) due.push(pid);
  }
  if (due.length && !procStartProbe) procStartProbe = probeProcStarts(due, execFileImpl, now).finally(() => { procStartProbe = null; });
  return out;
}

// Resolves once the background probe in flight (if any) has filled the cache,
// so an async decision path can wait for a pid it just asked about.
export function procStartsSettled() {
  return procStartProbe ?? Promise.resolve();
}

function probeProcStarts(pids, execFileImpl, startedAt) {
  return new Promise((resolve) => {
    const done = (text) => {
      const got = new Map();
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const m = /^(\d+) (\d+)$/.exec(line.trim());
        if (m) got.set(Number(m[1]), m[2]);
      }
      for (const pid of pids) procStartCache.set(pid, { start: got.get(pid) ?? null, at: startedAt });
      resolve();
    };
    try {
      execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.StartTime.ToFileTimeUtc())\" }`],
      { windowsHide: true, timeout: 10_000, encoding: 'utf-8' }, (err, stdout) => done(stdout ?? err?.stdout));
    } catch { done(''); }
  });
}

// Claude Code's own registry, <claudeDir>/sessions/<pid>.json, written by every
// session (interactive ones included) and removed when it exits. A pid alone is
// not proof the session is open: pids are reused, so an entry counts only while
// the process holding that pid started at the recorded procStart. The
// <pid>.<hash>.key files beside them are never read.
// -> Map<sessionId, { pid, cwd, status, kind }>
export function readClaudeSessionRegistry(sessionsDir, { procStarts = procStartsOf } = {}) {
  const live = new Map();
  if (!sessionsDir) return live;
  let names = [];
  try { names = fs.readdirSync(sessionsDir); } catch { return live; }
  const entries = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const e = readJson(path.join(sessionsDir, name), null);
    if (!e?.sessionId || !Number.isInteger(e.pid) || e.pid <= 0 || e.procStart == null) continue;
    if (pidAlive(e.pid)) entries.push(e);
  }
  if (!entries.length) return live;
  const starts = procStarts(entries.map((e) => e.pid));
  for (const e of entries) {
    if (starts.get(e.pid) !== String(e.procStart)) continue;
    live.set(e.sessionId, { pid: e.pid, cwd: e.cwd ?? null, status: e.status ?? null, kind: e.kind ?? null });
  }
  return live;
}

// Per-session statusline snapshots (<statusDir>/<id>.json) are read for every
// session on every poll tick and every session walk, and most sessions have
// none: a readFileSync miss throws ENOENT, which on Windows was most of the
// kernel's CPU (glmps-193). A no-throw stat answers the common miss, and a
// parsed file is reused until its mtime or size changes. Returns null for a
// missing or unparseable file. Callers must not mutate the returned object.
//
// indexDir() (glmps-2-0-runtime-86) lists the dir once; until the next call a
// session with no file there answers null with no stat at all, which took
// ~2,300 stats off every poll. The poll calls it each tick, so a new status
// file shows within one poll. An unreadable dir leaves the stat-per-read path.
export function createStatusReader(statusDir, fsImpl = fs) {
  const cache = new Map();
  let present = null;
  readStatus.indexDir = () => {
    try {
      present = new Set(fsImpl.readdirSync(statusDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
    } catch { present = null; }
  };
  return readStatus;
  function readStatus(id) {
    if (present && !present.has(String(id))) { cache.delete(id); return null; }
    const file = path.join(statusDir, `${id}.json`);
    let st;
    try { st = fsImpl.statSync(file, { throwIfNoEntry: false }); } catch { st = undefined; }
    if (!st) { cache.delete(id); return null; }
    const hit = cache.get(id);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    let value = null;
    try { value = JSON.parse(fsImpl.readFileSync(file, 'utf-8')); } catch { value = null; }
    cache.set(id, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }
}

function liveClaudeSessions({ activeSessionsFile, claudeSessionsDir = null, procStarts }) {
  const reg = readJson(activeSessionsFile, []);
  const regEntries = Array.isArray(reg) ? reg.filter(e => e?.sessionId) : [];
  const live = new Map();
  for (const e of regEntries) if (pidAlive(e.ppid)) live.set(e.sessionId, e);
  // Claude Code's own registry also sees sessions the hook-fed file never
  // recorded, e.g. an interactive window left open and idle.
  for (const [id, e] of readClaudeSessionRegistry(claudeSessionsDir, procStarts ? { procStarts } : undefined)) {
    if (!live.has(id)) live.set(id, { sessionId: id, cwd: e.cwd });
  }
  return { regEntries, live };
}

// registry entries not found by the scan still count (brand-new or foreign-dir sessions)
function addUnscannedRegistryEntries(out, regEntries, live) {
  for (const e of regEntries) {
    if (out.has(e.sessionId)) continue;
    const isLive = live.has(e.sessionId);
    out.set(e.sessionId, {
      id: e.sessionId, tool: 'claude-code', transcriptPath: e.transcriptPath,
      mtimeMs: isLive ? Date.now() : 0, cwd: e.cwd ?? null, live: isLive });
  }
}

// -> [{ id, tool:'claude-code', cwd, transcriptPath, live, mtimeMs }]
export function discoverClaudeSessions({ activeSessionsFile, projectsDir, claudeSessionsDir = null, procStarts }) {
  const { regEntries, live } = liveClaudeSessions({ activeSessionsFile, claudeSessionsDir, procStarts });

  const out = new Map();
  let projects = [];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch {}
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue; // root files only
      const id = f.name.slice(0, -'.jsonl'.length);
      const full = path.join(dir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      out.set(id, {
        id, tool: 'claude-code', transcriptPath: full, mtimeMs,
        cwd: live.get(id)?.cwd ?? null, live: live.has(id),
      });
    }
  }
  addUnscannedRegistryEntries(out, regEntries, live);
  return [...out.values()];
}

// The poll's discovery (glmps-198). The full scan above stats every transcript
// on every 1 s tick (~2,500 sync calls on this machine), which on a saturated
// disk stalled the event loop 23.9 s. This keeps the last scan and per call
// rescans only dirs that are new, hold a transcript changed within hotMs or a
// live session, are the home of a live session not yet located, or fall in a
// rotating 1/cycleTicks slice, so a cold dir is rescanned at least once a
// cycle. Same arguments and result as discoverClaudeSessions.
export function createClaudeDiscovery({ fsImpl = fs, now = Date.now, cycleTicks = 30, hotMs = 15 * 60_000 } = {}) {
  let root = null;
  let dirs = new Map(); // dir name -> Map<id, { full, mtimeMs }>
  let cursor = 0;
  function scan(name) {
    const dir = path.join(root, name);
    const files = new Map();
    let entries = [];
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { dirs.delete(name); return; }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue; // root files only
      const full = path.join(dir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fsImpl.statSync(full).mtimeMs; } catch {}
      files.set(f.name.slice(0, -'.jsonl'.length), { full, mtimeMs });
    }
    dirs.set(name, files);
  }
  return function discover({ activeSessionsFile, projectsDir, claudeSessionsDir = null, procStarts }) {
    const { regEntries, live } = liveClaudeSessions({ activeSessionsFile, claudeSessionsDir, procStarts });
    if (projectsDir !== root) { root = projectsDir; dirs = new Map(); cursor = 0; }
    let names = [];
    try { names = fsImpl.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
    const present = new Set(names);
    for (const name of dirs.keys()) if (!present.has(name)) dirs.delete(name);

    const due = new Set(names.filter((name) => !dirs.has(name)));
    const step = Math.ceil(names.length / cycleTicks);
    for (let i = 0; i < step; i++) due.add(names[(cursor + i) % names.length]);
    cursor = names.length ? (cursor + step) % names.length : 0;
    const t = now();
    const located = new Set();
    for (const [name, files] of dirs) {
      for (const [id, f] of files) {
        located.add(id);
        if (t - f.mtimeMs <= hotMs || live.has(id)) due.add(name);
      }
    }
    for (const [id, e] of live) {
      if (located.has(id) || !e.cwd) continue;
      const home = claudeProjectDirName(e.cwd);
      if (present.has(home)) due.add(home);
    }
    for (const name of due) scan(name);

    const out = new Map();
    for (const name of names) {
      for (const [id, f] of dirs.get(name) ?? []) {
        out.set(id, {
          id, tool: 'claude-code', transcriptPath: f.full, mtimeMs: f.mtimeMs,
          cwd: live.get(id)?.cwd ?? null, live: live.has(id),
        });
      }
    }
    addUnscannedRegistryEntries(out, regEntries, live);
    return [...out.values()];
  };
}

// -> [{ id, tool:'antigravity', dir, logPath|null, pbPath|null, mtimeMs, format:'log'|'pb' }]
export function discoverAgSessions({ antigravityDirs, brainDir }) {
  // Support legacy single-brainDir call (for backward compat in tests that pass {brainDir})
  const roots = antigravityDirs ?? (brainDir ? [path.dirname(brainDir)] : []);

  // keyed by id; keeps best entry across all roots
  const byId = new Map();

  function upsert(entry) {
    const existing = byId.get(entry.id);
    if (!existing) { byId.set(entry.id, entry); return; }
    // 'log' format beats 'pb'; same format -> keep max mtime
    if (existing.format === 'log' && entry.format === 'pb') {
      // keep existing log but update mtime if pb is newer
      if (entry.mtimeMs > existing.mtimeMs)
        existing.mtimeMs = entry.mtimeMs;
      return;
    }
    if (existing.format === 'pb' && entry.format === 'log') {
      byId.set(entry.id, { ...entry, mtimeMs: Math.max(entry.mtimeMs, existing.mtimeMs) });
      return;
    }
    // same format - keep max mtime
    if (entry.mtimeMs > existing.mtimeMs) byId.set(entry.id, entry);
  }

  for (const root of roots) {
    // scan brain/<id>/ for log-format sessions
    const scanBrainDir = path.join(root, 'brain');
    let brainEntries = [];
    try { brainEntries = fs.readdirSync(scanBrainDir, { withFileTypes: true }); } catch {}
    for (const d of brainEntries) {
      if (!d.isDirectory()) continue;
      let logPath = path.join(scanBrainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(logPath).mtimeMs;
      } catch {
        logPath = path.join(scanBrainDir, d.name, '.system_generated', 'logs', 'overview.txt');
        try {
          mtimeMs = fs.statSync(logPath).mtimeMs;
        } catch {
          continue;
        }
      }

      // Also check messages folder and history.jsonl for newer mtime to keep active sessions alive
      const msgDir = path.join(scanBrainDir, d.name, '.system_generated', 'messages');
      try {
        const msgMtime = fs.statSync(msgDir).mtimeMs;
        if (msgMtime > mtimeMs) mtimeMs = msgMtime;
      } catch {}

      const historyPath = path.join(root, 'history.jsonl');
      try {
        const histMtime = fs.statSync(historyPath).mtimeMs;
        if (histMtime > mtimeMs) mtimeMs = histMtime;
      } catch {}

      upsert({ id: d.name, tool: 'antigravity', dir: path.join(scanBrainDir, d.name),
        logPath, pbPath: null, mtimeMs, format: 'log' });
    }

    // scan conversations/*.pb for pb-format sessions
    const convsDir = path.join(root, 'conversations');
    let pbEntries = [];
    try { pbEntries = fs.readdirSync(convsDir, { withFileTypes: true }); } catch {}
    for (const f of pbEntries) {
      if (!f.isFile() || !f.name.endsWith('.pb')) continue;
      const id = f.name.slice(0, -'.pb'.length);
      const pbPath = path.join(convsDir, f.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(pbPath).mtimeMs; } catch {}
      upsert({ id, tool: 'antigravity', dir: convsDir,
        logPath: null, pbPath, mtimeMs, format: 'pb' });
    }
  }

  return [...byId.values()];
}

export function livenessOf(processAlive, lastWriteMs, nowMs, cfg) {
  if (!processAlive) return 'ended';
  return (nowMs - lastWriteMs) <= cfg.workingThresholdMs ? 'working' : 'idle';
}

// glmps-8b: GLMPS's own plugin loops spawn headless
// `claude -p` sessions (pre-D23: the session memory distiller's own
// extraction spawn, since retired; as of D23/D24, the shared model call
// every loop plugin uses, server/lib/plugins/claude-model.js). Those spawns
// show up in this same discovery scan as ordinary claude-code sessions -- 6
// "live" sessions when only 2 were real people, as measured live on
// 2026-07-29 -- so callers need a way to tell the two apart.
//
// Normalize the path separator before the substring check: Windows cwds use
// backslashes, and CI runs both Linux and Windows, so a raw-string match on
// '/mc-distill-' alone would silently pass on Linux (where paths already use
// forward slashes) while never matching a real Windows cwd, hiding a
// same-bug failure on the platform CI would have caught.
function normalizeCwd(cwd) {
  return typeof cwd === 'string' ? cwd.replace(/\\/g, '/') : '';
}

// A session is internal when its id is in the persisted internal-id set (the
// PRIMARY signal -- internal-sessions.js's markInternal(), fed by whichever
// spawn wrapper captures its own session_id; the pre-D23 memory distiller's
// sessionIdFromEnvelope was the one producer of this and is retired at the
// D23/D24 cutover with nothing populating it currently -- markInternal
// itself is a still-live, general primitive, just presently unfed) OR its
// cwd sits inside a throwaway temp dir this codebase itself spawns `claude
// -p` from (the SECONDARY signal, covering sessions already on disk before
// id capture existed: 3 of the 4 measured phantom sessions had cwd:null
// because that temp dir is deleted before the index reads it, so this arm
// alone cannot carry the fix). Two prefixes currently: `mc-distill-*` (the
// retired pre-D23 memory distiller's own spawn) and `mc-model-*` (B15,
// final-fix-wave.md: claude-model.js's runClaude, the shared model call
// every loop plugin - mem0, judge, GEPA - uses via fs.mkdtempSync). Without
// the second, every plugin model call showed up as an apparent live
// external session.
//
// A null cwd with an unknown id is deliberately NOT internal: guessing
// internal-ness from a null cwd would silently uncount a genuine
// foreign-directory user session, the same class of bug this whole plan
// exists to fix, just pointed the other way.
export function isInternalSession(session, internalIds) {
  const ids = internalIds instanceof Set ? internalIds : new Set(internalIds || []);
  if (session && ids.has(session.id)) return true;
  const cwd = normalizeCwd(session?.cwd);
  return cwd.includes('/mc-distill-') || cwd.includes('/mc-model-');
}
