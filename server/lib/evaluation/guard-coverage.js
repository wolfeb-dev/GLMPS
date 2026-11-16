// server/lib/evaluation/guard-coverage.js
// Which gap codes already have a rule in the guard file (CLAUDE.global.md).
// A recurrence of a code whose guard exists is a compliance signal, not a new
// proposal, so learning-store files it as status 'covered' instead of
// 'pending' (card glmps-2-0-82: 645 of 646 queued rows were such repeats).
// Anchors match a distinctive phrase of the guard line, not the whole line, so
// a reworded guard keeps matching as long as its core instruction survives.
// A code with no anchor (ticket-closed-without-gate) is never covered.
import fs from 'node:fs';

export const GUARD_ANCHORS = {
  'bash-grep-over-grep-tool': /Grep\/Read tools instead of Bash grep/i,
  'done-without-verification': /before claiming done/i,
  'sleep-poll': /never poll with sleep/i,
  'plan-skipped-on-large-change': /3\+ distinct files/i,
  'serial-agents-no-parallel': /independent agents in a single message/i,
  'opus-on-mechanical': /reserve Opus for orchestration/i,
  'reread-loop': /re-read an unchanged file/i,
  'deferred-followup': /no deferred follow-ups/i,
  'egress': /secret\/credential files/i,
  'ui-without-frontend-design': /before the first UI\/CSS edit/i,
  'ui-design-too-late': /before the first UI\/CSS edit/i,
};

// The reviewed rule text for each anchored code (card glmps-2-0-201). These
// are the only rules the auto-approve loop may land, so a change here goes
// through a PR like any code change. Each must match its own anchor, or a
// landed guard would not mark its code covered and the loop would keep
// finding it. heavy-edits-no-subagents and ticket-closed-without-gate have no
// template on purpose: the first contradicts the subagent-cost rule and the
// second has no anchor.
export const GUARD_TEMPLATES = {
  'bash-grep-over-grep-tool': '- Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.',
  'done-without-verification': '- Before claiming done or committing, run the check that proves it (tests, build, or the command that shows the behavior) and show the actual command output.',
  'sleep-poll': '- Never poll with sleep N then cat - use run_in_background or Monitor.',
  'plan-skipped-on-large-change': '- Before a change touching 3+ distinct files, design first via grilling then to-spec, and count the files up front.',
  'serial-agents-no-parallel': '- Send independent agents in a single message with narrow per-agent file ownership so they run in parallel.',
  'opus-on-mechanical': "- Set model:'sonnet'|'haiku' on research/implementation/mechanical subagent dispatches; reserve Opus for orchestration and hard reasoning.",
  'reread-loop': '- Do not re-read an unchanged file; for codebase orientation query graphify (graphify query/path/explain) instead of repeated reads.',
  'deferred-followup': '- No deferred follow-ups: a follow-up that is part of completing the current work is folded into the active plan and executed on the same branch, never filed as a follow-up ticket.',
  'egress': '- Never open or read secret/credential files (.env, keys, tokens) or prod-zone paths in an agent session.',
  'ui-without-frontend-design': '- Before any UI/CSS/layout/styling work, load the UI design skills before the first UI/CSS edit, not after.',
  'ui-design-too-late': '- Before any UI/CSS/layout/styling work, load the UI design skills before the first UI/CSS edit, not after.',
};

export function coveredCodes(text) {
  const t = String(text ?? '');
  return new Set(Object.entries(GUARD_ANCHORS).filter(([, re]) => re.test(t)).map(([code]) => code));
}

const fileCache = new Map();

// Fails open to an empty set: an unreadable guard file must never hide a gap.
export function coveredCodesFromFile(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.codes;
    const codes = coveredCodes(fs.readFileSync(file, 'utf-8'));
    fileCache.set(file, { mtimeMs, codes });
    return codes;
  } catch {
    return new Set();
  }
}
