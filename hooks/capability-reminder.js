#!/usr/bin/env node
// UserPromptSubmit hook: inject targeted "this capability applies" reminders.
// Runs on every prompt; prints nothing unless a rule matches (keeps noise low).
// Stdin: JSON with a `prompt` field. Stdout: short reminder block added to context.
// Never throws and always exits 0 - must not block prompts.
//
// Guard proposer cutover: the learning loop's TEMPLATES map
// (server/lib/evaluation/learning-templates.js) is deleted - proposing a
// guard's rule text is now the GEPA plugin's job, and the live guard catalog
// is whatever has actually been approved into the queue, not a static
// compile-time list this hot-path, per-prompt hook could cheaply read. Every
// reminder below now carries its own literal `msg` text (the same wording
// TEMPLATES used to hold), so this hook has zero dependency on the learning
// loop and needs no disk access.
export const RULES = [
  { re: /\b(css|stylesheet|styling|style the|layout|colou?rs?|palette|theme|ui|ux|front-?end|design|dashboard|component|wireframe|mockup|spacing|typography|responsive|webpage|web page)\b|\.(css|html|tsx?|jsx?|vue|svelte)\b/i, msg: 'Before any UI/CSS/layout/styling work, read the repo tokens, then load ui-density and operational-expert-tool-ui (plus modular-scale-typography, visual-emphasis-and-hierarchy, color-mode-and-theme, algorithmic-color-palette for look and feel) BEFORE the first UI/CSS edit.' },
  { re: /\b(critique|design review|review (?:the|this) (?:ui|ux|design|screen|page|layout|dashboard)|looks? off|feels? off)\b/i, msg: 'UI critique: run /critique-screen (full pass) or /critique-ux (affordance, density, hierarchy), not design:design-critique.' },
  { re: /\b(a11y|accessib\w*|wcag|screen ?readers?|aria|contrast ratio|keyboard nav\w*)\b/i, msg: 'Accessibility: wcag-accessibility while building, the accessibility skill (WCAG 2.2) for an audit, a11y-debugging for a live page; not design:accessibility-review.' },
  { re: /\b(bug|broken|fails?|failing|errors?|crash(?:ing|ed)?|stack ?trace|unexpected|not working|does ?n.?t work|regression|flaky)\b/i, msg: 'Debugging: use diagnosing-bugs before proposing a fix.' },
  { re: /\b(new feature|implement|build (?:a|an|the|out)|add (?:a|an|support|the ability)|scaffold|from scratch|create (?:a|an) (?:feature|component|page|tool|system))\b/i, msg: 'Non-trivial feature: settle the open decisions with grilling, then write the spec with to-spec, before coding.' },
  { re: /\b(each of|all of the|multiple (?:files|services|projects|repos)|several (?:files|services|projects)|in parallel|fan ?out|across (?:all|the) )\b/i, msg: 'Dispatch 2+ independent subagents in a single message (parallel), with narrow per-agent file ownership.' },
  { re: /\.cs\b|ninjascript|ninjatrader|\b(indicator|strategy)\b/i, msg: 'NinjaScript change -> headlessly compile via test_ninjascript_compile.py before claiming it compiles.' },
  { re: /\b(how does|where is|architecture|refresh yourself|understand the|trace the|what calls|data ?flow|code ?base)\b/i, msg: 'Do not re-read an unchanged file; for codebase orientation query graphify (graphify query/path/explain) instead of repeated reads.' },
  { re: /\b(is it done|are we done|good to go|ship it|works now|is it working|ready to commit|all set)\b/i, msg: 'Before claiming done or committing, run the check that proves it and show the actual command output.' },
  { re: /\b(grep|ripgrep|\brg\b|cat the|search (?:the |all )?(?:files|code|repo|codebase)|find in files)\b/i, msg: 'Use the Grep/Read tools instead of Bash grep/cat for searching and reading files.' },
  { re: /\b(sub-?agent|delegate (?:this|to|the)|dispatch (?:an?|the|these)? ?agents?|spawn (?:an? )?agents?|mechanical (?:work|task|edits?))\b/i, msg: "Set model:'sonnet'|'haiku' on research/implementation/mechanical subagent dispatches; reserve Opus for orchestration and hard reasoning." },
  { re: /\b(poll(?:ing)?|sleep \d|keep checking|check (?:the )?(?:status|progress|deploy|ci) (?:every|periodically|repeatedly)|every \d+ ?(?:s|m|min|minutes|seconds))\b/i, msg: 'Never poll with sleep N then cat - use run_in_background or Monitor.' },
];

