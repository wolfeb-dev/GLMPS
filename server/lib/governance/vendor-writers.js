// server/lib/governance/vendor-writers.js
// PURE - no fs, no crypto. All IO (readFile / exists / guard) is injected.
// Renders vendor-specific AI guardrail policy sections and manages the
// managed-block lifecycle inside vendor instruction files.
import path from 'node:path';

export const SUPPORTED_VENDORS = [
  { id: 'claude-code', label: 'Claude Code',    defaultPath: 'CLAUDE.md',                          format: 'md'  },
  { id: 'agents',      label: 'Agents',          defaultPath: 'AGENTS.md',                          format: 'md'  },
  { id: 'codex',       label: 'Codex',           defaultPath: 'AGENTS.md',                          format: 'md'  },
  { id: 'cursor',      label: 'Cursor',           defaultPath: '.cursor/rules/glmps-guardrails.mdc', format: 'mdc' },
  { id: 'copilot',     label: 'GitHub Copilot',  defaultPath: '.github/copilot-instructions.md',    format: 'md'  },
  { id: 'gemini',      label: 'Gemini',           defaultPath: 'GEMINI.md',                          format: 'md'  },
];

const VENDOR_IDS = new Set(SUPPORTED_VENDORS.map(v => v.id));

/**
 * Resolve which vendor files a push should write (glmps-146).
 *
 * Defaults to every supported vendor, which is the shipped behavior. Passing a
 * list narrows it, so a caller can skip claude-code (Claude Code already reads
 * the curated memory dir natively, making its managed block pure duplication in
 * a tracked, always-loaded instruction file).
 *
 * Also de-duplicates by PATH. 'agents' and 'codex' both resolve to AGENTS.md;
 * both results are computed against the pre-write file and then written in
 * sequence, so the second silently overwrote the first. Harmless while their
 * renderers agree, a real footgun the moment they diverge.
 *
 * @param {string[]|null|undefined} vendors ids to include; falsy means all
 * @returns {{targets: Array<{vendor:string,path:string}>, unknown: string[]}}
 */
export function selectPushTargets(vendors) {
  const requested = Array.isArray(vendors) && vendors.length ? vendors.map(String) : null;
  const unknown = requested ? requested.filter((v) => !VENDOR_IDS.has(v)) : [];
  const pool = requested
    ? SUPPORTED_VENDORS.filter((v) => requested.includes(v.id))
    : SUPPORTED_VENDORS;

  const byPath = new Map();
  for (const v of pool) if (!byPath.has(v.defaultPath)) byPath.set(v.defaultPath, { vendor: v.id, path: v.defaultPath });
  return { targets: [...byPath.values()], unknown };
}

export const MANAGED_BEGIN = '<!-- GLMPS:BEGIN guardrails (managed block \u2014 edits here are overwritten on push) -->';
export const MANAGED_END   = '<!-- GLMPS:END guardrails -->';

// Professional notice wrapping the managed block. Rendered as VISIBLE markdown so it
// appears in the raw file a human or agent actually edits (the HTML-comment markers
// are invisible once the markdown is rendered). It is a deterrent + a signpost to the
// real edit path, not a hard lock; it pairs with attestation, which fires drift if the
// block is edited anyway.
export const MANAGED_NOTICE_TOP = [
  '> **GLMPS-managed guardrails. Do not edit this section.**',
  '> Generated from the central Guardrail Policy in GLMPS. Any change made here (by a person or an AI',
  '> agent) is overwritten on the next push. To change these rules, edit the Guardrail Policy in GLMPS,',
  '> not this file.',
].join('\n');
export const MANAGED_NOTICE_BOTTOM = '_End of GLMPS-managed guardrails. Do not edit above this line._';

export const MEMORY_MANAGED_BEGIN = '<!-- GLMPS:BEGIN memory (managed block \u2014 edits here are overwritten on next sync) -->';
export const MEMORY_MANAGED_END   = '<!-- GLMPS:END memory -->';

export const MEMORY_NOTICE_TOP = [
  '> **GLMPS-managed cross-agent memory. Do not edit this section.**',
  '> Synced from the canonical shared-memory store. Any change made here (by a person or an AI',
  '> agent) is overwritten on the next sync. To change this memory, edit it in the GLMPS Memory view,',
  '> not this file.',
].join('\n');
export const MEMORY_NOTICE_BOTTOM = '_End of GLMPS-managed cross-agent memory. Do not edit above this line._';

export const MEMORY_INDEX_PREAMBLE = [
  'Facts shared across every connected agent, as an index: one line per fact.',
  'Full text is not inlined here. Fetch a fact by name from the GLMPS',
  'shared-memory store (`GET /api/cross-agent-memory`) when you need its body.',
].join('\n');

