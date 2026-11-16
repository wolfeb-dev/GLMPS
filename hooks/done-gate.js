#!/usr/bin/env node
// Stop hook: the "definition of done" gate. When the working tree is dirty, run the repo's
// frozen acceptance.md contract commands; block the stop (exit 2) while they fail so the agent
// keeps working instead of self-declaring done. Mirrors hooks/capability-reminder.js: all logic
// is in pure, tested functions; the CLI entry holds the I/O and always fails open on error.
//
// Stdin: Claude Code Stop-hook JSON { cwd, stop_hook_active, session_id }.
// Exit 0 = allow the stop; exit 2 + stderr = block and feed the reason back to the agent.
//
// Bypasses (operator approval, from the hook's OWN environment only; D30 item 2):
//   GLMPS_DONE_GATE=off   skip the whole gate (acceptance commands and scope-guard).
//   GLMPS_ALLOW_PROD=1    bypass only the scope-guard (protected-zone edits).
// A 'done.skip' or 'prod.allow' file in the cwd is NOT honoured (the guarded agent
// could create it); when present it is ignored with a one-line stderr notice.
// commands run only for an acceptance.md the operator approved by hash (`--approve <dir>`,
// which needs an interactive "y" on a terminal; it refuses when stdin is not a TTY).
// Residual, accepted by the operator decision of record: approved commands such as `npm test`
// execute repo code an agent can edit; hashing acceptance.md cannot prevent that.

const BLOCK_CAP = 3;

// Parse the YAML-frontmatter `commands:` list out of an acceptance.md string. Zero-dep: read the
// block between the first two '---' fences, collect `- item` lines under a `commands:` key.
// Returns { commands: string[] } or null (no frontmatter / no commands / bad input).
// CRLF is normalized first: with core.autocrlf=true a Windows checkout has
// CRLF, and the unnormalized match made every Stop log 'no-contract' (card
// glmps-2-0-192).
const toLf = (md) => String(md).replace(/\r\n/g, '\n');
export function parseAcceptance(md) {
  if (typeof md !== 'string') return null;
  const m = toLf(md).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const out = [];
  let inCommands = false;
  for (const line of m[1].split('\n')) {
    if (/^commands:\s*$/.test(line)) { inCommands = true; continue; }
    if (inCommands) {
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item) { out.push(item[1]); continue; }
      if (/^\S/.test(line)) break; // a following top-level key ends the list
    }
  }
  return out.length ? { commands: out } : null;
}

// Pure decision. Called in two passes by the CLI: first without runResult (returns needsRun:true
// when the commands should run), then again with the populated runResult for the final verdict.
// `stop_hook_active === false` marks a fresh end-of-turn, which resets the consecutive-block count.
export function decideDoneGate({ contract, dirty, skip, stopHookActive, blockCount, runResult }) {
  const count = stopHookActive ? (blockCount || 0) : 0; // fresh turn resets the cap counter
  if (!contract) return { action: 'allow', reason: '', needsRun: false, nextBlockCount: 0, result: 'no-contract' };
  if (skip) return { action: 'allow', reason: 'done-gate: skipped (bypassed)', needsRun: false, nextBlockCount: 0, skipped: true };
  if (!dirty) return { action: 'allow', reason: '', needsRun: false, nextBlockCount: 0, result: 'clean' };
  if (runResult === undefined) return { action: 'pending', needsRun: true, nextBlockCount: count };
  if (runResult.ok) return { action: 'allow', reason: '', needsRun: false, nextBlockCount: 0, result: 'pass' };
  if (count < BLOCK_CAP) {
    const reason = `done-gate: blocked - \`${runResult.failedCommand}\` failed. Fix it before stopping.\n${runResult.tail || ''}`;
    return { action: 'block', reason, needsRun: false, nextBlockCount: count + 1, result: 'block' };
  }
  return {
    action: 'allow',
    reason: `done-gate: yielding after ${BLOCK_CAP} blocks; \`${runResult.failedCommand}\` still failing`,
    needsRun: false, nextBlockCount: 0, result: 'yield',
  };
}