export function capabilityReminders(prompt) {
  if (typeof prompt !== 'string') return [];
  const out = [];
  for (const r of RULES) {
    if (!r.re.test(prompt)) continue;
    if (r.msg) out.push(r.msg);
  }
  return out.slice(0, 3);
}

import { classifyTask } from '../server/lib/evaluation/task-classify.js';
import { pickSkills, loadSkillCues } from '../server/lib/orchestration/skill-cues.js';

const OWNERSHIP = "New work: state the objective and what done means in one line first. Ask the operator only what is theirs to decide (intent, scope, priority, done, money, irreversible or prod actions); state engineering calls as 'I will X unless you say otherwise'.";
const OWNERSHIP_CLASSES = new Set(['feature', 'research', 'ui']);
const NOT_OPERATOR_TEXT = /^\s*(?:<(?:command-name|command-message|command-args|local-command-[a-z-]+|system-reminder)>[\s\S]*?<\/(?:command-name|command-message|command-args|local-command-[a-z-]+|system-reminder)>\s*)+$/;

// Same agent/skill cueing a queue-runner card gets, for an interactive prompt.
// Thresholds mirror resolveRoute in queue-runner.js. Returns lines or null; any
// throw means no route lines (fail open).
export function routeReminder(prompt, { vocab, routes, minConfidence = 0.5, minScore = 1, classify = classifyTask, pick = pickSkills } = {}) {
  try {
    if (typeof prompt !== 'string') return null;
    const text = prompt.trim();
    if (text.split(/\s+/).filter(Boolean).length < 6) return null;
    if (text.startsWith('/')) return null;
    if (text.startsWith('Backlog card ') || text.startsWith('Read the task described in this file')) return null;
    if (NOT_OPERATOR_TEXT.test(text)) return null;
    const { taskClass, confidence, score } = classify({ firstPrompt: text }) ?? {};
    const lines = [];
    let routedClass = null;
    const agent = routes && taskClass && taskClass !== 'other' ? routes[taskClass] : null;
    if (agent && confidence >= minConfidence && score >= minScore) {
      routedClass = taskClass;
      lines.push(`This reads as ${taskClass} work: dispatch the \`${agent}\` agent for it. Doing it inline is fine for a one- or two-file change or a bug already reproduced; say so in one line.`);
    }
    const picked = pick(text, vocab, { taskClass: routedClass ?? undefined, operator: true });
    if (picked?.skills?.length) {
      const names = picked.skills.map(s => `\`${s}\``).join(', ');
      lines.push(picked.via === 'cue'
        ? `The wording cues ${names}: run the ${names} skill.`
        : `Run the ${names} skill.`);
    }
    if (routedClass && OWNERSHIP_CLASSES.has(routedClass)) lines.push(OWNERSHIP);
    return lines.length ? lines : null;
  } catch { return null; }
}

// CLI entry - only when run directly (not when imported by tests).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', d => { raw += d; });
  process.stdin.on('end', async () => {
    let prompt = '';
    try { prompt = JSON.parse(raw).prompt ?? ''; } catch {}
    let route = null;
    try {
      const { configDefaults } = await import('../server/lib/config-defaults.js');
      const cfg = configDefaults();
      route = routeReminder(prompt, {
        vocab: loadSkillCues(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')),
        routes: cfg.agentRoutes,
        minConfidence: cfg.agentRouteMinConfidence,
        minScore: cfg.agentRouteMinScore,
      });
    } catch {}
    const named = (route ?? []).join(' ').match(/`[a-z-]+`/g)?.map(n => n.slice(1, -1)) ?? [];
    const rules = capabilityReminders(prompt).filter(m => !named.some(n => m.includes(n)));
    const rem = [...(route ?? []), ...rules];
    if (rem.length) {
      process.stdout.write(
        'Capability check (consider before acting):\n' +
        rem.map(r => '- ' + r).join('\n') + '\n',
      );
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