/**
 * Render the managed memory-section body for a given vendor.
 *
 * INDEX, not corpus. Each fact contributes ONE line (name + its one-line
 * description); bodies are fetched on demand by name. This mirrors how the
 * local MEMORY.md index already works, and is not cosmetic: rendering full
 * bodies put 226KB into a 7.9KB CLAUDE.md the first time this was fed against
 * the real 87-fact memory dir, which would evict the actual project
 * instructions from every agent's attention.
 *
 * @param {Array<{name, description, body}>} entries - kept/approved shared-memory facts.
 * @param {{ vendor: string }} opts
 */
export function renderMemoryBody(entries, { vendor } = {}) {
  const v = SUPPORTED_VENDORS.find(s => s.id === vendor);
  const format = v?.format ?? 'md';
  const list = Array.isArray(entries) ? entries : [];
  const index = list.map(e => {
    // Descriptions come from memory-file frontmatter and can wrap across lines;
    // collapse so one fact is always exactly one index line.
    const desc = String(e.description ?? '').replace(/\s+/g, ' ').trim();
    return desc ? `- **${e.name}** - ${desc}` : `- **${e.name}**`;
  }).join('\n');
  const listing = index || '_(no shared memory yet)_';
  const body = `${MEMORY_NOTICE_TOP}\n\n## Cross-Agent Memory\n\n${MEMORY_INDEX_PREAMBLE}\n\n${listing}\n\n${MEMORY_NOTICE_BOTTOM}`;
  if (format === 'mdc') {
    return `---\ndescription: GLMPS cross-agent memory\nalwaysApply: true\n---\n\n${body}`;
  }
  return body;
}

/**
 * Render the managed-section body for a given vendor.
 * Only enabled policy items are included, in declaration order, wrapped in the
 * "do not edit" notice. For mdc format (Cursor), prepends Cursor-rule frontmatter.
 * @param {Array<{id, text, enabled, tags?}>} policy
 * @param {{ vendor: string }} opts
 * @returns {string}
 */
export function renderPolicyBody(policy, { vendor } = {}) {
  const v = SUPPORTED_VENDORS.find(s => s.id === vendor);
  const format = v?.format ?? 'md';
  const enabled = (Array.isArray(policy) ? policy : []).filter(p => p.enabled !== false);
  const bullets = enabled.map(p => `- ${p.text}`).join('\n');
  const body = `${MANAGED_NOTICE_TOP}\n\n## AI Guardrails\n\n${bullets}\n\n${MANAGED_NOTICE_BOTTOM}`;
  if (format === 'mdc') {
    return `---\ndescription: GLMPS guardrails\nalwaysApply: true\n---\n\n${body}`;
  }
  return body;
}

/** Wrap body in managed-section markers. Custom {begin,end} for a
 * non-guardrail managed section (e.g. cross-agent memory); defaults keep
 * every existing caller byte-identical. */
export function wrapManaged(body, { begin = MANAGED_BEGIN, end = MANAGED_END } = {}) {
  return `${begin}\n${body}\n${end}`;
}

/**
 * Extract the body between managed markers, or null if absent.
 * Round-trips with wrapManaged: extractManagedSection(wrapManaged(b)) === b.
 */
/**
 * Canonicalize a managed-section body for hashing (glmps-147).
 *
 * Every attestation hash of a managed block MUST run through this first.
 * The body is written to disk with LF and hashed from memory at push time,
 * but git with core.autocrlf=true materializes CRLF on the next checkout, so
 * a raw-byte hash reports drift for a file nobody touched. Line endings are
 * not part of a guardrail's or a memory fact's meaning, so they are
 * normalized out. Real edits still change the hash.
 *
 * @param {string} s
 * @returns {string} the body with CRLF and lone CR collapsed to LF
 */
