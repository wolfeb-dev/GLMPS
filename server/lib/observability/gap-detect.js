// Detect capability-usage gaps in a session: cases where a skill/agent should
// likely have been used but wasn't. Pure function over a session's events + the
// persisted skillsUsed list. Returns [{ code, severity, message }].
// Conservative on purpose - only flag high-confidence misses so the signal stays trustworthy.
//
// Architectural boundary (glmps-81, substrate refactor Phase 1 - "decouple
// memory from learning"): this module, and the rest of the learning loop it
// feeds (rule-synth.js's validateRule, learning-apply.js's applyGuard), reads
// RAW events by design - either the durable Phase-0 event-log spine
// (event-log.js's readEvents) or the in-memory/replay-derived event list
// server.js falls back to, never a distilled/condensed projection of them.
// This must NEVER import server/lib/evaluation/memory-distill-core.js or
// memory-writer.js: those modules are the session-memory distiller's
// RETRIEVAL-only output (condensed facts for a future agent's context window),
// and are lossy by construction (summarized, deduped, confidence-scored).
// Learning is the expensive-to-fail half of the substrate (a bad guard is a
// standing cost across every future session) - it must never inherit the
// memory layer's lossy intermediate projection as its own input. Enforced by
// server/test/architecture-memory-learning-boundary.test.js (a static import
// guard over the source text of this file, rule-synth.js, and
// learning-apply.js).

// Unambiguously front-end by extension (styles, markup, component files).
const CLEAR_UI_EXT = /\.(css|scss|less|html|vue|svelte|tsx|jsx)$/i;
// Plain JS/TS counts as UI only inside a front-end directory (server JS shouldn't trip it).
const UI_DIR_RE = /[\\/](web|ui|frontend|components|styles|public|client)[\\/]/i;
const PLAIN_SCRIPT_RE = /\.(js|ts|mjs|cjs)$/i;
const HEAVY_EDIT_THRESHOLD = 15;

// Design docs: Pocock specs under docs/specs/ (the convention since card
// glmps-2-0-33), and the older superpowers plans, which still count. No anchor
// on the leading separator - matches both a repo-relative path and an absolute
// one ("D:\...\docs\specs\...").
const PLAN_FILE_RE = /docs[\\/](?:specs|superpowers[\\/]plans)[\\/]/i;
const DESIGN_SKILL_RE = /brainstorming|writing-plans|grilling|grill-with-docs|grill-me|to-spec|to-tickets/i;
// Any vendored UI design skill satisfies the UI rules (card glmps-2-0-40 replaced
// frontend-design). The gap codes keep their old ids: learning and shadow history
// are keyed to them.
const UI_DESIGN_SKILL_RE = /ui-density|operational-expert-tool-ui|data-display-and-selection|coordinated-data-views|status-colors-and-errors|modular-scale-typography|visual-emphasis-and-hierarchy|color-mode-and-theme|algorithmic-color-palette/i;
const VERIFY_COMMAND_RE = /\b(npm test|npm run (?:test|build|lint)|node --test|pytest|jest|vitest|go test|cargo test|dotnet build|msbuild)\b|test_ninjascript_compile/i;

function isUiFile(p) {
  const path = String(p ?? '');
  if (!path) return false;
  if (CLEAR_UI_EXT.test(path)) return true;
  return UI_DIR_RE.test(path) && PLAIN_SCRIPT_RE.test(path);
}

