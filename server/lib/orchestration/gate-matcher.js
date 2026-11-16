// server/lib/orchestration/gate-matcher.js
// Pure decision: does this tool call need operator approval before it runs?
// No I/O, no clock, no state - so it is cheap enough to run on every tool call
// and testable as a table.
//
// ENFORCED, NOT REQUESTED. This is evaluated by the PreToolUse hook against the
// action the agent is ATTEMPTING. It is never something the agent asks for. A
// gate an agent must remember to request is not a control: an ordinary agent
// forgets, and a poisoned one simply declines to ask. Same reasoning that
// removed SCUT's voluntary inbound scan in favour of the enforced intake gate.
import { classifyPath } from '../zones.js';

// Only tools that can CHANGE something are gateable. Reads are never gated:
// gating them would stall ordinary work for no safety gain.
const MUTATING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Is `p` the configured path itself, or inside it? Never a mere name prefix. */
function underPath(p, base) {
  const a = norm(p), b = norm(base);
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/');
}

// Shell constructs that WRITE. Bash carries no structured target, so a path in
// the command text means nothing on its own: `grep D:/prod`, `ls D:/prod` and a
// curl body quoting the path all merely NAME it.
//
// The first version gated on the mention alone, and the first read-only curl
// after gates were switched on blocked its caller for the full 9-minute budget.
// The asymmetry settles it: a false gate is near-certain, since paths get named
// constantly, and costs 9 minutes plus the operator's willingness to keep the
// feature on. A missed gate needs a mutating command this list does not know,
// and live-install-guard covers that layer independently.
//
// Deliberately a heuristic, not a shell parser, and it errs in both directions.
// It MISSES exotic forms (eval, a path assembled from variables). It also
// OVER-fires when a mutator and a prod path appear in one command without being
// related, e.g. `grep -rn foo D:/prod > /tmp/out`, since matching a redirect to
// its actual target needs real parsing. Both are accepted: the feature is
// opt-in and an over-fire costs one approval, not a wrong write. Anything that
// must be airtight belongs in live-install-guard, which is static, local, and
// does not depend on a human answering.
const BASH_MUTATORS = [
  /\bcp\b/, /\bmv\b/, /\brm\b/, /\btee\b/, /\binstall\b/, /\bdd\b/,
  /\brsync\b/, /\brobocopy\b/, /\bxcopy\b/, /\bcopy-item\b/, /\bmkdir\b/,
  /\btouch\b/, /\bchmod\b/, /\bchown\b/, /\bln\b/, /\bunzip\b/, /\btar\b/,
  />>?/,                                    // redirection into a file
];

const looksMutating = (cmd) => BASH_MUTATORS.some(re => re.test(cmd));

/**
 * Paths this call could touch. For file tools that is the declared target; Bash
 * is handled separately (see the mutator list above) because its "target" is
 * free text.
 */
function candidatePaths(tool, toolInput) {
  if (tool === 'Bash') return [];
  const i = toolInput ?? {};
  return [i.file_path, i.notebook_path, i.path].filter(Boolean);
}

/**
 * @param {object} args
 * @param {string} args.tool       tool name, e.g. 'Write'
 * @param {object} args.toolInput  the tool's input object
 * @param {string} args.cwd        the session's cwd, used as projectRoot for zone classification
 * @param {{enabled:boolean, paths:string[], includeBash?:boolean}} args.config
 * @returns {{gated:boolean, summary:string|null, why:string|null}}
 */
export function shouldGate({ tool, toolInput, cwd, config } = {}) {
  const no = { gated: false, summary: null, why: null };
  try {
    if (!config?.enabled) return no;
    if (!MUTATING.has(tool)) return no;
    const paths = Array.isArray(config.paths) ? config.paths.filter(Boolean) : [];

    if (tool === 'Bash') {
      // OPT-IN (config.includeBash). Even with the mutation-verb requirement
      // this is a guess against free text: `grep foo D:/prod > /tmp/out` still
      // reads as a write. Once a gate can wait hours rather than minutes, a
      // false positive stops costing nine minutes and starts costing "until
      // someone notices", so a matcher with that blast radius must be switched
      // on deliberately. Write/Edit need no such flag: they declare exactly
      // what they touch, so gating them is never a guess.
      if (!config.includeBash) return no;
      const cmd = String(toolInput?.command ?? '');
      if (!cmd) return no;
      // Both halves are required: a path AND something that writes. Either one
      // alone is ordinary work (`ls D:/prod`, `cp a b`).
      if (!looksMutating(cmd.toLowerCase())) return no;
      const hit = paths.find(p => norm(cmd).includes(norm(p)));
      if (hit) return { gated: true, summary: `run: ${cmd.slice(0, 160)}`, why: `writes into ${hit}` };
      return no;
    }

    for (const target of candidatePaths(tool, toolInput)) {
      const hit = paths.find(p => underPath(target, p));
      if (hit) return { gated: true, summary: `${tool} ${target}`, why: `inside ${hit}` };
      // Zone classification is the second source of "risky", reused rather than
      // reinvented so there is one definition of prod in the codebase.
      const zone = classifyPath(target, { projectRoot: cwd });
      if (zone?.env === 'prod' || zone?.protected) {
        return { gated: true, summary: `${tool} ${target}`, why: `prod zone (${zone.zone})` };
      }
    }
    return no;
  } catch {
    return no; // never break tool use on a matcher error
  }
}
