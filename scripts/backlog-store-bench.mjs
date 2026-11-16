#!/usr/bin/env node
// Board write cost on a live-sized fixture: how long one devlog append blocks
// the event loop, and the CPU it burns. Every store call is synchronous, so the
// wall time of the call is the time the loop is blocked.
//
//   node scripts/backlog-store-bench.mjs [--writes 200] [--mb 4.5] [--from <store.json>] [--module <store.js>] [--json]
//
// --from copies a real store into a temp dir first; the source is only read.
// --module benches another copy of the store module (a before/after comparison).
// The first write is reported apart: on a legacy store it is the one-time migration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; };
const writes = Number(flag('--writes', 200));
const targetMb = Number(flag('--mb', 4.5));
const from = flag('--from', null);
const asJson = argv.includes('--json');
const mod = flag('--module', null);
const store = await import(mod ? pathToFileURL(path.resolve(mod)).href : '../server/lib/orchestration/backlog-store.js');

function fixtureBoard(mb = 4.5) {
  const filler = 'x'.repeat(400);
  const items = [];
  let bytes = 0; let n = 0;
  while (bytes < mb * 1024 * 1024) {
    n += 1;
    const devLog = Array.from({ length: 6 + (n % 10) }, (_, k) => ({ ts: new Date(1e12 + k).toISOString(), by: 'agent', text: `${filler} ${n}.${k}` }));
    const item = {
      id: `bench-${n}`, project: 'bench', title: `card ${n}`, prompt: filler, state: n % 5 ? 'done' : 'queued', source: 'manual',
      groupId: null, order: n, priority: null, sessionId: null, branch: null, prUrl: null, origin: null, actor: null,
      activity: [{ ts: new Date(1e12).toISOString(), text: 'filed' }], createdAt: new Date(1e12).toISOString(), updatedAt: new Date(1e12).toISOString(),
      description: filler, acceptanceCriteria: [{ text: 'AC', done: false }], relevantFiles: [], deferredRefs: [], blockedBy: [], devLog, gate: null,
    };
    bytes += JSON.stringify(item, null, 2).length;
    items.push(item);
  }
  return { items, paused: false, seq: 0, seqs: { bench: n } };
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }
function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, p50: +pct(s, 0.5).toFixed(2), p95: +pct(s, 0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-board-bench-'));
fs.mkdirSync(path.join(stateDir, 'backlog'), { recursive: true });
const storeFile = path.join(stateDir, 'backlog', 'store.json');
if (from) fs.copyFileSync(from, storeFile);
else fs.writeFileSync(storeFile, JSON.stringify(fixtureBoard(targetMb), null, 2));
const boardBytes = fs.statSync(storeFile).size;
const ids = store.load(stateDir).items.map((i) => i.id);

const wall = []; let cpuMs = 0; let firstMs = null;
for (let k = 0; k < writes; k += 1) {
  const id = ids[(k * 37) % ids.length];
  const c0 = process.cpuUsage(); const t0 = performance.now();
  store.appendDevLogIn(stateDir, id, { by: 'agent', text: `bench write ${k}` });
  const ms = performance.now() - t0;
  if (k === 0) firstMs = ms; else wall.push(ms);
  const c = process.cpuUsage(c0); cpuMs += (c.user + c.system) / 1000;
}
const t0 = performance.now(); const items = store.load(stateDir).items; const loadMs = performance.now() - t0;
const files = fs.readdirSync(path.join(stateDir, 'backlog')).map((f) => `${f}=${fs.statSync(path.join(stateDir, 'backlog', f)).size}`);
const out = {
  boardMB: +(boardBytes / 1048576).toFixed(2), cards: items.length, writes,
  firstWriteMs: +firstMs.toFixed(2), blockedMsPerWrite: stats(wall), cpuMsPerWriteMean: +(cpuMs / writes).toFixed(2), loadAfterMs: +loadMs.toFixed(2), files,
};
fs.rmSync(stateDir, { recursive: true, force: true });
console.log(asJson ? JSON.stringify(out) : JSON.stringify(out, null, 2));
