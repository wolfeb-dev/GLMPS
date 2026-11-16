// server/lib/observability/wiki-loop.js
// The wiki loop (program plan section 4, D-W5), registered through K3's
// registerLoop. Maker: build HEAD into <stateDir>/wiki/builds/<id> by running
// scripts/wiki-build-cli.mjs as a child. Checker: wiki-verify.js (a different
// actor). onVerified: publish (atomic pointer swap) and close the
// wiki.reflects-head obligation. Every failure becomes the run's
// failed:<reason>; nothing here swallows an error.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { verifyWikiBuild } from './wiki-verify.js';
import { buildingAccountNames } from '../governance/private-text-scan.js';
import { wikiPaths, readCurrentWiki, publishWikiBuild, pruneWikiBuilds, buildIdFor, writeJsonAtomic } from './wiki-publish.js';
import { CeilingError } from '../loops/registry.js';
import { graphFingerprint } from './graph-fingerprint.js';

export const WIKI_LOOP_NAME = 'wiki';
export const WIKI_OBLIGATION_KIND = 'wiki.reflects-head';
export const WIKI_OPENED_BY = 'wiki-loop';
export const WIKI_VERIFIED_BY = 'wiki-verify';
export const WIKI_LOOP_DEFAULTS = Object.freeze({
  enabled: null, everyMs: 6 * 3600000, timeoutMs: 90 * 60000, slaMs: 36 * 3600000, backoffMaxMs: 24 * 3600000,
  maxModelCalls: 120, backend: 'claude', modelTier: 'strong', model: null, keepBuilds: 3,
});

export function readHeadAsync(root, { execFileImpl = nodeExecFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl('git', ['-C', root, 'rev-parse', 'HEAD'], { windowsHide: true }, (err, out) => {
      if (err) return reject(new Error(`no-head: git rev-parse HEAD failed: ${String(err.message).split('\n')[0]}`));
      const sha = String(out).trim();
      return sha ? resolve(sha) : reject(new Error('no-head: git rev-parse HEAD printed nothing'));
    });
  });
}

