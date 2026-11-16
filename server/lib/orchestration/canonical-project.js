// server/lib/orchestration/canonical-project.js
// The one answer to "which board project is this" for 2.0 work (card
// glmps-2-0-runtime-151, spec 2026-11-04-glmps-2-0-140-self-contained-layout).
// 2.0 cards had landed under six project names; board intake, Slack channel
// routing, the runner's project-to-checkout lookup and every server-side
// auto-filer now resolve through this table, so flipping `target` in config
// moves all of them together. Resolution only ever touches new filings and
// lookups: stored card ids and projects are never rewritten.
import path from 'node:path';
import { projectSlug } from './backlog-store.js';

// target ships as today's live checkout; cutover (T6) flips it to glmps-2.0.
// `glmps` is the Slack channel name, kept here so the channel map needs no
// alias table of its own. intakeDefault (set by cutover) also sends a filing
// with no project, which the store names `default`, to the target.
export const CANONICAL_PROJECT_DEFAULTS = Object.freeze({
  target: 'glmps-2.0-runtime',
  names: Object.freeze(['glmps-2.0-runtime', 'glmps-2', 'glmps-2-0', 'glmps']),
  intakeDefault: false,
});
const UNNAMED = new Set(['', 'default']);

// Projects a 2.0 auto-filer must never file into: the board's catch-all and
// the frozen 1.0 project.
const NOT_FOR_AUTO_FILERS = new Set(['', 'default', 'glmps']);

const key = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// A partial or malformed config keeps the shipped defaults field by field.
export function canonicalTable(cfg) {
  const c = cfg?.canonicalProject ?? cfg;
  const target = typeof c?.target === 'string' && c.target.trim() ? c.target.trim() : CANONICAL_PROJECT_DEFAULTS.target;
  const names = Array.isArray(c?.names)
    ? c.names.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
    : [...CANONICAL_PROJECT_DEFAULTS.names];
  const intakeDefault = typeof c?.intakeDefault === 'boolean' ? c.intakeDefault : CANONICAL_PROJECT_DEFAULTS.intakeDefault;
  return { target, names, intakeDefault };
}

// Exact name match, never a slug match: `glmps-2.0` slugs to `glmps-2-0`, and
// folding the corpus project into the runtime one before the repo merge would
// send corpus cards to the wrong checkout.
export function resolveProject(project, table = CANONICAL_PROJECT_DEFAULTS) {
  const t = canonicalTable(table);
  const k = key(project);
  if (t.intakeDefault && UNNAMED.has(k)) return t.target;
  if (!k) return project;
  if (k === key(t.target) || t.names.some((n) => key(n) === k)) return t.target;
  return typeof project === 'string' ? project.trim() : project;
}

export function isRetiredProject(project) {
  return key(project) === 'glmps';
}

export function autoFiledProject(project, table = CANONICAL_PROJECT_DEFAULTS) {
  const t = canonicalTable(table);
  if (NOT_FOR_AUTO_FILERS.has(key(project))) return t.target;
  return resolveProject(project, t);
}

// Wraps the server's card writer so every auto-filer that shares it gets the
// same project rule; the caller's project (or none) is replaced, nothing else.
export function makeAutoFiler(addCard, table = CANONICAL_PROJECT_DEFAULTS) {
  return (input = {}) => addCard({ ...input, project: autoFiledProject(input.project, table) });
}

// The runner's project-to-checkout lookup over a list of repo roots: basename
// first (the card key), then slug-insensitive so `harbor-app` still finds
// D:\proj. The project is resolved first so an alias finds the target's
// checkout.
export function checkoutForProject(roots, project, table = CANONICAL_PROJECT_DEFAULTS) {
  const p = resolveProject(project, table);
  if (typeof p !== 'string' || !p) return null;
  const list = Array.isArray(roots) ? roots : [];
  return list.find((r) => path.basename(r) === p)
    ?? list.find((r) => projectSlug(path.basename(r)) === projectSlug(p))
    ?? null;
}