export function normalizeManagedBody(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function extractManagedSection(content, { begin = MANAGED_BEGIN, end = MANAGED_END } = {}) {
  if (typeof content !== 'string') return null;
  const beginIdx = content.indexOf(begin);
  if (beginIdx === -1) return null;
  const bodyStart = beginIdx + begin.length;
  const endIdx = content.indexOf(end, bodyStart);
  if (endIdx === -1) return null;
  // Strip the exactly-one leading newline (from wrapManaged) and the trailing
  // newline before END. CRLF-tolerant: under core.autocrlf=true the section
  // begins "\r\n", and an LF-only /^\n/ left that stray newline in the hashed
  // string (glmps-147).
  return content.slice(bodyStart, endIdx).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/**
 * Merge the managed section into existing file content. Idempotent.
 * - Markers present in existing   -> replace everything between them (inclusive).
 * - Markers absent, existing non-empty -> append wrapped block.
 * - Existing empty / whitespace-only  -> produce only the wrapped block.
 *
 * MUST satisfy: mergeManagedSection(mergeManagedSection(x, b), b) === mergeManagedSection(x, b)
 */
export function mergeManagedSection(existing, body, { begin = MANAGED_BEGIN, end = MANAGED_END } = {}) {
  const wrapped = wrapManaged(body, { begin, end });

  if (typeof existing !== 'string' || existing.trim() === '') {
    return wrapped + '\n';
  }

  const beginIdx = existing.indexOf(begin);
  if (beginIdx === -1) {
    // No markers - append after trimmed existing content
    return existing.trimEnd() + '\n\n' + wrapped + '\n';
  }

  const endIdx = existing.indexOf(end, beginIdx);
  if (endIdx === -1) {
    // Malformed: BEGIN with no END - replace from BEGIN onward
    return existing.slice(0, beginIdx).trimEnd() + '\n\n' + wrapped + '\n';
  }

  // Replace inclusive from begin to end
  const before = existing.slice(0, beginIdx);
  const after  = existing.slice(endIdx + end.length);
  return before + wrapped + after;
}

/**
 * Validate a PUT /api/governance/policy request body.
 * Pure: no IO. Rejects invalid vendors, path escapes, and empty text.
 * @param {{ policy?: any[], targets?: any[] }} body
 * @param {{ repoRoot?: string }} opts
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePolicyUpdate({ policy = [], targets = [] } = {}, { repoRoot } = {}) {
  const errors = [];

  if (!Array.isArray(policy)) { errors.push('policy must be an array'); }
  else {
    const seenIds = new Set();
    for (let i = 0; i < policy.length; i++) {
      const item = policy[i];
      if (!item || typeof item !== 'object') { errors.push(`policy[${i}]: must be an object`); continue; }
      if (typeof item.text !== 'string' || !item.text.trim()) {
        errors.push(`policy[${i}]: text is required and must be non-empty`);
      }
      if (item.id) {
        if (seenIds.has(item.id)) errors.push(`policy: duplicate id "${item.id}"`);
        seenIds.add(item.id);
      }
    }
  }

  if (!Array.isArray(targets)) { errors.push('targets must be an array'); }
  else {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || typeof t !== 'object') { errors.push(`targets[${i}]: must be an object`); continue; }
      if (!VENDOR_IDS.has(t.vendor)) {
        errors.push(`targets[${i}]: unknown vendor "${t.vendor}"`);
      }
      const p = String(t.path ?? '');
      if (!p) {
        errors.push(`targets[${i}]: path is required`);
      } else if (path.isAbsolute(p)) {
        errors.push(`targets[${i}]: path must be relative (got absolute: "${p}")`);
      } else if (p.includes('..')) {
        errors.push(`targets[${i}]: path must not contain ".." (got: "${p}")`);
      } else if (repoRoot) {
        const resolved = path.resolve(repoRoot, p);
        const rootResolved = path.resolve(repoRoot);
        if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
          errors.push(`targets[${i}]: path "${p}" escapes the project root`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Apply push to all targets - pure, with injected IO fns.
 *
 * @param {object} opts
 * @param {Array<{vendor, path}>} opts.targets
 * @param {Array<{id, text, enabled, tags?}>} opts.policy
 * @param {(path: string) => string}  opts.readFile  Read file content (called only when exists returns true)
 * @param {(path: string) => boolean} opts.exists    Check file existence
 * @param {(path: string) => {allowed: boolean, reason?: string}} opts.guard  Safety check
 *
 * @returns {Array<{vendor, path, action: 'created'|'updated'|'unchanged'|'skipped', reason?, content?, managedBody?}>}
 */
export function applyPush({ targets = [], policy = [], items = policy, readFile, exists, guard, render = renderPolicyBody, begin = MANAGED_BEGIN, end = MANAGED_END }) {
  const results = [];

  for (const target of targets) {
    const { vendor, path: targetPath } = target;

    // Safety guard (path confinement, secrets, live-install, prod zone)
    const g = guard(targetPath);
    if (!g.allowed) {
      results.push({ vendor, path: targetPath, action: 'skipped', reason: g.reason });
      continue;
    }

    const managedBody = render(items, { vendor });

    const fileExists  = exists(targetPath);
    const currentContent = fileExists ? readFile(targetPath) : '';
    const newContent  = mergeManagedSection(currentContent, managedBody, { begin, end });

    let action;
    if (!fileExists) {
      action = 'created';
    } else if (newContent === currentContent) {
      action = 'unchanged';
    } else {
      action = 'updated';
    }

    results.push({ vendor, path: targetPath, action, content: newContent, managedBody });
  }

  return results;
}