// One parse yields both markers the maker decides on: the graph's commit and
// its fingerprint (graph-fingerprint.js), which moves when graphify rewrites
// the graph at an unchanged HEAD.
export async function readGraphCommit(root) {
  let raw;
  try { raw = await fs.promises.readFile(path.join(root, 'graphify-out', 'graph.json'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { exists: false, commit: null, fingerprint: null }; throw e; }
  const g = JSON.parse(raw); // a corrupt graph throws; the run fails with that reason
  return {
    exists: true,
    commit: typeof g.built_at_commit === 'string' && g.built_at_commit ? g.built_at_commit : null,
    fingerprint: graphFingerprint(g),
  };
}

export function evictRejected({ cacheFile, lastVerifyFile }) {
  let last;
  try { last = JSON.parse(fs.readFileSync(lastVerifyFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  if (last.ok || !Array.isArray(last.offending) || !last.offending.length) return 0;
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let n = 0;
  for (const o of last.offending) if (o?.contentHash && Object.hasOwn(cache, o.contentHash)) { delete cache[o.contentHash]; n += 1; }
  if (n) writeJsonAtomic(cacheFile, cache);
  return n;
}

// returns a short reason string (or a promise of
// one, for the async taskkill) when the kill
// itself failed (not the benign "already exited" case), null on success or
// on the benign case. A caller folds a non-null return into the run's own
// failure reason (spawnWikiBuild's fail(), below) -- console.error alone
// left no trace beyond a log file nobody watches whether a timed-out build
// child was actually reaped or is still running, still spending quota.
export function defaultKillTree(child, { platform = process.platform, spawnImpl = nodeSpawn } = {}) {
  if (platform === 'win32' && child.pid) {
    return new Promise((resolve) => {
      const done = (status) => {
        // 128: the process already exited, which is the outcome we wanted
        if (status !== 0 && status !== 128) {
          const reason = `taskkill /T exited ${status} for pid ${child.pid}`;
          console.error(`wiki-loop: ${reason}`);
          resolve(reason);
        } else resolve(null);
      };
      try {
        const k = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.on('error', () => done(1));
        k.on('close', done);
      } catch { done(1); }
    });
  }
  try { child.kill('SIGKILL'); }
  catch (e) {
    const reason = `kill failed for pid ${child.pid}: ${e.message}`;
    console.error(`wiki-loop: ${reason}`);
    return reason;
  }
  return null;
}

export function spawnWikiBuild({
  cliPath, root, buildDir, cacheFile, priorDir = null, stateDir = null, headSha, backend, model = null, readCache = true,
  signal = null, onModelCall = () => {}, spawnImpl = nodeSpawn, killTree = defaultKillTree, nodePath = process.execPath,
}) {
  const args = [cliPath, root, '--llm', '--out', buildDir, '--cache', cacheFile, '--backend', backend,
    '--max-model-calls', 'auto', '--expect-head', headSha, '--protocol'];
  if (backend === 'claude' && model) args.push('--model', model);
  if (priorDir) args.push('--prior', priorDir);
  if (stateDir) args.push('--state-dir', stateDir);
  if (!readCache) args.push('--no-cache-read');
  return new Promise((resolve, reject) => {
    let settled = false;
    let summary = null;
    let stderr = '';
    let buf = '';
    // check signal.aborted BEFORE
    // spawning -- a run already aborted when spawnWikiBuild is called
    // (close() tore the whole wiki loop run down between the maker's own
    // checkNotAborted(ctx) check and the runBuild call that reaches here)
    // used to spawn a real child first, only to kill it immediately after.
    if (signal?.aborted) {
      const reason = signal.reason instanceof Error ? signal.reason : new Error('timeout');
      reject(reason);
      return;
    }
    const child = spawnImpl(nodePath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('timeout'));
    function fail(err) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      Promise.resolve(killTree(child)).catch((e) => e?.message ?? String(e)).then((killError) => {
        // the S6 fix's `err.message +=
        // ...` mutated the incoming error IN PLACE, which crashed (uncaught
        // TypeError, inside this abort listener) whenever `err` was a
        // DOMException -- the registry's own timeout path calls ac.abort()
        // with NO reason, so signal.reason defaults to one, and DOMException's
        // .message is a getter with no setter (strict ESM throws on assigning
        // it). Never mutate `err`: build a NEW error instead, preserving
        // CeilingError's type (registry.js's classify() keys off instanceof)
        // via its own constructor; anything else becomes a plain Error. The
        // original is kept as `cause` either way.
        if (killError) {
          const msg = `${err?.message ?? err} (and the build process may still be running: ${killError})`;
          err = err instanceof CeilingError
            ? Object.assign(new CeilingError(msg), { cause: err })
            : new Error(msg, { cause: err });
        }
        reject(err);
      });
    }
    // Already-aborted is handled above, before spawning; this only ever
    // needs to listen for an abort that arrives WHILE the child is running.
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith('WIKI_MODEL_CALL ')) {
          try { onModelCall(line.slice('WIKI_MODEL_CALL '.length)); } catch (e) { fail(e); return; }
        } else if (line.startsWith('WIKI_RESULT ')) {
          try { summary = JSON.parse(line.slice('WIKI_RESULT '.length)); } catch (e) { fail(new Error(`unparseable WIKI_RESULT: ${e.message}`)); return; }
        }
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (e) => fail(new Error(`wiki build spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || '(no stderr)';
      if (code !== 0) return reject(new Error(`wiki build exited ${code}: ${tail}`));
      if (!summary) return reject(new Error('wiki build exited 0 without a WIKI_RESULT line'));
      return resolve(summary);
    });
  });
}

export function wikiLoopDefinition({
  repoRoot, stateDir, webDir = null, cfg = {}, obligations = null,
  readHead = readHeadAsync, readGraph = readGraphCommit, refreshGraph, runBuild,
  now = Date.now, log = (m) => console.error(m),
  rm = fs.rmSync, readdir = fs.readdirSync,
  // Fired after every prune attempt (the pre-build one in maker AND the
  // post-publish one in onVerified), always with the array pruneWikiBuilds/
  // publishWikiBuild returned -- empty when nothing failed to remove. A
  // caller that wants to know when a retention problem clears (not just when
  // one appears) needs this structured, always-fired signal: `log` above
  // only fires on a non-empty array, so it can tell a caller a problem
  // exists but never that a later, clean prune resolved it.
  onRetention = () => {},
}) {
  if (typeof runBuild !== 'function') throw new Error('wikiLoopDefinition: runBuild is required');
  if (typeof refreshGraph !== 'function') throw new Error('wikiLoopDefinition: refreshGraph is required');
  const c = { ...WIKI_LOOP_DEFAULTS, ...cfg };
  const p = wikiPaths(stateDir);
  let warned = false;
  const noObligations = () => {
    if (warned) return;
    warned = true;
    log('wiki-loop: obligations store unavailable; freshness obligation skipped (K4 absent or failed to open)');
  };

  // closes every open wiki.reflects-head row
  // whose subject is `headSha`, or which was opened before `beforeTs` (a
  // published build at a newer HEAD satisfies obligations for older HEADs
  // too -- Decision 3). Shared by onVerified (right after a real publish)
  // AND the maker's own nothing-to-do branch below: onVerified's close runs
  // AFTER the pointer swap already succeeded, so if close() itself throws
  // (SQLITE_BUSY, store closed at shutdown) current.json already says HEAD
  // -- every later run on that HEAD used to return nothing-to-do forever
  // without ever retrying the close, leaving the obligation open until the
  // sweeper's 36h SLA escalated a false overdue alert for a build that was,
  // in fact, already published. The nothing-to-do branch gives it another
  // chance on every subsequent tick. listOpen() itself is inside the try
  // (not just the per-row close()) so a store that cannot even list open
  // rows is reported the same way as one that cannot close them.
  function closeReflectsHeadObligations({ headSha, beforeTs, verifierRef }) {
    const closeErrors = [];
    try {
      for (const row of obligations.listOpen()) {
        if (row.kind !== WIKI_OBLIGATION_KIND) continue;
        if (row.subject !== headSha && row.openedTs > beforeTs) continue;
        try { obligations.close(row.id, { closer: 'verified.done', closedBy: WIKI_VERIFIED_BY, verifierRef }); }
        catch (e) { closeErrors.push(`${String(row.subject).slice(0, 8)}: ${e.message}`); }
      }
    } catch (e) { closeErrors.push(`listOpen: ${e.message}`); }
    return closeErrors;
  }

  // the maker did no abort check of
  // its own -- it would open a wiki.reflects-head row and spawn a real
  // build child even when ctx.signal was already aborted (close() tore the
  // run down before the maker got anywhere, or mid-refreshGraph, which has
  // no abort wiring of its own to interrupt). Checked right before each of
  // the two operations worth not doing for an abandoned run: opening a
  // durable obligation on a store that may be closing, and spawning a
  // build for a run the server already decided to abandon.
  function checkNotAborted(ctx) {
    if (ctx.signal?.aborted) throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted'));
  }

  async function maker(ctx) {
    const runStartTs = now();
    const headSha = await readHead(repoRoot);
    const current = readCurrentWiki(stateDir);
    // The graph is read BEFORE the nothing-to-do decision: a graph rewritten
    // at an unchanged HEAD (graphify upgrade, rebuild tick) leaves the commits
    // equal while the content the wiki describes has moved. Drift adds no
    // trigger of its own; it is only acted on at this loop's own cadence.
    // An unusable graph still lets a moved HEAD open its obligation first, as
    // before; it fails the run by name right after.
    let graph = null;
    let graphError = null;
    try {
      graph = await readGraph(repoRoot);
      if (!graph.exists) graphError = new Error('no-graph: graphify-out/graph.json is missing');
      else if (!graph.commit) graphError = new Error('graph-unversioned: graphify-out/graph.json has no built_at_commit');
    } catch (e) { graphError = e; }
    checkNotAborted(ctx);
    let reason = null;
    if (current?.builtAtCommit !== headSha) reason = 'commit';
    else if (graphError) reason = null;
    else if (!current.graphFingerprint) reason = 'graph-unrecorded';
    else if (current.graphFingerprint !== graph.fingerprint) reason = 'graph-drift';
    if (reason) {
      if (obligations) {
        const meta = { previous: current?.builtAtCommit ?? null };
        if (reason !== 'commit') Object.assign(meta, { reason, builtFromGraph: current.graphFingerprint ?? null, currentGraph: graph.fingerprint });
        obligations.open({ kind: WIKI_OBLIGATION_KIND, subject: headSha, openedBy: WIKI_OPENED_BY, dueTs: runStartTs + c.slaMs, meta });
      } else noObligations();
    }
    if (graphError) throw graphError;
    if (!reason && !ctx.payload?.force) {
      // give a stale wiki.reflects-head row (left open by an earlier
      // publish whose own close() attempt failed) another chance on every
      // nothing-to-do tick, rather than leaving it open until the sweeper
      // escalates a false overdue alert for a build that is already
      // published. Non-fatal: nothing-to-do stays nothing-to-do either way.
      if (obligations) {
        const closeErrors = closeReflectsHeadObligations({ headSha, beforeTs: current.builtTs ?? runStartTs, verifierRef: current.verifierRef });
        if (closeErrors.length) log(`wiki-loop: nothing-to-do, but ${closeErrors.length} stale obligation(s) still not closed: ${closeErrors[0]}`);
      } else noObligations();
      return { outcome: 'nothing-to-do', result: { headSha }, fresh: { builtAtCommit: headSha, graphFingerprint: graph.fingerprint } };
    }
    if (graph.commit !== headSha) {
      await refreshGraph(repoRoot);
      graph = await readGraph(repoRoot);
      if (!graph.commit) throw new Error('graph-unversioned: graphify-out/graph.json has no built_at_commit');
      if (graph.commit !== headSha) {
        throw new Error(`graph-stale: graph at ${graph.commit.slice(0, 8)}, HEAD ${headSha.slice(0, 8)}`);
      }
    }
    // refreshGraph has no abort wiring of its own (unlike runBuild, whose
    // signal spawnWikiBuild already reacts to) -- an abort that lands while
    // it is in flight is only checked for HERE, once it returns, before
    // doing anything that spawns a real build child.
    checkNotAborted(ctx);
    evictRejected({ cacheFile: p.cache, lastVerifyFile: p.lastVerify });
    const pruned = pruneWikiBuilds({ stateDir, keep: c.keepBuilds, rm, readdir });
    if (pruned.retentionErrors.length) log(`wiki-loop: ${pruned.retentionErrors.length} old build(s) not removed: ${pruned.retentionErrors[0]}`);
    onRetention(pruned.retentionErrors);
    const buildId = buildIdFor(headSha, runStartTs);
    const buildDir = path.join(p.builds, buildId);
    fs.mkdirSync(p.builds, { recursive: true });
    fs.mkdirSync(buildDir); // not recursive: an existing dir (same sha and ms) throws EEXIST instead of overwriting a build
    const summary = await runBuild({
      root: repoRoot, buildDir, cacheFile: p.cache, priorDir: current ? path.join(p.builds, current.build) : null, stateDir,
      headSha, backend: c.backend, model: c.model, readCache: ctx.payload?.fresh !== true,
      signal: ctx.signal, onModelCall: () => ctx.countModelCall(),
    });
    if (summary?.skipped) throw new Error(`build-skipped: ${summary.skipped}`);
    // HEAD can move while the child builds (a push mid-run); publishing that
    // build would silently mislabel newer work as already covered, so the
    // loop refuses it here rather than in the checker.
    const headAfter = await readHead(repoRoot);
    if (headAfter !== headSha) {
      throw new Error(`head-moved: HEAD moved from ${headSha.slice(0, 8)} to ${headAfter.slice(0, 8)} during the build`);
    }
    return {
      outcome: 'done',
      result: { buildId, buildDir, headSha, previous: current, summary, runStartTs },
      fresh: { builtAtCommit: current?.builtAtCommit ?? null, candidateCommit: headSha },
    };
  }

  async function checker(result) {
    const v = verifyWikiBuild({ buildDir: result.buildDir, headSha: result.headSha, previous: result.previous, webDir, privateNames: buildingAccountNames(stateDir) });
    // modelErrors travels in-process all the
    // way from the builder's enrichSection catch to here, but used to be
    // discarded unlogged -- the operator only ever saw "sections: structural
    // stub: <slug>", never the real cause (rate limit? malformed output? a
    // bug in enrichSection's own post-processing?). Carried into last-verify.
    // json (the same per-run record failures/offending already live in) and,
    // when the build failed, into the reason itself; logged the same way
    // pruned.retentionErrors already is.
    const modelErrors = Array.isArray(result.summary?.modelErrors) ? result.summary.modelErrors : [];
    // S2 fix, the surfacing half: the builder's own degraded[] (sourceContext/
    // listFiles/head/gitLog catches) reaches here over the line protocol, but
    // used to go nowhere from there -- same posture as modelErrors above.
    const degraded = Array.isArray(result.summary?.degraded) ? result.summary.degraded : [];
    writeJsonAtomic(p.lastVerify, { build: result.buildId, ok: v.ok, failures: v.failures, offending: v.offending, modelErrors, degraded, ts: now() });
    if (modelErrors.length) log(`wiki-loop: ${modelErrors.length} section(s) hit a model error this run: ${modelErrors[0].slug}: ${modelErrors[0].error}`);
    if (degraded.length) log(`wiki-loop: ${degraded.length} degrade(s) this run: ${degraded[0].site}: ${degraded[0].error}`);
    // S4 fix, production-path half: spawnWikiBuild
    // only surfaces the child's stderr tail on a NON-ZERO exit, so a
    // SUCCESSFUL but silently-downgraded build (wikiLoop.backend: 'agy'
    // configured, agy not ready, falls back to 'gemini' or 'none') would
    // otherwise reach here with no trace of the downgrade anywhere the loop
    // itself logs, even with the CLI's own stderr warning.
    if (result.summary?.backend && result.summary.backend !== c.backend) {
      log(`wiki-loop: requested backend '${c.backend}' but the build used '${result.summary.backend}'`);
    }
    if (v.ok) return { ok: true, verifierRef: `${WIKI_VERIFIED_BY}@${result.buildId}` };
    const [rule, detail] = v.failures[0];
    const more = v.failures.length > 1 ? ` (+${v.failures.length - 1} more)` : '';
    let reason = `${rule}: ${detail}${more}`;
    if (modelErrors.length) {
      const firstModelErr = modelErrors[0];
      const moreModel = modelErrors.length > 1 ? ` (+${modelErrors.length - 1} more)` : '';
      reason += `; modelErrors: ${firstModelErr.slug}: ${firstModelErr.error}${moreModel}`;
    }
    return { ok: false, reason };
  }

  async function onVerified(result, verdict) {
    const { retentionErrors } = publishWikiBuild({
      stateDir, buildDir: result.buildDir, keep: c.keepBuilds, now, rm, readdir,
      meta: { builtAtCommit: result.headSha, graphFingerprint: result.summary.graphFingerprint ?? null, sections: result.summary.sections, llmSections: result.summary.llmSections, verifierRef: verdict.verifierRef },
    });
    // The publish (the pointer swap) already succeeded by this point; a
    // failure to remove an old build directory afterward is reported, not
    // thrown, so the run still records as done, same posture as the
    // pre-build prune above.
    if (retentionErrors.length) {
      log(`wiki-loop: published, but ${retentionErrors.length} old build(s) not removed: ${retentionErrors[0]}`);
      result.publishRetentionErrors = retentionErrors;
    }
    onRetention(retentionErrors);
    if (!obligations) { noObligations(); return; }
    const closeErrors = closeReflectsHeadObligations({ headSha: result.headSha, beforeTs: result.runStartTs, verifierRef: verdict.verifierRef });
    if (closeErrors.length) throw new Error(`published, but obligation close failed: ${closeErrors.join('; ')}`);
  }

  return {
    name: WIKI_LOOP_NAME,
    trigger: { everyMs: c.everyMs },
    maker, checker, onVerified,
    ceiling: { maxAttempts: 1, maxModelCalls: c.maxModelCalls, timeoutMs: c.timeoutMs },
    sla: { maxAgeMs: c.slaMs, obligation: false }, // the wiki's freshness obligation is wiki.reflects-head (Decision 3), not a second loop.freshness
    backoff: { baseMs: c.everyMs, maxMs: c.backoffMaxMs },
    allowOverlap: false,
  };
}

export function registerWikiLoop(registry, deps) {
  return registry.registerLoop(wikiLoopDefinition(deps));
}