// Pure: parse raw `git status --porcelain -z` text + cwd -> string[] of absolute paths.
// -z gives NUL-separated, unquoted entries, so escaped names and arrows in names
// cannot hide a file. A rename or copy entry is followed by a second NUL field
// holding the source name; both names are returned. No fs/git/process.
export function parsePorcelain(porcelainText, cwd) {
  if (typeof porcelainText !== 'string') return [];
  const paths = [];
  const fields = porcelainText.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(path.join(cwd, entry.slice(3)));
    if (/[RC]/.test(entry.slice(0, 2)) && fields[i + 1]) {
      i += 1;
      paths.push(path.join(cwd, fields[i]));
    }
  }
  return paths;
}

// a repo's acceptance.md is attacker-controllable (a cloned repo, or an
// agent with edit-only permission), and this hook runs as a global Stop hook
// with no Bash approval. Its commands run only when the operator approved
// THIS exact file content for THIS directory (sha256), recorded outside the
// repo by `node hooks/done-gate.js --approve <dir>`.
export function contractHash(md) { return crypto.createHash('sha256').update(toLf(md)).digest('hex'); }
export function approvalKey(cwd) {
  const r = path.resolve(String(cwd));
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
// repoRoot is the main checkout of the repository cwd belongs to (its git
// common dir's parent). Runner sessions work in throwaway worktrees, so an
// approval keyed only to cwd never matched them; the content hash still has
// to match, so a worktree with an edited contract stays unapproved.
export function isContractApproved(approvals, cwd, md, { repoRoot = null } = {}) {
  if (!approvals || typeof approvals !== 'object' || typeof md !== 'string') return false;
  const hash = contractHash(md);
  return approvals[approvalKey(cwd)] === hash || (!!repoRoot && approvals[approvalKey(repoRoot)] === hash);
}


import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideScopeGuard } from '../server/lib/governance/scope-guard.js';
import { DEFAULT_ZONE_CONFIG, mergeProtectedRoots } from '../server/lib/zones.js';
import { episodeIdForSession } from '../server/lib/evaluation/episode-id.js';
import { resolveStateDir } from '../server/lib/state-dir.js';

