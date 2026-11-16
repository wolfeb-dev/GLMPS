// server/lib/governance/cross-agent-memory.js
//
// Cross-agent shared memory orchestration (glmps-pro flagship): capture ->
// (propose-only vetting lives in cross-agent-memory-store.js) -> distribute
// -> attest. This file composes existing, already-shipped primitives rather
// than inventing new ones - see the plan header for the full reuse ledger.
//
// The capture source is THIS project's own local curated memory dir (the
// same directory memory-writer.js's writeMemoryFile() already writes
// .md/MEMORY.md into). A local fact becoming a cross-agent-shared candidate
// is a SEPARATE trust boundary from "written to this project's memory dir"
// (see cross-agent-memory-store.js's mandatory re-scan), so capture here is
// intentionally just a parser over already-durable, already-local-vetted
// text - no new distillation model call, no re-reading of session
// transcripts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyPush, renderMemoryBody, extractManagedSection, normalizeManagedBody, MEMORY_MANAGED_BEGIN, MEMORY_MANAGED_END, SUPPORTED_VENDORS } from './vendor-writers.js';
import { readBaseline, writeBaseline } from './baseline-store.js';
import { load as camLoad, resolveTrialIn } from './cross-agent-memory-store.js';

/**
 * Parse one memory-writer.js-authored .md file back into a Fact-shaped
 * object. Not a general YAML parser - the format is fixed and self-produced
 * by renderMemoryFile() (memory-distill-core.js), so a few targeted
 * line-regexes are enough and stay honest about what they support.
 *
 * @param {string} content
 * @returns {{name:string, description:string, type:string, body:string} | null}
 */
export function parseMemoryFile(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const [, frontmatter, rest] = m;
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const typeMatch = frontmatter.match(/^\s*type:\s*(.+)$/m);
  if (!nameMatch || !descMatch) return null;
  return {
    name: nameMatch[1].trim(),
    description: descMatch[1].trim(),
    type: typeMatch ? typeMatch[1].trim() : 'project',
    body: rest.replace(/^\n+/, '').replace(/\n{2,}(?:\[\[[^\]\n]+\]\](?:\s+\[\[[^\]\n]+\]\])*)\s*$/, '').trim(),
  };
}

/**
 * Read every memory file in `memoryDir` (skipping MEMORY.md, the index) and
 * parse each into a candidate Fact. Fail-open per file - one unparseable or
 * unreadable file never drops the rest. Missing dir -> [].
 *
 * @param {string} memoryDir
 * @param {{readdirSync?:Function, readFileSync?:Function}} [io] - injectable for tests.
 * @returns {Array<{name,description,type,body}>}
 */
export function captureCandidates(memoryDir, { readdirSync = fs.readdirSync, readFileSync = fs.readFileSync } = {}) {
  let names;
  try { names = readdirSync(memoryDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name === 'MEMORY.md' || !name.endsWith('.md')) continue;
    let content;
    try { content = readFileSync(path.join(memoryDir, name), 'utf8'); } catch { continue; }
    const fact = parseMemoryFile(content);
    if (fact) out.push(fact);
  }
  return out;
}

// Thin wrapper over vendor-writers.js's generalized applyPush:
// same guarded managed-section merge the guardrail-policy push already
// uses, pointed at the memory markers/renderer instead.

/**
 * @param {{targets:Array<{vendor,path}>, entries:Array<{name,description,body}>,
 *   readFile:Function, exists:Function, guard:Function}} opts
 * @returns {Array<{vendor,path,action,content?,managedBody?,reason?}>}
 */
export function distributeMemory({ targets, entries, readFile, exists, guard }) {
  return applyPush({
    targets, items: entries, readFile, exists, guard,
    render: renderMemoryBody, begin: MEMORY_MANAGED_BEGIN, end: MEMORY_MANAGED_END,
  });
}

// Inline attestation check: compares requiredFiles against disk hashes.
// A separate baseline file (not governance-baseline.json) so memory drift
// never collides with any other baseline; hashes only the managed-section
// body so edits outside the memory block never trip drift.

/**
 * @param {{ baselinePath: string, readFileSync?: Function }} opts
 * @returns {{configured:boolean, findings:object[], summary:object}}
 */
