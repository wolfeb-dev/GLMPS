// Classify a `graphify update` run from its OUTPUT, not its exit code.
//
// WHY THIS EXISTS: the exit code cannot name the outcome. `updated` and `noop`
// both exit 0, so a tick keying on the code cannot tell a graph that was
// rebuilt from one that was skipped. A refusal does exit 1, but the old tick
// only console.error'd it into the server's stderr file, which nobody reads:
// two of four tracked repos sat frozen or falsely stale for 16 and 29 days
// with the evidence sitting in .server-8123.err the whole time. The fix is not
// just reading stdout, it is turning the verdict into durable state something
// else can alert on.
//
// Pure: no fs, no process, no clock. The caller runs graphify and passes the
// captured streams in.

const RE_REBUILT = /Rebuilt:\s*(\d+)\s*nodes/i;
// 0.9.99 added the second wording for a run that saw no code-file change;
// 0.9.102 replaced it with the third, which failed every audit of 0.9.102.
const RE_NOOP = /No code-graph topology changes detected|No relevant changes; graphify-out left untouched|No tracked code files in change set - skipping rebuild/i;
const RE_REFUSED = /Refusing to overwrite/i;
const RE_COUNTS = /new graph has\s*(\d+)\s*nodes but existing graph\.json has\s*(\d+)/i;

/**
 * @param {{ code?: number, stdout?: string, stderr?: string }} run
 * @returns {{ outcome: 'updated'|'noop'|'refused'|'failed',
 *             nodes: number|null, existingNodes: number|null, reason: string }}
 */
export function classifyGraphifyRun({ code, stdout, stderr } = {}) {
  const out = `${typeof stdout === 'string' ? stdout : ''}\n${typeof stderr === 'string' ? stderr : ''}`;

  // Output is read BEFORE the exit code, deliberately. The first cut of this
  // module checked `code !== 0` first, on the belief that graphify exits 0 for
  // every outcome. That belief was wrong, and the live server's own stderr
  // disproved it: a refusal exits 1 (`graph auto-rebuild: d:/proj failed
  // (exit 1): ... Refusing to overwrite`). Only `updated` and `noop` exit 0.
  // Checking the code first therefore swallowed the single outcome this module
  // exists to name, reporting it as a bare "exit 1" and discarding both node
  // counts. An outcome we can READ is more trustworthy than an exit convention
  // that has already surprised us once, so the code now decides only for output
  // we cannot classify at all.

  // Refusal is checked before success: a refusing run can still have printed a
  // "Rebuilt" line for the graph it then declined to write.
  if (RE_REFUSED.test(out)) {
    const m = out.match(RE_COUNTS);
    return {
      outcome: 'refused',
      nodes: m ? Number(m[1]) : null,
      existingNodes: m ? Number(m[2]) : null,
      reason: m ? `refused to write ${m[1]} nodes over an existing ${m[2]}` : 'refused to overwrite',
    };
  }
  if (RE_NOOP.test(out)) {
    return { outcome: 'noop', nodes: null, existingNodes: null, reason: 'no topology change' };
  }
  const rebuilt = out.match(RE_REBUILT);
  if (rebuilt) {
    return { outcome: 'updated', nodes: Number(rebuilt[1]), existingNodes: null, reason: `rebuilt ${rebuilt[1]} nodes` };
  }
  // Output we cannot classify is NOT success, whatever the exit code says.
  // Upstream changing its wording is exactly the silent-rot case this module
  // exists to catch, and a clean exit must not launder it into "fine".
  return {
    outcome: 'failed', nodes: null, existingNodes: null,
    reason: code === 0 ? 'unrecognised output at exit 0' : `exit ${code}`,
  };
}
