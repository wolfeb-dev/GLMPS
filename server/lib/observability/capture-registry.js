// server/lib/observability/capture-registry.js
// The popularity-weighted set of agent tools GLMPS targets for capture, and the single
// source of truth for both the parity-matrix rows and adapter build-prioritization.
// See docs/superpowers/specs/2026-07-01-capture-parity-harness-design.md sec 3.2.
//
// popularityWeight: 1..5 (5 = largest install base). Rank by data - external adoption
//   (marketplace/survey) blended with what actually appears in the user's own GLMPS
//   sessions. Revisit as the market moves.
// captureSurface: 'local-artifact' (tail/parse a local file/DB) | 'hook' (tap/hook we install).
// adapter: the server/lib/adapters/<id>.js module id, or null = not built yet.
// fixture: path (relative to repo root) to a committed raw golden artifact, or null.
//   Wired in Task 4 of the plan for tools that have one.
// speculative: true when the adapter's record shapes are inferred, not checked
//   against a real session, so its fixture was written to match the guess and a
//   passing golden test proves self-consistency only (card glmps-2-0-runtime-132).

export const REFERENCE_TOOL = 'claude-code';

const FIX = 'server/test/fixtures';

export const TOOL_REGISTRY = [
  { id: 'copilot-chat',  displayName: 'GitHub Copilot Chat', popularityWeight: 5, captureSurface: 'local-artifact', adapter: 'copilot-chat', fixture: `${FIX}/copilot-chat/chat.json` },
  { id: 'copilot-cli',   displayName: 'GitHub Copilot CLI',  popularityWeight: 5, captureSurface: 'local-artifact', adapter: 'copilot-cli', fixture: `${FIX}/copilot-cli/events.jsonl` },
  { id: 'cursor-native', displayName: 'Cursor (native)',     popularityWeight: 5, captureSurface: 'local-artifact', adapter: null,          fixture: null }, // gap: biggest uncaptured AI-IDE
  { id: 'cursor-cli',    displayName: 'Cursor CLI',          popularityWeight: 4, captureSurface: 'local-artifact', adapter: 'cursor-cli',  fixture: `${FIX}/cursor-cli/transcript.jsonl`, speculative: true }, // tool_use blocks not confirmed by Orca
  { id: 'grok',          displayName: 'Grok',                popularityWeight: 2, captureSurface: 'local-artifact', adapter: 'grok',        fixture: `${FIX}/grok/chat_history.jsonl` },
  { id: 'pi',            displayName: 'Pi',                  popularityWeight: 2, captureSurface: 'local-artifact', adapter: 'pi',          fixture: `${FIX}/pi/session.jsonl` },
  { id: 'droid',         displayName: 'Factory Droid',       popularityWeight: 2, captureSurface: 'local-artifact', adapter: 'droid',       fixture: `${FIX}/droid/session.jsonl`, speculative: true }, // tool_use / tool_call shapes not confirmed by Orca
  { id: 'claude-code',   displayName: 'Claude Code',         popularityWeight: 5, captureSurface: 'local-artifact', adapter: 'claude-code', fixture: `${FIX}/claude-code/transcript.jsonl` }, // reference bar
  { id: 'cline',         displayName: 'Cline / Roo',         popularityWeight: 4, captureSurface: 'local-artifact', adapter: 'cline',       fixture: `${FIX}/cline/ui_messages.json` },
  { id: 'codex-cli',     displayName: 'Codex CLI',           popularityWeight: 4, captureSurface: 'local-artifact', adapter: 'codex-cli',   fixture: `${FIX}/codex-cli/rollout.jsonl` },
  { id: 'gemini-cli',    displayName: 'Gemini CLI',          popularityWeight: 4, captureSurface: 'local-artifact', adapter: 'gemini-cli',  fixture: `${FIX}/gemini-cli/session.json` }, // model gap CLOSED (b); cumulative tokens = ceiling (needs a tap)
  { id: 'antigravity',   displayName: 'Antigravity',         popularityWeight: 3, captureSurface: 'local-artifact', adapter: 'antigravity', fixture: `${FIX}/antigravity/session.jsonl` },
  { id: 'windsurf',      displayName: 'Windsurf (Cascade)',  popularityWeight: 3, captureSurface: 'local-artifact', adapter: null,          fixture: null }, // next tier
  { id: 'aider',         displayName: 'Aider',               popularityWeight: 3, captureSurface: 'local-artifact', adapter: null,          fixture: null }, // next tier
  { id: 'opencode',      displayName: 'OpenCode',            popularityWeight: 2, captureSurface: 'local-artifact', adapter: 'opencode',    fixture: `${FIX}/opencode/storage` },
  { id: 'hermes',        displayName: 'Hermes',              popularityWeight: 2, captureSurface: 'local-artifact', adapter: 'hermes',      fixture: `${FIX}/hermes/state.sql` },
  { id: 'agy-cli',       displayName: 'agy CLI',             popularityWeight: 1, captureSurface: 'local-artifact', adapter: 'agy-cli',     fixture: `${FIX}/agy-cli/steps.sql` },
  { id: 'openclaw',      displayName: 'OpenClaw',            popularityWeight: 1, captureSurface: 'local-artifact', adapter: 'openclaw',    fixture: `${FIX}/openclaw/session.jsonl`, speculative: true },
];

/** Registry entries that can be scored today: have both an adapter and a committed fixture. */
export function withAdapters() {
  return TOOL_REGISTRY.filter(t => t.adapter && t.fixture);
}