export function computeMemoryAttestation({ baselinePath, readFileSync = fs.readFileSync, existsSync = fs.existsSync } = {}) {
  const baseline = readBaseline(baselinePath);
  if (!baseline || typeof baseline !== 'object') {
    return { configured: false, findings: [], summary: { critical: 0, warn: 0, ok: 0, uncovered: 0, filesChecked: 0, hooksChecked: 0 } };
  }

  const requiredFiles = Array.isArray(baseline.requiredFiles) ? baseline.requiredFiles : [];
  const findings = [];
  const summary = { critical: 0, warn: 0, ok: 0, uncovered: 0, filesChecked: 0, hooksChecked: 0 };

  for (const entry of requiredFiles) {
    const p = String(entry.path ?? '');
    const label = String(entry.label ?? p);
    summary.filesChecked++;
    let exists = false;
    let sha256 = null;
    try {
      const text = readFileSync(p, 'utf-8');
      exists = true;
      const section = extractManagedSection(text, { begin: MEMORY_MANAGED_BEGIN, end: MEMORY_MANAGED_END });
      sha256 = section !== null
        ? crypto.createHash('sha256').update(normalizeManagedBody(section)).digest('hex')
        : null;
    } catch {
      exists = false;
      sha256 = null;
    }

    const requiredMarkerPresent = Boolean(entry.sha256);
    const liveMarkerPresent = Boolean(sha256);

    if (!exists && projectFolderGone(p, existsSync)) {
      findings.push({
        id: `attest:guardrail-project-removed:${p}`,
        source: 'attestation',
        severity: 'info',
        kind: 'guardrail-project-removed',
        title: `Guardrail project folder removed: ${label}`,
        detail: `"${p}" is in a project folder that no longer exists; push shared memory again from the current checkout to re-baseline`,
        target: { view: 'governance' },
      });
    } else if (!exists) {
      findings.push({
        id: `attest:guardrail-missing:${p}`,
        source: 'attestation',
        severity: 'critical',
        kind: 'guardrail-missing',
        title: `Guardrail file missing: ${label}`,
        detail: `Expected file "${p}" is absent from the project`,
        target: { view: 'governance' },
      });
      summary.critical++;
    } else if (requiredMarkerPresent && liveMarkerPresent && sha256 !== entry.sha256) {
      findings.push({
        id: `attest:guardrail-modified:${p}`,
        source: 'attestation',
        severity: 'critical',
        kind: 'guardrail-modified',
        title: `Guardrail file modified: ${label}`,
        detail: `"${p}" content hash does not match baseline (expected ${entry.sha256.slice(0, 8)}..., got ${sha256.slice(0, 8)}...)`,
        target: { view: 'governance' },
      });
      summary.critical++;
    } else if (requiredMarkerPresent && !liveMarkerPresent) {
      findings.push({
        id: `attest:guardrail-modified:${p}`,
        source: 'attestation',
        severity: 'critical',
        kind: 'guardrail-modified',
        title: `Guardrail file modified: ${label}`,
        detail: `"${p}" managed block is missing (expected hash ${entry.sha256.slice(0, 8)}..., no managed block found in the file)`,
        target: { view: 'governance' },
      });
      summary.critical++;
    } else {
      summary.ok++;
    }
  }

  return { configured: true, findings, summary };
}

// A baseline row records where a push wrote, so a renamed or deleted repo
// leaves rows that can never be satisfied (card glmps-2-0-219: five rows still
// named the renamed 1.0 checkout). The project folder is the path with the
// vendor's own relative path taken off; a file without a known suffix falls
// back to its directory.
function projectFolderGone(p, existsSync) {
  const norm = String(p).replace(/\\/g, '/');
  const suffix = SUPPORTED_VENDORS.map((v) => v.defaultPath).find((d) => norm.toLowerCase().endsWith('/' + d.toLowerCase()));
  const root = suffix ? norm.slice(0, norm.length - suffix.length - 1) : path.dirname(norm);
  try { return !existsSync(root); } catch { return false; }
}

