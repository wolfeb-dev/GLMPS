// server/lib/observability/work-phase.js
//
// Derive the CURRENT work-phase (what a session is doing right now) from its
// event stream. Pure, zero-dependency ESM - mirrors the house style of
// loop-stage.js / gap-detect.js in this directory: scan events, latest ts
// wins, ts may be an ISO string or a number.
//
// Signal shape: { kind, label, ts, ... } - see event-log.js's header comment
// and server/test/fixtures/claude-code/expected.json for real event shape.

// ts may be an ISO-8601 string (real events) or a numeric epoch ms (tests /
// other callers). Normalize to a comparable number; unparseable -> -Infinity
// so such events never win a "most recent" comparison.
function tsMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : -Infinity;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    return Number.isNaN(n) ? -Infinity : n;
  }
  return -Infinity;
}

// skill label -> { phase, label } table, superpowers and Pocock names alike. Labels are often prefixed, e.g.
// "superpowers:brainstorming" - matched by regex/substring (mirrors the
// `usedSkill` pattern in gap-detect.js).
const SKILL_RULES = [
  { re: /brainstorming|grilling|grill-me|grill-with-docs/i, phase: 'brainstorm', label: 'Brainstorm' },
  { re: /writing-plans|executing-plans|\bto-spec\b|\bto-tickets\b/i, phase: 'spec', label: 'Spec' },
  { re: /test-driven-development|\btdd\b|subagent-driven-development|dispatching-parallel-agents|^(?:[\w-]+:)?implement(?:-spec)?$/i, phase: 'coding', label: 'Coding' },
  { re: /verification-before-completion/i, phase: 'verify', label: 'Verify' },
  { re: /requesting-code-review|receiving-code-review|code-review|\breview\b/i, phase: 'review', label: 'Review' },
  { re: /systematic-debugging|diagnose|diagnosing-bugs/i, phase: 'debug', label: 'Debug' },
  { re: /graphify|deep-research|storm-research|web-researcher|research/i, phase: 'research', label: 'Research' },
];

const TEST_RUNNER_RE = /\b(npm test|npm run test|node --test|pytest|jest|vitest|go test|cargo test)\b/i;

// Strip a leading "superpowers:" (or any single "namespace:") prefix off a
// skill label for display, e.g. "superpowers:brainstorming" -> "brainstorming".
function stripNamespace(label) {
  const s = String(label ?? '');
  const idx = s.indexOf(':');
  return idx === -1 ? s : s.slice(idx + 1);
}

function basename(p) {
  const s = String(p ?? '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx === -1 ? s : s.slice(idx + 1);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '\u2026' : str;
}

const PHASE_LABELS = {
  brainstorm: 'Brainstorm',
  spec: 'Spec',
  coding: 'Coding',
  debug: 'Debug',
  verify: 'Verify',
  review: 'Review',
  research: 'Research',
  idle: 'Idle',
};

/**
 * Derive the current work-phase from a session's event stream.
 *
 * @param {object[]} events - chronological array of canonical events.
 * @returns {{ phase: string, label: string, doing: string }}
 */
export function workPhase(events) {
  const evs = Array.isArray(events) ? events : [];

  let bestTs = -Infinity;
  let bestResult = null; // { phase, doing }

  for (const e of evs) {
    if (!e || typeof e !== 'object') continue;
    const t = tsMs(e.ts);

    let match = null;
    if (e.kind === 'skill') {
      const rule = SKILL_RULES.find(r => r.re.test(String(e.label ?? '')));
      if (rule) match = { phase: rule.phase, doing: stripNamespace(e.label) };
    } else if (e.kind === 'file-edit') {
      match = { phase: 'coding', doing: e.path ? `editing ${basename(e.path)}` : 'editing files' };
    } else if (e.kind === 'command') {
      if (TEST_RUNNER_RE.test(String(e.label ?? ''))) {
        match = { phase: 'verify', doing: truncate(e.label, 40) };
      }
    }

    if (!match) continue;
    // Latest ts wins; on a tie, prefer the earlier-declared rule by keeping
    // the first-seen match at that ts (>= only overwrites strictly-later ts).
    if (t > bestTs) {
      bestTs = t;
      bestResult = match;
    }
  }

  if (!bestResult) {
    return { phase: 'idle', label: PHASE_LABELS.idle, doing: '' };
  }
  return { phase: bestResult.phase, label: PHASE_LABELS[bestResult.phase], doing: bestResult.doing };
}
