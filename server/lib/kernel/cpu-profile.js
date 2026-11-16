// In-process CPU profiling of the kernel (card glmps-2-0-runtime-68, AC-4).
// The service runs as LocalSystem, so no operator-account process can attach
// an inspector to it; an in-process inspector Session opens no port at all.
import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { ChildProcess } from 'node:child_process';

const KEEP = 5;
const TOP = 12;

export async function captureCpuProfile({ seconds, intervalUs = 1000, onStarted }) {
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: intervalUs });
    await session.post('Profiler.start');
    onStarted?.();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { profile } = await session.post('Profiler.stop');
    return profile;
  } finally {
    session.disconnect();
  }
}

function frameKey(cf) {
  const file = cf.url ? cf.url.split(/[\\/]/).pop() : '';
  return { fn: cf.functionName || '(anonymous)', at: file ? `${file}:${cf.lineNumber + 1}` : '' };
}

function top(map) {
  return [...map.values()].sort((a, b) => b.ms - a.ms).slice(0, TOP).map((e) => ({ ...e, ms: Math.round(e.ms * 10) / 10 }));
}

// A busy run is a stretch of consecutive samples none of which is (idle): the
// event loop was held for that long. (program) and (garbage collector) count as
// busy because the loop cannot turn during them either.
export function analyzeProfile(profile, { thresholdMs = 1000 } = {}) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const isIdle = (id) => byId.get(id)?.callFrame.functionName === '(idle)';

  const runs = [];
  let cur = null;
  let t = profile.startTime;
  let busyUs = 0;
  let longestUs = 0;
  const close = () => {
    if (!cur) return;
    const us = cur.end - cur.start;
    longestUs = Math.max(longestUs, us);
    if (us >= thresholdMs * 1000) runs.push(cur);
    cur = null;
  };
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] ?? 0;
    const start = t;
    t += dt;
    if (isIdle(id)) { close(); return; }
    // A sample's weight is the time until the next one, so the last sample of
    // a run counts up to where the idle stretch begins.
    const w = profile.timeDeltas[i + 1] ?? dt;
    busyUs += w;
    if (!cur) cur = { start, end: start, samples: [] };
    cur.end = t - dt + w;
    cur.samples.push([id, w]);
  });
  close();

  const describe = (run) => {
    const self = new Map();
    const incl = new Map();
    const stackWeight = new Map();
    const add = (map, cf, us) => {
      const k = frameKey(cf);
      const key = `${k.fn}@${k.at}`;
      const e = map.get(key) || { ...k, ms: 0 };
      e.ms += us / 1000;
      map.set(key, e);
      return key;
    };
    for (const [id, us] of run.samples) {
      add(self, byId.get(id).callFrame, us);
      const seen = new Set();
      for (let n = id; n != null; n = parent.get(n)) {
        const cf = byId.get(n).callFrame;
        if (cf.functionName === '(root)') break;
        const k = frameKey(cf);
        const key = `${k.fn}@${k.at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(incl, cf, us);
      }
      stackWeight.set(id, (stackWeight.get(id) || 0) + us);
    }
    const [heaviest] = [...stackWeight.entries()].sort((a, b) => b[1] - a[1]);
    const stack = [];
    for (let n = heaviest?.[0]; n != null; n = parent.get(n)) {
      const cf = byId.get(n).callFrame;
      if (cf.functionName === '(root)') break;
      const k = frameKey(cf);
      stack.unshift(k.at ? `${k.fn} (${k.at})` : k.fn);
    }
    return {
      startMs: Math.round((run.start - profile.startTime) / 1000),
      ms: Math.round((run.end - run.start) / 1000),
      self: top(self),
      inclusive: top(incl),
      stack,
    };
  };

  return {
    durationMs: Math.round((profile.endTime - profile.startTime) / 1000),
    busyMs: Math.round(busyUs / 1000),
    longestRunMs: Math.round(longestUs / 1000),
    thresholdMs,
    runs: runs.map(describe),
  };
}

// The command a launch is grouped under: the program's base name plus its
// first two arguments that are not an option or an option's value, so every
// `git -C <dir> status ...` lands in one row.
export function spawnKey(file, args = []) {
  const prog = String(file).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
  // A shell launch (shell:true, or sh -c / cmd /c by hand) is keyed on the
  // command it runs, not on the shell.
  if (/^(sh|bash|cmd)$/i.test(prog)) {
    const at = args.findIndex((a, i) => i > 0 && /^(-c|\/c)$/i.test(String(a)));
    if (at > 0 && args[at + 1] != null) {
      const cmd = String(args[at + 1]).replace(/^"|"$/g, '').trim().split(/\s+/);
      return spawnKey(cmd[0], cmd);
    }
  }
  const words = [];
  const rest = args.slice(1);
  for (let i = 0; i < rest.length && words.length < 2; i++) {
    const a = String(rest[i]);
    if (a === '-C' || a === '-c') { i++; continue; }
    if (a.startsWith('-') || a.startsWith('/')) { if (!words.length) { words.push(a); break; } continue; }
    words.push(a);
  }
  return [prog, ...words].join(' ');
}

// Process creation runs on the main thread (synchronously, even for async
// execFile), so it is a stall source the CPU profile shows only as `spawn`
// with the caller hidden behind the git limiter. Every launch goes through
// ChildProcess.prototype.spawn, so counting there names the commands.
export function trackSpawns() {
  const proto = ChildProcess.prototype;
  const original = proto.spawn;
  const rows = new Map();
  const summary = { total: 0, ms: 0, byCommand: [] };
  const trackedSpawn = function trackedSpawn(options) {
    const t0 = performance.now();
    try { return original.call(this, options); } finally {
      const ms = performance.now() - t0;
      const key = spawnKey(options?.file, options?.args);
      const r = rows.get(key) || { cmd: key, n: 0, ms: 0, maxMs: 0 };
      r.n++; r.ms += ms; r.maxMs = Math.max(r.maxMs, ms);
      rows.set(key, r);
      summary.total++; summary.ms += ms;
    }
  };
  proto.spawn = trackedSpawn;
  return () => {
    if (proto.spawn === trackedSpawn) proto.spawn = original;
    const round = (x) => Math.round(x * 10) / 10;
    summary.ms = round(summary.ms);
    summary.byCommand = [...rows.values()].sort((a, b) => b.ms - a.ms || b.n - a.n).slice(0, 20)
      .map((r) => ({ ...r, ms: round(r.ms), maxMs: round(r.maxMs) }));
    return summary;
  };
}

export function keepProfile(stateDir, profile, { now = Date.now } = {}) {
  const dir = path.join(stateDir, 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cpu-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
  fs.writeFileSync(file, JSON.stringify(profile));
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('cpu-') && f.endsWith('.cpuprofile')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}
