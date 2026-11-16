// Tracked paths (file or dir prefix) kept out of anything public: the public
// mirror (scripts/export-public.mjs) and a public installer's ship graph
// (apps/shell/scripts/kernel-stage-lib.mjs).
export const PUBLIC_DENY = [
  'docs/PUBLISHING.md',     // contains the personal-path scrub rules
  'docs/future-changes.md', // internal register (has a local .gemini path)
  'docs/superpowers',       // internal design specs/plans (personal paths)
  'docs/agent-poisoning-safeguards.md', // threat model - references private live-trading infra
  'addons',                             // private trading agents and skill (personal paths and rules)
  'assets/CLAUDE.global.md',           // the operator's global instructions (personal paths and rules)
  'docs/dev-prod-separation.md',        // dev/prod zones - references private trading installs/projects
  'scripts/export-public.mjs',          // its RENAMES carry personal paths; never publish it
];

export function isPublicDenied(file, deny = PUBLIC_DENY) {
  const f = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return deny.some((d) => f === d || f.startsWith(d + '/'));
}