function doneGateDir() {
  if (process.env.GLMPS_DONE_GATE_DIR) return process.env.GLMPS_DONE_GATE_DIR;
  const stateDir = resolveStateDir();
  return path.join(stateDir, 'done-gate');
}
function approvalsFile(dir) { return path.join(dir, 'approved-contracts.json'); }
function readApprovals(dir) {
  try { return JSON.parse(fs.readFileSync(approvalsFile(dir), 'utf8')); } catch { return {}; }
}
function readContractRaw(cwd) {
  try { return fs.readFileSync(path.join(cwd, 'acceptance.md'), 'utf8'); } catch { return null; }
}
// read acceptance.md ONCE; the parsed commands and the text that gets hashed come from the
// same string, so the file cannot change between the approval check and the run.
export function loadContract(cwd, read = readContractRaw) {
  const raw = read(cwd);
  return { raw, contract: raw === null ? null : parseAcceptance(raw) };
}
export function approveContract(dir, cwd) {
  const md = readContractRaw(cwd);
  if (md === null) throw new Error(`no acceptance.md in ${cwd}`);
  fs.mkdirSync(dir, { recursive: true });
  const approvals = readApprovals(dir);
  approvals[approvalKey(cwd)] = contractHash(md);
  fs.writeFileSync(approvalsFile(dir), JSON.stringify(approvals, null, 2));
  return { cwd: approvalKey(cwd), hash: approvals[approvalKey(cwd)], store: path.resolve(approvalsFile(dir)), commands: parseAcceptance(md)?.commands ?? [] };
}
// approval is an operator act. Show the directory and exact commands, then require "y" on a
// TTY, so an agent running `--approve .` from a non-interactive Bash call cannot self-approve.
// `isTTY` and `ask` are injectable seams for tests.
export async function confirmAndApprove(dir, cwd, { isTTY, ask, out = () => {} } = {}) {
  if (!isTTY) return { approved: false, reason: 'approval must be done by the operator at an interactive terminal (stdin is not a TTY)' };
  const md = readContractRaw(cwd);
  if (md === null) throw new Error(`no acceptance.md in ${cwd}`);
  out(`done-gate: approve acceptance.md in ${approvalKey(cwd)}? It will run these commands at every Stop:\n${(parseAcceptance(md)?.commands ?? []).map((c) => `  - ${c}`).join('\n')}\n`);
  const answer = String(await ask('Approve? [y/N] ')).trim().toLowerCase();
  if (answer !== 'y') return { approved: false, reason: 'not approved' };
  return { approved: true, ...approveContract(dir, cwd) };
}
// The store path is printed because the hook reads GLMPS_STATE_DIR from its own environment: an
// operator whose shell differs would otherwise approve into a file the hook never reads.
export function approvedMessage(r) {
  return `done-gate: approved acceptance.md in ${r.cwd} (sha256 ${r.hash.slice(0, 12)}).\ndone-gate: approvals store written: ${r.store}\n`;
}
// Opt-in, config-driven prod roots: read prodRoots[] from the gitignored
// config.json at the repo root (one level above hooks/). Absent in a fresh or
// public install -> [] -> the scope-guard stays inert. Exported for tests.
export function readProdRoots(hooksDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(hooksDir, '..', 'config.json'), 'utf8'));
    return Array.isArray(cfg.prodRoots) ? cfg.prodRoots.filter(r => typeof r === 'string' && r) : [];
  } catch { return []; }
}
// Approval comes only from the hook's own environment, never from a file in the
// agent's cwd (an agent can write done.skip / prod.allow itself). A present file
// is ignored with a one-line stderr notice.
function skipPresent() {
  return (process.env.GLMPS_DONE_GATE || '').toLowerCase() === 'off';
}
function noticeIgnoredFile(cwd, file, envSwitch) {
  try {
    if (fs.existsSync(path.join(cwd, file))) {
      process.stderr.write(`[done-gate] '${file}' in the working directory is ignored; set ${envSwitch} in the hook's environment.\n`);
    }
  } catch { /* notice only */ }
}
function mainCheckoutOf(cwd) {
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return common ? path.dirname(common) : null;
  } catch { return null; }
}
function isDirty(cwd) {
  try { return execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim().length > 0; }
  catch { return false; } // git missing / not a repo -> do not gate
}
// Runner sessions commit before they stop, so a clean tree can still carry
// unverified work (card glmps-2-0-192): commits that are not yet on the
// integration branch count too. No remote-tracking base means no gate.
function hasUnmergedCommits(cwd) {
  for (const base of ['origin/main', 'origin/master']) {
    try {
      execSync(`git rev-parse --verify -q ${base}`, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch { continue; }
    try {
      const n = execSync(`git rev-list --count ${base}..HEAD`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return Number(n) > 0;
    } catch { return false; }
  }
  return false;
}
// Return absolute paths of all changed files from git status. Fail-open to [].
function changedPaths(cwd) {
  try {
    // Porcelain paths are relative to the repo root, not to the cwd the hook ran in.
    const root = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8' }).trim() || cwd;
    const out = execSync('git status --porcelain -z --untracked-files=all', { cwd, encoding: 'utf8' });
    return parsePorcelain(out, root);
  } catch { return []; } // not a git repo or git unavailable
}
// GLMPS_ALLOW_PROD=1 in the hook's environment allows the scope-guard to be bypassed.
function prodAllowed() {
  return process.env.GLMPS_ALLOW_PROD === '1';
}
function readCount(dir, sid) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'counter.json'), 'utf8'))[sid] || 0; }
  catch { return 0; }
}
function writeCount(dir, sid, n) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'counter.json');
    let m = {}; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    m[sid] = n; fs.writeFileSync(f, JSON.stringify(m));
  } catch {}
}
function runCommands(commands, cwd) {
  for (const cmd of commands) {
    try { execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      const tail = `${e.stdout || ''}${e.stderr || ''}`.slice(-1500);
      return { ok: false, failedCommand: cmd, tail };
    }
  }
  return { ok: true };
}
function appendResult(dir, sid, result, failedCommand, episodeId) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), result, failedCommand: failedCommand || null, sessionId: sid, episodeId: episodeId || null }) + '\n';
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), line);
  } catch {}
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain && process.argv[2] === '--approve') {
  const target = path.resolve(process.argv[3] || process.cwd());
  const rl = process.stdin.isTTY ? (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const r = await confirmAndApprove(doneGateDir(), target, {
      isTTY: !!process.stdin.isTTY,
      ask: (q) => new Promise((res) => rl.question(q, res)),
      out: (t) => process.stdout.write(t),
    });
    rl?.close();
    if (!r.approved) { process.stderr.write(`done-gate: ${r.reason}\n`); process.exit(1); }
    process.stdout.write(approvedMessage(r));
    process.exit(0);
  } catch (e) { process.stderr.write(`done-gate: ${e.message}\n`); process.exit(1); }
} else if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', async () => {
    try {
      const inp = JSON.parse(raw || '{}');
      const cwd = inp.cwd || process.cwd();
      const sid = inp.session_id || 'unknown';
      const dir = doneGateDir();
      const { raw: contractRaw, contract } = loadContract(cwd);
      const skip = skipPresent();
      noticeIgnoredFile(cwd, 'done.skip', 'GLMPS_DONE_GATE=off');
      noticeIgnoredFile(cwd, 'prod.allow', 'GLMPS_ALLOW_PROD=1');
      const dirty = isDirty(cwd) || hasUnmergedCommits(cwd);

      const stateDirForEpisode = resolveStateDir();
      let episodeId = null;
      try { episodeId = episodeIdForSession(stateDirForEpisode, { sessionId: sid, cwd }); } catch { /* fail-open */ }

      // Load zone config from GLMPS_ZONE_CONFIG env JSON; fall back to DEFAULT silently.
      let zoneConfig = DEFAULT_ZONE_CONFIG;
      try {
        if (process.env.GLMPS_ZONE_CONFIG) zoneConfig = JSON.parse(process.env.GLMPS_ZONE_CONFIG);
      } catch { /* bad JSON in env -> use default, never throw */ }
      // Fold opt-in, config-driven prod roots (e.g. a live install outside any repo,
      // <live-install>) into protectedRoots so they trip the scope-guard at Stop.
      // Default empty -> inert on a fresh/public install.
      zoneConfig = mergeProtectedRoots(zoneConfig, readProdRoots(path.dirname(fileURLToPath(import.meta.url))));

      const override = skip || prodAllowed(); // skip covers GLMPS_DONE_GATE=off
      const sg = decideScopeGuard({
        changedPaths: changedPaths(cwd),
        projectRoot: cwd,
        config: zoneConfig,
        override,
        contract,
      });
      if (sg.action === 'block') { process.stderr.write(sg.reason + '\n'); process.exit(2); }

      const blockCount = readCount(dir, sid);
      const stopHookActive = !!inp.stop_hook_active;
      const d1 = decideDoneGate({ contract, dirty, skip, stopHookActive, blockCount });
      if (d1.skipped) { appendResult(dir, sid, 'skipped', null, episodeId); process.exit(0); }
      if (!d1.needsRun) {
        if (d1.result) appendResult(dir, sid, d1.result, null, episodeId);
        process.exit(0);
      }
      // only an operator-approved contract may run (exact content hash).
      if (!isContractApproved(readApprovals(dir), cwd, contractRaw, { repoRoot: mainCheckoutOf(cwd) })) {
        appendResult(dir, sid, 'unapproved', null, episodeId);
        const notice = `done-gate: acceptance.md in ${cwd} is not operator-approved (new or changed), so its commands were not run. Review it, then run at a terminal: node "${fileURLToPath(import.meta.url)}" --approve "${cwd}"\n`;
        process.stderr.write(notice);
        process.stdout.write(notice);
        process.exit(0);
      }
      const runResult = runCommands(contract.commands, cwd);
      const d2 = decideDoneGate({ contract, dirty, skip, stopHookActive, blockCount, runResult });
      writeCount(dir, sid, d2.nextBlockCount);
      appendResult(dir, sid, d2.result, runResult.failedCommand, episodeId);
      // The outcome row was finalized by a parallel Stop hook before these
      // tests finished, so ask the server to carry this verdict into it (card
      // glmps-2-0-192). Fails open and is bounded at 1.5 s. A redirected
      // GLMPS_DONE_GATE_DIR is a store the server never reads (tests use one), so
      // pinging would only finalize a stray row on whatever server answers.
      if (!process.env.GLMPS_DONE_GATE_DIR) {
        try {
          const { pingOutcomesFinalize } = await import('../server/lib/evaluation/outcome-finalize-ping.js');
          await pingOutcomesFinalize(sid);
        } catch { /* fail-open */ }
      }
      if (d2.action === 'block') { process.stderr.write(d2.reason + '\n'); process.exit(2); }
      process.exit(0);
    } catch { process.exit(0); } // fail open: a hook bug must never trap the user
  });
  process.stdin.on('error', () => process.exit(0));
}
