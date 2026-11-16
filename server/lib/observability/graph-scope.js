// server/lib/observability/graph-scope.js
// Graph scope classifier: puts every root the app knows into exactly one scope
// (ship, machine candidate, or excluded) with a reason, so the graph rebuild
// never has to guess which repos it may index.
//
// WHY: the project list is the union of session cwds, the harness's
// additionalDirectories and the kernel itself, and it contains worktrees,
// subdirectories, duplicate clones, private dirs and non-repos alongside real
// repos. Only the kernel repo and the corpus repo may ever be "ship"; everything
// else is an opt-in machine candidate or excluded. Exclusion is per-machine
// config and empty in code, so another user's machine starts with nothing
// excluded.
//
// All path handling is string-only (no node:path), for the same reason as
// private-dirs.js: a Windows path must classify on a POSIX CI host. The only
// IO is in the default adapters (gitProbe, the scan-root lister); the
// classifier takes them as injected functions.
import { readdirSync, existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { isPrivateDir } from '../private-dirs.js';

export const GRAPH_DEFAULTS = Object.freeze({
  ship: Object.freeze({ corpusRoot: null, corpusRemote: 'wolfeb-dev/glmps-2.0' }),
  machine: Object.freeze({
    enabled: false,
    scanRoots: Object.freeze([]),
    include: Object.freeze([]),
    exclude: Object.freeze([]),
  }),
});

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
const key = (p) => norm(p).toLowerCase();
const baseName = (p) => norm(p).split('/').filter(Boolean).pop() ?? '';
const dirName = (p) => norm(p).replace(/\/[^/]*$/, '');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const cloneVal = (v) => (Array.isArray(v) ? [...v] : v);

/**
 * Fresh config with `user` merged over GRAPH_DEFAULTS, one level deep per
 * sub-block, so a config that sets only machine.exclude keeps the rest.
 * Arrays are replaced, never concatenated, and always fresh copies.
 */
export function mergeGraphConfig(user) {
  const u = isObj(user) ? user : {};
  const out = {};
  for (const block of Object.keys(GRAPH_DEFAULTS)) {
    const o = {};
    for (const [k, v] of Object.entries(GRAPH_DEFAULTS[block])) o[k] = cloneVal(v);
    if (isObj(u[block])) for (const [k, v] of Object.entries(u[block])) o[k] = cloneVal(v);
    out[block] = o;
  }
  return out;
}

/** 'owner/name' (lowercased) from a git remote URL, or null. */
export function normalizeRemote(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const m = s.match(/(?:^|[:/])([^/:]+)\/([^/:]+)$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * The first pattern that excludes `root`, or null. An entry with a separator or
 * a colon is a path (equal or inside, separator-aware like isPrivateDir, so
 * D:\Docs-old is not caught by D:\Docs); any other entry is a case-insensitive
 * substring of the root's basename.
 */
export function matchesExclude(root, patterns = []) {
  const c = key(root);
  const name = baseName(root).toLowerCase();
  for (const pat of patterns) {
    if (typeof pat !== 'string' || !pat.trim()) continue;
    if (/[\\/:]/.test(pat)) {
      const p = key(pat);
      if (p && (c === p || c.startsWith(p + '/'))) return pat;
    } else if (name.includes(pat.trim().toLowerCase())) {
      return pat;
    }
  }
  return null;
}

const defaultReaddir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};
const defaultIsRepo = (p) => existsSync(p + '/.git');

/** Git-repo children, one level deep, of each scan root. Never throws. */
export function listScanRootRepos(scanRoots = [], { readdir = defaultReaddir, isRepo = defaultIsRepo } = {}) {
  const out = [];
  for (const sr of scanRoots) {
    const dir = norm(sr);
    if (!dir) continue;
    let names;
    try { names = readdir(dir); } catch { continue; }
    for (const n of names || []) {
      const child = `${dir}/${n}`;
      try { if (isRepo(child)) out.push(child); } catch { /* skip */ }
    }
  }
  return out;
}

/** Real git IO for classifyGraphRoots; any failure is { isRepo: false }. */
export function gitProbe(root) {
  const run = (args) => execFileSync('git', ['-C', root, ...args], {
    windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
  try {
    const [toplevel, gitDir, commonDir] = run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
      .split(/\r?\n/);
    if (!toplevel || !gitDir || !commonDir) return { isRepo: false };
    let remote = null;
    try { remote = run(['config', '--get', 'remote.origin.url']) || null; } catch { /* no origin */ }
    return { isRepo: true, toplevel, gitDir, commonDir, remote };
  } catch {
    return { isRepo: false };
  }
}

/** gitProbe without blocking the event loop; same result shape. */
export function gitProbeAsync(root) {
  const run = (args) => new Promise((res, rej) => {
    execFile('git', ['-C', root, ...args], { windowsHide: true, timeout: 5000, encoding: 'utf-8' },
      (err, out) => (err ? rej(err) : res(String(out).trim())));
  });
  return (async () => {
    try {
      const [toplevel, gitDir, commonDir] = (await run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']))
        .split(/\r?\n/);
      if (!toplevel || !gitDir || !commonDir) return { isRepo: false };
      let remote = null;
      try { remote = (await run(['config', '--get', 'remote.origin.url'])) || null; } catch { /* no origin */ }
      return { isRepo: true, toplevel, gitDir, commonDir, remote };
    } catch {
      return { isRepo: false };
    }
  })();
}

const defaultExistsAsync = (p) => access(p).then(() => true, () => false);
const defaultMtimeAsync = (p) => stat(p).then((s) => s.mtimeMs, () => null);

/**
 * A probeAsync that remembers each path's result across classifier runs, so a
 * steady-state tick spawns git only for cwds it has not seen. An entry is
 * re-probed after ttlMs, or sooner when its repo's git config (where the
 * remote lives, and which a re-init rewrites) changes or disappears; the .git
 * directory's own mtime would move on every index write. Concurrent callers
 * for one path share a single probe.
 */
export function cachedProbeAsync({
  probeAsync = gitProbeAsync, ttlMs = 60 * 60_000, now = Date.now, mtimeAsync = defaultMtimeAsync,
} = {}) {
  const entries = new Map();
  const inflight = new Map();
  const marker = (r) => (r && r.isRepo ? `${norm(r.commonDir)}/config` : null);
  return async (root) => {
    const k = key(root);
    const e = entries.get(k);
    if (e && now() - e.at < ttlMs) {
      const m = marker(e.result);
      if (!m || (await mtimeAsync(m)) === e.mtimeMs) return e.result;
    }
    if (inflight.has(k)) return inflight.get(k);
    const job = (async () => {
      const at = now();
      const result = await probeAsync(root);
      const m = marker(result);
      entries.set(k, { at, result, mtimeMs: m ? await mtimeAsync(m) : null });
      return result;
    })();
    inflight.set(k, job);
    try { return await job; } finally { inflight.delete(k); }
  };
}

const mainOfProbe = (p) => (baseName(p.commonDir) === '.git' ? dirName(p.commonDir) : norm(p.toplevel));

/**
 * classifyGraphRoots for callers on the server's event loop: every candidate,
 * and every main checkout a worktree or subdirectory folds into, is probed
 * with async git first (at most `concurrency` at once), then the pure
 * classifier runs over the cached results. A path missing on disk is never
 * probed (it classifies as not a git repo), and once `signal` aborts no
 * further probe starts and the call rejects.
 */
export async function classifyGraphRootsAsync(opts = {}) {
  const { probeAsync = gitProbeAsync, existsAsync = defaultExistsAsync, concurrency = 4, privateDirs = [], signal } = opts;
  const checkAbort = () => { if (signal?.aborted) throw signal.reason ?? new Error('aborted'); };
  const g = mergeGraphConfig(opts.graph);
  const lister = opts.listScanRoot ?? ((roots) => listScanRootRepos(roots));
  let scanned = [];
  try { scanned = lister(opts.scanRoots ?? g.machine.scanRoots) || []; } catch { /* fail open */ }

  const cache = new Map();
  const probeAll = async (paths) => {
    const todo = [...new Set(paths.map(norm).filter((p) => p && !cache.has(key(p)) && !isPrivateDir(p, privateDirs)))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !signal?.aborted) {
        const p = todo[next++];
        let r;
        try { r = (await existsAsync(p)) ? await probeAsync(p) : null; } catch { r = null; }
        cache.set(key(p), r && r.isRepo ? r : { isRepo: false });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
    checkAbort();
  };
  checkAbort();
  await probeAll([opts.kernelRoot, g.ship.corpusRoot, ...(opts.sessionCwds || []), ...(opts.additionalDirectories || []), ...scanned, ...g.machine.include]);
  await probeAll([...cache.values()].filter((p) => p.isRepo).map(mainOfProbe));

  return classifyGraphRoots({
    ...opts, graph: g, scanRoots: [], listScanRoot: () => scanned,
    probe: (root) => cache.get(key(root)) ?? { isRepo: false },
  });
}

/** Roots the graph timers may act on: ship roots and opted-in machine roots. */
export function inScopeRoots(roots = []) {
  return roots.filter((r) => r.scope === 'ship' || (r.scope === 'machine' && r.optedIn === true));
}

const SOURCE_REASON = {
  kernel: 'kernel path', corpus: 'corpus path', session: 'session cwd',
  additionalDirectories: 'additionalDirectories', scanRoot: 'scan root',
  include: 'include', fold: 'folded main checkout',
};

export function classifyGraphRoots({
  kernelRoot, sessionCwds = [], additionalDirectories = [], scanRoots, graph = mergeGraphConfig(),
  privateDirs = [], probe = gitProbe, listScanRoot,
} = {}) {
  const g = mergeGraphConfig(graph);
  const scans = scanRoots ?? g.machine.scanRoots;
  const lister = listScanRoot ?? ((roots) => listScanRootRepos(roots));

  const cands = new Map();
  const add = (root, source) => {
    const r = norm(root);
    if (!r) return;
    const k = r.toLowerCase();
    const e = cands.get(k);
    if (!e) cands.set(k, { root: r, sources: [source] });
    else if (!e.sources.includes(source)) e.sources.push(source);
  };
  add(kernelRoot, 'kernel');
  add(g.ship.corpusRoot, 'corpus');
  for (const c of sessionCwds) add(c, 'session');
  for (const c of additionalDirectories) add(c, 'additionalDirectories');
  let scanned = [];
  try { scanned = lister(scans) || []; } catch { /* fail open */ }
  for (const c of scanned) add(c, 'scanRoot');
  for (const c of g.machine.include) add(c, 'include');

  const probeCache = new Map();
  const probeOnce = (root) => {
    const k = key(root);
    if (!probeCache.has(k)) {
      let p;
      try { p = probe(root); } catch { p = null; }
      probeCache.set(k, p && p.isRepo ? p : { isRepo: false });
    }
    return probeCache.get(k);
  };
  const mainOf = mainOfProbe;

  // Ship roots are the literal kernel and corpus paths, never their main
  // checkout: the live 2.0 kernel is itself a worktree of the 1.0 checkout, so
  // folding it would make the 1.0 checkout ship and drop the running kernel.
  // Every other checkout of a ship repo is excluded as already covered.
  const kernelKey = kernelRoot ? key(kernelRoot) : null;
  let kernelCommon = null;
  if (kernelKey && !isPrivateDir(kernelRoot, privateDirs)) {
    const kp = probeOnce(norm(kernelRoot));
    if (kp.isRepo) kernelCommon = key(kp.commonDir);
  }
  const corpusRemote = normalizeRemote(g.ship.corpusRemote);
  let corpusKey = g.ship.corpusRoot ? key(g.ship.corpusRoot) : null;
  let corpusShown = g.ship.corpusRoot ? norm(g.ship.corpusRoot) : null;
  let corpusReason = 'corpus repo';
  let corpusCommon = null;
  if (corpusKey && !isPrivateDir(g.ship.corpusRoot, privateDirs)) {
    const cp = probeOnce(corpusShown);
    if (cp.isRepo) corpusCommon = key(cp.commonDir);
  }
  let corpusResolved = null;
  const includeKeys = g.machine.include.map(key);
  const commonSeen = new Map();
  const roots = [];

  const queue = [...cands.values()];
  for (let i = 0; i < queue.length; i++) {
    const { root, sources } = queue[i];
    const done = (scope, reason, extra) => { roots.push({ root, scope, reason, sources, ...extra }); };

    if (isPrivateDir(root, privateDirs)) { done('excluded', 'private dir'); continue; }
    const p = probeOnce(root);
    if (!p.isRepo) { done('excluded', 'not a git repo'); continue; }

    const ck = key(p.commonDir);
    if (key(root) === kernelKey) { commonSeen.set(ck, root); done('ship', 'kernel repo'); continue; }
    if (key(root) === corpusKey) {
      corpusResolved = root; commonSeen.set(ck, root);
      done('ship', corpusReason); continue;
    }
    if (ck === kernelCommon) { done('excluded', `other checkout of kernel repo ${norm(kernelRoot)}`); continue; }
    if (corpusCommon && ck === corpusCommon) { done('excluded', `other checkout of corpus repo ${corpusShown}`); continue; }

    const main = mainOf(p);
    if (key(main) !== key(root)) {
      const reason = norm(p.gitDir).toLowerCase() !== norm(p.commonDir).toLowerCase()
        ? `worktree of ${main}` : `subdirectory of ${main}`;
      done('excluded', reason);
      if (!cands.has(key(main))) {
        const folded = { root: main, sources: ['fold'] };
        cands.set(key(main), folded);
        queue.push(folded);
      }
      continue;
    }

    const mk = key(main);
    const remoteMatch = corpusRemote && normalizeRemote(p.remote) === corpusRemote;
    if (!corpusKey && remoteMatch) {
      corpusKey = mk; corpusShown = main; corpusCommon = ck; corpusResolved = main;
      corpusReason = 'corpus repo (matched by remote)';
      commonSeen.set(ck, main);
      done('ship', corpusReason); continue;
    }
    if (remoteMatch) { done('excluded', 'duplicate clone of corpus repo'); continue; }

    const ex = matchesExclude(main, g.machine.exclude);
    if (ex !== null) { done('excluded', `config exclude: ${ex}`); continue; }

    if (commonSeen.has(ck)) { done('excluded', `duplicate of ${commonSeen.get(ck)}`); continue; }
    commonSeen.set(ck, main);

    done('machine', SOURCE_REASON[sources[0]] || sources[0], {
      optedIn: g.machine.enabled && includeKeys.includes(mk),
    });
  }

  return { roots, corpusRoot: corpusResolved };
}