export function detectGaps(events, skillsUsed = []) {
  const evs = Array.isArray(events) ? events : [];
  const skills = Array.isArray(skillsUsed) ? skillsUsed : [];

  const usedSkill = (re) =>
    skills.some(s => re.test(String(s))) ||
    evs.some(e => e.kind === 'skill' && re.test(String(e.label ?? '')));

  const gaps = [];

  // 1) UI/style files edited without any UI design skill.
  const editedUi = evs.some(e =>
    (e.kind === 'file-edit' || e.kind === 'context-file') &&
    e.op !== 'read' &&
    isUiFile(e.path));
  if (editedUi && !usedSkill(UI_DESIGN_SKILL_RE)) {
    gaps.push({
      code: 'ui-without-frontend-design',
      severity: 'warn',
      message: 'Edited UI/style files without loading a UI design skill (ui-density and friends).',
    });
  }

  // 2) The heavy-edits-no-subagents detector was retired (card glmps-2-0-82):
  //    it nudged toward delegation, the opposite of the "subagents multiply
  //    cost, do small work directly" guard. editCount still feeds check 5.
  const editCount = evs.filter(e => e.kind === 'file-edit' && e.op !== 'read').length;

  // 2b) Task-size tier rule (BMAD borrow): a change touching 3+ distinct files
  //     should have gone through a design skill (grilling, to-spec) first.
  //
  // on a card's branch, hooks/plan-gate.js now BLOCKS the third
  // distinct source file until the card has a committed plan naming a
  // committed spec - this detector stays as the after-the-fact report for
  // sessions with no card (the gate does nothing there, per K7's design), so
  // its message says the gate now handles the card case, this one covers what
  // it cannot.
  const editedPaths = new Set(evs.filter(e => e.kind === 'file-edit' && e.op !== 'read' && e.path).map(e => String(e.path)));
  if (editedPaths.size >= 3 && !usedSkill(DESIGN_SKILL_RE)) {
    gaps.push({
      code: 'plan-skipped-on-large-change',
      severity: 'warn',
      message: `${editedPaths.size} distinct files edited without grilling/to-spec (tier rule says design first for 3+ file changes). On a card's branch the plan gate now blocks this before it happens; this report only fires for sessions with no card.`,
    });
  }

  // Helper: parse ts to a numeric millisecond value (accepts number or ISO string).
  const tsMs = (e) => {
    const v = e.ts;
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const parsed = Date.parse(String(v));
    return isNaN(parsed) ? Number(v) : parsed;
  };

  // 3) UI/style files edited BEFORE any UI design skill was invoked
  //    (the skill was eventually used, but too late).
  const uiEditEvents = evs.filter(e =>
    (e.kind === 'file-edit' || e.kind === 'context-file') &&
    e.op !== 'read' &&
    isUiFile(e.path));
  const fdSkillEvents = evs.filter(e =>
    e.kind === 'skill' && UI_DESIGN_SKILL_RE.test(String(e.label ?? '')));
  if (uiEditEvents.length > 0 && fdSkillEvents.length > 0) {
    const earliestUiEdit = Math.min(...uiEditEvents.map(tsMs));
    const earliestFdSkill = Math.min(...fdSkillEvents.map(tsMs));
    if (earliestUiEdit < earliestFdSkill) {
      gaps.push({
        code: 'ui-design-too-late',
        severity: 'warn',
        message: 'Edited UI/style files before loading a UI design skill (skill came after the work).',
      });
    }
  }

  // 4) Same path read more than 8 times (re-read loop).
  const readCounts = new Map();
  for (const e of evs) {
    if (e.op === 'read' && e.path != null) {
      const p = String(e.path);
      readCounts.set(p, (readCounts.get(p) ?? 0) + 1);
    }
  }
  let worstPath = null;
  let worstCount = 0;
  for (const [p, n] of readCounts) {
    if (n > worstCount) { worstPath = p; worstCount = n; }
  }
  if (worstCount > 8) {
    gaps.push({
      code: 'reread-loop',
      severity: 'info',
      message: `Re-read ${worstPath} ${worstCount} times - read once or query graphify for orientation.`,
    });
  }

  // 5) Many edits with no verification. Verification is a house rule now, not
  //    a skill, so the evidence is a test/build command run after the last
  //    edit; the old skill still counts for sessions that predate the switch.
  const lastEditTs = Math.max(-Infinity, ...evs.filter(e => e.kind === 'file-edit' && e.op !== 'read').map(tsMs).filter(Number.isFinite));
  const verifiedAfter = evs.some(e => e.kind === 'command' && VERIFY_COMMAND_RE.test(String(e.label ?? ''))
    && !(tsMs(e) < lastEditTs));
  if (editCount >= HEAVY_EDIT_THRESHOLD && !verifiedAfter && !usedSkill(/verification-before-completion/i)) {
    gaps.push({
      code: 'done-without-verification',
      severity: 'warn',
      message: 'Many edits with no test or build run after them.',
    });
  }

  // 6) Wrote an implementation plan AND filed a deferred backlog ticket in the
  //    same session - the in-scope-follow-up-that-should-have-been-folded-in
  //    pattern the CLAUDE.md no-deferred-followups directive exists to catch.
  //
  //    Honesty note: detectGaps only receives the shared event shape
  //    (events, skillsUsed) - it never sees the raw POST body or the
  //    transcript's lastText (that lives in capability-feed-core.js's
  //    separate lastText-based deferral-phrase ticket detector, glmps-75).
  //    The closest genuine signal available here is a 'command' event
  //    (Bash/shell, the shape every adapter uses for shell invocations) whose
  //    text names both the backlog endpoint and a deferred ticket, per the
  //    documented convention `POST /api/backlog {source:'deferred', title,
  //    prompt}`. This fires on real transcripts that follow that convention.
  //    It is a heuristic in BOTH directions: a filing whose Bash --description
  //    omits both words is a false negative, and a command that merely
  //    discusses or greps both words (e.g. a review session referencing
  //    source:'deferred') without actually filing is a false positive. Both
  //    are acceptable here because this code only surfaces a `warn` for human
  //    review and has no learning-templates entry, so it can never auto-apply
  //    a guard - the same no-template posture as plan-skipped-on-large-change.
  const wroteImplementationPlan = evs.some(e =>
    (e.kind === 'file-edit' || e.kind === 'context-file') &&
    e.op !== 'read' &&
    PLAN_FILE_RE.test(String(e.path ?? '')));
  const filedDeferredBacklogTicket = evs.some(e => {
    if (e.kind !== 'command') return false;
    const label = String(e.label ?? '');
    return /backlog/i.test(label) && /deferred/i.test(label);
  });
  if (wroteImplementationPlan && filedDeferredBacklogTicket) {
    gaps.push({
      code: 'deferred-followup',
      severity: 'warn',
      message: 'Wrote an implementation plan and filed a deferred backlog ticket in the same session - fold in-scope follow-ups into the active plan instead of deferring them.',
    });
  }

  return gaps;
}
