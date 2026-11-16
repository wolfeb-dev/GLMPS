// server/lib/governance/agent-rules.js
// One source for every vendor's project rules (card glmps-2-0-162): the
// operator's "all models are equal". CLAUDE.md is the source; GEMINI.md
// (Antigravity) and AGENTS.md (Codex, Grok Build) carry the same text in a
// generated block next to the shared-memory block. Pure: callers do the IO
// (scripts/sync-agent-rules.mjs writes, server/test/agent-rules.test.js checks
// the committed files have not drifted).

export const RULES_BEGIN = '<!-- GLMPS:BEGIN rules (generated from CLAUDE.md by scripts/sync-agent-rules.mjs; edit CLAUDE.md, never this block) -->';
export const RULES_END = '<!-- GLMPS:END rules -->';

export const RULES_TARGETS = Object.freeze([
  { file: 'GEMINI.md', agents: 'Gemini (Antigravity CLI)' },
  { file: 'AGENTS.md', agents: 'GPT (Codex CLI) and Grok (Grok Build)' },
]);

const MANAGED_RE = /<!-- GLMPS:BEGIN ([a-z-]+)[^>]*-->[\s\S]*?<!-- GLMPS:END \1 -->\n?/g;

/** CLAUDE.md with every GLMPS-managed block taken out (those sync on their own). */
export function projectRules(claudeMd) {
  return String(claudeMd ?? '').replace(/\r\n/g, '\n').replace(MANAGED_RE, '').trimEnd();
}

export function renderRulesBlock(claudeMd, { agents }) {
  return [
    RULES_BEGIN,
    `> **Project rules for ${agents}.** These are the same rules Claude Code reads from CLAUDE.md in this`,
    '> repo, copied here so every model works under one set of rules. Where they say "Claude" or "the',
    '> agent", read "you". Claude Code hooks (the plan gate, workspace-steer stop and approval gates, the',
    '> test-file guard, the capability feed) do not run inside your CLI; when the GLMPS runner launches you',
    '> on a card it enforces the equivalent fence itself and owns the devlog, gate, commit, push and pull',
    '> request, so do not do those yourself.',
    '',
    projectRules(claudeMd),
    '',
    RULES_END,
  ].join('\n');
}

/** Put the rules block into a vendor file: replace an existing one, else prepend it. */
export function applyRulesBlock(fileText, block) {
  const text = String(fileText ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf(RULES_BEGIN);
  const end = text.indexOf(RULES_END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + RULES_END.length);
  return `${block}\n\n${text}`;
}

/** The rules block currently in a vendor file, or null. */
export function extractRulesBlock(fileText) {
  const text = String(fileText ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf(RULES_BEGIN);
  const end = text.indexOf(RULES_END);
  return start >= 0 && end > start ? text.slice(start, end + RULES_END.length) : null;
}