/**
 * Relabel memory-attestation findings for the alert center (glmps-145).
 *
 * computeMemoryAttestation's findings come back titled "Guardrail file
 * modified" and targeted at the Governance pillar, which has no memory drift
 * view. Surfacing them as-is would tell an operator their guardrails drifted
 * and then deep-link them to a page that does not show the drift. Retitle
 * and retarget so a memory alert names memory and lands on the Registry,
 * where shared memory actually lives.
 *
 * @param {object[]} findings
 * @returns {object[]}
 */
export function memoryAttestationAlerts(findings) {
  return (Array.isArray(findings) ? findings : []).map((f) => ({
    ...f,
    id: String(f.id ?? '').replace(/^attest:/, 'attest-memory:'),
    kind: f.kind === 'guardrail-modified' ? 'memory-modified' : f.kind,
    title: String(f.title ?? '').replace(/^Guardrail file modified/, 'Cross-agent memory file modified'),
    target: { view: 'registry' },
  }));
}

/**
 * Record baseline entries after a successful distributeMemory() push, the
 * same "managed-body hash + managed:true" pattern server.js's guardrail
 * push already uses (see the aligned design's sec 3 reused-chokepoints row),
 * applied to the memory baseline.
 * @param {string} baselinePath
 * @param {Array<{vendor,path,action,managedBody?}>} pushResults
 */
export function recordMemoryBaseline(baselinePath, pushResults) {
  const baseline = readBaseline(baselinePath) ?? { requiredFiles: [], coveredTools: [] };
  const requiredFiles = Array.isArray(baseline.requiredFiles) ? [...baseline.requiredFiles] : [];
  const coveredTools = new Set(Array.isArray(baseline.coveredTools) ? baseline.coveredTools : []);
  for (const r of pushResults) {
    if (r.action === 'skipped' || r.action === 'unchanged' || !r.managedBody) continue;
    const sha256 = crypto.createHash('sha256').update(normalizeManagedBody(r.managedBody)).digest('hex');
    const idx = requiredFiles.findIndex(e => e.path === r.path);
    const entry = { label: r.vendor, path: r.path, tool: r.vendor, sha256, managed: true };
    if (idx !== -1) requiredFiles[idx] = entry; else requiredFiles.push(entry);
    coveredTools.add(r.vendor);
  }
  writeBaseline(baselinePath, { ...baseline, requiredFiles, coveredTools: [...coveredTools] });
}

// One tick per call (the caller drives cadence - see server.js's
// setInterval wiring in Task 13). Drift is FILE-level (the whole managed
// block's hash), not per-entry: a human hand-edit anywhere in a vendor's
// combined memory block cannot be attributed to one entry (renderMemoryBody
// mixes every kept/approved entry into one block per vendor file), so it is
// treated conservatively as drift for every item currently trialing - 
// "canonical wins inside the block" means any unexplained change there
// invalidates trial confidence, not just the one entry that happened to
// change.

/**
 * @param {string} stateDir
 * @param {{ attestationFindings?: object[], observationCounts?: Map<string,number> }} ctx
 *   observationCounts: id -> n-so-far, owned/persisted by the CALLER across
 *   ticks (kept out of the store to avoid a write on every no-op tick).
 * @param {{ minObservations?: number }} [opts]
 * @returns {{ kept: string[], rejected: string[], stillTrialing: string[] }}
 */
export function runTrialTick(stateDir, { attestationFindings = [], observationCounts = new Map() } = {}, opts = {}) {
  const state = camLoad(stateDir);
  const driftedAnywhere = attestationFindings.some(f => f.kind === 'guardrail-modified' || f.kind === 'guardrail-missing');
  const kept = [], rejected = [], stillTrialing = [];
  for (const item of state.items) {
    if (item.status !== 'trialing') continue;
    const n = (observationCounts.get(item.id) ?? 0) + 1;
    observationCounts.set(item.id, n);
    const done = driftedAnywhere || (opts.minObservations ? n >= opts.minObservations : false);
    if (!done) { stillTrialing.push(item.id); continue; }
    const r = resolveTrialIn(stateDir, item.id, { n, drifted: driftedAnywhere }, opts);
    observationCounts.delete(item.id); // resolved (kept/rejected is terminal) - stop accreting per-tick state for it
    (r.item.status === 'kept' ? kept : rejected).push(item.id);
  }
  return { kept, rejected, stillTrialing };
}
